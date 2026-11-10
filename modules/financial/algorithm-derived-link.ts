import type { CoreDatabase } from '../../platform/state/database.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';

interface DerivedRow { service_task_id: string; material_id: string; material_sha256: string;
  result_sha256: string; origin_json: string }

/** 验证会话派生材料直接来自已完成 WFD 算法任务，不把任意文件冒充新金融数据。 */
export function verifyDerivedMaterialLink(
  database: CoreDatabase, companion: WorkspaceServices, origin: ModelTaskOrigin, materialId: string,
  ancestorMessages?: ReadonlySet<string>,
): boolean {
  const hasTable = database.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_algorithm_derived'").get();
  if (!hasTable) return false;
  const row = database.connection.prepare('SELECT * FROM conversation_algorithm_derived WHERE material_id=?').get(materialId) as DerivedRow | undefined;
  if (!row) return false;
  let saved: ModelTaskOrigin;
  try { saved = JSON.parse(row.origin_json) as ModelTaskOrigin; }
  catch { throw new TaskError('ALGORITHM_DERIVED_ORIGIN', '派生材料原会话记录无法核实。'); }
  if (saved.conversationId !== origin.conversationId || saved.branchId !== origin.branchId
    || ancestorMessages && !ancestorMessages.has(saved.messageId))
    throw new TaskError('ALGORITHM_DERIVED_ORIGIN', '派生材料不属于当前会话分支或当前消息的来源祖先。');
  const result = companion.algorithms?.view(row.service_task_id);
  if (result?.status !== 'succeeded' || result.requiresReview || result.result?.status !== 'computed')
    throw new TaskError('ALGORITHM_DERIVED_RESULT', '原算法任务尚未成功或结果仍需核对。');
  const computed = result.result;
  if (!computed.source || typeof computed.source !== 'object' || !('kind' in computed.source)
    || computed.source.kind !== 'wfd_fixed_snapshot')
    throw new TaskError('ALGORITHM_DERIVED_SOURCE', '派生结果未绑定 WFD 固定快照输入。');
  const actual = wfdSha256(canonicalWfdJson(computed.rows));
  const digest = wfdSha256(canonicalWfdJson(computed));
  const material = companion.materials?.get(materialId);
  if (!material || row.material_sha256 !== actual || material.envelope.sha256 !== actual
    || row.result_sha256 !== digest)
    throw new TaskError('ALGORITHM_DERIVED_CHANGED', '派生材料和原计算结果行、来源或身份摘要不一致。');
  return true;
}
