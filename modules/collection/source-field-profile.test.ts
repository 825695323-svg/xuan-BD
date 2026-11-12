import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readSourceFieldProfile, SourceFieldProfileStore, profileFingerprint, sourceFieldProfileDigest,
  compareProfileSemantics, type SourceFieldProfile,
} from './source-field-profile.js';

const sample = (changes: Record<string, unknown> = {}): SourceFieldProfile => ({
  version: 'bd.source-field-profile/1', mappingVersion: 1,
  profileId: 'demo-daily-1', sourceId: 'synthetic-a', series: 'daily.ohlcv',
  fields: [
    { originalHeader: '交易日期', fieldCode: 'trade_date', dataType: 'text', unitCode: 'date', role: 'date' },
    { originalHeader: 'close', aliases: ['收盘价'], fieldCode: 'close', dataType: 'decimal',
      unitCode: 'cny_per_share', role: 'value', measurement: '未复权每股收盘价' },
    { originalHeader: 'volume', fieldCode: 'volume', dataType: 'integer',
      unitCode: 'share', role: 'value', measurement: '本区间累计成交股数' },
  ],
  frequency: 'day', timeBucket: { labelSemantics: 'start', interval: 'closed_open',
    lengthMinutes: 1440, timezone: 'Asia/Shanghai' },
  adjustment: { status: 'raw' },
  confirmation: { status: 'operator_confirmed', basis: '合成测试资料逐字段口径确认，不代表真实供应商已验收',
    confirmedAtUtc: '2026-11-13T00:00:00Z' },
  ...changes,
});
const ref = (id: string) => ({ adapterId: id, version: '1', configDigest: 'a'.repeat(64) });
const throws = (fn: () => unknown) => assert.throws(fn, (e: unknown) =>
  typeof e === 'object' && e !== null && 'code' in e && e.code === 'SOURCE_FIELD_PROFILE');

test('source header aliases are retained, but do not change canonical cross-provider semantics', () => {
  const a = readSourceFieldProfile(sample(), 'a.json');
  const b = readSourceFieldProfile(sample({
    profileId: 'other-daily-1', sourceId: 'synthetic-b',
    fields: [
      { originalHeader: 'date', fieldCode: 'trade_date', dataType: 'text', unitCode: 'date', role: 'date' },
      { originalHeader: 'closing_price', fieldCode: 'close', dataType: 'decimal',
        unitCode: 'cny_per_share', role: 'value', measurement: '未复权每股收盘价' },
      { originalHeader: 'traded_shares', fieldCode: 'volume', dataType: 'integer',
        unitCode: 'share', role: 'value', measurement: '本区间累计成交股数' },
    ],
  }), 'b.json');
  assert.deepEqual(a.fields[1]?.aliases, ['收盘价']);
  assert.equal(compareProfileSemantics(a, b).sameProduct, true);
  assert.equal(profileFingerprint(a), profileFingerprint(b));
  assert.notEqual(sourceFieldProfileDigest(a), sourceFieldProfileDigest(b));
});

test('same units and field names do not hide adjustment method, basis, or unresolved meaning', () => {
  const a = readSourceFieldProfile(sample({ adjustment: { status: 'qfq', method: 'factor-v1',
    basis: '2026-11-01' } }), 'a.json');
  const b = readSourceFieldProfile(sample({ adjustment: { status: 'qfq', method: 'factor-v2',
    basis: '2026-11-01' } }), 'b.json');
  assert.equal(compareProfileSemantics(a, b).sameProduct, false);
  assert.match(compareProfileSemantics(a, b).reasons.join(';'), /复权方法不同/);
  const c = readSourceFieldProfile(sample({ adjustment: { status: 'qfq', method: 'factor-v1',
    basis: '2026-11-02' } }), 'c.json');
  assert.match(compareProfileSemantics(a, c).reasons.join(';'), /复权基准不同/);
  const unknown = readSourceFieldProfile(sample({ adjustment: { status: 'unknown' } }), 'unknown.json');
  assert.equal(compareProfileSemantics(unknown, unknown).sameProduct, false);
  const withoutMeasure = readSourceFieldProfile(sample({
    fields: sample().fields.map(field => field.fieldCode === 'close'
      ? { ...field, measurement: undefined } : field),
  }), 'missing.json');
  assert.match(compareProfileSemantics(withoutMeasure, withoutMeasure).reasons.join(';'), /金融计量口径未同时明确/);
});

test('profiles only apply to exactly pinned adapter and source series; old generic profiles cannot take over', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bd-source-profiles-'));
  try {
    const write = (name: string, value: SourceFieldProfile) => writeFileSync(join(directory, name), JSON.stringify(value));
    write('one.json', sample({ adapter: ref('vendor.daily') }));
    write('two.json', sample({ profileId: 'demo-daily-other', adapter: ref('vendor.minute'),
      frequency: 'minute', timeBucket: { labelSemantics: 'start', interval: 'closed_open',
        lengthMinutes: 1, timezone: 'Asia/Shanghai' } }));
    write('generic.json', sample({ profileId: 'generic-profile', series: 'generic' }));
    const store = new SourceFieldProfileStore(directory);
    assert.equal(store.match({ sourceId: 'synthetic-a', series: 'daily.ohlcv',
      adapter: ref('vendor.daily') })?.profileId, 'demo-daily-1');
    assert.equal(store.match({ sourceId: 'synthetic-a', series: 'daily.ohlcv',
      adapter: ref('vendor.minute') })?.profileId, 'demo-daily-other');
    assert.equal(store.match({ sourceId: 'synthetic-a', series: 'daily.ohlcv',
      adapter: { ...ref('vendor.daily'), configDigest: 'b'.repeat(64) } }), null);
    assert.equal(store.match({ sourceId: 'synthetic-a', series: 'daily.ohlcv' }), null);
    assert.equal(store.match({ sourceId: 'synthetic-a', series: 'generic',
      adapter: ref('vendor.daily') }), null);
    assert.equal(store.match({ sourceId: 'synthetic-a', series: 'generic' })?.profileId, 'generic-profile');
    throws(() => readSourceFieldProfile(sample({ adapter: { ...ref('vendor.daily'), configDigest: 'latest' } }), 'invalid.json'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('new semantics require explicit, linearly versioned supersession; old files stay reconstructible', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bd-semantic-versions-'));
  try {
    const older = sample({ adapter: ref('vendor.daily') });
    const newer = sample({ adapter: ref('vendor.daily'), profileId: 'demo-daily-2',
      mappingVersion: 2, adjustment: { status: 'qfq', method: 'official-factor', basis: '2026-11-13' },
      supersedes: [{ profileId: 'demo-daily-1', note: '供应商公告修订了该数据系列的复权定义' }],
      confirmation: { status: 'operator_confirmed',
        basis: '合成测试来源修订公告和独立样本记录', confirmedAtUtc: '2026-11-13T01:00:00Z' } });
    writeFileSync(join(directory, 'old.json'), JSON.stringify(older));
    writeFileSync(join(directory, 'new.json'), JSON.stringify(newer));
    const store = new SourceFieldProfileStore(directory);
    const selected = store.match({ sourceId: 'synthetic-a', series: 'daily.ohlcv',
      adapter: ref('vendor.daily') });
    assert.equal(selected?.profileId, 'demo-daily-2');
    assert.notEqual(profileFingerprint(older), profileFingerprint(selected!));
    assert.equal(store.list().length, 2, '旧版本仍在，历史任务可以按原摘要恢复');
    const missing = { ...newer, supersedes: undefined };
    writeFileSync(join(directory, 'new.json'), JSON.stringify(missing));
    throws(() => store.match({ sourceId: 'synthetic-a', series: 'daily.ohlcv',
      adapter: ref('vendor.daily') }));
    const badVersion = { ...newer, mappingVersion: 1 };
    writeFileSync(join(directory, 'new.json'), JSON.stringify(badVersion));
    throws(() => store.match({ sourceId: 'synthetic-a', series: 'daily.ohlcv',
      adapter: ref('vendor.daily') }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
