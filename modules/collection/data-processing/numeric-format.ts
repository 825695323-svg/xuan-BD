import { TaskError } from '../../../platform/jobs/tasks.js';
import type { DecimalPrecision } from '../../../contracts/financial-value.js';

/** 区域语法由计划逐列冻结；不从词面猜分组、小数或百分比口径。 */
export interface NumericFormat {
  decimal: '.' | ',';
  grouping: '.' | ',' | ' ' | null;
  negative: 'minus' | 'minus_or_parentheses';
  plus: boolean;
  percent: 'reject' | 'as_reported' | 'fraction';
  /** 缺省不增加默认小数位；存在时只接受显式无损规则。 */
  precision?: DecimalPrecision;
}
const fail = (): never => { throw new TaskError('CANDIDATE_NUMERIC_FORMAT', '数值词面与明确的区域语法不相容；未删除标点、猜值或舍入。'); };

/** 数值实现留在现有模块内，纳入候选与处理计划的实现摘要，不另建执行器。 */
export function readDecimalPrecision(raw: unknown): DecimalPrecision {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new TaskError('CANDIDATE_DECIMAL_CONTRACT', '精度规则必须显式声明 precision、scale 和 rounding。');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'precision,rounding,scale'
    || !Number.isSafeInteger(value.precision) || Number(value.precision) < 1 || Number(value.precision) > 128
    || !Number.isSafeInteger(value.scale) || Number(value.scale) < 0 || Number(value.scale) > Number(value.precision)
    || value.rounding !== 'reject')
    throw new TaskError('CANDIDATE_DECIMAL_CONTRACT', 'precision 须为 1—128，scale 须在 0—precision 内；只允许明确 reject，不能静默舍入。');
  return { precision: value.precision as number, scale: value.scale as number, rounding: 'reject' };
}

/** 只按十进制字符串检查，不让金融值经过 Number 或 float 往返。 */
export function assertDecimalPrecision(value: string, raw: DecimalPrecision): string {
  const rule = readDecimalPrecision(raw);
  if (typeof value !== 'string' || value.length > 1024 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value))
    throw new TaskError('CANDIDATE_DECIMAL_LEXEME', '精度核对只接受已解析的精确十进制字符串，不接受浮点数或隐式语法转换。');
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  // 来源原始词面仍由原件单元格保留；尾随零不意味着数值需要舍入。
  const fractionalDigits = fraction.replace(/0+$/u, '').length;
  if (fractionalDigits > rule.scale)
    throw new TaskError('CANDIDATE_DECIMAL_SCALE', `值需要 ${fractionalDigits} 位小数，超过声明的 ${rule.scale} 位；未截断或舍入。`);
  const integerDigits = whole!.replace(/^0+/u, '').length;
  if (integerDigits > rule.precision - rule.scale)
    throw new TaskError('CANDIDATE_DECIMAL_PRECISION', `整数部分超过声明 precision=${rule.precision}、scale=${rule.scale} 的范围；未溢出或降精度。`);
  return value;
}

export function readNumericFormat(raw: unknown): NumericFormat {
  const value = raw as NumericFormat;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).filter(key => key !== 'precision').sort().join(',') !== 'decimal,grouping,negative,percent,plus'
    || !['.', ','].includes(value.decimal) || ![null, '.', ',', ' '].includes(value.grouping)
    || value.grouping === value.decimal || !['minus', 'minus_or_parentheses'].includes(value.negative)
    || typeof value.plus !== 'boolean' || !['reject', 'as_reported', 'fraction'].includes(value.percent)) fail();
  return Object.hasOwn(value, 'precision') ? { ...value, precision: readDecimalPrecision(value.precision) } : { ...value };
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
  const normalized = negative && /[1-9]/u.test(result) ? '-' + result : result;
  return format.precision ? assertDecimalPrecision(normalized, format.precision) : normalized;
}
