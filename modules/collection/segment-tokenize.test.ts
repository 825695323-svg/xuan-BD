import assert from 'node:assert/strict';
import test from 'node:test';
import { ftsQuery, indexTokens, normalizeForIndex, tokenize } from './segments/tokenize.js';

test('CJK 按 2 字滑窗切分，2 字与 4 字词都可命中', () => {
  assert.deepEqual(tokenize('封装').tokens, ['封装']);
  assert.deepEqual(tokenize('先进封装').tokens, ['先进', '进封', '封装']);
  assert.equal(ftsQuery('封装'), '"封装"');
  assert.equal(ftsQuery('先进封装'), '"先进" AND "进封" AND "封装"');
});

test('单字成段保留单字，不补造词项', () => {
  assert.deepEqual(tokenize('白').tokens, ['白']);
  assert.equal(ftsQuery('白'), '"白"');
});

test('拉丁词与数字整段小写，全角经 NFKC 归一', () => {
  assert.deepEqual(tokenize('PE估值').tokens, ['pe', '估值']);
  assert.deepEqual(tokenize('688981.SH').tokens, ['688981', 'sh']);
  assert.equal(normalizeForIndex('ＰＥ'), 'pe');
  assert.equal(ftsQuery('688981.SH'), '"688981" AND "sh"');
});

test('空白与标点不产生词项，纯符号查询返回 null', () => {
  const result = tokenize('  ，。、 ');
  assert.deepEqual(result.tokens, []);
  assert.equal(ftsQuery('  ，。 '), null);
  assert.equal(ftsQuery(''), null);
});

test('重复词项去重但保留首次顺序，索引串以空格连接', () => {
  assert.equal(ftsQuery('封装封装'), '"封装" AND "装封"');
  assert.equal(indexTokens('先进封装'), '先进 进封 封装');
});
