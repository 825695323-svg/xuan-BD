import assert from 'node:assert/strict';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { inspectMaterial } from './data-processing/material-inspector/index.js';
import { resolveR1Evidence } from './r1-evidence.js';
import type { MaterialEnvelope } from './materials/contracts.js';

const row = { business_key: 'sample-1', start_utc: '2023-11-01T00:00:00Z', end_utc: '2023-11-02T00:00:00Z',
  reading: '13.97', value_state: 'valid_value', 'bd.semantic_code': 'example.flow_count', 'bd.subject_id': 'sample-plant',
  'bd.subject_kind': 'entity', 'bd.period_type': 'natural', 'bd.frequency': 'day', 'bd.precision': 'day', 'bd.timezone': 'UTC',
  'bd.type.reading': 'decimal', 'bd.unit.reading': 'count', 'bd.measurement.reading': 'flow' };
function resolve(rows: Record<string, unknown>[], answers: Record<string,string> = {}) {
  const original = Buffer.from(JSON.stringify(rows));
  const envelope: MaterialEnvelope = { materialId:'test-material',taskId:'test-task',category:'data',environment:'synthetic-test',
    filename:'observations.json',mediaType:'application/json',byteLength:original.length,sha256:wfdSha256(original),
    version:1,fileRefId:'test-file',fileRefVersion:1,inspectorVersion:'1',adapter:null,createdAt:0,localOnly:true };
  const preview = inspectMaterial(original, { category:'data',filename:envelope.filename,mediaType:envelope.mediaType });
  return resolveR1Evidence({ original, material:{envelope,preview}, answers, namespace:'lab',datasetId:'test-data', parentSnapshotId:null });
}
test('automatic admission maps only declared values, preserving source evidence without asserting historical availability', () => {
  const result = resolve([row]);
  assert.deepEqual(result.questions, []);
  assert.equal(result.proposal?.target.definition.semantic_code, row['bd.semantic_code']);
  assert.deepEqual(result.proposal?.mapping.fields, [{fieldCode:'reading',value:'reading',state:'value_state'}]);
  assert.equal(result.proposal?.mapping.publicTime, undefined);
  assert.deepEqual(result.evidence.find(e => e.key === 'unit.reading'), {key:'unit.reading',value:'count',origin:'file',column:'bd.unit.reading'});
});
test('one unresolved source unit asks one question and keeps the original row for resubmission', () => {
  const incomplete = { ...row, 'bd.unit.reading':'unknown' };
  assert.deepEqual(resolve([incomplete]).questions.map(q=>q.key), ['unit.reading']);
  assert.equal(resolve([incomplete]).proposal, undefined);
  const filled = resolve([incomplete], {'unit.reading':'count'});
  assert.equal(filled.questions.length,0);
  assert.equal(filled.evidence.find(e=>e.key==='unit.reading')?.origin, 'operator');
});
test('a later contradictory row or answer cannot silently overwrite the admitted scope', () => {
  assert.throws(()=>resolve([row,{ ...row, business_key:'sample-2', 'bd.unit.reading':'percent' }]), /逐行不一致/);
  assert.throws(()=>resolve([row],{'unit.reading':'percent'}), /冲突/);
  assert.throws(()=>resolve([{...row,'bd.connection':'production'}]), /不支持来源声明/);
});
test('a native self-describing source table can introduce an unfamiliar metric without BD-prefixed columns', () => {
  const result = resolve([{ business_key:'report-9', start_utc:row.start_utc, end_utc:row.end_utc,
    semantic_code:'facility.temperature_count', subject_kind:'entity',subject_id:'facility-33',frequency:'day',
    period_type:'natural', precision:'day', timezone:'UTC', field_code:'sample_count',data_type:'integer',
    unit_code:'count',measurement_nature:'flow',value:'26',value_state:'valid_value'}]);
  assert.deepEqual(result.questions, []);
  assert.equal(result.proposal?.target.definition.semantic_code, 'facility.temperature_count');
  assert.deepEqual(result.proposal?.mapping.fields, [{fieldCode:'sample_count',value:'value',state:'value_state'}]);
});
test('empty cells become null only when their explicit state permits the column rule', () => {
  assert.deepEqual(resolve([row, { ...row, business_key:'missing-row',value_state:'unknown',reading:'' }]).proposal?.emptyToNull, ['reading']);
  const validEmpty = { ...row, reading:'', 'bd.type.reading':'text','bd.unit.reading':'not_applicable' };
  assert.equal(resolve([validEmpty]).proposal?.emptyToNull, undefined);
  assert.throws(() => resolve([validEmpty,{ ...validEmpty, business_key:'missing',value_state:'unknown' }]), /有效空字符串/);
});
