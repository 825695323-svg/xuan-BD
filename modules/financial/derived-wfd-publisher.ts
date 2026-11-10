import { TaskError } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument, type R1HandoffService, type R1LocalReferences } from '../collection/r1-structured-handoff.js';
import type { R1Runtime } from '../collection/r1-runtime.js';
import type { R1WorkspaceService } from '../collection/r1-workspace.js';
import type { AlgorithmTaskView, AlgorithmData } from './algorithm-types.js';
import { checkDerivedForWfd } from './derived-wfd-check.js';
import { publishRestrictionTarget, restrictionEvidenceFromUsageStatus } from '../collection/wfd-publish-restriction.js';

/**
 * 固定算法 → 单次独立核对 → R1 data-only 正式入 WFD。
 * 此处不运行数据采集五步，不提供模型可覆盖的行、方法或 WFD 连接。
 * 使用 R1 已有持久请求、远端状态恢复和固定读回；不新造发布账本。
 */
export class DerivedWfdPublisher {
  constructor(private readonly options: {
    viewAlgorithm(taskId: string): AlgorithmTaskView;
    readAlgorithmInput(taskId: string): AlgorithmData;
    runtime(): R1Runtime | undefined;
    workspace(): R1WorkspaceService | undefined;
    handoff: R1HandoffService;
  }) {}

  private requireResult(taskId: string) {
    const task = this.options.viewAlgorithm(taskId);
    if (task.status !== 'succeeded' || task.requiresReview || !task.result || task.result.status !== 'computed'
      || task.result.taskId !== taskId)
      throw new TaskError('DERIVED_RESULT_NOT_READY', '固定算法原任务未完成或结果仍待核对，不能写入 WFD。');
    return task.result;
  }

  /** R1 首次准备、首次发送和重新发送前重新执行，不使用缓存的“审核通过”标签。 */
  verify(refs: R1LocalReferences, documentSha256: string): void {
    const proof = refs.fixedAlgorithm;
    if (!proof) throw new TaskError('DERIVED_PROOF_MISSING', '算法派生缺少固定任务证明。');
    const runtime = this.options.runtime();
    if (!runtime) throw new TaskError('DERIVED_WFD_UNAVAILABLE', 'WFD 正式交接连接尚未装配。');
    const identity = runtime.currentIdentity();
    if (identity.namespace !== proof.namespace || identity.mode !== proof.mode)
      throw new TaskError('DERIVED_WFD_BINDING_CHANGED', '原派生任务的 WFD 连接身份已变化，不允许借新连接重发。');
    const result = this.requireResult(proof.taskId);
    const checked = checkDerivedForWfd(result, {
      namespace: proof.namespace, mode: proof.mode,
      expectedParentSnapshotId: proof.expectedParentSnapshotId,
    }, proof.requestId, this.options.readAlgorithmInput(proof.taskId));
    if (wfdSha256(canonicalWfdJson(result)) !== proof.resultSha256
      || checked.sourceSha256 !== refs.sourceRefs[0]?.sha256
      || checked.sourceSha256 !== refs.evidenceRefs[0]?.content_sha256
      || wfdSha256(canonicalWfdJson(buildStructuredIngestDocument(checked.structured))) !== documentSha256)
      throw new TaskError('DERIVED_PROOF_CHANGED', '固定算法原结果、原行字节或 WFD 结构化文档与冻结证明不一致。');
  }

  async publish(taskId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const runtime = this.options.runtime(), workspace = this.options.workspace();
    if (!runtime || !workspace) throw new TaskError('DERIVED_WFD_UNAVAILABLE', '未装配正式 WFD 固定读取与 R1 提交端口。');
    const identity = runtime.currentIdentity();
    const result = this.requireResult(taskId);
    const requestId = 'bd-derived:' + wfdSha256(canonicalWfdJson({
      taskId, inputDigest: result.inputDigest, source: result.source,
      method: result.methodId, methodVersion: result.methodVersion,
      producer: identity.namespace, connection: identity.connectionId,
    })).slice(0,48);
    let prior: ReturnType<R1HandoffService['attempt']> | null = null;
    try { prior = this.options.handoff.attempt(requestId); }
    catch (error) {
      if (!(error instanceof TaskError) || error.code !== 'R1_ATTEMPT_NOT_FOUND') throw error;
    }

    let refs: R1LocalReferences;
    if (prior) {
      refs = JSON.parse(String(prior.local_refs_json)) as R1LocalReferences;
      this.verify(refs, String(prior.document_sha256));
      if (['sending','pending_unknown','pending_receipt'].includes(String(prior.state))) {
        await this.options.handoff.recoverStatus(requestId, runtime.client, signal);
      } else if (['associated','partially_associated','conflicts_pending','rejected'].includes(String(prior.state))) {
        return this.publication(requestId);
      }
    } else {
      const current = await workspace.snapshotStatus(signal);
      signal?.throwIfAborted();
      const checked = checkDerivedForWfd(result, {
        namespace: identity.namespace, mode: identity.mode,
        expectedParentSnapshotId: current.snapshotId,
      }, requestId, this.options.readAlgorithmInput(taskId));
      // WFD 治理约束仍由当前权威查询；这不是第二条原报清洗/人工审批链。
      const target = publishRestrictionTarget({
        purpose: 'current_publish', expectedSnapshotId: current.snapshotId,
        logicalDomain: 'observations', subject: checked.structured.subject,
        definition: checked.structured.definition, definitionMode: 'create',
      });
      const restrictions = restrictionEvidenceFromUsageStatus(
        (await runtime.client.usageStatus(signal)).result, target, Date.now());
      if ('publishable' in restrictions && restrictions.publishable === false)
        throw new TaskError('DERIVED_WFD_USAGE_SUSPENDED',
          'WFD 使用治理已暂停目标派生产品的发布，拒绝提交并保留原计算任务。');
      const registered = this.options.handoff.registerOriginal({
        bytes: checked.originalBytes, originalName: 'derived-' + taskId + '.json',
        mediaType: 'application/json', source: checked.source,
      });
      refs = { originalIds: [registered.originalId], materialIds: [],
        sourceRefs: [checked.source], processRefs: [],
        evidenceRefs: [{ ref_id: 'algorithm:' + taskId, content_sha256: checked.sourceSha256,
          kind: 'fixed-algorithm-output' }],
        fixedAlgorithm: { taskId, requestId, resultSha256: checked.resultSha256,
          namespace: identity.namespace, mode: identity.mode,
          expectedParentSnapshotId: current.snapshotId },
      };
      this.options.handoff.prepare({ structured: checked.structured, localRefs: refs });
    }

    // R1 恢复后可能已经结算；未知外部状态不允许换号重发。
    prior = this.options.handoff.attempt(requestId);
    if (['sending','pending_unknown','pending_receipt'].includes(String(prior.state))
      || ['associated','partially_associated','conflicts_pending','rejected'].includes(String(prior.state)))
      return this.publication(requestId);
    this.verify(refs, String(prior.document_sha256));
    signal?.throwIfAborted();
    await this.options.handoff.submitAndAssociate(requestId, runtime.client, signal);
    return this.publication(requestId);
  }

  private publication(requestId: string) {
    const attempt = this.options.handoff.attempt(requestId);
    const state = String(attempt.state);
    const published = state === 'associated' && Number(attempt.pending_count) === 0;
    return {
      requestId, state, published,
      requiresRecovery: ['sending','pending_unknown','pending_receipt'].includes(state),
      fixedReadback: published,
      error: attempt.error_json ? JSON.parse(String(attempt.error_json)) as unknown : null,
    };
  }
}
