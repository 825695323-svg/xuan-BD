import type { R1PrepareInput, R1SourceDeclaration } from '../../../contracts/r1-contracts.js';
import { TABULAR_KEY_ALGORITHM, TABULAR_FIELD_CODE, createTabularRowSemantics, tabularDigest, tabularPartitionValue,
  type TabularBatchChunk, type TabularPartition, type TabularTableContract } from '../../../contracts/tabular-batch.js';
import { buildTabularBulkTarget, verifyFrozenTabularBulkProfile, type FrozenTabularBulkProfile } from '../tabular-bulk-profile.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isWfdRecord, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import { candidateCsvRecords } from '../candidate-csv-records.js';
import { annotateCandidateTable, candidateImplementationDigest, CANDIDATE_STAGE_VERSIONS, checkCandidateTables,
  cleanCandidateTable, parseTableSource, structureCandidateTable } from '../candidate-pipeline.js';
import { assertEmptyBulkStaging, bulkCoordinates, bulkRawRecords, createBulkSorter, readBulkChunk, readBulkLocators,
  TABULAR_BULK_LIMITS, type BulkRawRecord, type BulkLocator } from './tabular-bulk-engine.js';

export { TABULAR_BULK_LIMITS } from './tabular-bulk-engine.js';

export const TABULAR_BULK_VERSION = 'bd.tabular-bulk/1' as const;
export interface TabularBulkPlanInput {
  profile: FrozenTabularBulkProfile; source: R1SourceDeclaration;
  namespace: string; datasetId: string; parentSnapshotId: string | null;
  materialId: string; sourceSha256: string; sourceBytes: number;
  targetIdentity: WfdRecord; partitionValue?: string;
}
export interface TabularBulkPlan extends TabularBulkPlanInput {
  version: typeof TABULAR_BULK_VERSION; digest: string;
  versions: WfdRecord; limits: typeof TABULAR_BULK_LIMITS;
}
export type TabularBulkLocator = BulkLocator;
export interface TabularBulkManifest {
  version: typeof TABULAR_BULK_VERSION; planDigest: string; manifestDigest: string;
  sourceSha256: string; sourceBytes: number; materialId: string; headerRange: TabularBulkLocator;
  evidenceRange: { startByte: 0; endByte: number; sha256: string };
  target: R1PrepareInput['target']; fieldCodes: string[]; partition: TabularPartition; tableContract: TabularTableContract;
  rowCount: number; rowsDigest: string; chunks: TabularBatchChunk[]; locatorDigests: string[];
  check: { quality: 'pass'; standardMarketCalculation: false; candidateStages: typeof CANDIDATE_STAGE_VERSIONS;
    checkScope: string[]; gaps: string[]; segments: number; changesTotal: number; typeChangesTotal: number;
    segmentEvidenceDigest: string };
}

const fail = (code: string, message: string): never => { throw new TaskError('TABULAR_BULK_' + code, message); };
const IMPLEMENTATION = wfdSha256(Buffer.concat(['./tabular-bulk.ts','./tabular-bulk-engine.ts','../tabular-bulk-profile.ts',
  '../r1-evidence.ts','../../../contracts/tabular-batch.ts','./material-inspector/index.ts','../production-verifier.ts']
  .map(path => readFileSync(new URL(path, import.meta.url)))));

export function freezeTabularBulkPlan(input: TabularBulkPlanInput): TabularBulkPlan {
  const profile = verifyFrozenTabularBulkProfile(input.profile);
  if (input.source.source_id !== profile.profile.sourceId || !input.source.provider || !input.materialId || !input.datasetId
    || !TABULAR_FIELD_CODE.test(input.namespace) || !isWfdRecord(input.targetIdentity)
    || !Number.isSafeInteger(input.sourceBytes) || input.sourceBytes < 1 || input.sourceBytes > TABULAR_BULK_LIMITS.sourceBytes
    || typeof input.sourceSha256 !== 'string' || !/^(?:sha256:)?[0-9a-f]{64}$/u.test(input.sourceSha256))
    return fail('PLAN', '来源档案、原件、目标的冻结证据不完整或超出单件接收预算。');
  const partitionValue = input.partitionValue === undefined ? undefined : tabularPartitionValue(input.partitionValue);
  if (partitionValue === undefined && profile.profile.tableContract.partition_field === null)
    return fail('PLAN', '没有分区字段的档案须明确指定文件的常量分区值。');
  const plan: Omit<TabularBulkPlan, 'digest'> = {
    version: TABULAR_BULK_VERSION, profile, source: structuredClone(input.source), namespace: input.namespace,
    datasetId: input.datasetId, parentSnapshotId: input.parentSnapshotId, materialId: input.materialId,
    sourceSha256: input.sourceSha256.startsWith('sha256:') ? input.sourceSha256 : 'sha256:' + input.sourceSha256,
    sourceBytes: input.sourceBytes, targetIdentity: structuredClone(input.targetIdentity),
    ...(partitionValue === undefined ? {} : { partitionValue }), limits: TABULAR_BULK_LIMITS,
    versions: { implementation: IMPLEMENTATION, candidate: candidateImplementationDigest(), steps: CANDIDATE_STAGE_VERSIONS,
      key: TABULAR_KEY_ALGORITHM, text: 'utf8-csv-verbatim-and-empty-unknown/1', sort: 'utf8-tuple-order/1' },
  };
  return { ...plan, digest: tabularDigest(plan) };
}

export interface TabularBulkProgress { stage: 'parse' | 'sort' | 'check'; rowCount: number; sourceBytes: number }

/** Compile selected CSV to a bounded, complete-partition transport artifact. */
export async function compileTabularBulk(input: {
  plan: TabularBulkPlan; original: AsyncIterable<Uint8Array>; stagingDir: string;
  signal?: AbortSignal; assertGrowth?: (bytes: number) => void;
  onProgress?: (progress: TabularBulkProgress) => void | Promise<void>;
}): Promise<TabularBulkManifest> {
  input.signal?.throwIfAborted();
  const { digest: frozenDigest, ...savedPlan } = input.plan;
  const plan = freezeTabularBulkPlan(savedPlan);
  if (plan.digest !== frozenDigest || tabularDigest(savedPlan) !== frozenDigest)
    return fail('PLAN_CHANGED', '冻结计划、来源/目标或加工版本已改变；未按新计划重建同一请求。');
  await assertEmptyBulkStaging(input.stagingDir, fail);
  const sourceHash = createHash('sha256'), checkedSegments = createHash('sha256');
  const raw = bulkRawRecords(input.original, plan.sourceBytes, sourceHash, fail);
  const first = await raw.next();
  if (first.done) return fail('HEADER', 'CSV 原件没有实际表头。');
  const header = first.value, table = plan.profile.profile.tableContract;
  const fieldCodes = table.fields;
  const sorter = createBulkSorter(input, { fieldCount: fieldCodes.length, keyIndices: table.key_fields.map(field => fieldCodes.indexOf(field)),
    fail, duplicateLabel: '冻结业务键' });
  const byHeader = new Map(plan.profile.profile.columns.flatMap(column =>
    [column.originalHeader, ...(column.aliases ?? [])].map(name => [name, column.fieldCode] as const)));
  const orderedColumns: string[] = [];
  let actualColumns: string[] = [];
  let semantics = createTabularRowSemantics(table, plan.partitionValue === undefined ? undefined : { value: plan.partitionValue });
  let partitionValue = plan.partitionValue, segment: BulkRawRecord[] = [], segmentBytes = 0;
  let rowCount = 0, sourceRows = 0, sourceBytes = header.locator.endByte;
  let target: TabularBulkManifest['target'] | undefined, evidenceRange: TabularBulkManifest['evidenceRange'] | undefined;
  let checkScope: string[] = [], gaps: string[] = [], segments = 0, changesTotal = 0, typeChangesTotal = 0;
  const report = async (stage: TabularBulkProgress['stage']) => {
    input.signal?.throwIfAborted();
    await input.onProgress?.({ stage, rowCount, sourceBytes });
  };
  const processSegment = async () => {
    if (!segment.length) return;
    input.signal?.throwIfAborted();
    const actual = Buffer.concat([header.bytes, ...segment.map(row => row.bytes)]);
    try {
      // Verify the same bounded candidate representation as the existing CSV processing rules.
      const parsed = parseTableSource(actual, { materialId: plan.materialId, format: 'csv',
        types: Object.fromEntries(actualColumns.map(column => [column, 'string' as const])) });
      const cleaned = cleanCandidateTable(parsed);
      const structured = structureCandidateTable(cleaned);
      const checked = checkCandidateTables([annotateCandidateTable(structured)]);
      const { evidence } = checked;
      if (checked.rows.length !== segment.length || parsed.columns.some((column, i) => column !== actualColumns[i]))
        return fail('COVERAGE', '加工片段未完整覆盖实际 CSV 行与原列。');
      for (const [i, row] of checked.rows.entries()) {
        const locator = segment[i]!.locator;
        const cells = orderedColumns.map(column => {
          const value = row[column], original = parsed.rows[i]![actualColumns.indexOf(column)]!.original;
          if (value !== original)
            return fail('ROW_CONTRACT', '本档案只允许发布原报文字；不能把改变过的值冒充原件。');
          if (value !== null && typeof value !== 'string') return fail('LEXEME', '通道单元格只能保留原文或未知空值。');
          return value;
        });
        let value: string;
        try { ({ value } = semantics.validate(cells)); } catch (error) {
          return fail('ROW_CONTRACT', `${bulkCoordinates(locator)}不满足冻结契约：${error instanceof Error ? error.message : String(error)}`);
        }
        if (partitionValue === undefined) {
          partitionValue = value;
          semantics = createTabularRowSemantics(table, { value });
        }
        const pending = sorter.add(cells, locator);
        if (pending) await pending;
      }
      sourceBytes = segment.at(-1)!.locator.endByte;
      if (!target) {
        target = buildTabularBulkTarget(plan, actual, orderedColumns);
        evidenceRange = { startByte: 0, endByte: sourceBytes, sha256: 'sha256:' + parsed.source_sha256 };
        checkScope = evidence.check_scope; gaps = evidence.gaps;
      }
      checkedSegments.update(tabularDigest(evidence) + '\n');
      changesTotal += evidence.changes_total;
      typeChangesTotal += evidence.type_changes_total;
      segments++;
      rowCount += checked.rows.length;
    } catch (error) {
      if (error instanceof TaskError && error.code.startsWith('TABULAR_BULK_')) throw error;
      return fail('FRAGMENT', `${bulkCoordinates(segment[0]!.locator)}起的分片加工失败：${error instanceof Error ? error.message : String(error)}`);
    }
    segment = []; segmentBytes = 0;

  };
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let headerText: string;
    try { headerText = decoder.decode(header.bytes); } catch { return fail('ENCODING', '原件表头不是严格 UTF-8。'); }
    const [columns, extra] = [...candidateCsvRecords(headerText, { maxColumns: fieldCodes.length, maxCellCharacters: 512 })];
    actualColumns = columns?.map(column => column.value) ?? [];
    const codes = actualColumns.map(column => byHeader.get(column));
    if (extra || codes.length !== fieldCodes.length || codes.some(code => !code) || new Set(codes).size !== codes.length)
      return fail('HEADER', '实际表头须完整且唯一对应已审核档案，未静默增删或改名。');
    orderedColumns.push(...fieldCodes.map(code => actualColumns[codes.indexOf(code)]!));
    for await (const record of raw) {
      if (++sourceRows > TABULAR_BULK_LIMITS.rows) return fail('ROW_BUDGET', 'CSV 超过单件数据行上限，未截断。');
      if (segment.length >= TABULAR_BULK_LIMITS.segmentRows || segmentBytes + record.bytes.length > TABULAR_BULK_LIMITS.segmentBytes) {
        await processSegment();
        segment = []; segmentBytes = 0;
        if (rowCount % 10_000 < TABULAR_BULK_LIMITS.segmentRows) await report('parse');
      }
      segment.push(record); segmentBytes += record.bytes.length;
    }
  } finally { await raw.return(undefined); }
  if ('sha256:' + sourceHash.digest('hex') !== plan.sourceSha256) return fail('SOURCE_CHANGED', '完整受管原件与冻结 SHA-256 不符。');
  await processSegment();
  if (!target || !evidenceRange || partitionValue === undefined || !rowCount || rowCount !== sourceRows || sourceBytes !== plan.sourceBytes)
    return fail('COVERAGE', '整件加工未覆盖全部冻结原件和实际记录。');
  const sorted = await sorter.finish(rowCount, report);
  const manifest: Omit<TabularBulkManifest, 'manifestDigest'> = {
    version: TABULAR_BULK_VERSION, planDigest: plan.digest, sourceSha256: plan.sourceSha256, sourceBytes: plan.sourceBytes,
    materialId: plan.materialId, headerRange: header.locator, evidenceRange, target, fieldCodes, partition: { value: partitionValue },
    tableContract: table, rowCount, ...sorted,
    check: { quality: 'pass', standardMarketCalculation: false, candidateStages: CANDIDATE_STAGE_VERSIONS,
      checkScope, gaps, segments, changesTotal, typeChangesTotal, segmentEvidenceDigest: 'sha256:' + checkedSegments.digest('hex') },
  };
  await report('check');
  return { ...manifest, manifestDigest: tabularDigest(manifest) };
}

export const readTabularBulkChunk = (stagingDir: string, chunk: TabularBatchChunk, fieldCount: number) =>
  readBulkChunk(stagingDir, chunk, fieldCount, fail);
export const readTabularBulkLocators = (stagingDir: string, chunk: TabularBatchChunk, locatorDigest: string) =>
  readBulkLocators(stagingDir, chunk, locatorDigest, fail);
