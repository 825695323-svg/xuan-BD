import assert from 'node:assert/strict';
import test from 'node:test';
import { annotateCandidateTable, CANDIDATE_LIMITS, parseTableSource, structureCandidateTable } from './candidate-pipeline.js';

test('annotation enforces one field budget across original, constant and dictionary columns', () => {
  const limit = CANDIDATE_LIMITS.maxFields;
  const makeTable = (count: number) => {
    const header = Array.from({ length: count }, (_, index) => `source_${index}`).join(',');
    const row = Array.from({ length: count }, () => 'synthetic').join(',');
    return structureCandidateTable(parseTableSource(Buffer.from(`${header}\n${row}\n`), { materialId: 'synthetic-wide', format: 'csv' }));
  };
  const mapping = { code: { sourceColumn: 'source_0', dictionaryId: 'synthetic-terms', version: '1', entries: { synthetic: 'S' } } };
  const annotations = { source_batch: 'synthetic' }, full = makeTable(limit);
  assert.throws(() => annotateCandidateTable(full, {}, mapping), { code: 'CANDIDATE_FIELDS_LIMIT' });
  assert.throws(() => annotateCandidateTable(full, annotations), { code: 'CANDIDATE_FIELDS_LIMIT' });
  const almostFull = makeTable(limit - 1);
  assert.throws(() => annotateCandidateTable(almostFull, annotations, mapping), { code: 'CANDIDATE_FIELDS_LIMIT' });
  assert.equal(annotateCandidateTable(almostFull, {}, mapping).fields.length, limit);
  const annotated = annotateCandidateTable(makeTable(limit - 2), annotations, mapping);
  assert.equal(annotated.fields.length, limit);
  assert.deepEqual(annotated.fields.slice(-2), ['code', 'source_batch']);
  assert.equal(annotated.rows[0]?.at(-1)?.value, 'S');
});
