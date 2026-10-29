import type { JsonValue } from '../../contracts/task-contracts.js';
import type { StructuredOutput } from '../../modules/collection/pipeline.js';

function scaleDigits(scale: string): number {
  if (typeof scale !== 'string' || !/^10{0,18}$/.test(scale)) throw new RangeError('WFD v0.2 倍率必须是 1 至 10^18 的十进制整次幂字符串。');
  return scale.length - 1;
}
/** v0.2 的精确十进制解释；不通过浮点除法生成审计值。 */
export function decodeWfdScaledInteger(stored: number, scale: string): string {
  const places = scaleDigits(scale);
  if (!Number.isSafeInteger(stored)) throw new RangeError('WFD 存储数值必须是安全整数。');
  const digits = String(Math.abs(stored)).padStart(places + 1, '0');
  const value = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/0+$/, '').replace(/\.$/, '') : digits;
  return (stored < 0 ? '-' : '') + value;
}
/** 与同一正式语义对应的精确编码；余数、指数文本和溢出均拒绝。 */
export function encodeWfdScaledInteger(unitValue: string, scale: string): number {
  const places = scaleDigits(scale);
  if (typeof unitValue !== 'string' || unitValue.length > 128 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(unitValue)) throw new RangeError('WFD 单位值必须是明确十进制字符串。');
  const negative = unitValue.startsWith('-'), unsigned = negative ? unitValue.slice(1) : unitValue;
  const [whole, fraction = ''] = unsigned.split('.');
  let coefficient = BigInt(whole! + fraction);
  const shift = places - fraction.length;
  if (shift >= 0) coefficient *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    if (coefficient % divisor !== 0n) throw new RangeError('WFD 单位值不能按声明倍率精确编码。');
    coefficient /= divisor;
  }
  if (coefficient > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('WFD 编码超出安全整数范围。');
  return coefficient === 0n ? 0 : Number(negative ? -coefficient : coefficient);
}

/** 固定合成投影；正式结构仍由被信任摘要锁定的 WFD schema 校验。 */
export function createWfdTablePackage(output: StructuredOutput): JsonValue {
  if (output.environment !== 'synthetic-test' || output.descriptor.format !== 'internal-synthetic-daily/1'
    || output.descriptor.priceUnit !== 'CNY' || output.descriptor.priceScale !== 10000
    || output.descriptor.volumeUnit !== 'shares' || output.descriptor.volumeScale !== 1
    || output.descriptor.dateEncoding !== 'YYYYMMDD') throw new Error('不支持的内部合成表格声明。');
  const fields = ['instrument_id', 'trade_date', 'open', 'high', 'low', 'close', 'volume'];
  if (JSON.stringify(output.descriptor.fields) !== JSON.stringify(fields)
    || JSON.stringify(output.descriptor.primaryKey) !== JSON.stringify(['instrument_id', 'trade_date'])) throw new Error('合成表格字段或主键不匹配。');
  if (!Array.isArray(output.rows) || output.rows.length > 1000 || output.rows.some(row => Object.keys(row).length !== fields.length
    || fields.some(field => !Object.hasOwn(row, field) || !Number.isSafeInteger(row[field as keyof typeof row])))) throw new Error('合成表格行必须与已声明安全整数字段一致。');
  const dictionary = Object.fromEntries(Object.entries(output.descriptor.instrumentDictionary).map(([symbol, code]) => {
    if (!Number.isSafeInteger(code) || code < 1) throw new Error('合成对象编码必须为正安全整数。');
    return [String(code), symbol];
  }));
  if (Object.keys(dictionary).length !== Object.keys(output.descriptor.instrumentDictionary).length) throw new Error('合成对象编码冲突。');
  const originals = output.evidence.sourceInputs.map(input => input.sha256);
  return {
    entrypoint: '库说明.json',
    descriptor: {
      contract_version: 'wfd-table/v0.2', unit_id: 'synthetic.cn_equity.daily', output_id: 'bars',
      definition_rev: '2', schema_rev: '2', snapshot_id: null, data_kind: 'synthetic', format: 'json-table',
      fields: fields.map(name => ({ name, dtype: 'safe_integer', role: ['instrument_id', 'trade_date'].includes(name) ? 'key' : 'value',
        unit: name === 'instrument_id' ? 'synthetic-instrument-code' : name === 'trade_date' ? 'YYYYMMDD' : name === 'volume' ? 'shares' : 'CNY',
        scale: ['instrument_id', 'trade_date', 'volume'].includes(name) ? '1' : '10000', nullable: false })),
      primary_key: ['instrument_id', 'trade_date'], row_count: output.rows.length,
      time_capability: 'fixed_snapshot_only', allowed_purposes: ['isolation_test'],
      coverage: {
        complete: output.evidence.coverage.complete, gaps: [],
        description: '仅明确合成对象及请求日期集合；v0.2声明单位值=存储整数/scale：价格整数/10000=CNY，股份量整数/1=shares。历史公开资格未知；日期为YYYYMMDD合成日历编码。',
      },
      codebooks: { instrument_id: { revision: output.evidence.annotation.referenceVersions.dictionary, entries: dictionary } },
      dependencies: { read: [], compute: [], regenerate: originals, audit: originals },
    },
    rows: output.rows.map(row => ({ ...row })),
  };
}
