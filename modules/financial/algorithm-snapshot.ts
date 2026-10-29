import { randomUUID } from 'node:crypto';
import { GENERIC_CONTRACT, type GenericDatabaseBinding, type GenericEnvelope } from '../../adapters/database/generic-transport.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { AlgorithmSnapshotPort, AlgorithmSnapshotRead, AlgorithmSnapshotReference } from './algorithm-types.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const READ_LIMIT = 1000;
const MAX_PAGES = 100;

/**
 * 真实 `wfd.data-service/v1` `data.read` 固定快照适配。
 *
 * 只使用已发现的 GenericDatabaseBinding 与固定 product_id/snapshot_id；逐页请求并核对
 * definition_rev、commit_id、fields、row_count、rows_sha256。真实 `data.read` 只按请求字段投影
 * `rows`，`rows_sha256` 始终是服务端完整行资源（全部声明字段）的摘要；因此本端口把服务端完整
 * 行摘要身份与本地选定字段摘要分开记录，只有请求字段覆盖全部声明字段时才在本地重算完整摘要。
 * 不使用 latest，不扫描目录，不调用 data.submit，也不写 WFD。
 */
export function createWfdFixedSnapshotPort(options: {
  binding(): GenericDatabaseBinding | undefined;
  now?: () => number;
}): AlgorithmSnapshotPort {
  return {
    status() {
      try {
        const binding = options.binding();
        return binding ? { status: 'available' as const, reason: null }
          : { status: 'unavailable' as const, reason: '当前线路没有已发现的通用数据合同；固定快照读取不可用。' };
      } catch (error) {
        return { status: 'unavailable' as const, reason: message(error, '固定快照线路不可用。') };
      }
    },
    async read(reference, context): Promise<AlgorithmSnapshotRead> {
      const fixed = structuredClone(reference);
      assertReference(fixed);
      const binding = options.binding();
      if (!binding) throw new TaskError('ALGORITHM_SNAPSHOT_UNBOUND', '固定快照端口尚未装配；没有已发现的通用数据合同。');
      if (binding.instanceId !== fixed.instanceId) throw new TaskError('ALGORITHM_SNAPSHOT_MISMATCH', '固定快照实例与当前线路不同；不能跨实例读取。');
      if (fixed.contractDigest !== undefined && binding.contractDigest !== fixed.contractDigest) {
        throw new TaskError('ALGORITHM_SNAPSHOT_MISMATCH', '固定快照合同摘要与当前线路不同；请重新核对采用记录。');
      }
      const rows: WfdRecord[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined, frozen: { commitId: string; rowsSha256: string; rowCount: number; definitionSha256: string;
        fields: string[]; declaredFields: string[] | null; rowsBytes: number | null; descriptorSha256: string;
        committedAt: string } | undefined, pages = 0;
      do {
        context.signal.throwIfAborted();
        if (++pages > MAX_PAGES) throw new TaskError('ALGORITHM_SNAPSHOT_BUDGET', `固定快照超过 ${MAX_PAGES} 页读取预算；未截断采用。`);
        if (cursor) seenCursors.add(cursor);
        const page = await binding.call(envelope(binding, fixed, cursor), context.signal);
        const current = pageIdentity(page, fixed, cursor !== undefined);
        if (frozen && (current.commitId !== frozen.commitId || current.rowsSha256 !== frozen.rowsSha256
          || current.rowCount !== frozen.rowCount || current.definitionSha256 !== frozen.definitionSha256
          || current.descriptorSha256 !== frozen.descriptorSha256 || current.rowsBytes !== frozen.rowsBytes
          || canonicalWfdJson(current.fields) !== canonicalWfdJson(frozen.fields)
          || canonicalWfdJson(current.declaredFields) !== canonicalWfdJson(frozen.declaredFields)
          || current.committedAt !== frozen.committedAt)) {
          throw new TaskError('ALGORITHM_SNAPSHOT_CHANGED', '分页读取期间快照身份、定义、字段、行数、资源摘要或 descriptor 发生变化。');
        }
        frozen ??= current;
        if (rows.length + (page.rows as unknown[]).length > current.rowCount) {
          throw new TaskError('ALGORITHM_SNAPSHOT_CHANGED', '分页行数超过声明 row_count；拒绝不完整或重复分页。');
        }
        for (const row of page.rows as unknown[]) {
          if (!isWfdRecord(row)) throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'data.read 返回行不是对象。');
          if (Object.keys(row).length !== current.fields.length) throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'data.read 投影行字段数与请求字段数不一致。');
          for (const field of current.fields) {
            if (!Object.hasOwn(row, field)) throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', `data.read 行缺少请求字段 ${field}。`);
          }
          rows.push(row);
        }
        const next = page.next_cursor;
        if (next !== null && typeof next !== 'string') throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'data.read 分页游标无效。');
        if (next !== null && seenCursors.has(next)) throw new TaskError('ALGORITHM_SNAPSHOT_CHANGED', 'data.read 返回重复分页游标；拒绝循环或重复分页。');
        if (next === null) cursor = undefined; else cursor = next;
        if (next !== null && page.returned_rows === 0) throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'data.read 返回空页但仍有后续游标。');
      } while (cursor);
      const identity = frozen!;
      if (rows.length !== identity.rowCount) throw new TaskError('ALGORITHM_SNAPSHOT_CHANGED', `固定快照完整读取 ${rows.length} 行，与声明 ${identity.rowCount} 行不符。`);
      // 本地只对实际返回的选定字段做投影摘要。真实 WFD 的 rows_sha256 是完整行资源（全部声明字段）摘要，
      // 请求字段不覆盖全部声明字段时不能拿投影摘要冒充全表摘要；覆盖时才顺带完成一次真实全量重算。
      const projectionSha256 = wfdSha256(canonicalWfdJson(rows));
      const coversAllDeclared = identity.declaredFields !== null && identity.declaredFields.length === identity.fields.length
        && identity.fields.every(field => identity.declaredFields!.includes(field));
      if (coversAllDeclared && projectionSha256 !== identity.rowsSha256) {
        throw new TaskError('ALGORITHM_SNAPSHOT_CHANGED', '请求覆盖全部声明字段时，完整读取行资源摘要与固定快照 rows_sha256 不符。');
      }
      if (fixed.expectedRowsSha256 !== undefined && fixed.expectedRowsSha256 !== identity.rowsSha256) {
        throw new TaskError('ALGORITHM_SNAPSHOT_CHANGED', '固定快照行摘要与本次明确引用不同。');
      }
      if (fixed.expectedRowCount !== undefined && fixed.expectedRowCount !== identity.rowCount) {
        throw new TaskError('ALGORITHM_SNAPSHOT_CHANGED', '固定快照行数与本次明确引用不同。');
      }
      if (fixed.expectedDefinitionSha256 !== undefined && fixed.expectedDefinitionSha256 !== identity.definitionSha256) {
        throw new TaskError('ALGORITHM_SNAPSHOT_CHANGED', '固定快照定义摘要与本次明确引用不同。');
      }
      const verifiedScope = coversAllDeclared ? 'server_identity_descriptor_and_full_rows' as const
        : 'server_identity_descriptor_and_projection' as const;
      const resolution = {
        contract: GENERIC_CONTRACT, protocolVersion: 3, operation: 'data.read',
        instanceId: binding.instanceId, productId: fixed.productId, snapshotId: fixed.snapshotId,
        definitionRevision: fixed.definitionRevision, definitionSha256: identity.definitionSha256,
        commitId: identity.commitId, committedAt: identity.committedAt, fields: identity.fields,
        rowCount: identity.rowCount,
        // 服务端身份事实：完整行资源摘要，来自固定快照 descriptor；不是本地对投影行的重算结果。
        rowsSha256: identity.rowsSha256, rowsSha256Basis: 'server_full_resource_descriptor',
        descriptorSha256: identity.descriptorSha256,
        // 本地事实：只对本次实际返回的选定字段做规范 JSON 重算。
        projectionSha256,
        projection: { fields: identity.fields, rowCount: rows.length, sha256: projectionSha256,
          basis: 'local_selected_fields_canonical_json' },
        // 单独记录 full resource vs projection proof，明确本地是否真的重算过全表。
        fullResource: { rowsSha256: identity.rowsSha256, rowCount: identity.rowCount, bytes: identity.rowsBytes,
          basis: 'server_descriptor', recomputedLocally: coversAllDeclared },
        verifiedScope,
        verification: { scope: verifiedScope, pages, cursorChain: 'complete', descriptorStable: true,
          fullRowsRecomputedLocally: coversAllDeclared, projectionRows: rows.length },
        pages,
        readAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      } as JsonValue;
      return { reference: fixed, rows: rows as Record<string, JsonValue>[], resolution, verifiedScope };
    },
  };
}

function envelope(binding: GenericDatabaseBinding, reference: AlgorithmSnapshotReference, cursor: string | undefined): GenericEnvelope {
  return { protocol_version: 3, contract_version: GENERIC_CONTRACT, instance_id: binding.instanceId,
    request_id: `algorithm-read-${randomUUID()}`, operation: 'data.read',
    arguments: { product_id: reference.productId, snapshot_id: reference.snapshotId, fields: reference.fields,
      limit: READ_LIMIT, ...(cursor ? { cursor } : {}) } };
}

function pageIdentity(page: WfdRecord, reference: AlgorithmSnapshotReference, continued: boolean) {
  if (page.product_id !== reference.productId || page.snapshot_id !== reference.snapshotId
    || page.definition_rev !== reference.definitionRevision) throw new TaskError('ALGORITHM_SNAPSHOT_MISMATCH', 'data.read 返回的产品、快照或定义修订与固定引用不同。');
  if (typeof page.commit_id !== 'string' || !page.commit_id || typeof page.committed_at !== 'string' || !page.committed_at) {
    throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'data.read 缺少固定提交身份或提交时刻。');
  }
  if (!Array.isArray(page.fields) || canonicalWfdJson(page.fields) !== canonicalWfdJson(reference.fields)) {
    throw new TaskError('ALGORITHM_SNAPSHOT_MISMATCH', 'data.read 返回字段与固定请求不同。');
  }
  if (!Array.isArray(page.rows) || page.rows.length > READ_LIMIT || page.returned_rows !== page.rows.length) {
    throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'data.read 返回行或 returned_rows 不一致。');
  }
  if (!Number.isSafeInteger(page.row_count) || Number(page.row_count) < 0) throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'data.read 缺少有效 row_count。');
  if (typeof page.rows_sha256 !== 'string' || !SHA256.test(page.rows_sha256)) throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'data.read 缺少有效 rows_sha256。');
  if (typeof page.definition_sha256 !== 'string' || !SHA256.test(page.definition_sha256)) throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'data.read 缺少有效 definition_sha256。');
  const descriptor = page.descriptor;
  if (!isWfdRecord(descriptor) || descriptor.row_count !== page.row_count || descriptor.rows_sha256 !== page.rows_sha256
    || descriptor.definition_sha256 !== page.definition_sha256 || !isWfdRecord(descriptor.declaration)
    || descriptor.declaration.product_id !== reference.productId || descriptor.declaration.definition_rev !== reference.definitionRevision) {
    throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'data.read descriptor 与固定产品、定义、行数或摘要不一致。');
  }
  const declaration = descriptor.declaration;
  const structure = isWfdRecord(declaration.structure) ? declaration.structure : undefined;
  const fields = structure && Array.isArray(structure.fields) ? structure.fields : undefined;
  const declaredFields = fields?.map(field => isWfdRecord(field) && typeof field.name === 'string' ? field.name : null);
  if (!declaredFields || declaredFields.some(field => field === null) || new Set(declaredFields).size !== declaredFields.length) {
    throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'data.read descriptor 缺少唯一、明确的声明字段集。');
  }
  for (const field of reference.fields) {
    if (!declaredFields.includes(field)) throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', `请求字段 ${field} 不在固定快照声明字段集中。`);
  }
  if (descriptor.rows_bytes !== undefined && (!Number.isSafeInteger(descriptor.rows_bytes) || Number(descriptor.rows_bytes) < 0)) {
    throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', 'data.read descriptor 的完整行资源字节数无效。');
  }
  const next = page.next_cursor;
  if (continued && page.rows.length === 0 && next !== null) throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '后续分页为空但游标未结束。');
  return { commitId: page.commit_id, rowsSha256: page.rows_sha256, rowCount: Number(page.row_count),
    definitionSha256: page.definition_sha256, fields: page.fields as string[],
    declaredFields: declaredFields as string[], rowsBytes: descriptor.rows_bytes === undefined ? null : Number(descriptor.rows_bytes),
    descriptorSha256: wfdSha256(canonicalWfdJson(descriptor)), committedAt: page.committed_at };
}

function assertReference(reference: AlgorithmSnapshotReference): void {
  if (reference.kind !== 'wfd_fixed_snapshot') throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '固定快照引用类型无效。');
  for (const [label, value] of [['实例', reference.instanceId], ['产品', reference.productId],
    ['快照', reference.snapshotId], ['定义修订', reference.definitionRevision]] as const) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value) || /^(latest|current)$/iu.test(value)) {
      throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', `固定快照${label}须为明确的非 latest 标识。`);
    }
  }
  if (!Array.isArray(reference.fields) || !reference.fields.length || reference.fields.length > 256
    || new Set(reference.fields).size !== reference.fields.length
    || reference.fields.some(field => typeof field !== 'string' || !field || field.length > 128)) {
    throw new TaskError('ALGORITHM_SNAPSHOT_INVALID', '固定快照字段须为 1 至 256 个不重复非空字段。');
  }
}
function message(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message : fallback; }
