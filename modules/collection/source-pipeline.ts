import { createHash } from 'node:crypto';
import type { JsonValue } from '../../contracts/task-contracts.js';

export type SourceSampleKind = 'minute_bars' | 'announcement' | 'index_change';
export interface SourcePipelineInput {
  kind: SourceSampleKind;
  sourceId: string;
  sourceUrl: string;
  observedAt: string;
  rawSha256: string;
  records: Record<string, JsonValue>[];
  attachments?: { url: string; mediaType: string; sha256: string; text?: string }[];
  /** 仅在调用方有明确时间窗口时核连续性；不从相邻行情猜测交易日历。 */
  expectedTimestamps?: string[];
}
export interface SourcePipelineIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  row?: number;
}
export interface SourcePipelineStep {
  name: 'parse' | 'clean' | 'annotate' | 'check' | 'structure';
  version: string;
  inputSha256: string;
  outputSha256: string;
}
export interface SourcePipelineResult {
  version: 'source-pipeline/1';
  kind: SourceSampleKind;
  status: 'ready' | 'partial' | 'invalid';
  records: Record<string, JsonValue>[];
  provenance: { sourceId: string; sourceUrl: string; observedAt: string; rawSha256: string; attachments: NonNullable<SourcePipelineInput['attachments']> };
  coverage: { received: number; retained: number; duplicatesRemoved: number; missingTimestamps: string[] | null };
  steps: SourcePipelineStep[];
  issues: SourcePipelineIssue[];
  database: { state: 'awaiting_contract'; reason: string; commitId: null; snapshotId: null };
}

/** 来源适配负责取数和字段映射；本模块只加工原记录，不联网、不改来源配置、不提交数据库。 */
export function processSourcePipeline(input: SourcePipelineInput): SourcePipelineResult {
  if (!['minute_bars', 'announcement', 'index_change'].includes(input.kind)
    || !input.sourceId || !/^https?:\/\//u.test(input.sourceUrl)
    || !zonedTime(input.observedAt) || !/^[a-f0-9]{64}$/u.test(input.rawSha256)
    || !Array.isArray(input.records) || input.records.length > 10_000
    || input.records.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('来源处理需要明确类型、原件身份、观察时间和有界记录。');
  }
  const issues: SourcePipelineIssue[] = [];
  const steps: SourcePipelineStep[] = [];
  const step = (name: SourcePipelineStep['name'], before: unknown, after: unknown) => {
    steps.push({ name, version: `source-${input.kind}-${name}/1`, inputSha256: digest(before), outputSha256: digest(after) });
  };
  const parsed = structuredClone(input.records);
  step('parse', { rawSha256: input.rawSha256, records: input.records }, parsed);
  const records: Record<string, JsonValue>[] = [], seen = new Set<string>(), identities = new Map<string, string>();
  const originalRows: number[] = [];
  for (const [ordinal, record] of parsed.entries()) {
    const value = digest(record);
    if (seen.has(value)) continue;
    seen.add(value);
    const key = recordIdentity(input.kind, record);
    if (key && identities.has(key) && identities.get(key) !== value) {
      issues.push({ code: 'CONFLICTING_RECORD', severity: 'error', row: ordinal + 1, message: '同一对象和版本返回冲突记录；保留两份原值，等待明确修订关系。' });
    }
    if (key) identities.set(key, value);
    records.push(record); originalRows.push(ordinal + 1);
  }
  step('clean', parsed, records);
  const provenance = {
    sourceId: input.sourceId, sourceUrl: input.sourceUrl, observedAt: input.observedAt, rawSha256: input.rawSha256,
    attachments: structuredClone(input.attachments ?? []),
  };
  for (const attachment of provenance.attachments) {
    if (!/^https?:\/\//u.test(attachment.url) || !/^[a-f0-9]{64}$/u.test(attachment.sha256) || !attachment.mediaType) {
      issues.push({ code: 'INVALID_ATTACHMENT_REFERENCE', severity: 'error', message: '附件缺少实际来源、类型或原字节摘要。' });
    }
  }
  const annotated = { records, originalRows, provenance };
  step('annotate', records, annotated);
  for (const [index, record] of records.entries()) {
    validateRecord(input.kind, record, originalRows[index]!, issues, provenance.attachments);
  }
  let missingTimestamps: string[] | null = null;
  if (input.kind === 'minute_bars' && input.expectedTimestamps !== undefined) {
    if (!Array.isArray(input.expectedTimestamps) || input.expectedTimestamps.some(value => !zonedTime(value))) {
      issues.push({ code: 'INVALID_EXPECTED_WINDOW', severity: 'error', message: '预期分钟窗口必须给出带时区的时间戳。' });
    } else {
      const received = new Set(records.map(record => String(record.timestamp)));
      missingTimestamps = [...new Set(input.expectedTimestamps)].filter(value => !received.has(value));
      if (missingTimestamps.length) issues.push({ code: 'MISSING_MINUTES', severity: 'warning', message: `明确窗口缺少 ${missingTimestamps.length} 个分钟记录，未插值或补造。` });
    }
  }
  if (!records.length) issues.push({ code: 'EMPTY_SAMPLE', severity: 'warning', message: '本次返回空记录；不作为故障，但未完成非空样本验收。' });
  const coverage = { received: parsed.length, retained: records.length, duplicatesRemoved: parsed.length - records.length, missingTimestamps };
  const checked = { ...annotated, coverage, issues };
  step('check', annotated, checked);
  const status = issues.some(issue => issue.severity === 'error') ? 'invalid'
    : issues.some(issue => issue.severity === 'warning') ? 'partial' : 'ready';
  const candidate = {
    version: 'source-pipeline/1' as const, kind: input.kind, status: status as SourcePipelineResult['status'],
    records, provenance, coverage, issues,
    database: { state: 'awaiting_contract' as const,
      reason: '本类型尚无适用的数据库接收目标与契约；已保管的候选和证据可用于后续交接，未宣称正式提交。',
      commitId: null, snapshotId: null },
  };
  step('structure', checked, candidate);
  return { ...candidate, steps };
}

function validateRecord(kind: SourceSampleKind, record: Record<string, JsonValue>, row: number,
  issues: SourcePipelineIssue[], attachments: NonNullable<SourcePipelineInput['attachments']>): void {
  const issue = (code: string, message: string, severity: SourcePipelineIssue['severity'] = 'error') =>
    issues.push({ code, message, severity, row });
  const text = (key: string) => typeof record[key] === 'string' && !!String(record[key]).trim();
  const required = (keys: string[]) => {
    for (const key of keys) if (!text(key)) issue('MISSING_FIELD', `缺少 ${key}，未猜测补齐。`);
  };
  if (kind === 'minute_bars') {
    required(['symbol', 'timestamp', 'unit', 'currency', 'timezone', 'volumeUnit']);
    if (!zonedTime(record.timestamp)) issue('INVALID_MINUTE_TIME', '分钟时间戳需要有效时区，观察时间不能代替行情时间。');
    for (const field of ['open', 'high', 'low', 'close', 'volume']) {
      if (typeof record[field] !== 'number' || !Number.isFinite(record[field]) || record[field] < 0) {
        issue('INVALID_NUMBER', `${field} 必须是有限非负数；不把空值转成零。`);
      }
    }
    const { open, high, low, close } = record;
    if ([open, high, low, close].every(value => typeof value === 'number' && Number.isFinite(value))
      && (Number(high) < Math.max(Number(open), Number(close), Number(low))
        || Number(low) > Math.min(Number(open), Number(close), Number(high)))) issue('INVALID_OHLC', '最高/最低价与开收盘价不一致。');
    return;
  }
  if (kind === 'announcement') {
    required(['id', 'title', 'publishedAt', 'url']);
    if (!dateOrTime(record.publishedAt)) issue('INVALID_PUBLICATION_TIME', '公告发布时间缺失或无效，不能用抓取时间代替。');
    if (!/^https?:\/\//u.test(String(record.url ?? ''))) issue('INVALID_ANNOUNCEMENT_URL', '公告缺少有效来源网址。');
    if (!text('bodyText')) issue('MISSING_ANNOUNCEMENT_BODY', '未取得公告正文，标题和链接不代表全文完成。', 'warning');
    if (record.attachmentUrl && !attachments.some(value => value.url === record.attachmentUrl)) {
      issue('MISSING_ATTACHMENT', '公告声明的附件尚未保管，不能把元信息当作附件已完成。', 'warning');
    }
    return;
  }
  required(['indexCode', 'noticeId', 'announcedAt', 'effectiveAt']);
  if (!dateOrTime(record.announcedAt) || !dateOrTime(record.effectiveAt)) issue('INVALID_INDEX_TIME', '指数变更须分别保留公告日期与生效日期。');
  for (const key of ['added', 'removed']) {
    if (!Array.isArray(record[key]) || record[key].some(code => typeof code !== 'string' || !code.trim())
      || new Set(record[key] as JsonValue[]).size !== record[key].length) issue('INVALID_CHANGE_LIST', `${key} 必须为明确且不重复的证券代码列表。`);
  }
  if (Array.isArray(record.added) && Array.isArray(record.removed)) {
    if (!record.added.length && !record.removed.length) issue('EMPTY_INDEX_CHANGE', '未取得调入或调出名单，当前成分表不能代替变更事件。');
    if (record.added.some(code => (record.removed as JsonValue[]).includes(code))) issue('OVERLAPPING_INDEX_CHANGE', '同一次变更的调入和调出名单存在相同证券。');
  }
  if (record.supersedes !== undefined && !text('supersedes')) issue('INVALID_REVISION', '更正关系必须引用明确的原公告身份。');
}
function recordIdentity(kind: SourceSampleKind, record: Record<string, JsonValue>): string | null {
  const fields = kind === 'minute_bars' ? ['symbol', 'timestamp'] : kind === 'announcement' ? ['id'] : ['indexCode', 'noticeId'];
  return fields.every(field => record[field] !== undefined) ? JSON.stringify(fields.map(field => record[field])) : null;
}
function zonedTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && calendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
function dateOrTime(value: unknown): value is string {
  return typeof value === 'string' && (calendarDate(value) || zonedTime(value));
}
function calendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
