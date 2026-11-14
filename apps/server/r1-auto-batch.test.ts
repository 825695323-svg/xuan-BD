import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1BatchFile, R1BatchStartInput, R1BatchView } from '../../modules/collection/r1-auto-batch.js';
import type { R1AutoView } from '../../modules/collection/r1-auto.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { WfdProductMachineError } from '../../adapters/database/wfd-product-machine.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const source: R1BatchStartInput['source'] = { source_id: 'batch-synthetic', provider: 'isolated-fixture',
  requested_url: 'file:///explicit-isolated-source/observations', requested_at_utc: '2026-01-02T00:00:00Z',
  acquired_at_utc: '2026-01-04T00:01:00Z', usage_scope: 'isolated multi-file automatic acceptance',
  authorization: { status: 'authorized', basis: 'operator selected these synthetic originals for isolated batch admission' } };
function raw(key: string, missingUnit = false): Buffer {
  const columns = ['business_key', 'start_utc', 'end_utc', 'value_state', 'reading', 'bd.semantic_code',
    'bd.subject_kind', 'bd.subject_id', 'bd.frequency', 'bd.precision', 'bd.timezone', 'bd.period_type',
    'bd.type.reading', ...(!missingUnit ? ['bd.unit.reading'] : []), 'bd.measurement.reading'];
  const row = [key, '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', 'valid_value', '12.30',
    'generic.source.report', 'physical_object', 'item_1', 'day', 'day', 'UTC', 'natural', 'decimal', ...(!missingUnit ? ['count'] : []), 'stock'];
  return Buffer.from(columns.join(',') + '\n' + row.join(',') + '\n');
}
function manifest(name: string, bytes: Buffer): R1BatchFile { return { name, relativePath: name, sha256: wfdSha256(bytes), byteLength: bytes.length }; }
async function readUntil(host: FullChainHost, id: string, predicate: (view: R1BatchView) => boolean): Promise<R1BatchView> {
  for (let tries = 0; tries < 2400; tries++) {
    const view = await host.call(`/r1/batches/${id}`) as R1BatchView;
    if (predicate(view)) return view;
    if (view.error) assert.fail(JSON.stringify(view));
    await delay(25);
  }
  assert.fail('Batch did not reach expected state: ' + JSON.stringify(await host.call(`/r1/batches/${id}`)));
}
async function upload(host: FullChainHost, batchId: string, itemId: string, bytes: Buffer, expected = 202): Promise<R1BatchView> {
  const response = await fetch(`${host.base}/r1/batches/${batchId}/items/${itemId}/upload`, { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web' }, body: new Uint8Array(bytes) });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value as R1BatchView;
}
function associations(item: R1BatchView['items'][number]): WfdRecord[] { return item.auto?.currentRequest?.local.associations as WfdRecord[] ?? []; }
function proof(host: FullChainHost, result: unknown) { writeFileSync(join(host.fixture.root, 'batch-verification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); }

test('batch intake preserves sequential custody, duplicate identities, per-file returns, and pending answers across restart', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-batch-sequence', machine: true });
  let host = await openFullChainHost(fixture);
  try {
    const gap = raw('pending', true), good = raw('known'), unsupported = Buffer.from('an original without a supported table'), last = raw('last');
    const input: R1BatchStartInput = { batchId: 'batch-sequence', source, datasetId: 'batch_observations',
      files: [manifest('pending.csv', gap), manifest('known.csv', good), manifest('known.csv', good), manifest('unsupported.txt', unsupported), manifest('last.csv', last)] };
    const start = await host.call('/r1/batches/start', input, 202) as R1BatchView;
    assert.equal(start.nextUploadItemId, 'item-1');
    assert.equal(start.items[0]!.requestedUrl, 'file:///explicit-isolated-source/observations/pending.csv');
    assert.equal(start.items[0]!.materialId, null);
    const outOfOrder = await upload(host, input.batchId, 'item-2', good, 409) as unknown as { code: string };
    assert.equal(outOfOrder.code, 'R1_BATCH_ORDER');
    const changed = await upload(host, input.batchId, 'item-1', Buffer.from('different'), 409) as unknown as { code: string };
    assert.equal(changed.code, 'R1_BATCH_FILE_CHANGED');
    await upload(host, input.batchId, 'item-1', gap);
    const pending = await readUntil(host, input.batchId, view => view.items[0]!.state === 'awaiting_answers');
    assert.equal(pending.nextUploadItemId, 'item-2');
    assert.deepEqual(pending.items[0]!.auto!.questions.map(question => question.key), ['unit.reading']);
    await upload(host, input.batchId, 'item-2', good);
    const second = await readUntil(host, input.batchId, view => view.items[1]!.state === 'associated');
    assert.equal(second.items[2]!.state, 'associated');
    assert.deepEqual(second.items[2]!.duplicateOf, { batchId: input.batchId, itemId: 'item-2' });
    assert.equal(second.items[2]!.materialId, second.items[1]!.materialId);
    assert.equal(second.items[2]!.autoRequestId, second.items[1]!.autoRequestId);
    assert.equal(second.nextUploadItemId, 'item-4');
    await upload(host, input.batchId, 'item-4', unsupported);
    const returned = await readUntil(host, input.batchId, view => view.items[3]!.state === 'blocked');
    assert.ok(returned.items[3]!.error); assert.equal(returned.nextUploadItemId, 'item-5');
    await upload(host, input.batchId, 'item-5', last);
    const beforeRestart = await readUntil(host, input.batchId, view => view.items[4]!.state === 'associated');
    assert.equal(beforeRestart.items[4]!.auto!.parentSnapshotId, associations(second.items[1]!)[0]!.snapshot_id);
    const tasksBefore = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n;
    await host.close(); host = await openFullChainHost(fixture);
    const restarted = await host.call(`/r1/batches/${input.batchId}`) as R1BatchView;
    assert.equal(restarted.items[0]!.state, 'awaiting_answers');
    assert.equal(restarted.items[3]!.error!.code, returned.items[3]!.error!.code);
    await host.call(`/r1/auto/${restarted.items[0]!.autoRequestId}/answers`, { answers: { 'unit.reading': 'count' } }, 202);
    const final = await readUntil(host, input.batchId, view => view.items[0]!.state === 'associated');
    assert.equal(final.items[0]!.auto!.parentSnapshotId, associations(beforeRestart.items[4]!)[0]!.snapshot_id,
      'Pending evidence resumes from the active head after unrelated files have published');
    assert.equal(final.items[0]!.auto!.source.source_id, source.source_id);
    assert.equal(final.items[0]!.auto!.source.provider, source.provider);
    assert.equal(final.state, 'blocked');
    assert.deepEqual(final.items.map(item => item.state), ['associated', 'associated', 'associated', 'blocked', 'associated']);
    assert.equal(final.items[3]!.error?.code, returned.items[3]!.error?.code);
    assert.deepEqual(host.services.materials!.readOriginal(final.items[0]!.materialId!).bytes, gap);
    const tasksAfter = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n;
    assert.ok(Number(tasksAfter) > Number(tasksBefore));
    const repeated = await host.call('/r1/batches/start', input, 202) as R1BatchView;
    assert.equal(repeated.batchId, input.batchId); assert.equal(repeated.duplicateBatch, true);
    const alias = await host.call('/r1/batches/start', { ...input, batchId: 'batch-identical-alias' }, 202) as R1BatchView;
    assert.equal(alias.batchId, input.batchId); assert.equal(alias.duplicateBatch, true);
    // 规范批次身份随响应返回；重试不会为了被忽略的请求编号无限写入别名。
    const aliases = host.database.connection.prepare('SELECT COUNT(*) AS count FROM r1_auto_batch_aliases').get() as { count: number };
    assert.equal(aliases.count, 0, '新批次重复请求不产生永久别名记录');
    await upload(host, input.batchId, 'item-2', good);
    await host.call(`/r1/batches/${input.batchId}/advance`, {});
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n, tasksAfter);
    assert.equal((await host.call('/r1/batches/start', { ...input, datasetId: 'changed' }, 409)).code, 'R1_BATCH_CONFLICT');
    const subset = await host.call('/r1/batches/start', { ...input, batchId: 'batch-overlapping-subset', files: [input.files[1]!, input.files[4]!] }, 202) as R1BatchView;
    assert.deepEqual(subset.items[0]!.duplicateOf, { batchId: input.batchId, itemId: 'item-2' });
    assert.equal(subset.items[0]!.autoRequestId, final.items[1]!.autoRequestId);
    const newAcquisition = await host.call('/r1/batches/start', { ...input, batchId: 'batch-new-acquisition', files: [input.files[1]!],
      source: { ...source, acquired_at_utc: '2026-01-05T00:01:00Z' } }, 202) as R1BatchView;
    assert.equal(newAcquisition.items[0]!.duplicateOf, null, 'Different declared acquisition times remain separate acquisitions');
    const subdirectories = await host.call('/r1/batches/start', { ...input, batchId: 'batch-same-names-subdirectories',
      files: [{ ...manifest('same.csv', good), relativePath: 'series-a/same.csv' }, { ...manifest('same.csv', last), relativePath: 'series-b/same.csv' }] }, 202) as R1BatchView;
    assert.equal(subdirectories.items[0]!.requestedUrl, 'file:///explicit-isolated-source/observations/series-a/same.csv');
    assert.equal(subdirectories.items[1]!.requestedUrl, 'file:///explicit-isolated-source/observations/series-b/same.csv');
    assert.equal((await host.call('/r1/batches/start', { ...input, batchId: 'batch-conflicting-source-path',
      files: [manifest('same.csv', good), manifest('same.csv', last)] }, 409)).code, 'R1_BATCH_SOURCE_PATH_CONFLICT');
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n, tasksAfter);
    proof(host, { start, pending, second, returned, beforeRestart, final, alias, subset, newAcquisition, subdirectories, repeatedTasks: 0 });
  } finally { await host.close(); }
});

test('a completed material intake is recovered after its batch journal loses the custody reply', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-batch-custody-recovery', machine: true });
  let host = await openFullChainHost(fixture);
  try {
    const bytes = raw('custody-reply-lost'), input: R1BatchStartInput = { batchId: 'batch-custody-recovery', source,
      datasetId: 'batch_observations', files: [manifest('custody.csv', bytes)] };
    await host.call('/r1/batches/start', input, 202);
    const options = (host.services.r1Batches as unknown as { options: { accept(input: { bytes: Buffer; name: string; category: 'data'; requestId: string }): Promise<string> } }).options;
    const originalAccept = options.accept;
    options.accept = async value => {
      const taskId = await originalAccept(value); await host.settled(taskId);
      throw new TaskError('TEST_CUSTODY_REPLY_LOST', 'Actual material custody completed before the batch could bind its reply.');
    };
    try { await upload(host, input.batchId, 'item-1', bytes, 409); } finally { options.accept = originalAccept; }
    const tasksBefore = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n;
    await host.close(); host = await openFullChainHost(fixture);
    const result = await readUntil(host, input.batchId, view => view.items[0]!.state === 'associated');
    assert.deepEqual(host.services.materials!.readOriginal(result.items[0]!.materialId!).bytes, bytes);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM material_inputs').get()!.n, 1);
    assert.ok(Number(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n) > Number(tasksBefore));
    proof(host, { result, oneRealCustody: true });
  } finally { await host.close(); }
});

test('a batch freezes selected source columns and returns a missing-column item before unrelated valid files continue', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-batch-selected-columns', machine: true, units: { date: { dimension: 'date' } } });
  const host = await openFullChainHost(fixture);
  try {
    const missing = Buffer.from('交易日期,对象代码,别的说明,未核数值\n20251215,A01,原文,7.70\n');
    const known = Buffer.from('交易日期,对象代码,说明,未核数值\n20251216,A01,原文,7.70\n');
    const later = Buffer.from('交易日期,对象代码,说明,未核数值\n20251217,A01,后文,8.80\n');
    const input: R1BatchStartInput = { batchId: 'batch-selected-columns', source, datasetId: 'source_columns',
      files: [manifest('missing.csv', missing), manifest('known-columns.csv', known), manifest('later-columns.csv', later)],
      datePolicy: 'a_share_calendar_day_asia_shanghai', sourceValueColumns: ['说明'] };
    const start = await host.call('/r1/batches/start', input, 202) as R1BatchView;
    assert.deepEqual(start.sourceValueColumns, ['说明']);
    await upload(host, input.batchId, 'item-1', missing);
    const returned = await readUntil(host, input.batchId, view => view.items[0]!.state === 'blocked');
    assert.match(returned.items[0]!.error!.message, /原列|选列/);
    assert.equal(returned.nextUploadItemId, 'item-2');
    await upload(host, input.batchId, 'item-2', known);
    const second = await readUntil(host, input.batchId, view => ['associated', 'blocked', 'awaiting_answers'].includes(view.items[1]!.state)
      && !!view.items[1]!.policyAnswers.source_trade_date_timezone);
    assert.equal(second.items[1]!.state, 'associated', JSON.stringify(second.items[1]));
    await upload(host, input.batchId, 'item-3', later);
    const final = await readUntil(host, input.batchId, view => view.items[2]!.state === 'associated');
    const plan = host.services.processing!.get(final.items[2]!.auto!.planIds[0]!);
    const mapping = plan.outputs[0]!.target!.declaration!.mapping as WfdRecord;
    assert.deepEqual((mapping.fields as WfdRecord[]).map(field => field.value), ['交易日期', '对象代码', '说明']);
    assert.deepEqual(host.services.materials!.readOriginal(final.items[2]!.materialId!).bytes, later);
    assert.equal(final.items[2]!.auto!.parentSnapshotId, associations(second.items[1]!)[0]!.snapshot_id);
    const changed = await host.call('/r1/batches/start', { ...input, batchId: 'batch-different-columns', sourceValueColumns: ['未核数值'] }, 202) as R1BatchView;
    assert.equal(changed.items[1]!.duplicateOf, null, 'A different column scope cannot silently reuse the old projection');
    proof(host, { start, returned, second, final, changed });
  } finally { await host.close(); }
});

test('simultaneous batches serialize automatic publication and expose the queued original identity', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-batch-concurrent', machine: true });
  const host = await openFullChainHost(fixture);
  try {
    const one = raw('first-concurrent'), two = raw('second-concurrent');
    const inputs = [one, two].map((bytes, index): R1BatchStartInput => ({ batchId: `batch-concurrent-${index + 1}`, source,
      datasetId: 'batch_observations', files: [manifest(`concurrent-${index + 1}.csv`, bytes)] }));
    for (const input of inputs) await host.call('/r1/batches/start', input, 202);
    await Promise.all(inputs.map((input, index) => upload(host, input.batchId, 'item-1', [one, two][index]!)));
    let queued: R1AutoView | null = null;
    for (let tries = 0; tries < 400; tries++) {
      const views = await Promise.all(inputs.map(input => host.call(`/r1/batches/${input.batchId}`) as Promise<R1BatchView>));
      queued = views.map(view => view.items[0]!.auto).find(auto => auto?.waitingForRequestId) ?? null;
      if (queued || views.every(view => view.items[0]!.state === 'associated')) break;
      await delay(10);
    }
    assert.ok(queued, 'A second automatic request waits for the first fixed readback');
    assert.equal(queued.parentSnapshotId, null); assert.ok(queued.waitingReason);
    const results = await Promise.all(inputs.map(input => readUntil(host, input.batchId, view => view.items[0]!.state === 'associated')));
    const queuedItem = results.flatMap(view => view.items).find(item => item.autoRequestId === queued!.requestId)!;
    const preceding = results.flatMap(view => view.items).find(item => item.autoRequestId === queued!.waitingForRequestId)!;
    assert.equal(queuedItem.auto!.parentSnapshotId, associations(preceding)[0]!.snapshot_id);
    assert.equal(queuedItem.auto!.requestIds.length, 1); assert.equal(preceding.auto!.requestIds.length, 1);
    proof(host, { queued, results });
  } finally { await host.close(); }
});

test('batch date policy answers only the recognized source trade-date question within an explicit batch scope', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-batch-date-policy', machine: true });
  const host = await openFullChainHost(fixture);
  try {
    const trade = Buffer.from('交易日期,对象代码,金额（元）\n20251215,A01,13.9700\n');
    const report = Buffer.from('报告日期,对象代码,金额（元）\n20251215,A01,13.9700\n');
    const inputs: R1BatchStartInput[] = [
      { batchId: 'batch-date-without-scope', source, datasetId: 'raw_source', files: [manifest('trade.csv', trade)] },
      { batchId: 'batch-date-with-scope', source, datasetId: 'raw_source', files: [manifest('trade-scoped.csv', trade)], datePolicy: 'a_share_calendar_day_asia_shanghai' },
      { batchId: 'batch-date-generic', source, datasetId: 'raw_source', files: [manifest('report.csv', report)], datePolicy: 'a_share_calendar_day_asia_shanghai' },
    ];
    const results: R1BatchView[] = [];
    for (const [index, input] of inputs.entries()) {
      await host.call('/r1/batches/start', input, 202);
      await upload(host, input.batchId, 'item-1', index === 2 ? report : trade);
      results.push(await readUntil(host, input.batchId, view => ['awaiting_answers', 'blocked', 'associated'].includes(view.items[0]!.state)
        && (index !== 1 || !!view.items[0]!.policyAnswers.source_trade_date_timezone)));
    }
    assert.ok(results[0]!.items[0]!.auto!.questions.some(question => question.key === 'source_trade_date_timezone'));
    assert.deepEqual(results[0]!.items[0]!.policyAnswers, {});
    assert.deepEqual(results[1]!.items[0]!.policyAnswers, { source_trade_date_timezone: 'Asia/Shanghai' });
    assert.ok(!results[1]!.items[0]!.auto!.questions.some(question => question.key === 'source_trade_date_timezone'));
    assert.ok(results[2]!.items[0]!.auto!.questions.some(question => question.key === 'source_date_timezone'));
    assert.deepEqual(results[2]!.items[0]!.policyAnswers, {});
    proof(host, { results });
  } finally { await host.close(); }
});

test('actual registered-but-unpublished output rejection releases the batch without erasing registration or resubmitting', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-batch-registered-return', machine: true,
    units: { count: { dimension: 'date' }, good_count: { dimension: 'quantity' } } });
  let host = await openFullChainHost(fixture);
  try {
    const invalid = raw('incompatible-unit'), valid = Buffer.from(raw('unrelated-valid').toString().replaceAll(',count,', ',good_count,').replaceAll('generic.source.report', 'generic.source.other'));
    const input: R1BatchStartInput = { batchId: 'batch-registered-return', source, datasetId: 'batch_observations',
      files: [manifest('wrong-unit.csv', invalid), manifest('unrelated-valid.csv', valid)] };
    const client = host.services.r1Runtime!.client, actualSubmit = client.submit.bind(client); let sends = 0;
    let actualReply: WfdRecord | null = null;
    client.submit = async (...args) => { sends++; const reply = await actualSubmit(...args); actualReply = reply.result; return reply; };
    await host.call('/r1/batches/start', input, 202); await upload(host, input.batchId, 'item-1', invalid);
    const returned = await readUntil(host, input.batchId, view => view.items[0]!.state === 'blocked');
    assert.equal((actualReply as unknown as WfdRecord).state, 'rejected');
    assert.equal(returned.items[0]!.auto!.currentRequest!.state, 'rejected');
    assert.equal(returned.items[0]!.auto!.currentRequest!.requiresRecovery, false);
    assert.equal(returned.items[0]!.auto!.wfdRejection!.registration_preserved, true);
    assert.match(JSON.stringify(returned.items[0]!.error), /UNIT_DIMENSION_MISMATCH|WFD/);
    assert.equal(returned.nextUploadItemId, 'item-2'); assert.equal(associations(returned.items[0]!).length, 0);
    const receipt = returned.items[0]!.auto!.currentRequest!.local.receipt as WfdRecord;
    assert.equal(receipt.state, 'rejected');
    const registered = (receipt.output_results as WfdRecord[])[0]!;
    assert.equal(registered.registration_state, 'registered'); assert.equal(registered.publication_state, 'not_published');
    assert.ok(registered.product_id); assert.deepEqual(registered.records, []);
    assert.equal((registered.errors as WfdRecord[])[0]!.code, 'UNIT_DIMENSION_MISMATCH');
    assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, null);
    const request = returned.items[0]!.auto!.currentRequest!;
    await host.call(`/r1/requests/${request.requestId}/submit`, { confirmationDigest: request.documentSha256 }, 202);
    await host.call(`/r1/requests/${request.requestId}/recover`, { lookupId: 'original-registered-rejection' }, 202);
    assert.equal(sends, 1);
    await upload(host, input.batchId, 'item-2', valid);
    const final = await readUntil(host, input.batchId, view => view.items[1]!.state === 'associated');
    assert.equal(final.items[0]!.auto!.requestIds.length, 1); assert.equal(sends, 2);
    await host.close(); host = await openFullChainHost(fixture);
    const preserved = await host.call(`/r1/batches/${input.batchId}`) as R1BatchView;
    assert.equal(preserved.items[0]!.auto!.currentRequest!.state, 'rejected');
    assert.deepEqual(preserved.items[0]!.auto!.currentRequest!.local.receipt, receipt);
    proof(host, { actualReply, returned, final, preserved, invalidActualSubmits: 1 });
  } finally { await host.close(); }
});

test('lost actual registered rejection recovers by original status after restart and releases the next batch item', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-batch-registered-recovery', machine: true,
    units: { count: { dimension: 'date' }, good_count: { dimension: 'quantity' } } });
  let host = await openFullChainHost(fixture);
  try {
    const invalid = raw('lost-registered-return'), valid = Buffer.from(raw('next-after-recovery').toString().replaceAll(',count,', ',good_count,').replaceAll('generic.source.report', 'generic.source.next'));
    const input: R1BatchStartInput = { batchId: 'batch-registered-recovery', source, datasetId: 'batch_observations',
      files: [manifest('lost-return.csv', invalid), manifest('next.csv', valid)] };
    const client = host.services.r1Runtime!.client, actualSubmit = client.submit.bind(client); let sends = 0;
    let actualReply: WfdRecord | null = null;
    client.submit = async (...args) => {
      sends++; const reply = await actualSubmit(...args); actualReply = reply.result;
      assert.equal(reply.result.state, 'rejected');
      throw new WfdProductMachineError('TEST_REGISTERED_REPLY_LOST', 'Reply lost after actual registration and complete output rejection.',
        { operation: 'submit', requestId: input.batchId, mayHaveBeenAccepted: true });
    };
    client.requestStatusPage = async () => { throw new WfdProductMachineError('TEST_STATUS_UNAVAILABLE', 'Original status is temporarily unavailable.',
      { operation: 'request_status', requestId: input.batchId, mayHaveBeenAccepted: false }); };
    await host.call('/r1/batches/start', input, 202); await upload(host, input.batchId, 'item-1', invalid);
    const pending = await readUntil(host, input.batchId, view => view.items[0]!.state === 'recovering');
    assert.equal(pending.nextUploadItemId, null); assert.equal(sends, 1);
    await host.close(); host = await openFullChainHost(fixture);
    const returned = await readUntil(host, input.batchId, view => view.items[0]!.state === 'blocked');
    const request = returned.items[0]!.auto!.currentRequest!;
    assert.equal(request.state, 'rejected'); assert.equal(request.requiresRecovery, false);
    assert.equal(request.requestId, pending.items[0]!.auto!.currentRequest!.requestId);
    assert.equal(returned.items[0]!.auto!.wfdRejection!.registration_preserved, true);
    assert.equal(returned.nextUploadItemId, 'item-2'); assert.equal(associations(returned.items[0]!).length, 0);
    const receipt = request.local.receipt as WfdRecord;
    assert.equal(receipt.state, 'rejected'); assert.equal(receipt.outputs_complete, true);
    assert.equal((receipt.pagination as WfdRecord).detail, 'full');
    assert.equal(((receipt.output_results as WfdRecord[])[0]!.errors as WfdRecord[])[0]!.code, 'UNIT_DIMENSION_MISMATCH');
    await host.call(`/r1/requests/${request.requestId}/recover`, { lookupId: 'preserved-registered-failure' }, 202);
    await upload(host, input.batchId, 'item-2', valid);
    const final = await readUntil(host, input.batchId, view => view.items[1]!.state === 'associated');
    assert.equal(final.items[0]!.auto!.requestIds.length, 1);
    proof(host, { actualReply, pending, returned, final, lostOriginalActualSubmits: sends });
  } finally { await host.close(); }
});
