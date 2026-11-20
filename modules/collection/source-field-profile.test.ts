import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import {
  readSourceFieldProfile, SourceFieldProfileStore, profileFingerprint, profileSemanticGaps, profileSignature, sourceFieldProfileDigest,
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

test('explicit domain placeholders are gaps even when both sources supply the same values', () => {
  const scope = { domain: 'bilateral_trade', quantityBasis: 'dry_weight', periodBasis: 'calendar_year',
    valuationBasis: 'FOB', processingStage: 'ore', statisticalAreaScheme: 'ISO_3166_1',
    commodityClassification: { scheme: 'HS', version: 'HS2022', mappingQuality: 'exact' } };
  for (const placeholder of ['unknown', ' UnReSoLvEd ', ' UNSPECIFIED ']) {
    for (const axis of ['processingStage', 'statisticalAreaScheme', 'commodityClassification']) {
      const value = axis === 'commodityClassification' ? { ...scope.commodityClassification, version: placeholder } : placeholder;
      const domainScope = { ...scope, [axis]: value };
      const left = readSourceFieldProfile(sample({ domainScope }), 'left.json');
      const right = readSourceFieldProfile(sample({ domainScope, sourceId: 'synthetic-b' }), 'right.json');
      const comparison = compareProfileSemantics(left, right);
      assert.equal(comparison.status, 'needs_evidence', `${axis}: ${placeholder}`);
      assert.ok(comparison.gaps.some(gap => gap.includes(axis)));
    }
  }
});

test('optional stage and area placeholders block equivalence outside commodity and trade domains', () => {
  for (const scope of [
    { domain: 'market_series' },
    { domain: 'financial_statement', accountingStandard: 'CAS', statementScope: 'consolidated', periodBasis: 'fiscal_year' },
    { domain: 'relation_claim', taxonomyAuthority: 'synthetic-taxonomy/v1', effectivePeriodPolicy: 'explicit_range' },
  ]) {
    const compare = (domainScope: Record<string, unknown>) => compareProfileSemantics(
      readSourceFieldProfile(sample({ domainScope }), 'left.json'),
      readSourceFieldProfile(sample({ domainScope, sourceId: 'synthetic-b' }), 'right.json'),
    );
    assert.equal(compare(scope).status, 'candidate_equivalent');
    for (const axis of ['processingStage', 'statisticalAreaScheme']) {
      for (const placeholder of ['unknown', ' UnReSoLvEd ', ' UnSpEcIfIeD ', ' NoT_RePoRtEd ', 'unreported', '未披露', '未知']) {
        const comparison = compare({ ...scope, [axis]: placeholder });
        assert.equal(comparison.status, 'needs_evidence', `${scope.domain}: ${axis} = ${placeholder}`);
        assert.equal(comparison.sameProduct, false);
        assert.ok(comparison.gaps.some(gap => gap.includes(axis)));
      }
    }
  }
});
const throws = (fn: () => unknown) => assert.throws(fn, (e: unknown) =>
  typeof e === 'object' && e !== null && 'code' in e && e.code === 'SOURCE_FIELD_PROFILE');

test('explicit and implicit market profiles retain the exact legacy bytes and fingerprints', () => {
  const baseline = [
    { domainScope: undefined, fingerprint: '837e584af0fe9bfd585ddcba676295671af5aa0324b38aad6b6cfb46259c2cfc',
      digest: 'fbd55ae66a707f151e34f65097849bb09834234ab1dd531614e7c3c248f4c395',
      bytesHash: '3e22cd0337a65aef666a9c3a30267caa65f2746e267a475e9bce1eb00fe6e6c5' },
    { domainScope: { domain: 'market_series' }, fingerprint: '8426d87b05c894f93a481530f0cad6fd0ccf2107983df3b2ca4a705ea6cb448b',
      digest: '78dd50c52764fce9961965606508fbf6d8e66b5bfb3af2eceadbc467d0606324',
      bytesHash: 'd3e5c8ef4d16aff53316f9c916ce150184aab990542d99f58c3e8f09dd074214' },
  ];
  for (const { domainScope, fingerprint, digest, bytesHash } of baseline) {
    const a = readSourceFieldProfile(sample({ domainScope }), 'old.json');
    const b = readSourceFieldProfile(sample({ domainScope, adjustment: { status: 'qfq', method: 'factor-v1' },
      timeBucket: { ...a.timeBucket, labelSemantics: 'end' } }), 'old-peer.json');
    assert.equal(profileFingerprint(a), fingerprint);
    assert.equal(sourceFieldProfileDigest(a), digest);
    assert.equal(wfdSha256(JSON.stringify([
      a, b, profileSignature(a), profileSignature(b), profileSemanticGaps(a), profileSemanticGaps(b),
      compareProfileSemantics(a, b), compareProfileSemantics(b, a),
    ])), bytesHash);
  }
});

const noMarketAxes = { timeBucket: { kind: 'not_applicable', timezone: 'Asia/Shanghai' },
  adjustment: { status: 'not_applicable' } };
const eventSemantics = { contentNature: 'source_claim', occurrencePolicy: 'preserve_distinct_propagation',
  timePrecisionPolicy: 'preserve_unknown_no_midnight_fill' };
const relationScope = { domain: 'relation_claim', taxonomyAuthority: 'synthetic-taxonomy/v1',
  effectivePeriodPolicy: 'explicit_range' };

test('only declared non-market domains may opt out of market buckets and adjustment', () => {
  for (const domainScope of [
    { domain: 'event_claim', eventSemantics }, relationScope,
    { domain: 'financial_statement', accountingStandard: 'synthetic-accounting/v1', statementScope: 'consolidated',
      periodBasis: 'fiscal_year' },
    { domain: 'geo_commodity', periodBasis: 'month', quantityBasis: 'net_weight', processingStage: 'ore',
      statisticalAreaScheme: 'synthetic-geo/v1' },
    { domain: 'bilateral_trade', periodBasis: 'month', quantityBasis: 'net_weight', processingStage: 'ore',
      statisticalAreaScheme: 'synthetic-geo/v1', valuationBasis: 'FOB',
      commodityClassification: { scheme: 'synthetic-trade', version: '1', mappingQuality: 'exact' } },
  ]) {
    const profile = readSourceFieldProfile(sample({ domainScope, ...noMarketAxes }), 'non-market.json');
    assert.deepEqual(profile.timeBucket, noMarketAxes.timeBucket);
    assert.deepEqual(profile.adjustment, noMarketAxes.adjustment);
    assert.deepEqual(profileSemanticGaps(profile), []);
    assert.equal(compareProfileSemantics(profile, profile).status, 'candidate_equivalent');
  }
  for (const domainScope of [undefined, { domain: 'market_series' }]) {
    throws(() => readSourceFieldProfile(sample({ domainScope, timeBucket: noMarketAxes.timeBucket }), 'market.json'));
    throws(() => readSourceFieldProfile(sample({ domainScope, adjustment: noMarketAxes.adjustment }), 'market.json'));
    throws(() => readSourceFieldProfile(sample({ domainScope,
      timeBucket: { ...sample().timeBucket, ...noMarketAxes.timeBucket } }), 'market-mixed.json'));
  }
  for (const timezone of ['invalid/zone', '+08:00']) {
    throws(() => readSourceFieldProfile(sample({ domainScope: relationScope, ...noMarketAxes,
      timeBucket: { ...noMarketAxes.timeBucket, timezone } }), 'invalid-zone.json'));
  }
});

test('relation taxonomy and effective period report gaps and known differences', () => {
  const relation = (domainScope: Record<string, unknown>) =>
    readSourceFieldProfile(sample({ domainScope, ...noMarketAxes }), 'relation.json');
  const complete = relation(relationScope);
  for (const scope of [{ domain: 'relation_claim' },
    { ...relationScope, taxonomyAuthority: '未知', effectivePeriodPolicy: 'unknown' }]) {
    const result = compareProfileSemantics(complete, relation(scope));
    assert.equal(result.status, 'needs_evidence');
    assert.deepEqual(result.gaps, profileSemanticGaps(relation(scope)));
    assert.match(result.gaps.join(' '), /taxonomyAuthority.*effectivePeriodPolicy/u);
  }
  const other = relation({ ...relationScope, taxonomyAuthority: 'synthetic-taxonomy/v2', effectivePeriodPolicy: 'snapshot_only' });
  assert.equal(compareProfileSemantics(complete, other).status, 'different_semantics');
  assert.match(compareProfileSemantics(complete, other).differences.join(' '), /taxonomyAuthority.*effectivePeriodPolicy/u);
  assert.notEqual(profileFingerprint(complete), profileFingerprint(other));
  throws(() => relation({ ...relationScope, effectivePeriodPolicy: 'open_ended' }));
  throws(() => relation({ ...relationScope, taxonomyAuthority: 42 }));
});

test('event roles and declared event policies are retained and validated', () => {
  const event = (domainScope: Record<string, unknown>) => readSourceFieldProfile(sample({
    domainScope, ...noMarketAxes,
    fields: ['event_time', 'public_time', 'expected_time', 'occurrence', 'evidence'].map(role => ({
      originalHeader: role, fieldCode: role, role, unitCode: 'not_applicable', dataType: 'text',
    })),
  }), 'event.json');
  const left = event({ domain: 'event_claim', eventSemantics });
  assert.deepEqual(left.fields.map(field => field.role), ['event_time', 'public_time', 'expected_time', 'occurrence', 'evidence']);
  assert.deepEqual(left.domainScope?.eventSemantics, eventSemantics);
  assert.match(profileSemanticGaps(event({ domain: 'event_claim' })).join(' '), /eventSemantics/u);
  const right = event({ domain: 'event_claim', eventSemantics: {
    ...eventSemantics, contentNature: 'forecast', occurrencePolicy: 'exact_event_id_only',
  } });
  assert.match(compareProfileSemantics(left, right).differences.join(' '), /contentNature.*occurrencePolicy/u);
  for (const override of [{ contentNature: 'unknown' }, { occurrencePolicy: 'merge_by_text' },
    { timePrecisionPolicy: 'fill_midnight' }, { timePrecisionPolicy: undefined }]) {
    throws(() => event({ domain: 'event_claim', eventSemantics: { ...eventSemantics, ...override } }));
  }
});

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
