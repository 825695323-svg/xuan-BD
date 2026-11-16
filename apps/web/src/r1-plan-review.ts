import type { R1PrepareInput, R1RequestView, R1SnapshotStatus } from '../../../contracts/r1-contracts.js';

/** Read-only projection for the existing single-output R1 transport, never a publication authority. */
export interface R1OutputReview {
  planId: string; outputId: string; materialIds: string[]; state: string;
  datasetId: string | null; outputKey: string | null; expectedSnapshotId: string | null;
  relatedOutputIds: string[]; reasons: string[]; gaps: string[]; eligible: boolean;
  stamp: string; recipe: Omit<R1PrepareInput, 'requestId'> | null;
}
export interface R1PlanReview {
  planId: string; planDigest: string; outputs: R1OutputReview[];
  submissionMode: 'one_independent_output'; collectionSubmission: 'not_supported';
}
export interface R1ReviewPort {
  plan(id: string): Promise<Record<string, unknown>>;
  snapshotStatus(): Promise<R1SnapshotStatus>;
  prepare(input: R1PrepareInput): Promise<R1RequestView>;
  get(id: string): Promise<R1RequestView>;
  submit(view: R1RequestView): Promise<unknown>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value);
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
/** Comparison key only. The backend alone checks actual objects, roles, digest and publication. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}
const groupKeys = ['consistencyGroups', 'consistency_groups', 'publicationSets', 'publication_sets', 'publicationSet', 'publicationGroup', 'dependencies'];
function hasGroup(value: unknown): boolean {
  return object(value) && groupKeys.some(key => Object.hasOwn(value, key) && value[key] !== null
    && !(Array.isArray(value[key]) && value[key].length === 0)
    && !(object(value[key]) && Object.keys(value[key]).length === 0));
}

/** One authoritative plan read; unknown graph/integrity fields fail closed rather than becoming an empty list. */
export function reviewR1Plan(value: unknown): R1PlanReview {
  if (!object(value) || !id(value.planId) || !digest(value.planDigest)
    || !Array.isArray(value.outputs) || !value.outputs.length || value.outputs.length > 16
    || !value.outputs.every(output => object(output) && id(output.outputId))
    || !Array.isArray(value.steps) || value.steps.length > 256
    || !value.steps.every(step => object(step) && id(step.stepId) && id(step.outputId) && strings(step.dependsOn))
    || !Array.isArray(value.integrity) || !value.integrity.every(item => object(item) && id(item.stepId) && typeof item.present === 'boolean')
    || !strings(value.missingSteps) || !strings(value.missingOutputs))
    fail('R1_REVIEW_SHAPE', '处理计划身份、依赖或完整性无法核对；没有把未知状态当成可发布。');
  const planId = value.planId, planDigest = value.planDigest;
  const outputs = value.outputs as Record<string, unknown>[], steps = value.steps as Record<string, unknown>[];
  const outputIds = outputs.map(output => String(output.outputId));
  const stepById = new Map(steps.map(step => [String(step.stepId), step]));
  if (new Set(outputIds).size !== outputIds.length || stepById.size !== steps.length
    || steps.some(step => !outputIds.includes(String(step.outputId)) || (step.dependsOn as string[]).some(dep => !stepById.has(dep))))
    fail('R1_REVIEW_DEPENDENCY', '输出或步骤重复、缺失或引用未声明依赖，不能拆开确认。');
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(stepId: string): void {
    if (visiting.has(stepId)) fail('R1_REVIEW_DEPENDENCY', '步骤依赖存在循环，不能确认发布。');
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    for (const dep of stepById.get(stepId)!.dependsOn as string[]) visit(dep);
    visiting.delete(stepId); visited.add(stepId);
  }
  steps.forEach(step => visit(String(step.stepId)));
  const links = new Map(outputIds.map(outputId => [outputId, new Set<string>()]));
  for (const step of steps) for (const dependency of step.dependsOn as string[]) {
    const other = String(stepById.get(dependency)!.outputId), own = String(step.outputId);
    if (other !== own) { links.get(own)!.add(other); links.get(other)!.add(own); }
  }
  function related(outputId: string): string[] {
    const found = new Set<string>(), pending = [...links.get(outputId)!];
    while (pending.length) {
      const next = pending.pop()!;
      if (next === outputId || found.has(next)) continue;
      found.add(next); pending.push(...links.get(next)!);
    }
    return [...found].sort();
  }
  return { planId, planDigest, submissionMode: 'one_independent_output', collectionSubmission: 'not_supported',
    outputs: outputs.map(output => {
      const outputId = String(output.outputId), reasons: string[] = [], own = steps.filter(step => step.outputId === outputId);
      const relatedOutputIds = related(outputId);
      const target = object(output.target) ? output.target : {};
      const declaration = object(target.declaration) ? target.declaration : {};
      const destination = object(declaration.target) ? declaration.target : {};
      const mapping = object(declaration.mapping) ? declaration.mapping : {};
      const source = object(declaration.source) ? declaration.source : {};
      const materialIds = strings(output.materialIds) ? output.materialIds : [];
      if (output.state !== 'structured' || output.publishEligible !== true || output.intendedAction !== 'publish'
        || output.routingState !== 'ready_candidate') reasons.push('R1_OUTPUT_NOT_READY');
      if (materialIds.length !== 1) reasons.push('R1_MULTI_SOURCE_UNSUPPORTED');
      if (relatedOutputIds.length || hasGroup(value) || hasGroup(output) || hasGroup(target)
        || hasGroup(declaration) || hasGroup(destination)) reasons.push('R1_COLLECTION_CONFIRMATION_REQUIRED');
      const ownIntegrity = (value.integrity as Record<string, unknown>[]).filter(item => own.some(step => step.stepId === item.stepId));
      if ((value.missingOutputs as string[]).includes(outputId)
        || (value.missingSteps as string[]).length > 0 || !own.length
        || ownIntegrity.length !== own.length || ownIntegrity.some(item => item.present !== true)
        || own.some(step => step.state !== 'succeeded' || !digest(step.outputDigest)
          || !ownIntegrity.some(item => item.stepId === step.stepId && item.present === true))) reasons.push('R1_OUTPUT_INTEGRITY');
      if (object(output.semantic) && output.semantic.quality !== 'pass') reasons.push('R1_SEMANTIC_UNRESOLVED');
      if (declaration.protocol !== 'wfd.structured-ingest/1.0'
        || Object.keys(declaration).some(key => !['protocol','target','mapping','source'].includes(key))
        || Object.keys(destination).some(key => !['datasetId','outputKey','expectedParentSnapshotId','subject','definition','inputMode','coverage'].includes(key))
        || !id(destination.datasetId) || !id(destination.outputKey)
        || !object(destination.subject) || !object(destination.definition) || !object(destination.coverage)
        || !['partial_observation', 'complete_snapshot'].includes(String(destination.inputMode))
        || !(destination.expectedParentSnapshotId === null || typeof destination.expectedParentSnapshotId === 'string')
        || destination.expectedParentSnapshotId !== target.expectedSnapshotId) reasons.push('R1_TARGET_UNCONFIRMED');
      // Existing scalar plans lack a frozen source declaration; keep their original manual editor.
      if (mapping.kind !== 'tabular_rows') reasons.push('R1_SOURCE_EDITOR_REQUIRED');
      if (!['source_id', 'provider', 'requested_url', 'requested_at_utc', 'acquired_at_utc', 'usage_scope']
        .every(key => typeof source[key] === 'string' && String(source[key]).trim())) reasons.push('R1_SOURCE_UNCONFIRMED');
      const recipe = reasons.length ? null : structuredClone({ planId, outputId, source, mapping, target: destination }) as Omit<R1PrepareInput, 'requestId'>;
      const gaps = [...(strings(output.gaps) ? output.gaps : []), ...(strings(output.semanticGaps) ? output.semanticGaps : [])];
      // Unrelated completion timestamps do not invalidate a selected output's review.
      const stamp = canonical({ planId, planDigest, output, own, ownIntegrity, relatedOutputIds,
        graph: steps.map(step => [step.stepId, step.outputId, step.dependsOn]), reasons });
      return { planId, outputId, materialIds, state: String(output.state),
        datasetId: typeof destination.datasetId === 'string' ? destination.datasetId : null,
        outputKey: typeof destination.outputKey === 'string' ? destination.outputKey : null,
        expectedSnapshotId: typeof destination.expectedParentSnapshotId === 'string' ? destination.expectedParentSnapshotId : null,
        relatedOutputIds, reasons: [...new Set(reasons)], gaps: [...new Set(gaps)], eligible: reasons.length === 0, stamp, recipe };
    }) };
}

/** Preparation never submits; derive the recipe again from the fresh authoritative plan, not editable UI JSON. */
export async function prepareReviewedR1Output(port: R1ReviewPort, reviewed: R1OutputReview, requestId: string): Promise<R1RequestView> {
  if (!id(requestId)) fail('R1_REVIEW_REQUEST_ID', '需要明确的原请求编号。');
  const fresh = reviewR1Plan(await port.plan(reviewed.planId)).outputs.find(output => output.outputId === reviewed.outputId);
  if (!fresh || fresh.stamp !== reviewed.stamp) fail('R1_REVIEW_CHANGED', '所选输出、依赖或质量状态已改变，请重新审阅。');
  if (!fresh.eligible || !fresh.recipe) fail('R1_REVIEW_BLOCKED', '该输出仍有阻断项；未准备、拆组或提交。');
  const snapshot = await port.snapshotStatus();
  if (snapshot.snapshotId !== fresh.expectedSnapshotId) fail('R1_REVIEW_BASELINE_CHANGED', 'WFD 当前基线已改变；请明确修订目标后重新确认，不能自动换成最新快照。');
  const prepared = await port.prepare({ ...fresh.recipe, requestId });
  if (prepared.requestId !== requestId || prepared.planId !== fresh.planId || prepared.outputId !== fresh.outputId
    || prepared.datasetId !== fresh.datasetId || prepared.outputKey !== fresh.outputKey || !digest(prepared.documentSha256))
    fail('R1_REVIEW_RECEIPT', '准备回执身份与所选输出不一致，请按原请求编号核对，不重新创建请求。');
  return prepared;
}

export function r1ConfirmationKey(view: R1RequestView): string {
  return canonical([view.requestId, view.planId, view.outputId, view.datasetId, view.outputKey, view.documentSha256, view.connection]);
}
/** Confirmation is consumed once by the caller; an unknown/successful original must be queried, never resent in a loop. */
export async function submitReviewedR1Request(port: R1ReviewPort, reviewed: R1RequestView): Promise<unknown> {
  const fresh = await port.get(reviewed.requestId);
  if (r1ConfirmationKey(fresh) !== r1ConfirmationKey(reviewed)) fail('R1_CONFIRMATION_CHANGED', '原请求文档或连接已改变，旧确认已失效。');
  if (fresh.requiresRecovery || !['prepared_profile_pending', 'send_failed'].includes(fresh.state))
    fail('R1_REVIEW_LOOKUP_REQUIRED', '原请求需要查询或恢复；不能把未确认回执或已成功结果当成未提交。');
  const selected = reviewR1Plan(await port.plan(fresh.planId)).outputs.find(output => output.outputId === fresh.outputId);
  if (!selected?.eligible) fail('R1_REVIEW_BLOCKED', '原计划的输出或依赖不再满足独立确认条件。');
  const snapshot = await port.snapshotStatus();
  if (snapshot.snapshotId !== selected.expectedSnapshotId) fail('R1_REVIEW_BASELINE_CHANGED', 'WFD 基线已改变，旧确认不能自动重绑。');
  return port.submit(fresh);
}
