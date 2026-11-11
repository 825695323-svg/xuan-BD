import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import {
  assertFinancialLinearCandidate, readFinancialCalculation,
  type FinancialCalculation, type FinancialReader,
} from '../collection/data-processing/financial-fixed.js';
import {
  assertMacroYoYCandidate, readMacroYoYCalculation, type MacroYoYCalculation,
} from '../collection/data-processing/polars-fixed.js';
import { selectWfdFixedRecords, type WfdFixedRecordSelection } from './wfd-fixed-selection.js';

export const UNIFIED_POLARS_PUBLICATION_PROOF = 'bd.unified-polars-publication-proof/1';
export type StructuredCalculationToVerify =
  | { methodId: 'financial_linear'; calculation: FinancialCalculation; evidence: WfdRecord; rows: WfdRecord[];
    verifyFinancialReview(review: NonNullable<FinancialCalculation['compatibilityReview']>): void }
  | { methodId: 'macro_yoy'; calculation: MacroYoYCalculation; evidence: WfdRecord; rows: WfdRecord[] };

export interface UnifiedPolarsPublicationProof {
  version: typeof UNIFIED_POLARS_PUBLICATION_PROOF;
  methodId: 'financial_linear' | 'macro_yoy';
  calculationSha256: string;
  candidateRowsSha256: string;
  originalEvidenceSha256: string;
  fixedSourceRowsSha256: string[];
  recordVersionDigest: string;
  connectionDigest: string;
  historyQualification: 'not_asserted';
}

const fail = (message: string): never => { throw new TaskError('UNIFIED_POLARS_PUBLICATION_PROOF', message); };
const digest = (data: unknown) => wfdSha256(canonicalWfdJson(data));

/**
 * 复用财务/宏观独立数值核验，正式发布前从原受信 WFD 固定快照重新读取所有
 * 具体记录版本；不能把旧计算回执的 selectedSha256 自报为“再次读回”。
 *
 * 本函数只核冻结来源和数值，不注册新数据库/发布者；真正的治理暂停与
 * R1 提交/未知状态恢复仍由原 DerivedWfdPublisher + R1 独立办理。
 */
export async function verifyUnifiedPolarsForPublication(
  input: StructuredCalculationToVerify, reader: FinancialReader, signal: AbortSignal,
): Promise<UnifiedPolarsPublicationProof> {
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 5000
    || !isWfdRecord(input.evidence) || !Array.isArray(input.evidence.inputs)
    || input.evidence.historicalQualification !== 'not_asserted') fail('结构化候选缺完整的冻结来源或未知结果，不可准备正式发布。');

  let refs: WfdFixedRecordSelection[] = [];
  const original = input.evidence.inputs as WfdRecord[];
  if (input.methodId === 'financial_linear') {
    const calc = readFinancialCalculation(input.calculation);
    if (!['quarter_difference', 'ttm'].includes(calc.operation)) fail('固定财务只支持已验收的单季与近十二个月派生。');
    assertFinancialLinearCandidate(calc, input.evidence, input.rows, input.verifyFinancialReview);
    const proof = input.evidence.linearAdmission;
    if (!isWfdRecord(proof) || !Array.isArray(proof.rows) || proof.rows.length !== calc.inputs.length
      || original.length !== calc.inputs.length) fail('冻结财务核验没有完整、逐项的原始来源版本。');
    const frozenRows = proof.rows as WfdRecord[];
    refs = calc.inputs.map((selection, index) => {
      const item = frozenRows[index];
      if (!isWfdRecord(item) || !isWfdRecord(item.record_ref) || selection.businessKeys.length !== 1
        || typeof item.record_ref.revision_id !== 'string') return fail('每项财务候选缺唯一来源版本。');
      return { ...selection, recordVersions: { [selection.businessKeys[0]!]: item.record_ref.revision_id } };
    });
  } else {
    const calc = readMacroYoYCalculation(input.calculation);
    assertMacroYoYCandidate(calc, input.evidence, input.rows);
    if (original.length !== calc.inputs.length) fail('宏观同比没有完整的本期和上年同期来源。');
    refs = calc.inputs.map(selection => ({ snapshotId: selection.snapshotId, productId: selection.productId,
      businessKeys: [selection.businessKey], recordVersions: { [selection.businessKey]: selection.recordVersion } }));
  }
  const actual = await selectWfdFixedRecords(refs, reader, signal, reason => fail(reason));
  if (digest(actual.connection) !== digest(input.evidence.connection ?? null)) {
    fail('重新读取 WFD 的受信连接身份与原计算时不同。');
  }
  for (const [index, value] of actual.selections.entries()) {
    const expected = original[index]!;
    if (input.methodId === 'financial_linear') {
      if (value.selectedRowsSha256 !== expected.selectedRowsSha256
        || digest(value.recordVersions) !== digest(expected.recordVersions)) {
        fail('财务固定来源的原行字节或记录版本与原冻结计算证据不同。');
      }
      const proof = input.evidence.linearAdmission as WfdRecord;
      const frozenRow = (proof.rows as WfdRecord[])[index];
      if (value.rows.length !== 1 || !frozenRow || digest(value.rows[0]) !== digest(frozenRow)) {
        fail('财务发布前重新读取的原行与独立核验时原记录不一致。');
      }
    } else {
      if (value.rows.length !== 1 || typeof expected.selectedSha256 !== 'string'
        || digest(value.rows[0]) !== expected.selectedSha256
        || digest(value.recordVersions[0]) !== digest(expected.record)) {
        fail('宏观同比的真实 WFD 原行摘要或来源记录版本已变化。');
      }
      const rawValues = (value.rows[0] as WfdRecord).values;
      if (!isWfdRecord(rawValues) || !isWfdRecord(expected.values)) fail('宏观实际 WFD 来源缺失字段。');
      const rowValues = rawValues as WfdRecord, frozenValues = expected.values as WfdRecord;
      for (const [field, value] of Object.entries(frozenValues)) {
        const cell = rowValues[field];
        if (!isWfdRecord(cell) || cell.value !== value) fail('宏观真实 WFD 原字段与原计算冻结值不一致。');
      }
    }
  }
  return {
    version: UNIFIED_POLARS_PUBLICATION_PROOF, methodId: input.methodId,
    calculationSha256: digest(input.calculation), candidateRowsSha256: digest(input.rows),
    originalEvidenceSha256: digest(input.evidence),
    fixedSourceRowsSha256: actual.selections.map(item => item.selectedRowsSha256),
    recordVersionDigest: digest(actual.selections.map(item => item.recordVersions)),
    connectionDigest: digest(actual.connection), historyQualification: 'not_asserted',
  };
}
