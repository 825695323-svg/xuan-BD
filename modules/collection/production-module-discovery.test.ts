import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { isModelActionAllowed } from '../agent/model-tools.js';
import { ConversationProcessingBridge } from './conversation-processing.js';
import { ConversationAlgorithmBridge } from '../financial/conversation-algorithms.js';

test('AGENTS exposes five stages, factor library, WFD semantic dictionary and one common WFD read action', () => {
  const db = new CoreDatabase();
  try {
    const requested: string[] = [];
    const modules = {
      capability: (id: string) => ({ status: id === 'calculate' ? 'blocked' : 'ready',
        reason: id === 'calculate' ? 'host-disabled' : null }),
      capabilities: () => ({ modules: [
        { id: 'parse', status: 'ready', wfd: { readable: true } },
        { id: 'factor_library', status: 'ready', wfd: { readable: true } },
      ] }),
      calculate: () => { requested.push('calculate'); throw Error('must not run'); },
    };
    const companion = { processing: { catalog: () => ({ cleaningEngine: { status: 'ready' } }) },
      productionModules: modules, productionCalculation: { capabilities: () => ({
        version: 'bd.production-calculation/1', methods: [{ methodId: 'macro_yoy', status: 'ready' }] }) } };
    const bridge = new ConversationProcessingBridge({ database: db, core: {} as never,
      companion: companion as never, origin: () => null });
    const actions = ['data.module.parse', 'data.module.clean', 'data.module.structure',
      'data.module.annotate', 'data.module.check', 'data.factor.catalog',
      'data.semantic.lookup', 'data.module.read_wfd'];
    for (const action of actions) {
      const entry = bridge.registrations.find(x => x.action === action);
      assert.ok(entry, action);
      assert.equal(isModelActionAllowed(action), true);
      assert.equal(entry.available().available, true);
    }
    assert.equal(bridge.registrations.filter(item => actions.includes(item.action)).length, 8);
    assert.equal(requested.length, 0);
    const algorithms = new ConversationAlgorithmBridge({ database: db, core: {} as never,
      companion: companion as never, origin: () => null });
    assert.equal(algorithms.registrations.find(r => r.action === 'algorithms.calculate')?.available().available, false,
      'Disabling calculation in eight-port host must close old AGENTS execution action too');
    assert.equal(algorithms.registrations.find(r => r.action === 'bd.session.capabilities')?.available().available, true);
  } finally { db.close(); }
});
