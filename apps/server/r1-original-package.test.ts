import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { openIsolatedBrowser } from './r1-browser-test-support.js';

type Json = Record<string, any>;
type Selected = { key: string; path: string; relativePath: string; uri: string; bytes: number; sha256: string };
type Oracle = { sha256: string; columns: string[]; rows: string[][] };
type Browser = Awaited<ReturnType<typeof openIsolatedBrowser>>;
const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT
  && !!process.env.XUAN_ORIGINAL_MANIFEST && !!process.env.XUAN_ORIGINAL_ORACLE;
const units = {
  count: { dimension: 'quantity' }, date: { dimension: 'date' }, percent: { dimension: 'ratio' },
  srcunit_5YWD: { dimension: 'number', authority: '来源原表头单位：元；不推导币种或换算' },
  srcunit_5Lq_5YWD: { dimension: 'number', authority: '来源原表头单位：亿元；不推导币种或换算' },
  srcunit_54K5: { dimension: 'number', authority: '来源原表头单位：点；不推导标准指数意义' },
};
const literal = JSON.stringify;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fieldCode = (column: string) => 'src_' + Buffer.from(column, 'utf8').toString('base64url');
function save(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function selectedInputs() {
  const manifest = JSON.parse(readFileSync(process.env.XUAN_ORIGINAL_MANIFEST!, 'utf8'));
  const oracle = JSON.parse(readFileSync(process.env.XUAN_ORIGINAL_ORACLE!, 'utf8')) as Record<string, Oracle>;
  const byKey = Object.fromEntries((manifest.selected as Selected[]).map(item => [item.key, item]));
  return { manifest, oracle, byKey };
}
function source(uri: string, stamp: string) {
  return { source_id: 'user-selected-unchanged-original-package', provider: '余哈哈的数据仓库 原创整理',
    requested_url: uri, requested_at_utc: stamp, acquired_at_utc: stamp,
    usage_scope: '用户明确选择真实原包用于全新隔离BD与WFD原报观察验收',
    authorization: { status: 'authorized', basis: '用户明确选择原包根，授权本轮全新隔离BD与WFD综合验收；境内A股原报交易日期按北京时间日历日' } };
}
async function waitAuto(host: FullChainHost, id: string) {
  for (let tries = 0; tries < 3600; tries++) {
    const view = await host.call('/r1/auto/' + id);
    if (['associated', 'awaiting_answers', 'blocked', 'stopped', 'recovering'].includes(view.state)) return view as Json;
    await delay(25);
  }
  throw new Error('原自动请求未收束：' + id);
}
async function upload(host: FullChainHost, item: Selected, requestId: string) {
  const bytes = readFileSync(item.path); assert.equal(bytes.length, item.bytes); assert.equal(sha(bytes), item.sha256);
  const accepted = await host.upload(basename(item.path), 'data', bytes, requestId);
  const task = await host.settled(accepted.jobId);
  assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  const material = host.services.materials!.getByTask(task.id)!;
  assert.equal(material.envelope.sha256, item.sha256);
  assert.deepEqual(host.services.materials!.readOriginal(material.envelope.materialId).bytes, bytes);
  return material.envelope.materialId;
}
async function runBatch(host: FullChainHost, input: Json, selected: Selected[], oracle: Record<string, Oracle>) {
  await host.call('/r1/batches/start', input, 202);
  for (let tries = 0; tries < 4800; tries++) {
    const view = await host.call('/r1/batches/' + input.batchId);
    const failedRecovery = view.items.find((item: Json) => item.auto?.state === 'recovering' && item.auto.error);
    assert.ok(!failedRecovery, JSON.stringify({ requestId: failedRecovery?.autoRequestId,
      error: failedRecovery?.auto?.error, originalError: failedRecovery?.auto?.currentRequest?.error }));
    let answered = false;
    for (const [index, entry] of view.items.entries()) if (entry.auto?.state === 'awaiting_answers'
      && entry.auto.questions.some((q: Json) => q.key === 'source_key_columns')) {
      const item = selected[index]!;
      assert.ok(item.key.startsWith('retail_'), '本轮只为已逐行核对的游资原报声明复合身份');
      const columns = ['股票代码', '游资名称', '关联机构（一般为营业部或机构专用）'];
      const original = oracle[item.key]!;
      const keys = original.rows.map(row => ['交易日期', ...columns].map(column => row[original.columns.indexOf(column)]));
      assert.ok(keys.every(key => key.every(value => value !== undefined && value !== '')));
      assert.equal(new Set(keys.map(key => JSON.stringify(key))).size, original.rows.length);
      await host.call('/r1/auto/' + entry.autoRequestId + '/answers', { answers: { source_key_columns: JSON.stringify(columns) } }, 202);
      answered = true; break;
    }
    if (answered) { await delay(25); continue; }
    if (view.nextUploadItemId) {
      const index = view.items.findIndex((item: Json) => item.itemId === view.nextUploadItemId);
      const bytes = readFileSync(selected[index]!.path);
      assert.equal(sha(bytes), selected[index]!.sha256);
      const response = await fetch(host.base + `/r1/batches/${input.batchId}/items/${view.nextUploadItemId}/upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web' }, body: bytes });
      const receipt = await response.json(); assert.equal(response.status, 202, JSON.stringify(receipt));
      continue;
    }
    if (view.items.every((item: Json) => ['associated', 'awaiting_answers', 'blocked'].includes(item.state))
      && view.items.every((item: Json) => !item.auto?.questions.some((q: Json) => q.key === 'source_trade_date_timezone'))) return view as Json;
    assert.ok(!['stopped', 'blocked'].includes(view.state), JSON.stringify(view));
    await delay(25);
  }
  throw new Error('真实原包批次未收束：' + input.batchId);
}
async function fixedRead(host: FullChainHost, snapshotId: string, productId: string, fields?: string[]) {
  const pages: Json[] = []; let cursor: string | undefined;
  do {
    const value = await host.call('/r1/products/read', { snapshotId, productId, ...(fields ? { fields } : {}), ...(cursor ? { cursor } : {}) });
    assert.equal(value.result.snapshot_id, snapshotId); assert.equal(value.result.product_id, productId);
    pages.push(value.result); cursor = value.result.page.has_more ? value.result.page.next_cursor : undefined;
    assert.ok(!value.result.page.has_more || cursor);
  } while (cursor);
  return { pages, rows: pages.flatMap(page => page.rows) as Json[] };
}
function originalPlan(host: FullChainHost, view: Json, item: Selected, oracle: Oracle) {
  assert.equal(view.state, 'associated', JSON.stringify(view));
  assert.equal(view.currentRequest.state, 'associated');
  assert.equal(view.currentRequest.local.associations.length, oracle.rows.length);
  const plan = host.services.processing!.get(view.planIds.at(-1)!);
  assert.deepEqual(plan.steps.map(step => step.kind), ['parse', 'clean', 'structure', 'annotate', 'check']);
  assert.ok(plan.steps.every(step => step.state === 'succeeded' || step.applicability === 'not_applicable'));
  assert.equal(plan.outputs[0]!.publishEligible, true);
  const parse = plan.steps.find(step => step.kind === 'parse')!;
  const parsed = JSON.parse(host.services.processing!.artifact(plan.planId, parse.stepId).bytes.toString('utf8'));
  assert.equal(parsed.source_sha256, item.sha256);
  assert.deepEqual(parsed.source_columns, oracle.columns);
  assert.equal(parsed.rows.length, oracle.rows.length);
  let originalCells = 0;
  for (const [rowIndex, row] of oracle.rows.entries()) for (const [columnIndex, value] of row.entries()) {
    const cell = parsed.rows[rowIndex][columnIndex];
    assert.equal(cell.original, value, `${item.key} 原行${rowIndex + 2} 原列${oracle.columns[columnIndex]}`);
    assert.ok(cell.location && typeof cell.quote === 'string'); originalCells++;
  }
  const projection = parsed.sourceProjection;
  assert.equal(projection.timezone, 'Asia/Shanghai');
  assert.equal(projection.keyColumns[0], '交易日期');
  assert.deepEqual(projection.sourceColumns, oracle.columns);
  for (const field of projection.fields) assert.equal(field.fieldCode, fieldCode(field.column));
  return { plan, parsed, projection, originalCells };
}
function normalizeDecimal(value: unknown) {
  assert.equal(typeof value, 'string');
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value as string); assert.ok(match, String(value));
  const whole = match[2]!.replace(/^0+(?=\d)/u, ''), fraction = (match[3] ?? '').replace(/0+$/u, '');
  return (whole === '0' && !fraction ? '' : match[1]) + whole + (fraction ? '.' + fraction : '');
}
function expectedUnit(column: string) {
  if (column === '交易日期') return 'date';
  if (column.includes('%')) return 'percent';
  const match = /[（(]([^（）()]+)[）)]\s*$/u.exec(column);
  if (match && ['元', '亿元', '点'].includes(match[1]!)) return 'srcunit_' + Buffer.from(match[1]!, 'utf8').toString('base64url');
  return 'not_applicable';
}
function verifyRows(rows: Json[], item: Selected, oracle: Oracle, projection: Json, columns?: string[]) {
  const byKey = new Map(rows.map(row => [row.record_ref.logical_key ?? row.record_ref.record_id, row]));
  const dateIndex = oracle.columns.indexOf('交易日期'); let values = 0, blanks = 0, zeroes = 0;
  for (const [rowIndex, raw] of oracle.rows.entries()) {
    const key = 'source_row_' + sha(JSON.stringify(projection.keyColumns.map((column: string) => raw[oracle.columns.indexOf(column)])));
    const actual = byKey.get(key); assert.ok(actual, `${item.key} 原行${rowIndex + 2} 缺少独立计算业务键 ${key}`);
    const date = raw[dateIndex]!, isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const start = Date.parse(isoDate + 'T00:00:00+08:00'), time = actual.business_time ?? actual.observation_time;
    assert.equal(time.status, 'known'); assert.equal(Date.parse(time.earliest_utc), start);
    assert.equal(Date.parse(time.latest_exclusive_utc), start + 86_400_000);
    assert.equal(time.source_timezone, 'Asia/Shanghai');
    const publicTime = actual.times?.public_time ?? actual.public_time;
    if (publicTime) assert.equal(publicTime.status, 'unknown', '原报日期不得冒充历史公开时间');
    for (const field of projection.fields.filter((field: Json) => !columns || columns.includes(field.column))) {
      const expected = raw[oracle.columns.indexOf(field.column)]!;
      const cell: Json = actual.values[field.fieldCode];
      assert.ok(cell, `${item.key} ${field.column} 缺少WFD真实值`);
      assert.equal(cell.unit.unit_code, expectedUnit(field.column), `${item.key} ${field.column} 原报单位`);
      assert.equal(cell.value_state, expected === '' ? 'unknown' : 'valid_value');
      if (expected === '') { assert.equal(cell.value, null); blanks++; }
      else if (cell.data_type === 'decimal' || cell.data_type === 'integer') {
        assert.equal(normalizeDecimal(cell.value), normalizeDecimal(expected), `${item.key} 原行${rowIndex + 2} ${field.column} 数值`);
        if (normalizeDecimal(expected) === '0') zeroes++;
      } else assert.equal(cell.value, expected, `${item.key} 原行${rowIndex + 2} ${field.column} 原文`);
      values++;
    }
  }
  return { sourceRows: oracle.rows.length, verifiedValues: values, sourceBlankCells: blanks, numericZeroCells: zeroes };
}

test('original HTTP batch retains real source gaps, fixed values and same-series reuse', { skip: !enabled, timeout: 600_000 }, async () => {
  const { manifest, oracle, byKey } = selectedInputs();
  const fixture = createFullChainFixture({ name: 'original-http-batch', machine: true, units });
  const host = await openFullChainHost(fixture);
  const keys = ['ths_industry_1', 'ths_industry_2', 'dc_market_1', 'dc_market_2', 'dc_sector_1', 'dc_sector_2', 'retail_1', 'retail_2'];
  const selected = keys.map(key => byKey[key]!);
  const stamp = new Date().toISOString();
  const input = { batchId: 'original-mixed-batch', source: source(pathToFileURL(manifest.rawRoot + '/').href, stamp),
    datasetId: 'original_http_reports', datePolicy: 'a_share_calendar_day_asia_shanghai',
    files: selected.map(item => ({ name: basename(item.path), relativePath: item.relativePath, sha256: item.sha256, byteLength: item.bytes })) };
  const report: Json = { originalManifest: process.env.XUAN_ORIGINAL_MANIFEST, oracle: process.env.XUAN_ORIGINAL_ORACLE,
    root: fixture.root, endpoint: host.base, datePolicyAuthority: input.source.authorization.basis, cases: [], negatives: [] };
  save(join(fixture.root, 'run-context.json'), { root: fixture.root, endpoint: host.base, fixture, input });
  try {
    const batch = await runBatch(host, input, selected, oracle); report.batch = batch;
    const associated: { item: Selected; oracle: Oracle; view: Json; projection: Json }[] = [];
    for (const [index, entry] of batch.items.entries()) {
      const item = selected[index]!, expected = oracle[item.key]!;
      assert.equal(entry.requestedUrl, item.uri);
      assert.equal(entry.policyAnswers.source_trade_date_timezone, 'Asia/Shanghai');
      assert.equal(sha(host.services.materials!.readOriginal(entry.materialId).bytes), item.sha256);
      const view = entry.auto;
      if (item.key.startsWith('ths_') || item.key.startsWith('dc_sector_')) {
        assert.equal(view.state, 'awaiting_answers', JSON.stringify(view));
        assert.ok(view.questions.length > 0);
        assert.ok(view.questions.every((q: Json) => q.key.startsWith('unit.')), JSON.stringify(view.questions));
        assert.equal(view.requestIds.length, 0); assert.equal(view.currentRequest, null);
        report.cases.push({ key: item.key, state: view.state, originalSha256: item.sha256, questions: view.questions, wfdRows: 0 });
      } else {
        const plan = originalPlan(host, view, item, expected);
        associated.push({ item, oracle: expected, view, projection: plan.projection });
        report.cases.push({ key: item.key, state: view.state, originalSha256: item.sha256, originalCells: plan.originalCells,
          sourceRows: expected.rows.length, definitionReview: view.definitionReview, definitionAction: view.definitionAction,
          productId: view.currentRequest.local.associations[0].product_id, projection: plan.projection });
        save(join(fixture.root, item.key + '-plan.json'), plan.plan);
      }
      console.log(JSON.stringify({ key: item.key, state: view.state, questionKeys: view.questions.map((q: Json) => q.key),
        wfdRows: view.currentRequest?.local.associations.length ?? 0, definitionAction: view.definitionAction }));
    }
    const snapshotId = (await host.call('/r1/products/snapshot', {})).snapshotId;
    report.snapshotId = snapshotId;
    for (const family of ['dc_market', 'retail']) {
      const familyCases = associated.filter(entry => entry.item.key.startsWith(family));
      assert.equal(familyCases.length, 2);
      const first = familyCases[0]!, second = familyCases[1]!;
      const productId = first.view.currentRequest.local.associations[0].product_id;
      assert.equal(second.view.currentRequest.local.associations[0].product_id, productId);
      assert.equal(first.view.definitionReview.code, 'FAMILY_DEFINITION_REQUIRED');
      assert.equal(second.view.definitionReview.code, 'CANDIDATE_FIELDS_PRESENT');
      assert.equal(second.view.definitionAction, 'reuse_same_definition');
      if (family === 'retail') assert.equal(second.view.evidence.find((fact: Json) => fact.key === 'source_key_columns')?.origin,
        'contract', '同系列后件应复用WFD固定目录的复合键，不重复向操作者提问');
      const result = await fixedRead(host, snapshotId, productId);
      assert.equal(result.rows.length, first.oracle.rows.length + second.oracle.rows.length);
      const checks = familyCases.map(entry => ({ key: entry.item.key, ...verifyRows(result.rows, entry.item, entry.oracle, entry.projection) }));
      report[family + 'Readback'] = { productId, snapshotId, pageCounts: result.pages.map(page => page.rows.length), checks };
      save(join(fixture.root, family + '-actual-fixed-read.json'), result);
    }
    const tasksBefore = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n;
    const duplicate = await host.call('/r1/batches/start', { ...input, batchId: 'same-original-manifest-alias' }, 202);
    assert.equal(duplicate.batchId, input.batchId); assert.equal(duplicate.duplicateBatch, true);
    const sameFile = await host.call('/r1/batches/start', { ...input, batchId: 'same-original-file', files: [input.files.at(-1)!] }, 202);
    assert.ok(sameFile.items[0].duplicateOf); assert.equal(sameFile.items[0].autoRequestId, batch.items.at(-1).autoRequestId);
    assert.equal(sameFile.items[0].state, 'associated'); assert.equal(sameFile.nextUploadItemId, null);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n, tasksBefore);
    report.idempotence = { sameManifestReturnedBatchId: duplicate.batchId, sameFileAutoRequestId: sameFile.items[0].autoRequestId, addedTasks: 0 };
    for (const key of ['institution_xlsx', 'mixed_limit_xlsx', 'yearbook_legacy_xls']) {
      const item = byKey[key]!, materialId = await upload(host, item, key + '-upload');
      const requestId = 'unsupported-' + key;
      await host.call('/r1/auto/start', { requestId, materialId, source: source(item.uri, stamp), datasetId: input.datasetId }, 202);
      const view = await waitAuto(host, requestId);
      assert.equal(view.state, 'blocked', JSON.stringify(view)); assert.equal(view.requestIds.length, 0);
      assert.equal(view.currentRequest, null); assert.ok(view.error?.message);
      report.negatives.push({ key, rawCustody: 'succeeded', materialId, originalSha256: item.sha256,
        autoAcceptedHttpStatus: 202, state: view.state, error: view.error, wfdRows: 0 });
      console.log(JSON.stringify(report.negatives.at(-1)));
    }
    const minute = byKey.minute_oversize!;
    const response = await fetch(host.base + '/r1/batches/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' },
      body: JSON.stringify({ ...input, batchId: 'oversize-minute-original', files: [{ name: basename(minute.path), relativePath: minute.relativePath,
        sha256: minute.sha256, byteLength: minute.bytes }] }) });
    const rejection = await response.json(); assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(rejection));
    report.negatives.push({ key: minute.key, originalSha256: minute.sha256, bytes: minute.bytes, custody: 'not_started', httpStatus: response.status, rejection, wfdRows: 0 });
    assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, snapshotId);
    report.summary = { originalCsvCases: 8, originalCsvRows: selected.reduce((n, item) => n + oracle[item.key]!.rows.length, 0),
      associatedCases: associated.length, publishedRows: associated.reduce((n, item) => n + item.oracle.rows.length, 0),
      awaitingSemanticCases: report.cases.filter((item: Json) => item.state === 'awaiting_answers').length,
      actualQuestionCount: report.cases.reduce((n: number, item: Json) => n + (item.questions?.length ?? 0), 0),
      unsupportedCases: report.negatives.length, sourceBytesRewritten: 0, syntheticOriginals: 0, naturalHeaderEvolutionClaimed: false };
    save(join(fixture.root, 'original-http-result.json'), report);
    console.log('ORIGINAL_HTTP_EVIDENCE_ROOT=' + fixture.root);
  } catch (error) {
    save(join(fixture.root, 'original-http-failure.json'), { ...report, error: String(error) });
    console.log('ORIGINAL_HTTP_FAILURE_ROOT=' + fixture.root); throw error;
  } finally { await host.close(); }
});

test('original sector files retain source ordinal labels and ask only the unresolved index unit', { skip: !enabled, timeout: 120_000 }, async () => {
  const { manifest, oracle, byKey } = selectedInputs();
  const fixture = createFullChainFixture({ name: 'original-sector-label-delta', machine: true, units });
  const host = await openFullChainHost(fixture);
  try {
    const selected = [byKey.dc_sector_1!, byKey.dc_sector_2!];
    const input = { batchId: 'original-sector-label-delta', source: source(pathToFileURL(manifest.rawRoot + '/').href, new Date().toISOString()),
      datasetId: 'original_sector_delta', datePolicy: 'a_share_calendar_day_asia_shanghai',
      files: selected.map(item => ({ name: basename(item.path), relativePath: item.relativePath, sha256: item.sha256, byteLength: item.bytes })) };
    const batch = await runBatch(host, input, selected, oracle);
    const cases = batch.items.map((entry: Json, index: number) => {
      const item = selected[index]!;
      assert.equal(entry.state, 'awaiting_answers');
      assert.deepEqual(entry.auto.questions.map((q: Json) => q.key), ['unit.板块最新指数']);
      assert.equal(entry.auto.evidence.find((fact: Json) => fact.key === 'type.序号')?.value, 'text');
      assert.equal(entry.auto.evidence.find((fact: Json) => fact.key === 'unit.序号')?.value, 'not_applicable');
      assert.ok(!entry.auto.evidence.find((fact: Json) => fact.key === 'source_key_columns')?.value.includes('序号'));
      assert.equal(entry.auto.requestIds.length, 0); assert.equal(entry.auto.currentRequest, null);
      assert.equal(sha(host.services.materials!.readOriginal(entry.materialId).bytes), item.sha256);
      return { key: item.key, originalSha256: item.sha256, originalRows: oracle[item.key]!.rows.length,
        state: entry.state, questions: entry.auto.questions, sourceOrdinalType: 'text', sourceOrdinalUnit: 'not_applicable', wfdRows: 0 };
    });
    assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, null);
    save(join(fixture.root, 'original-sector-label-delta.json'), { root: fixture.root, cases, batch });
    console.log('ORIGINAL_SECTOR_DELTA_EVIDENCE_ROOT=' + fixture.root);
  } finally { await host.close(); }
});

const autoPanel = 'section[aria-label="文件自动交接"]';
const autoForm = autoPanel + ' > form';
const autoCurrent = autoPanel + ' > div.r1-material';
const batchPanel = 'section[aria-label="多文件批量交接"]';
const readerPanel = 'section[aria-label="WFD 持久数据查询"]';
async function fill(browser: Browser, scope: string, label: string, value: string) {
  await browser.evaluate(`(()=>{const root=document.querySelector(${literal(scope)});
    const label=[...root.querySelectorAll('label')].find(e=>e.firstChild?.textContent===${literal(label)});
    if(!label)throw new Error('Missing visible label: '+${literal(label)});
    const e=label.querySelector('input,select,textarea');if(!e||e.disabled)throw new Error('Input unavailable');
    const type=e.tagName==='SELECT'?HTMLSelectElement:e.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;
    Object.getOwnPropertyDescriptor(type.prototype,'value').set.call(e,${literal(value)});
    e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function click(browser: Browser, scope: string, text: string) {
  const expression = `[...document.querySelector(${literal(scope)}).querySelectorAll('button')].find(e=>e.textContent.trim()===${literal(text)}&&!e.disabled)`;
  await browser.until(`!!(${expression})`, '页面按钮尚不可用：' + text);
  await browser.evaluate(`(${expression}).click()`);
}
async function checkbox(browser: Browser, scope: string, prefix: string) {
  const expression = `[...document.querySelector(${literal(scope)}).querySelectorAll('label')].find(e=>e.textContent.startsWith(${literal(prefix)}))?.querySelector('input[type=checkbox]')`;
  assert.equal(await browser.evaluate(`(${expression})?.checked`), false, '正式授权不得预先勾选');
  const point = await browser.evaluate<{ x: number; y: number }>(`(()=>{const e=${expression};if(!e||e.disabled)throw new Error('Checkbox unavailable');
    e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await browser.page('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await browser.page('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await browser.until(`(${expression})?.checked===true`, '页面未接收本次明确授权');
}
async function chooseFiles(browser: Browser, scope: string, paths: string[]) {
  const document = await browser.page('DOM.getDocument');
  const input = await browser.page('DOM.querySelector', { nodeId: document.root.nodeId, selector: scope + ' input[type=file]' });
  assert.ok(input.nodeId); await browser.page('DOM.setFileInputFiles', { nodeId: input.nodeId, files: paths });
}
async function screenshot(browser: Browser, path: string, scope: string) {
  await browser.evaluate(`document.querySelector(${literal(scope)}).scrollIntoView({block:'start',behavior:'instant'})`);
  const result = await browser.page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path, Buffer.from(result.data, 'base64'), { flag: 'wx' });
}
async function navigate(browser: Browser, host: FullChainHost) {
  await browser.page('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1150, deviceScaleFactor: 1, mobile: false });
  await browser.page('Page.navigate', { url: host.base.replace('/api/bd', '/') });
  await browser.until(`(()=>{if(document.querySelector(${literal(batchPanel)})&&document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;
    document.querySelector('button[aria-label="数据库"]')?.click();return false;})()`, '真实应用未显示批量交接入口');
}
async function browserSettled(host: FullChainHost, id: string) {
  for (let tries = 0; tries < 3600; tries++) {
    const view = await host.call('/r1/auto/' + id);
    assert.ok(!(view.state === 'recovering' && view.error), JSON.stringify({ requestId: id, error: view.error, originalError: view.currentRequest?.error }));
    if (view.state === 'associated' || view.state === 'awaiting_answers') return view as Json;
    assert.ok(!['blocked', 'stopped'].includes(view.state), JSON.stringify({ state: view.state, error: view.error }));
    await delay(25);
  }
  throw new Error('网页原请求未完成：' + id);
}
async function answerActualQuestions(browser: Browser, host: FullChainHost, view: Json, oracle: Oracle) {
  if (view.state !== 'awaiting_answers') return { view, questionKeys: [] as string[] };
  const questionKeys: string[] = view.questions.map((question: Json) => question.key);
  for (const question of view.questions) {
    let value: string;
    if (question.key === 'source_trade_date_timezone') value = 'Asia/Shanghai';
    else {
      assert.equal(question.key, 'source_key_columns', '本验收不补造原件未给出的单位或其它事实');
      const columns = ['股票代码', '游资名称', '关联机构（一般为营业部或机构专用）'];
      const keys = oracle.rows.map(row => ['交易日期', ...columns].map(column => row[oracle.columns.indexOf(column)]));
      assert.ok(keys.every(key => key.every(value => value !== undefined && value !== '')));
      assert.equal(new Set(keys.map(key => JSON.stringify(key))).size, oracle.rows.length);
      value = JSON.stringify(columns);
    }
    await browser.until(`[...document.querySelector(${literal(autoCurrent)}).querySelectorAll('label')].some(e=>e.firstChild?.textContent===${literal(question.label)})`,
      '页面未呈现实际待补问题');
    await fill(browser, autoCurrent, question.label, value);
  }
  await click(browser, autoCurrent, '保存补答并继续');
  const after = await browserSettled(host, view.requestId); assert.equal(after.state, 'associated', JSON.stringify(after));
  await browser.until(`document.querySelector(${literal(autoPanel)})?.textContent.includes('真实回执、固定读回及回链完成')`, '网页没有呈现实际回链完成');
  return { view: after, questionKeys };
}
async function startSingleFromPage(browser: Browser, host: FullChainHost, item: Selected, stamp: string, columns: string[]) {
  if (await browser.evaluate(`!!document.querySelector(${literal(autoForm)})`) === false) await click(browser, autoPanel, '另选原件开始新交接');
  await fill(browser, autoForm, '上传接收类别', 'data');
  await chooseFiles(browser, autoForm, [item.path]);
  const option = `[...document.querySelector(${literal(autoForm)}).querySelectorAll('select option')].find(e=>e.textContent.startsWith(${literal(basename(item.path) + ' · ')}))`;
  await browser.until(`!!(${option})`, '真实原件上传未进入保管目录');
  await fill(browser, autoForm, '已保管原件', await browser.evaluate<string>(`(${option}).value`));
  await browser.until(`document.querySelector(${literal(autoForm)}+' .r1-material')?.textContent.includes(${literal(item.sha256)})`, '页面未显示真实原件摘要');
  const materialId = await browser.evaluate<string>(`[...document.querySelector(${literal(autoForm)}).querySelectorAll('label')].find(e=>e.firstChild?.textContent==='已保管原件').querySelector('select').value`);
  assert.equal(sha(host.services.materials!.readOriginal(materialId).bytes), item.sha256);
  const s = source(item.uri, stamp);
  for (const [label, value] of Object.entries({ '目标数据集编号': 'original_controlled_columns', 来源身份: s.source_id, 提供者: s.provider,
    '原始地址或 URI（资源标识）': s.requested_url, '请求时间（UTC，协调世界时）': s.requested_at_utc,
    '取得时间（UTC，协调世界时）': s.acquired_at_utc, 本次获准用途: s.usage_scope,
    本次正式交接授权: 'authorized', 本次授权依据: s.authorization.basis })) await fill(browser, autoForm, label, value);
  await browser.evaluate(`(()=>{const label=[...document.querySelector(${literal(autoForm)}).querySelectorAll('label')].find(e=>e.firstChild?.textContent==='本次原报字段，每行一个原列名');
    const details=label?.closest('details');if(details&&!details.open)details.querySelector('summary').click();})()`);
  await fill(browser, autoForm, '本次原报字段，每行一个原列名', columns.join('\n'));
  await checkbox(browser, autoForm, '我允许');
  await click(browser, autoForm, '开始自动交接');
  const idExpression = `[...document.querySelector(${literal(autoPanel)}).querySelectorAll('p')].find(e=>e.querySelector('strong')?.textContent==='自动交接编号')?.querySelector('code')?.textContent`;
  await browser.until(`!!(${idExpression})`, '页面未保留实际自动请求编号');
  return { materialId, view: await browserSettled(host, await browser.evaluate<string>(idExpression)) };
}
async function readFromPage(browser: Browser, host: FullChainHost, snapshotId: string, productId: string, fields: string[], screenshotPath?: string) {
  await fill(browser, readerPanel, '固定快照编号', snapshotId); await click(browser, readerPanel, '发现快照中的产品');
  await browser.until(`document.querySelector(${literal(readerPanel)})?.getAttribute('aria-busy')==='false'&&!!document.querySelector(${literal(readerPanel)}+' select')`, '页面固定发现尚未完成');
  const discovery = await host.call('/r1/products/discover', { snapshotId });
  const selection = discovery.selections.find((item: Json) => item.productId === productId); assert.ok(selection);
  await fill(browser, readerPanel, '快照中的产品', productId);
  for (const field of selection.fields) await browser.evaluate(`(()=>{const group=[...document.querySelector(${literal(readerPanel)}).querySelectorAll('fieldset')].find(e=>e.querySelector('legend')?.textContent==='选择读取字段');
    const checkbox=[...group.querySelectorAll('label')].find(e=>e.querySelector('span')?.title===${literal(field)})?.querySelector('input');if(!checkbox)throw new Error('Discovered field absent');
    if(checkbox.checked!==${fields.includes(field)})checkbox.click();})()`);
  await click(browser, readerPanel, '读取持久数据');
  await browser.until(`document.querySelector(${literal(readerPanel)})?.getAttribute('aria-busy')==='false'&&!!document.querySelector(${literal(readerPanel)}+' [aria-label="WFD 实际读取结果"] table')`, '网页没有返回真实WFD数据', 60_000);
  const pages: Json[] = [];
  for (;;) {
    const page = await browser.evaluate<Json>(`(()=>{const root=document.querySelector(${literal(readerPanel)}+' [aria-label="WFD 实际读取结果"]');return JSON.parse(root.querySelector('details:last-child pre').textContent);})()`);
    assert.equal(page.snapshot_id, snapshotId); assert.equal(page.product_id, productId); assert.equal(page.history_mode, 'snapshot_contents');
    assert.deepEqual(page.fields, [...fields].sort());
    const rendered = await browser.evaluate<string[]>(`[...document.querySelector(${literal(readerPanel)}+' table').querySelectorAll('tbody tr')].map(e=>e.innerText)`);
    assert.equal(rendered.length, page.rows.length);
    if (page.rows.length) assert.ok(Object.values(page.rows[0].values).every((cell: any) => rendered[0]!.includes(cell.value === null ? cell.value_state : String(cell.value))));
    if (!pages.length && screenshotPath) await screenshot(browser, screenshotPath, readerPanel);
    pages.push(page); if (!page.page.has_more) break;
    await click(browser, readerPanel, '下一页');
    await browser.until(`document.querySelector(${literal(readerPanel)})?.getAttribute('aria-busy')==='false'&&document.querySelector(${literal(readerPanel)}+' [aria-label="WFD 实际读取结果"]')?.textContent.includes(${literal('第 ')}+${pages.length + 1}+' 页')`, '网页未沿原固定游标翻页', 60_000);
  }
  return { pages, rows: pages.flatMap(page => page.rows) as Json[] };
}

test('original browser uploads multiple real files, extends selected native columns and reopens fixed snapshots', {
  skip: !enabled || !process.env.XUAN_TEST_BROWSER || !process.env.XUAN_TEST_BROWSER_SHA256 || !process.env.XUAN_TEST_WEB_ROOT,
  timeout: 600_000,
}, async () => {
  const { oracle, byKey } = selectedInputs();
  assert.equal(sha(readFileSync(process.env.XUAN_TEST_BROWSER!)), process.env.XUAN_TEST_BROWSER_SHA256);
  const resumeRoot = process.env.XUAN_ORIGINAL_RESUME_ROOT;
  const fixture = resumeRoot ? JSON.parse(readFileSync(join(resumeRoot, 'run-context.json'), 'utf8')).fixture
    : createFullChainFixture({ name: 'original-browser', machine: true, units });
  const imageRoot = resumeRoot ? mkdtempSync(join(fixture.root, 'resumed-readback-')) : fixture.root;
  let host = await openFullChainHost(fixture, process.env.XUAN_TEST_WEB_ROOT!);
  let browser: Browser | undefined = await openIsolatedBrowser(process.env.XUAN_TEST_BROWSER!, imageRoot);
  const stamp = new Date().toISOString();
  const report: Json = resumeRoot ? JSON.parse(readFileSync(join(resumeRoot, 'original-browser-failure.json'), 'utf8'))
    : { root: fixture.root, endpoint: host.base, cases: [], questionHistory: [] };
  const controlled: { item: Selected; oracle: Oracle; view: Json; projection: Json }[] = [];
  if (!resumeRoot) save(join(fixture.root, 'run-context.json'), { root: fixture.root, endpoint: host.base, fixture, originalManifest: process.env.XUAN_ORIGINAL_MANIFEST });
  try {
    await navigate(browser, host);
    if (!resumeRoot) {
    save(join(fixture.root, 'initial-page.json'), await browser.evaluate(`({text:document.body.innerText,labels:[...document.querySelectorAll('label')].map(e=>e.firstChild?.textContent)})`));
    await chooseFiles(browser, batchPanel, [byKey.minute_oversize!.path]);
    await browser.until(`document.querySelector(${literal(batchPanel)}+' .error-note')?.textContent.includes('25 MiB')`, '超限真实分钟原件未具体退回');
    report.oversizeMinute = { originalSha256: byKey.minute_oversize!.sha256,
      error: await browser.evaluate(`document.querySelector(${literal(batchPanel)}+' .error-note').innerText`), custody: 'not_started' };
    await screenshot(browser, join(fixture.root, '01-minute-original-size-return.png'), batchPanel);
    const fullFiles = [byKey.retail_1!, byKey.retail_2!];
    await chooseFiles(browser, batchPanel, fullFiles.map(item => item.path));
    await browser.until(`document.querySelector(${literal(batchPanel)})?.getAttribute('aria-busy')==='false'&&document.querySelector(${literal(batchPanel)})?.textContent.includes('本次选定文件')`, '网页未核完多件原文件');
    const s = source(pathToFileURL(dirname(fullFiles[0]!.path) + '/').href, stamp);
    for (const [label, value] of Object.entries({ 本批目标数据集编号: 'original_browser_full', 来源身份: s.source_id, 提供者: s.provider,
      来源系列地址: s.requested_url, '请求时间（UTC，协调世界时）': stamp, '取得时间（UTC，协调世界时）': stamp,
      本批获准用途: s.usage_scope, 本批正式交接授权: 'authorized', 本批授权依据: s.authorization.basis })) await fill(browser, batchPanel, label, value);
    await checkbox(browser, batchPanel, '本批全部文件属于'); await checkbox(browser, batchPanel, '我允许仅对本批所列');
    await click(browser, batchPanel, '开始本批自动交接');
    const batchIdExpression = `[...document.querySelector(${literal(batchPanel)}).querySelectorAll('p')].find(e=>e.querySelector('strong')?.textContent==='本批编号')?.querySelector('code')?.textContent`;
    await browser.until(`!!(${batchIdExpression})`, '页面未保留真实批次编号');
    const batchId = await browser.evaluate<string>(batchIdExpression);
    for (let i = 0; i < 3600; i++) {
      const batch = await host.call('/r1/batches/' + batchId);
      if (batch.items.every((item: Json) => ['awaiting_answers', 'associated'].includes(item.state))) break;
      assert.ok(!['blocked', 'stopped'].includes(batch.state), JSON.stringify(batch)); await delay(25);
    }
    let batch = await host.call('/r1/batches/' + batchId);
    for (const [index, entry] of batch.items.entries()) {
      const item = fullFiles[index]!;
      assert.equal(entry.requestedUrl, item.uri); assert.equal(entry.policyAnswers.source_trade_date_timezone, 'Asia/Shanghai');
      const rowExpression = `[...document.querySelector(${literal(batchPanel)}).querySelectorAll('tbody tr')].find(e=>e.querySelector('strong')?.textContent===${literal(basename(item.path))})`;
      await browser.until(`!!(${rowExpression})?.querySelector('button:not([disabled])')`, '原件条目未提供实际补答入口');
      await browser.evaluate(`(${rowExpression}).querySelector('button').click()`);
      await browser.until(`document.querySelector(${literal(autoCurrent)})?.textContent.includes(${literal(entry.autoRequestId)})`, '页面未打开对应原自动请求');
      const answered = await answerActualQuestions(browser, host, await browserSettled(host, entry.autoRequestId), oracle[item.key]!);
      const plan = originalPlan(host, answered.view, item, oracle[item.key]!);
      report.questionHistory.push({ key: item.key, questionKeys: answered.questionKeys });
      report.cases.push({ key: item.key, kind: 'unchanged_full_original', sourceRows: oracle[item.key]!.rows.length,
        originalCells: plan.originalCells, productId: answered.view.currentRequest.local.associations[0].product_id,
        definitionReview: answered.view.definitionReview, definitionAction: answered.view.definitionAction });
    }
    await browser.until(`document.querySelector(${literal(batchPanel)})?.textContent.includes('关联 2 件')`, '页面未显示逐件真实回链数');
    batch = await host.call('/r1/batches/' + batchId); report.batch = batch;
    await screenshot(browser, join(fixture.root, '02-real-multiple-originals-associated.png'), batchPanel);
    console.log('原始网页双件实际关联=' + batch.items.filter((item: Json) => item.state === 'associated').length);
    for (const [index, key] of ['retail_1', 'retail_2', 'retail_3'].entries()) {
      const item = byKey[key]!, columns = ['买入金额（元）', '卖出金额（元）', ...(index ? ['净买卖（元）'] : [])];
      const started = await startSingleFromPage(browser, host, item, stamp, columns);
      const answered = await answerActualQuestions(browser, host, started.view, oracle[key]!);
      if (index) assert.ok(answered.questionKeys.every(key => key === 'source_trade_date_timezone'),
        '已核登记的同系列复合键不应再次提问');
      const plan = originalPlan(host, answered.view, item, oracle[key]!);
      controlled.push({ item, oracle: oracle[key]!, view: answered.view, projection: plan.projection });
      report.questionHistory.push({ key, kind: 'controlled_columns', questionKeys: answered.questionKeys });
      report.cases.push({ key, kind: 'controlled_native_source_columns', selectedSourceValueColumns: columns,
        originalSha256: item.sha256, sourceRows: oracle[key]!.rows.length, originalCells: plan.originalCells,
        definitionReview: answered.view.definitionReview, definitionAction: answered.view.definitionAction,
        productId: answered.view.currentRequest.local.associations[0].product_id, projection: plan.projection });
      save(join(fixture.root, `controlled-${index + 1}-plan.json`), plan.plan);
      await screenshot(browser, join(fixture.root, `03-controlled-original-${index + 1}.png`), autoCurrent);
      console.log(JSON.stringify({ original: key, selectedSourceValueColumns: columns, state: answered.view.state, definitionAction: answered.view.definitionAction }));
    }
    } else {
      const originals = (await host.call('/r1/auto')).items;
      for (const key of ['retail_1', 'retail_2', 'retail_3']) {
        const item = byKey[key]!;
        const view = originals.find((view: Json) => view.datasetId === 'original_controlled_columns' && view.source.requested_url === item.uri);
        assert.ok(view, '续验只接受先前已关联的原请求');
        const plan = originalPlan(host, view, item, oracle[key]!);
        controlled.push({ item, oracle: oracle[key]!, view, projection: plan.projection });
      }
      report.priorTestFailure = { path: join(resumeRoot, 'original-browser-failure.json'), error: report.error,
        correction: '按原记录与缺字段对跨页重复覆盖诊断去重；保留全部原始页诊断，不重提已成功原件' };
      report.initialBrowserRequests = report.requests;
      delete report.error; delete report.pageText; delete report.requests;
    }
    const first = controlled[0]!, second = controlled[1]!, third = controlled[2]!;
    const productId = first.view.currentRequest.local.associations[0].product_id;
    assert.equal(second.view.currentRequest.local.associations[0].product_id, productId);
    assert.equal(third.view.currentRequest.local.associations[0].product_id, productId);
    assert.equal(second.view.definitionReview.code, 'FIELD_DEFINITION_REQUIRED');
    assert.deepEqual(second.view.definitionReview.missingFields, [fieldCode('净买卖（元）')]);
    assert.equal(second.view.definitionAction, 'evolve_additive_definition');
    assert.equal(third.view.definitionAction, 'reuse_same_definition');
    const oldSnapshotId = first.view.currentRequest.local.associations[0].snapshot_id;
    const currentSnapshotId = third.view.currentRequest.local.associations[0].snapshot_id;
    const commonColumns = first.projection.fields.map((field: Json) => field.column), commonFields = commonColumns.map(fieldCode);
    const historical = await readFromPage(browser, host, oldSnapshotId, productId, commonFields,
      join(imageRoot, '04-original-fixed-snapshot.png'));
    assert.equal(historical.rows.length, first.oracle.rows.length); verifyRows(historical.rows, first.item, first.oracle, first.projection);
    const current = await readFromPage(browser, host, currentSnapshotId, productId, commonFields,
      join(imageRoot, '05-expanded-fixed-snapshot.png'));
    assert.equal(current.rows.length, controlled.reduce((n, item) => n + item.oracle.rows.length, 0));
    report.sharedReadbackChecks = controlled.map(entry => ({ key: entry.item.key,
      ...verifyRows(current.rows, entry.item, entry.oracle, entry.projection, commonColumns) }));
    const added = await readFromPage(browser, host, currentSnapshotId, productId, [fieldCode('净买卖（元）')],
      join(imageRoot, '06-new-source-column-and-old-contract-gaps.png'));
    assert.equal(added.rows.length, second.oracle.rows.length + third.oracle.rows.length);
    for (const entry of [second, third]) verifyRows(added.rows, entry.item, entry.oracle, entry.projection, ['净买卖（元）']);
    const missingByRecord = new Map(added.pages.flatMap(page => page.diagnostics)
      .filter(item => item.code === 'FIELD_NOT_DEFINED_IN_ROW_CONTRACT')
      .map(item => [JSON.stringify([item.record_ref, item.missing_fields]), item]));
    const missing = [...missingByRecord.values()];
    assert.equal(missing.length, first.oracle.rows.length, '旧行合同没有新增字段，不能补造旧行新值');
    report.actualFixedReadArtifact = join(imageRoot, 'actual-controlled-fixed-reads.json');
    save(report.actualFixedReadArtifact, { productId, oldSnapshotId, currentSnapshotId, historical, current, added });
    report.extension = { productId, oldSnapshotId, currentSnapshotId, controlledOriginalFiles: 3,
      historicalRows: historical.rows.length, currentSharedRows: current.rows.length, addedFieldRows: added.rows.length,
      historicalMissingNewFieldDiagnostics: missing.length, naturalHeaderEvolution: false, sourceBytesRewritten: 0 };
    report.initialBrowserRequests ??= browser.requests;
    assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedRequests, []);
    await browser.close(); browser = undefined; await host.close();
    host = await openFullChainHost(fixture, process.env.XUAN_TEST_WEB_ROOT!);
    const reopened = join(imageRoot, 'reopened'); mkdirSync(reopened);
    browser = await openIsolatedBrowser(process.env.XUAN_TEST_BROWSER!, reopened); await navigate(browser, host);
    const reopenedHistorical = await readFromPage(browser, host, oldSnapshotId, productId, commonFields,
      join(imageRoot, '07-reopened-original-snapshot.png'));
    const reopenedCurrent = await readFromPage(browser, host, currentSnapshotId, productId, commonFields,
      join(imageRoot, '08-reopened-expanded-snapshot.png'));
    assert.deepEqual(reopenedHistorical.rows, historical.rows); assert.deepEqual(reopenedCurrent.rows, current.rows);
    assert.ok(!browser.requests.some(request => /\/r1\/(?:prepare|auto\/start|batches\/start|requests\/[^/]+\/(?:submit|recover))$/u.test(new URL(request.url).pathname)));
    assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedRequests, []);
    report.reopenedBrowserRequests = browser.requests; report.pageExceptions = browser.exceptions;
    report.externalRequests = browser.blockedRequests; report.persistedAfterHostAndBrowserRestart = true;
    save(join(fixture.root, 'original-browser-result.json'), report);
    console.log('ORIGINAL_BROWSER_EVIDENCE_ROOT=' + fixture.root);
  } catch (error) {
    if (browser) {
      await screenshot(browser, join(imageRoot, 'failure.png'), autoPanel).catch(() => {});
      report.pageText = await browser.evaluate('document.body.innerText').catch(String);
      report.exceptions = browser.exceptions; report.requests = browser.requests;
    }
    save(join(resumeRoot ? imageRoot : fixture.root, resumeRoot ? 'original-browser-resume-failure.json' : 'original-browser-failure.json'), { ...report, error: String(error) });
    console.log('ORIGINAL_BROWSER_FAILURE_ROOT=' + fixture.root); throw error;
  } finally { await browser?.close(); await host.close(); }
});

test('original current browser scopes keep single upload and batch selection independent', {
  skip: !enabled || !process.env.XUAN_TEST_BROWSER || !process.env.XUAN_TEST_BROWSER_SHA256 || !process.env.XUAN_TEST_WEB_ROOT,
  timeout: 120_000,
}, async () => {
  const { byKey } = selectedInputs();
  const fixture = createFullChainFixture({ name: 'original-current-ui', machine: true, units });
  const host = await openFullChainHost(fixture, process.env.XUAN_TEST_WEB_ROOT!);
  const browser = await openIsolatedBrowser(process.env.XUAN_TEST_BROWSER!, fixture.root);
  try {
    await navigate(browser, host);
    assert.equal(await browser.evaluate(`!!document.querySelector(${literal(autoPanel)})?.querySelector(${literal(batchPanel)})`), false);
    assert.equal(await browser.evaluate(`document.querySelector(${literal(autoForm)})?.querySelectorAll('input[type=file]').length`), 1);
    const item = byKey.dc_market_1!;
    await fill(browser, autoForm, '上传接收类别', 'data');
    await chooseFiles(browser, autoForm, [item.path]);
    await browser.until(`document.querySelector(${literal(autoForm)}+' .r1-material')?.textContent.includes(${literal(item.sha256)})`, '最终单件入口未保管真实原件');
    const materialId = await browser.evaluate<string>(`[...document.querySelector(${literal(autoForm)}).querySelectorAll('label')].find(e=>e.firstChild?.textContent==='已保管原件').querySelector('select').value`);
    assert.equal(sha(host.services.materials!.readOriginal(materialId).bytes), item.sha256);
    await chooseFiles(browser, batchPanel, [item.path, byKey.dc_market_2!.path]);
    await browser.until(`document.querySelector(${literal(batchPanel)})?.getAttribute('aria-busy')==='false'&&document.querySelector(${literal(batchPanel)})?.textContent.includes('本次选定文件')`, '最终批区未独立核对双件摘要');
    const selectedNames = await browser.evaluate<string[]>(`[...document.querySelector(${literal(batchPanel)}).querySelectorAll('details li')].map(e=>e.textContent)`);
    assert.equal(selectedNames.length, 2);
    assert.equal(browser.requests.filter(request => new URL(request.url).pathname === '/api/bd/materials/upload').length, 1);
    assert.ok(!browser.requests.some(request => /\/r1\/(?:auto|batches)\/start$/u.test(new URL(request.url).pathname)));
    assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedRequests, []);
    await screenshot(browser, join(fixture.root, 'final-independent-intake-scopes.png'), autoPanel);
    save(join(fixture.root, 'original-current-ui.json'), { root: fixture.root, webRoot: process.env.XUAN_TEST_WEB_ROOT,
      originalSha256: item.sha256, materialId, selectedNames, publicationRequests: 0,
      singleAndBatchAreParallelSections: true, browserRequests: browser.requests });
    console.log('ORIGINAL_CURRENT_UI_EVIDENCE_ROOT=' + fixture.root);
  } finally { await browser.close(); await host.close(); }
});
