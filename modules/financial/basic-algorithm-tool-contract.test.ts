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
  assert.equal(contract.manualOnly, true);
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
  assert.equal(contract.toolGroups.length, 5);
  assert.ok(contract.toolGroups.find(item => item.id === 'files')!.tools.includes('material.read'));
  assert.ok(contract.toolGroups.find(item => item.id === 'api_sources')!.tools.includes('source.api.read'));
  assert.ok(contract.toolGroups.find(item => item.id === 'basic_algorithms')!.tools.includes('algorithms.contract'));
  assert.equal(contract.algorithms.sourcePolicy.includes('WFD fixed snapshot only'), true);
});
