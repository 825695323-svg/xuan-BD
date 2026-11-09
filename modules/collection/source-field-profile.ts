import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TaskError } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';

/**
 * BD 来源字段档案：原表头 → 标准字段、类型、单位与金融口径。
 *
 * 原表头是来源原文，不是正式金融字段身份。档案按「来源系列 + 版本」管理；
 * 不同供应商可以映射到同一规范字段，但只有这里明确登记的映射才生效，
 * 不按列名相似自动合并，也不据档案改写原件。
 */
export type SourceFieldRole = 'identity' | 'date' | 'minute' | 'value';
export interface SourceFieldMapping {
  originalHeader: string;
  /** 同一标准字段的其他原表头写法；只在该来源档案内有效，不跨来源猜词。 */
  aliases?: string[];
  fieldCode: string;
  dataType: 'decimal' | 'integer' | 'text' | 'boolean';
  unitCode: string;
  role: SourceFieldRole;
  /** 明确写下的金融口径（例如「每股价格」「后复权累计因子」）；未知就留空，不补造。 */
  measurement?: string;
}
/** 分钟桶定义：标签表示起点、区间左闭右开、时长与来源时区都必须写明。 */
export interface SourceTimeBucket {
  labelSemantics: 'start' | 'end' | 'unknown';
  interval: 'closed_open' | 'closed_closed' | 'unknown';
  lengthMinutes: number;
  timezone: string;
}
export interface SourceAdjustment {
  status: 'raw' | 'qfq' | 'hfq' | 'unknown';
  /** 复权方法与基准日；未知就留空，不补造。 */
  method?: string;
  basis?: string;
}
export interface SourceFieldProfile {
  version: 'bd.source-field-profile/1';
  /** 映射版本：同一系列口径变化必须升版本，旧版本请求按旧版本核对。 */
  mappingVersion: number;
  profileId: string;
  sourceId: string;
  /** 来源系列；空字符串表示该来源的全部系列共用这一份档案。 */
  series: string;
  fields: SourceFieldMapping[];
  confirmation: { status: 'operator_confirmed'; basis: string; confirmedAtUtc: string };
  /** 频率与时间桶：决定两份档案能否复用同一产品定义。 */
  frequency: 'minute' | 'day' | 'tick' | 'other';
  timeBucket: SourceTimeBucket;
  adjustment: SourceAdjustment;
  /** 显式登记与被取代产品/档案的关系；不靠改名悄悄合并。 */
  supersedes?: { productId?: string; profileId?: string; note: string }[];
}
export interface FrozenSourceFieldProfile { profile: SourceFieldProfile; digest: string; fingerprint: string }

const syntax = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const roles: readonly SourceFieldRole[] = ['identity', 'date', 'minute', 'value'];
const dataTypes = ['decimal', 'integer', 'text', 'boolean'] as const;
const unknownBasis = /^(?:authorized|approved|unknown|pending|待核|待确认|已确认|无依据)$/iu;

function fail(message: string): never { throw new TaskError('SOURCE_FIELD_PROFILE', message); }
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/u.test(value)) fail(`来源字段档案的${label}无效。`);
  return value;
};

/** 严格读取一份档案；任何字段不合规都整体拒绝，不猜测缺失项。 */
export function readSourceFieldProfile(value: unknown, name: string): SourceFieldProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`来源字段档案 ${name} 不是对象。`);
  const raw = value as Record<string, unknown>;
  if (raw.version !== 'bd.source-field-profile/1') fail(`来源字段档案 ${name} 版本不是 bd.source-field-profile/1。`);
  const profileId = text(raw.profileId, 'profileId');
  const sourceId = text(raw.sourceId, 'sourceId');
  if (typeof raw.series !== 'string' || raw.series.length > 512) fail(`来源字段档案 ${name} 的 series 必须是字符串。`);
  const confirmation = raw.confirmation as Record<string, unknown> | undefined;
  if (!confirmation || confirmation.status !== 'operator_confirmed'
    || typeof confirmation.basis !== 'string' || !confirmation.basis.trim() || unknownBasis.test(confirmation.basis.trim())) {
    fail(`来源字段档案 ${name} 缺少操作者确认依据；列名相似不能代替确认。`);
  }
  if (!Number.isSafeInteger(raw.mappingVersion) || (raw.mappingVersion as number) < 1) fail(`来源字段档案 ${name} 的 mappingVersion 无效。`);
  if (!['minute', 'day', 'tick', 'other'].includes(String(raw.frequency))) fail(`来源字段档案 ${name} 的 frequency 无效。`);
  const bucket = raw.timeBucket as Record<string, unknown> | undefined;
  if (!bucket || !['start', 'end', 'unknown'].includes(String(bucket.labelSemantics))
    || !['closed_open', 'closed_closed', 'unknown'].includes(String(bucket.interval))
    || !Number.isSafeInteger(bucket.lengthMinutes) || Number(bucket.lengthMinutes) < 1
    || typeof bucket.timezone !== 'string' || !bucket.timezone.trim()) fail(`来源字段档案 ${name} 的 timeBucket 需要标签语义、区间、分钟长度与时区。`);
  const adjustmentRaw = raw.adjustment as Record<string, unknown> | undefined;
  if (!adjustmentRaw || !['raw', 'qfq', 'hfq', 'unknown'].includes(String(adjustmentRaw.status))) fail(`来源字段档案 ${name} 的 adjustment.status 无效。`);
  const confirmedAtUtc = text(confirmation.confirmedAtUtc, 'confirmedAtUtc');
  if (!Number.isFinite(Date.parse(confirmedAtUtc))) fail(`来源字段档案 ${name} 的确认时间不是有效 UTC。`);
  if (!Array.isArray(raw.fields) || !raw.fields.length || raw.fields.length > 64) fail(`来源字段档案 ${name} 的字段映射数量越界。`);
  const headers = new Set<string>(), codes = new Set<string>();
  const fields = raw.fields.map((entry, index): SourceFieldMapping => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`来源字段档案 ${name} 第 ${index + 1} 项不是对象。`);
    const field = entry as Record<string, unknown>;
    const originalHeader = text(field.originalHeader, `fields[${index}].originalHeader`);
    const fieldCode = text(field.fieldCode, `fields[${index}].fieldCode`);
    const unitCode = text(field.unitCode, `fields[${index}].unitCode`);
    if (!syntax.test(fieldCode) || ['__proto__', 'constructor', 'prototype'].includes(fieldCode)) fail(`来源字段档案 ${name} 的字段编码越界：${fieldCode}`);
    if (!syntax.test(unitCode)) fail(`来源字段档案 ${name} 的单位编码越界：${unitCode}`);
    if (!dataTypes.includes(field.dataType as never)) fail(`来源字段档案 ${name} 的类型无效：${originalHeader}`);
    if (!roles.includes(field.role as never)) fail(`来源字段档案 ${name} 的角色无效：${originalHeader}`);
    if (field.measurement !== undefined && (typeof field.measurement !== 'string' || field.measurement.length > 512)) fail(`来源字段档案 ${name} 的口径描述无效：${originalHeader}`);
    if (headers.has(originalHeader)) fail(`来源字段档案 ${name} 重复映射同一原表头：${originalHeader}`);
    if (codes.has(fieldCode)) fail(`来源字段档案 ${name} 把两个原表头映射到同一标准字段：${fieldCode}`);
    headers.add(originalHeader); codes.add(fieldCode);
    if (field.aliases !== undefined) {
      if (!Array.isArray(field.aliases) || field.aliases.length > 16
        || field.aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 512)) {
        fail(`来源字段档案 ${name} 的 aliases 无效：${originalHeader}`);
      }
      for (const alias of field.aliases as string[]) {
        if (headers.has(alias)) fail(`来源字段档案 ${name} 的原表头或别名重复：${alias}`);
        headers.add(alias);
      }
    }
    return { originalHeader, fieldCode, dataType: field.dataType as SourceFieldMapping['dataType'], unitCode,
      role: field.role as SourceFieldRole, ...(field.measurement === undefined ? {} : { measurement: field.measurement }) };
  });
  const supersedes = raw.supersedes === undefined ? undefined : (() => {
    if (!Array.isArray(raw.supersedes) || !raw.supersedes.length) fail(`来源字段档案 ${name} 的 supersedes 无效。`);
    return raw.supersedes.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`来源字段档案 ${name} 的 supersedes[${index}] 无效。`);
      const item = entry as Record<string, unknown>;
      return { ...(typeof item.productId === 'string' ? { productId: item.productId } : {}),
        ...(typeof item.profileId === 'string' ? { profileId: item.profileId } : {}), note: text(item.note, `supersedes[${index}].note`) };
    });
  })();
  return { version: 'bd.source-field-profile/1', mappingVersion: raw.mappingVersion as number, profileId, sourceId,
    series: raw.series, fields, frequency: raw.frequency as SourceFieldProfile['frequency'],
    timeBucket: { labelSemantics: bucket.labelSemantics as SourceTimeBucket['labelSemantics'],
      interval: bucket.interval as SourceTimeBucket['interval'], lengthMinutes: Number(bucket.lengthMinutes),
      timezone: String(bucket.timezone) },
    adjustment: { status: adjustmentRaw.status as SourceAdjustment['status'],
      ...(typeof adjustmentRaw.method === 'string' ? { method: adjustmentRaw.method } : {}),
      ...(typeof adjustmentRaw.basis === 'string' ? { basis: adjustmentRaw.basis } : {}) },
    confirmation: { status: 'operator_confirmed', basis: confirmation.basis, confirmedAtUtc },
    ...(supersedes ? { supersedes } : {}) };
}

export const sourceFieldProfileDigest = (profile: SourceFieldProfile): string => wfdSha256(canonicalWfdJson(profile));

/** 档案目录：一份 JSON 一份档案。读不到目录时视为没有档案，不静默补默认映射。 */
export class SourceFieldProfileStore {
  constructor(private readonly directory: string) {}
  list(): SourceFieldProfile[] {
    let names: string[];
    try { names = readdirSync(this.directory).filter(name => name.endsWith('.json')).sort(); }
    catch { return []; }
    return names.map(name => readSourceFieldProfile(JSON.parse(readFileSync(resolve(join(this.directory, name)), 'utf8')), name));
  }
  /** 按来源与系列选择档案；多份同时命中视为冲突，不自行挑一份。 */
  match(input: { sourceId: string; series?: string | null }): SourceFieldProfile | null {
    const hits = this.list().filter(profile => profile.sourceId === input.sourceId
      && (!profile.series || !input.series || profile.series === input.series));
    if (hits.length > 1) fail(`来源 ${input.sourceId} 系列「${input.series ?? ''}」命中多份字段档案：${hits.map(hit => hit.profileId).join('、')}；请只保留一份生效版本。`);
    return hits[0] ?? null;
  }
}

/** 语义签名：决定两份来源档案能否落到同一产品定义的关键事实，不含原表头。 */
export interface SemanticSignature {
  fields: { fieldCode: string; dataType: string; unitCode: string; role: string; measurement: string | null }[];
  frequency: string; timeBucket: SourceTimeBucket; adjustment: SourceAdjustment;
}
export const profileSignature = (profile: SourceFieldProfile): SemanticSignature => ({
  fields: [...profile.fields].map(field => ({ fieldCode: field.fieldCode, dataType: field.dataType,
    unitCode: field.unitCode, role: field.role, measurement: field.measurement ?? null }))
    .sort((a, b) => a.fieldCode.localeCompare(b.fieldCode)),
  frequency: profile.frequency, timeBucket: profile.timeBucket, adjustment: profile.adjustment,
});
export const profileFingerprint = (profile: SourceFieldProfile): string => wfdSha256(canonicalWfdJson(profileSignature(profile)));

/** 跨来源复用判定：只按语义事实比较，原表头、provider、文件名不参与。 */
export function compareProfileSemantics(left: SourceFieldProfile, right: SourceFieldProfile): {
  sameProduct: boolean; reasons: string[];
} {
  const reasons: string[] = [];
  const a = profileSignature(left), b = profileSignature(right);
  const leftCodes = new Set(a.fields.map(field => field.fieldCode)), rightCodes = new Set(b.fields.map(field => field.fieldCode));
  const missing = [...leftCodes].filter(code => !rightCodes.has(code));
  const extra = [...rightCodes].filter(code => !leftCodes.has(code));
  if (missing.length) reasons.push(`缺少标准字段 ${JSON.stringify(missing)}`);
  if (extra.length) reasons.push(`多出标准字段 ${JSON.stringify(extra)}`);
  for (const field of a.fields) {
    const other = b.fields.find(item => item.fieldCode === field.fieldCode);
    if (!other) continue;
    if (other.unitCode !== field.unitCode) reasons.push(`${field.fieldCode} 单位不同：${field.unitCode} ≠ ${other.unitCode}`);
    if (other.dataType !== field.dataType) reasons.push(`${field.fieldCode} 类型不同：${field.dataType} ≠ ${other.dataType}`);
    if (other.role !== field.role) reasons.push(`${field.fieldCode} 角色不同：${field.role} ≠ ${other.role}`);
    if (field.measurement !== other.measurement) reasons.push(`${field.fieldCode} 口径不同：${field.measurement ?? '未声明'} ≠ ${other.measurement ?? '未声明'}`);
  }
  if (a.frequency !== b.frequency) reasons.push(`频率不同：${a.frequency} ≠ ${b.frequency}`);
  if (a.timeBucket.labelSemantics !== b.timeBucket.labelSemantics
    || a.timeBucket.interval !== b.timeBucket.interval
    || a.timeBucket.lengthMinutes !== b.timeBucket.lengthMinutes
    || a.timeBucket.timezone !== b.timeBucket.timezone) reasons.push(`分钟桶定义不同：${canonicalWfdJson(a.timeBucket)} ≠ ${canonicalWfdJson(b.timeBucket)}`);
  if (a.adjustment.status !== b.adjustment.status) reasons.push(`复权状态不同：${a.adjustment.status} ≠ ${b.adjustment.status}`);
  return { sameProduct: reasons.length === 0, reasons };
}

/**
 * 语义产品登记：指纹 → 正式数据集。不同来源只要指纹相同就必须落到同一数据集；
 * 换了数据集等于另立家族，必须由操作者显式登记，不能靠改名悄悄分叉。
 */
export interface SemanticProductRegistry {
  version: 'bd.semantic-products/1';
  products: { fingerprint: string; datasetId: string; note?: string; registeredAtUtc?: string }[];
}
export function readSemanticProductRegistry(value: unknown, name: string): SemanticProductRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`语义产品登记 ${name} 不是对象。`);
  const raw = value as Record<string, unknown>;
  if (raw.version !== 'bd.semantic-products/1') fail(`语义产品登记 ${name} 的版本不是 bd.semantic-products/1。`);
  if (!Array.isArray(raw.products) || !raw.products.length) fail(`语义产品登记 ${name} 没有产品条目。`);
  const seen = new Set<string>();
  const products = raw.products.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`语义产品登记 ${name} 的 products[${index}] 无效。`);
    const item = entry as Record<string, unknown>;
    if (typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(item.fingerprint)) fail(`语义产品登记 ${name} 的指纹无效。`);
    if (typeof item.datasetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(item.datasetId)) fail(`语义产品登记 ${name} 的数据集编号无效。`);
    if (seen.has(item.fingerprint)) fail(`语义产品登记 ${name} 重复登记同一指纹。`);
    seen.add(item.fingerprint);
    return { fingerprint: item.fingerprint, datasetId: item.datasetId,
      ...(typeof item.note === 'string' ? { note: item.note } : {}),
      ...(typeof item.registeredAtUtc === 'string' ? { registeredAtUtc: item.registeredAtUtc } : {}) };
  });
  return { version: 'bd.semantic-products/1', products };
}
export class SemanticProductRegistryStore {
  constructor(private readonly path: string) {}
  read(): SemanticProductRegistry | null {
    try { return readSemanticProductRegistry(JSON.parse(readFileSync(this.path, 'utf8')), this.path); }
    catch { return null; }
  }
  /** 已登记的正式数据集；未登记返回 null（首次登记由操作者完成，不自动写入）。 */
  datasetFor(fingerprint: string): string | null {
    return this.read()?.products.find(item => item.fingerprint === fingerprint)?.datasetId ?? null;
  }
}
