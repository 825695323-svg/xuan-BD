import type { R1RequestView } from '../../../../contracts/r1-contracts';
import { useWords } from './Controls';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function businessFirst(value: unknown): Record<string, unknown> {
  const row = object(value), { values, value_decimal, value_state, ...context } = row;
  if (values !== undefined) return { values, ...context };
  if (Object.hasOwn(row, 'value_decimal')) return { value_decimal, value_state, ...context };
  return row;
}
function recordsWithValuesFirst(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(value => {
    const { row, ...reference } = object(value);
    return { row: businessFirst(row), ...reference };
  }) : [];
}

/** One receipt view shared by manual, automatic, batch and CSV page handoffs. */
export function R1DuplicateResult({ request, rowStart = 1 }: { request: R1RequestView; rowStart?: number }) {
  const words = useWords(), summary = request.rowSummary;
  if (!summary) return null;
  const receipt = object(request.local.receipt), conflicts = Array.isArray(receipt.conflicts) ? receipt.conflicts.map(object) : [];
  return <div className="r1-proof" aria-label={words('重复录入处理结果', 'Duplicate intake result')}>
    <p role="status">{words(`新增 ${summary.inserted} 行；相同跳过 ${summary.duplicate_skipped} 行；冲突待确认 ${summary.conflict_pending} 行。`,
      `Inserted ${summary.inserted}; identical rows skipped ${summary.duplicate_skipped}; conflicts awaiting confirmation ${summary.conflict_pending}.`)}</p>
    {summary.conflict_pending > 0 && <p className="danger-text">{summary.inserted > 0 && words('无冲突的新记录已先追加。', 'New non-conflicting records were appended. ')}{words('以下冲突保留待确认，整批尚未全部完成。请先核对新旧值和原记录，再明确选择修订方案。此处没有确认后自动覆盖的动作。',
      'Conflicts remain for review and the intake is incomplete. Review both values and original records before choosing a revision. Confirmation here never overwrites a record automatically.')}</p>}
    {conflicts.map(conflict => <details key={String(conflict.row_index)}><summary>{words('待确认原行', 'Original row awaiting confirmation')} {Number(conflict.row_index) + rowStart} · {String(conflict.business_key)}</summary>
      <p className="r1-help">{words('差异字段', 'Different fields')}: {Array.isArray(conflict.difference_fields) ? conflict.difference_fields.map(String).join('、') : '—'}</p>
      <p className="r1-help">{words('冲突原因', 'Conflict reason')}: {String(conflict.reason)}</p>
      {Number(conflict.incoming_conflict_rows_total) > 0 && <p className="r1-help">{words(`同一请求另有 ${Number(conflict.incoming_conflict_rows_total)} 条同键冲突；以下最多显示 4 个不同内容示例，完整原行保留在固定文档。`,
        `There are ${Number(conflict.incoming_conflict_rows_total)} other conflicting rows for this key. Up to four distinct examples follow; every original row remains in the frozen document.`)}</p>}
      <div className="r1-grid"><div><p>{words('本次新值', 'Incoming value')}</p><pre className="database-text-preview">{JSON.stringify(businessFirst(conflict.incoming_row), null, 2)}</pre></div>
        <div><p>{words('固定读回的原值与记录引用', 'Original values and fixed record references')}</p><pre className="database-text-preview">{JSON.stringify({ existing_rows: recordsWithValuesFirst(conflict.existing_rows), same_request_conflicting_rows: recordsWithValuesFirst(conflict.incoming_conflict_rows) }, null, 2)}</pre></div></div>
    </details>)}
    {summary.inserted === 0 && summary.conflict_pending === 0 && <p className="r1-help">{words('本次全部为相同内容；沿用已存在的固定记录，没有新建快照。本次原件和来源关联仍保留。',
      'Every incoming row is identical. Existing fixed records were reused without creating a snapshot. This original and its source links are preserved.')}</p>}
  </div>;
}
