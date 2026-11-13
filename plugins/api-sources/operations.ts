import type { SourceOperationView } from '../../contracts/source-settings.js';
import { publicKlineProvider } from './public-kline.js';

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
