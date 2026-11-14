import type { SourceCandidateFeedback, SourceOperationView } from '../../contracts/source-settings.js';
import { publicKlineProvider, publicKlineProviders } from './public-kline.js';

/**
 * 唯一的接口操作目录：页面展示的操作与服务端路由使用同一份声明。
 * 新增来源时只登记已经由执行器支持的动作；不在页面猜测供应商协议。
 */
const providerOperations: Record<string, SourceOperationView[]> = {
  tdx: [{ id: 'minute_bars', label: '1分钟K线', dataCapability: 'history', assetScope: 'equity',
    run: { action: 'source.fetch', sourceId: 'tdx' } }],
  ths: [
    { id: 'daily_bars', label: '日线行情', dataCapability: 'history', assetScope: 'equity',
      run: { action: 'source.api.read' } },
    { id: 'index_constituents', label: '当前指数成分', dataCapability: 'snapshot', assetScope: 'equity',
      run: { action: 'source.api.read' } },
  ],
};

export function sourceOperations(pluginId: string): SourceOperationView[] {
  const fixed = providerOperations[pluginId];
  if (fixed) return fixed;
  const publicProvider = publicKlineProvider(pluginId);
  return publicProvider ? publicProvider.operations.map(operation => ({
    ...operation, run: { action: 'source.kline.read' as const },
  })) : [];
}

/** 按执行器投影同一目录，供旧请求适配和工具选项复用；不再另写支持动作名单。 */
export function sourceOperationsForAction(action: SourceOperationView['run']['action']): SourceOperationView[] {
  const operations = [...Object.values(providerOperations).flat(),
    ...publicKlineProviders.flatMap(provider => sourceOperations(provider.id))];
  return [...new Map(operations.filter(operation => operation.run.action === action)
    .map(operation => [operation.id, operation])).values()];
}


/** 来源回执的统一、有界候选反馈。原件保管成功不等于业务数据完整、等价或已发布。 */

/** 只投影当前真实已获得的证据；不按数据类型创建清洗任务或推断行情交易日覆盖。 */
export function sourceCandidateFeedback(input: {
  scopeId: string; operationId: SourceOperationView['id']; providerId: string; connectionId: string;
  acquiredAtUtc: string; subjectId?: string; start?: string; end?: string; adjustment?: string;
  rowCount?: number; actualStart?: string | null; actualEnd?: string | null;
  originals: { fileRefId: string; sha256: string }[];
}): SourceCandidateFeedback {
  if (!sourceOperations(input.providerId).some(operation => operation.id === input.operationId))
    throw new Error('SOURCE_OPERATION_NOT_REGISTERED: 仅允许实际登记的来源操作生成候选反馈。');
  if (input.rowCount !== undefined && (!Number.isSafeInteger(input.rowCount) || input.rowCount < 0))
    throw new Error('SOURCE_CANDIDATE_ROWS: 已解析的行数必须真实且非负。');
  if (!input.originals.length || input.originals.some(item => !item.fileRefId || !/^[a-f0-9]{64}$/u.test(item.sha256)))
    throw new Error('SOURCE_CANDIDATE_EVIDENCE: 来源候选缺少真实保管摘要和文件引用。');
  const state = input.rowCount === undefined ? 'raw_only' : input.rowCount === 0 ? 'empty_unconfirmed' : 'rows_observed';
  return {
    contract: 'bd.source-candidate-feedback/1',
    logicalRequest: { scopeId: input.scopeId, operationId: input.operationId,
      subjectId: input.subjectId ?? null, start: input.start ?? null, end: input.end ?? null,
      adjustment: input.adjustment ?? null },
    actualSource: { providerId: input.providerId, connectionId: input.connectionId },
    observation: { state, rowCount: input.rowCount ?? null, acquiredAtUtc: input.acquiredAtUtc },
    coverage: { actualStart: input.actualStart ?? null, actualEnd: input.actualEnd ?? null,
      completeness: 'not_established' },
    evidence: { originalRefs: input.originals.map(item => ({ fileRefId: item.fileRefId, sha256: item.sha256 })) },
    semanticStatus: 'not_verified',
    gaps: [state === 'raw_only' ? '当前只有保管的原始响应；业务记录、空响应性质及覆盖未解析。'
      : state === 'empty_unconfirmed' ? '本次没有观测到记录；未证明来源确认无数据，不能补零或声明历史完整。'
      : '仅观测到原报数据行；交易日完整性和可用历史范围尚未核定。',
      '字段单位、时间口径、来源真实性及正式 WFD 发布资格仍须按实际合同核对。'],
    next: 'return_to_agents', publication: 'not_requested',
  };
}
