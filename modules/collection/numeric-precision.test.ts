import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePrecision, precisionInterval, reconcileLinearPrecision } from './numeric-precision.js';

const unit = (code = 'CNY', base = code, multiplier = '1') => ({ code, base, multiplier });
const exact = (value: string, binding = unit()) => ({ value, unit: binding, precision: { kind: 'exact_decimal' as const } });
const binary = (value: string, bits: string, kind: 'binary32' | 'binary64' = 'binary32') => ({
  value, unit: unit(), precision: { kind, bits, byteOrder: 'little' as const, rounding: 'nearest_even' as const },
});
const decimal = (value: string, rounding: 'nearest_even' | 'toward_zero' | 'unknown' = 'nearest_even') => ({
  value, unit: unit(), precision: { kind: 'decimal_quantized' as const, quantum: '0.01', rounding },
});
const fraction = (numerator: string, denominator = '1') => ({ numerator, denominator });
const errorCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
function tiny(power: number): string {
  const digits = (5n ** BigInt(power)).toString();
  return '0.' + digits.padStart(power, '0');
}

test('binary representation intervals scale with magnitude and preserve asymmetric and even-tie boundaries', () => {
  const source = Object.freeze(binary('285524557824', '2ef58452'));
  const result = precisionInterval(source);
  assert.ok(result.status === 'known');
  assert.deepEqual(result.interval.lower, fraction('285524541440'));
  assert.deepEqual(result.interval.upper, fraction('285524574208'));
  const compared = comparePrecision(source, exact('285524543268.38'));
  assert.ok(compared.status === 'compatible');
  assert.equal(compared.scope, 'numeric_precision_only');
  assert.deepEqual(compared.absoluteDifference, fraction('727781', '50'));
  assert.equal(comparePrecision(source, exact('285524540000')).status, 'different');
  assert.equal(source.precision.bits, '2ef58452'); assert.equal(source.value, '285524557824');
  const one = binary('1', '0000803f');
  assert.equal(comparePrecision(one, exact('0.99999996')).status, 'different');
  assert.equal(comparePrecision(one, exact('0.9999999701976776123046875')).status, 'compatible');
  const odd = binary('1.00000011920928955078125', '0100803f');
  assert.equal(comparePrecision(odd, exact('1.000000059604644775390625')).status, 'different');
  assert.equal(comparePrecision(binary('1', '000000000000f03f', 'binary64'), exact('1.0000000000000001')).status, 'compatible');
  assert.equal(comparePrecision(binary('1', '000000000000f03f', 'binary64'), exact('1.0000000000000002')).status, 'different');
});

test('explicit decimal quantization and linear reconciliation use exact unit scales and input error intervals', () => {
  assert.equal(comparePrecision(exact('1.23'), exact('1.2300000001')).status, 'different');
  assert.equal(comparePrecision(decimal('1.24'), exact('1.235')).status, 'compatible');
  assert.equal(comparePrecision(decimal('1.23'), exact('1.235')).status, 'different');
  assert.equal(comparePrecision(decimal('1.23', 'toward_zero'), exact('1.239')).status, 'compatible');
  assert.equal(comparePrecision(decimal('1.23', 'toward_zero'), exact('1.24')).status, 'different');
  assert.equal(comparePrecision(decimal('-1.23', 'toward_zero'), exact('-1.239')).status, 'compatible');
  assert.equal(comparePrecision(decimal('-1.23', 'toward_zero'), exact('-1.24')).status, 'different');
  assert.throws(() => precisionInterval(decimal('1.235')), errorCode('NUMERIC_PRECISION_GRID'));
  assert.equal(comparePrecision(exact('100', unit('CNY_10000', 'CNY', '10000')), exact('1000000')).status, 'compatible');
  const terms = (equity: string) => [
    { coefficient: '1', operand: decimal('100.00') },
    { coefficient: '-1', operand: decimal('60.00') },
    { coefficient: '-1', operand: decimal(equity) },
  ];
  const compatible = reconcileLinearPrecision(terms('40.01'), 'CNY');
  assert.ok(compatible.status === 'compatible');
  assert.deepEqual(compatible.residual, fraction('-1', '100'));
  assert.equal(reconcileLinearPrecision(terms('40.02'), 'CNY').status, 'different');
  assert.equal(reconcileLinearPrecision([{ coefficient: '1', operand: exact('100', unit('CNY_10000', 'CNY', '10000')) },
    { coefficient: '-1', operand: exact('1000000') }], 'CNY').status, 'compatible');
  assert.equal(comparePrecision(exact('1', unit('USD')), exact('1')).status, 'indeterminate');
  assert.equal(reconcileLinearPrecision([{ coefficient: '1', operand: exact('1', unit('USD')) }], 'CNY').status, 'indeterminate');
});

test('unknown declarations cannot hide value mismatch and zero or subnormal boundaries stay explicit', () => {
  assert.equal(precisionInterval({ ...exact('1'), precision: { kind: 'unknown' } }).status, 'indeterminate');
  for (const value of ['NaN', 'Infinity', 'not-a-number']) assert.throws(() => precisionInterval({ ...exact(value), precision: { kind: 'unknown' } }), errorCode('NUMERIC_PRECISION_VALUE'));
  assert.equal(precisionInterval(decimal('1.23', 'unknown')).status, 'indeterminate');
  assert.equal(precisionInterval(exact('1', unit('unknown'))).status, 'indeterminate');
  assert.equal(precisionInterval(exact('1', unit('CNY', 'unknown'))).status, 'indeterminate');
  const mismatch = binary('2', '0000803f');
  assert.throws(() => precisionInterval({ ...mismatch, precision: { ...mismatch.precision, rounding: 'unknown' } }), errorCode('NUMERIC_PRECISION_VALUE_MISMATCH'));
  assert.throws(() => precisionInterval({ ...mismatch, unit: unit('unknown') }), errorCode('NUMERIC_PRECISION_VALUE_MISMATCH'));
  for (const bits of ['0000807f', '0000c07f']) assert.throws(() => precisionInterval(binary('0', bits)), errorCode('NUMERIC_PRECISION_NONFINITE'));
  assert.throws(() => precisionInterval(exact('1', unit('CNY', 'CNY', '0'))), errorCode('NUMERIC_PRECISION_UNIT'));
  assert.equal(precisionInterval(binary('340282346638528859811704183484516925440', 'ffff7f7f')).status, 'indeterminate');
  assert.equal(comparePrecision(binary('-1', '000080bf'), exact('-0.99999996')).status, 'different');
  const positiveZero = precisionInterval(binary('0', '00000000'));
  assert.ok(positiveZero.status === 'known');
  assert.deepEqual(positiveZero.interval.lower, fraction('0'));
  assert.deepEqual(positiveZero.interval.upper, fraction('1', (1n << 150n).toString()));
  assert.equal(comparePrecision(binary('0', '00000000'), exact('-' + tiny(151))).status, 'different');
  assert.equal(comparePrecision(binary('-0', '00000080'), binary('0', '00000000')).status, 'compatible');
  const subnormal = binary(tiny(149), '01000000');
  const interval = precisionInterval(subnormal);
  assert.ok(interval.status === 'known');
  assert.deepEqual(interval.interval.lower, fraction('1', (1n << 150n).toString()));
  assert.deepEqual(interval.interval.upper, fraction('3', (1n << 150n).toString()));
  assert.equal(interval.interval.lowerClosed, false); assert.equal(interval.interval.upperClosed, false);
  assert.equal(comparePrecision(subnormal, exact(tiny(150))).status, 'different');
  const subnormal64 = precisionInterval(binary(tiny(1074), '0100000000000000', 'binary64'));
  assert.ok(subnormal64.status === 'known');
  assert.deepEqual(subnormal64.interval.lower, fraction('1', (1n << 1075n).toString()));
  assert.equal(comparePrecision(decimal('0', 'toward_zero'), exact('0.01')).status, 'different');
});
