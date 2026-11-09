import { canonicalWfdJson, wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import { TaskError } from '../../../platform/jobs/tasks.js';

export const NECESSARY_TEXT_VERSION = 'bd-necessary-business-paragraph/1';
export interface NecessaryTextSelection {
  version: typeof NECESSARY_TEXT_VERSION;
  sourceSha256: string;
  documentVersion: string;
  purpose: 'correction_scope' | 'audit_opinion' | 'limiting_condition';
  reviewBasis: string;
  paragraphs: { start: number; end: number; quote: string }[];
}
const fail = (message: string): never => { throw new TaskError('NECESSARY_TEXT_REVIEW', message); };
export function readNecessaryTextSelection(raw: unknown): NecessaryTextSelection {
  const value = raw as NecessaryTextSelection;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'documentVersion,paragraphs,purpose,reviewBasis,sourceSha256,version'
    || value.version !== NECESSARY_TEXT_VERSION || !/^[a-f0-9]{64}$/u.test(value.sourceSha256)
    || typeof value.documentVersion !== 'string' || !value.documentVersion.trim() || value.documentVersion.length > 256
    || !['correction_scope', 'audit_opinion', 'limiting_condition'].includes(value.purpose)
    || typeof value.reviewBasis !== 'string' || value.reviewBasis.trim().length < 8 || value.reviewBasis.length > 4000
    || !Array.isArray(value.paragraphs) || value.paragraphs.length < 1 || value.paragraphs.length > 64
    || value.paragraphs.some(item => !item || Object.keys(item).sort().join(',') !== 'end,quote,start'
      || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < 0 || item.end <= item.start
      || typeof item.quote !== 'string' || !item.quote.trim())) fail('必要文字须有固定原版本、摘要、真实用途、操作者核定依据和完整原文段范围；自报text_role不足准入。');
  return structuredClone(value);
}

/** 只支持已核定的完整原文业务段；标题、摘要或自由的“必要”标签不能替代选择记录。 */
export function projectNecessaryText(bytes: Uint8Array, raw: NecessaryTextSelection) {
  const selection = readNecessaryTextSelection(raw);
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('必要文字选择只接受明确UTF-8原文；PDF须先走保留原件的文字转换。'); }
  if (wfdSha256(bytes) !== selection.sourceSha256) fail('原文字节与核定版本摘要不一致。');
  let previousEnd = -1;
  const records = selection.paragraphs.map(paragraph => {
    if (paragraph.start < previousEnd || source.slice(paragraph.start, paragraph.end) !== paragraph.quote) fail('核定文字范围重叠、乱序或与原文不一致。');
    previousEnd = paragraph.end;
    // 一段允许跨视觉换行；空行才是业务段界，不按短字数或句子截断条件。
    const left = source.slice(0, paragraph.start), right = source.slice(paragraph.end);
    if (left.trim() && !/\n[\t ]*\n[\t ]*$/u.test(left) || right.trim() && !/^[\t ]*\n[\t ]*\n/u.test(right)
      || /\n[\t ]*\n/u.test(paragraph.quote)) fail('选择须覆盖一个完整原文段，不能只摘断句、否定或前提，也不能整篇文章伪装成一段选录。');
    const normalized = paragraph.quote.replace(/\s+/gu, '');
    const matches = selection.purpose === 'correction_scope' ? /(?:更正|追溯调整|会计差错)/u.test(normalized) && /(?:不涉及|仅影响|仅对|调整|影响范围)/u.test(normalized)
      : selection.purpose === 'audit_opinion' ? /(?:审计意见|审计了|公允反映|保留意见|无法表示意见|否定意见)/u.test(normalized)
        : /(?:除非|尚未|不超过|不得|预计|须经|不构成|不保证)/u.test(normalized);
    if (!matches || !/[。！？.!?][”’"']?$/u.test(normalized)) fail('本次受控规则无法核定完整业务条件；保留待核，不能靠自报必要标签发布。');
    const digest = wfdSha256(paragraph.quote);
    return { business_key: 'necessary_' + wfdSha256(canonicalWfdJson({ source: selection.sourceSha256, version: selection.documentVersion,
      purpose: selection.purpose, start: paragraph.start, end: paragraph.end, digest })), text_role: 'necessary_condition',
      text: paragraph.quote, document_version: selection.documentVersion, purpose: selection.purpose };
  });
  const jsonBytes = Buffer.from(canonicalWfdJson(records));
  return { jsonBytes, evidence: { ...selection, publishedContentSha256: wfdSha256(jsonBytes),
    conditionIntegrity: 'exact-complete-source-paragraphs', necessityAuthority: 'operator-reviewed-under-listed-rule',
    independentSemanticVerification: false } };
}
