/**
 * 固定截面上的声明式规则筛选；调用者负责 WFD 固定读取和历史可见性。
 * 语义参考 henrylin99/quantitative_analysis@2edbc3ea 的 strategy_dsl.py。
 * 本实现独立编写，不调用 Python/eval，不含网络、存储、下单或参数写回。
 */
export const STRATEGY_SCREEN_VERSION = 'bd.strategy-screen/1';
/** 执行资源预算，不代表市场规则或供应商限额。 */
export const STRATEGY_SCREEN_LIMITS = Object.freeze({
  rows: 10_000, factors: 64, expressionLength: 2048, tokens: 256, depth: 12, topN: 1000,
});

type InvalidReason = 'missing_factor' | 'invalid_factor' | 'division_by_zero' | 'non_finite_result';
export type StrategyExclusionReason = InvalidReason | 'filter_false' | 'top_n';
type NumericCell = number | InvalidReason;
type BooleanCell = boolean | InvalidReason;
type Comparison = '>' | '>=' | '<' | '<=' | '==' | '!=';
type Arithmetic = '+' | '-' | '*' | '/';

export interface StrategyScreenInput {
  readonly rows: readonly Record<string, unknown>[];
  readonly factorNames: readonly string[];
  readonly keyField: string;
  /** 空字符串表示不设过滤条件。 */
  readonly filter: string;
  readonly orderBy: string;
  readonly topN: number;
}

export interface StrategyScreenResult {
  version: typeof STRATEGY_SCREEN_VERSION;
  rule: { filter: string; orderBy: string; topN: number; keyField: string };
  referencedFactors: string[];
  selected: Array<{ key: string; rowIndex: number; score: number; position: number;
    factors: Record<string, number>; filterMatched: true }>;
  counts: { input: number; filterMatched: number; eligible: number; selected: number; excluded: number };
  /** 每个未入选行只计一个原因；top_n 表示有效候选因名额未入选。 */
  exclusionCounts: Record<StrategyExclusionReason, number>;
  semantics: {
    rankUniverse: 'all_input_rows_with_valid_operand';
    rankMethod: 'average_tie_rank_divided_by_valid_count';
    sort: 'score_desc_key_asc_row_index_asc';
    missing: 'exclude_any_invalid_referenced_factor_even_under_not_or_ne';
    numeric: 'finite_numbers_or_decimal_strings_as_float64';
  };
}

export class StrategyScreenError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'StrategyScreenError'; }
}

type NumberNode = { type: 'number'; depth: number } & (
  { kind: 'literal'; value: number } | { kind: 'factor'; name: string }
  | { kind: 'negate'; child: NumberNode } | { kind: 'rank'; child: NumberNode }
  | { kind: 'arithmetic'; operator: Arithmetic; left: NumberNode; right: NumberNode });
type BooleanNode = { type: 'boolean'; depth: number } & (
  { kind: 'not'; child: BooleanNode }
  | { kind: 'logical'; operator: 'and' | 'or'; left: BooleanNode; right: BooleanNode }
  | { kind: 'comparison'; operator: Comparison; left: NumberNode; right: NumberNode });
type Node = NumberNode | BooleanNode;
interface Token { text: string; kind: 'number' | 'identifier' | 'operator' }

function fail(code: string, message: string): never { throw new StrategyScreenError(code, message); }
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value);
const reserved = new Set(['and', 'or', 'not', 'rank']);
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const comparisons = new Set(['>', '>=', '<', '<=', '==', '!=']);

function tokenize(expression: string): Token[] {
  if (expression.length > STRATEGY_SCREEN_LIMITS.expressionLength)
    fail('STRATEGY_SCREEN_BUDGET', '规则表达式超过长度预算。');
  const tokens: Token[] = [];
  const pattern = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z][A-Za-z0-9_]*|>=|<=|==|!=|[()+\-*/<>]/uy;
  let offset = 0;
  while (offset < expression.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(expression);
    if (!match) fail('STRATEGY_SCREEN_EXPRESSION', `规则第 ${offset + 1} 个字符不属于允许的语法。`);
    const text = match[0];
    offset = pattern.lastIndex;
    if (/^\s/u.test(text)) continue;
    tokens.push({ text, kind: /^[\d.]/u.test(text) ? 'number' : /^[A-Za-z]/u.test(text) ? 'identifier' : 'operator' });
    if (tokens.length > STRATEGY_SCREEN_LIMITS.tokens) fail('STRATEGY_SCREEN_BUDGET', '规则表达式超过词元预算。');
  }
  return tokens;
}

/** 手写有类型的语法树，不将规则转成 JavaScript 或动态函数。 */
class Parser {
  private index = 0;
  private nesting = 0;
  private readonly tokens: Token[];
  readonly referenced = new Set<string>();
  constructor(expression: string, private readonly factors: ReadonlySet<string>) { this.tokens = tokenize(expression); }
  parse(type: Node['type']): Node {
    if (!this.tokens.length) fail('STRATEGY_SCREEN_EXPRESSION', '排序表达式不能为空。');
    const result = this.or();
    if (this.index !== this.tokens.length) fail('STRATEGY_SCREEN_EXPRESSION', '规则含多余字符、链式比较或未支持的调用。');
    if (result.type !== type) fail('STRATEGY_SCREEN_EXPRESSION', type === 'number' ? 'orderBy 必须是数值表达式。' : 'filter 必须是比较或布尔表达式。');
    return result;
  }
  private peek(): string { return this.tokens[this.index]?.text ?? ''; }
  private take(text: string): boolean { if (this.peek() !== text) return false; this.index += 1; return true; }
  private expect(text: string): void { if (!this.take(text)) fail('STRATEGY_SCREEN_EXPRESSION', `规则缺少 ${text}。`); }
  private bounded<T extends Node>(node: T): T {
    if (node.depth > STRATEGY_SCREEN_LIMITS.depth) fail('STRATEGY_SCREEN_BUDGET', '规则表达式超过嵌套深度预算。');
    return node;
  }
  private number(node: Node): NumberNode {
    return node.type === 'number' ? node : fail('STRATEGY_SCREEN_EXPRESSION', '算术、比较和 rank 的输入必须为数值。');
  }
  private boolean(node: Node): BooleanNode {
    return node.type === 'boolean' ? node : fail('STRATEGY_SCREEN_EXPRESSION', 'and、or、not 的输入必须为布尔条件。');
  }
  private or(): Node {
    let left = this.and();
    while (this.take('or')) { const right = this.and(); left = this.bounded({ type: 'boolean', kind: 'logical', operator: 'or',
      left: this.boolean(left), right: this.boolean(right), depth: Math.max(left.depth, right.depth) + 1 }); }
    return left;
  }
  private and(): Node {
    let left = this.not();
    while (this.take('and')) { const right = this.not(); left = this.bounded({ type: 'boolean', kind: 'logical', operator: 'and',
      left: this.boolean(left), right: this.boolean(right), depth: Math.max(left.depth, right.depth) + 1 }); }
    return left;
  }
  private not(): Node {
    if (!this.take('not')) return this.compare();
    const child = this.boolean(this.not());
    return this.bounded({ type: 'boolean', kind: 'not', child, depth: child.depth + 1 });
  }
  private compare(): Node {
    const left = this.add();
    if (!comparisons.has(this.peek())) return left;
    const operator = this.tokens[this.index++]!.text as Comparison, right = this.add();
    return this.bounded({ type: 'boolean', kind: 'comparison', operator, left: this.number(left), right: this.number(right),
      depth: Math.max(left.depth, right.depth) + 1 });
  }
  private add(): Node {
    let left = this.multiply();
    while (this.peek() === '+' || this.peek() === '-') {
      const operator = this.tokens[this.index++]!.text as Arithmetic, right = this.multiply();
      left = this.bounded({ type: 'number', kind: 'arithmetic', operator, left: this.number(left), right: this.number(right),
        depth: Math.max(left.depth, right.depth) + 1 });
    }
    return left;
  }
  private multiply(): Node {
    let left = this.unary();
    while (this.peek() === '*' || this.peek() === '/') {
      const operator = this.tokens[this.index++]!.text as Arithmetic, right = this.unary();
      left = this.bounded({ type: 'number', kind: 'arithmetic', operator, left: this.number(left), right: this.number(right),
        depth: Math.max(left.depth, right.depth) + 1 });
    }
    return left;
  }
  private unary(): Node {
    if (this.take('-')) { const child = this.number(this.unary()); return this.bounded({ type: 'number', kind: 'negate', child, depth: child.depth + 1 }); }
    if (this.take('+')) { const child = this.number(this.unary()); return this.bounded({ ...child, depth: child.depth + 1 }); }
    return this.primary();
  }
  private grouped(): Node {
    this.nesting += 1;
    if (this.nesting > STRATEGY_SCREEN_LIMITS.depth) fail('STRATEGY_SCREEN_BUDGET', '规则括号超过嵌套预算。');
    const node = this.or(); this.expect(')'); this.nesting -= 1; return node;
  }
  private primary(): Node {
    if (this.take('(')) return this.grouped();
    const token = this.tokens[this.index++];
    if (!token) fail('STRATEGY_SCREEN_EXPRESSION', '规则表达式不完整。');
    if (token.kind === 'number') {
      const value = Number(token.text);
      if (!Number.isFinite(value)) fail('STRATEGY_SCREEN_EXPRESSION', '数值常量必须有限。');
      return { type: 'number', kind: 'literal', value, depth: 1 };
    }
    if (token.kind !== 'identifier') fail('STRATEGY_SCREEN_EXPRESSION', '此位置需要数字、已声明因子或括号。');
    if (token.text === 'rank') {
      this.expect('('); const child = this.number(this.grouped());
      return this.bounded({ type: 'number', kind: 'rank', child, depth: child.depth + 1 });
    }
    if (!this.factors.has(token.text)) fail('STRATEGY_SCREEN_FACTOR_UNKNOWN', `规则引用未声明的因子 ${token.text}。`);
    this.referenced.add(token.text);
    return { type: 'number', kind: 'factor', name: token.text, depth: 1 };
  }
}

function numericValue(value: unknown): NumericCell {
  if (value === null || value === undefined) return 'missing_factor';
  if (typeof value === 'number') return Number.isFinite(value) ? value : 'invalid_factor';
  if (typeof value !== 'string' || value.length > 128 || !decimal.test(value)) return 'invalid_factor';
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : 'invalid_factor';
}

function evaluate(rows: number, factors: ReadonlyMap<string, NumericCell[]>) {
  const numberCache = new Map<NumberNode, NumericCell[]>(), booleanCache = new Map<BooleanNode, BooleanCell[]>();
  const numbers = (node: NumberNode): NumericCell[] => {
    const cached = numberCache.get(node); if (cached) return cached;
    let values: NumericCell[];
    if (node.kind === 'literal') values = Array(rows).fill(node.value);
    else if (node.kind === 'factor') values = factors.get(node.name)!;
    else if (node.kind === 'negate') values = numbers(node.child).map(value => typeof value === 'number' ? -value : value);
    else if (node.kind === 'rank') {
      const input = numbers(node.child);
      values = [...input];
      const sorted = input.flatMap((value, index) => typeof value === 'number' ? [{ value, index }] : [])
        .sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : a.index - b.index);
      for (let start = 0; start < sorted.length;) {
        let end = start + 1;
        while (end < sorted.length && sorted[end]!.value === sorted[start]!.value) end += 1;
        const percentile = ((start + 1 + end) / 2) / sorted.length;
        for (let index = start; index < end; index += 1) values[sorted[index]!.index] = percentile;
        start = end;
      }
    } else {
      const left = numbers(node.left), right = numbers(node.right);
      values = left.map((a, index): NumericCell => {
        const b = right[index]!;
        if (typeof a !== 'number') return a;
        if (typeof b !== 'number') return b;
        if (node.operator === '/' && b === 0) return 'division_by_zero';
        const value = node.operator === '+' ? a + b : node.operator === '-' ? a - b : node.operator === '*' ? a * b : a / b;
        return Number.isFinite(value) ? value : 'non_finite_result';
      });
    }
    numberCache.set(node, values); return values;
  };
  const booleans = (node: BooleanNode): BooleanCell[] => {
    const cached = booleanCache.get(node); if (cached) return cached;
    let values: BooleanCell[];
    if (node.kind === 'not') values = booleans(node.child).map(value => typeof value === 'boolean' ? !value : value);
    else if (node.kind === 'logical') {
      const left = booleans(node.left), right = booleans(node.right);
      values = left.map((a, index): BooleanCell => {
        const b = right[index]!;
        // 不短路：无效右支不能被 true or / false and 隐藏。
        if (typeof a !== 'boolean') return a;
        if (typeof b !== 'boolean') return b;
        return node.operator === 'and' ? a && b : a || b;
      });
    } else {
      const left = numbers(node.left), right = numbers(node.right);
      values = left.map((a, index): BooleanCell => {
        const b = right[index]!;
        if (typeof a !== 'number') return a;
        if (typeof b !== 'number') return b;
        switch (node.operator) {
          case '>': return a > b; case '>=': return a >= b; case '<': return a < b;
          case '<=': return a <= b; case '==': return a === b; case '!=': return a !== b;
        }
      });
    }
    booleanCache.set(node, values); return values;
  };
  return { numbers, booleans };
}

/** 返回筛选结果和排除计数；不改变原行，不改变参数，不产生外部副作用。 */
export function screenStrategy(input: StrategyScreenInput): StrategyScreenResult {
  if (!input || typeof input !== 'object' || !Array.isArray(input.rows) || !Array.isArray(input.factorNames)
    || typeof input.filter !== 'string' || typeof input.orderBy !== 'string' || !identifier(input.keyField))
    fail('STRATEGY_SCREEN_INPUT', '需要显式截面行、因子词表、标的字段、过滤和排序表达式。');
  if (input.rows.length > STRATEGY_SCREEN_LIMITS.rows || input.factorNames.length > STRATEGY_SCREEN_LIMITS.factors
    || !Number.isSafeInteger(input.topN) || input.topN < 1 || input.topN > STRATEGY_SCREEN_LIMITS.topN)
    fail('STRATEGY_SCREEN_BUDGET', '截面行数、因子数或 topN 不在执行预算内。');
  if (!input.factorNames.length || input.factorNames.some(name => !identifier(name) || reserved.has(name) || name === input.keyField)
    || new Set(input.factorNames).size !== input.factorNames.length)
    fail('STRATEGY_SCREEN_INPUT', '因子词表须非空、唯一且为有效标识符，不得占用规则关键字或标的字段。');
  const factors = new Set(input.factorNames), orderParser = new Parser(input.orderBy, factors);
  const order = orderParser.parse('number') as NumberNode;
  // 空白仍受原始长度预算约束，不能通过 trim 绕过。
  if (input.filter.length > STRATEGY_SCREEN_LIMITS.expressionLength) fail('STRATEGY_SCREEN_BUDGET', '过滤表达式超过长度预算。');
  const filterParser = input.filter.trim() ? new Parser(input.filter, factors) : null;
  const filter = filterParser?.parse('boolean') as BooleanNode | undefined;
  const referencedFactors = [...new Set([...orderParser.referenced, ...filterParser?.referenced ?? []])].sort();
  const keys: string[] = [], uniqueKeys = new Set<string>();
  const columns = new Map(referencedFactors.map(name => [name, [] as NumericCell[]]));
  for (const row of input.rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('STRATEGY_SCREEN_INPUT', '截面每行必须是字段对象。');
    const key = Object.hasOwn(row, input.keyField) ? row[input.keyField] : undefined;
    if (typeof key !== 'string' || !key.trim() || key !== key.trim() || key.length > 128 || /[\u0000-\u001f\u007f]/u.test(key) || uniqueKeys.has(key))
      fail('STRATEGY_SCREEN_KEY', '标的字段须为非空、唯一、无控制字符的显式字符串；截面不能重复标的。');
    keys.push(key); uniqueKeys.add(key);
    for (const [name, values] of columns) values.push(numericValue(Object.hasOwn(row, name) ? row[name] : undefined));
  }
  const evaluator = evaluate(input.rows.length, columns), scores = evaluator.numbers(order);
  const matches: BooleanCell[] = filter ? evaluator.booleans(filter) : Array(input.rows.length).fill(true);
  const exclusionCounts: Record<StrategyExclusionReason, number> = {
    missing_factor: 0, invalid_factor: 0, division_by_zero: 0, non_finite_result: 0, filter_false: 0, top_n: 0,
  };
  const candidates: Array<{ key: string; rowIndex: number; score: number }> = [];
  for (let index = 0; index < input.rows.length; index += 1) {
    const invalid = referencedFactors.map(name => columns.get(name)![index]!).find(value => typeof value !== 'number');
    const match = matches[index]!, score = scores[index]!;
    const reason: StrategyExclusionReason | null = typeof invalid === 'string' ? invalid
      : typeof match !== 'boolean' ? match : !match ? 'filter_false' : typeof score !== 'number' ? score : null;
    if (reason) exclusionCounts[reason] += 1;
    else candidates.push({ key: keys[index]!, rowIndex: index, score: score as number });
  }
  candidates.sort((a, b) => a.score < b.score ? 1 : a.score > b.score ? -1
    : a.key < b.key ? -1 : a.key > b.key ? 1 : a.rowIndex - b.rowIndex);
  exclusionCounts.top_n = Math.max(0, candidates.length - input.topN);
  const selected = candidates.slice(0, input.topN).map((candidate, index) => ({ ...candidate, position: index + 1,
    factors: Object.fromEntries(referencedFactors.map(name => [name, columns.get(name)![candidate.rowIndex] as number])), filterMatched: true as const }));
  return { version: STRATEGY_SCREEN_VERSION, rule: { filter: input.filter, orderBy: input.orderBy, topN: input.topN, keyField: input.keyField },
    referencedFactors, selected,
    counts: { input: input.rows.length, filterMatched: matches.filter(value => value === true).length,
      eligible: candidates.length, selected: selected.length, excluded: input.rows.length - selected.length },
    exclusionCounts, semantics: { rankUniverse: 'all_input_rows_with_valid_operand', rankMethod: 'average_tie_rank_divided_by_valid_count',
      sort: 'score_desc_key_asc_row_index_asc', missing: 'exclude_any_invalid_referenced_factor_even_under_not_or_ne',
      numeric: 'finite_numbers_or_decimal_strings_as_float64' } };
}
