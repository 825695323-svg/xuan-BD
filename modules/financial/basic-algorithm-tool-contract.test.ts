import assert from 'node:assert/strict';
import test from 'node:test';
import type { AlgorithmCatalogView } from './algorithm-types.js';
import { basicAlgorithmToolContract, bdSessionToolContract } from './basic-algorithm-tool-contract.js';

const catalog = { methods: [
  { id: 'ma', title: '移动均线', status: 'ready', reason: null, methodVersion: 'ma/full-window-v1',
    implementationVersion: 'sha256:test', parameters: { type: 'object', required: ['period'] },
    requiredFields: ['timestamp', 'close'], outputFields: ['MA'], limitations: [] },
  { id: 'macd', title: 'MACD', status: 'blocked', reason: '采用尚未完成', methodVersion: 'macd/test',
    implementationVersion: 'sha256:test', parameters: {}, requiredFields: ['timestamp', 'close'],
    outputFields: ['MACD'], limitations: [] },
] } as unknown as AlgorithmCatalogView;

test('统一契约列出独立方法，但不能把未实现观测均线宣称为可执行', () => {
  const contract = basicAlgorithmToolContract(catalog);
  assert.equal(contract.agentTriggered, true);
  assert.equal(contract.uiExecution, false);
  assert.equal(contract.agentMaySelfAuthorize, false);
  assert.deepEqual(contract.methods.slice(0, 3).map(item => item.methodId), ['ma', 'macd', 'source_observation_ma']);
  assert.equal(contract.methods.find(item => item.methodId === 'ema')!.status, 'blocked');
  assert.equal(contract.methods.find(item => item.methodId === 'ma')!.input.kind, 'fixed_snapshot');
  assert.equal(contract.methods.find(item => item.methodId === 'macd')!.status, 'blocked');
  assert.equal(contract.methods.find(item => item.methodId === 'source_observation_ma')!.status, 'blocked');
  assert.equal(contract.methods.find(item => item.methodId === 'ma')!.output.publication, 'not_requested');
});

test('按算法编号只读返回明确接口，不把未知方法当成可执行', () => {
  const chosen = basicAlgorithmToolContract(catalog, 'ma');
  assert.equal(chosen.methods.length, 1);
  assert.equal(chosen.methods[0]!.methodId, 'ma');
  const unknown = basicAlgorithmToolContract(catalog, 'not_registered');
  assert.equal(unknown.unknownMethod, true);
  assert.equal(unknown.methods.length, 0);
});

test('BD AGENTS 会话入口只声明既有工具，算法不反向触发原报管线', () => {
  const contract = bdSessionToolContract(catalog);
  assert.equal(contract.entry, 'bd_agents.conversation');
  assert.equal(contract.backgroundCalculation, false);
  assert.equal(contract.uiCalculation, false);
  assert.equal(contract.toolGroups.length, 5);
  assert.ok(contract.toolGroups.find(item => item.id === 'files')!.tools.includes('material.read'));
  assert.ok(contract.toolGroups.find(item => item.id === 'api_sources')!.tools.includes('source.api.read'));
  assert.ok(contract.toolGroups.find(item => item.id === 'basic_algorithms')!.tools.includes('algorithms.contract'));
  assert.equal(contract.algorithms.sourcePolicy.includes('WFD fixed snapshot only'), true);
});


test('new task contract never recommends bulk processing; module actions derive from existing ports', async () => {
  const { processingSessionContract, PRODUCTION_MODULES, stepModuleForAction } = await import('../collection/production-module-ports.js');
  const processing = processingSessionContract();
  const files = bdSessionToolContract(catalog).toolGroups.find(item => item.id === 'files')!;
  assert.equal(processing.execute, 'data.processing.execute');
  assert.deepEqual(processing.moduleActions,
    PRODUCTION_MODULES.filter(module => stepModuleForAction(module.action) !== null).map(module => module.action));
  assert.ok(files.tools.includes(processing.execute));
  assert.ok(files.tools.includes(processing.recover), 'existing single-step plans retain explicit artifact recovery');
  assert.equal(files.tools.includes('data.processing.run'), false);
  assert.deepEqual(files.legacyRecovery, processing.legacyRecovery);
  assert.equal(files.legacyRecovery?.newTasks, false);
});

test('BD capability response and session tool groups agree about stepwise work and historical recovery', async () => {
  const { CoreDatabase } = await import('../../platform/state/database.js');
  const { ConversationAlgorithmBridge } = await import('./conversation-algorithms.js');
  const { processingSessionContract } = await import('../collection/production-module-ports.js');
  const database = new CoreDatabase(':memory:');
  let dispatchChecks = 0;
  try {
    const bridge = new ConversationAlgorithmBridge({
      database, core: {} as never, origin: () => ({ conversationId: 'isolated', branchId: 'main' } as never),
      companion: { bd: { assertDispatch: () => { dispatchChecks++; } },
        processing: { catalog: () => ({ cleaningEngine: { status: 'ready' } }),
          moduleCapability: () => ({ status: 'ready', engine: 'fixed' }) } } as never,
    });
    const result = await bridge.execute({ task: { id: 'capability-only', action: 'bd.session.capabilities', args: {} },
      signal: new AbortController().signal, assertAuthorized: () => ({ approvalId: null }) } as never);
    const preview = (result.data as any).modelPreview;
    assert.equal(preview.onDemand.cleaning.execute, processingSessionContract().execute);
    assert.equal(preview.onDemand.cleaning.recover, 'data.processing.recover');
    assert.deepEqual(preview.onDemand.cleaning.moduleActions, processingSessionContract().moduleActions);
    assert.equal(preview.onDemand.cleaning.legacyRecovery.newTasks, false);
    assert.equal(dispatchChecks, 1);
    assert.equal(preview.parallelModuleDirectory.autoTrigger, false);
  } finally { database.close(); }
});
