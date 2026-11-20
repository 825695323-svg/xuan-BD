import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCommodityQuantityCompatibility,
  assertGeoScopeCompatibility,
  assertTradeAggregationNoOverlap,
  checkHsClassificationContinuity,
  classifySupplyDisruptionImpact,
  computeApparentSupplyAndNetImportRatio,
  computeSharesAndHhi,
  deriveGeoCommoditySummaryLabels,
  diagnoseBilateralTradeMirror,
  evaluateEnterpriseRegionalExposure,
  filterTemporalRecordsAtPerspective,
  resolveEnterpriseProductionExposureRegions,
  validateGeoCommodityObservation,
  validateGeoRegionHierarchy,
  validateShockTransmissionScenario,
  type GeoCommodityObservation,
  type GeoRegionMaster,
  type TradeObservation,
} from './global-supply-trade.js';
import {
  resolveFinancialConceptRule,
  scaleFinancialUnitValue,
  verifyFinancialStatementArticulation,
  FINANCIAL_MAPPING_V2_VERSION,
} from './financial-fixed.js';
import {
  assertCrossSourceProductAdmission,
  compareProfileSemantics,
  readSourceFieldProfile,
} from '../source-field-profile.js';
import {
  checkR1RelationRows,
  compileR1RelationDeclaration,
} from '../r1-relation.js';

const REGIONS: readonly GeoRegionMaster[] = [
  { regionId: 'WORLD', namespace: 'un.m49', code: 'WORLD', name: '全球总计', kind: 'regional_bloc', statisticalScheme: 'UN_M49' },
  { regionId: 'APAC', namespace: 'xuan.region', code: 'APAC', name: '亚太地区', kind: 'regional_bloc', memberRegionIds: ['AUS', 'CHN'], statisticalScheme: 'XUAN_BLOC' },
  { regionId: 'AUS', namespace: 'iso.3166', code: 'AUS', name: '澳大利亚全国', kind: 'country_or_region', parentRegionId: 'APAC', statisticalScheme: 'ISO_3166_1' },
  { regionId: 'AUS-WA', namespace: 'iso.3166.2', code: 'AUS-WA', name: '西澳州', kind: 'state_or_province', parentRegionId: 'AUS', statisticalScheme: 'ISO_3166_2' },
  { regionId: 'PER', namespace: 'iso.3166', code: 'PER', name: '秘鲁', kind: 'country_or_region', statisticalScheme: 'ISO_3166_1' },
  { regionId: 'CHN', namespace: 'iso.3166', code: 'CHN', name: '中国', kind: 'country_or_region', parentRegionId: 'APAC', statisticalScheme: 'ISO_3166_1' },
  { regionId: 'FRA-ISO', namespace: 'iso.3166', code: 'FRA', name: '法国（ISO行政范围）', kind: 'country_or_region', statisticalScheme: 'ISO_3166_1' },
  { regionId: 'FRA-CUSTOMS', namespace: 'un.comtrade.customs', code: '251', name: '法国（海关统计区域）', kind: 'customs_statistical_area', statisticalScheme: 'COMTRADE_CUSTOMS' },
];

test('验收场景1（地域错配拦截）：西澳州不混同澳大利亚全国、海关统计区不混同ISO、企业总部/上市地不冒充矿山生产地', () => {
  const regionMap = validateGeoRegionHierarchy(REGIONS);
  assert.doesNotThrow(() => assertGeoScopeCompatibility('AUS-WA', 'AUS-WA', regionMap));
  // 西澳州 2024-25 财年 864 百万干吨铁矿石不能被标为澳大利亚全国
  assert.throws(
    () => assertGeoScopeCompatibility('AUS-WA', 'AUS', regionMap),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_GEO_SCOPE_MISMATCH',
  );
  // UN Comtrade 法国海关统计范围代码不能直接当作普通 ISO 代码互换
  assert.throws(
    () => assertGeoScopeCompatibility('FRA-CUSTOMS', 'FRA-ISO', regionMap),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_GEO_SCOPE_MISMATCH',
  );
  // 企业股票在 A 地上市、总部在 B 地、矿山在 C 地：生产供给敞口只连接 C 地矿山
  const resolved = resolveEnterpriseProductionExposureRegions('miner_entity_1', [
    { entityId: 'miner_entity_1', role: 'listed_on', regionId: 'CHN', evidenceBasis: '交易所挂牌档案' },
    { entityId: 'miner_entity_1', role: 'headquartered_in', regionId: 'CHN', evidenceBasis: '年报公司简介' },
    { entityId: 'miner_entity_1', role: 'produces_in', regionId: 'PER', facilityId: 'mine_las_bambas', evidenceBasis: '年报矿山资产附注' },
  ]);
  assert.deepEqual(resolved.productionRegions, ['PER']);
  assert.deepEqual(resolved.nonProductionRolesIgnored, ['listed_on', 'headquartered_in']);
});

test('验收场景2（数量口径与阶段错配拦截）：秘鲁铜三量分离、澳洲铁矿干湿吨分离、澳洲活牛头数与牛肉重量分离、延迟不作永久减产、单厂暂停不作全国中断', () => {
  // 秘鲁铜：精矿实物重量（gross_weight）与其中含铜量（metal_content）不能直接相加
  assert.throws(
    () => assertCommodityQuantityCompatibility([
      { commodityId: 'copper_concentrate', stageCode: 'concentrate', quantityBasis: 'gross_weight', unitCode: 'metric_ton' },
      { commodityId: 'copper_concentrate', stageCode: 'concentrate', quantityBasis: 'metal_content', unitCode: 'metric_ton' },
    ]),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_QUANTITY_BASIS_MISMATCH',
  );
  // 秘鲁开采的铜精矿与另一地区冶炼的精炼铜（不同阶段）即使都是金属吨，也不能相加称为全球新增铜供给
  assert.throws(
    () => assertCommodityQuantityCompatibility([
      { commodityId: 'copper_concentrate', stageCode: 'mine_concentrate_cu', quantityBasis: 'metal_content', unitCode: 'metric_ton' },
      { commodityId: 'refined_copper_cathode', stageCode: 'smelting_refined_cu', quantityBasis: 'metal_content', unitCode: 'metric_ton' },
    ]),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_STAGE_MISMATCH',
  );
  // 澳大利亚铁矿石：干吨（dry_weight）与湿吨（wet_weight）不能混算
  assert.throws(
    () => assertCommodityQuantityCompatibility([
      { commodityId: 'iron_ore_fines', stageCode: 'beneficiation_fines', quantityBasis: 'dry_weight', unitCode: 'million_ton' },
      { commodityId: 'iron_ore_fines', stageCode: 'beneficiation_fines', quantityBasis: 'wet_weight', unitCode: 'million_ton' },
    ]),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_QUANTITY_BASIS_MISMATCH',
  );
  // 澳大利亚牛肉：活牛头数（head_count）、胴体重量（carcass_weight）、商品肉装运重量（shipped_weight）不能混算
  assert.throws(
    () => assertCommodityQuantityCompatibility([
      { commodityId: 'live_cattle', stageCode: 'live_cattle_export', quantityBasis: 'head_count', unitCode: 'head' },
      { commodityId: 'chilled_boneless_beef', stageCode: 'primal_cuts_export', quantityBasis: 'shipped_weight', unitCode: 'metric_ton' },
    ]),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_QUANTITY_BASIS_MISMATCH',
  );
  // 短期港口关闭只计装船延迟，不计为矿产永久损失
  const portDelay = classifySupplyDisruptionImpact({
    eventId: 'evt_hedland_cyclone_3d',
    disruptionKind: 'port_loading_delay',
    affectedRegionId: 'AUS-WA',
    affectedFacilityId: 'port_hedland',
    affectedCommodityId: 'iron_ore_fines',
    affectedStageCode: 'rail_port_shipment',
    durationDays: 3,
    affectedQuantity: '4500000',
    quantityBasis: 'wet_weight',
  });
  assert.equal(portDelay.permanentSupplyLoss, '0');
  assert.equal(portDelay.delayedDeliverableQuantity, '4500000');
  assert.equal(portDelay.nationwideExportInterrupted, false);

  // 某牛肉出口工厂暂停市场准入，只约束该工厂、该产品、该目的地，不把全国所有牛肉出口标成中断
  const plantSuspension = classifySupplyDisruptionImpact({
    eventId: 'evt_beef_plant_239_suspend',
    disruptionKind: 'facility_market_access_suspension',
    affectedRegionId: 'AUS',
    affectedFacilityId: 'abattoir_est_239',
    affectedCommodityId: 'frozen_beef_cuts',
    affectedStageCode: 'chilled_frozen_trade',
    destinationRegionId: 'CHN',
    durationDays: 60,
    affectedQuantity: '12000',
    quantityBasis: 'shipped_weight',
  });
  assert.equal(plantSuspension.scopeRestriction, 'facility_and_destination_only');
  assert.equal(plantSuspension.nationwideExportInterrupted, false);
});

const baseTemporal = {
  effectiveStartUtc: '2025-01-01T00:00:00Z',
  effectiveEndExclusiveUtc: '2026-01-01T00:00:00Z',
  publicTimeUtc: '2026-02-15T00:00:00Z',
  systemHeldAtUtc: '2026-02-16T00:00:00Z',
  usableStage: 'published_readable' as const,
  revisionArchivePolicy: 'versioned_archive' as const,
  revisionId: 'rev_1',
};

function makeTradeObs(overrides: Partial<TradeObservation> = {}): TradeObservation {
  return {
    observationKey: 'trade_per_chn_cu_conc_2025',
    reporterRegionId: 'PER',
    reporterStatisticalScheme: 'ISO_3166_1',
    partnerRegionId: 'CHN',
    partnerRole: 'last_known_destination',
    flow: 'export',
    commodityId: 'copper_concentrate',
    stageCode: 'concentrate',
    externalClassification: { scheme: 'HS', version: 'HS2022', code: '260300', aggrLevel: 6, parentCode: '2603', mappingQuality: 'exact' },
    periodBasis: 'calendar_year',
    periodLabel: '2025',
    primaryValue: '15200000000',
    currencyCode: 'USD',
    valuationBasis: 'FOB',
    valueState: 'valid_value',
    quantity: '6800000',
    quantityBasis: 'dry_weight',
    quantityUnitCode: 'metric_ton',
    quantityState: 'valid_value',
    temporal: baseTemporal,
    sourceId: 'minem_peru',
    ...overrides,
  };
}

test('验收场景3（聚合防重叠与镜像差异诊断）：阻断五类重叠相加，保留进出口双方镜像统计差异与原因解释', () => {
  const regionMap = validateGeoRegionHierarchy(REGIONS);
  const perToChn = makeTradeObs();
  const perToAus = makeTradeObs({ observationKey: 'trade_per_aus', partnerRegionId: 'AUS', quantity: '100000' });
  assert.doesNotThrow(() => assertTradeAggregationNoOverlap([perToChn, perToAus], regionMap));

  // 1. 世界总计与伙伴明细同时相加 -> 阻断
  assert.throws(
    () => assertTradeAggregationNoOverlap([perToChn, makeTradeObs({ partnerRegionId: 'WORLD' })], regionMap),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_AGGREGATION_WORLD_TOTAL_OVERLAP',
  );
  // 2. 区域集团（APAC）与其成员国（CHN）同时相加 -> 阻断
  assert.throws(
    () => assertTradeAggregationNoOverlap([perToChn, makeTradeObs({ partnerRegionId: 'APAC' })], regionMap),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_AGGREGATION_BLOC_MEMBER_OVERLAP',
  );
  // 3. HS 父项（2603）与子项（260300）同时相加 -> 阻断
  assert.throws(
    () => assertTradeAggregationNoOverlap([
      perToChn,
      makeTradeObs({ externalClassification: { scheme: 'HS', version: 'HS2022', code: '2603', aggrLevel: 4, mappingQuality: 'exact' } }),
    ], regionMap),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_AGGREGATION_HS_HIERARCHY_OVERLAP',
  );
  // 4. 总流量（export）与子流量（re_export）同时相加 -> 阻断
  assert.throws(
    () => assertTradeAggregationNoOverlap([perToChn, makeTradeObs({ flow: 're_export', isSubFlowOf: 'export' })], regionMap),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_AGGREGATION_SUBFLOW_OVERLAP',
  );
  // 5. 月度值与年度值混加 -> 阻断
  assert.throws(
    () => assertTradeAggregationNoOverlap([perToChn, makeTradeObs({ periodBasis: 'month', periodLabel: '2025-01' })], regionMap),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_AGGREGATION_PERIOD_MIXED',
  );

  // 镜像差异诊断：秘鲁报告对华出口（FOB） vs 中国报告自秘鲁进口（CIF，且含跨期在途差）
  const chnImportFromPer = makeTradeObs({
    observationKey: 'trade_chn_per_cu_conc_2025',
    reporterRegionId: 'CHN',
    partnerRegionId: 'PER',
    partnerRole: 'origin',
    flow: 'import',
    primaryValue: '15850000000',
    valuationBasis: 'CIF',
    quantity: '6750000',
  });
  const mirror = diagnoseBilateralTradeMirror(perToChn, chnImportFromPer);
  assert.equal(mirror.status, 'explainable_statistical_mirror_difference');
  assert.equal(mirror.exporterReportedValue, '15200000000');
  assert.equal(mirror.importerReportedValue, '15850000000');
  assert.equal(mirror.quantityDifference, '50000');
  assert.ok(mirror.plausibleReasons.includes('cif_vs_fob_valuation'));
  assert.ok(mirror.plausibleReasons.includes('cross_period_in_transit_lag'));
});

test('验收场景4（分类换版与跨源G5门禁）：HS拆分/合并近似映射识别缺口，不同口径来源禁止混入同一产品', () => {
  const hs2017 = { scheme: 'HS', version: 'HS2017', code: '283691', aggrLevel: 6, mappingQuality: 'exact' as const };
  const hs2022Approx = { scheme: 'HS', version: 'HS2022', code: '283691', aggrLevel: 6, mappingQuality: 'partial_overlap' as const };
  const check = checkHsClassificationContinuity(hs2017, hs2022Approx);
  assert.equal(check.continuous, false);
  assert.match(check.gap ?? '', /partial_overlap/);

  // G5 跨来源比较：西澳干吨财年统计 vs 另一来源湿吨自然年统计
  const baseProfile = {
    version: 'bd.source-field-profile/1',
    profileId: 'wa_iron_ore_dmt_fy',
    sourceId: 'wa_govt_digest',
    series: 'iron_ore_output',
    fields: [{ originalHeader: 'output_dmt', fieldCode: 'output_ton', dataType: 'decimal', unitCode: 'count', role: 'value', measurement: '西澳铁矿石干吨产量' }],
    frequency: 'other',
    timeBucket: { labelSemantics: 'start', interval: 'closed_open', lengthMinutes: 525600, timezone: 'UTC' },
    adjustment: { status: 'raw' },
    domainScope: {
      domain: 'geo_commodity',
      statisticalAreaScheme: 'ISO_3166_2_AUS_WA',
      processingStage: 'beneficiation_fines_lump',
      quantityBasis: 'dry_weight',
      periodBasis: 'fiscal_year',
      commodityClassification: { scheme: 'HS', version: 'HS2022', mappingQuality: 'exact' },
    },
    confirmation: { status: 'operator_confirmed', basis: '西澳政府 2024-25 Statistics Digest 干吨财年口径核实', confirmedAtUtc: '2026-11-20T00:00:00Z' },
  };
  const left = readSourceFieldProfile(baseProfile, 'wa.json');
  const rightWetCalendar = readSourceFieldProfile({
    ...baseProfile,
    profileId: 'aus_iron_ore_wmt_cy',
    sourceId: 'other_provider',
    domainScope: {
      ...baseProfile.domainScope,
      statisticalAreaScheme: 'ISO_3166_1_AUS',
      quantityBasis: 'wet_weight',
      periodBasis: 'calendar_year',
    },
  }, 'other.json');
  const cmp = compareProfileSemantics(left, rightWetCalendar);
  assert.equal(cmp.status, 'different_semantics');
  assert.ok(cmp.differences.some(d => d.includes('计量数量基础不同')));
  assert.ok(cmp.differences.some(d => d.includes('统计期间口径不同')));
  assert.throws(
    () => assertCrossSourceProductAdmission(rightWetCalendar, [left]),
    (err: { code?: string }) => err.code === 'G5_CROSS_SOURCE_SEMANTIC_CONFLICT',
  );
  const sep = assertCrossSourceProductAdmission(rightWetCalendar, [left], { allowNewDefinitionVersion: true });
  assert.equal(sep.action, 'require_new_definition_version');
});

test('验收场景5（W08历史回放防倒灌）：后公开的贸易修订、后投产的设施不提前可见，无历史版本档案的Comtrade数据在market_known_at显式报缺口', () => {
  const earlyPub = makeTradeObs({
    observationKey: 'obs_2025_initial',
    temporal: { ...baseTemporal, publicTimeUtc: '2026-02-10T00:00:00Z', systemHeldAtUtc: '2026-02-12T00:00:00Z', revisionId: 'rev_initial' },
  });
  const lateRevision = makeTradeObs({
    observationKey: 'obs_2025_revised_in_oct',
    temporal: { ...baseTemporal, publicTimeUtc: '2026-10-01T00:00:00Z', systemHeldAtUtc: '2026-10-02T00:00:00Z', revisionId: 'rev_oct' },
  });
  const comtradeCurrentOnly = makeTradeObs({
    observationKey: 'obs_comtrade_no_vintage',
    temporal: { ...baseTemporal, publicTimeUtc: null, revisionArchivePolicy: 'current_revision_only', revisionId: 'rev_comtrade_current' },
  });

  // 在 2026-03-01 市场已知视角下：初报可见、10月修订不可见、无历史版本档案的 Comtrade 报明确缺口且不混入结果
  const marketView = filterTemporalRecordsAtPerspective([earlyPub, lateRevision, comtradeCurrentOnly], {
    historyMode: 'market_known_at',
    cutoffUtc: '2026-03-01T00:00:00Z',
  });
  assert.deepEqual(marketView.visible.map(r => r.observationKey), ['obs_2025_initial']);
  assert.equal(marketView.gaps.length, 1);
  assert.equal(marketView.gaps[0]?.code, 'HISTORICAL_PUBLIC_ARCHIVE_UNAVAILABLE');

  // 在 2026-02-11 系统持有视角下（早于本系统 02-12 实际入库时间）：初报虽已市场公开但本系统当时尚未持有，不可见
  const heldViewBefore = filterTemporalRecordsAtPerspective([earlyPub], {
    historyMode: 'system_held_at',
    cutoffUtc: '2026-02-11T00:00:00Z',
    usableStage: 'published_readable',
  });
  assert.equal(heldViewBefore.visible.length, 0);
});

test('验收场景6（六类指标、宏观与企业直接敞口证据边界、数据生成摘要标签及C07-C冲击传导情景契约）', () => {
  const regionMap = validateGeoRegionHierarchy(REGIONS);
  // 1. 份额与 HHI：覆盖不足时不强行重归一化为 100%
  const importShares = computeSharesAndHhi({
    measureKind: 'quantity',
    totalDenominator: '1000',
    partners: [
      { partnerRegionId: 'PER', amount: '500' },
      { partnerRegionId: 'AUS', amount: '300' },
    ],
  });
  assert.equal(importShares.coverageComplete, false);
  assert.equal(importShares.observedCoverageRatio, '0.8');
  assert.equal(importShares.shares[0]?.share, '0.5');
  assert.equal(importShares.shares[1]?.share, '0.3');
  // HHI = 0.5^2 + 0.3^2 = 0.25 + 0.09 = 0.34
  assert.equal(importShares.hhi, '0.34');
  assert.equal(importShares.gaps.length, 1);

  // 2. 表观国内供给 A = P + M - X - ΔS 与净进口占比 R = (M - X) / A
  // 秘鲁铜精矿净出口国：P=2600, M=0, X=2400, 期初库存=100, 期末库存=150 (ΔS=+50) -> A = 2600 + 0 - 2400 - 50 = 150, R = -2400 / 150 = -16
  const peruApparent = computeApparentSupplyAndNetImportRatio({
    measureKind: 'quantity',
    quantityBasis: 'metal_content',
    unitCode: 'kiloton_cu',
    production: '2600',
    imports: '0',
    exports: '2400',
    beginningInventory: '100',
    endingInventory: '150',
  });
  assert.equal(peruApparent.apparentSupply, '150');
  assert.equal(peruApparent.netImports, '-2400');
  assert.equal(peruApparent.netImportRatio, '-16');
  assert.equal(peruApparent.netPosition, 'net_exporter');

  // 3. 由底层观测数据生成“主要生产地区 / 净出口地区”摘要标签，可点回底层观测键
  const labels = deriveGeoCommoditySummaryLabels({
    regionId: 'PER',
    commodityId: 'copper_concentrate',
    stageCode: 'mine_concentrate_cu',
    periodLabel: '2025',
    quantityBasis: 'metal_content',
    unitCode: 'kiloton_cu',
    productionShare: { share: '0.12', threshold: '0.1', observationKeys: ['obs_per_cu_output_2025', 'obs_world_cu_output_2025'] },
    apparentSupply: { ...peruApparent, observationKeys: ['obs_per_cu_output_2025', 'obs_per_cu_export_2025', 'obs_per_cu_stock_2025'] },
  });
  assert.deepEqual(labels.map(l => l.labelKind), ['major_producer', 'net_exporter']);
  assert.deepEqual(labels[0]?.underlyingObservationKeys, ['obs_per_cu_output_2025', 'obs_world_cu_output_2025']);

  // 4. 宏观与企业直接敞口证据边界：企业仅披露“亚太地区（APAC）”收入，查询具体国家“澳大利亚（AUS）”时返回 unknown，且禁止按宏观贸易份额分摊
  const unknownDirect = evaluateEnterpriseRegionalExposure({
    entityId: 'smelter_co_1',
    exposureKind: 'revenue',
    disclosedRegionId: 'APAC',
    targetQueryRegionId: 'AUS',
    disclosedAmount: '300000000',
    entityTotalAmount: '1000000000',
    evidenceKind: 'financial_report_segment',
  }, regionMap);
  assert.equal(unknownDirect.status, 'unknown_direct_exposure');
  assert.equal(unknownDirect.exposureRatio, null);

  assert.throws(
    () => evaluateEnterpriseRegionalExposure({
      entityId: 'smelter_co_1',
      exposureKind: 'procurement',
      disclosedRegionId: 'PER',
      targetQueryRegionId: 'PER',
      disclosedAmount: '100',
      entityTotalAmount: '1000',
      evidenceKind: 'macro_trade_share_inference',
      macroTradeShareUsedForProration: true,
    }, regionMap),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_MACRO_TRADE_PRORATION_FORBIDDEN',
  );

  // 5. C07-C 冲击传导情景七要素核对：分离事实节点与推演节点、分离出处核实与因果确认、禁止跨层百分比连乘
  const scenario = validateShockTransmissionScenario({
    scenarioId: 'scen_peru_mine_road_blockade_2025',
    modelId: 'xuan-supply-analyst-v1',
    promptDigest: 'sha256:' + 'a'.repeat(64),
    triggerScope: {
      eventId: 'evt_las_bambas_corridor_blockade',
      regionId: 'PER',
      facilityId: 'mine_las_bambas',
      commodityId: 'copper_concentrate',
      stageCode: 'mine_concentrate_cu',
      startUtc: '2025-05-01T00:00:00Z',
    },
    nodes: [
      { nodeId: 'n1', nodeNature: 'verified_fact', relationLayer: 'direct_bilateral_trade', description: '矿山运输通道受阻公告', evidenceSpanRef: 'claim_excerpt_1' },
      { nodeId: 'n2', nodeNature: 'inferred_step', relationLayer: 'event_impact_hypothesis', description: '预计下月到港铜精矿减少导致现货 TC 走低', evidenceSpanRef: null },
    ],
    transmissionMechanism: ['delivery_delay', 'cost_pass_through'],
    bufferConditions: { inventoryDaysAvailable: '28', longTermContractCoverage: '0.75', certifiedSubstituteAvailable: true },
    timeLagWindow: { shipmentArrivalLagDays: 35, costRecognitionLagDays: 60, earningsImpactQuarter: '2025Q3' },
    invalidationConditions: ['运输走廊在 10 日内恢复通行且港口缓冲库存足以覆盖装船计划'],
    coverageAndMethodVersion: {
      methodVersion: 'shock-scenario/1',
      dataCoverageNote: '秘鲁 MINEM 月度产量与企业年报长协披露，不含非上市贸易商在途隐性库存',
      sourceVerified: true,
      causalityEstablished: false,
    },
  });
  assert.equal(scenario.valid, true);
  assert.equal(scenario.factNodeCount, 1);
  assert.equal(scenario.hypothesisNodeCount, 1);

  assert.throws(
    () => validateShockTransmissionScenario({
      scenarioId: 'bad_chained_product',
      modelId: 'm1',
      promptDigest: 'd1',
      triggerScope: { eventId: 'e1', regionId: 'PER', commodityId: 'cu', stageCode: 's1', startUtc: '2025-05-01T00:00:00Z' },
      nodes: [{ nodeId: 'n1', nodeNature: 'verified_fact', relationLayer: 'direct_bilateral_trade', description: 'd', evidenceSpanRef: 'ref1' }],
      transmissionMechanism: ['physical_shortage'],
      bufferConditions: {},
      timeLagWindow: {},
      invalidationConditions: ['复产'],
      coverageAndMethodVersion: {
        methodVersion: 'v1',
        dataCoverageNote: 'note',
        sourceVerified: true,
        causalityEstablished: false,
        chainedPercentageMultiplicationUsed: true,
      },
    }),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_SCENARIO_CHAINED_PERCENTAGE_FORBIDDEN',
  );
});

test('财报录入四行业科目表（cas-primary-statements/2）、单位显式倍率换算、三表区间容限勾稽与关系完整快照边界', () => {
  // 1. 四行业模板与非线性科目（EPS 禁止 additive）
  assert.equal(resolveFinancialConceptRule('归属于母公司股东的净利润', FINANCIAL_MAPPING_V2_VERSION, 'general_industrial')?.code, 'net_profit_parent');
  assert.equal(resolveFinancialConceptRule('（一）基本每股收益', FINANCIAL_MAPPING_V2_VERSION, 'general_industrial')?.additive, false);
  assert.equal(resolveFinancialConceptRule('发放贷款和垫款', FINANCIAL_MAPPING_V2_VERSION, 'commercial_bank')?.code, 'bank_loans_and_advances');
  assert.equal(resolveFinancialConceptRule('保险服务收入', FINANCIAL_MAPPING_V2_VERSION, 'insurance')?.code, 'ins_service_revenue');
  assert.equal(resolveFinancialConceptRule('融出资金', FINANCIAL_MAPPING_V2_VERSION, 'securities')?.code, 'sec_margin_accounts_receivable');

  // 2. 单位倍率无损换算与原始最低有效位半径保留（百万元保留1位小数 -> half-ULP = 50000 元）
  const scaled = scaleFinancialUnitValue('12.3', 'cny_million');
  assert.equal(scaled.scaledValue, '12300000');
  assert.equal(scaled.declaredPrecisionHalfUlp, '50000');

  // 3. C09 三表线性勾稽区间容限校验：百万元披露保留1位小数导致 0.1 百万元（100,000 元）四舍五入尾差 -> within_declared_quantization_tolerance
  const articulation = verifyFinancialStatementArticulation([
    scaleFinancialUnitValue('100.0', 'cny_million'),
    scaleFinancialUnitValue('60.0', 'cny_million'),
    scaleFinancialUnitValue('39.9', 'cny_million'),
  ].map((s, idx) => ({
    concept: ['total_assets', 'total_liabilities', 'total_equity'][idx]!,
    scaledValue: s.scaledValue,
    declaredPrecisionHalfUlp: s.declaredPrecisionHalfUlp,
  })));
  const bs01 = articulation.find(item => item.ruleId === 'BS-01')!;
  assert.equal(bs01.status, 'within_declared_quantization_tolerance');
  assert.equal(bs01.residual, '100000');
  assert.equal(bs01.toleranceRadius, '150000');

  // 4. r1-relation.ts：显式 membership_set:true 的板块完整成分集支持 complete_snapshot，但贸易关系（trade_flow_projection）严禁声称 complete_snapshot
  const completeThemeDecl = {
    protocol: 'wfd.structured-ingest/1.0',
    mapping: {
      kind: 'relation_edges',
      businessKey: 'key',
      relationType: 'type',
      object: { kind: 'object_kind', namespace: 'object_ns', id: 'object_id' },
      effectivePeriod: { status: 'unknown', sourceTimezone: 'UTC' },
      publicTime: { status: 'unknown', sourceTimezone: 'UTC' },
      fields: [{ fieldCode: 'label', value: 'label', state: 'state' }],
    },
    target: {
      subject: { kind: 'entity', namespace: 'synthetic', id: 'company_1' },
      inputMode: 'complete_snapshot',
      definition: {
        semantic_code: 'synthetic.theme.membership',
        definition_authority: 'synthetic',
        measurement_nature: 'relation',
        time_role: 'validity',
        unit_code: 'not_applicable',
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim' },
        field_definitions: [{ field_code: 'label', data_type: 'text', measurement_nature: 'relation', time_role: 'validity', unit_code: 'text' }],
      },
      coverage: {
        scope: { membership_set: true, board_id: 'BK0800' },
        basis: 'declared_full',
        completeness: 'complete',
        absence_means: 'explicitly_absent',
      },
    },
  };
  assert.equal(compileR1RelationDeclaration(completeThemeDecl).applicable, true);
  assert.equal(
    checkR1RelationRows(
      [{ key: 'm1', type: 'member_of_theme', object_kind: 'definition', object_ns: 'eastmoney_board', object_id: 'BK0800', label: 'member', state: 'valid_value' }],
      completeThemeDecl,
    ).quality,
    'pass',
  );
  // 若把 trade_flow_projection 塞进 complete_snapshot，直接拒绝
  assert.throws(
    () => checkR1RelationRows(
      [{ key: 't1', type: 'trade_flow_projection', object_kind: 'region', object_ns: 'iso', object_id: 'CHN', label: 'trade', state: 'valid_value' }],
      completeThemeDecl,
    ),
    { code: 'R1_RELATION_MAPPING' },
  );

  const validObs: GeoCommodityObservation = {
    observationKey: 'wa_iron_ore_2024_25',
    regionId: 'AUS-WA',
    commodityId: 'iron_ore_fines',
    stageCode: 'beneficiation',
    category: 'actual_output',
    metricCode: 'mine_production_dmt',
    periodBasis: 'fiscal_year',
    periodLabel: '2024-25',
    quantityBasis: 'dry_weight',
    unitCode: 'million_ton',
    value: '864',
    valueState: 'valid_value',
    capacityStatus: 'operational_effective',
    temporal: baseTemporal,
    sourceId: 'wa_govt_digest',
  };
  assert.doesNotThrow(() => validateGeoCommodityObservation(validObs));
  assert.throws(
    () => validateGeoCommodityObservation({ ...validObs, category: 'inventory', inventoryScope: 'port_annual_throughput' }),
    (err: { code?: string }) => err.code === 'GLOBAL_SUPPLY_TRADE_THROUGHPUT_AS_INVENTORY',
  );
});
