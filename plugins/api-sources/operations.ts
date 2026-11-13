import type { SourceOperationView } from '../../contracts/source-settings.js';
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
