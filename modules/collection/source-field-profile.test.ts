import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readSourceFieldProfile, SourceFieldProfileStore, profileFingerprint, sourceFieldProfileDigest,
  compareProfileSemantics, SemanticProductRegistryStore, type SourceFieldProfile,
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
  assert.equal(profileFingerprint(a), '837e584af0fe9bfd585ddcba676295671af5aa0324b38aad6b6cfb46259c2cfc');
  assert.equal(sourceFieldProfileDigest(a), 'fbd55ae66a707f151e34f65097849bb09834234ab1dd531614e7c3c248f4c395');
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

test('unknown measurement is a distinct frozen claim allowed only for source lexemes', () => {
  const [date, close, volume] = sample().fields;
  const lexeme = { ...close!, dataType: 'text', unitCode: 'not_applicable', measurement: '原表标签「元」' };
  const ordinary = readSourceFieldProfile(sample({ fields: [date, lexeme] }), 'ordinary.json');
  const unknown = readSourceFieldProfile(sample({
    fields: [date, { ...lexeme, measurementStatus: 'unknown' }],
  }), 'unknown.json');
  assert.equal(unknown.fields[1]?.measurementStatus, 'unknown');
  assert.notEqual(profileFingerprint(unknown), profileFingerprint(ordinary));
  assert.notEqual(sourceFieldProfileDigest(unknown), sourceFieldProfileDigest(ordinary));
  assert.equal(compareProfileSemantics(ordinary, ordinary).sameProduct, true);
  for (const [left, right] of [[ordinary, unknown], [unknown, ordinary], [unknown, unknown]] as const) {
    const result = compareProfileSemantics(left, right);
    assert.equal(result.sameProduct, false);
    assert.match(result.reasons.join(';'), /计量口径未知/);
  }
  for (const field of [close, volume, { ...lexeme, dataType: 'boolean' }, { ...lexeme, unitCode: 'cny' }]) {
    throws(() => readSourceFieldProfile(sample({
      fields: [date, { ...field, measurementStatus: 'unknown' }],
    }), 'invalid.json'));
  }
  throws(() => readSourceFieldProfile(sample({
    fields: [date, { ...lexeme, measurementStatus: 'known' }],
  }), 'invalid.json'));
});

test('channel upgrades do not change source semantics; new tasks use one current profile', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bd-current-semantic-'));
  try {
    const write = (name: string, value: SourceFieldProfile) => writeFileSync(join(directory, name), JSON.stringify(value));
    const old = readSourceFieldProfile(sample({ adapter: ref('vendor.daily') }), 'daily.json');
    write('daily.json', old);
    write('other.json', sample({ profileId: 'demo-other', series: 'other-series' }));
    const store = new SourceFieldProfileStore(directory);
    const before = store.match({ sourceId: 'synthetic-a', series: 'daily.ohlcv', adapter: ref('vendor.daily') })!;
    assert.equal(before.profileId, old.profileId);
    // 升级来源适配器/实现版本，业务字段未变时不新增一份通道词典。
    assert.equal(store.match({ sourceId: 'synthetic-a', series: 'daily.ohlcv',
      adapter: { ...ref('vendor.daily'), version: '89', configDigest: 'b'.repeat(64) } })!.profileId, old.profileId);
    assert.equal(store.match({ sourceId: 'synthetic-a', series: 'other-series' })?.profileId, 'demo-other');
    assert.equal(store.match({ sourceId: 'synthetic-a' }), null,
      '缺少确切数据系列不能猜测要用哪个来源字段档案');
    assert.equal(store.match({ sourceId: 'another-vendor', series: 'daily.ohlcv' }), null);

    // 本机只维护当前一份：原位修订映射时旧对象仍被冻结于旧请求，不要求保留 old.json。
    const changed = readSourceFieldProfile(sample({
      fields: sample().fields.map(field => field.fieldCode === 'volume'
        ? { ...field, unitCode: 'lot', measurement: '区间成交手数，非成交股数' } : field),
    }), 'daily.json');
    write('daily.json', changed);
    const current = store.match({ sourceId: 'synthetic-a', series: 'daily.ohlcv' })!;
    assert.equal(current.fields.find(field => field.fieldCode === 'volume')!.unitCode, 'lot');
    assert.equal(before.fields.find(field => field.fieldCode === 'volume')!.unitCode, 'share');
    assert.notEqual(sourceFieldProfileDigest(current), sourceFieldProfileDigest(before));
    assert.notEqual(profileFingerprint(current), profileFingerprint(before));
    // 两套同时驻留属于需要清理的当前配置冲突，而不是强制每次维护一个 supersedes 历史链。
    write('stale.json', old);
    throws(() => store.match({ sourceId: 'synthetic-a', series: 'daily.ohlcv' }));
    throws(() => readSourceFieldProfile(sample({ adapter: { ...ref('vendor.daily'), configDigest: 'latest' } }), 'invalid.json'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('semantic product registry distinguishes absent config from corrupt config', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bd-semantic-registry-'));
  const file = join(directory, 'semantic-products.json');
  const fingerprint = 'f'.repeat(64);
  try {
    const store = new SemanticProductRegistryStore(file);
    assert.equal(store.read(), null, '仅未配置文件才返回 null');
    assert.equal(store.datasetFor(fingerprint), null);

    writeFileSync(file, '{"version":');
    assert.throws(() => store.read(), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error
      && error.code === 'SEMANTIC_PRODUCT_REGISTRY_INVALID',
    '损坏的 JSON 不能被视作未登记');

    writeFileSync(file, JSON.stringify({ version: 'bd.semantic-products/1', products: [] }));
    assert.throws(() => store.datasetFor(fingerprint),
      /语义产品登记.*没有产品条目/u, '不合法的产品清单必须阻断读取');

    writeFileSync(file, JSON.stringify({ version: 'bd.semantic-products/1',
      products: [{ fingerprint, datasetId: 'financial_daily' }] }));
    assert.equal(store.datasetFor(fingerprint), 'financial_daily');
    assert.equal(store.datasetFor('0'.repeat(64)), null, '合法登记中未命中的指纹仍是 null');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('new source-field profiles do not require adapter version, supersedes chain or mapping revision', () => {
  const current = { ...sample() } as Partial<SourceFieldProfile>;
  delete current.mappingVersion;
  const accepted = readSourceFieldProfile(current, 'current.json');
  assert.equal(Object.hasOwn(accepted, 'mappingVersion'), false);
  assert.equal(accepted.adapter, undefined);
  assert.equal(accepted.supersedes, undefined);
  assert.equal(profileFingerprint(accepted), profileFingerprint(sample()),
    'Business semantics remain identical across a removed historical mapping revision');
});

test('profile directory permission/shape errors must not be mistaken for missing profiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'bd-profile-readable-'));
  const file = join(root, 'not-a-directory');
  try {
    writeFileSync(file, 'ordinary file');
    assert.throws(() => new SourceFieldProfileStore(file).list(), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error
      && error.code === 'SOURCE_FIELD_PROFILE_READ');
    assert.deepEqual(new SourceFieldProfileStore(join(root, 'absent')).list(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
