import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CoreDatabase } from '../../platform/state/database.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { MaterialService } from './materials/service.js';
import type { OperatorContext } from './processing-plan.js';
import { adapterConfigDigest, discoverEndpointAdapter, matchAdapterContext, readAdapterBindingRef,
  readAdapterSourceContext, readEndpointAdapterConfig, readAdapterSelection, type AdapterSelection, type AdapterMatchEvidence,
  type EndpointAdapterConfig, type FrozenAdapterBinding } from './endpoint-adapter.js';
import { parseEndpointSource, type AdapterParseResult } from './endpoint-adapter.js';

export const ADAPTER_REGISTRY_VERSION = 'bd.endpoint-adapter-registry/1';
export const ADAPTER_REGISTRY_LIMITS = Object.freeze({ maxSamples: 16, maxExceptions: 200, maxVersions: 200 });

type AdapterStatus = 'candidate' | 'adopted' | 'retired';
/** 宿主从已有来源任务结果解析出的取得证据；只由服务装配提供，不从请求正文读取。 */
export interface AdapterReceiptEvidence {
  operation: string; observedAt: string; adjustment?: 'none' | 'qfq' | 'hfq' | 'unknown'; market?: string;
  /** 任务结果里声明的请求字段（只作冲突核对；实际字段以选中回执 URL 为准）。 */
  requestedFields?: string[]; requestedFields2?: string[];
  receipts: { url: string; sha256: string; fileRefId: string; contentType: string }[];
}
/** 受信来源下载动作；只有这些动作的持久结果才可能成为取得回执。 */
export const SOURCE_DOWNLOAD_ACTIONS = Object.freeze(['source.kline.read', 'source.api.read', 'source.fetch']);
/**
 * 生产 issuer：从已有任务记录解析取得回执。
 * 只接受成功、无需复核、由受信 producer 运行且动作属于来源下载的任务；
 * 请求字段/fields2 取自任务结果的实际请求参数与 URL 查询，不按配置回填。
 */
export function readSourceReceiptFromTask(task: { action: string; runtimeId: string; status: string; requiresReview?: boolean;
  versions?: Record<string, unknown>; result?: { data?: unknown } | null } | null | undefined,
  trustedRuntimes: readonly string[]): AdapterReceiptEvidence | null {
  if (!task || task.status !== 'succeeded' || task.requiresReview === true) return null;
  if (!trustedRuntimes.includes(task.runtimeId) || !SOURCE_DOWNLOAD_ACTIONS.includes(task.action)) return null;
  const data = task.result?.data as Record<string, unknown> | undefined;
  if (!data || !Array.isArray(data.sourceReceipts) || typeof data.operation !== 'string') return null;
  const requested = data.requested as Record<string, unknown> | undefined;
  const daily = data.dailyValidation as Record<string, unknown> | undefined;
  const adjustment = (daily?.adjustment ?? requested?.adjustment) as string | undefined;
  const scopeId = typeof data.scopeId === 'string' ? data.scopeId : undefined;
  const list = (value: unknown): string[] | undefined => Array.isArray(value) && value.length && value.every(item => typeof item === 'string')
    ? [...value as string[]] : undefined;
  const receipts = (data.sourceReceipts as Record<string, unknown>[]).flatMap(entry => {
    if (typeof entry.url !== 'string' || typeof entry.sha256 !== 'string' || typeof entry.fileRefId !== 'string') return [];
    return [{ url: entry.url, sha256: entry.sha256, fileRefId: entry.fileRefId, contentType: String(entry.contentType ?? '') }];
  });
  if (!receipts.length) return null;
  // 请求字段只作为声明携带；实际字段与顺序在选中本材料对应回执后按该回执 URL 解析。
  const requestedFields = list(requested?.fields), requestedFields2 = list(requested?.fields2);
  return { operation: data.operation, observedAt: String(data.observedAt ?? ''), ...(adjustment ? { adjustment: adjustment as 'none' | 'qfq' | 'hfq' | 'unknown' } : {}),
    ...(scopeId ? { market: scopeId === 'CN/A_STOCK' ? 'cn-a-share' : scopeId } : {}),
    ...(requestedFields ? { requestedFields } : {}), ...(requestedFields2 ? { requestedFields2 } : {}), receipts };
}
interface AdapterRow { adapter_id: string; version: string; config_digest: string; config_json: string; status: string;
  revision: number; created_at: number; updated_at: number; adopted_at: number | null; adopted_by: string | null; adoption_json: string | null }
interface ReplayRow { replay_id: string; adapter_id: string; version: string; config_digest: string; sample_sha256: string;
  material_id: string; expectation: string; outcome: string; evidence_json: string; created_at: number }
interface DriftRow { drift_id: string; adapter_id: string; version: string; config_digest: string; material_id: string | null;
  code: string; message: string; detail_json: string; created_at: number }

const SCHEMA = `
CREATE TABLE source_adapters (
 adapter_id TEXT NOT NULL, version TEXT NOT NULL, config_digest TEXT NOT NULL, config_json TEXT NOT NULL,
 status TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 adopted_at INTEGER, adopted_by TEXT, adoption_json TEXT, PRIMARY KEY(adapter_id,version)
);
CREATE INDEX source_adapters_status ON source_adapters(adapter_id,status,version);
CREATE TABLE source_adapter_replays (
 replay_id TEXT PRIMARY KEY, adapter_id TEXT NOT NULL, version TEXT NOT NULL, config_digest TEXT NOT NULL,
 sample_sha256 TEXT NOT NULL, material_id TEXT NOT NULL, expectation TEXT NOT NULL, outcome TEXT NOT NULL,
 evidence_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX source_adapter_replays_config ON source_adapter_replays(adapter_id,version,config_digest,created_at);
CREATE TABLE source_adapter_drift (
 drift_id TEXT PRIMARY KEY, adapter_id TEXT NOT NULL, version TEXT NOT NULL, config_digest TEXT NOT NULL,
 material_id TEXT, code TEXT NOT NULL, message TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX source_adapter_drift_adapter ON source_adapter_drift(adapter_id,version,created_at);
`;

const fail = (code: string, message: string): never => { throw new TaskError(code, message); };

/**
 * 端点适配版本登记：候选、样本重放、受控采用与漂移隔离。
 * 采用只接受本机受信入口的明确确认；模型或请求正文自报的授权、READY 或 authorized:true 都不是采用依据。
 * 计划按 (adapterId, version, configDigest) 冻结；新版本不会改写旧计划的解析实现。
 */
export class EndpointAdapterRegistry {
  readonly versionBinding: Record<string, string>;
  constructor(private readonly options: { database: CoreDatabase; materials: MaterialService;
    /** 宿主按已有来源任务/回执解析；不存在或不是来源下载任务时返回 null。 */
    sourceReceipt?(taskId: string): AdapterReceiptEvidence | null }) {
    // 适配重放只核来源载体的真实解析，不把清洗、结构化或 WFD 准入的实现版本绑定进来。
    const files = ['./endpoint-adapter-registry.ts', './endpoint-adapter.ts'].map(path => readFileSync(new URL(path, import.meta.url)));
    this.versionBinding = Object.freeze({ registry: ADAPTER_REGISTRY_VERSION,
      implementation: wfdSha256(Buffer.concat(files)) });
    options.database.migrate('collection_source_adapters', 1, SCHEMA);
  }
  private get db() { return this.options.database.connection; }

  catalog(): WfdRecord {
    const rows = this.db.prepare('SELECT * FROM source_adapters ORDER BY adapter_id,CAST(version AS INTEGER)').all() as unknown as AdapterRow[];
    const drift = this.db.prepare('SELECT COUNT(*) AS n FROM source_adapter_drift').get()!.n;
    return { contract: ADAPTER_REGISTRY_VERSION,
      versions: rows.slice(0, ADAPTER_REGISTRY_LIMITS.maxVersions).map(row => ({ adapterId: row.adapter_id, version: row.version,
        configDigest: row.config_digest, status: row.status, revision: row.revision, adoptedAt: row.adopted_at, adoptedBy: row.adopted_by,
        createdAt: row.created_at, updatedAt: row.updated_at })),
      driftCount: Number(drift),
      lifecycle: ['candidate', 'adopted', 'retired'],
      adoptionRule: '候选仅重放原件的载体、字段、类型和有据单位转换；受信入口确认正反样本。不等于清洗、金融语义、完整 WFD 管路或正式发布已验收。',
      binding: '计划与请求按 adapterId+version+configDigest 冻结；新采用版本只影响新计划。',
      limits: ADAPTER_REGISTRY_LIMITS };
  }

  list(adapterId?: string): WfdRecord[] {
    const rows = (adapterId ? this.db.prepare('SELECT * FROM source_adapters WHERE adapter_id=? ORDER BY CAST(version AS INTEGER) DESC').all(adapterId)
      : this.db.prepare('SELECT * FROM source_adapters ORDER BY adapter_id,CAST(version AS INTEGER)').all()) as unknown as AdapterRow[];
    return rows.map(row => this.versionView(row));
  }

  /** 候选提交只登记配置与摘要；不因提交而具备解析或采用资格。 */
  propose(value: unknown, operator: OperatorContext): WfdRecord {
    assertOperator(operator);
    const body = exactRecord(value, ['config'], 'ADAPTER_INPUT');
    const config = readEndpointAdapterConfig(body.config);
    const digest = adapterConfigDigest(config), existing = this.row(config.adapterId, config.version);
    if (existing) {
      if (existing.config_digest !== digest) fail('ADAPTER_VERSION_CONFLICT', '同一适配版本已登记不同配置；请递增版本，不能覆盖已冻结身份。');
      return { ...this.versionView(existing), created: false };
    }
    const now = Date.now();
    this.db.prepare('INSERT INTO source_adapters VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(config.adapterId, config.version, digest,
      canonicalWfdJson(config), 'candidate', 1, now, now, null, null, null);
    return { ...this.versionView(this.row(config.adapterId, config.version)!), created: true };
  }

  /** 自动发现只读取本机受管材料并生成候选；结果不落库、不采用、不影响任何计划。 */
  discover(value: unknown): WfdRecord {
    const body = exactRecord(value, ['materialId', 'adapterId', 'version', 'endpoint', 'protocol', 'frequency', 'sourceId', 'provider', 'coverage'], 'ADAPTER_INPUT');
    const materialId = text(body.materialId, 'ADAPTER_INPUT'), original = this.options.materials.readOriginal(materialId);
    const material = this.options.materials.get(materialId);
    if (material.envelope.sha256 !== original.sha256) fail('ADAPTER_MATERIAL_CHANGED', '材料原件摘要与登记不符。');
    const proposal = discoverEndpointAdapter(original.bytes, { adapterId: text(body.adapterId, 'ADAPTER_INPUT'),
      version: text(body.version, 'ADAPTER_INPUT'), endpoint: text(body.endpoint, 'ADAPTER_INPUT'),
      ...(body.protocol === undefined ? {} : { protocol: text(body.protocol, 'ADAPTER_INPUT') }),
      ...(body.frequency === undefined ? {} : { frequency: text(body.frequency, 'ADAPTER_INPUT') as EndpointAdapterConfig['match']['frequency'] }),
      sourceId: text(body.sourceId, 'ADAPTER_INPUT'), provider: text(body.provider, 'ADAPTER_INPUT'), coverage: text(body.coverage, 'ADAPTER_INPUT') });
    return { status: proposal.status, confidence: proposal.confidence, basis: proposal.basis, gaps: proposal.gaps,
      config: proposal.config, configDigest: adapterConfigDigest(proposal.config), materialId, materialSha256: original.sha256,
      persisted: false };
  }

  /**
   * 仅重放与正式解析模块共用的来源载体解码器。
   * 清洗、结构化、标注与核对由 BD 处理计划按本件数据实际需要独立调用；
   * 重放结论只授权适配器配置，不代表金融语义已确认或 WFD 可发布。
   */
  replay(value: unknown, operator: OperatorContext): WfdRecord {
    assertOperator(operator);
    const body = exactRecord(value, ['adapterId', 'version', 'samples'], 'ADAPTER_REPLAY');
    const adapterId = text(body.adapterId, 'ADAPTER_REPLAY'), version = text(body.version, 'ADAPTER_REPLAY');
    const row = this.row(adapterId, version) ?? fail('ADAPTER_NOT_FOUND', '没有该适配版本的登记。');
    if (row.status === 'retired') fail('ADAPTER_RETIRED', '已退役版本不能用于新的重放证据。');
    const config = JSON.parse(row.config_json) as EndpointAdapterConfig;
    if (!Array.isArray(body.samples) || !body.samples.length || body.samples.length > ADAPTER_REGISTRY_LIMITS.maxSamples)
      fail('ADAPTER_REPLAY', `重放须提供 1 至 ${ADAPTER_REGISTRY_LIMITS.maxSamples} 个明确样本。`);
    const implementation = this.versionBinding.implementation;
    const results: WfdRecord[] = [];
    for (const item of body.samples) {
      const sample = exactRecord(item, ['materialId', 'expectation', 'expectedCode', 'expect'], 'ADAPTER_REPLAY');
      const materialId = text(sample.materialId, 'ADAPTER_REPLAY');
      if (sample.expectation !== 'accept' && sample.expectation !== 'reject') fail('ADAPTER_REPLAY', '样本期望须明确为 accept 或 reject。');
      const expected = sample.expect === undefined ? null : readExpectation(sample.expect);
      // 期望值只能核对生产实际接受的结果；反样本必须由生产链真实拒绝，不能用期望错误伪造。
      if (expected && sample.expectation !== 'accept')
        fail('ADAPTER_REPLAY', '期望值只能用于期望接受的样本；反样本不能以期望值代替真实拒绝。');
      const original = this.options.materials.readOriginal(materialId), material = this.options.materials.get(materialId);
      if (material.envelope.sha256 !== original.sha256) fail('ADAPTER_MATERIAL_CHANGED', '重放材料原件摘要与登记不符。');
      let outcome: 'accept' | 'reject' = 'accept', code: string | null = null, message: string | null = null;
      let parsed: AdapterParseResult | null = null;
      try {
        parsed = parseEndpointSource(original.bytes, config);
      } catch (error) {
        if (!(error instanceof TaskError)) throw error;
        outcome = 'reject'; code = error.code; message = error.message;
      }
      // 期望值只针对实际解析字段，不由适配器重放触发其他数据处理模块。
      const rowCount: number | null = parsed ? parsed.rows.length : null;
      let actual: WfdRecord | null = null;
      const mismatch: string[] = [];
      if (parsed && expected) {
        const first = parsed.rows[expected.row];
        if (!first) mismatch.push(`期望第 ${expected.row + 1} 行不存在（实际 ${rowCount} 行）`);
        else {
          const current: WfdRecord = Object.fromEntries(parsed.columns.map((field, index) =>
            [field, first[index]?.value ?? null]));
          actual = Object.fromEntries(Object.keys(expected.values).map(field => [field, current[field] ?? null]));
          for (const [field, value] of Object.entries(expected.values))
            if (!Object.hasOwn(current, field) || String(current[field]) !== value)
              mismatch.push(`${field}: 期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(current[field] ?? null)}`);
        }
        if (expected.rowCount !== undefined && expected.rowCount !== rowCount)
          mismatch.push(`rowCount: 期望 ${expected.rowCount}，实际 ${rowCount}`);
      }
      const passed = outcome === sample.expectation
        && (outcome !== 'reject' || sample.expectedCode === undefined || sample.expectedCode === code)
        && mismatch.length === 0;
      const evidence = { adapterId, version, configDigest: row.config_digest, implementation,
        verifiedStage: 'parse_only', semanticApproval: false, wfdPublicationAuthorized: false,
        materialId, materialSha256: original.sha256,
        expectation: sample.expectation, ...(sample.expectedCode === undefined ? {} : { expectedCode: String(sample.expectedCode) }),
        ...(expected ? { expect: expected } : {}), outcome, code, message, rowCount, actual, mismatch, passed };
      const replayId = randomUUID();
      this.db.prepare('INSERT INTO source_adapter_replays VALUES(?,?,?,?,?,?,?,?,?,?)').run(replayId, adapterId, version,
        row.config_digest, original.sha256, materialId, sample.expectation, outcome, canonicalWfdJson(evidence), Date.now());
      results.push({ replayId, ...evidence });
    }
    return { adapterId, version, configDigest: row.config_digest, implementation, results,
      passed: results.every(result => result.passed === true), evidenceDigest: this.replayDigest(adapterId, version, row.config_digest) };
  }

  /**
   * 受控采用解析配置：同配置摘要下每个解析重放样本都必须通过（含期望值），
   * 至少一个正样本与一个反样本，且全部证据来自当前解析实现；确认摘要须等于服务实际证据摘要。
   * 会话模型不能直接采用。
   */
  adopt(value: unknown, operator: OperatorContext): WfdRecord {
    assertOperator(operator);
    if (operator.source === 'conversation') fail('ADAPTER_ADOPTION_AUTHORITY', '适配采用只能由本机受信入口确认；会话模型不能自行采用配置。');
    const body = exactRecord(value, ['adapterId', 'version', 'configDigest', 'evidenceDigest', 'confirmationDigest'], 'ADAPTER_ADOPT');
    const adapterId = text(body.adapterId, 'ADAPTER_ADOPT'), version = text(body.version, 'ADAPTER_ADOPT');
    const row = this.row(adapterId, version) ?? fail('ADAPTER_NOT_FOUND', '没有该适配版本的登记。');
    if (row.status === 'retired') fail('ADAPTER_RETIRED', '已退役版本不能重新采用。');
    if (body.configDigest !== undefined && body.configDigest !== row.config_digest)
      fail('ADAPTER_CONFIG_CHANGED', '采用请求的配置摘要与已登记版本不符；未按其他版本采用。');
    const evidenceDigest = this.replayDigest(adapterId, version, row.config_digest);
    if (!evidenceDigest) fail('ADAPTER_REPLAY_REQUIRED', '该版本尚无可核的重放证据，不能采用。');
    if (body.evidenceDigest !== evidenceDigest) fail('ADAPTER_EVIDENCE_CHANGED', '重放证据已变化；请按当前证据重新核对，不采用旧结论。');
    if (body.confirmationDigest !== evidenceDigest) fail('ADAPTER_CONFIRMATION_REQUIRED', '须明确确认当前重放证据的准确摘要。');
    const replays = this.replays(adapterId, version, row.config_digest);
    // 任一样本不符期望即不可采用；不能只看"存在通过的正/反样本"。
    if (replays.some(replay => replay.passed !== true))
      fail('ADAPTER_REPLAY_FAILED', '存在未通过的重放样本；整组证据不可用于采用。');
    if (replays.some(replay => replay.implementation !== this.versionBinding.implementation))
      fail('ADAPTER_IMPLEMENTATION_CHANGED', '重放证据来自不同解析实现；须按当前实现重新重放。');
    const accept = replays.some(replay => replay.expectation === 'accept' && replay.outcome === 'accept');
    const reject = replays.some(replay => replay.expectation === 'reject' && replay.outcome === 'reject');
    if (!accept || !reject) fail('ADAPTER_REPLAY_INCOMPLETE', '采用前须对同一配置实际重放至少一个正样本与一个反样本，并全部符合期望。');
    const now = Date.now();
    const adoption = { operatorId: operator.operatorId, requestId: operator.requestId, method: operator.method, path: operator.path,
      remoteAddress: operator.remoteAddress, observedAt: operator.observedAt, evidenceDigest,
      implementation: this.versionBinding.implementation,
      replays: replays.map(replay => ({ replayId: replay.replay_id, materialId: replay.material_id, expectation: replay.expectation,
        outcome: replay.outcome, passed: replay.passed })) };
    this.options.database.transaction(() => {
      // 历史未完成批次可能仍需要其已冻结的旧适配配置。当前版本由稳定 adapterId
      // 的 latestAdopted 选择，旧版本仅按明确的历史引用核对，不因采用新版就破坏旧任务。
      // 只有当前采用版本参与新任务的 adapterId 选择；已冻结旧任务读取其自身配置。
      this.db.prepare("UPDATE source_adapters SET status='retired',revision=revision+1,updated_at=? WHERE adapter_id=? AND status='adopted' AND version<>?")
        .run(now, adapterId, version);
      this.db.prepare(`UPDATE source_adapters SET status='adopted',revision=revision+1,updated_at=?,adopted_at=?,adopted_by=?,adoption_json=?
        WHERE adapter_id=? AND version=? AND config_digest=?`).run(now, now, operator.operatorId, canonicalWfdJson(adoption), adapterId, version, row.config_digest);
    });
    return { ...this.versionView(this.row(adapterId, version)!), adoption };
  }

  retire(adapterId: string, version: string, operator: OperatorContext): WfdRecord {
    assertOperator(operator);
    if (operator.source === 'conversation') fail('ADAPTER_ADOPTION_AUTHORITY', '退役只能由本机受信入口确认。');
    const row = this.row(adapterId, version) ?? fail('ADAPTER_NOT_FOUND', '没有该适配版本的登记。');
    if (row.status !== 'adopted') fail('ADAPTER_STATUS', '只有已采用版本可以退役。');
    this.db.prepare("UPDATE source_adapters SET status='retired',revision=revision+1,updated_at=? WHERE adapter_id=? AND version=?")
      .run(Date.now(), adapterId, version);
    return this.versionView(this.row(adapterId, version)!);
  }

  /**
   * 计划与请求只按已采用版本冻结；未采用、摘要不符或缺失一律阻断。
   * 提供本材料取得回执时同时核对地址/协议/字段顺序/频率/复权/市场；未提供时匹配结论为未核。
   */
  resolve(ref: AdapterSelection, options?: { materialId?: string; context?: unknown; sourceReceiptTaskId?: string }): FrozenAdapterBinding {
    const selected = readAdapterSelection(ref);
    const binding = 'version' in selected ? selected
      : this.latestAdopted(selected.adapterId) ?? fail('ADAPTER_NOT_ADOPTED',
        '此稳定适配器编号没有当前已采用实现；不能使用旧实现或未验证配置兜底。');
    const row = this.row(binding.adapterId, binding.version) ?? fail('ADAPTER_NOT_ADOPTED', '没有该适配版本的登记；未按猜测配置解析。');
    if (row.status !== 'adopted') fail('ADAPTER_NOT_ADOPTED', `适配 ${binding.adapterId}@${binding.version} 当前状态为 ${row.status}；只有已采用版本可用于新计划。`);
    if (row.config_digest !== binding.configDigest) fail('ADAPTER_CONFIG_CHANGED', '适配配置摘要与已采用版本不符；未换用其他版本继续。');
    const config = JSON.parse(row.config_json) as EndpointAdapterConfig;
    let match: AdapterMatchEvidence = { verified: false, consistent: false, kind: 'unverified', url: null, observedAt: null,
      gaps: ['未提供本材料实际取得回执；适配匹配未核，依赖匹配的算法与发布用途不能由已采用配置自动取得。'] };
    if (options?.context !== undefined && options?.sourceReceiptTaskId !== undefined)
      fail('ADAPTER_CONTEXT', '同一表源不能同时声明合成上下文与真实取得回执。');
    if (options?.sourceReceiptTaskId !== undefined) {
      const materialId = options.materialId ?? fail('ADAPTER_CONTEXT', '来源回执必须绑定本材料身份。');
      const material = this.options.materials.get(materialId);
      const resolver = this.options.sourceReceipt;
      if (!resolver) throw new TaskError('ADAPTER_RECEIPT_UNAVAILABLE', '本实例未装配来源回执解析，不能核真实取得。');
      const receipt = resolver(options.sourceReceiptTaskId)
        ?? fail('ADAPTER_RECEIPT_MISSING', '没有该来源任务的取得回执；未按正文自报或猜测取证。');
      // 文件引用与原始字节摘要必须同时对上，不能只按 URL 或文件名。
      const entry = receipt.receipts.find(item => item.sha256 === material.envelope.sha256
        && (material.envelope.fileRefId === undefined || item.fileRefId === material.envelope.fileRefId))
        ?? fail('ADAPTER_CONTEXT_MATERIAL', '来源回执中的文件引用或原字节摘要与本材料不符；未按其他取得关联匹配。');
      // 只按本材料选中回执的实际 URL 解析字段；任务结果声明与实际 URL 冲突时拒绝，不用声明覆盖实际。
      const query = (() => { try { return new URL(entry.url).searchParams; } catch { return null; } })();
      const fromUrl = (name: 'fields' | 'fields2') => {
        const raw = query?.get(name);
        return raw ? raw.split(',').filter(Boolean) : undefined;
      };
      const conflict = (declared: string[] | undefined, actual: string[] | undefined, label: string) => {
        // 实际 URL 是唯一依据：声明与它不一致、或声明了却在实际 URL 中缺失，都不能算已核。
        if (declared && !actual)
          fail('ADAPTER_CONTEXT_CONFLICT', `${label} 在所选回执实际 URL 中缺失；未用任务声明代替实际请求。`);
        if (declared && actual && canonicalWfdJson(declared) !== canonicalWfdJson(actual))
          fail('ADAPTER_CONTEXT_CONFLICT', `${label} 在任务结果声明与所选回执实际 URL 中不一致；未用声明覆盖实际请求。`);
        return actual;
      };
      const fields = conflict(receipt.requestedFields, fromUrl('fields'), '请求字段');
      const fields2 = conflict(receipt.requestedFields2, fromUrl('fields2'), 'fields2');
      const context = { kind: 'receipt' as const, url: entry.url, materialSha256: material.envelope.sha256,
        observedAt: receipt.observedAt, protocol: `${receipt.operation}|${entry.contentType}`,
        frequency: receipt.operation === 'daily_bars' ? 'day' as const : receipt.operation === 'minute_bars' ? 'minute' as const : 'other' as const,
        ...(receipt.adjustment ? { adjustment: receipt.adjustment } : {}),
        ...(receipt.market ? { market: receipt.market } : {}),
        ...(fields ? { fields } : {}), ...(fields2 ? { fields2 } : {}),
        basis: `来源任务 ${options.sourceReceiptTaskId} 的实际取得回执（${receipt.operation}）。` };
      // 宿主解析出的回执上下文不经正文读取器（该读取器只接受 synthetic）。
      match = matchAdapterContext(config, context, material.envelope.sha256);
    } else if (options?.context !== undefined) {
      const materialId = options.materialId ?? fail('ADAPTER_CONTEXT', '来源上下文必须绑定本材料身份。');
      const material = this.options.materials.get(materialId);
      const context = readAdapterSourceContext(options.context);
      match = matchAdapterContext(config, context, material.envelope.sha256);
    }
    return { adapterId: row.adapter_id, version: row.version, configDigest: row.config_digest, config, match };
  }

  latestAdopted(adapterId: string): FrozenAdapterBinding | null {
    const row = this.db.prepare("SELECT * FROM source_adapters WHERE adapter_id=? AND status='adopted' ORDER BY CAST(version AS INTEGER) DESC LIMIT 1")
      .get(adapterId) as AdapterRow | undefined;
    return row ? { adapterId: row.adapter_id, version: row.version, configDigest: row.config_digest,
      config: JSON.parse(row.config_json) as EndpointAdapterConfig } : null;
  }

  /** 漂移隔离：只记录实际失败原因，不改配置、不重试其他版本。 */
  recordDrift(input: { adapterId: string; version: string; configDigest: string; materialId: string | null; code: string; message: string; detail?: WfdRecord }): void {
    this.db.prepare('INSERT INTO source_adapter_drift VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), input.adapterId, input.version,
      input.configDigest, input.materialId, input.code.slice(0, 128), input.message.slice(0, 2000),
      canonicalWfdJson(input.detail ?? {}), Date.now());
  }

  exceptions(limit = 50): WfdRecord {
    const bounded = Number.isSafeInteger(limit) && limit > 0 && limit <= ADAPTER_REGISTRY_LIMITS.maxExceptions ? limit : 50;
    const rows = this.db.prepare('SELECT * FROM source_adapter_drift ORDER BY created_at DESC,rowid DESC LIMIT ?').all(bounded) as unknown as DriftRow[];
    return { items: rows.map(row => ({ driftId: row.drift_id, adapterId: row.adapter_id, version: row.version,
      configDigest: row.config_digest, materialId: row.material_id, code: row.code, message: row.message,
      detail: JSON.parse(row.detail_json) as WfdRecord, createdAt: row.created_at })), limit: bounded,
      note: '漂移记录只说明实际失败原因；旧计划不因新配置或新证据自动重跑。' };
  }

  private row(adapterId: string, version: string): AdapterRow | undefined {
    return this.db.prepare('SELECT * FROM source_adapters WHERE adapter_id=? AND version=?').get(adapterId, version) as AdapterRow | undefined;
  }
  private versionView(row: AdapterRow): WfdRecord {
    return { adapterId: row.adapter_id, version: row.version, configDigest: row.config_digest, status: row.status as AdapterStatus,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, adoptedAt: row.adopted_at, adoptedBy: row.adopted_by,
      config: JSON.parse(row.config_json) as WfdRecord };
  }
  private replays(adapterId: string, version: string, configDigest: string) {
    const rows = this.db.prepare('SELECT * FROM source_adapter_replays WHERE adapter_id=? AND version=? AND config_digest=? ORDER BY created_at,rowid')
      .all(adapterId, version, configDigest) as unknown as ReplayRow[];
    return rows.map(row => {
      const evidence = JSON.parse(row.evidence_json) as { passed?: boolean; implementation?: string };
      return { ...row, passed: evidence.passed === true, implementation: evidence.implementation ?? null };
    });
  }
  /**
   * 证据摘要覆盖实际重放结论与当前解析实现，不含时间戳。
   * 实现变化或任一结论变化都会改变摘要，旧确认不能用于新实现。
   */
  private replayDigest(adapterId: string, version: string, configDigest: string): string | null {
    const rows = this.replays(adapterId, version, configDigest);
    if (!rows.length) return null;
    return wfdSha256(canonicalWfdJson({ implementation: this.versionBinding.implementation,
      replays: rows.map(row => ({ replayId: row.replay_id, materialSha256: row.sample_sha256, expectation: row.expectation,
        outcome: row.outcome, evidence: JSON.parse(row.evidence_json) as WfdRecord })) }));
  }
}

function assertOperator(operator: OperatorContext): void {
  if (!operator || typeof operator !== 'object' || Array.isArray(operator)) fail('ADAPTER_OPERATOR', '需要真实操作者请求身份。');
  if (typeof operator.operatorId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(operator.operatorId)
    || typeof operator.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(operator.requestId)) fail('ADAPTER_OPERATOR', '操作者或请求身份无效。');
}
/** 只做键集合核对；值仍由各字段的显式类型检查逐项验证。 */
function exactRecord(value: unknown, keys: string[], code: string): Record<string, any> {
  if (!isWfdRecord(value) || Object.keys(value).some(key => !keys.includes(key))) fail(code, `需要明确对象且只接受字段：${keys.join(', ')}。`);
  return value as Record<string, any>;
}
/** 期望值只用于重放核对：字段须存在于产出、值为精确文本；不做类型推断。 */
function readExpectation(value: unknown): { row: number; rowCount?: number; values: Record<string, string> } {
  const record = exactRecord(value, ['row', 'rowCount', 'values'], 'ADAPTER_REPLAY');
  const row = record.row === undefined ? 0 : record.row;
  if (!Number.isSafeInteger(row) || row < 0 || row > 100_000) fail('ADAPTER_REPLAY', '期望行号须为明确非负整数。');
  if (record.rowCount !== undefined && (!Number.isSafeInteger(record.rowCount) || record.rowCount < 0 || record.rowCount > 100_000))
    fail('ADAPTER_REPLAY', '期望行数须为明确非负整数。');
  if (!isWfdRecord(record.values) || !Object.keys(record.values).length || Object.keys(record.values).length > 64)
    fail('ADAPTER_REPLAY', '期望值须逐字段提供明确文本。');
  const values = Object.fromEntries(Object.entries(record.values).map(([field, expected]) => {
    if (typeof expected !== 'string' && typeof expected !== 'number' && typeof expected !== 'boolean')
      fail('ADAPTER_REPLAY', '期望值须为标量文本。');
    return [field, String(expected)];
  }));
  return { row: Number(row), ...(record.rowCount === undefined ? {} : { rowCount: Number(record.rowCount) }), values };
}
function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/u.test(value))
    throw new TaskError(code, '需要明确非空文本。');
  return value;
}
