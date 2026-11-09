import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WfdProductMachineError } from '../../adapters/database/wfd-product-machine.js';
import { canonicalWfdJson } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

type Json = Record<string, any>;
const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT && !!process.env.XUAN_MA_ORACLE;
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const code = (column: string) => 'src_' + Buffer.from(column).toString('base64url');
const units = { date: { dimension: 'date' },
  srcunit_5YWD: { dimension: 'number', authority: '来源原表头单位：元；不推导币种或复权口径' } };
const save = (root: string, name: string, value: unknown) => writeFileSync(join(root, name),
  JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

async function until(host: FullChainHost, batchId: string, predicate: (view: Json) => boolean) {
  for (let tries = 0; tries < 4800; tries++) {
    const view = await host.call('/r1/batches/' + batchId);
    if (predicate(view)) return view as Json;
    assert.ok(!view.error, JSON.stringify(view.error));
    assert.notEqual(view.calculation?.state, 'blocked', JSON.stringify(view.calculation?.error));
    const failed = view.items.find((item: Json) => item.state === 'blocked');
    assert.ok(!failed, JSON.stringify(failed?.error));
    await delay(25);
  }
  const pending = await host.call('/r1/batches/' + batchId);
  assert.fail('原均线批次未收束：' + JSON.stringify({ batchId, state: pending.state, error: pending.error,
    items: pending.items.map((item: Json) => ({ itemId: item.itemId, state: item.state, error: item.error })),
    calculation: { state: pending.calculation?.state, error: pending.calculation?.error } }));
}
async function uploadRemaining(host: FullChainHost, input: Json, files: Json[]) {
  for (let index = 0; index < files.length; index++) {
    const view = await until(host, input.batchId, value => !!value.nextUploadItemId);
    const item = view.items.find((item: Json) => item.itemId === view.nextUploadItemId);
    const file = files.find(file => file.relativePath === item.relativePath)!;
    const bytes = readFileSync(file.path);
    assert.equal(bytes.length, file.byteLength); assert.equal(sha(bytes), file.sha256);
    const response = await fetch(`${host.base}/r1/batches/${input.batchId}/items/${item.itemId}/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web' }, body: bytes });
    const accepted = await response.json(); assert.equal(response.status, 202, JSON.stringify(accepted));
  }
}
async function fixedRead(host: FullChainHost, snapshotId: string, productId: string) {
  const pages: Json[] = []; let cursor: string | undefined;
  do {
    const value = await host.call('/r1/products/read', { snapshotId, productId, ...(cursor ? { cursor } : {}) });
    assert.equal(value.result.snapshot_id, snapshotId); assert.equal(value.result.product_id, productId);
    pages.push(value.result); cursor = value.result.page.has_more ? value.result.page.next_cursor : undefined;
    assert.ok(!value.result.page.has_more || cursor);
  } while (cursor);
  return { pages, rows: pages.flatMap(page => page.rows) as Json[] };
}
function normalizedDecimal(value: string) {
  const number = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value); assert.ok(number, value);
  const whole = number[2]!.replace(/^0+(?=\d)/u, ''), fraction = (number[3] ?? '').replace(/0+$/u, '');
  return (whole === '0' && !fraction ? '' : number[1]) + whole + (fraction ? '.' + fraction : '');
}
/** The mean comes from the independent Fraction oracle; this only applies its declared output quantization. */
function oracleDecimal(value: { numerator: string; denominator: string }) {
  const numerator = BigInt(value.numerator), denominator = BigInt(value.denominator);
  const absolute = numerator < 0n ? -numerator : numerator, scaled = absolute * 100_000_000n;
  let integer = scaled / denominator;
  const twiceRemainder = scaled % denominator * 2n;
  if (twiceRemainder > denominator || twiceRemainder === denominator && integer % 2n !== 0n) integer++;
  const digits = integer.toString().padStart(9, '0');
  return normalizedDecimal((numerator < 0n ? '-' : '') + digits.slice(0, -8) + '.' + digits.slice(-8));
}
function verifyContracts(read: Awaited<ReturnType<typeof fixedRead>>) {
  for (const page of read.pages) {
    const product = page.product;
    assert.deepEqual(Object.keys(product.contract_role_refs).sort(), ['algorithm_dependency', 'read_layout', 'semantic', 'update_release']);
    for (const [role, ref] of Object.entries(product.contract_role_refs) as [string, Json][]) {
      assert.equal(ref.role, role); assert.equal(ref.resolution, 'pinned'); assert.match(ref.digest, /^sha256:[a-f0-9]{64}$/u);
    }
    assert.match(product.contract_bundle_ref.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(product.contract_bundle_ref.roles, ['algorithm_dependency', 'read_layout', 'semantic', 'update_release']);
  }
}
function verifySource(rows: Json[], oracle: Json) {
  assert.equal(rows.length, oracle.observations.length);
  const byKey = new Map(rows.map(row => [row.record_ref.logical_key, row])); let values = 0;
  for (const expected of oracle.observations) {
    const key = 'source_row_' + sha(JSON.stringify([expected.date, expected.symbol]));
    const row = byKey.get(key); assert.ok(row, '缺少原始业务键：' + key);
    for (const [column, raw] of [['交易日期', expected.date], ['股票代码', expected.symbol], ['股票名称', expected.name], ['收盘价（元）', expected.close]]) {
      const cell: Json = row.values[code(column)]; assert.ok(cell, column);
      assert.equal(cell.value_state, raw === '' ? 'unknown' : 'valid_value');
      if (column === '收盘价（元）') {
        assert.equal(cell.unit.unit_code, 'srcunit_5YWD');
        assert.equal(normalizedDecimal(cell.value), normalizedDecimal(raw));
      } else assert.equal(cell.value, raw);
      values++;
    }
    assert.equal(row.business_time.source_timezone, 'Asia/Shanghai');
    const iso = `${expected.date.slice(0,4)}-${expected.date.slice(4,6)}-${expected.date.slice(6,8)}`;
    assert.equal(Date.parse(row.business_time.earliest_utc), Date.parse(iso + 'T00:00:00+08:00'));
    assert.deepEqual(row.evidence_refs, []);
  }
  return { rows: rows.length, values };
}
function verifyOriginalProcessing(host: FullChainHost, view: Json, files: Json[]) {
  let cells = 0;
  for (const item of view.items) {
    const file = files.find(file => file.sha256 === item.sha256)!;
    assert.equal(item.state, 'associated', JSON.stringify(item.error));
    assert.equal(item.auto.currentRequest.local.associations.length, file.rows.length);
    const original = host.services.materials!.readOriginal(item.materialId).bytes;
    assert.equal(sha(original), file.sha256); assert.deepEqual(original, readFileSync(file.path));
    const plan = host.services.processing!.get(item.auto.planIds.at(-1)!);
    const parsed = JSON.parse(host.services.processing!.artifact(plan.planId, plan.steps.find(step => step.kind === 'parse')!.stepId).bytes.toString());
    assert.equal(parsed.source_sha256, file.sha256); assert.deepEqual(parsed.source_columns, file.sourceColumns);
    assert.equal(parsed.rows.length, file.rows.length);
    for (const [rowIndex, row] of file.rows.entries()) for (const [columnIndex, raw] of row.entries()) {
      assert.equal(parsed.rows[rowIndex][columnIndex].original, raw); cells++;
    }
  }
  return { originalFiles: view.items.length, originalCells: cells };
}
function verifyDerived(rows: Json[], oracle: Json) {
  assert.equal(rows.length, oracle.results.length);
  const byKey = new Map(rows.map(row => [row.record_ref.logical_key, row]));
  let valid = 0, warmup = 0;
  for (const expected of oracle.results) {
    const key = 'source_row_' + sha(JSON.stringify([expected.date, expected.symbol]));
    const row = byKey.get(key); assert.ok(row, `缺少派生键 ${expected.symbol}/${expected.date}`);
    const value = row.values.value, status = row.values.calculation_status;
    assert.equal(value.data_type, 'decimal'); assert.equal(value.unit.unit_code, 'srcunit_5YWD');
    assert.equal(value.value_state, expected.state);
    assert.equal(status.data_type, 'text'); assert.equal(status.value_state, 'valid_value');
    if (expected.state === 'valid_value') {
      assert.equal(normalizedDecimal(value.value), oracleDecimal(expected.value), `${expected.symbol}/${expected.date} 独立精确均值`);
      assert.equal(status.value, 'valid'); valid++;
    } else {
      assert.equal(value.value, null); assert.equal(status.value, 'warmup'); warmup++;
    }
    assert.equal(row.business_time.source_timezone, 'Asia/Shanghai');
    const iso = `${expected.date.slice(0,4)}-${expected.date.slice(4,6)}-${expected.date.slice(6,8)}`;
    assert.equal(Date.parse(row.business_time.earliest_utc), Date.parse(iso + 'T00:00:00+08:00'));
    assert.deepEqual(row.evidence_refs, []);
  }
  assert.deepEqual({ valid, warmup }, { valid: 9, warmup: 11 });
  return { rows: rows.length, valid, warmup, groups: oracle.summary.symbols };
}
function verifyDerivedDefinition(discovery: Json, productId: string) {
  const product = discovery.products.find((product: Json) => product.product_id === productId); assert.ok(product);
  const declaration = product.declaration, context = declaration.semantic_context;
  assert.equal(context.content_nature, 'deterministic_derived'); assert.equal(context.measurement_nature, 'derived');
  assert.equal(context.time.period_type, 'natural'); assert.equal(context.time.frequency, 'source_reported_day');
  assert.equal(context.time.interval, 'half_open'); assert.equal(context.time.timezone, 'Asia/Shanghai');
  const definition = declaration.algorithm_definition;
  assert.equal(definition.definition_version, '1.0.0');
  assert.deepEqual(definition.window, { type: 'observation_rows', count: 3, interval: 'closed', unit: 'selected_source_observations' });
  assert.deepEqual(definition.constants, { period: 3, output_scale: 8 });
  assert.match(definition.mathematical_definition, /sum\(x\[j\]/u);
  assert.match(definition.mathematical_definition, /no row dropping, filling, interpolation or cross-group windows/u);
  assert.match(definition.mathematical_definition, /round-half-to-even/u);
  assert.match(definition.result_semantics, /股票代码/u); assert.match(definition.result_semantics, /交易日期/u);
  assert.match(definition.result_semantics, /不证明交易日完整性、复权或历史公开资格/u);
  return { productId, definition, semanticContext: context };
}
function verifyProof(host: FullChainHost, completed: Json, oracle: Json) {
  const proof = host.services.r1Batches!.calculationEvidence(completed.batchId)!;
  assert.ok(proof);
  const persisted = host.database.connection.prepare('SELECT record_json FROM r1_auto_batches WHERE batch_id=?').get(completed.batchId)!;
  assert.deepEqual(JSON.parse(String(persisted.record_json)).calculation.proof, proof);
  const summary = completed.calculation.proof;
  assert.equal(summary.proofSha256, sha(canonicalWfdJson(proof)));
  assert.equal(summary.lineageSha256, sha(canonicalWfdJson(proof.lineage)));
  assert.equal(proof.codeDigest, sha(readFileSync(new URL('../../modules/collection/source-observation-ma.ts', import.meta.url))));
  assert.equal(proof.materialSha256, sha(host.services.materials!.readOriginal(completed.calculation.materialId).bytes));
  assert.equal(proof.windowKind, 'observation_rows'); assert.equal(proof.period, 3);
  assert.equal(proof.rounding, 'half_even'); assert.equal(proof.outputScale, 8);
  assert.equal(proof.inputScope, 'selected_batch_only'); assert.equal(proof.priceBasis, 'source_reported_unverified');
  assert.equal(proof.historicalAvailability, 'unknown');
  assert.deepEqual(proof.counts, { rows: 20, groups: 6, valid: 9, warmup: 11, windowMissing: 0 });
  assert.deepEqual(proof.groupColumns, ['股票代码']); assert.equal(proof.dateColumn, '交易日期');
  assert.equal(proof.sources.length, 5); assert.equal(proof.lineage.length, 20);
  for (const row of proof.lineage) {
    const source = proof.sources[row.sourceIndex]!;
    const item = completed.items.find((item: Json) => item.materialId === source.materialId); assert.ok(item);
    const expected = oracle.observations.find((entry: Json) => entry.sourceSha256 === source.materialSha256
      && entry.date === row.date.replaceAll('-', '') && entry.symbol === row.groupValues[0]); assert.ok(expected);
    assert.equal(row.sourceRow + 1, expected.sourceRow); assert.equal(row.inputValue, expected.close);
    assert.equal(source.productId, item.auto.currentRequest.local.associations[0].product_id);
    assert.equal(source.snapshotId, item.auto.currentRequest.local.associations[0].snapshot_id);
    assert.equal(source.requestId, item.auto.currentRequest.requestId);
    const ref = item.auto.currentRequest.local.associations.find((ref: Json) => ref.record_id === row.businessKey);
    assert.ok(ref); assert.equal(ref.record_version, row.recordVersion); assert.equal(ref.definition_digest, source.definitionDigest);
    const expectedWindow = oracle.results.find((entry: Json) => entry.date === expected.date && entry.symbol === expected.symbol).window;
    const actualWindow = proof.lineage.slice(row.windowStart, row.windowStart + row.windowCount);
    assert.deepEqual(actualWindow.map(entry => [entry.date.replaceAll('-', ''), entry.groupValues[0], entry.inputValue]),
      expectedWindow.map((entry: Json) => [entry.date, entry.symbol, entry.close]));
    assert.ok(actualWindow.every(entry => entry.groupValues[0] === expected.symbol), '窗口不能跨证券');
    assert.equal(row.location.line, expected.sourceRow);
    const originalText = readFileSync(expected.sourceFile, 'utf8').replace(/^\uFEFF/u, '');
    assert.equal(originalText.slice(row.location.start, row.location.end), expected.close);
  }
  return proof;
}

test('original grouped MA batch publishes separate source and calculated products, retains fixed readback and replays no publication',
  { skip: !enabled, timeout: 600_000 }, async () => {
  const oraclePath = process.env.XUAN_MA_ORACLE!, oracleBytes = readFileSync(oraclePath);
  const oracle = JSON.parse(oracleBytes.toString('utf8')) as Json;
  assert.equal(oracle.oracleVersion, 'independent-python-csv-fraction-ma/1');
  assert.deepEqual(oracle.summary, { files: 5, rows: 20, symbols: 6, validMeans: 9, warmupUnknowns: 11, sourceMissingCloses: 0 });
  const files = [...oracle.files].reverse() as Json[];
  const fixture = createFullChainFixture({ name: 'original-grouped-ma', machine: true, units });
  let host = await openFullChainHost(fixture);
  const stamp = new Date().toISOString();
  const input = { batchId: 'original-grouped-ma', datasetId: 'real_ma_observations',
    source: { source_id: 'user-selected-unchanged-daily-originals', provider: '余哈哈的数据仓库 原创整理',
      requested_url: pathToFileURL(oracle.sourceRoot + '/').href, requested_at_utc: stamp, acquired_at_utc: stamp,
      usage_scope: '真实原报及三观测均线同批隔离验收；来源价格口径维持原报，不认定复权或交易日完整覆盖',
      authorization: { status: 'authorized', basis: '用户明确授权本轮真实原包均线单项、原始及派生产品分别发布到全新隔离库' } },
    datePolicy: 'a_share_calendar_day_asia_shanghai', sourceValueColumns: oracle.sourceValueColumns,
    calculation: { method: 'source_observation_ma', period: 3, valueColumn: '收盘价（元）' },
    files: files.map(({ name, relativePath, sha256, byteLength }) => ({ name, relativePath, sha256, byteLength })) };
  const report: Json = { fixture, endpoint: host.base, oraclePath, oracleSha256: sha(oracleBytes), input, phases: [] };
  const submissions: Json[] = [];
  let derivedSends = 0, lostReply = false, extraSendsAfterReopen = 0;
  const client = host.services.r1Runtime!.client, actualSubmit = client.submit.bind(client);
  client.submit = async (document, signal) => {
    const derived = JSON.stringify(document).includes('"calculation_status"');
    const reply = await actualSubmit(document, signal);
    submissions.push({ derived, documentSha256: sha(JSON.stringify(document)), requestIdentity: document.request_identity, result: reply.result });
    if (derived) {
      derivedSends++; assert.equal(derivedSends, 1, '同一派生请求不应重复发送');
      save(fixture.root, 'actual-derived-submit-result.json', reply);
      assert.equal(reply.result.state, 'published_formal', JSON.stringify(reply.result));
      assert.equal(reply.result.formal_publication_verified, true);
      assert.ok(reply.result.snapshot_id);
      lostReply = true;
      throw new WfdProductMachineError('TEST_MA_REPLY_LOST', 'Actual derived publication completed before its reply was lost.',
        { operation: 'submit', requestId: input.batchId, mayHaveBeenAccepted: true });
    }
    return reply;
  };
  const actualStatus = client.requestStatusPage.bind(client);
  client.requestStatusPage = async (...args) => {
    if (lostReply) throw new WfdProductMachineError('TEST_MA_STATUS_UNAVAILABLE', 'Original status temporarily unavailable before host reopening.',
      { operation: 'request_status', requestId: input.batchId, mayHaveBeenAccepted: false });
    return actualStatus(...args);
  };
  save(fixture.root, 'run-context.json', report);
  try {
    const response = await fetch(host.base + '/r1/batches/start', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' }, body: JSON.stringify(input) });
    const started = await response.json(); report.started = { status: response.status, value: started };
    assert.equal(response.status, 202, JSON.stringify(started));
    await uploadRemaining(host, input, files);
    const pending = await until(host, input.batchId, view => view.calculation?.state === 'recovering');
    report.pendingAfterActualPublication = pending; report.submissions = submissions;
    save(fixture.root, 'lost-derived-reply.json', { pending, submissions });
    assert.equal(lostReply, true, '只有真实 published_formal 回执才可以进入本项断连恢复验收');
    assert.equal(derivedSends, 1); assert.equal(pending.nextUploadItemId, null);
    assert.ok(pending.items.every((item: Json) => item.state === 'associated'));
    const originalDerivedRequestId = pending.calculation.auto.currentRequest.requestId;
    const snapshotAfterPublication = (await host.call('/r1/products/snapshot', {})).snapshotId;
    await host.close(); host = await openFullChainHost(fixture);
    host.services.r1Runtime!.client.submit = async () => {
      extraSendsAfterReopen++;
      throw new Error('Recovered source/derived requests must query original status without submitting again');
    };
    const completed = await until(host, input.batchId, view => view.state === 'completed');
    report.completed = completed;
    assert.ok(completed.calculation, '同一批动作必须提供均线结果及原始/派生产品关联');
    assert.equal(completed.calculation.state, 'associated', JSON.stringify(completed.calculation));
    assert.equal(completed.calculation.auto.currentRequest.requestId, originalDerivedRequestId);
    assert.equal(completed.calculation.auto.requestIds.length, 1);
    assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, snapshotAfterPublication);
    report.originalProcessing = verifyOriginalProcessing(host, completed, files);
    const sourceProductIds = new Set(completed.items.flatMap((item: Json) => item.auto.currentRequest.local.associations.map((ref: Json) => ref.product_id)));
    assert.equal(sourceProductIds.size, 1);
    const sourceProductId = [...sourceProductIds][0] as string, calculation = completed.calculation;
    assert.notEqual(calculation.productId, sourceProductId);
    const sourceSnapshotId = completed.items.at(-1).auto.currentRequest.local.associations[0].snapshot_id;
    const sourceRead = await fixedRead(host, sourceSnapshotId, sourceProductId);
    const derivedRead = await fixedRead(host, calculation.snapshotId, calculation.productId);
    verifyContracts(sourceRead); verifyContracts(derivedRead);
    report.sourceReadback = verifySource(sourceRead.rows, oracle);
    report.productIdentities = { sourceProductId, sourceSnapshotId, derivedProductId: calculation.productId,
      derivedSnapshotId: calculation.snapshotId };
    report.derivedRows = derivedRead.rows.length;
    assert.equal(derivedRead.rows.length, oracle.results.length);
    report.independentDerivedReadback = verifyDerived(derivedRead.rows, oracle);
    save(fixture.root, 'actual-fixed-products.json', { source: sourceRead, derived: derivedRead });
    const discovery = await host.call('/r1/products/discover', { snapshotId: calculation.snapshotId });
    assert.equal(new Set(discovery.products.map((product: Json) => product.product_id)).size, 2);
    save(fixture.root, 'actual-fixed-discovery.json', discovery);
    report.derivedDefinition = verifyDerivedDefinition(discovery, calculation.productId);
    const proof = verifyProof(host, completed, oracle);
    save(fixture.root, 'actual-persisted-computation-proof.json', proof);
    const publishedText = JSON.stringify({ source: sourceRead, derived: derivedRead, discovery });
    for (const source of proof.sources) {
      assert.equal(publishedText.includes(source.materialId), false, 'WFD不承载BD保管身份');
      assert.equal(publishedText.includes(source.materialSha256), false, 'WFD不承载原件摘要');
    }
    assert.equal(publishedText.includes(proof.codeDigest), false, 'WFD不承载BD实现代码摘要');
    report.proof = { proofSha256: calculation.proof.proofSha256, lineageSha256: calculation.proof.lineageSha256,
      implementationVersion: proof.implementationVersion, methodVersion: proof.methodVersion, codeDigest: proof.codeDigest };
    const tasksBefore = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n;
    const repeated = await host.call('/r1/batches/start', input, 202);
    const alias = await host.call('/r1/batches/start', { ...input, batchId: 'same-ma-manifest-alias' }, 202);
    assert.equal(repeated.duplicateBatch, true); assert.equal(alias.duplicateBatch, true);
    assert.equal(alias.batchId, input.batchId);
    assert.equal((await host.call('/r1/batches/same-ma-manifest-alias')).batchId, input.batchId);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n, tasksBefore);
    assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, snapshotAfterPublication);
    assert.equal((await host.call('/r1/batches/start', { ...input, calculation: { ...input.calculation, period: 4 } }, 409)).code, 'R1_BATCH_CONFLICT');
    await host.close(); host = await openFullChainHost(fixture);
    host.services.r1Runtime!.client.submit = async () => { extraSendsAfterReopen++; throw new Error('Fixed reads must not submit'); };
    const reopenedSource = await fixedRead(host, sourceSnapshotId, sourceProductId);
    const reopenedDerived = await fixedRead(host, calculation.snapshotId, calculation.productId);
    assert.deepEqual(reopenedSource, sourceRead); assert.deepEqual(reopenedDerived, derivedRead);
    assert.equal(extraSendsAfterReopen, 0);
    for (const file of files) assert.equal(sha(readFileSync(file.path)), file.sha256, '原件在验收前后摘要必须一致');
    report.recovery = { requestId: originalDerivedRequestId, actualDerivedSends: derivedSends,
      extraSubmitsAfterTwoReopens: extraSendsAfterReopen, taskDeltaOnRepetition: 0,
      fixedSourceAndDerivedReadsEqualAfterReopen: true, sourceFilesUnchanged: files.length };
    save(fixture.root, 'original-ma-result.json', report);
    console.log('ORIGINAL_MA_EVIDENCE_ROOT=' + fixture.root);
  } catch (error) {
    save(fixture.root, 'original-ma-failure.json', { ...report, submissions, error: String(error) });
    console.log('ORIGINAL_MA_FAILURE_ROOT=' + fixture.root); throw error;
  } finally { await host.close(); }
});

test('auxiliary interleaved source rows keep zeros and missing windows separate across securities',
  { skip: !enabled, timeout: 180_000 }, async () => {
  const fixture = createFullChainFixture({ name: 'auxiliary-ma-missing', machine: true, units });
  let host = await openFullChainHost(fixture);
  const bytes = Buffer.from('交易日期,股票代码,收盘价（元）\n'
    + '20260103,000001,3\n20260101,000002,10\n20260101,000001,0\n20260102,000001,\n'
    + '20260104,000001,4\n20260105,000001,5\n20260106,000001,6\n20260102,000002,20\n20260103,000002,30\n');
  const file = { name: 'explicit-auxiliary-missing.csv', relativePath: 'explicit-auxiliary-missing.csv', sha256: sha(bytes), byteLength: bytes.length };
  const path = join(fixture.root, file.name); writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  const stamp = new Date().toISOString();
  const input = { batchId: 'auxiliary-ma-missing', datasetId: 'auxiliary_ma_missing',
    source: { source_id: 'explicit-synthetic-ma-test', provider: 'isolated synthetic fixture',
      requested_url: 'file:///explicit-isolated-ma/每日日线/按交易日/', requested_at_utc: stamp, acquired_at_utc: stamp,
      usage_scope: '辅助夹具只核原报缺失与零、交错证券分组及窗口传播；不计为真实原包',
      authorization: { status: 'authorized', basis: '本轮隔离验收明确生成并选定的辅助缺失窗口夹具' } },
    datePolicy: 'a_share_calendar_day_asia_shanghai', sourceValueColumns: ['收盘价（元）'],
    calculation: { method: 'source_observation_ma', period: 3, valueColumn: '收盘价（元）' }, files: [file] };
  const expected = [
    ['000001', '20260101', 'warmup', null], ['000001', '20260102', 'warmup', null],
    ['000001', '20260103', 'window_missing', null], ['000001', '20260104', 'window_missing', null],
    ['000001', '20260105', 'valid', '4'], ['000001', '20260106', 'valid', '5'],
    ['000002', '20260101', 'warmup', null], ['000002', '20260102', 'warmup', null], ['000002', '20260103', 'valid', '20'],
  ];
  const report: Json = { fixture, input, sourceKind: 'explicit_auxiliary_not_original_package', expected };
  try {
    await host.call('/r1/batches/start', input, 202);
    await uploadRemaining(host, input, [{ ...file, path }]);
    const completed = await until(host, input.batchId, view => view.state === 'completed');
    assert.equal(completed.calculation.state, 'associated', JSON.stringify(completed.calculation.error));
    const calculation = completed.calculation;
    const read = await fixedRead(host, calculation.snapshotId, calculation.productId);
    assert.equal(read.rows.length, 9); verifyContracts(read);
    const rowsByKey = new Map(read.rows.map(row => [row.record_ref.logical_key, row]));
    for (const [symbol, date, status, value] of expected) {
      const row = rowsByKey.get('source_row_' + sha(JSON.stringify([date, symbol])))!; assert.ok(row);
      assert.equal(row.values.calculation_status.value, status);
      assert.equal(row.values.value.value_state, status === 'valid' ? 'valid_value' : 'unknown');
      if (value === null) assert.equal(row.values.value.value, null);
      else assert.equal(normalizedDecimal(row.values.value.value), value);
    }
    const sourceItem = completed.items[0], sourceProductId = sourceItem.auto.currentRequest.local.associations[0].product_id;
    const sourceRead = await fixedRead(host, sourceItem.auto.currentRequest.local.associations[0].snapshot_id, sourceProductId);
    const sourceRows = new Map(sourceRead.rows.map(row => [row.record_ref.logical_key, row]));
    const originalZero = sourceRows.get('source_row_' + sha(JSON.stringify(['20260101', '000001'])))!.values[code('收盘价（元）')];
    const originalMissing = sourceRows.get('source_row_' + sha(JSON.stringify(['20260102', '000001'])))!.values[code('收盘价（元）')];
    assert.equal(originalZero.value_state, 'valid_value'); assert.equal(normalizedDecimal(originalZero.value), '0');
    assert.equal(originalMissing.value_state, 'unknown'); assert.equal(originalMissing.value, null);
    const proof = host.services.r1Batches!.calculationEvidence(input.batchId)!;
    assert.deepEqual(proof.counts, { rows: 9, groups: 2, valid: 3, warmup: 4, windowMissing: 2 });
    report.completed = completed; report.proof = proof; report.actualSource = sourceRead; report.actualDerived = read;
    await host.close(); host = await openFullChainHost(fixture);
    const reopened = await fixedRead(host, calculation.snapshotId, calculation.productId);
    assert.deepEqual(reopened, read);
    report.persistedAfterReopen = true;
    save(fixture.root, 'auxiliary-ma-missing-result.json', report);
    console.log('AUXILIARY_MA_EVIDENCE_ROOT=' + fixture.root);
  } catch (error) {
    save(fixture.root, 'auxiliary-ma-missing-failure.json', { ...report, error: String(error) });
    console.log('AUXILIARY_MA_FAILURE_ROOT=' + fixture.root); throw error;
  } finally { await host.close(); }
});
