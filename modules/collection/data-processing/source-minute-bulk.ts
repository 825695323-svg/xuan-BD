import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import type { R1PrepareInput, R1SourceDeclaration } from '../../../contracts/r1-contracts.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import { candidateCsvRecords } from '../candidate-csv-records.js';
import { annotateCandidateTable, candidateImplementationDigest, CANDIDATE_STAGE_VERSIONS, checkCandidateTables,
  cleanCandidateTable, parseTableSource, structureCandidateTable } from '../candidate-pipeline.js';
import { resolveSourceReportedEvidence, type R1EvidenceProposal } from '../r1-evidence.js';
import { checkR1TabularRows, type R1TabularCompilation } from '../r1-tabular.js';
import { profileFingerprint, readSourceFieldProfile, sourceFieldProfileDigest, type FrozenSourceFieldProfile } from '../source-field-profile.js';
import { sourceReportedDate, sourceReportedMinute } from '../source-reported-table.js';
import { assertEmptyBulkStaging, bulkCoordinates as coordinates, bulkRawRecords, createBulkSorter, readBulkChunk, readBulkLocators,
  TABULAR_BULK_LIMITS, type BulkRawRecord as RawRecord } from './tabular-bulk-engine.js';

export const SOURCE_MINUTE_BULK_VERSION = 'bd.source-minute-bulk/1';
export const SOURCE_MINUTE_BULK_KEY = 'wfd.source-minute-key/1';
export const SOURCE_MINUTE_BULK_LIMITS = TABULAR_BULK_LIMITS;
const TIMEZONE = 'Asia/Shanghai';
const IMPLEMENTATION = wfdSha256(Buffer.concat(['./source-minute-bulk.ts',
  './tabular-bulk-engine.ts', '../r1-evidence.ts', '../r1-tabular.ts', '../source-field-profile.ts',
  '../candidate-pipeline.ts', '../candidate-csv-records.ts', '../source-reported-table.ts',
  '../../../adapters/database/wfd-transport.ts'].map(path => readFileSync(new URL(path, import.meta.url)))));
const fail = (code: string, message: string): never => { throw new TaskError('SOURCE_MINUTE_BULK_' + code, message); };
const digest = (value: unknown) => 'sha256:' + wfdSha256(canonicalWfdJson(value));
const shaSyntax = /^sha256:[0-9a-f]{64}$/u;
const wireCode = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;

export interface SourceMinuteBulkPlanInput {
  profile: FrozenSourceFieldProfile; source: R1SourceDeclaration;
  namespace: string; datasetId: string; parentSnapshotId: string | null;
  materialId: string; sourceSha256: string; sourceBytes: number;
  /** Host-only reference to the authorized request, destination and duplicate policy. */
  targetIdentity: WfdRecord; partitionDate?: string;
}
export interface SourceMinuteBulkPlan extends SourceMinuteBulkPlanInput {
  version: typeof SOURCE_MINUTE_BULK_VERSION; digest: string;
  versions: WfdRecord; limits: typeof SOURCE_MINUTE_BULK_LIMITS;
}
export interface SourceMinuteBulkPartition {
  date: string; date_field: string; minute_field: string; identity_field: string;
  timezone: typeof TIMEZONE; key_algorithm: typeof SOURCE_MINUTE_BULK_KEY;
}
export interface SourceMinuteBulkChunk {
  chunk_id: string; ordinal: number; row_count: number; digest: string;
}
export interface SourceMinuteBulkLocator {
  /** CSV logical record number including the header (record 1), and physical starting line. */
  sourceRow: number; sourceLine: number; startByte: number; endByte: number;
}
export interface SourceMinuteBulkManifest {
  version: typeof SOURCE_MINUTE_BULK_VERSION; planDigest: string; manifestDigest: string;
  sourceSha256: string; sourceBytes: number; materialId: string; headerRange: SourceMinuteBulkLocator;
  evidenceRange: { startByte: 0; endByte: number; sha256: string };
  target: R1PrepareInput['target']; fieldCodes: string[]; partition: SourceMinuteBulkPartition;
  rowCount: number; rowsDigest: string; chunks: SourceMinuteBulkChunk[];
  /** BD-local only: hashes of the parallel ordered source location arrays, by chunk ordinal. */
  locatorDigests: string[];
  check: Omit<R1TabularCompilation, 'applicable'> & { quality: 'pass' | 'indeterminate'; standardMarketCalculation: false };
}
export interface SourceMinuteBulkProgress { stage: 'parse' | 'sort' | 'check'; rowCount: number; sourceBytes: number }

export function freezeSourceMinuteBulkPlan(input: SourceMinuteBulkPlanInput): SourceMinuteBulkPlan {
  const profile = readSourceFieldProfile(input.profile.profile, 'source-minute-bulk');
  const { fields, timeBucket } = profile;
  if (sourceFieldProfileDigest(profile) !== input.profile.digest || profileFingerprint(profile) !== input.profile.fingerprint)
    fail('PROFILE', '冻结的来源字段档案摘要与实际声明不一致。');
  if (profile.sourceId !== input.source.source_id || !input.source.provider || !profile.series || profile.adapter
    || profile.frequency !== 'minute' || timeBucket.timezone !== TIMEZONE || timeBucket.lengthMinutes !== 1
    || timeBucket.labelSemantics !== 'unknown' || timeBucket.interval !== 'unknown' || profile.adjustment.status !== 'unknown'
    || fields.length !== 11 || fields.some(field => field.dataType !== 'text' || !wireCode.test(field.fieldCode)
      || field.unitCode !== (field.role === 'date' ? 'date' : 'not_applicable'))
    || ['date', 'minute', 'identity'].some(role => fields.filter(field => field.role === role).length !== 1)
    || fields.filter(field => field.measurementStatus === 'unknown').length !== 7
    || fields.some(field => field.measurementStatus === 'unknown' && field.role !== 'value'))
    fail('PROFILE', '此批量版本只接受同来源的 11 列原报文字档案、一个日期/分钟/身份轴、七个明确未知计量字段及未确认的分钟口径。');
  if (!input.materialId || !input.datasetId || !wireCode.test(input.namespace) || !isWfdRecord(input.targetIdentity)
    || !Number.isSafeInteger(input.sourceBytes) || input.sourceBytes < 1 || input.sourceBytes > SOURCE_MINUTE_BULK_LIMITS.sourceBytes
    || (input.partitionDate !== undefined && !sourceReportedDate(input.partitionDate, 'yyyymmdd'))
    || typeof input.sourceSha256 !== 'string' || !shaSyntax.test(input.sourceSha256.startsWith('sha256:') ? input.sourceSha256 : 'sha256:' + input.sourceSha256))
    fail('PLAN', '原件、目标或分区冻结证据不完整，或已超过单件接收预算。');
  const body: Omit<SourceMinuteBulkPlan, 'digest'> = {
    profile: { profile, digest: input.profile.digest, fingerprint: input.profile.fingerprint },
    source: structuredClone(input.source), namespace: input.namespace, datasetId: input.datasetId,
    parentSnapshotId: input.parentSnapshotId, materialId: input.materialId,
    sourceSha256: input.sourceSha256.startsWith('sha256:') ? input.sourceSha256 : 'sha256:' + input.sourceSha256,
    sourceBytes: input.sourceBytes, targetIdentity: structuredClone(input.targetIdentity),
    ...(input.partitionDate === undefined ? {} : { partitionDate: input.partitionDate }),
    version: SOURCE_MINUTE_BULK_VERSION, limits: SOURCE_MINUTE_BULK_LIMITS,
    versions: { implementation: IMPLEMENTATION, candidate: candidateImplementationDigest(), steps: CANDIDATE_STAGE_VERSIONS,
      key: SOURCE_MINUTE_BULK_KEY, text: 'utf8-csv-verbatim-and-empty-unknown/1', sort: 'utf8-pair-order/1' },
  };
  return { ...body, digest: digest(body) };
}

export function sourceMinuteBulkKey(date: string, identity: string, minute: string): string {
  return 'source_minute_' + date + '_' + wfdSha256(canonicalWfdJson([identity, minute]));
}

function readHeader(header: RawRecord, profile: FrozenSourceFieldProfile) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text: string;
  try { text = decoder.decode(header.bytes); } catch { return fail('ENCODING', '原件表头不是严格 UTF-8。'); }
  const [cells, extra] = [...candidateCsvRecords(text, { maxColumns: 11, maxCellCharacters: 512 })];
  const columns = cells?.map(cell => cell.value) ?? [];
  const byName = new Map(profile.profile.fields.flatMap(field => [field.originalHeader, ...(field.aliases ?? [])].map(name => [name, field] as const)));
  const fields = columns.map(column => byName.get(column));
  if (extra || fields.length !== 11 || fields.some(field => !field) || new Set(fields).size !== fields.length)
    fail('HEADER', '实际表头须完整命中冻结档案的 11 个不同字段；未静默增删或改名。');
  return { columns, fields: fields as FrozenSourceFieldProfile['profile']['fields'] };
}

function wireProposal(plan: SourceMinuteBulkPlan, proposal: R1EvidenceProposal, axes: Omit<SourceMinuteBulkPartition, 'date'>) {
  const target = structuredClone(proposal.target);
  const family = wfdSha256(canonicalWfdJson({ legacyFamily: target.definition.semantic_code, key: SOURCE_MINUTE_BULK_KEY,
    date_field: axes.date_field, minute_field: axes.minute_field, identity_field: axes.identity_field })).slice(0, 32);
  target.outputKey = 'source_minute.' + family;
  target.subject.id = 'source_minute_table.' + family;
  target.coverage.scope = { subject_id: target.subject.id };
  target.definition.semantic_code = target.outputKey;
  const context = target.definition.semantic_context as WfdRecord;
  const identity = context.identity as WfdRecord;
  identity.identity_resolution_rule = SOURCE_MINUTE_BULK_KEY + ':' + canonicalWfdJson({
    date_field: axes.date_field, minute_field: axes.minute_field, identity_field: axes.identity_field,
    order: ['identity UTF-8 bytes', 'minute UTF-8 bytes'],
    record_id: 'source_minute_YYYYMMDD_ + SHA256(canonical([identity,minute]))',
  });
  if (proposal.mapping.bar || proposal.mapping.publicTime || context.content_nature !== 'source_claim'
    || target.expectedParentSnapshotId !== plan.parentSnapshotId)
    fail('DEFINITION', '批量产品须为来源原报，无标准行情角色或已确认公开时间。');
  return target;
}

export async function compileSourceMinuteBulk(input: {
  plan: SourceMinuteBulkPlan; original: AsyncIterable<Uint8Array>; stagingDir: string;
  signal?: AbortSignal;
  assertGrowth?: (bytes: number) => void;
  onProgress?: (progress: SourceMinuteBulkProgress) => void | Promise<void>;
}): Promise<SourceMinuteBulkManifest> {
  input.signal?.throwIfAborted();
  const { digest: frozenDigest, ...savedPlan } = input.plan;
  const plan = freezeSourceMinuteBulkPlan(savedPlan);
  if (plan.digest !== frozenDigest || digest(savedPlan) !== frozenDigest)
    fail('PLAN_CHANGED', '冻结计划、来源/目标或加工版本已改变；未按新计划重建同一请求。');
  await assertEmptyBulkStaging(input.stagingDir, fail);
  const sourceHash = createHash('sha256');
  const raw = bulkRawRecords(input.original, plan.sourceBytes, sourceHash, fail);
  const first = await raw.next();
  if (first.done) fail('HEADER', 'CSV 原件没有实际表头。');
  const header = first.value!;
  let layout: ReturnType<typeof readHeader>;
  try { layout = readHeader(header, plan.profile); } catch (error) { await raw.return(undefined); throw error; }
  const { columns, fields } = layout;
  const axes = { date: fields.findIndex(field => field.role === 'date'), minute: fields.findIndex(field => field.role === 'minute'),
    identity: fields.findIndex(field => field.role === 'identity') };
  const axisFields = { date_field: fields[axes.date]!.fieldCode, minute_field: fields[axes.minute]!.fieldCode,
    identity_field: fields[axes.identity]!.fieldCode, timezone: TIMEZONE, key_algorithm: SOURCE_MINUTE_BULK_KEY } as const;
  const fieldCodes = fields.map(field => field.fieldCode);
  let date = plan.partitionDate, target: R1PrepareInput['target'] | undefined, proposal: R1EvidenceProposal | undefined;
  let declaration: WfdRecord, check: SourceMinuteBulkManifest['check'] | undefined;
  let evidenceRange: SourceMinuteBulkManifest['evidenceRange'] | undefined;
  let sourceBytes = header.locator.endByte, rowCount = 0, sourceRows = 0;
  let segment: RawRecord[] = [], segmentBytes = 0;
  const sorter = createBulkSorter(input, { fieldCount: fieldCodes.length, keyIndices: [axes.identity, axes.minute],
    fail, duplicateLabel: '来源身份和分钟' });
  const report = async (stage: SourceMinuteBulkProgress['stage']) => {
    input.signal?.throwIfAborted();
    await input.onProgress?.({ stage, rowCount, sourceBytes });
  };
  const processSegment = async () => {
    if (!segment.length) return;
    input.signal?.throwIfAborted();
    const actual = Buffer.concat([header.bytes, ...segment.map(row => row.bytes)]);
    try {
      if (!proposal) {
        // The fragment is real parsed bytes. Its full-source identity is separately verified below.
        const parsed = parseTableSource(actual, { materialId: plan.materialId, format: 'csv' });
        const review = resolveSourceReportedEvidence({ namespace: plan.namespace, datasetId: plan.datasetId,
          parentSnapshotId: plan.parentSnapshotId, source: plan.source, sourceFieldProfile: plan.profile,
          registeredKeyColumns: [columns[axes.date]!, columns[axes.minute]!, columns[axes.identity]!],
          answers: { source_series: plan.profile.profile.series,
            [/^(?:交易日期|trade_date)$/iu.test(columns[axes.date]!) ? 'source_trade_date_timezone' : 'source_date_timezone']: TIMEZONE } }, parsed, 'csv');
        if (!review.proposal || review.questions.length)
          return fail('EVIDENCE', '来源原报档案仍有待核证据：' + review.questions.map(question => question.key).join(', '));
        proposal = review.proposal;
        evidenceRange = { startByte: 0, endByte: segment.at(-1)!.locator.endByte, sha256: 'sha256:' + parsed.source_sha256 };
        const projection = proposal.sourceProjection!;
        if (projection.dateEncoding !== 'yyyymmdd' || projection.dateColumn !== columns[axes.date]
          || projection.minute?.column !== columns[axes.minute] || projection.keyColumns.length !== 3
          || projection.keyColumns[2] !== columns[axes.identity]
          || canonicalWfdJson(proposal.mapping.fields.map(field => field.fieldCode)) !== canonicalWfdJson(fieldCodes))
          fail('PARTITION', '来源日期、分钟、身份轴或字段顺序不符合冻结档案。');
        target = wireProposal(plan, proposal, axisFields);
        declaration = { protocol: 'wfd.structured-ingest/1.0', mapping: proposal.mapping, source: plan.source, target };
      }
      // Same fixed candidate stages as prepareCandidateTable; the bulk manifest hashes the complete result,
      // so there is no need to serialize and hash each rich intermediate artifact.
      const parsed = parseTableSource(actual, { materialId: plan.materialId, format: 'csv', types: proposal.types,
        sourceProjection: proposal.sourceProjection, emptyToNull: columns });
      const prepared = checkCandidateTables([annotateCandidateTable(structureCandidateTable(cleanCandidateTable(parsed)))]);
      if (prepared.rows.length !== segment.length) fail('COVERAGE', '加工分片与实际 CSV 记录数不一致。');
      for (const [index, row] of prepared.rows.entries()) {
        const loc = segment[index]!.locator;
        const dateText = row[columns[axes.date]!], minuteText = row[columns[axes.minute]!], identity = row[columns[axes.identity]!];
        const normalizedDate = sourceReportedDate(dateText, 'yyyymmdd'), normalizedMinute = sourceReportedMinute(minuteText);
        if (typeof dateText !== 'string' || !normalizedDate || typeof minuteText !== 'string' || !normalizedMinute
          || minuteText !== normalizedMinute.replace('T', ' ') || normalizedMinute.slice(0, 10) !== normalizedDate
          || (date !== undefined && dateText !== date))
          return fail('PARTITION', `${coordinates(loc)}的原报日期或分钟与单日期分区不一致。`);
        if (typeof identity !== 'string' || !identity.replace(/[\s\u001c-\u001f\u0085]/gu, ''))
          return fail('IDENTITY', `${coordinates(loc)}缺少非空原报身份。`);
        date ??= dateText;
        row[proposal.mapping.businessKey] = sourceMinuteBulkKey(date, identity, minuteText);
      }
      const result = checkR1TabularRows(prepared.rows, declaration);
      const { rows, applicable: _applicable, ...compiled } = result;
      check = { ...compiled, standardMarketCalculation: false };
      if (result.quality !== 'pass') fail('QUALIFICATION', '批量原报结构核验未通过：' + result.gaps.join('；'));
      for (const [index, row] of rows.entries()) {
        const values = row.values as WfdRecord;
        const cells = fieldCodes.map(code => {
          const value = (values[code] as WfdRecord).value;
          if (value !== null && typeof value !== 'string') return fail('LEXEME', '批量来源单元格必须是原报文字或未知空值。');
          return value;
        });
        const pending = sorter.add(cells, segment[index]!.locator);
        if (pending) await pending;
      }
      rowCount += rows.length; sourceBytes = segment.at(-1)!.locator.endByte;
    } catch (error) {
      if (error instanceof TaskError && error.code.startsWith('SOURCE_MINUTE_BULK_')) throw error;
      throw new TaskError('SOURCE_MINUTE_BULK_FRAGMENT', `${coordinates(segment[0]!.locator)}起的分片加工失败：${error instanceof Error ? error.message : String(error)}`);
    }
    segment = []; segmentBytes = 0;
    // Progress is bounded; it is not a new durable checkpoint per piece.
    if (rowCount % 10_000 < SOURCE_MINUTE_BULK_LIMITS.segmentRows) await report('parse');
  };
  try {
    for await (const item of raw) {
      if (++sourceRows > SOURCE_MINUTE_BULK_LIMITS.rows) fail('ROW_BUDGET', 'CSV 超过单件数据行上限，未截断。');
      if (segment.length >= SOURCE_MINUTE_BULK_LIMITS.segmentRows
        || segmentBytes + item.bytes.length > SOURCE_MINUTE_BULK_LIMITS.segmentBytes) await processSegment();
      segment.push(item); segmentBytes += item.bytes.length;
    }
  } finally { await raw.return(undefined); }
  if ('sha256:' + sourceHash.digest('hex') !== plan.sourceSha256) fail('SOURCE_CHANGED', '完整受管原件与冻结 SHA-256 不符。');
  await processSegment();
  if (!date || !target || !check || !evidenceRange || !rowCount || rowCount !== sourceRows || sourceBytes !== plan.sourceBytes)
    fail('COVERAGE', '整件加工未覆盖全部冻结原件和实际记录。');
  const sorted = await sorter.finish(rowCount, report);
  const manifest: Omit<SourceMinuteBulkManifest, 'manifestDigest'> = { version: SOURCE_MINUTE_BULK_VERSION, planDigest: plan.digest, sourceSha256: plan.sourceSha256,
    sourceBytes: plan.sourceBytes, materialId: plan.materialId, headerRange: header.locator, evidenceRange: evidenceRange!,
    target: target!, fieldCodes, partition: { ...axisFields, date: date! }, rowCount, ...sorted, check: check! };
  await report('check');
  return { ...manifest, manifestDigest: digest(manifest) };
}

export function readSourceMinuteBulkChunk(stagingDir: string, chunk: SourceMinuteBulkChunk): Promise<(string | null)[][]> {
  return readBulkChunk(stagingDir, chunk, 11, fail);
}

export function readSourceMinuteBulkLocators(stagingDir: string, chunk: SourceMinuteBulkChunk, locatorDigest: string): Promise<SourceMinuteBulkLocator[]> {
  return readBulkLocators(stagingDir, chunk, locatorDigest, fail);
}
