import { TaskError } from '../../../platform/jobs/tasks.js';

/** 区域语法由计划逐列冻结；不从词面猜分组、小数或百分比口径。 */
export interface NumericFormat {
  decimal: '.' | ',';
  grouping: '.' | ',' | ' ' | null;
  negative: 'minus' | 'minus_or_parentheses';
  plus: boolean;
  percent: 'reject' | 'as_reported' | 'fraction';
}
const fail = (): never => { throw new TaskError('CANDIDATE_NUMERIC_FORMAT', '数值词面与明确的区域语法不相容；未删除标点、猜值或舍入。'); };

export function readNumericFormat(raw: unknown): NumericFormat {
  const value = raw as NumericFormat;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'decimal,grouping,negative,percent,plus'
    || !['.', ','].includes(value.decimal) || ![null, '.', ',', ' '].includes(value.grouping)
    || value.grouping === value.decimal || !['minus', 'minus_or_parentheses'].includes(value.negative)
    || typeof value.plus !== 'boolean' || !['reject', 'as_reported', 'fraction'].includes(value.percent)) fail();
  return { ...value };
}

export function normalizeNumericLexeme(original: string, raw: NumericFormat): string {
  const format = readNumericFormat(raw);
  if (typeof original !== 'string' || original.length > 1024 || original !== original.trim()) fail();
  let value = original, negative = false;
  if (value.startsWith('(') || value.endsWith(')')) {
    if (format.negative !== 'minus_or_parentheses' || !/^\([^()]+\)$/u.test(value)) fail();
    negative = true; value = value.slice(1, -1);
  } else if (value.startsWith('-')) { negative = true; value = value.slice(1); }
  else if (value.startsWith('+')) { if (!format.plus) fail(); value = value.slice(1); }
  const percent = value.endsWith('%');
  if (percent) { if (format.percent === 'reject') fail(); value = value.slice(0, -1); }
  const parts = value.split(format.decimal);
  if (parts.length > 2 || !parts[0] || parts[1] !== undefined && !/^\d+$/u.test(parts[1])) fail();
  let whole = parts[0]!;
  if (format.grouping && whole.includes(format.grouping)) {
    const groups = whole.split(format.grouping);
    if (!/^[1-9]\d{0,2}$/u.test(groups[0]!) || groups.slice(1).some(group => !/^\d{3}$/u.test(group))) fail();
    whole = groups.join('');
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(whole)) fail();
  let fraction = parts[1] ?? '';
  if (percent && format.percent === 'fraction') {
    const digits = whole + fraction, scale = fraction.length + 2;
    whole = scale < digits.length ? digits.slice(0, -scale) : '0';
    fraction = scale < digits.length ? digits.slice(-scale) : '0'.repeat(scale - digits.length) + digits;
  }
  whole = whole.replace(/^0+(?=\d)/u, ''); fraction = fraction.replace(/0+$/u, '');
  const result = whole + (fraction ? '.' + fraction : '');
  return negative && /[1-9]/u.test(result) ? '-' + result : result;
}
