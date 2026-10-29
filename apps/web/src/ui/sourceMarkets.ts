import type { SourceAssetScope, SourceConnection, SourceDataCapability, SourceOperationId } from '../../../../contracts/source-settings';

/** 接口源分类：地区与全球类型常量、偏好布局与筛选身份，供接口源页和来源编排共用。 */
export interface MarketLeaf { id: string; label: string; countries?: string[]; china?: boolean }
const REGION_DEFAULTS: Record<string, MarketLeaf> = {
  cnMainland: { id: 'cnMainland', label: '中国大陆', china: true },
  cnHongkong: { id: 'cnHongkong', label: '中国香港', china: true },
  cnTaiwan: { id: 'cnTaiwan', label: '中国台湾', china: true },
  us: { id: 'us', label: '美国', countries: ['美国'] },
  europe: { id: 'europe', label: '欧洲', countries: ['英国', '德国', '法国', '瑞士', '荷兰', '意大利', '西班牙', '瑞典'] },
  japan: { id: 'japan', label: '日本', countries: ['日本'] },
  canada: { id: 'canada', label: '加拿大', countries: ['加拿大'] },
  korea: { id: 'korea', label: '韩国', countries: ['韩国'] },
  india: { id: 'india', label: '印度', countries: ['印度'] },
};
const OTHER_DEFAULTS: Record<string, MarketLeaf> = {
  sea: { id: 'sea', label: '东南亚', countries: ['新加坡', '马来西亚', '泰国', '印度尼西亚', '越南', '菲律宾'] },
  oceania: { id: 'oceania', label: '大洋洲', countries: ['澳大利亚', '新西兰'] },
  latam: { id: 'latam', label: '拉丁美洲', countries: ['巴西', '墨西哥', '智利', '哥伦比亚', '阿根廷'] },
  middleeast: { id: 'middleeast', label: '中东', countries: ['沙特阿拉伯', '阿联酋', '卡塔尔', '科威特', '以色列'] },
  africa: { id: 'africa', label: '非洲', countries: ['南非', '埃及', '尼日利亚', '摩洛哥', '肯尼亚'] },
  asiaOther: { id: 'asiaOther', label: '其他亚洲地区', countries: ['巴基斯坦', '孟加拉国', '斯里兰卡', '蒙古', '哈萨克斯坦'] },
};
const GLOBAL_CATEGORIES: MarketLeaf[] = [
  { id: 'fx', label: '全球外汇' }, { id: 'crypto', label: '数字资产' }, { id: 'commodity', label: '大宗商品' },
  { id: 'global-index', label: '全球指数与跨国统计' }, { id: 'special-assets', label: '特殊资产' },
];
export const GLOBAL_MARKET_LEAVES = GLOBAL_CATEGORIES;
export const ASSET_SCOPES = ['全部', '股票与基金', '期货与期权', '债券与利率', '其他'];
export const DATA_CAPS = ['全部', '历史数据', '快照', '实时流'];
export const DATA_CAPABILITY_LABELS: Record<SourceDataCapability, [string, string]> = {
  history: ['历史数据', 'History'], snapshot: ['快照', 'Snapshot'], stream: ['实时流', 'Live'],
};
export const DATA_CAPABILITY_IDS: Record<string, SourceDataCapability> = { '历史数据': 'history', '快照': 'snapshot', '实时流': 'stream' };
export const ASSET_SCOPE_IDS: Record<string, SourceAssetScope> = { '股票与基金': 'equity', '期货与期权': 'futures', '债券与利率': 'bond', '其他': 'other' };
export const ASSET_SCOPE_LABELS: Record<SourceAssetScope, [string, string]> = {
  equity: ['股票与基金', 'Equity & funds'], futures: ['期货与期权', 'Futures & options'], bond: ['债券与利率', 'Bonds & rates'], other: ['其他', 'Other'],
};
export const TYPE_CAPABILITY_ORDER: SourceDataCapability[] = ['history', 'snapshot', 'stream'];
export const MARKET_SCOPES: Partial<Record<string, string>> = { cnMainland: 'CN/A_STOCK', cnHongkong: 'HK/STOCK', us: 'US/STOCK' };
export interface TypeCard { id: SourceOperationId; label: string; capability: SourceDataCapability; assetScope: SourceAssetScope; primary: SourceConnection | null; backups: SourceConnection[]; optional: SourceConnection[] }
export interface Layout { root: string[]; other: string[] }
export const defaultLayout: Layout = { root: ['cnMainland', 'cnHongkong', 'cnTaiwan', 'us', 'europe', 'japan', 'canada', 'korea', 'india'], other: ['sea', 'oceania', 'latam', 'middleeast', 'africa', 'asiaOther'] };
export const DEFAULT_MARKET = 'cnMainland';

export const marketOf = (id: string): MarketLeaf | undefined =>
  [...Object.values(REGION_DEFAULTS), ...Object.values(OTHER_DEFAULTS), ...GLOBAL_CATEGORIES].find((item) => item.id === id);
export const layoutOf = (ids: string[]): MarketLeaf[] =>
  ids.map((id) => marketOf(id)).filter((item): item is MarketLeaf => !!item);
export const marketLabelOf = (id: string): string => marketOf(id)?.label ?? id;
export const shortSource = (connection: SourceConnection): string => connection.alias.split(' · ')[0] || connection.alias;
