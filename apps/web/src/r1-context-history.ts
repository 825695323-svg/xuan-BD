import { isExplicitUtcInstant } from '../../../contracts/financial-value';
import type { R1ContextReadInput } from '../../../contracts/r1-contracts';
import { assertR1ReadHistoryEcho, R1HistoryError, validateR1ReadHistoryInput } from './r1-read-history';

type History = Pick<R1ContextReadInput, 'historyMode' | 'at' | 'businessTimeRange'>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const equalObject = (left: unknown, right: unknown): boolean => object(left) && object(right)
  && Object.keys(left).length === Object.keys(right).length
  && Object.keys(right).every(key => Object.hasOwn(left, key) && left[key] === right[key]);
function fail(): never {
  throw new R1HistoryError('R1_CONTEXT_HISTORY_INPUT', '关系历史须分别明确公开截止与有效期起止，终点包含该秒；不推断其它历史视角。',
    'Relation history requires separate public cutoff and validity bounds; the ending second is inclusive. Other historical perspectives are not inferred.');
}

/** UI UTC instants are converted to the existing WFD local-time + timezone contract.
 * WFD includes the ending second. This does not introduce half-open range semantics. */
export function buildR1ContextHistory(selection: { historyMode?: R1ContextReadInput['historyMode']; at?: string; start?: string; end?: string }): History {
  const historyMode = selection.historyMode ?? 'snapshot_contents';
  validateR1ReadHistoryInput({ historyMode, ...(selection.at !== undefined ? { at: selection.at } : {}) });
  if (historyMode === 'snapshot_contents') {
    if (selection.start !== undefined || selection.end !== undefined) fail();
    return { historyMode };
  }
  if (historyMode !== 'market_known_at' || !isExplicitUtcInstant(selection.start) || selection.start.length !== 20
    || !isExplicitUtcInstant(selection.end) || selection.end.length !== 20 || selection.start > selection.end
    || Date.parse(selection.end) + 1000 > Date.parse('9999-12-31T23:59:59Z')) fail();
  return { historyMode, at: selection.at, businessTimeRange: { role: 'validity', start: selection.start.slice(0, -1),
    end: selection.end.slice(0, -1), timezone: 'UTC' } };
}

export function validateR1ContextHistoryInput(input: R1ContextReadInput): void {
  validateR1ReadHistoryInput(input);
  const mode = input.historyMode ?? 'snapshot_contents';
  if (mode !== 'snapshot_contents' && (mode !== 'market_known_at' || input.operation !== 'read_relation_graph')) fail();
  if (mode === 'market_known_at') {
    const range = input.businessTimeRange;
    if (!object(range) || Object.keys(range).sort().join(',') !== 'end,role,start,timezone' || range.role !== 'validity'
      || !['start', 'end', 'timezone'].every(key => typeof range[key] === 'string' && !!range[key])) fail();
  }
}

export function assertR1ContextHistoryEcho(input: R1ContextReadInput, response: unknown): void {
  validateR1ContextHistoryInput(input);
  const result = object(response) && object(response.result) ? response.result : null;
  if (!object(response) || !result || response.operation !== input.operation || result.operation !== input.operation
    || response.snapshotId !== input.snapshotId || result.snapshot_id !== input.snapshotId
    || response.datasetId !== input.datasetId || result.dataset_id !== input.datasetId
    || !equalObject(input.subject, response.subject) || !equalObject(input.subject, result.subject)
    || response.historyMode !== (input.historyMode ?? 'snapshot_contents') || result.history_mode !== (input.historyMode ?? 'snapshot_contents'))
    throw new R1HistoryError('R1_CONTEXT_ECHO_MISMATCH', '上下文固定身份、主体或视角回显不符。', 'The returned fixed context identity, subject or perspective does not match.');
  if (input.operation === 'read_relation_graph') {
    assertR1ReadHistoryEcho(input, response);
    const expected = input.businessTimeRange ?? null;
    if (expected === null ? result.business_time_range !== null : !equalObject(result.business_time_range, expected))
      throw new R1HistoryError('R1_CONTEXT_ECHO_MISMATCH', '关系有效期回显与原请求不符。', 'The returned relation validity range does not match the request.');
  }
}
