import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { WfdProductMachineReply } from '../../adapters/database/wfd-product-machine.js';
import type { TabularReadPage } from '../../contracts/tabular-batch.js';
import type { TabularBulkManifest } from './data-processing/tabular-bulk.js';
import { buildTabularBatchHeader, verifyTabularBatchReadback, verifyTabularBatchReceipt } from './r1-tabular-bulk-transport.js';
const sha = (value: unknown) => 'sha256:' + wfdSha256(canonicalWfdJson(value));
const fields = ['category', 'code', 'label'];
const cells = [['分类甲', 'A', '0.0'], ['分类甲', '中', null], ['分类甲', '😀', '末行']];
function fixture() {
  const contract = { version: 'wfd.tabular-contract/1', fields, key_fields: ['code'], partition_field: 'category', time: { kind: 'unknown' } };
  const target = { datasetId: 'isolated', outputKey: 'labels', expectedParentSnapshotId: null,
    subject: { kind: 'entity', namespace: 'local', id: 'labels' }, inputMode: 'partial_observation', coverage: { basis: 'observed_partial' },
    definition: { semantic_code: 'labels', semantic_context: { content_nature: 'source_claim' },
      field_definitions: fields.map(field_code => ({ field_code, data_type: 'text' })) } };
  const body = { version: 'bd.tabular-bulk/1', planDigest: sha('plan'), sourceSha256: sha('source'), sourceBytes: 120, materialId: 'material',
    headerRange: { sourceRow: 1, sourceLine: 1, startByte: 0, endByte: 20 }, evidenceRange: { startByte: 0, endByte: 120, sha256: sha('source') },
    target, fieldCodes: fields, partition: { value: '分类甲' }, tableContract: { ...contract, digest: sha(contract) },
    rowCount: cells.length, rowsDigest: 'sha256:' + createHash('sha256').update(cells.map(row => canonicalWfdJson(row) + '\n').join('')).digest('hex'),
    chunks: [cells.slice(0, 2), cells.slice(2)].map((rows, ordinal) => ({ chunk_id: `c${String(ordinal).padStart(6, '0')}`, ordinal, row_count: rows.length, digest: sha(rows) })),
    locatorDigests: [sha('loc1'), sha('loc2')], check: { quality: 'pass', standardMarketCalculation: false },
  };
  const manifest = { ...body, manifestDigest: sha(body) } as unknown as TabularBulkManifest;
  const header = buildTabularBatchHeader(manifest, { requestId: 'generic-one', namespace: 'local' });
  const product_id = 'p_' + 'b'.repeat(24), roles = ['algorithm_dependency', 'read_layout', 'semantic', 'update_release'];
  const contract_refs = Object.fromEntries(roles.map(role => [role, {
    id: 'contract_' + role + '_' + wfdSha256(canonicalWfdJson(['isolated', product_id, role])).slice(0, 24),
    version: 'v_' + sha(role).slice(7, 23), kind: 'contract', role, dataset_id: 'isolated', namespace: 'wfd.product',
    resolution: 'pinned', digest: sha(role), required: true, dependency_type: 'read',
  }]));
  const bundle = { format_version: 'wfd.contract-bundle/1.0', product_id, dataset_id: 'isolated', roles, contracts: contract_refs };
  const receipt: WfdRecord = { snapshot_id: 's_' + 'a'.repeat(24), product_id, partition: '分类甲', result_root: sha('root'),
    protocol_version: header.protocol_version, table_contract_digest: header.table_contract.digest,
    state: 'published_formal', formal_publication_verified: true,
    row_count: cells.length, rows_digest: manifest.rowsDigest, row_summary: { inserted: cells.length, duplicate_skipped: 0, conflict_pending: 0, pending_publication: 0 },
    partition_fingerprint: header.request_identity.submission_digest, output_key: target.outputKey, subject: target.subject, definition: target.definition,
    definition_ref: { kind: 'definition_version', dataset_id: 'isolated', namespace: 'wfd.product', id: 'def_' + sha(target.definition).slice(7, 31),
      version: 'v_' + sha(target.definition).slice(7, 23), digest: sha(target.definition), resolution: 'pinned', required: true, dependency_type: 'read' }, contract_refs,
    contract_bundle_ref: { id: 'cb_' + sha(bundle).slice(7, 31), version: 'v_' + sha(bundle).slice(7, 23), kind: 'contract_bundle', dataset_id: 'isolated',
      namespace: 'wfd.product', resolution: 'pinned', roles, digest: sha(bundle), required: true, dependency_type: 'read' },
  };
  function page(input: TabularReadPage, values = cells) {
    assert.equal(input.protocol_version, 'wfd.tabular-batch/1');
    const offset = input.cursor === null ? 0 : Number(input.cursor), end = Math.min(offset + Math.min(input.page_size, 1), values.length);
    return { ...receipt, rows: values.slice(offset, end).map((value, index) => {
      const business_key = 'tabular_' + wfdSha256(canonicalWfdJson(['分类甲', [value[1]]]));
      const row = { business_key, subject: target.subject, observation_time: { status: 'unknown' },
        values: Object.fromEntries(fields.map((code, i) => [code, { data_type: 'text', value_state: value[i] === null ? 'unknown' : 'valid_value', value: value[i] }])) };
      const record_version = 'r_' + wfdSha256(canonicalWfdJson([product_id, row, 'partial_observation', null,
        String(receipt.partition_fingerprint).slice(7), target.outputKey])).slice(0, 32);
      return { cells: value, record_id: business_key, record_version, row_index: offset + index };
    }), next_cursor: end < values.length ? String(end) : null };
  }
  return { manifest, header, receipt, page };
}
const reply = (result: WfdRecord) => ({ result } as WfdProductMachineReply);
test('three-column timeless data uses complete fixed readback with Unicode partition and UTF-8 key order', async () => {
  const f = fixture(), checkpoints: WfdRecord[] = [];
  const proof = await verifyTabularBatchReadback({ ...f, client: { tabularReadPage: async input => reply(f.page(input)) }, assertCurrent() {}, onCheckpoint(value) { checkpoints.push(value); } });
  assert.equal(proof.row_count, 3); assert.equal(proof.version, 'bd.tabular-association/1');
  assert.equal(proof.standard_market_calculation, false); assert.equal(proof.partition, '分类甲');
  assert.deepEqual(checkpoints.map(value => value.verifiedRows), [2, 3]);
  assert.deepEqual(checkpoints.at(-1)!.lastKey, ['😀']);
});
test('generic recovery resumes completed chunks and rejects another contract or protocol checkpoint', async () => {
  const f = fixture(), checkpoints: WfdRecord[] = []; let calls = 0;
  await assert.rejects(verifyTabularBatchReadback({ ...f, client: { tabularReadPage: async input => {
    if (++calls === 3) throw Error('interrupted'); return reply(f.page(input));
  } }, assertCurrent() {}, onCheckpoint(value) { checkpoints.push(value); } }), /interrupted/);
  assert.equal(checkpoints.length, 1);
  const cursors: (string | null)[] = [];
  await verifyTabularBatchReadback({ ...f, checkpoint: checkpoints[0], client: { tabularReadPage: async input => {
    cursors.push(input.cursor); return reply(f.page(input));
  } }, assertCurrent() {}, onCheckpoint() {} });
  assert.deepEqual(cursors, ['2']);
  const changed = { ...checkpoints[0], version: 'bd.source-minute-readback/1' };
  await assert.rejects(verifyTabularBatchReadback({ ...f, checkpoint: changed, client: { tabularReadPage: async input => reply(f.page(input)) }, assertCurrent() {}, onCheckpoint() {} }), /检查点/);
  f.receipt.protocol_version = 'wfd.source-minute-batch/1';
  assert.throws(() => verifyTabularBatchReceipt(f.header, f.manifest, f.receipt));
});
test('generic transport rejects altered contract, cross-partition rows, null keys and changed lexemes', async () => {
  const f = fixture();
  const changed = structuredClone(f.manifest); changed.tableContract.key_fields = ['label'];
  const { manifestDigest: _digest, ...body } = changed; changed.manifestDigest = sha(body);
  assert.throws(() => buildTabularBatchHeader(changed, { requestId: 'same', namespace: 'local' }));
  for (const mutate of [(row: (string | null)[]) => { row[0] = '分类乙'; }, (row: (string | null)[]) => { row[1] = null; }, (row: (string | null)[]) => { row[2] = '0'; }]) {
    const values = structuredClone(cells); mutate(values[0]!); let saved = 0;
    await assert.rejects(verifyTabularBatchReadback({ ...f, client: { tabularReadPage: async input => reply(f.page(input, values)) }, assertCurrent() {}, onCheckpoint() { saved++; } }));
    assert.equal(saved, 0);
  }
});
