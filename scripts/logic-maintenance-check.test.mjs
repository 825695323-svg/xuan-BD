import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyDiagnostics } from './logic-maintenance-check.mjs';

test('本轮范围告警失败，历史范围仅允许明确的未使用声明代码', () => {
  const checked = new Set(['apps/web/src/App.tsx']);
  const result = classifyDiagnostics([
    "apps\\web\\src\\App.tsx(2,3): error TS6133: 'obsolete' is declared but never read.",
    "modules/old.ts(9,1): error TS6196: 'OldShape' is declared but never used.",
    "modules/old.ts(10,1): error TS2322: Type 'number' is not assignable to type 'string'.",
    'unexpected compiler error',
  ].join('\n'), checked);
  assert.equal(result.failures.length, 3);
  assert.equal(result.deferred.length, 1);
  assert.match(result.deferred[0], /OldShape/u);
});

test('空输出没有历史告警，不借空输出伪造错误分类', () => {
  assert.deepEqual(classifyDiagnostics('\n\r\n'), { failures: [], deferred: [] });
});
