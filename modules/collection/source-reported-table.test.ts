import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
import { inspectMaterial } from './data-processing/material-inspector/index.js';
import { parseTableSource, prepareCandidateTable } from './candidate-pipeline.js';
import { resolveR1Evidence } from './r1-evidence.js';
import { readSourceFieldProfile, profileFingerprint, sourceFieldProfileDigest,
  type FrozenSourceFieldProfile } from './source-field-profile.js';
import { projectSourceReportedTable, readSourceProjection, sourceReportedCode } from './source-reported-table.js';
import type { MaterialEnvelope } from './materials/contracts.js';

const first = { '交易日期':'20251215','对象代码':'A01','对象名称':'甲','原报金额（亿元）':'13.9700','原报比例%':'0','标签':'' };
function resolve(rows: Record<string,unknown>[], options: { answers?:Record<string,string>; series?:string; sourceValueColumns?:string[]; filename?:string;
  registeredKeyColumns?:string[];registeredUnits?:Record<string,string>;registeredTypes?:Record<string,'decimal'|'integer'|'text'|'boolean'>;
  registeredSourceDefinition?:WfdRecord; sourceFieldProfile?:FrozenSourceFieldProfile } = {}) {
  const original = Buffer.from(JSON.stringify(rows));
  const envelope: MaterialEnvelope = { materialId:'source-test',taskId:'test-task',category:'data',environment:'synthetic-test',
    filename:options.filename ?? 'unrelated-name.json',mediaType:'application/json',byteLength:original.length,sha256:wfdSha256(original),
    version:1,fileRefId:'test-file',fileRefVersion:1,inspectorVersion:'1',adapter:null,createdAt:0,localOnly:true };
  const preview = inspectMaterial(original,{category:'data',filename:envelope.filename,mediaType:envelope.mediaType});
  const result = resolveR1Evidence({original,material:{envelope,preview},namespace:'test',datasetId:'data',parentSnapshotId:null,
    answers:{source_trade_date_timezone:'Asia/Shanghai',...options.answers},sourceValueColumns:options.sourceValueColumns,
    registeredKeyColumns:options.registeredKeyColumns,registeredUnits:options.registeredUnits,
    registeredTypes:options.registeredTypes,
    registeredSourceDefinition:options.registeredSourceDefinition,
    sourceFieldProfile:options.sourceFieldProfile,
    source:{source_id:'same-provider-export',provider:'test-declared-provider',requested_url:`file:///explicit-source/${encodeURIComponent(options.series ?? '原报指标系列')}/2025/file.json`,
      requested_at_utc:'2026-11-04T00:00:00Z',acquired_at_utc:'2026-11-04T00:00:00Z',usage_scope:'synthetic projection test'} });
  return {original,result};
}
test('source dates, original units, reversible names and derived cells retain exact source evidence', () => {
  const {original,result} = resolve([first,{...first,'对象代码':'A02','原报金额（亿元）':'','标签':'有效文字'}]);
  assert.deepEqual(result.questions,[]);
  const proposal = result.proposal!;
  assert.equal(proposal.mapping.publicTime,undefined);
  assert.equal(proposal.mapping.sourceTimezone,'Asia/Shanghai');
  assert.equal(proposal.target.definition.semantic_context && (proposal.target.definition.semantic_context as {content_nature:string}).content_nature,'source_claim');
  assert.equal(result.evidence.find(fact=>fact.key==='source_trade_date_timezone')?.field,'answers.source_trade_date_timezone');
  const field = proposal.sourceProjection!.fields.find(field=>field.column==='原报金额（亿元）')!;
  assert.equal(Buffer.from(field.fieldCode.slice(4),'base64url').toString('utf8'),'原报金额（亿元）');
  const definition = (proposal.target.definition.field_definitions as {field_code:string;data_type:string;unit_code:string}[]).find(value=>value.field_code===field.fieldCode)!;
  assert.equal(definition.data_type,'decimal');
  assert.equal(Buffer.from(definition.unit_code.slice(8),'base64url').toString('utf8'),'亿元');
  const out = prepareCandidateTable(original,{materialId:'source-test',format:'json',sourceProjection:proposal.sourceProjection,types:proposal.types,emptyToNull:proposal.emptyToNull});
  assert.equal(out.rows[0]!.__bd_source_start,'2025-12-14T16:00:00Z');
  assert.equal(out.rows[0]!.__bd_source_end,'2025-12-15T16:00:00Z');
  assert.equal(out.rows[0]!.__bd_source_key,'source_row_'+wfdSha256(canonicalWfdJson(['20251215','A01'])));
  assert.equal(out.rows[0]!['原报金额（亿元）'],'13.97');
  assert.equal(out.rows[1]!['原报金额（亿元）'],null);
  assert.equal(out.rows[1]![field.stateColumn],'unknown');
  const percentState=proposal.sourceProjection!.fields.find(field=>field.column==='原报比例%')!.stateColumn;
  assert.equal(out.rows[0]![percentState],'valid_value');
  const parsed = parseTableSource(original,{materialId:'source-test',format:'json',sourceProjection:proposal.sourceProjection});
  assert.equal(parsed.rows[0]![3]!.original,'13.9700');
  const start = parsed.rows[0]![parsed.columns.indexOf('__bd_source_start')]!;
  assert.equal(start.original,null);
  assert.deepEqual(start.projection?.sources.map(value=>[value.column,value.original]),[['交易日期','20251215']]);
  for (const source of start.projection!.sources) assert.equal(original.toString().slice(source.location.start,source.location.end),source.quote);
});
test('same source series reuses identity across dates and selected/new nonidentity columns without claiming missing units', () => {
  const base=resolve([first]).result.proposal!;
  const later=resolve([{...first,'交易日期':'20260101','新观察次数':'2'}]).result.proposal!;
  assert.equal(base.target.outputKey,later.target.outputKey);
  assert.deepEqual(base.target.subject,later.target.subject);
  assert.notEqual(base.target.outputKey,resolve([first],{series:'同形不同业务系列'}).result.proposal!.target.outputKey);
  assert.deepEqual(resolve([{...first,'单位未写数值':'7.75'}]).result.questions.map(question=>question.key),['unit.单位未写数值']);
  const scoped=resolve([{...first,'单位未写数值':'7.75'}],{sourceValueColumns:['原报金额（亿元）']}).result;
  assert.deepEqual(scoped.questions,[]);
  assert.equal(scoped.proposal!.target.outputKey,base.target.outputKey);
  assert.deepEqual(scoped.proposal!.sourceProjection!.fields.map(field=>field.column),['交易日期','对象代码','原报金额（亿元）']);
  assert.ok(scoped.proposal!.sourceProjection!.sourceColumns.includes('单位未写数值'));
  assert.equal(scoped.proposal!.mapping.fields.some(field=>field.value==='单位未写数值'),false);
});
test('repeated object codes require actual composite dimensions and never row ordinals or measured values', () => {
  const rows=[{...first,'机构名称':'甲机构'},{...first,'机构名称':'乙机构'}];
  assert.deepEqual(resolve(rows).result.questions.map(question=>question.key),['source_key_columns']);
  const completed=resolve(rows,{answers:{source_key_columns:'["对象代码","机构名称"]'}}).result;
  assert.deepEqual(completed.questions,[]);
  assert.deepEqual(completed.proposal!.sourceProjection!.keyColumns,['交易日期','对象代码','机构名称']);
  assert.deepEqual(resolve(rows,{answers:{source_key_columns:'["对象代码","原报金额（亿元）"]'}}).result.questions.map(question=>question.key),['source_key_columns']);
  assert.throws(()=>resolve([{...first,'机构名称':'同一个'},{...first,'机构名称':'同一个'}],{answers:{source_key_columns:'["对象代码","机构名称"]'}}),/重复业务键/);
});
test('invalid dates, numeric source markers and conflicting unit replacements cannot obtain a proposal', () => {
  assert.throws(()=>resolve([{...first,'交易日期':'20250230'}]),/无效或混合编码日期/);
  assert.throws(()=>resolve([{...first,'原报金额（亿元）':'--'}]),/非数值原报/);
  assert.throws(()=>resolve([first],{answers:{'unit.原报金额（亿元）':'cny'}}),/冲突/);
  const {original,result}=resolve([first]);
  const parsed=parseTableSource(original,{materialId:'source-test',format:'json'});
  assert.throws(()=>projectSourceReportedTable(parsed,{...result.proposal!.sourceProjection!,keyColumns:['交易日期','不存在']}),/身份轴|实际键列/);
  assert.throws(()=>readSourceProjection({...result.proposal!.sourceProjection!,script:'arbitrary'}),/明确版本/);
  assert.equal(sourceReportedCode('src_','非常长的原始字段'.repeat(20)),null);
});
test('source minute labels retain their own time axis and key without claiming bar anchoring or calendar coverage', () => {
  const rows = [
    { '交易日期':'20260407', '证券代码':'000001.SZ', '分钟时间':'2026-04-07 09:30:00', '收盘价（元）':'11.13' },
    { '交易日期':'20260407', '证券代码':'000001.SZ', '分钟时间':'2026-04-07 09:31:00', '收盘价（元）':'11.11' },
    { '交易日期':'20260407', '证券代码':'000002.SZ', '分钟时间':'2026-04-07 09:30:00', '收盘价（元）':'6.88' },
  ];
  const {original,result}=resolve(rows,{sourceValueColumns:['收盘价（元）']});
  assert.deepEqual(result.questions,[]);
  const proposal=result.proposal!;
  assert.deepEqual(proposal.sourceProjection!.keyColumns,['交易日期','分钟时间','证券代码']);
  assert.deepEqual(proposal.sourceProjection!.minute,{column:'分钟时间',encoding:'iso-local-minute'});
  assert.equal(proposal.sourceProjection!.version,'source-reported-table/2');
  assert.equal(proposal.mapping.precision,'minute');
  const context=proposal.target.definition.semantic_context as WfdRecord;
  assert.equal((context.time as WfdRecord).frequency,'source_reported_minute');
  assert.equal(((context.time as WfdRecord).roles as WfdRecord).business_interval,'minute_label_bucket_not_verified_bar_interval');
  const out=prepareCandidateTable(original,{materialId:'source-test',format:'json',sourceProjection:proposal.sourceProjection,types:proposal.types});
  assert.equal(out.rows[0]!.__bd_source_start,'2026-04-07T01:30:00Z');
  assert.equal(out.rows[0]!.__bd_source_end,'2026-04-07T01:31:00Z');
  assert.notEqual(out.rows[0]!.__bd_source_key,out.rows[1]!.__bd_source_key);
  assert.notEqual(out.rows[0]!.__bd_source_key,out.rows[2]!.__bd_source_key);
  const parsed=parseTableSource(original,{materialId:'source-test',format:'json',sourceProjection:proposal.sourceProjection});
  const start=parsed.rows[0]![parsed.columns.indexOf('__bd_source_start')]!;
  assert.deepEqual(start.projection!.sources.map(value=>value.column),['交易日期','分钟时间']);
});
test('invalid, conflicting, missing and ambiguous local minute labels never fall back to a day projection', () => {
  const row={'交易日期':'20260407','证券代码':'000001.SZ','分钟时间':'2026-04-07 09:30:00','收盘价（元）':'11.13'};
  for(const minute of ['2026-04-08 09:30:00','2026-04-07 09:30:01','2026-04-07 24:00:00',''])
    assert.throws(()=>resolve([{...row,'分钟时间':minute}]),/分钟/);
  for(const [date,minute] of [['20241103','2024-11-03 01:30:00'],['20240310','2024-03-10 02:30:00']])
    assert.throws(()=>resolve([{...row,'交易日期':date,'分钟时间':minute}],{answers:{source_trade_date_timezone:'America/New_York'}}),/唯一|明确时间映射/);
});
test('adjacent reports reuse verified composite keys, with concrete gaps for an inapplicable registered key', () => {
  const early=resolve([{...first,'机构名称':'甲机构'},{...first,'机构名称':'乙机构'}],{answers:{source_key_columns:'["对象代码","机构名称"]'}}).result.proposal!;
  const laterRow={...first,'交易日期':'20260101','机构名称':'甲机构'};
  const unresolved=resolve([laterRow],{answers:{source_trade_date_timezone:''}}).result;
  assert.equal(unresolved.sourceFamilyHint!.semanticCode,early.target.outputKey);
  const later=resolve([laterRow],{registeredKeyColumns:early.sourceProjection!.keyColumns}).result;
  assert.deepEqual(later.questions,[]);
  assert.equal(later.proposal!.target.outputKey,early.target.outputKey);
  assert.deepEqual(later.proposal!.sourceProjection!.keyColumns,early.sourceProjection!.keyColumns);
  assert.equal(later.evidence.find(fact=>fact.key==='source_key_columns')?.origin,'contract');
  assert.equal(later.evidence.find(fact=>fact.key==='key_column')?.origin,'file');
  for (const [rows,pattern] of [
    [[first],/缺失/], [[{...laterRow,'机构名称':''}],/含空值/], [[laterRow,laterRow],/不唯一/],
  ] as const) {
    const failed=resolve([...rows],{registeredKeyColumns:early.sourceProjection!.keyColumns}).result;
    assert.equal(failed.proposal,undefined);
    assert.match(failed.questions.find(question=>question.key==='source_key_columns')!.label,pattern);
    assert.equal(failed.sourceFamilyHint!.semanticCode,early.target.outputKey);
  }
});
test('source identifiers and non-unit parentheses stay distinct from measured values and registered units', () => {
  const column='未写单位数值';
  const code=sourceReportedCode('src_',column)!;
  const rows=[{...first,'TS代码':'600000.SH','备用代码':'600000',[column]:'12.5','分类（A）':'一般','提供方备注（THS）':''}];
  assert.deepEqual(resolve(rows).result.questions.map(question=>question.key),['unit.'+column]);
  const trusted=resolve(rows,{registeredUnits:{[code]:'srcunit_54K5'}}).result;
  assert.deepEqual(trusted.questions,[]);
  assert.equal(trusted.evidence.find(fact=>fact.key==='unit.'+column)?.origin,'contract');
  const definitions=trusted.proposal!.target.definition.field_definitions as {field_code:string;data_type:string;unit_code:string}[];
  assert.equal(definitions.find(field=>field.field_code===sourceReportedCode('src_','备用代码'))!.data_type,'text');
  assert.equal(definitions.find(field=>field.field_code===sourceReportedCode('src_','提供方备注（THS）'))!.unit_code,'not_applicable');
  assert.deepEqual(resolve([{...first,'数值（DC）':'7.5'}]).result.questions.map(question=>question.key),['unit.数值（DC）']);
  assert.deepEqual(resolve([{...first,[column]:''}],{registeredUnits:{[code]:'srcunit_54K5'},registeredTypes:{[code]:'decimal'}}).result.questions,[]);
  const explicitCode=sourceReportedCode('src_','原报金额（亿元）')!;
  const explicit=resolve([first],{registeredUnits:{[explicitCode]:'cny'}}).result;
  assert.equal(explicit.evidence.find(fact=>fact.key==='unit.原报金额（亿元）')?.origin,'file');
  assert.equal(explicit.evidence.find(fact=>fact.key==='unit.原报金额（亿元）')?.value,'srcunit_5Lq_5YWD');
});
test('empty or mixed unknown columns ask for a real type and can reuse a scoped registered type', () => {
  const column='原报TTM',code=sourceReportedCode('src_',column)!;
  const blank=resolve([{...first,[column]:''}]).result;
  assert.deepEqual(blank.questions.map(question=>question.key),['type.'+column]);
  assert.ok(blank.sourceFamilyHint);
  const known=resolve([{...first,[column]:''}],{registeredTypes:{[code]:'decimal'},registeredUnits:{[code]:'ratio'}}).result;
  assert.deepEqual(known.questions,[]);
  assert.equal(known.evidence.find(fact=>fact.key==='type.'+column)?.origin,'contract');
  assert.equal(known.evidence.find(fact=>fact.key==='unit.'+column)?.origin,'contract');
  const mixed=[{...first,[column]:'1.25'},{...first,'对象代码':'A02',[column]:'--'}];
  assert.deepEqual(resolve(mixed).result.questions.map(question=>question.key),['type.'+column]);
  assert.deepEqual(resolve(mixed,{registeredTypes:{[code]:'decimal'},registeredUnits:{[code]:'ratio'}}).result.questions.map(question=>question.key),['type.'+column]);
  const literal=resolve(mixed,{answers:{['type.'+column]:'text'}}).result;
  assert.deepEqual(literal.questions,[]);
  assert.equal(literal.evidence.find(fact=>fact.key==='type.'+column)?.origin,'operator');
  assert.throws(()=>resolve(mixed,{answers:{['type.'+column]:'decimal',['unit.'+column]:'ratio'}}),/非数值原报/);
});
test('common date partition directories retain the actual parent source series', () => {
  const left=resolve([first],{series:'具体系列甲/按交易日'}).result;
  const right=resolve([first],{series:'具体系列乙/按交易日'}).result;
  assert.equal(left.evidence.find(fact=>fact.key==='source_series')?.value,'具体系列甲 / 按交易日');
  assert.equal(right.evidence.find(fact=>fact.key==='source_series')?.value,'具体系列乙 / 按交易日');
  assert.notEqual(left.sourceFamilyHint!.semanticCode,right.sourceFamilyHint!.semanticCode);
});
test('source row labels keep leading zeros without becoming business keys, and literal share/person units stay unchanged', () => {
  const {original,result}=resolve([{...first,'序号':'0003','流通数量（万股）':'13.9700','职员数量（人）':'17'}]);
  assert.deepEqual(result.questions,[]);
  assert.equal(result.proposal!.sourceProjection!.keyColumns.includes('序号'),false);
  const definitions=result.proposal!.target.definition.field_definitions as {field_code:string;data_type:string;unit_code:string}[];
  const label=definitions.find(field=>field.field_code===sourceReportedCode('src_','序号'))!;
  assert.deepEqual([label.data_type,label.unit_code],['text','not_applicable']);
  for (const [column,unit] of [['流通数量（万股）','万股'],['职员数量（人）','人']])
    assert.equal(definitions.find(field=>field.field_code===sourceReportedCode('src_',column!))!.unit_code,sourceReportedCode('srcunit_',unit!));
  const out=prepareCandidateTable(original,{materialId:'source-test',format:'json',sourceProjection:result.proposal!.sourceProjection,types:result.proposal!.types});
  assert.equal(out.rows[0]!['序号'],'0003');
  assert.deepEqual(resolve([{...first,'序号':'0003'}],{answers:{source_key_columns:'["序号"]'}}).result.questions.map(question=>question.key),['source_key_columns']);
  assert.deepEqual(resolve([{...first,'序号':'0003'}],{registeredKeyColumns:['交易日期','序号']}).result.questions.map(question=>question.key),['source_key_columns']);
  for (const suffix of ['亿','元或个','上海','TTM'])
    assert.deepEqual(resolve([{...first,[`原值（${suffix}）`]:'13.97'}]).result.questions.map(question=>question.key),[`unit.原值（${suffix}）`]);
});
test('source semantics fix date, claim, coverage and field qualifications without guessing financial facts', () => {
  const result=resolve([{...first,'收盘价（元）':'13.97','涨跌额（元）':'0.12','涨跌幅（%）':'0.87',
    '换手率（%）':'1.2','今日主力净流入 净额（元）':'12.3','炸板次数':'2','原因描述':'来源解释'}]).result;
  assert.deepEqual(result.questions,[]);
  const definition=result.proposal!.target.definition,context=definition.semantic_context as WfdRecord;
  assert.deepEqual(context.content,{assertion_status:'source_reported_unverified'});
  assert.deepEqual(context.measurement,{value_states:['valid_value','unknown']});
  assert.deepEqual(context.coverage_quality,{completeness:'partial',absence_means:'unknown'});
  assert.deepEqual((context.time as WfdRecord).roles,{business_date:'source_reported_trade_date_label',
    business_interval:'calendar_date_label_not_trading_session',public_time:'unknown'});
  assert.equal(context.financial,undefined);
  assert.equal(result.proposal!.mapping.bar,undefined);
  const fields=definition.field_semantic_context as Record<string,WfdRecord>;
  for (const [column,kind] of [['收盘价（元）','source_reported_price_label'],['涨跌额（元）','source_reported_price_change_label'],
    ['涨跌幅（%）','source_reported_return_label'],['换手率（%）','source_reported_turnover_label'],
    ['今日主力净流入 净额（元）','source_reported_fund_flow_label'],['炸板次数','source_reported_limit_process_label'],
    ['原因描述','source_reported_interpretation']]) {
    assert.deepEqual(fields[sourceReportedCode('src_',column!)!]!.content,{assertion_status:kind});
    const fact=result.evidence.find(fact=>fact.key==='source_semantics.'+column)!;
    assert.equal(fact.origin,'file'); assert.equal(fact.column,column);
    const qualification=JSON.parse(fact.value);
    assert.equal(qualification.rules_version,'bd.source-reported-semantics/1');
    assert.equal(qualification.assertion_status,kind);
    assert.ok(qualification.unknown.length>0);
  }
  assert.ok(JSON.parse(result.evidence.find(fact=>fact.key==='source_semantics.收盘价（元）')!.value).unknown.includes('price_adjustment'));
  assert.ok(JSON.parse(result.evidence.find(fact=>fact.key==='source_semantics.今日主力净流入 净额（元）')!.value).unknown.includes('fund_flow_method'));
  assert.ok(JSON.parse(result.evidence.find(fact=>fact.key==='source_semantics.炸板次数')!.value).unknown.includes('intraday_reconstruction'));
});
test('registered source contracts retain their known scope while only new fields adopt new qualifications', () => {
  const initial=resolve([first]).result.proposal!;
  const legacy=structuredClone(initial.target.definition);
  delete legacy.field_semantic_context;
  const context=legacy.semantic_context as WfdRecord;
  delete context.content; delete context.measurement; delete context.coverage_quality;
  (context.time as WfdRecord).roles={business_date:'source_reported_trade_date_label'};
  const later=resolve([{...first,'交易日期':'20260101'}],{registeredSourceDefinition:legacy}).result;
  assert.deepEqual(later.questions,[]);
  assert.deepEqual(later.proposal!.target.definition,legacy);
  assert.equal(later.proposal!.target.outputKey,initial.target.outputKey);
  const newer=resolve([{...first,'交易日期':'20260102','新观察次数':'2'}],{registeredSourceDefinition:legacy}).result;
  assert.deepEqual(newer.questions,[]);
  assert.deepEqual(newer.proposal!.target.definition.semantic_context,legacy.semantic_context);
  assert.deepEqual(Object.keys(newer.proposal!.target.definition.field_semantic_context as WfdRecord),[sourceReportedCode('src_','新观察次数')]);
  assert.equal(newer.evidence.find(fact=>fact.key==='source_semantics_contract')?.origin,'contract');
  assert.equal(JSON.parse(newer.evidence.find(fact=>fact.key==='source_semantics_contract')!.value).disposition,'retain_registered_scope');
});

test('an operator-confirmed source profile maps a verified header alias and blocks ambiguous duplicate columns', () => {
  const profile = readSourceFieldProfile({
    version: 'bd.source-field-profile/1', mappingVersion: 1,
    profileId: 'synthetic-series-1', sourceId: 'same-provider-export', series: '原报指标系列',
    fields: [
      { originalHeader: '交易日期', fieldCode: 'trade_date', dataType: 'text', unitCode: 'date', role: 'date' },
      { originalHeader: '对象代码', fieldCode: 'object_code', dataType: 'text', unitCode: 'not_applicable', role: 'identity' },
      { originalHeader: '原报金额（亿元）', aliases: ['当前金额'], fieldCode: 'amount_cny_100million',
        dataType: 'decimal', unitCode: 'cny_100million', role: 'value', measurement: '报告期金额，单位亿元' },
    ],
    frequency: 'day', timeBucket: { labelSemantics: 'start', interval: 'closed_open',
      lengthMinutes: 1440, timezone: 'Asia/Shanghai' },
    adjustment: { status: 'raw' },
    confirmation: { status: 'operator_confirmed', basis: '仅供回归验证的合成来源字段样例',
      confirmedAtUtc: '2026-11-13T00:00:00Z' },
  }, 'synthetic-profile.json');
  const frozen = { profile, digest: sourceFieldProfileDigest(profile), fingerprint: profileFingerprint(profile) };
  const incoming = { '交易日期': '20251215', '对象代码': 'A01', '当前金额': '13.9700' };
  const result = resolve([incoming], { sourceFieldProfile: frozen, sourceValueColumns: ['当前金额'] }).result;
  assert.deepEqual(result.questions, [], JSON.stringify(result.questions));
  assert.deepEqual(result.proposal?.mapping.fields.map(field => [field.value, field.fieldCode]), [
    ['交易日期', 'trade_date'], ['对象代码', 'object_code'], ['当前金额', 'amount_cny_100million'],
  ]);
  assert.equal(result.evidence.find(fact => fact.key === 'unit.当前金额')?.origin, 'contract');
  assert.equal(result.evidence.find(fact => fact.key === 'source_measurement.当前金额')?.value, '报告期金额，单位亿元');
  assert.throws(() => resolve([{ ...incoming, '原报金额（亿元）': '13.9700' }], {
    sourceFieldProfile: frozen, sourceValueColumns: ['当前金额'],
  }), /同义原表头/);
});
