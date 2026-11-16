import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openIsolatedBrowser, contrastRatio } from './r1-browser-test-support.js';
import type { R1PrepareInput, R1RequestView } from '../../contracts/r1-contracts.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { prepareReviewedR1Set, prepareReviewedR1Output, reviewR1Plan, submitReviewedR1Request, type R1ReviewPort } from '../web/src/r1-plan-review.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';

// Synthetic rules and rows use the real HTTP/TaskService/WFD path under an isolated root.
const isolated = { skip: !process.env.XUAN_FULL_CHAIN_ROOT || !process.env.WFD_PYTHON
  ? 'Requires explicitly selected isolated root and WFD_PYTHON.' : false, timeout: 180_000 };
function recipe(outputId: string): Omit<R1PrepareInput, 'requestId' | 'planId'> {
  return { outputId, source: { source_id: 'review-fixture', provider: 'synthetic-test', requested_url: 'test:review-fixture',
    requested_at_utc: '2026-01-06T09:00:00Z', acquired_at_utc: '2026-01-06T09:00:01Z', usage_scope: 'isolated-test',
    authorization: { status: 'authorized', basis: 'operator declared isolated synthetic test use' } },
    mapping: { kind: 'tabular_rows', businessKey: 'key', earliestUtc: 'start', latestExclusiveUtc: 'end',
      precision: 'day', sourceTimezone: 'Asia/Shanghai',
      fields: ['open','high','low','close','volume','amount'].map(fieldCode => ({ fieldCode, value: fieldCode, state: 'state' })),
      bar: { frequency: 'day', open: 'open', high: 'high', low: 'low', close: 'close', volume: 'volume', amount: 'amount' } },
    target: { datasetId: 'r1_review_test', outputKey: 'review.' + outputId, expectedParentSnapshotId: null,
      subject: { kind: 'instrument', namespace: 'r1.review.test', id: outputId }, inputMode: 'partial_observation',
      coverage: { scope: { synthetic_sample: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      definition: { semantic_code: 'review.' + outputId, measurement_nature: 'mixed_observation', unit_code: 'per_field',
        definition_authority: 'r1.review.test', time_role: 'observation',
        field_definitions: ['open','high','low','close','volume','amount'].map((field_code, index) => ({ field_code, data_type: 'decimal',
          unit_code: index < 4 ? 'cny_per_share' : index === 4 ? 'share' : 'cny', measurement_nature: index < 4 ? 'stock' : 'flow', time_role: 'observation' })),
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
          time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'Asia/Shanghai' },
          statistical: { price_basis: 'nominal', period_aggregation: 'period' }, financial: { price_adjustment: { direction: 'raw' } } },
        field_semantic_context: { volume: { measurement: { aggregation: 'period_total' } }, amount: { measurement: { aggregation: 'period_total' } } } } } };
}

test('HTTP multi-output review retains failed peer; selected confirmation publishes once and reopens fixed original receipt', isolated, async () => {
  const fixture = createFullChainFixture({ name: 'r1-plan-review', machine: true,
    units: { cny_per_share: { dimension: 'money_per_share' }, share: { dimension: 'quantity' }, cny: { dimension: 'money' } } });
  const browserPath = process.env.XUAN_TEST_BROWSER;
  const webRoot = browserPath ? resolve('dist/web') : undefined;
  let host = await openFullChainHost(fixture, webRoot);
  let browser: Awaited<ReturnType<typeof openIsolatedBrowser>> | undefined;
  let prepares = 0, submits = 0;
  const port: R1ReviewPort = {
    plan: id => host.call(`/processing/plans/${encodeURIComponent(id)}`),
    snapshotStatus: () => host.call('/r1/products/snapshot', {}),
    prepare: input => { prepares++; return host.call('/r1/prepare', input, 201); },
    get: id => host.call(`/r1/requests/${encodeURIComponent(id)}`),
    submit: view => { submits++; return host.call(`/r1/requests/${encodeURIComponent(view.requestId)}/submit`, { confirmationDigest: view.documentSha256 }, 202); },
  };
  try {
    assert.equal((await host.call('/r1/check', {})).supported, true);
    const materials: { outputId: string; materialId: string }[] = [];
    for (const outputId of ['good','bad']) {
      const raw = Buffer.from('key,start,end,open,high,low,close,volume,amount,state\n'
        + `${outputId},2026-01-04T16:00:00Z,2026-01-05T16:00:00Z,11.42,${outputId === 'good' ? '11.51' : '10'},11.41,11.50,100,1145,valid_value\n`);
      const uploaded = await host.upload(outputId + '.csv', 'data', raw, 'review-upload-' + outputId);
      const intake = await host.settled(uploaded.jobId);
      assert.equal(intake.status, 'succeeded', JSON.stringify(intake.error));
      const materialId = host.services.materials!.getByTask(intake.id)!.envelope.materialId;
      assert.deepEqual(host.services.materials!.readOriginal(materialId).bytes, raw);
      materials.push({ outputId, materialId });
    }
    const facts = { role: 'financial-record', informationNature: 'direct-observation', businessObject: 'market_bars',
      objectTime: 'synthetic object; explicit intervals', purpose: 'isolated-test', structureGranularity: 'table' };
    const dimensions = (index: number) => Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: facts[key],
      evidence: [{ source: 'operator', field: `routing.materials.${index}.dimensions.${key}`, quote: facts[key] }] }]));
    const input = { routing: { materials: materials.map((item, index) => ({ materialId: item.materialId, dimensions: dimensions(index), intendedAction: 'publish' })) },
      outputs: materials.map(({ outputId, materialId }) => {
        const draft = recipe(outputId);
        return { outputId, materialIds: [materialId], intendedAction: 'publish', stages: ['parse','structure','check'],
          tables: [{ materialId, format: 'csv', types: Object.fromEntries(['open','high','low','close','volume','amount'].map(key => [key, 'decimal_string'])) }],
          target: { declaration: { protocol: 'wfd.structured-ingest/1.0', target: draft.target, mapping: draft.mapping, source: draft.source }, expectedSnapshotId: null } };
      }) };
    const accepted = await host.call('/processing/plans', { requestId: 'review-multi-plan', input }, 202);
    const task = await host.settled(accepted.jobId);
    assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
    const planId = host.services.processing!.getByTask(task.id)!.plan!.planId;
    for (const outputId of ['good','bad']) for (const kind of ['parse','structure','check']) {
      const step = host.services.processing!.get(planId).steps.find(item => item.outputId === outputId && item.kind === kind)!;
      const acceptedStep = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: `review-${outputId}-${kind}` }, 202);
      const done = await host.settled(acceptedStep.jobId);
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      assert.equal(host.services.processing!.get(planId).steps.find(item => item.stepId === step.stepId)!.state, 'succeeded');
    }
    const review = reviewR1Plan(await port.plan(planId));
    assert.equal(review.outputs.length, 2);
    const good = review.outputs.find(output => output.outputId === 'good')!, bad = review.outputs.find(output => output.outputId === 'bad')!;
    assert.equal(good.eligible, true, JSON.stringify(good.reasons));
    assert.equal(bad.eligible, false);
    await assert.rejects(prepareReviewedR1Output(port, bad, 'review-blocked'), /阻断项/u);
    assert.equal(prepares, 0); assert.equal(submits, 0);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get()!.n, 0);
    const prepared = await prepareReviewedR1Output(port, good, 'review-independent');
    assert.equal(prepared.state, 'prepared_profile_pending');
    assert.equal(submits, 0, 'Preparation does not grant or execute publication');
    const replay = await prepareReviewedR1Output(port, good, prepared.requestId);
    assert.equal(replay.documentSha256, prepared.documentSha256);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get()!.n, 1);
    if (browserPath) {
      assert.equal(createHash('sha256').update(readFileSync(browserPath)).digest('hex'), process.env.XUAN_TEST_BROWSER_SHA256);
      browser = await openIsolatedBrowser(browserPath, fixture.root);
      const b = browser;
      const click = async (label: string) => {
        await b.until(`!![...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled)`, label);
        await b.evaluate(`(()=>{[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled).click()})()`);
      };
      const fill = async (label: string, value: string) => b.evaluate(`(()=>{
        const span=[...document.querySelectorAll('.r1-plan-review .ui-page-field-label')].find(e=>e.textContent===${JSON.stringify(label)});
        const input=span?.parentElement.querySelector('input'); if(!input||input.disabled)throw Error('Input unavailable');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
        input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      const openReview = async () => {
        await b.until(`(()=>{if(document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;document.querySelector('button[aria-label="数据库"]')?.click();return false;})()`, 'R1 page did not load');
        await click('已有计划多输出审阅');
        await b.until(`!!document.querySelector('.r1-plan-review')`, 'Review panel missing');
      };
      await b.page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
      await b.page('Page.navigate', { url: host.base.replace('/api/bd', '/') });
      await openReview();
      await fill('处理计划编号', planId); await click('读取计划与质量');
      await b.until(`document.querySelectorAll('.r1-plan-review-output').length===2`, 'All plan outputs must remain visible');
      assert.equal(await b.evaluate(`document.querySelectorAll('.r1-plan-review input[type=radio]:checked').length`), 0);
      await b.evaluate(`document.querySelectorAll('.r1-plan-review-output input')[1].click()`);
      await b.until(`!![...document.querySelectorAll('.r1-plan-review button')].find(e=>e.textContent==='仅准备所选输出'&&e.disabled)`, 'Failed output became preparable');
      await fill('原 R1 请求编号', prepared.requestId); await click('查询原请求');
      await b.until(`!!document.querySelector('.r1-plan-review input[type=checkbox]')`, 'Original prepare receipt not shown');
      await b.evaluate(`document.querySelector('.r1-plan-review input[type=checkbox]').click()`);
      await click('查询原请求');
      await b.until(`!!document.querySelector('.r1-plan-review input[type=checkbox]')&&!document.querySelector('.r1-plan-review input[type=checkbox]').checked`, 'Query must revoke the earlier checkbox');
      const beforeReload = b.requests.length;
      await b.page('Page.reload'); await openReview();
      assert.equal(await b.evaluate(`document.querySelector('.r1-plan-review input[type=checkbox]')===null`), true);
      assert.equal(await b.evaluate(`(()=>{const s=[...document.querySelectorAll('.r1-plan-review .ui-page-field-label')].find(e=>e.textContent==='原 R1 请求编号');return s.parentElement.querySelector('input').value})()`), prepared.requestId);
      assert.equal(b.requests.slice(beforeReload).filter(r=>r.method==='POST'&&r.url.endsWith('/submit')).length, 0);
      await click('查询原请求');
      await b.until(`!!document.querySelector('.r1-plan-review input[type=checkbox]')`, 'Reopened view not loaded');
      const imageRoot = process.env.XUAN_REVIEW_VISUAL_ROOT;
      if (imageRoot) mkdirSync(imageRoot, { recursive: true });
      for (const theme of ['light','dark']) for (const width of [1440,375]) {
        await b.page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        await b.page('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
        await b.until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`, 'Theme provider mismatch');
        const metrics = await b.evaluate<{ overflow: string[]; contrast: string[]; small: number }>(`(()=>{const panel=document.querySelector('.r1-plan-review');const s=getComputedStyle(panel);return {
          overflow:[...panel.querySelectorAll('input,button,select,textarea')].filter(e=>e.getBoundingClientRect().width>0&&(e.getBoundingClientRect().right>innerWidth+2||e.getBoundingClientRect().left< -2)).map(e=>e.tagName),
          contrast:[s.color,s.backgroundColor], small:[...panel.querySelectorAll('.r1-plan-review-meta')].filter(e=>parseFloat(getComputedStyle(e).fontSize)<12).length};})()`);
        assert.deepEqual(metrics.overflow, []); assert.equal(metrics.small, 0);
        assert.ok(contrastRatio(metrics.contrast[0]!, metrics.contrast[1]!) >= 4.5);
        if (imageRoot) {
          const picture = await b.page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          writeFileSync(join(imageRoot, `review-${theme}-${width}.png`), Buffer.from(picture.data, 'base64'));
        }
      }
      await b.evaluate(`document.querySelector('.r1-plan-review input[type=checkbox]').focus()`);
      await b.page('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await b.page('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      await b.until(`document.querySelector('.r1-plan-review input[type=checkbox]').checked`, 'Keyboard confirmation not reachable');
      const beforeSubmit = b.requests.length;
      await b.evaluate(`(()=>{const button=[...document.querySelectorAll('.r1-plan-review button')].find(e=>e.textContent==='确认并提交此输出');button.click();button.click();})()`);
      await b.until(`document.querySelector('.r1-plan-review input[type=checkbox]')===null`, 'Submission should consume confirmation');
      // Querying the backend here observes the real accepted task, not a fabricated UI success.
      let acceptedView = await port.get(prepared.requestId);
      for (let attempt=0; !acceptedView.submitTaskId && attempt<50; attempt++) {
        await new Promise(resolve=>setTimeout(resolve,100)); acceptedView=await port.get(prepared.requestId);
      }
      assert.ok(acceptedView.submitTaskId);
      const done = await host.settled(acceptedView.submitTaskId!);
      assert.equal(done.status,'succeeded',JSON.stringify(done.error));
      await click('查询原请求');
      await b.until(`document.querySelector('.r1-plan-review').textContent.includes('associated')`, 'Final fixed receipt missing');
      assert.equal(b.requests.slice(beforeSubmit).filter(r=>r.method==='POST'&&r.url.endsWith('/submit')).length,1,'Double click must not duplicate the request');
      assert.deepEqual(b.exceptions,[]); assert.deepEqual(b.blockedRequests,[]);
      console.log('R1_REVIEW_BROWSER_OK: real HTTP + WFD; 2 themes/2 widths; keyboard confirmation; reload read-only; double-click single submit');
      await browser.close(); browser=undefined;
    } else {
      const submitted = await submitReviewedR1Request(port, prepared) as { jobId: string };
      const done = await host.settled(submitted.jobId);
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    }
    const fixed: R1RequestView = await port.get(prepared.requestId);
    assert.equal(fixed.state, 'associated'); assert.equal(fixed.rowCount, 1);
    assert.equal(fixed.rowSummary?.inserted, 1); assert.equal(submits, browserPath ? 0 : 1);
    const associations = fixed.local.associations as unknown[];
    assert.equal(associations.length, 1, 'A successful state requires real fixed record associations');
    await assert.rejects(submitReviewedR1Request(port, fixed), /查询或恢复/u);
    assert.equal(submits, browserPath ? 0 : 1);
    await host.close(); host = await openFullChainHost(fixture);
    const reopened = await port.get(prepared.requestId);
    assert.equal(reopened.documentSha256, fixed.documentSha256);
    assert.equal(reopened.state, 'associated');
    assert.deepEqual(reopened.local.associations, fixed.local.associations);
    const reopenedReview = reviewR1Plan(await port.plan(planId));
    assert.equal(reopenedReview.outputs.find(output => output.outputId === 'bad')!.eligible, false);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get()!.n, 1);
  } finally { await browser?.close(); await host.close(); }
});


/** Fresh synthetic inputs, real host processing, no fabricated WFD records or receipts. */
async function preparedSetPlan(host: Awaited<ReturnType<typeof openFullChainHost>>, prefix: string,
  options: { badMember?: boolean; unknownUnit?: boolean } = {}) {
  const materials: { outputId: string; materialId: string }[] = [];
  for (const outputId of ['left', 'right']) {
    const raw = Buffer.from('key,start,end,open,high,low,close,volume,amount,state\n'
      + `${prefix}-${outputId},2026-01-04T16:00:00Z,2026-01-05T16:00:00Z,11.42,${options.badMember && outputId === 'right' ? '10' : '11.51'},11.41,11.50,100,1145,valid_value\n`);
    const uploaded = await host.upload(outputId + '.csv', 'data', raw, prefix + '-upload-' + outputId);
    const task = await host.settled(uploaded.jobId);
    assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
    materials.push({ outputId, materialId: host.services.materials!.getByTask(task.id)!.envelope.materialId });
  }
  const facts = { role: 'financial-record', informationNature: 'direct-observation', businessObject: 'market_bars',
    objectTime: 'synthetic set objects; explicit intervals', purpose: 'isolated-test', structureGranularity: 'table' };
  const drafts = materials.map(({ outputId }) => {
    const draft = recipe(outputId);
    draft.source.source_id = prefix + '-' + outputId;
    if (options.unknownUnit && outputId === 'left') {
      const fields = draft.target.definition.field_definitions as { field_code: string; unit_code: string }[];
      for (const field of fields.filter(field => ['open','high','low','close'].includes(field.field_code)))
        field.unit_code = 'synthetic_unregistered_currency';
    }
    return draft;
  });
  const input = { consistencyGroups: { pair: ['left','right'] },
    routing: { materials: materials.map((item, index) => ({ materialId: item.materialId, intendedAction: 'publish',
      dimensions: Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: facts[key],
        evidence: [{ source: 'operator', field: `routing.materials.${index}.dimensions.${key}`, quote: facts[key] }] }])) })) },
    outputs: materials.map(({ outputId, materialId }, index) => {
      const draft = drafts[index]!;
      return { outputId, materialIds: [materialId], intendedAction: 'publish', stages: ['parse','structure','check'],
        tables: [{ materialId, format: 'csv', types: Object.fromEntries(['open','high','low','close','volume','amount'].map(key => [key,'decimal_string'])) }],
        target: { declaration: { protocol: 'wfd.structured-ingest/1.0', target: draft.target, mapping: draft.mapping, source: draft.source }, expectedSnapshotId: null } };
    }) };
  const prepared = await host.call('/processing/plans', { requestId: prefix + '-plan', input }, 202);
  const done = await host.settled(prepared.jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const planId = host.services.processing!.getByTask(done.id)!.plan!.planId;
  for (const { outputId } of materials) for (const kind of ['parse','structure','check']) {
    const step = host.services.processing!.get(planId).steps.find(item => item.outputId === outputId && item.kind === kind)!;
    const accepted = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: `${prefix}-${outputId}-${kind}` }, 202);
    const result = await host.settled(accepted.jobId);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
  }
  return { planId, drafts, materials, input };
}
const setFixture = (name: string) => createFullChainFixture({ name, machine: true,
  units: { cny_per_share: { dimension: 'money_per_share' }, share: { dimension: 'quantity' }, cny: { dimension: 'money' } } });
function reviewPort(host: () => Awaited<ReturnType<typeof openFullChainHost>>): R1ReviewPort {
  return { plan: id => host().call(`/processing/plans/${id}`), snapshotStatus: () => host().call('/r1/products/snapshot', {}),
    prepare: value => host().call('/r1/prepare', value, 201), prepareSet: value => host().call('/r1/prepare', value, 201),
    get: id => host().call(`/r1/requests/${id}`),
    submit: view => host().call(`/r1/requests/${view.requestId}/submit`, { confirmationDigest: view.documentSha256 }, 202) };
}

test('HTTP declared set is one document, explicit whole confirmation, two fixed member links, reopen without resubmit', isolated, async () => {
  const fixture = setFixture('r1-set');
  const browserPath = process.env.XUAN_TEST_BROWSER;
  let host = await openFullChainHost(fixture, browserPath ? resolve('dist/web') : undefined);
  const port = reviewPort(() => host);
  let browser: Awaited<ReturnType<typeof openIsolatedBrowser>> | undefined;
  let actualSubmits = 0;
  try {
    const built = await preparedSetPlan(host, 'set-success');
    const plan = reviewR1Plan(await port.plan(built.planId));
    assert.equal(plan.sets[0]!.eligible, true, JSON.stringify(plan));
    assert.ok(plan.outputs.every(item => !item.eligible));
    await assert.rejects(host.services.r1Workspace!.prepareWithRestriction({ ...built.drafts[0], requestId: 'split-set', planId: built.planId }),
      (error: unknown) => (error as { code?: string }).code === 'R1_SET_WHOLE_REQUIRED');
    const setInput = { kind: 'publication_set' as const, requestId: 'set-whole', planId: built.planId, setId: 'pair' };
    await assert.rejects(host.services.r1Workspace!.prepareWithRestriction({ ...setInput, outputIds: ['left'] }));
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get()!.n, 0);
    const [prepared, concurrent] = await Promise.all([
      prepareReviewedR1Set(port, plan.sets[0]!, setInput.requestId),
      prepareReviewedR1Set(port, plan.sets[0]!, setInput.requestId),
    ]);
    assert.equal(concurrent.documentSha256, prepared.documentSha256, 'Concurrent identical preparation must return the same accepted document');
    assert.equal(prepared.rowCount, 2);
    assert.equal(prepared.submitTaskId, null);
    assert.deepEqual(prepared.publicationSet!.members.map(member => member.outputId), ['left','right']);
    assert.ok(prepared.publicationSet!.members.every(member => member.state === 'not_submitted'));
    const replay = await port.prepareSet!(setInput);
    assert.equal(replay.documentSha256, prepared.documentSha256);
    const attempt = host.services.r1!.attempt(prepared.requestId);
    const document = JSON.parse(String(attempt.document_json));
    assert.equal(document.outputs.length, 2);
    assert.deepEqual(document.consistency_groups, { pair: ['review.left','review.right'] });
    assert.equal(document.duplicate_policy, undefined, 'Whole-member conflict is not converted to row-skipping partial success');
    assert.doesNotMatch(JSON.stringify(document), /requested_url|source_id|process_refs|original_path/u);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get()!.n, 1);
    const rejected = await host.call(`/r1/requests/${prepared.requestId}/submit`, { confirmationDigest: '0'.repeat(64) }, 409);
    assert.equal(rejected.code, 'R1_CONFIRMATION_CHANGED');
    const client = host.services.r1Runtime!.client, submit = client.submit.bind(client);
    client.submit = async (...args) => { actualSubmits++; assert.equal((args[0].outputs as unknown[]).length, 2); return submit(...args); };
    if (browserPath) {
      assert.equal(createHash('sha256').update(readFileSync(browserPath)).digest('hex'), process.env.XUAN_TEST_BROWSER_SHA256);
      browser = await openIsolatedBrowser(browserPath, fixture.root);
      const b = browser;
      const click = async (label: string) => {
        await b.until(`!![...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled)`, label);
        await b.evaluate(`(()=>{[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.disabled).click()})()`);
      };
      const fill = async (label: string, value: string) => b.evaluate(`(()=>{
        const l=[...document.querySelectorAll('.r1-plan-review .ui-page-field-label')].find(e=>e.textContent===${JSON.stringify(label)});
        const e=l.parentElement.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});
        e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await b.page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
      await b.page('Page.navigate', { url: host.base.replace('/api/bd','/') });
      await b.until(`(()=>{if(document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;document.querySelector('button[aria-label="数据库"]')?.click();return false;})()`, 'R1 page unavailable');
      await click('已有计划多输出审阅');
      await fill('处理计划编号', built.planId); await click('读取计划与质量');
      await b.until(`document.querySelectorAll('.r1-plan-review-set').length===1`, 'Set membership must be visible');
      await b.evaluate(`document.querySelector('.r1-plan-review-set input').click()`);
      await b.until(`!![...document.querySelectorAll('.r1-plan-review button')].find(e=>e.textContent==='仅准备整个集合'&&!e.disabled)`, 'Whole-set prepare unavailable');
      // Read the pre-existing exact request; the UI must not create a second preparation.
      await fill('原 R1 请求编号', prepared.requestId); await click('查询原请求');
      await b.until(`document.querySelector('[aria-label="集合逐成员回执"]')?.textContent.includes('review.right')`, 'Both member receipts required');
      const imageRoot = process.env.XUAN_REVIEW_VISUAL_ROOT;
      for (const theme of ['light','dark']) for (const width of [1440,375]) {
        await b.page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        await b.page('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
        await b.until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`, 'Set view theme mismatch');
        const overflow = await b.evaluate<string[]>(`[...document.querySelectorAll('.r1-plan-review input,.r1-plan-review button')].filter(e=>e.getBoundingClientRect().width>0&&(e.getBoundingClientRect().right>innerWidth+2||e.getBoundingClientRect().left< -2)).map(e=>e.tagName)`);
        assert.deepEqual(overflow, []);
        if (imageRoot) { mkdirSync(imageRoot, { recursive: true }); const image=await b.page('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
          writeFileSync(join(imageRoot, `set-${theme}-${width}.png`), Buffer.from(image.data,'base64')); }
      }
      await b.evaluate(`document.querySelector('.r1-plan-review input[type=checkbox]').click()`);
      await click('查询原请求');
      await b.until(`!!document.querySelector('.r1-plan-review input[type=checkbox]')&&!document.querySelector('.r1-plan-review input[type=checkbox]').checked`, 'Requery must reset whole-set confirmation');
      await b.evaluate(`document.querySelector('.r1-plan-review input[type=checkbox]').click()`);
      const before = b.requests.length;
      await b.evaluate(`(()=>{const e=[...document.querySelectorAll('.r1-plan-review button')].find(e=>e.textContent==='确认并提交整个集合');e.click();e.click();})()`);
      await b.until(`document.querySelector('.r1-plan-review input[type=checkbox]')===null`, 'Whole-set confirmation not consumed');
      let accepted = await port.get(prepared.requestId);
      for (let i=0; !accepted.submitTaskId && i<50; i++) { await new Promise(resolve=>setTimeout(resolve,100)); accepted=await port.get(prepared.requestId); }
      assert.ok(accepted.submitTaskId);
      const done = await host.settled(accepted.submitTaskId!);
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      assert.equal(b.requests.slice(before).filter(item=>item.method==='POST'&&item.url.endsWith('/submit')).length,1);
      await click('查询原请求');
      await b.until(`document.querySelector('[aria-label="集合逐成员回执"]')?.textContent.includes('published')`, 'Published set receipts absent');
      const reloadStart=b.requests.length;
      await b.page('Page.reload');
      await b.until(`!!document.querySelector('.r1-panel')`, 'Reload failed');
      assert.equal(b.requests.slice(reloadStart).filter(item=>item.method==='POST'&&item.url.endsWith('/submit')).length,0);
      assert.deepEqual(b.exceptions, []); assert.deepEqual(b.blockedRequests, []);
      await browser.close(); browser=undefined;
      console.log('R1_SET_BROWSER_OK: one document, two member receipts, exact confirmation, no duplicate submit');
    } else {
      const accepted = await submitReviewedR1Request(port, prepared) as { jobId: string };
      const repeat = await host.call(`/r1/requests/${prepared.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
      assert.equal(repeat.jobId, accepted.jobId);
      const done = await host.settled(accepted.jobId);
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    }
    const fixed = await port.get(prepared.requestId);
    assert.equal(fixed.state, 'associated', JSON.stringify(fixed.error));
    assert.ok(fixed.publicationSet!.members.every(member=>member.state==='published'));
    assert.equal(new Set(fixed.publicationSet!.members.map(member=>member.snapshotId)).size,1);
    const links=fixed.local.associations as Record<string,unknown>[];
    assert.equal(links.length,2); assert.equal(new Set(links.map(link=>link.original_id)).size,2);
    assert.equal(new Set(links.map(link=>link.source_id)).size,2);
    for(const member of fixed.publicationSet!.members) {
      const link=links.find(link=>link.product_id===member.productId)!;
      assert.equal(link.source_id,'set-success-'+member.outputId);
      const refs=host.services.r1!.recordMaterials({datasetId:fixed.datasetId,productId:member.productId!,recordId:String(link.record_id),recordVersion:String(link.record_version)});
      assert.deepEqual(refs?.materialIds,[built.materials.find(m=>m.outputId===member.outputId)!.materialId]);
    }
    assert.equal(actualSubmits,1);
    await host.close(); host=await openFullChainHost(fixture);
    const reopened=await port.get(prepared.requestId);
    assert.equal(reopened.documentSha256,fixed.documentSha256);
    assert.deepEqual(reopened.publicationSet,fixed.publicationSet);
    assert.deepEqual(reopened.local.associations,fixed.local.associations);
    await assert.rejects(submitReviewedR1Request(port,reopened),/查询或恢复/u);
  } finally { await browser?.close(); await host.close(); }
});

test('HTTP set preparation refuses a failed member and cannot replace frozen membership', isolated, async () => {
  const fixture=setFixture('r1-set-blocked'); const host=await openFullChainHost(fixture);
  try {
    const built=await preparedSetPlan(host,'set-blocked',{badMember:true});
    const view=reviewR1Plan(await host.call(`/processing/plans/${built.planId}`));
    assert.equal(view.sets[0]!.eligible,false);
    const input={kind:'publication_set',requestId:'blocked-set',planId:built.planId,setId:'pair'};
    const failure=await host.call('/r1/prepare',input,409);
    assert.equal(failure.code,'R1_PROCESS_NOT_READY');
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get()!.n,0);
    assert.equal((await host.call('/r1/products/snapshot',{})).snapshotId,null);
    const alternate=structuredClone(built.input); alternate.consistencyGroups.pair=['left'];
    const invalid = await host.call('/processing/plans', { requestId: 'illegal-membership', input: alternate }, 409);
    assert.equal(invalid.code, 'PROCESSING_PUBLICATION_SET');
  } finally { await host.close(); }
});

test('HTTP lost whole-set response recovers both original members with no second submission', isolated, async () => {
  const fixture=setFixture('r1-set-lost'); let host=await openFullChainHost(fixture); const port=reviewPort(()=>host);
  try {
    const built=await preparedSetPlan(host,'set-lost');
    const selected=reviewR1Plan(await port.plan(built.planId)).sets[0]!;
    const prepared=await prepareReviewedR1Set(port,selected,'lost-set');
    const client=host.services.r1Runtime!.client, submit=client.submit.bind(client); let sends=0;
    client.submit=async(...args)=>{sends++; await submit(...args); throw Object.assign(new Error('synthetic lost response after actual publish'),{code:'TEST_RESPONSE_LOST',mayHaveBeenAccepted:true});};
    const accepted=await port.submit(prepared) as {jobId:string}; await host.settled(accepted.jobId);
    const unknown=await port.get(prepared.requestId);
    assert.equal(unknown.state,'pending_unknown');
    assert.equal((unknown.local.associations as unknown[]).length,0);
    assert.ok(unknown.publicationSet!.members.every(member=>member.state==='pending_receipt'));
    assert.equal(sends,1);
    await host.close(); host=await openFullChainHost(fixture);
    host.services.r1Runtime!.client.submit=async()=>{throw new Error('Recovery must not resubmit');};
    const recovered=await host.call(`/r1/requests/${prepared.requestId}/recover`,{lookupId:'recover-set'},202);
    const done=await host.settled(recovered.jobId);
    assert.equal(done.status,'succeeded',JSON.stringify(done.error));
    const fixed=await port.get(prepared.requestId);
    assert.equal(fixed.state,'associated',JSON.stringify(fixed.error));
    assert.equal(fixed.documentSha256,prepared.documentSha256);
    assert.equal((fixed.local.associations as unknown[]).length,2);
    assert.ok(fixed.publicationSet!.members.every(member=>member.state==='published'));
    assert.equal(new Set(fixed.publicationSet!.members.map(member=>member.snapshotId)).size,1);
  } finally {await host.close();}
});

test('HTTP actual WFD rejects an unsupported member unit, preserves both set failures after reopen', isolated, async () => {
  const fixture=setFixture('r1-set-rejected'); let host=await openFullChainHost(fixture); const port=reviewPort(()=>host);
  try {
    const built=await preparedSetPlan(host,'set-rejected',{unknownUnit:true});
    const plan=reviewR1Plan(await port.plan(built.planId));
    assert.equal(plan.sets[0]!.eligible,true,JSON.stringify(plan.outputs.map(output=>({id:output.outputId,reasons:output.reasons,gaps:output.gaps}))));
    const prepared=await prepareReviewedR1Set(port,plan.sets[0]!,'rejected-set');
    const accepted=await port.submit(prepared) as {jobId:string}; await host.settled(accepted.jobId);
    const failed=await port.get(prepared.requestId);
    assert.equal(failed.state,'rejected',JSON.stringify(failed));
    assert.ok(failed.publicationSet!.members.every(member=>member.state==='failed'));
    assert.equal((failed.local.associations as unknown[]).length,0);
    assert.equal((await host.call('/r1/products/snapshot',{})).snapshotId,null);
    await host.close();host=await openFullChainHost(fixture);
    const reopened=await port.get(prepared.requestId);
    assert.deepEqual(reopened.publicationSet,failed.publicationSet);
    assert.equal(reopened.state,'rejected');
    await assert.rejects(submitReviewedR1Request(port,reopened),/查询或恢复/u);
  } finally {await host.close();}
});

test('HTTP incomplete, mixed-snapshot and half-group receipts remain unassociated until original status recovery', isolated, async () => {
  for (const fault of ['missing_member','mixed_snapshot','half_group'] as const) {
    const fixture=setFixture('r1-set-'+fault.replaceAll('_','-')); const host=await openFullChainHost(fixture);
    const port=reviewPort(()=>host);
    try {
      const built=await preparedSetPlan(host,'set-'+fault);
      const selected=reviewR1Plan(await port.plan(built.planId)).sets[0]!;
      const prepared=await prepareReviewedR1Set(port,selected,'fault-'+fault);
      const client=host.services.r1Runtime!.client, submit=client.submit.bind(client);
      let sends=0;
      client.submit=async(...args)=>{
        sends++; const actual=await submit(...args); const result=structuredClone(actual.result);
        const outputs=result.output_results as Record<string,unknown>[];
        assert.equal(outputs.length,2);
        if(fault==='missing_member') outputs.pop();
        else if(fault==='mixed_snapshot') outputs[1]!.snapshot_id='s_'+ '0'.repeat(24);
        else { outputs[1]!.publication_state='not_published'; outputs[1]!.records=[];
          outputs[1]!.errors=[{code:'TEST_INCOMPLETE_SET'}]; result.state='partially_published_formal'; }
        return {...actual,result};
      };
      const started=await port.submit(prepared) as {jobId:string}; await host.settled(started.jobId);
      const pending=await port.get(prepared.requestId);
      assert.equal(pending.state,'pending_receipt',JSON.stringify(pending));
      assert.equal((pending.local.associations as unknown[]).length,0,'No partial association may escape an invalid whole-set receipt');
      assert.ok(pending.publicationSet!.members.every(member=>member.state!=='published'));
      client.submit=async()=>{throw new Error('Do not resubmit after actual acceptance');};
      const recovery=await host.call(`/r1/requests/${prepared.requestId}/recover`,{lookupId:'repair-'+fault},202);
      const task=await host.settled(recovery.jobId);
      assert.equal(task.status,'succeeded',JSON.stringify(task.error));
      const complete=await port.get(prepared.requestId);
      assert.equal(complete.state,'associated');
      assert.equal((complete.local.associations as unknown[]).length,2);
      assert.ok(complete.publicationSet!.members.every(member=>member.state==='published'));
      assert.equal(sends,1);
    } finally {await host.close();}
  }
});
