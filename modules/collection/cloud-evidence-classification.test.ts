import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOUD_EVIDENCE_TOPICS } from '../../plugins/storage/baidu-drive.js';
import { classifyCloudEvidenceTopic } from './cloud-evidence-classification.js';

const classify = (text: string) => classifyCloudEvidenceTopic(Buffer.from(text));

test('cloud evidence topics reuse complete daily and minute bar recognition', () => {
  const daily = '交易日期,股票代码,收盘价（元）\n20260407,000001,1.20\n20260408,000001,1.40\n';
  const result = classify(daily);
  assert.equal(result.topic, '行情');
  assert.match(result.basis, /完整原表.*2.*日/u);
  const minute = '交易日期,证券代码,分钟时间,收盘价（元）\n20260407,000001,2026-04-07 09:30:00,1.20\n20260407,000001,2026-04-07 09:31:00,1.40\n';
  assert.equal(classify(minute).topic, '行情');
  assert.equal(classify(minute.replace('09:31:00', '09:31:01')).topic, '待分类');
  assert.equal(classify(daily.replace('20260408', 'not-a-date')).topic, '待分类');
});

test('flow, sentiment and ranking use distinct report structures even when prices are attached', () => {
  assert.equal(classify('交易日期,股票代码,收盘价（元）,主力资金净流入（元）\n20260407,000001,1.20,9000\n').topic, '资金流向');
  assert.equal(classify('交易日期,股票代码,大单买入额（元）\n20260407,000001,9000\n').topic, '资金流向');
  assert.equal(classify('交易日期,股票代码,情绪得分\n20260407,000001,90\n').topic, '市场情绪');
  assert.equal(classify('日期,涨停家数,跌停家数\n2026-04-07,50,5\n').topic, '市场情绪');
  assert.equal(classify('交易日期,股票代码,排名,收盘价（元）\n20260407,000001,1,1.20\n').topic, '榜单');
  assert.equal(classify('交易日期,股票代码,榜单类型,收盘价（元）\n20260407,000001,涨停池,1.20\n').topic, '榜单');
});

test('real ranking structure accepts local security codes with supplemental TS codes', () => {
  const header = ['股票代码', 'TS代码', '交易日期', '股票名称', '榜单类型', '收盘价(元)', '涨跌幅%', '打开次数', '原因描述', '板单类别',
    '标签', '状态', '首次涨停时间', '最后涨停时间', '首次跌停时间', '最后跌停时间', '封单量(元或个)', '封单额(元或个)', '换手率%',
    '实际流通(元或个)', '近一年涨停封板率', '昨收价（元）', '开盘价（元）', '开盘价涨幅%（%）', '最低价（元）', '最低价涨幅%（%）', '收盘价（元）', '收盘价涨幅%（%）'];
  const types = ['跌停池', '炸板池', '连扳池', '涨停池'];
  const rows = Array.from({ length: 59 }, (_, index) => {
    const code = String(index + 1).padStart(6, '0');
    return header.map(name => name === '股票代码' ? code : name === 'TS代码' ? `${code}.SZ` : name === '交易日期' ? '20231103'
      : ['榜单类型', '板单类别'].includes(name) ? types[index % types.length] : name === '收盘价（元）' ? '1.20' : '').join(',');
  });
  const original = `${header.join(',')}\n${rows.join('\n')}\n`;
  assert.equal(classify(original).topic, '榜单');
  assert.equal(classify(original.replaceAll('20231103', '')).topic, '待分类');
  const withoutSubject = `${header.join(',')}\n${rows.map(row => row.split(',').map((cell, index) => index < 2 ? '' : cell).join(',')).join('\n')}\n`;
  assert.equal(classify(withoutSubject).topic, '待分类');
  assert.equal(classify(original.replace('榜单类型,', '情绪得分,')).topic, '待分类');
});

test('real industry, market, sector and retail flow structures supply sufficient composite evidence', () => {
  const fixture = (header: string[], values: Record<string, string>) => `${header.join(',')}\n${header.map(name => values[name] ?? '').join(',')}\n`;
  const industry = fixture(['交易日期', '板块代码', '板块名称', '领涨股票名称', '收盘指数', '指数涨跌幅', '公司数量', '领涨股涨跌幅', '领涨股最新价', '流入资金(亿元)', '流出资金(亿元)', '净额(亿元)'],
    { 交易日期: '20251215', 板块代码: '881101.TI', '流入资金(亿元)': '35.0', '流出资金(亿元)': '33.0', '净额(亿元)': '1.0' });
  const market = fixture(['交易日期', '上证收盘价（点）', '上证涨跌幅(%)', '深证收盘价（点）', '深证涨跌幅(%)', '今日主力净流入 净额（元）', '今日主力净流入净占比%',
    '今日超大单净流入 净额（元）', '今日超大单净流入 净占比%', '今日大单净流入 净额（元）', '今日大单净流入 净占比%', '今日中单净流入 净额（元）',
    '今日中单净流入 净占比%', '今日小单净流入 净额（元）', '今日小单净流入 净占比%'],
  { 交易日期: '20251215', '上证收盘价（点）': '3867.92', '深证收盘价（点）': '13112.09', '今日主力净流入 净额（元）': '-500',
    '今日超大单净流入 净额（元）': '-300', '今日大单净流入 净额（元）': '-200', '今日中单净流入 净额（元）': '100', '今日小单净流入 净额（元）': '400' });
  const sector = fixture(['交易日期', '数据类型', '板块代码', '板块名称', '板块涨跌幅（%）', '板块最新指数', '今日主力净流入额（元）', '今日主力净流入净占比（%）',
    '今日超大单净流入额（元）', '今日超大单净流入占比（%）', '今日大单净流入额（元）', '今日大单净流入占比（%）', '今日中单净流入额（元）',
    '今日中单净流入占比（%）', '今日小单净流入额（元）', '今日小单净流入占比（%）', '今日主力净流入最大股', '序号'],
  { 交易日期: '20251215', 数据类型: '地域', 板块代码: 'BK0145.DC', '今日主力净流入额（元）': '-500', '今日超大单净流入额（元）': '-300',
    '今日大单净流入额（元）': '-200', '今日中单净流入额（元）': '100', '今日小单净流入额（元）': '400', 序号: '29' });
  const retail = fixture(['交易日期', '股票代码', '股票名称', '游资名称', '买入金额（元）', '卖出金额（元）', '净买卖（元）', '关联机构（一般为营业部或机构专用）', '标签'],
    { 交易日期: '20221116', 股票代码: '000032.SZ', 游资名称: '测试游资', '买入金额（元）': '100', '卖出金额（元）': '300', '净买卖（元）': '-200' });
  for (const original of [industry, market, sector, retail]) assert.equal(classify(original).topic, '资金流向');
  for (const original of [industry, market, sector, retail]) assert.equal(classify(original.replace(/2025\d{4}|20221116/gu, '')).topic, '待分类');
  assert.equal(classify(industry.replace('881101.TI', '')).topic, '待分类');
  assert.equal(classify(sector.replace('BK0145.DC', '')).topic, '待分类');
  assert.equal(classify(retail.replace('000032.SZ', '')).topic, '待分类');
  assert.equal(classify(market.replace('上证收盘价（点）', '其他指数')).topic, '待分类');
  assert.equal(classify('日期,今日主力净流入 净额（元）,今日大单净流入 净额（元）\n2025-12-15,-500,-200\n').topic, '待分类');
});

test('broad report signals and single keywords cannot select a topic', () => {
  for (const input of [
    '交易日期,股票代码,情绪备注\n20260407,000001,看好\n',
    '交易日期,股票代码,类型\n20260407,000001,市场情绪\n',
    '交易日期,股票代码,情绪得分\n20260407,000001,看好\n',
    '标题,正文\n资金流向财报行情,市场情绪榜单\n',
    '交易日期,股票代码,序号\n20260407,000001,1\n',
  ]) assert.equal(classify(input).topic, '待分类');
});

test('financial reports need an entity, a reporting period and multiple financial measures', () => {
  assert.equal(classify('报告期,股票代码,营业收入（元）,净利润（元）,收盘价（元）\n20260331,000001,10000,2000,1.20\n').topic, '财报');
  assert.equal(classify('report_period,symbol,total_assets,total_liabilities\n2026Q1,000001,10000,2000\n').topic, '财报');
  for (const input of [
    '报告期,股票代码,营业收入（元）\n20260331,000001,10000\n',
    '报告期,股票代码,营业收入（元）,净利润（元）\n20260230,000001,10000,2000\n',
    '报告期,股票代码,营业收入（元）,净利润（元）\n20260331,000001,10000,2000\n20260630,000002,9000,unknown\n',
  ]) assert.equal(classify(input).topic, '待分类');
});

test('article tables need metadata and body structure, ignoring keywords in article text', () => {
  const original = Buffer.from(JSON.stringify([{ title: '资金流向与财报', content: '本文讨论市场情绪和涨停榜单。', published_at: '2026-04-07T08:00:00+08:00', url: 'https://example.test/articles/1' }]));
  const before = Buffer.from(original);
  const result = classifyCloudEvidenceTopic(original);
  assert.equal(result.topic, '资讯');
  assert.deepEqual(original, before);
  assert.equal(classify('标题,正文,文章链接\n公告,公告原文,https://example.test/articles/2\n').topic, '资讯');
  assert.equal(classify('标题,正文,发布时间\n公告,公告原文,not-a-date\n').topic, '待分类');
});

test('conflicting topics and incomplete rows remain unclassified instead of picking a winning signal', () => {
  const conflict = classify('交易日期,股票代码,资金净流入（元）,情绪得分\n20260407,000001,9000,90\n');
  assert.equal(conflict.topic, '待分类');
  assert.match(conflict.basis, /冲突|混合/u);
  assert.equal(classify('报告期,交易日期,股票代码,营业收入,净利润,排名\n20260331,20260407,000001,10000,2000,1\n').topic, '待分类');
  const late = '交易日期,股票代码,榜单类型,收盘价\n' + '20260407,000001,涨停池,1.20\n'.repeat(100) + '20260407,000002,文章,1.40\n';
  assert.equal(classify(late).topic, '待分类');
  assert.equal(classify('交易日期,股票代码,排名\n20260407,000001,0\n').topic, '待分类');
});

test('unsupported originals, empty tables and full original budgets remain unclassified', () => {
  for (const original of [Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0x00]), Buffer.from('%PDF-1.7\n财报'), Buffer.from('PK\u0003\u0004'),
    Buffer.from('{"items":[{"title":"行情"}]}'), Buffer.from('交易日期,股票代码,收盘价\n')]) {
    const result = classifyCloudEvidenceTopic(original);
    assert.equal(result.topic, '待分类'); assert.ok(result.basis);
  }
  const overBytes = classifyCloudEvidenceTopic(Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  assert.equal(overBytes.topic, '待分类'); assert.match(overBytes.basis, /8 MiB/u);
  const overRows = classify('交易日期,股票代码,情绪得分\n' + '20260407,000001,90\n'.repeat(5001));
  assert.equal(overRows.topic, '待分类'); assert.match(overRows.basis, /5000/u);
});

test('every result uses the provider topic vocabulary and supplies a readable basis', () => {
  const samples = [
    '交易日期,股票代码,收盘价\n20260407,000001,1.20\n',
    '报告期,股票代码,营业收入,净利润\n20260331,000001,10000,2000\n',
    '标题,正文,文章链接\n公告,公告原文,https://example.test/a\n',
    '交易日期,股票代码,资金净流入\n20260407,000001,9000\n',
    '日期,情绪得分\n2026-04-07,90\n',
    '交易日期,股票代码,排名\n20260407,000001,1\n',
    '标题,正文\n公告,公告原文\n',
  ];
  assert.deepEqual(samples.map(input => classify(input).topic), [...CLOUD_EVIDENCE_TOPICS]);
  for (const input of samples) assert.ok(classify(input).basis.length > 10);
});
