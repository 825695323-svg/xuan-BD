/** Precision evidence only; no source, semantic, temporal or financial admission is granted. */
export const NUMERIC_PRECISION_VERSION = 'bd.numeric-precision/1';
const SCOPE = 'numeric_precision_only' as const;
export type NumericPrecision = { kind: 'exact_decimal' } | { kind: 'unknown' }
  | { kind: 'decimal_quantized'; quantum: string; rounding: 'nearest_even' | 'toward_zero' | 'unknown' }
  | { kind: 'binary32' | 'binary64'; bits: string; byteOrder: 'little' | 'big'; rounding: 'nearest_even' | 'unknown' };
export interface NumericOperand {
  readonly value: string;
  readonly unit: { readonly code: string; readonly base: string; readonly multiplier: string };
  readonly precision: NumericPrecision;
}
export interface Rational { numerator: string; denominator: string }
export interface PrecisionInterval { lower: Rational; upper: Rational; lowerClosed: boolean; upperClosed: boolean }
export interface KnownPrecision {
  status: 'known'; scope: typeof SCOPE; unit: string; value: Rational; interval: PrecisionInterval;
}
export interface IndeterminatePrecision { status: 'indeterminate'; scope: typeof SCOPE; reason: string }
export type NumericPrecisionEvidence = KnownPrecision | IndeterminatePrecision;
type Fraction = { n: bigint; d: bigint };
type Bounds = { lower: Fraction; upper: Fraction; lowerClosed: boolean; upperClosed: boolean };
type RawEvidence = { value: Fraction; interval: Bounds };
const ZERO = { n: 0n, d: 1n };

export class NumericPrecisionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'NumericPrecisionError'; }
}
function fail(code: string, message: string): never { throw new NumericPrecisionError('NUMERIC_PRECISION_' + code, message); }
function unknown(reason: string): IndeterminatePrecision { return { status: 'indeterminate', scope: SCOPE, reason }; }
function knownLabel(value: string): boolean {
  return typeof value === 'string' && !!value.trim() && value.length <= 128 && !/[\u0000-\u001f]/u.test(value)
    && !/^(unknown|unspecified|unverified|not_applicable|未知|待核|不明)$/iu.test(value.trim());
}
function abs(n: bigint): bigint { return n < 0n ? -n : n; }
function rational(n: bigint, d = 1n): Fraction {
  if (d === 0n) fail('DIVISION', '精度规则出现零分母。');
  if (d < 0n) { n = -n; d = -d; }
  let a = abs(n), b = d;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return { n: n / a, d: d / a };
}
const add = (a: Fraction, b: Fraction) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const multiply = (a: Fraction, b: Fraction) => rational(a.n * b.n, a.d * b.d);
const negative = (a: Fraction) => ({ n: -a.n, d: a.d });
const compare = (a: Fraction, b: Fraction) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
const packed = (a: Fraction): Rational => ({ numerator: a.n.toString(), denominator: a.d.toString() });
const unpack = (a: Rational): Fraction => ({ n: BigInt(a.numerator), d: BigInt(a.denominator) });
function packBounds(b: Bounds): PrecisionInterval {
  return { lower: packed(b.lower), upper: packed(b.upper), lowerClosed: b.lowerClosed, upperClosed: b.upperClosed };
}
function unpackBounds(b: PrecisionInterval): Bounds { return { ...b, lower: unpack(b.lower), upper: unpack(b.upper) }; }
function decimal(text: string): Fraction {
  // These bounded proof operands include exact subnormal expansions, not WFD row values.
  // The existing WFD 38/18 and 128-character admission limits are unchanged.
  if (typeof text !== 'string' || text.length > 2048) fail('VALUE', '精度输入须为有界完整十进制字符串。');
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(text);
  if (!match) fail('VALUE', '精度输入不是明确有限十进制值。');
  const exponent = Number(match[4] ?? 0), fraction = match[3] ?? '';
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1100) fail('BUDGET', '精度输入指数超出本次比较预算。');
  const digits = BigInt(match[2]! + fraction) * (match[1] ? -1n : 1n), scale = fraction.length - exponent;
  return scale < 0 ? rational(digits * 10n ** BigInt(-scale)) : rational(digits, 10n ** BigInt(scale));
}
function overlaps(a: Bounds, b: Bounds): boolean {
  const lowerOrder = compare(a.lower, b.lower), upperOrder = compare(a.upper, b.upper);
  const lower = lowerOrder >= 0 ? a.lower : b.lower, upper = upperOrder <= 0 ? a.upper : b.upper;
  const lowerClosed = lowerOrder === 0 ? a.lowerClosed && b.lowerClosed : lowerOrder > 0 ? a.lowerClosed : b.lowerClosed;
  const upperClosed = upperOrder === 0 ? a.upperClosed && b.upperClosed : upperOrder < 0 ? a.upperClosed : b.upperClosed;
  return compare(lower, upper) < 0 || compare(lower, upper) === 0 && lowerClosed && upperClosed;
}
const point = (value: Fraction): Bounds => ({ lower: value, upper: value, lowerClosed: true, upperClosed: true });
function binaryValue(bits: bigint, fractionBits: number, exponentBits: number): { value: Fraction | null; negative: boolean } {
  const fractionMask = (1n << BigInt(fractionBits)) - 1n, exponentMask = (1n << BigInt(exponentBits)) - 1n;
  const fraction = bits & fractionMask, exponent = Number((bits >> BigInt(fractionBits)) & exponentMask);
  const isNegative = (bits >> BigInt(fractionBits + exponentBits)) !== 0n;
  if (exponent === Number(exponentMask)) return { value: null, negative: isNegative };
  const bias = 2 ** (exponentBits - 1) - 1;
  const significand = exponent === 0 ? fraction : (1n << BigInt(fractionBits)) + fraction;
  const power = (exponent === 0 ? 1 - bias : exponent - bias) - fractionBits;
  const signed = isNegative ? -significand : significand;
  return { value: power < 0 ? rational(signed, 1n << BigInt(-power)) : rational(signed << BigInt(power)), negative: isNegative };
}
function rawEvidence(operand: NumericOperand): RawEvidence | IndeterminatePrecision {
  const precision = operand.precision;
  const value = decimal(operand.value);
  if (precision.kind === 'unknown') return unknown('source_precision_unknown');
  if (precision.kind === 'exact_decimal') return { value, interval: point(value) };
  if (precision.kind === 'decimal_quantized') {
    const quantum = decimal(precision.quantum);
    if (compare(quantum, ZERO) <= 0) fail('GRID', '量化步长必须是正有限数。');
    const steps = rational(value.n * quantum.d, value.d * quantum.n);
    if (steps.d !== 1n) fail('GRID', '原值不在明确量化步长网格上；没有替原值舍入。');
    if (precision.rounding === 'nearest_even') {
      const half = multiply(quantum, rational(1n, 2n)), even = steps.n % 2n === 0n;
      return { value, interval: { lower: add(value, negative(half)), upper: add(value, half), lowerClosed: even, upperClosed: even } };
    }
    if (precision.rounding === 'toward_zero') {
      return { value, interval: value.n > 0n
        ? { lower: value, upper: add(value, quantum), lowerClosed: true, upperClosed: false }
        : value.n < 0n ? { lower: add(value, negative(quantum)), upper: value, lowerClosed: false, upperClosed: true }
          : { lower: negative(quantum), upper: quantum, lowerClosed: false, upperClosed: false } };
    }
    return unknown('rounding_unknown_or_unsupported');
  }
  if (precision.kind !== 'binary32' && precision.kind !== 'binary64') return unknown('source_precision_unsupported');
  const fractionBits = precision.kind === 'binary32' ? 23 : 52, exponentBits = precision.kind === 'binary32' ? 8 : 11;
  const bytes = precision.kind === 'binary32' ? 4 : 8;
  if (!['little', 'big'].includes(precision.byteOrder) || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'iu').test(precision.bits)) fail('BITS', '原始浮点位和字节序必须明确且完整。');
  const hex = precision.byteOrder === 'little' ? precision.bits.match(/../gu)!.reverse().join('') : precision.bits;
  const bits = BigInt('0x' + hex), decoded = binaryValue(bits, fractionBits, exponentBits);
  if (!decoded.value) fail('NONFINITE', '非数或无穷不是有效数值，不赋予无限容差。');
  if (compare(decoded.value, value) !== 0 || value.n === 0n && operand.value.startsWith('-') !== decoded.negative) fail('VALUE_MISMATCH', '原始浮点位与声明解码值不一致。');
  if (precision.rounding !== 'nearest_even') return unknown('rounding_unknown_or_unsupported');
  if (value.n === 0n) {
    const halfSubnormal = multiply(binaryValue(1n, fractionBits, exponentBits).value!, rational(1n, 2n));
    // Signed-zero bit identity uses a one-sided cell; both cells contain numeric zero.
    return { value, interval: decoded.negative
      ? { lower: negative(halfSubnormal), upper: ZERO, lowerClosed: true, upperClosed: true }
      : { lower: ZERO, upper: halfSubnormal, lowerClosed: true, upperClosed: true } };
  }
  const previous = binaryValue(decoded.negative ? bits + 1n : bits - 1n, fractionBits, exponentBits).value;
  const next = binaryValue(decoded.negative ? bits - 1n : bits + 1n, fractionBits, exponentBits).value;
  if (!previous || !next) return unknown('finite_overflow_boundary_not_supported');
  const even = bits % 2n === 0n;
  return { value, interval: { lower: multiply(add(previous, value), rational(1n, 2n)), upper: multiply(add(value, next), rational(1n, 2n)), lowerClosed: even, upperClosed: even } };
}

/** Does not infer a source encoding, rounding mode, unit or currency. */
export function precisionInterval(operand: NumericOperand): NumericPrecisionEvidence {
  // Check a known source representation before unknown units can hide corrupt bits/value.
  const raw = rawEvidence(operand);
  if ('status' in raw) return raw;
  if (!knownLabel(operand.unit.code) || !knownLabel(operand.unit.base) || !knownLabel(operand.unit.multiplier)) return unknown('unit_or_multiplier_unknown');
  const multiplier = decimal(operand.unit.multiplier);
  if (compare(multiplier, ZERO) <= 0) fail('UNIT', '单位倍率必须为明确正数。');
  return { status: 'known', scope: SCOPE, unit: operand.unit.base, value: packed(multiply(raw.value, multiplier)),
    interval: packBounds({ ...raw.interval, lower: multiply(raw.interval.lower, multiplier), upper: multiply(raw.interval.upper, multiplier) }) };
}

export type PrecisionComparison = IndeterminatePrecision | {
  status: 'compatible' | 'different'; scope: typeof SCOPE; left: KnownPrecision; right: KnownPrecision;
  absoluteDifference: Rational; relativeDifference: Rational | null;
};
/** Compatibility is only under the caller's explicit source precision and unit declarations. */
export function comparePrecision(left: NumericOperand, right: NumericOperand): PrecisionComparison {
  const a = precisionInterval(left), b = precisionInterval(right);
  if (a.status === 'indeterminate') return unknown('left: ' + a.reason);
  if (b.status === 'indeterminate') return unknown('right: ' + b.reason);
  if (a.unit !== b.unit) return unknown('base_unit_mismatch');
  const av = unpack(a.value), bv = unpack(b.value), difference = add(av, negative(bv));
  const absolute = rational(abs(difference.n), difference.d), aa = rational(abs(av.n), av.d), ba = rational(abs(bv.n), bv.d);
  const denominator = compare(aa, ba) >= 0 ? aa : ba;
  return { status: overlaps(unpackBounds(a.interval), unpackBounds(b.interval)) ? 'compatible' : 'different', scope: SCOPE, left: a, right: b,
    absoluteDifference: packed(absolute), relativeDifference: denominator.n === 0n ? null : packed(rational(absolute.n * denominator.d, absolute.d * denominator.n)) };
}

export interface LinearPrecisionTerm { coefficient: string; operand: NumericOperand }
export type LinearPrecisionEvidence = IndeterminatePrecision | {
  status: 'compatible' | 'different'; scope: typeof SCOPE; unit: string; residual: Rational; interval: PrecisionInterval;
};
/** Only Σ coefficient × operand = 0; no nonlinear rule or financial binding is inferred. */
export function reconcileLinearPrecision(terms: readonly LinearPrecisionTerm[], baseUnit: string): LinearPrecisionEvidence {
  if (!knownLabel(baseUnit)) return unknown('base_unit_unknown');
  if (!Array.isArray(terms) || terms.length < 1 || terms.length > 64) fail('BUDGET', '本次线性勾稽只接受1—64个明确项。');
  let residual = ZERO, bounds = point(ZERO);
  for (const [index, term] of terms.entries()) {
    const evidence = precisionInterval(term.operand);
    if (evidence.status === 'indeterminate') return unknown(`term_${index + 1}: ${evidence.reason}`);
    if (evidence.unit !== baseUnit) return unknown(`term_${index + 1}: base_unit_mismatch`);
    const coefficient = decimal(term.coefficient), input = unpackBounds(evidence.interval), positive = coefficient.n > 0n;
    residual = add(residual, multiply(coefficient, unpack(evidence.value)));
    const scaled = coefficient.n === 0n ? point(ZERO) : {
      lower: multiply(coefficient, positive ? input.lower : input.upper), upper: multiply(coefficient, positive ? input.upper : input.lower),
      lowerClosed: positive ? input.lowerClosed : input.upperClosed, upperClosed: positive ? input.upperClosed : input.lowerClosed };
    bounds = { lower: add(bounds.lower, scaled.lower), upper: add(bounds.upper, scaled.upper),
      lowerClosed: bounds.lowerClosed && scaled.lowerClosed, upperClosed: bounds.upperClosed && scaled.upperClosed };
  }
  return { status: overlaps(bounds, point(ZERO)) ? 'compatible' : 'different', scope: SCOPE, unit: baseUnit,
    residual: packed(residual), interval: packBounds(bounds) };
}
