import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyR1AlgorithmInput } from './r1-algorithm-routing.js';

test('algorithm routing checks all source rows and report dimensions before selecting bar algorithms', () => {
  const daily = Buffer.from('交易日期,股票代码,收盘价（元）\n20260101,000001,1.20\n20260102,000001,1.40\n');
  const recognized = classifyR1AlgorithmInput(daily);
  assert.equal(recognized.kind, 'daily_bar'); assert.equal(recognized.valueColumn, '收盘价（元）');
  assert.equal(recognized.complete, true); assert.equal(recognized.rowCount, 2);
  const report = Buffer.from('交易日期,股票代码,榜单类型,收盘价（元）\n20260101,000001,涨停池,1.20\n');
  assert.equal(classifyR1AlgorithmInput(report).kind, 'mixed');
  const lateMixed = Buffer.from('交易日期,股票代码,收盘价（元）\n20260101,000001,1.20\nnot-a-date,000001,1.40\n');
  assert.equal(classifyR1AlgorithmInput(lateMixed).kind, 'unknown');
  const sentiment = Buffer.from('交易日期,股票代码,情绪得分\n20260101,000001,90\n');
  assert.equal(classifyR1AlgorithmInput(sentiment).kind, 'sentiment');
  const otherMeasure = Buffer.from('交易日期,股票代码,收盘价（元）,大单买入额（元）\n20260101,000001,1.20,9000\n');
  assert.equal(classifyR1AlgorithmInput(otherMeasure).kind, 'mixed', 'A price column cannot turn another report into a bar dataset');
});

test('minute classification needs actual matching date/minute labels and does not certify complete bars', () => {
  const original = Buffer.from('交易日期,证券代码,分钟时间,收盘价（元）\n20260407,000001,2026-04-07 09:30:00,1.20\n20260407,000001,2026-04-07 09:31:00,1.40\n');
  const result = classifyR1AlgorithmInput(original);
  assert.equal(result.kind, 'minute_bar'); assert.equal(result.minuteColumn, '分钟时间');
  assert.match(result.reason, /原报.*标签|完整性.*未知/u);
  assert.equal(classifyR1AlgorithmInput(Buffer.from(original.toString().replace('09:31:00', '09:31:01'))).kind, 'unknown');
  assert.equal(classifyR1AlgorithmInput(Buffer.from(original.toString().replace('2026-04-07 09:31', '2026-04-08 09:31'))).kind, 'unknown');
});
