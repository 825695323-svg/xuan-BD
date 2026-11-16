import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openIsolatedBrowser, contrastRatio } from './r1-browser-test-support.js';
import type { R1PrepareInput, R1RequestView } from '../../contracts/r1-contracts.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { prepareReviewedR1Output, reviewR1Plan, submitReviewedR1Request, type R1ReviewPort } from '../web/src/r1-plan-review.js';
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
        field_semantic_context: { volume: { measurement: { aggregation: 'period_total' } }, amount: { measurement: { aggregation: 'period_total' } } } } } } };
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
