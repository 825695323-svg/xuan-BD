import { TaskError } from '../../../platform/jobs/tasks.js';
import { resolveEnterpriseProductionExposureRegions, validateGeoRegionHierarchy,
  type EnterpriseLocationRole, type EnterpriseRegionalExposureKind, type GeoRegionMaster } from './global-supply-trade.js';

interface FinancialNoteSourceFact {
  businessKey: string;
  reportId: string;
  reportVersion: string;
  sourceId?: string;
  evidenceKind?: string;
}

type CounterpartyIdentity = 'named' | 'anonymous_disclosed';
type Top5Dimension = {
  rank: '1' | '2' | '3' | '4' | '5' | 'total_top5';
  counterparty_id?: string;
  counterparty_name?: string;
  counterparty_identity?: CounterpartyIdentity;
  region_code?: string | null;
};

// The caller supplies validated note facts with normalized dimension axes and pinned report lineage.
export type FinancialNoteFact = {
  statement: 'note';
  entityId: string;
  sourceEvidenceKind: 'enterprise_financial_note';
  sourceFact: FinancialNoteSourceFact;
  disclosedRegionLabel?: string;
  disclosedRegionId?: string;
  macroTradeShareUsedForProration?: boolean;
} & (
  | { section: 'note.operating_segments'; dimension: {
    segment_axis: 'by_industry' | 'by_product' | 'by_region'; mapped_node_id?: string | null;
  } }
  | { section: 'note.facilities_and_assets'; dimension: {
    facility_id: string; region_code?: string | null; role: 'production' | 'logistics';
    location_role?: EnterpriseLocationRole | 'facility_operation';
  } }
  | { section: 'note.top5_customers' | 'note.top5_suppliers'; dimension: Top5Dimension }
  | { section: 'note.production_sales_inventory'; dimension: { product_id?: string | null } }
);

type NoteLineage = FinancialNoteSourceFact & Pick<FinancialNoteFact, 'section' | 'sourceEvidenceKind' | 'disclosedRegionLabel' | 'disclosedRegionId'>;
type FinancialNoteRelation = {
  relationType: 'produces_product' | 'operated_by' | 'located_in' | 'supplies_to' | 'purchases_from';
  subjectId: string;
  objectId: string | null;
  lineage: NoteLineage;
  counterpartyIdentity?: CounterpartyIdentity;
  counterpartyName?: string;
  disclosureRank?: Top5Dimension['rank'];
  regionId?: string;
};

type FinancialNoteExposure = {
  entityId: string;
  exposureKind: EnterpriseRegionalExposureKind;
  regionId: string;
  lineage: NoteLineage;
};

const fail = (message: string): never => { throw new TaskError('FINANCIAL_NOTE_LINKAGE', message); };
const forbidMacroShare = (): never => {
  throw new TaskError('MACRO_SHARE_ALLOCATION_FORBIDDEN', '企业敞口须保留原披露地区范围，禁止改标为更细地区或按国家宏观贸易份额分摊。');
};
const known = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const aggregateRegionKinds: ReadonlySet<GeoRegionMaster['kind']> =
  new Set(['regional_bloc', 'trade_bloc', 'continent', 'macro_region', 'aggregate']);
const regionName = (name: string) => name.trim().normalize('NFC');
const matchesRegionLabel = (region: GeoRegionMaster, label: string) =>
  regionName(region.name) === label || region.aliases?.some(alias => regionName(alias) === label) === true;

export function deriveFinancialNoteLinkages(input: {
  facts: readonly FinancialNoteFact[];
  regions: readonly GeoRegionMaster[];
  macroTradeShareUsedForProration?: boolean;
  macroShareAllocation?: unknown;
}): { relations: FinancialNoteRelation[]; exposures: FinancialNoteExposure[] } {
  if (input.macroTradeShareUsedForProration === true
    || input.macroShareAllocation != null && input.macroShareAllocation !== false) forbidMacroShare();
  const regions = input.regions.length ? validateGeoRegionHierarchy(input.regions) : new Map<string, GeoRegionMaster>();
  const aggregateRegions = [...regions.values()].filter(region => aggregateRegionKinds.has(region.kind) || region.memberRegionIds?.length);
  const relations: FinancialNoteRelation[] = [];
  const exposures: FinancialNoteExposure[] = [];
  const disclosedRegion = ({ disclosedRegionLabel: label, disclosedRegionId }: FinancialNoteFact,
    mappedRegionId: string | null | undefined): string => {
    if (mappedRegionId == null || mappedRegionId === 'unknown') return 'unknown';
    if (!known(label)) return fail('地区映射须保留企业附注明确披露的原地区标签。');
    const mappedRegion = regions.get(mappedRegionId);
    if (!mappedRegion) throw new TaskError('GLOBAL_SUPPLY_TRADE_GEO_NOT_FOUND', '待核对的地理区域未在主数据中登记。');
    const normalized = regionName(label);
    if (disclosedRegionId !== undefined && disclosedRegionId !== mappedRegionId
      || aggregateRegions.some(region => region.regionId !== mappedRegionId && matchesRegionLabel(region, normalized))
      || !matchesRegionLabel(mappedRegion, normalized)) forbidMacroShare();
    return mappedRegionId;
  };

  for (const fact of input.facts) {
    const { entityId, section, dimension, sourceFact, sourceEvidenceKind, disclosedRegionLabel, disclosedRegionId } = fact;
    if (fact.statement !== 'note' || !known(entityId) || !sourceFact
      || ![sourceFact.businessKey, sourceFact.reportId, sourceFact.reportVersion].every(known) || !dimension) {
      fail('候选关系须来自有报告版本和事实键的已核对附注。');
    }
    const evidenceTags = [sourceEvidenceKind, sourceFact.sourceId, sourceFact.evidenceKind]
      .filter(known).map(value => value.toLowerCase().replace(/[^a-z0-9]/gu, ''));
    if (fact.macroTradeShareUsedForProration === true
      || evidenceTags.some(tag => tag.includes('macrotradeshareinference'))) forbidMacroShare();
    if (evidenceTags.some(tag => tag.includes('comtrade') || tag.includes('macrobilateraltrade'))) {
      throw new TaskError('FINANCIAL_NOTE_MACRO_EVIDENCE', '企业交易关系和地区敞口须使用企业披露事实，国家双边贸易不提供此类证据。');
    }
    if (sourceEvidenceKind !== 'enterprise_financial_note') fail('候选关系须显式声明企业财务附注证据类型。');

    const lineage = { ...sourceFact, section, sourceEvidenceKind,
      ...(disclosedRegionLabel !== undefined ? { disclosedRegionLabel } : {}),
      ...(disclosedRegionId !== undefined ? { disclosedRegionId } : {}) };
    const relate = (relationType: FinancialNoteRelation['relationType'], subjectId: string, objectId: string) =>
      relations.push({ relationType, subjectId, objectId, lineage });
    const expose = (exposureKind: EnterpriseRegionalExposureKind, regionId: string) =>
      exposures.push({ entityId, exposureKind, regionId, lineage });

    if (section === 'note.operating_segments') {
      if (dimension.segment_axis === 'by_product' && known(dimension.mapped_node_id) && dimension.mapped_node_id !== 'unknown')
        relate('produces_product', entityId, dimension.mapped_node_id);
      if (dimension.segment_axis === 'by_region') expose('revenue', disclosedRegion(fact, dimension.mapped_node_id));
    } else if (section === 'note.facilities_and_assets') {
      if (!known(dimension.facility_id) || !['production', 'logistics'].includes(dimension.role))
        fail('设施附注须明确设施身份及实际经营用途。');
      const locationRole = dimension.location_role;
      const region = dimension.region_code ?? 'unknown';
      const isOperationsLocation = locationRole === undefined || locationRole === 'facility_operation'
        || dimension.role === 'production' && resolveEnterpriseProductionExposureRegions(entityId, [{
          entityId, role: locationRole, regionId: region, facilityId: dimension.facility_id,
          evidenceBasis: sourceFact.businessKey,
        }]).productionRegions.includes(region);
      const regionId = isOperationsLocation ? disclosedRegion(fact, region) : 'unknown';
      relate('operated_by', dimension.facility_id, entityId);
      if (regionId !== 'unknown') relate('located_in', dimension.facility_id, regionId);
      expose(dimension.role, regionId);
    } else if (section === 'note.top5_customers' || section === 'note.top5_suppliers') {
      if (dimension.rank === 'total_top5') continue;
      if (!['1', '2', '3', '4', '5'].includes(dimension.rank)) fail('前五大交易对手须明确原披露名次。');
      const objectId = dimension.counterparty_id ?? null;
      const counterpartyIdentity = dimension.counterparty_identity ?? (objectId ? 'named' : 'anonymous_disclosed');
      if (!['named', 'anonymous_disclosed'].includes(counterpartyIdentity)
        || objectId !== null && (!known(objectId) || objectId === 'unknown' || counterpartyIdentity !== 'named')) {
        fail('匿名交易对手须保留原披露身份，不能绑定企业主数据。');
      }
      const regionId = disclosedRegion(fact, dimension.region_code);
      const customer = section === 'note.top5_customers';
      relations.push({
        relationType: customer ? 'supplies_to' : 'purchases_from', subjectId: entityId, objectId, lineage,
        counterpartyIdentity, counterpartyName: dimension.counterparty_name, disclosureRank: dimension.rank, regionId,
      });
      expose(customer ? 'revenue' : 'procurement', regionId);
    } else if (section === 'note.production_sales_inventory') {
      if (known(dimension.product_id) && dimension.product_id !== 'unknown')
        relate('produces_product', entityId, dimension.product_id);
    } else {
      fail('附注不属于已定义的联动专项表。');
    }
  }
  return { relations, exposures };
}
