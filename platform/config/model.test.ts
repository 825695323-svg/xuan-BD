import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelConfiguration } from './model.js';

const model = {
  provider: 'workbuddy_cn', model: 'deepseek-v4.1-flash', defaultThinkingLevel: 'off',
  customModel: { api: 'openai-completions', baseUrl: 'https://api.example.com/v1',
    name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, maxTokens: 65_536,
    input: ['text'], reasoning: false },
  credential: { kind: 'dsh-ref', path: '/tmp/credentials.yaml', ref: 'WORKBUDDY_BRIDGE_KEY' },
};

test('model connection accepts only an explicit local HTTP loopback endpoint', () => {
  const parse = (baseUrl: string) => parseModelConfiguration({
    ...model, customModel: { ...model.customModel, baseUrl },
  });
  assert.equal(parse('https://api.example.com/v1').customModel.baseUrl, 'https://api.example.com/v1');
  assert.equal(parse('http://127.0.0.1:18790/v1').customModel.baseUrl, 'http://127.0.0.1:18790/v1');
  for (const url of ['http://localhost:18790/v1', 'http://127.0.0.2:18790/v1',
    'http://api.example.com/v1', 'http://127.0.0.1/v1', 'http://127.0.0.1:18790/v1?key=x',
    'http://user:pass@127.0.0.1:18790/v1']) {
    assert.throws(() => parse(url), { name: 'ConfigError' }, url);
  }
});
