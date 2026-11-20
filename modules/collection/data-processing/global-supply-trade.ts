import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import { parseR1Utc } from '../r1-tabular.js';

export const GLOBAL_SUPPLY_TRADE_VERSION = 'bd-global-supply-trade/1';

export type GeoRegionKind =
  | 'country_or_region'
  | 'state_or_province'
  | 'customs_statistical_area'
  | 'regional_bloc'
  | 'facility_zone';

export type EnterpriseLocationRole =
  | 'registered_in'
  | 'listed_on'
  | 'headquartered_in'
  | 'produces_in'
  | 'sells_to_market';

export interface GeoRegionMaster {
  regionId: string;
  namespace: string;
  code: string;
  name: string;
  kind: GeoRegionKind;
  parentRegionId?: string | null;
  memberRegionIds?: readonly string[];
  statisticalScheme: string;
  validFromUtc?: string | null;
  validToUtc?: string | null;
}

export interface EnterpriseLocationBinding {
  entityId: string;
  role: EnterpriseLocationRole;
  regionId: string;
  facilityId?: string | null;
  evidenceBasis: string;
}

export type CommodityChainPosition = 'raw_material' | 'intermediate' | 'finished_good';
export type CommodityQuantityBasis =
  | 'gross_weight'
  | 'net_weight'
  | 'dry_weight'
  | 'wet_weight'
  | 'metal_content'
  | 'carcass_weight'
  | 'shipped_weight'
  | 'head_count'
  | 'volume'
  | 'energy'
  | 'count';

export type ExternalClassificationMappingQuality =
  | 'exact'
  | 'broader_narrower'
  | 'partial_overlap'
  | 'pending_review';

export interface CommodityExternalClassification {
  scheme: string;
  version: string;
  code: string;
  aggrLevel: number;
  parentCode?: string | null;
  mappingQuality: ExternalClassificationMappingQuality;
}

export interface CommodityMasterProfile {
  commodityId: string;
  name: string;
  chainPosition: CommodityChainPosition;
  stageCode: string;
  formOrGrade?: string;
  quantityBasis: CommodityQuantityBasis;
  unitCode: string;
  externalClassifications?: readonly CommodityExternalClassification[];
  processConversion?: {
    routeId: string;
    fromCommodityId: string;
    inputCoefficient: string;
    yieldRate: string;
    conditionBasis: string;
    version: string;
  };
}

export type GeoObservationCategory =
  | 'resource_reserve'
  | 'production_capacity'
  | 'actual_output'
  | 'domestic_use'
  | 'inventory'
  | 'import_export_summary';

export type CapacityOrFacilityStatus =
  | 'planned'
  | 'under_construction'
  | 'commissioning'
  | 'operational_effective'
  | 'nameplate_designed'
  | 'suspended'
  | 'not_applicable';

export type TradeOrObservationValueState =
  | 'valid_value'
  | 'reported_zero'
  | 'unreported_missing'
  | 'confidential_suppressed'
  | 'estimated'
  | 'not_covered';

export interface TemporalQualification {
  effectiveStartUtc: string;
  effectiveEndExclusiveUtc: string;
  publicTimeUtc: string | null;
  systemHeldAtUtc: string | null;
  usableStage: 'acquired' | 'custodied' | 'published_readable';
  revisionArchivePolicy: 'versioned_archive' | 'current_revision_only';
  revisionId: string;
}

export interface GeoCommodityObservation {
  observationKey: string;
  regionId: string;
  facilityId?: string | null;
  commodityId: string;
  stageCode: string;
  category: GeoObservationCategory;
  metricCode: string;
  periodBasis: 'calendar_year' | 'fiscal_year' | 'month' | 'instant';
  periodLabel: string;
  quantityBasis: CommodityQuantityBasis;
  unitCode: string;
  value: string | null;
  valueState: TradeOrObservationValueState;
  capacityStatus?: CapacityOrFacilityStatus;
  inventoryScope?: 'port_ending_stock' | 'commercial_stock' | 'in_transit_stock' | 'producer_stock' | 'port_annual_throughput';
  temporal: TemporalQualification;
  sourceId: string;
}

export type TradeFlowDirection = 'import' | 'export' | 're_import' | 're_export';
export type TradePartnerRole = 'origin' | 'last_known_destination' | 'consignment_or_transit';
export type TradeValuationBasis = 'CIF' | 'FOB' | 'ex_works' | 'unknown';

export interface TradeObservation {
  observationKey: string;
  reporterRegionId: string;
  reporterStatisticalScheme: string;
  partnerRegionId: string;
  partnerRole: TradePartnerRole;
  secondPartnerRegionId?: string | null;
  secondPartnerRole?: TradePartnerRole | null;
  flow: TradeFlowDirection;
  isSubFlowOf?: TradeFlowDirection | null;
  commodityId: string;
  stageCode: string;
  externalClassification: CommodityExternalClassification;
  periodBasis: 'calendar_year' | 'fiscal_year' | 'month' | 'ytd_cumulative';
  periodLabel: string;
  primaryValue: string | null;
  currencyCode: string;
  valuationBasis: TradeValuationBasis;
  valueState: TradeOrObservationValueState;
  quantity: string | null;
  quantityBasis: CommodityQuantityBasis;
  quantityUnitCode: string;
  quantityState: TradeOrObservationValueState;
  customsProcedure?: string;
  modeOfTransport?: string;
  temporal: TemporalQualification;
  sourceId: string;
}

const fail = (code: string, message: string): never => {
  throw new TaskError('GLOBAL_SUPPLY_TRADE_' + code, message);
};

const isNonEmptyText = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

const isDecimalLexeme = (value: unknown): value is string =>
  typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value);

/**
 * 1. 地理主数据与企业所在地角色核对（防止西澳州冒充全国、防止把企业总部/注册地当成矿山生产所在地，防止把海关统计区代码直接当 ISO 代码互换）
 */
export function validateGeoRegionHierarchy(regions: readonly GeoRegionMaster[]): Map<string, GeoRegionMaster> {
  if (!regions.length) fail('GEO_EMPTY', '地理主数据不能为空。');
  const map = new Map<string, GeoRegionMaster>();
  for (const region of regions) {
    if (!isNonEmptyText(region.regionId) || !isNonEmptyText(region.namespace)
      || !isNonEmptyText(region.code) || !isNonEmptyText(region.name)
      || !isNonEmptyText(region.statisticalScheme)) {
      fail('GEO_INVALID', `地理节点 ${String(region.regionId)} 缺少明确的命名空间、代码或统计体系。`);
    }
    if (map.has(region.regionId)) fail('GEO_DUPLICATE', `地理节点 ${region.regionId} 重复。`);
    map.set(region.regionId, region);
  }
  for (const region of regions) {
    if (region.parentRegionId) {
      const parent = map.get(region.parentRegionId);
      if (!parent) fail('GEO_PARENT_MISSING', `地理节点 ${region.regionId} 的上级区域 ${region.parentRegionId} 未登记。`);
      if (region.parentRegionId === region.regionId) fail('GEO_CYCLE', `地理节点 ${region.regionId} 不能以自身为父区域。`);
    }
  }
  return map;
}

export function assertGeoScopeCompatibility(
  declaredRegionId: string,
  expectedRegionId: string,
  regions: ReadonlyMap<string, GeoRegionMaster>,
): void {
  const declared = regions.get(declaredRegionId);
  const expected = regions.get(expectedRegionId);
  if (!declared || !expected) return fail('GEO_NOT_FOUND', '待核对的地理区域未在主数据中登记。');
  if (declared.regionId !== expected.regionId) {
    fail('GEO_SCOPE_MISMATCH',
      `地理统计范围不匹配：数据实际范围为 ${declared.name}（${declared.regionId}, ${declared.kind}），不能直接标为或混入 ${expected.name}（${expected.regionId}, ${expected.kind}）。`);
  }
  if (declared.namespace !== expected.namespace || declared.statisticalScheme !== expected.statisticalScheme) {
    fail('GEO_SCHEME_MISMATCH',
      `地理编码体系不同（${declared.statisticalScheme} vs ${expected.statisticalScheme}）；海关统计区域代码不能直接当作普通 ISO/M49 代码互换。`);
  }
}

export function resolveEnterpriseProductionExposureRegions(
  entityId: string,
  bindings: readonly EnterpriseLocationBinding[],
): { productionRegions: string[]; nonProductionRolesIgnored: EnterpriseLocationRole[] } {
  const entityBindings = bindings.filter(b => b.entityId === entityId);
  const productionRegions = [...new Set(entityBindings.filter(b => b.role === 'produces_in').map(b => b.regionId))];
  const nonProductionRolesIgnored = [...new Set(entityBindings.filter(b => b.role !== 'produces_in').map(b => b.role))];
  return { productionRegions, nonProductionRolesIgnored };
}

/**
 * 2. 商品主数据、加工阶段、计量基础与 HS 外部分类换版核对
 * （防止精矿实物重与含铜量混加、异地开采与冶炼混加、干吨与湿吨混加、活牛头数与牛肉重量混加、HS 换版近似映射静默拼接）
 */
export function assertCommodityQuantityCompatibility(
  items: readonly { commodityId: string; stageCode: string; quantityBasis: CommodityQuantityBasis; unitCode: string; category?: GeoObservationCategory }[],
): void {
  if (items.length < 2) return;
  const first = items[0]!;
  for (const item of items.slice(1)) {
    if (item.quantityBasis !== first.quantityBasis) {
      fail('QUANTITY_BASIS_MISMATCH',
        `数量计量基础不相容（${first.quantityBasis} ≠ ${item.quantityBasis}）：精矿实物重与金属含量、干吨与湿吨、活牛头数与胴体/商品肉重量严禁直接相加或混算。`);
    }
    if (item.unitCode !== first.unitCode) {
      fail('UNIT_MISMATCH', `计量单位不相容（${first.unitCode} ≠ ${item.unitCode}）。`);
    }
    if (item.stageCode !== first.stageCode) {
      fail('STAGE_MISMATCH',
        `商品加工阶段不同（${first.stageCode} ≠ ${item.stageCode}）：不同加工阶段（如铜矿开采精矿与异地精炼铜、活牛与屠宰分割肉）严禁直接相加作为同一阶段总供给。`);
    }
  }
}

export function checkHsClassificationContinuity(
  left: CommodityExternalClassification,
  right: CommodityExternalClassification,
): { continuous: boolean; gap: string | null } {
  if (left.scheme !== right.scheme) {
    return { continuous: false, gap: `外部分类体系不同（${left.scheme} vs ${right.scheme}），不能直接拼接时间序列。` };
  }
  if (left.mappingQuality !== 'exact' || right.mappingQuality !== 'exact') {
    const quality = left.mappingQuality !== 'exact' ? left.mappingQuality : right.mappingQuality;
    return {
      continuous: false,
      gap: `外部分类（${left.scheme} ${left.version}→${right.version}）映射质量为 ${quality}（存在拆分、合并或近似对应），不能自动合并为无断点时间序列。`,
    };
  }
  if (left.version !== right.version && left.code !== right.code) {
    return {
      continuous: false,
      gap: `外部分类版本由 ${left.version}(${left.code}) 切换为 ${right.version}(${right.code})，须显式应用版本转换桥并标注修订断点。`,
    };
  }
  return { continuous: true, gap: null };
}

/**
 * 3. 地区供需观测、设施扰动区分与由数据生成摘要标签
 */
export function validateGeoCommodityObservation(obs: GeoCommodityObservation): void {
  if (obs.category === 'inventory' && obs.inventoryScope === 'port_annual_throughput') {
    fail('THROUGHPUT_AS_INVENTORY', '港口全年吞吐量属于期间流量，严禁作为期末库存（存量）录入。');
  }
  if (obs.category === 'actual_output' && obs.capacityStatus && ['planned', 'under_construction'].includes(obs.capacityStatus)) {
    fail('PLANNED_CAPACITY_AS_OUTPUT', '规划或在建产能严禁计入当期实际产出。');
  }
  if (obs.valueState === 'valid_value' || obs.valueState === 'estimated') {
    if (!isDecimalLexeme(obs.value)) fail('OBSERVATION_VALUE', `观测 ${obs.observationKey} 缺少有效十进制数值。`);
  } else if (obs.valueState === 'reported_zero') {
    if (obs.value !== '0' && obs.value !== '0.0') fail('OBSERVATION_ZERO', `观测 ${obs.observationKey} 的 reported_zero 值必须为 0。`);
  } else if (obs.value !== null) {
    fail('OBSERVATION_NULL_STATE', `观测 ${obs.observationKey} 状态为 ${obs.valueState} 时不得填入零或数值。`);
  }
}

export type GeoCommoditySummaryLabelKind =
  | 'major_producer'
  | 'major_processor'
  | 'net_exporter'
  | 'import_concentrated'
  | 'major_consumer';

export interface GeoCommoditySummaryLabel {
  labelKind: GeoCommoditySummaryLabelKind;
  regionId: string;
  commodityId: string;
  stageCode: string;
  periodLabel: string;
  quantityBasis: CommodityQuantityBasis;
  unitCode: string;
  methodVersion: typeof GLOBAL_SUPPLY_TRADE_VERSION;
  criterion: string;
  metricValue: string;
  underlyingObservationKeys: readonly string[];
}

/**
 * C07-B3 由底层供需与贸易观测数据生成国家/商品摘要标签（禁止无时期、无方法、无底层依据的“盛产某商品”静态标签）
 */
export function deriveGeoCommoditySummaryLabels(input: {
  regionId: string;
  commodityId: string;
  stageCode: string;
  periodLabel: string;
  quantityBasis: CommodityQuantityBasis;
  unitCode: string;
  productionShare?: { share: string; threshold: string; observationKeys: readonly string[]; isProcessingStage?: boolean };
  consumptionShare?: { share: string; threshold: string; observationKeys: readonly string[] };
  apparentSupply?: ApparentSupplyResult & { observationKeys: readonly string[] };
  importConcentration?: PartnerShareAndHhiResult & { hhiThreshold: string; observationKeys: readonly string[] };
}): GeoCommoditySummaryLabel[] {
  const labels: GeoCommoditySummaryLabel[] = [];
  if (input.productionShare) {
    if (!input.productionShare.observationKeys.length) fail('SUMMARY_LABEL_EVIDENCE', '生成生产/加工地区摘要标签必须引用底层观测键。');
    const share = toScaledBigInt(input.productionShare.share);
    const threshold = toScaledBigInt(input.productionShare.threshold);
    if (share >= threshold) {
      labels.push({
        labelKind: input.productionShare.isProcessingStage ? 'major_processor' : 'major_producer',
        regionId: input.regionId,
        commodityId: input.commodityId,
        stageCode: input.stageCode,
        periodLabel: input.periodLabel,
        quantityBasis: input.quantityBasis,
        unitCode: input.unitCode,
        methodVersion: GLOBAL_SUPPLY_TRADE_VERSION,
        criterion: `stage_output_share >= ${input.productionShare.threshold}`,
        metricValue: input.productionShare.share,
        underlyingObservationKeys: [...input.productionShare.observationKeys],
      });
    }
  }
  if (input.consumptionShare) {
    if (!input.consumptionShare.observationKeys.length) fail('SUMMARY_LABEL_EVIDENCE', '生成主要消费市场标签必须引用底层观测键。');
    if (toScaledBigInt(input.consumptionShare.share) >= toScaledBigInt(input.consumptionShare.threshold)) {
      labels.push({
        labelKind: 'major_consumer',
        regionId: input.regionId,
        commodityId: input.commodityId,
        stageCode: input.stageCode,
        periodLabel: input.periodLabel,
        quantityBasis: input.quantityBasis,
        unitCode: input.unitCode,
        methodVersion: GLOBAL_SUPPLY_TRADE_VERSION,
        criterion: `domestic_use_share >= ${input.consumptionShare.threshold}`,
        metricValue: input.consumptionShare.share,
        underlyingObservationKeys: [...input.consumptionShare.observationKeys],
      });
    }
  }
  if (input.apparentSupply && input.apparentSupply.netPosition === 'net_exporter' && input.apparentSupply.netImportRatio !== null) {
    if (!input.apparentSupply.observationKeys.length) fail('SUMMARY_LABEL_EVIDENCE', '生成净出口地区标签必须引用底层观测键。');
    labels.push({
      labelKind: 'net_exporter',
      regionId: input.regionId,
      commodityId: input.commodityId,
      stageCode: input.stageCode,
      periodLabel: input.periodLabel,
      quantityBasis: input.quantityBasis,
      unitCode: input.unitCode,
      methodVersion: GLOBAL_SUPPLY_TRADE_VERSION,
      criterion: 'net_imports < 0 and apparent_supply > 0',
      metricValue: input.apparentSupply.netImportRatio,
      underlyingObservationKeys: [...input.apparentSupply.observationKeys],
    });
  }
  if (input.importConcentration && input.importConcentration.hhi !== null) {
    if (!input.importConcentration.observationKeys.length) fail('SUMMARY_LABEL_EVIDENCE', '生成进口来源集中标签必须引用底层观测键。');
    if (toScaledBigInt(input.importConcentration.hhi) >= toScaledBigInt(input.importConcentration.hhiThreshold)) {
      labels.push({
        labelKind: 'import_concentrated',
        regionId: input.regionId,
        commodityId: input.commodityId,
        stageCode: input.stageCode,
        periodLabel: input.periodLabel,
        quantityBasis: input.quantityBasis,
        unitCode: input.unitCode,
        methodVersion: GLOBAL_SUPPLY_TRADE_VERSION,
        criterion: `import_source_hhi >= ${input.importConcentration.hhiThreshold}`,
        metricValue: input.importConcentration.hhi,
        underlyingObservationKeys: [...input.importConcentration.observationKeys],
      });
    }
  }
  return labels;
}

export interface DisruptionEventInput {
  eventId: string;
  disruptionKind: 'mine_output_reduction' | 'port_loading_delay' | 'vessel_arrival_delay' | 'facility_market_access_suspension';
  affectedRegionId: string;
  affectedFacilityId?: string | null;
  affectedCommodityId: string;
  affectedStageCode: string;
  destinationRegionId?: string | null;
  durationDays: number;
  affectedQuantity: string;
  quantityBasis: CommodityQuantityBasis;
}

export interface DisruptionClassification {
  eventId: string;
  permanentSupplyLoss: string;
  delayedDeliverableQuantity: string;
  scopeRestriction: 'facility_and_destination_only' | 'facility_only' | 'region_stage';
  nationwideExportInterrupted: false;
  explanation: string;
}

/**
 * 区分矿山减产、港口装船延迟、到港延迟与单一工厂暂停市场准入：
 * 短期港口关闭不得直接变成“相同数量的矿产永久损失”；单一牛肉出口工厂暂停准入不得把全国所有牛肉出口标成中断。
 */
export function classifySupplyDisruptionImpact(input: DisruptionEventInput): DisruptionClassification {
  if (!isDecimalLexeme(input.affectedQuantity)) fail('DISRUPTION_QUANTITY', '扰动影响数量须为精确十进制字符串。');
  if (input.disruptionKind === 'port_loading_delay' || input.disruptionKind === 'vessel_arrival_delay') {
    return {
      eventId: input.eventId,
      permanentSupplyLoss: '0',
      delayedDeliverableQuantity: input.affectedQuantity,
      scopeRestriction: input.affectedFacilityId ? 'facility_only' : 'region_stage',
      nationwideExportInterrupted: false,
      explanation: '短期港口装船或到港延迟属于物流交付时点后移，不直接计为等量矿产永久产出损失。',
    };
  }
  if (input.disruptionKind === 'facility_market_access_suspension') {
    if (!input.affectedFacilityId || !input.destinationRegionId) {
      fail('MARKET_ACCESS_SCOPE_REQUIRED', '出口工厂暂停准入必须明确绑定具体工厂（affectedFacilityId）与目的地市场（destinationRegionId）。');
    }
    return {
      eventId: input.eventId,
      permanentSupplyLoss: '0',
      delayedDeliverableQuantity: input.affectedQuantity,
      scopeRestriction: 'facility_and_destination_only',
      nationwideExportInterrupted: false,
      explanation: `仅约束工厂 ${input.affectedFacilityId} 向目的地 ${input.destinationRegionId} 的适用商品准入，不扩大为全国出口中断。`,
    };
  }
  return {
    eventId: input.eventId,
    permanentSupplyLoss: input.affectedQuantity,
    delayedDeliverableQuantity: '0',
    scopeRestriction: input.affectedFacilityId ? 'facility_only' : 'region_stage',
    nationwideExportInterrupted: false,
    explanation: '矿山或产线实际减产计入对应商品阶段的当期产出减少。',
  };
}

/**
 * 4. 双边贸易观测、五类聚合防重叠门禁与进出口镜像差异诊断（C09）
 */
export function assertTradeAggregationNoOverlap(
  observations: readonly TradeObservation[],
  regions: ReadonlyMap<string, GeoRegionMaster>,
): void {
  if (observations.length < 2) return;
  const first = observations[0]!;
  assertCommodityQuantityCompatibility(observations.map(o => ({
    commodityId: o.commodityId,
    stageCode: o.stageCode,
    quantityBasis: o.quantityBasis,
    unitCode: o.quantityUnitCode,
  })));
  // 5. 月度、年度、财年、累计值禁止混加
  const periodBases = new Set(observations.map(o => o.periodBasis));
  if (periodBases.size > 1) {
    fail('AGGREGATION_PERIOD_MIXED', `禁止将不同期间频率或累计口径（${[...periodBases].join(', ')}）混加。`);
  }
  // 4. 总流量与已包含其中的子流量（如 export 与 re_export）禁止同加
  const flows = new Set(observations.map(o => o.flow));
  if (observations.some(o => o.isSubFlowOf && flows.has(o.isSubFlowOf))) {
    fail('AGGREGATION_SUBFLOW_OVERLAP', '禁止将总贸易流与已包含在其中的子流量（如总出口与再出口）同时相加。');
  }
  // 3. HS 父层级与所属子层级禁止同加
  const hsCodes = new Set(observations.map(o => o.externalClassification.code));
  for (const obs of observations) {
    const code = obs.externalClassification.code;
    const parent = obs.externalClassification.parentCode;
    if (parent && hsCodes.has(parent)) {
      fail('AGGREGATION_HS_HIERARCHY_OVERLAP', `禁止将 HS 父项（${parent}）与所属子项（${code}）同时相加。`);
    }
    for (const other of hsCodes) {
      if (other !== code && code.startsWith(other) && obs.externalClassification.scheme === first.externalClassification.scheme) {
        fail('AGGREGATION_HS_PREFIX_OVERLAP', `禁止将外部分类上级代码（${other}）与下级细分代码（${code}）同时相加。`);
      }
    }
  }
  // 1 & 2. 世界总计（WORLD）与各伙伴明细、区域集团与其成员国禁止同加
  const partners = new Set(observations.map(o => o.partnerRegionId));
  for (const partnerId of partners) {
    const meta = regions.get(partnerId);
    if (!meta) continue;
    if ((meta.code === 'WORLD' || meta.code === 'W00') && partners.size > 1) {
      fail('AGGREGATION_WORLD_TOTAL_OVERLAP', '禁止将世界总计（WORLD）与各具体伙伴地区明细同时相加。');
    }
    if (meta.kind === 'regional_bloc' && meta.memberRegionIds?.some(memberId => partners.has(memberId))) {
      fail('AGGREGATION_BLOC_MEMBER_OVERLAP', `禁止将区域集团（${meta.regionId}）与其已包含的成员地区同时相加。`);
    }
  }
}

export interface MirrorDiscrepancyDiagnosis {
  exporterRegionId: string;
  importerRegionId: string;
  commodityId: string;
  stageCode: string;
  periodLabel: string;
  exporterReportedQuantity: string | null;
  importerReportedQuantity: string | null;
  exporterReportedValue: string | null;
  importerReportedValue: string | null;
  exporterValuation: TradeValuationBasis;
  importerValuation: TradeValuationBasis;
  quantityDifference: string | null;
  valueDifference: string | null;
  status: 'exact_match' | 'explainable_statistical_mirror_difference';
  plausibleReasons: ('cif_vs_fob_valuation' | 'third_region_transit_or_consignment' | 'cross_period_in_transit_lag' | 'confidential_or_unreported_suppression' | 'statistical_system_difference')[];
}

function subtractDecimals(a: string, b: string, scale = 6): string {
  const toBig = (s: string) => {
    const neg = s.startsWith('-');
    const u = neg ? s.slice(1) : s;
    const [w = '0', f = ''] = u.split('.');
    const v = BigInt(w + f.slice(0, scale).padEnd(scale, '0'));
    return neg ? -v : v;
  };
  const diff = toBig(a) - toBig(b);
  const neg = diff < 0n;
  const abs = (neg ? -diff : diff).toString().padStart(scale + 1, '0');
  const w = abs.slice(0, abs.length - scale);
  const f = abs.slice(abs.length - scale).replace(/0+$/u, '');
  return (neg ? '-' : '') + (f ? `${w}.${f}` : w);
}

/**
 * C09 双边贸易进出口镜像差异诊断：
 * 若商品阶段或计量基础不匹配则直接报错阻断；若属同口径下的双边统计差异，则保留双方原报值并给出差异原因诊断，不机械改数或判脏。
 */
export function diagnoseBilateralTradeMirror(
  exportObs: TradeObservation,
  importObs: TradeObservation,
): MirrorDiscrepancyDiagnosis {
  if (exportObs.flow !== 'export' || importObs.flow !== 'import') {
    fail('MIRROR_FLOW_INVALID', '镜像对比须分别传入出口方报告的 export 与进口方报告的 import 观测。');
  }
  if (exportObs.reporterRegionId !== importObs.partnerRegionId || exportObs.partnerRegionId !== importObs.reporterRegionId) {
    fail('MIRROR_PARTNER_MISMATCH', '镜像对比的报告地区与伙伴地区未能互为镜像。');
  }
  assertCommodityQuantityCompatibility([
    { commodityId: exportObs.commodityId, stageCode: exportObs.stageCode, quantityBasis: exportObs.quantityBasis, unitCode: exportObs.quantityUnitCode },
    { commodityId: importObs.commodityId, stageCode: importObs.stageCode, quantityBasis: importObs.quantityBasis, unitCode: importObs.quantityUnitCode },
  ]);
  const reasons: MirrorDiscrepancyDiagnosis['plausibleReasons'] = [];
  if (exportObs.valuationBasis !== importObs.valuationBasis) reasons.push('cif_vs_fob_valuation');
  if (exportObs.secondPartnerRegionId || importObs.secondPartnerRegionId
    || exportObs.partnerRole !== 'last_known_destination' || importObs.partnerRole !== 'origin') {
    reasons.push('third_region_transit_or_consignment');
  }
  if (exportObs.valueState !== 'valid_value' || importObs.valueState !== 'valid_value'
    || exportObs.quantityState !== 'valid_value' || importObs.quantityState !== 'valid_value') {
    reasons.push('confidential_or_unreported_suppression');
  }
  const qtyDiff = exportObs.quantity && importObs.quantity ? subtractDecimals(exportObs.quantity, importObs.quantity) : null;
  const valDiff = exportObs.primaryValue && importObs.primaryValue && exportObs.currencyCode === importObs.currencyCode
    ? subtractDecimals(exportObs.primaryValue, importObs.primaryValue) : null;
  if ((qtyDiff && qtyDiff !== '0') || (valDiff && valDiff !== '0')) {
    if (!reasons.includes('cross_period_in_transit_lag')) reasons.push('cross_period_in_transit_lag');
    if (!reasons.includes('statistical_system_difference')) reasons.push('statistical_system_difference');
  }
  const exact = qtyDiff === '0' && valDiff === '0' && reasons.length === 0;
  return {
    exporterRegionId: exportObs.reporterRegionId,
    importerRegionId: importObs.reporterRegionId,
    commodityId: exportObs.commodityId,
    stageCode: exportObs.stageCode,
    periodLabel: exportObs.periodLabel,
    exporterReportedQuantity: exportObs.quantity,
    importerReportedQuantity: importObs.quantity,
    exporterReportedValue: exportObs.primaryValue,
    importerReportedValue: importObs.primaryValue,
    exporterValuation: exportObs.valuationBasis,
    importerValuation: importObs.valuationBasis,
    quantityDifference: qtyDiff,
    valueDifference: valDiff,
    status: exact ? 'exact_match' : 'explainable_statistical_mirror_difference',
    plausibleReasons: reasons,
  };
}

/**
 * 5. W08 三种历史视角（snapshot_contents / market_known_at / system_held_at）全面过滤：
 * 同时过滤贸易观测、供需观测、设施/企业关系、政策准入，并识别 Comtrade 等无历史版本档案来源在 market_known_at 下的缺口。
 */
export function filterTemporalRecordsAtPerspective<T extends { temporal: TemporalQualification }>(
  records: readonly T[],
  perspective: {
    historyMode: 'snapshot_contents' | 'market_known_at' | 'system_held_at';
    cutoffUtc?: string;
    usableStage?: 'acquired' | 'custodied' | 'published_readable';
    businessEffectiveAtUtc?: string;
  },
): { visible: T[]; gaps: { code: string; revisionId: string; reason: string }[] } {
  const visible: T[] = [];
  const gaps: { code: string; revisionId: string; reason: string }[] = [];
  const cutoffMs = perspective.cutoffUtc ? parseR1Utc(perspective.cutoffUtc) : NaN;
  if (perspective.historyMode !== 'snapshot_contents' && !Number.isFinite(cutoffMs)) {
    fail('HISTORY_CUTOFF_REQUIRED', `${perspective.historyMode} 必须提供有效的秒级 UTC 截止时间。`);
  }
  const businessMs = perspective.businessEffectiveAtUtc ? parseR1Utc(perspective.businessEffectiveAtUtc) : NaN;
  const stageRank = { acquired: 1, custodied: 2, published_readable: 3 } as const;

  for (const record of records) {
    const t = record.temporal;
    if (Number.isFinite(businessMs)) {
      const startMs = parseR1Utc(t.effectiveStartUtc);
      const endMs = parseR1Utc(t.effectiveEndExclusiveUtc);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || businessMs < startMs || businessMs >= endMs) {
        continue;
      }
    }
    if (perspective.historyMode === 'snapshot_contents') {
      visible.push(record);
      continue;
    }
    if (perspective.historyMode === 'market_known_at') {
      if (t.revisionArchivePolicy === 'current_revision_only') {
        gaps.push({
          code: 'HISTORICAL_PUBLIC_ARCHIVE_UNAVAILABLE',
          revisionId: t.revisionId,
          reason: '该来源仅保留当前最新修订版（如 UN Comtrade 无永久历次版本档案），不能在 market_known_at 下宣称还原当年市场已知数据。',
        });
        continue;
      }
      const pubMs = t.publicTimeUtc ? parseR1Utc(t.publicTimeUtc) : NaN;
      if (!Number.isFinite(pubMs)) {
        gaps.push({ code: 'PUBLIC_TIME_UNKNOWN', revisionId: t.revisionId, reason: '缺少可核对的历史首次公开时间。' });
        continue;
      }
      if (pubMs <= cutoffMs) visible.push(record);
      continue;
    }
    // system_held_at
    const requiredStage = perspective.usableStage ?? 'published_readable';
    const heldMs = t.systemHeldAtUtc ? parseR1Utc(t.systemHeldAtUtc) : NaN;
    if (!Number.isFinite(heldMs)) {
      gaps.push({ code: 'SYSTEM_HELD_TIME_UNKNOWN', revisionId: t.revisionId, reason: '缺少本系统实际持有该版本的时间戳。' });
      continue;
    }
    if (heldMs <= cutoffMs && stageRank[t.usableStage] >= stageRank[requiredStage]) {
      visible.push(record);
    }
  }
  return { visible, gaps };
}

/**
 * 6. 全球供需联动六类指标（生产份额、进口来源份额、出口市场份额、HHI、表观国内供给 A=P+M-X-ΔS 与净进口占比 R=(M-X)/A、企业四类地区敞口）
 */
const SCALE = 1_000_000n; // 6 decimal places for exact deterministic ratios
function toScaledBigInt(lexeme: string): bigint {
  if (!isDecimalLexeme(lexeme)) fail('DECIMAL_INVALID', `无效十进制数：${lexeme}`);
  const neg = lexeme.startsWith('-');
  const u = neg ? lexeme.slice(1) : lexeme;
  const [w = '0', f = ''] = u.split('.');
  const val = BigInt(w) * SCALE + BigInt(f.slice(0, 6).padEnd(6, '0'));
  return neg ? -val : val;
}
function fromScaledBigInt(val: bigint, decimals = 6): string {
  const neg = val < 0n;
  const abs = neg ? -val : val;
  const w = abs / SCALE;
  const f = (abs % SCALE).toString().padStart(6, '0').slice(0, decimals).replace(/0+$/u, '');
  return (neg && (w > 0n || f.length > 0) ? '-' : '') + (f ? `${w.toString()}.${f}` : w.toString());
}

export interface PartnerShareAndHhiResult {
  methodVersion: typeof GLOBAL_SUPPLY_TRADE_VERSION;
  measureKind: 'quantity' | 'value';
  totalDenominator: string;
  observedNumeratorSum: string;
  observedCoverageRatio: string;
  coverageComplete: boolean;
  shares: { partnerRegionId: string; amount: string; share: string }[];
  hhi: string | null;
  gaps: string[];
}

/**
 * 计算分阶段生产份额、进口来源份额、出口市场份额及来源/市场集中度 HHI = Σ(s_i^2)：
 * 覆盖不足时，保留已观察份额与缺口，严禁将几个已观察伙伴重新归一化成“全球完整的 100%”。
 */
export function computeSharesAndHhi(input: {
  measureKind: 'quantity' | 'value';
  totalDenominator: string;
  partners: readonly { partnerRegionId: string; amount: string }[];
}): PartnerShareAndHhiResult {
  const total = toScaledBigInt(input.totalDenominator);
  if (total <= 0n) fail('NONPOSITIVE_DENOMINATOR', '份额计算的分母必须大于零。');
  let sum = 0n;
  const shares = input.partners.map(p => {
    const amt = toScaledBigInt(p.amount);
    if (amt < 0n) fail('NEGATIVE_PARTNER_AMOUNT', '伙伴产量或贸易量不能为负。');
    sum += amt;
    const s = (amt * SCALE) / total;
    return { partnerRegionId: p.partnerRegionId, amount: p.amount, shareScaled: s, share: fromScaledBigInt(s) };
  });
  if (sum > total) {
    fail('PARTNER_SUM_EXCEEDS_TOTAL', '各伙伴明细之和超过同口径总分母，存在重复计数或口径混加。');
  }
  const coverageScaled = (sum * SCALE) / total;
  const coverageComplete = sum === total;
  const gaps: string[] = [];
  let hhi: string | null = null;
  if (!coverageComplete) {
    gaps.push(`当前已观察伙伴合计仅占总口径的 ${fromScaledBigInt(coverageScaled)}（未达 100%）；未将局部样本重归一化为完整 100%。`);
  }
  // HHI = Σ(s_i^2)
  let hhiScaled = 0n;
  for (const item of shares) {
    hhiScaled += (item.shareScaled * item.shareScaled) / SCALE;
  }
  hhi = fromScaledBigInt(hhiScaled);
  return {
    methodVersion: GLOBAL_SUPPLY_TRADE_VERSION,
    measureKind: input.measureKind,
    totalDenominator: input.totalDenominator,
    observedNumeratorSum: fromScaledBigInt(sum),
    observedCoverageRatio: fromScaledBigInt(coverageScaled),
    coverageComplete,
    shares: shares.map(({ partnerRegionId, amount, share }) => ({ partnerRegionId, amount, share })),
    hhi,
    gaps,
  };
}

export interface ApparentSupplyResult {
  methodVersion: typeof GLOBAL_SUPPLY_TRADE_VERSION;
  basisKind: 'inventory_adjusted' | 'unadjusted_no_inventory';
  measureKind: 'quantity' | 'value';
  quantityBasis: CommodityQuantityBasis;
  unitCode: string;
  apparentSupply: string | null;
  netImports: string;
  netImportRatio: string | null;
  netPosition: 'net_importer' | 'net_exporter' | 'balanced' | 'indeterminate';
  gaps: string[];
}

/**
 * 表观国内供给 A = P + M - X - ΔS（其中 ΔS = 期末库存 - 期初库存，库存增加减少当期可用供给）
 * 与表观净进口占比 R = (M - X) / A：
 * - 缺库存时另列 unadjusted_no_inventory 口径（A = P + M - X）；
 * - 分母 A <= 0 时不计算比率 R；
 * - R < 0 表达净出口特征，绝不强行裁剪为零。
 */
export function computeApparentSupplyAndNetImportRatio(input: {
  measureKind: 'quantity' | 'value';
  quantityBasis: CommodityQuantityBasis;
  unitCode: string;
  production: string;
  imports: string;
  exports: string;
  beginningInventory?: string | null;
  endingInventory?: string | null;
}): ApparentSupplyResult {
  const P = toScaledBigInt(input.production);
  const M = toScaledBigInt(input.imports);
  const X = toScaledBigInt(input.exports);
  const netImports = M - X;
  const hasInventory = input.beginningInventory !== undefined && input.beginningInventory !== null
    && input.endingInventory !== undefined && input.endingInventory !== null;
  const gaps: string[] = [];
  let deltaS = 0n;
  if (hasInventory) {
    deltaS = toScaledBigInt(input.endingInventory!) - toScaledBigInt(input.beginningInventory!);
  } else {
    gaps.push('缺少同口径期初/期末库存，本次采用未调整库存的表观供给口径（A = P + M - X）。');
  }
  const A = P + M - X - deltaS;
  if (A <= 0n) {
    gaps.push('表观国内供给分母非正（A <= 0），不计算表观净进口占比。');
    return {
      methodVersion: GLOBAL_SUPPLY_TRADE_VERSION,
      basisKind: hasInventory ? 'inventory_adjusted' : 'unadjusted_no_inventory',
      measureKind: input.measureKind,
      quantityBasis: input.quantityBasis,
      unitCode: input.unitCode,
      apparentSupply: fromScaledBigInt(A),
      netImports: fromScaledBigInt(netImports),
      netImportRatio: null,
      netPosition: 'indeterminate',
      gaps,
    };
  }
  const R = (netImports * SCALE) / A;
  const netPosition: ApparentSupplyResult['netPosition'] = netImports > 0n
    ? 'net_importer'
    : netImports < 0n ? 'net_exporter' : 'balanced';
  return {
    methodVersion: GLOBAL_SUPPLY_TRADE_VERSION,
    basisKind: hasInventory ? 'inventory_adjusted' : 'unadjusted_no_inventory',
    measureKind: input.measureKind,
    quantityBasis: input.quantityBasis,
    unitCode: input.unitCode,
    apparentSupply: fromScaledBigInt(A),
    netImports: fromScaledBigInt(netImports),
    netImportRatio: fromScaledBigInt(R),
    netPosition,
    gaps,
  };
}

export type EnterpriseRegionalExposureKind = 'production' | 'procurement' | 'revenue' | 'logistics';

export interface EnterpriseRegionalExposureClaim {
  entityId: string;
  exposureKind: EnterpriseRegionalExposureKind;
  disclosedRegionId: string;
  targetQueryRegionId: string;
  disclosedAmount: string | null;
  entityTotalAmount: string | null;
  evidenceKind: 'financial_report_segment' | 'top5_counterparty_disclosure' | 'facility_asset_disclosure' | 'macro_trade_share_inference';
  macroTradeShareUsedForProration?: boolean;
}

/**
 * 企业四类地区敞口（生产、采购、收入、物流）边界核对：
 * 1. 严禁把国家双边贸易关系（macro_trade_share_inference）直接当成企业采购（supplies_to）或地区收入证据；
 * 2. “海外收入”只支持海外范围，“亚太收入”只支持亚太范围，严禁按某国宏观贸易份额将企业未披露的具体国家比例自动分摊出来。
 */
export function evaluateEnterpriseRegionalExposure(
  claim: EnterpriseRegionalExposureClaim,
  regions: ReadonlyMap<string, GeoRegionMaster>,
): {
  status: 'verified_direct_exposure' | 'unknown_direct_exposure';
  exposureRatio: string | null;
  reason: string;
} {
  if (claim.macroTradeShareUsedForProration === true || claim.evidenceKind === 'macro_trade_share_inference') {
    fail('MACRO_TRADE_PRORATION_FORBIDDEN',
      '禁止按照国家宏观贸易份额将企业未披露的地区收入或采购比例自动分摊，国家双边贸易不能充当企业直接采购或销售证据。');
  }
  const disclosedRegion = regions.get(claim.disclosedRegionId);
  const targetRegion = regions.get(claim.targetQueryRegionId);
  if (!disclosedRegion || !targetRegion) return fail('GEO_NOT_FOUND', '敞口核对涉及的地理区域未登记。');
  if (disclosedRegion.regionId !== targetRegion.regionId) {
    // Например,财报只披露了“海外”或“亚太”（regional_bloc），而查询的是具体国家（如秘鲁 PER 或澳大利亚 AUS）
    return {
      status: 'unknown_direct_exposure',
      exposureRatio: null,
      reason: `企业仅披露了 ${disclosedRegion.name}（${disclosedRegion.regionId}）范围数据，未披露 ${targetRegion.name}（${targetRegion.regionId}）细分明细；保持企业直接敞口 unknown，不按宏观贸易份额拆分。`,
    };
  }
  if (!claim.disclosedAmount || !claim.entityTotalAmount) {
    return {
      status: 'unknown_direct_exposure',
      exposureRatio: null,
      reason: '缺少企业在该地区的具体披露金额或企业同项总金额，直接敞口比例保持 unknown。',
    };
  }
  const num = toScaledBigInt(claim.disclosedAmount);
  const den = toScaledBigInt(claim.entityTotalAmount);
  if (den <= 0n || num < 0n || num > den) fail('EXPOSURE_AMOUNT_INVALID', '企业地区敞口分子或总分母数值无效。');
  return {
    status: 'verified_direct_exposure',
    exposureRatio: fromScaledBigInt((num * SCALE) / den),
    reason: `基于 ${claim.evidenceKind} 核实的企业直接${claim.exposureKind}敞口。`,
  };
}

/**
 * 7. C07-C 冲击传导情景（Shock Transmission Scenario）七要素契约核对：
 * 强制区分事实节点与推演假设节点、区分新闻出处核对与价格因果确认、禁止将不同含义的百分比连乘伪造精确企业风险值。
 */
export interface ShockTransmissionNode {
  nodeId: string;
  nodeNature: 'verified_fact' | 'inferred_step';
  relationLayer: 'direct_bilateral_trade' | 'icio_tiva_indirect_value_added' | 'enterprise_direct_contract' | 'event_impact_hypothesis';
  description: string;
  evidenceSpanRef: string | null;
}

export interface ShockTransmissionScenario {
  scenarioId: string;
  modelId: string;
  promptDigest: string;
  triggerScope: {
    eventId: string;
    regionId: string;
    facilityId?: string | null;
    commodityId: string;
    stageCode: string;
    startUtc: string;
    endExclusiveUtc?: string | null;
  };
  nodes: readonly ShockTransmissionNode[];
  transmissionMechanism: readonly ('physical_shortage' | 'delivery_delay' | 'cost_pass_through' | 'demand_shift')[];
  bufferConditions: {
    inventoryDaysAvailable?: string | null;
    longTermContractCoverage?: string | null;
    certifiedSubstituteAvailable?: boolean | null;
    hedgingOrSpareCapacityNote?: string | null;
  };
  timeLagWindow: {
    shipmentArrivalLagDays?: number | null;
    costRecognitionLagDays?: number | null;
    earningsImpactQuarter?: string | null;
  };
  invalidationConditions: readonly string[];
  coverageAndMethodVersion: {
    methodVersion: string;
    dataCoverageNote: string;
    sourceVerified: boolean;
    causalityEstablished: boolean;
    chainedPercentageMultiplicationUsed?: boolean;
  };
}

export function validateShockTransmissionScenario(scenario: unknown): {
  valid: true;
  scenarioDigest: string;
  factNodeCount: number;
  hypothesisNodeCount: number;
  contentNature: 'hypothesis_candidate';
} {
  if (!isWfdRecord(scenario)) fail('SCENARIO_OBJECT', 'C07-C 冲击传导情景必须为结构化对象。');
  const s = scenario as unknown as ShockTransmissionScenario;
  if (!isNonEmptyText(s.scenarioId) || !isNonEmptyText(s.modelId) || !isNonEmptyText(s.promptDigest)) {
    fail('SCENARIO_IDENTITY', '冲击传导情景必须绑定 scenarioId、modelId 与 promptDigest。');
  }
  if (!isWfdRecord(s.triggerScope) || !isNonEmptyText(s.triggerScope.eventId)
    || !isNonEmptyText(s.triggerScope.regionId) || !isNonEmptyText(s.triggerScope.commodityId)
    || !isNonEmptyText(s.triggerScope.stageCode) || !Number.isFinite(parseR1Utc(s.triggerScope.startUtc))) {
    fail('SCENARIO_TRIGGER_SCOPE', '冲击传导情景必须明确触发事件及适用范围（地区、商品、阶段、起始 UTC 时间）。');
  }
  if (!Array.isArray(s.nodes) || !s.nodes.length) fail('SCENARIO_NODES', '冲击传导情景必须逐跳列出事实节点与假设推演节点。');
  let factNodeCount = 0, hypothesisNodeCount = 0;
  for (const node of s.nodes) {
    if (!isWfdRecord(node) || !['verified_fact', 'inferred_step'].includes(String(node.nodeNature))
      || !['direct_bilateral_trade', 'icio_tiva_indirect_value_added', 'enterprise_direct_contract', 'event_impact_hypothesis'].includes(String(node.relationLayer))
      || !isNonEmptyText(node.description, 2000)) {
      fail('SCENARIO_NODE_INVALID', '传导节点必须明确区分 verified_fact（已证实事实）与 inferred_step（推演假设）及所属关系层。');
    }
    if (node.nodeNature === 'verified_fact') {
      if (!isNonEmptyText(node.evidenceSpanRef)) fail('SCENARIO_FACT_EVIDENCE_REQUIRED', `已证实事实节点 ${node.nodeId} 必须绑定原文或观测证据引用。`);
      factNodeCount++;
    } else {
      hypothesisNodeCount++;
    }
  }
  if (!Array.isArray(s.transmissionMechanism) || !s.transmissionMechanism.length
    || s.transmissionMechanism.some(m => !['physical_shortage', 'delivery_delay', 'cost_pass_through', 'demand_shift'].includes(String(m)))) {
    fail('SCENARIO_MECHANISM', '冲击传导情景必须声明至少一种传导机制（实物不足/交付延迟/成本变化/需求变化）。');
  }
  if (!isWfdRecord(s.bufferConditions) || !isWfdRecord(s.timeLagWindow)) {
    fail('SCENARIO_BUFFER_OR_LAG', '冲击传导情景必须显式包含缓冲条件（库存/长协/替代/备用产能）与时间滞后窗口。');
  }
  if (!Array.isArray(s.invalidationConditions) || !s.invalidationConditions.length
    || s.invalidationConditions.some(item => !isNonEmptyText(item, 1000))) {
    fail('SCENARIO_INVALIDATION', '冲击传导情景必须声明至少一条可证伪的失效条件。');
  }
  const meta = s.coverageAndMethodVersion;
  if (!isWfdRecord(meta) || !isNonEmptyText(meta.methodVersion) || !isNonEmptyText(meta.dataCoverageNote, 2000)
    || typeof meta.sourceVerified !== 'boolean' || typeof meta.causalityEstablished !== 'boolean') {
    fail('SCENARIO_COVERAGE_META', '冲击传导情景必须分开声明 sourceVerified（新闻出处已核）与 causalityEstablished（价格/利润因果已证实）。');
  }
  if (meta.chainedPercentageMultiplicationUsed === true) {
    fail('SCENARIO_CHAINED_PERCENTAGE_FORBIDDEN',
      '禁止把直接贸易份额、ICIO/TiVA 跨国投入产出比与事件影响假设等不同含义的百分比直接连乘生成伪精确的企业风险值。');
  }
  if (hypothesisNodeCount > 0 && meta.causalityEstablished === true) {
    fail('SCENARIO_CAUSALITY_CLAIM_FORBIDDEN', '包含推演假设节点的情景不能将 causalityEstablished 标为已证实因果事实。');
  }
  return {
    valid: true,
    scenarioDigest: wfdSha256(canonicalWfdJson(s)),
    factNodeCount,
    hypothesisNodeCount,
    contentNature: 'hypothesis_candidate',
  };
}
