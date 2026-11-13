import { canonicalWfdJson } from '../../adapters/database/wfd-transport.js';
import { CLOUD_EVIDENCE_TOPICS } from '../../plugins/storage/baidu-drive.js';
import { parseTableSource, type ParsedCandidateTable } from './candidate-pipeline.js';
import { sourceReportedDate, sourceReportedMinute } from './source-reported-table.js';

export type CloudEvidenceTopic = typeof CLOUD_EVIDENCE_TOPICS[number];
export interface CloudEvidenceClassification { topic: CloudEvidenceTopic; basis: string }

const identityHeader = /^(?:(?:股票|证券|标的|合约|对象|板块|行业)代码|stock_code|security_code|instrument_id|sector_code|industry_code|symbol|code|ts_code|ts代码)$/u;
const dateHeader = /^(?:交易日期|统计日期|数据日期|日期|trade_date|date)$/u;
const minuteHeader = /^(?:分钟时间|分钟标签|minute_time|minute_timestamp)$/iu;
const barIdentityHeader = /^(?:(?:股票|证券|标的|合约|对象)代码|stock_code|security_code|instrument_id|symbol|code)$/iu;
const barDateHeader = /^(?:交易日期|日期|trade_date|date)$/iu;
const closeHeader = /^(?:收盘价?|close)(?:[（(][^()（）]+[）)])?$/iu;
const reportHeader = /(?:榜单|板单|情绪|热度|恐慌|贪婪|封单|封板|连板|连扳|炸板|涨停时间|跌停时间|资金流|净流入|净流出|主力资金|舆情|sentiment|ranking|rank_type)/iu;
const barFieldHeader = /^(?:交易日期|日期|trade_date|date|分钟时间|分钟标签|minute_time|minute_timestamp|(?:股票|证券|标的|合约|对象)代码|stock_code|security_code|instrument_id|symbol|code|TS代码|(?:股票|证券|标的|合约|对象)?名称|name|序号|(?:开盘|最高|最低|收盘|昨收)(?:价)?|涨跌额|涨跌幅|成交量|成交额|复权因子|换手率|量比|市盈率|市净率|市销率|股息率|总股本|流通股本|自由流通股本|总市值|流通市值|open|high|low|close|pre_close|volume|amount|adj_factor)(?:[（(][^\r\n]*[）)])?$/iu;
const reportValue = /涨停池|跌停池|连板池|连扳池|炸板池|涨跌停榜|市场情绪|资金流向/iu;
const periodHeader = /^(?:报告期|报告期末|报表日期|report_period|fiscal_period|period_end|end_date)$/u;
const flowHeader = /^(?:今日|当日)?(?:(?:(?:主力|超大单|大单|中单|小单)(?:资金)?|资金)(?:净流入|净流出|流入|流出)\s*(?:额|金额|净额)?|(?:流入|流出)资金|(?:超大单|大单|中单|小单)(?:买入|卖出)(?:额|金额)|(?:(?:main|super_large|large|medium|small)_)?net_(?:inflow|outflow))$/u;
const sentimentHeader = /^(?:情绪(?:得分|分数|指数)|市场情绪(?:得分|分数|指数)|恐慌贪婪指数|sentiment_score|sentiment_index|market_sentiment|fear_greed_index)$/u;
const financialHeaders = [
  /^(?:营业(?:总)?收入|revenue|total_revenue|operating_revenue)$/u,
  /^(?:(?:归母|扣非)?净利润|归属于母公司(?:所有者|股东)的净利润|net_profit|net_income|parent_net_profit)$/u,
  /^(?:总资产|资产总计|total_assets)$/u,
  /^(?:总负债|负债合计|total_liabilities)$/u,
  /^(?:所有者权益(?:合计)?|股东权益(?:合计)?|total_equity)$/u,
  /^(?:经营活动产生的现金流量净额|operating_cash_flow|net_operating_cash_flow)$/u,
  /^(?:基本每股收益|稀释每股收益|basic_eps|diluted_eps)$/u,
];
const rankingTypes = new Set(['涨停池', '跌停池', '连板池', '连扳池', '炸板池', '涨停榜', '跌停榜', '涨跌停榜', '龙虎榜']);
const numeric = (value: unknown) => (typeof value === 'string' || typeof value === 'number')
  && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(String(value));
const text = (value: unknown) => typeof value === 'string' && !!value.trim();
const date = (value: unknown) => !!(sourceReportedDate(value, 'yyyymmdd') || sourceReportedDate(value, 'iso-date'));
const period = (value: unknown) => date(value) || typeof value === 'string' && /^\d{4}Q[1-4]$/u.test(value);
const positiveInteger = (value: unknown) => (typeof value === 'string' || typeof value === 'number') && /^[1-9][0-9]*$/u.test(String(value));
function articleTime(value: unknown): boolean {
  if (date(value)) return true;
  return typeof value === 'string' && sourceReportedDate(value.slice(0, 10), 'iso-date') !== null
    && /^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/u.test(value)
    && Number.isFinite(Date.parse(value));
}
function articleUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}

function marketBarBasis(table: ParsedCandidateTable): string | null {
  const { columns, rows } = table;
  const closes = columns.filter(column => closeHeader.test(column));
  const dates = columns.filter(column => barDateHeader.test(column));
  const identities = columns.filter(column => barIdentityHeader.test(column));
  const minutes = columns.filter(column => minuteHeader.test(column));
  const values = (column: string) => rows.map(row => row[columns.indexOf(column)]!.original);
  const report = columns.some(column => reportHeader.test(column)
    || /(?:类型|类别|type|semantic_code|表题|表名)$/iu.test(column)
      && values(column).some(value => reportValue.test(String(value ?? ''))));
  if (report || closes.length !== 1 || dates.length !== 1 || identities.length !== 1 || minutes.length > 1
    || columns.some(column => !barFieldHeader.test(column))) return null;
  const rawDates = values(dates[0]!);
  const encoding = rawDates.every(value => sourceReportedDate(value, 'yyyymmdd')) ? 'yyyymmdd'
    : rawDates.every(value => sourceReportedDate(value, 'iso-date')) ? 'iso-date' : null;
  if (!encoding) return null;
  const symbols = values(identities[0]!);
  const prices = values(closes[0]!).filter(value => value !== null && value !== '');
  if (symbols.some(value => value === null || value === '') || !prices.length || prices.some(value => !numeric(value))) return null;
  if (!minutes.length && columns.some(column => /(?:时间|timestamp|datetime|(?:^|_)time)$/iu.test(column))) return null;
  const dateLabels = rawDates.map(value => sourceReportedDate(value, encoding));
  const labels = minutes.length ? values(minutes[0]!).map(value => sourceReportedMinute(value)) : dateLabels;
  if (labels.some((label, index) => !label || minutes.length && label.slice(0, 10) !== dateLabels[index])
    || new Set(labels.map((label, index) => canonicalWfdJson([symbols[index], label]))).size !== table.total_rows) return null;
  return `已核完整原表 ${table.total_rows} 行的对象、${minutes.length ? '日期及分钟' : '日期'}标签和收盘原值，匹配${minutes.length ? '分钟' : '日'}行情保管主题。`;
}

/** 主题只描述保管位置；复用完整原件预算和原表解析，不签发金融语义或发布资格。 */
export function classifyCloudEvidenceTopic(bytes: Buffer): CloudEvidenceClassification {
  const pending = (basis: string): CloudEvidenceClassification => ({ topic: '待分类', basis: basis.slice(0, 4096) });
  if (!Buffer.isBuffer(bytes) || !bytes.length) return pending('完整原件为空或不是原始字节，尚无可核对的数据主题。');
  if (bytes.length > 8 * 1024 * 1024) return pending('完整原件超过自动主题分类的 8 MiB 预算；未截取内容判定主题。');
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const format = /^\s*[\[{]/u.test(source) ? 'json' : 'csv';
    const table = parseTableSource(bytes, { materialId: 'cloud-evidence-classification', format });
    if (table.source_columns.some(column => column.length > 256)) return pending('完整原表的列名超过 256 字符预算。');
    if (table.total_rows > 5000) return pending('完整原表超过自动主题分类的 5000 行预算。');
    const market = marketBarBasis(table);
    if (market) return { topic: '行情', basis: market };
    // 仅规范化列名以核对结构；不读取标题、正文或任意单元格中的关键词决定主题。
    const names = table.columns.map(name => name.trim().toLowerCase().replace(/[（(][^()（）]*[）)]$/u, '').trim());
    const columns = (pattern: RegExp) => names.flatMap((name, index) => pattern.test(name) ? [index] : []);
    const complete = (indices: number[], valid: (value: unknown) => boolean) => indices.length === 1
      && table.rows.every(row => valid(row[indices[0]!]!.original));
    const measures = (indices: number[], minimum = 1) => indices.length >= minimum && table.rows.every(row =>
      indices.every(index => row[index]!.original === null || row[index]!.original === '' || numeric(row[index]!.original))
      && indices.filter(index => numeric(row[index]!.original)).length >= minimum);
    const identities = columns(identityHeader), dates = columns(dateHeader), periods = columns(periodHeader);
    const localIdentities = identities.filter(index => !/^(?:ts_code|ts代码)$/u.test(names[index]!));
    // 主题不建立业务主键；一个明确本地对象代码足以提供主体维度，附加 TS 代码不产生主题冲突。
    const subjectIdentities = localIdentities.length === 1 ? localIdentities : identities;
    const hasIdentity = complete(subjectIdentities, value => text(value) || typeof value === 'number' && Number.isFinite(value));
    const hasDate = complete(dates, date), hasPeriod = complete(periods, period);
    const flows = columns(flowHeader), sentiments = columns(sentimentHeader);
    const rising = columns(/^(?:涨停家数|涨停数量|limit_up_count)$/u), falling = columns(/^(?:跌停家数|跌停数量|limit_down_count)$/u);
    const ranks = columns(/^(?:排名|名次|rank|ranking)$/u), rankTypes = columns(/^(?:榜单类型|榜单名称|rank_type|ranking_type)$/u);
    const shanghai = columns(/^上证收盘价?$/u), shenzhen = columns(/^深证收盘价?$/u);
    const marketFlow = complete(shanghai, numeric) && complete(shenzhen, numeric) && measures(flows, 2);
    const traders = columns(/^游资名称$/u), bought = columns(/^买入金额$/u), sold = columns(/^卖出金额$/u), netTrades = columns(/^净买卖$/u);
    const retailPresent = !!traders.length && !!(bought.length || sold.length || netTrades.length);
    const retailFlow = hasIdentity && complete(traders, text) && complete(bought, numeric) && complete(sold, numeric) && complete(netTrades, numeric);
    const financial = financialHeaders.map(columns).filter(group => group.length);
    const titles = columns(/^(?:标题|文章标题|新闻标题|title)$/u), bodies = columns(/^(?:正文|文章正文|新闻正文|内容|content|body|text|content_text|article_text)$/u);
    const published = columns(/^(?:发布时间|发布日期|发表时间|published_at|published|pubdate|date_published|updated)$/u);
    const urls = columns(/^(?:文章链接|原文链接|新闻链接|url|link)$/u);
    const signals: { topic: CloudEvidenceTopic; present: boolean; valid: boolean; evidence: number[] }[] = [
      { topic: '资金流向', present: !!flows.length || retailPresent,
        valid: hasDate && (hasIdentity && measures(flows) || marketFlow || retailFlow),
        evidence: [...dates, ...(hasIdentity ? subjectIdentities : [...shanghai, ...shenzhen]), ...flows,
          ...(retailFlow ? [...traders, ...bought, ...sold, ...netTrades] : [])] },
      { topic: '市场情绪', present: !!sentiments.length || !!rising.length && !!falling.length,
        valid: hasDate && (measures(sentiments) || complete(rising, value => numeric(value) && Number(value) >= 0 && Number.isInteger(Number(value)))
          && complete(falling, value => numeric(value) && Number(value) >= 0 && Number.isInteger(Number(value)))), evidence: [...dates, ...sentiments, ...rising, ...falling] },
      { topic: '榜单', present: !!ranks.length || !!rankTypes.length,
        valid: hasIdentity && hasDate && (complete(ranks, positiveInteger) || complete(rankTypes, value => typeof value === 'string' && rankingTypes.has(value))),
        evidence: [...dates, ...subjectIdentities, ...ranks, ...rankTypes] },
      { topic: '财报', present: !!periods.length && !!financial.length,
        valid: hasIdentity && hasPeriod && financial.length >= 2 && financial.every(group => group.length === 1)
          && measures(financial.flat(), 2), evidence: [...periods, ...subjectIdentities, ...financial.flat()] },
      { topic: '资讯', present: !!titles.length && !!bodies.length,
        valid: complete(titles, text) && complete(bodies, text) && (complete(published, articleTime) || complete(urls, articleUrl)),
        evidence: [...titles, ...bodies, ...published, ...urls] },
    ];
    const present = signals.filter(signal => signal.present);
    if (present.length > 1) return pending(`完整原表 ${table.total_rows} 行存在${present.map(signal => signal.topic).join('、')}的混合或冲突维度，未自动选择单一主题。`);
    const matched = present[0];
    if (!matched?.valid) return pending(`完整原表 ${table.total_rows} 行尚未满足单一主题的明确列结构及逐行原值证据${matched ? `（${matched.topic}维度仍不完整或有歧义）` : ''}；保留待分类。`);
    const evidence = [...new Set(matched.evidence)].slice(0, 8).map(index => table.columns[index]).join('、');
    return { topic: matched.topic, basis: `已核完整原表 ${table.total_rows} 行的「${evidence}」列结构及相应原值，匹配${matched.topic}主题；仅用于证据保管分类。`.slice(0, 4096) };
  } catch {
    return pending('完整原件尚未完成受支持原表结构的主题核对；未从文件名、扩展名或局部内容推定主题。');
  }
}
