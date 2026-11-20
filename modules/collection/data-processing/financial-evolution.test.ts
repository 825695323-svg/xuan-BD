import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import {
  ChartOfAccountsRegistry, defaultFinancialCoaRegistry, financialCoaConfirmationDigest, IFRS_MAPPING_VERSION,
  inspectFinancialCoaRow, US_GAAP_MAPPING_VERSION,
  type CoaOperatorConfirmation, type CoaOperatorConfirmationReceipt, type FinancialCoaProfile, type FinancialCoaSampleRow,
} from './financial-coa-registry.js';
import { financialFactIdentity, FINANCIAL_FACT_VERSION, verifyFinancialFactRow } from './financial-fact.js';
import {
  FINANCIAL_FIXED_VERSION, FINANCIAL_MAPPING_VERSION, FINANCIAL_MAPPING_V2_VERSION, projectFinancialFixed,
  resolveFinancialConceptRule, scaleFinancialUnitValue, type FinancialCalculation, type FinancialReader,
} from './financial-fixed.js';
import { FINANCIAL_L1_TEMPLATE_VERSION, readFinancialPdfProjection, validateFinancialL1Template } from './financial-l1-templates.js';
import { deriveFinancialNoteLinkages, type FinancialNoteFact } from './financial-note-linkage.js';
import { FINANCIAL_PDF_VERSION, projectFinancialPdf, type FinancialPdfSelection } from './financial-pdf.js';
import {
  classifyAndValidateReportNature, pairComparativeFinancialPeriods, type ComparativeFinancialFact,
} from './financial-temporal-pairing.js';
import type { GeoRegionMaster } from './global-supply-trade.js';
import { XBRL_ADAPTER_VERSION } from './xbrl-table.js';

// All reports, companies, observations and confirmation records here are synthetic.
const reportId = 'fixture-report';
const reportVersion = 'v1';
const entityId = 'fixture-company';
const currentPeriod = { start_date: '2025-01-01', end_date: '2025-06-30' };
const priorPeriod = { start_date: '2024-01-01', end_date: '2024-06-30' };

async function projectFixture(values: WfdRecord, options: Partial<FinancialCalculation> = {},
  definition: WfdRecord = { dimension: 'money' }, recordFields: WfdRecord = {}, registry?: ChartOfAccountsRegistry) {
  const businessKey = 'fixture-financial-record';
  const code = values.unit ?? 'cny';
  const unit = { unit_code: code, definition, resolved: true,
    digest: 'sha256:' + wfdSha256(canonicalWfdJson({ code, definition })) };
  const snapshotId = 'fixture-snapshot', productId = 'fixture-product';
  const record = {
    ...recordFields,
    record_ref: { logical_key: businessKey, record_id: 'fixture-record', revision_id: 'r1' },
    values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
      value, value_state: 'valid_value', data_type: key === 'value' ? 'decimal' : 'text',
      unit: key === 'value' ? unit : { unit_code: 'text' },
    }])),
  };
  const reader: FinancialReader = async () => ({
    connection: { connectionId: 'fixture-reader' },
    result: { snapshot_id: snapshotId, product_id: productId, rows: [record],
      page: { has_more: false, next_cursor: null } },
  });
  return projectFinancialFixed({
    version: FINANCIAL_FIXED_VERSION, operation: 'standardize',
    inputs: [{ snapshotId, productId, businessKeys: [businessKey] }], ...options,
  }, reader, new AbortController().signal, registry);
}

test('CAS v1 default and v2 preserve historical base-unit rows', async () => {
  const values = { ...currentPeriod, concept: '其中：营业收入', statement: 'income_statement',
    accounting_standard: 'CAS', currency: 'CNY', unit: 'cny', period_type: 'duration', value: '9007199254740993.1200' };
  assert.deepEqual(resolveFinancialConceptRule(values.concept), { code: 'revenue', additive: true });
  assert.equal(resolveFinancialConceptRule('营业总收入', FINANCIAL_MAPPING_VERSION), null);
  assert.equal(resolveFinancialConceptRule('营业总收入', FINANCIAL_MAPPING_V2_VERSION)?.code, 'total_operating_revenue');
  const legacy = await projectFixture(values);
  const v2 = await projectFixture(values, { mappingProfile: FINANCIAL_MAPPING_V2_VERSION });
  assert.equal(legacy.evidence.mappingVersion, FINANCIAL_MAPPING_VERSION);
  assert.equal(v2.evidence.mappingVersion, FINANCIAL_MAPPING_V2_VERSION);
  for (const result of [legacy, v2]) {
    const [row] = JSON.parse(result.jsonBytes.toString()) as WfdRecord[];
    assert.equal(row?.concept, 'revenue');
    assert.equal(row?.original_concept, values.concept);
    assert.equal(row?.value, values.value);
    assert.equal(row?.unit, 'cny');
  }
});

const ifrsSample: FinancialCoaSampleRow = {
  concept: 'Revenue', statement: 'income_statement', periodType: 'duration',
  accountingStandard: 'IFRS', currency: 'HKD', unit: 'hkd_million', declaredScaleFactor: '1000000',
};
const usdSample: FinancialCoaSampleRow = {
  ...ifrsSample, currency: 'USD', unit: 'usd_thousand', declaredScaleFactor: '1000',
};
const fixedValues = (sample: FinancialCoaSampleRow, value: string) => ({
  ...currentPeriod, report_nature: 'formal', concept: sample.concept, statement: sample.statement,
  period_type: sample.periodType, accounting_standard: sample.accountingStandard, currency: sample.currency, unit: sample.unit, value,
});

test('IFRS L3 standardizes HKD millions and USD thousands with explicit scale and preserves currency and precision', async () => {
  const profile = defaultFinancialCoaRegistry.getFinancialCoaProfile(IFRS_MAPPING_VERSION);
  assert.ok(profile?.kind === 'builtin');
  for (const sample of [ifrsSample, usdSample]) {
    const result = inspectFinancialCoaRow(profile, sample, true);
    assert.equal(result.scaleIssue, null);
    assert.equal(result.periodConflict, false);
    assert.deepEqual(result.hits.map(rule => rule.code), ['revenue']);
    const value = sample.currency === 'HKD' ? '12.340' : '-0.0012';
    const values = fixedValues(sample, value);
    const options = { mappingProfile: IFRS_MAPPING_VERSION } as const;
    await assert.rejects(projectFixture(values, options), { code: 'FINANCIAL_FIXED' });
    const baseUnit = sample.currency.toLowerCase();
    const projected = await projectFixture(values, { ...options, allowUnitScale: true }, {
      dimension: 'money', currency: sample.currency, base_unit: baseUnit, scale_factor: sample.declaredScaleFactor,
    });
    const [row] = JSON.parse(projected.jsonBytes.toString()) as WfdRecord[];
    assert.equal(projected.evidence.mappingVersion, IFRS_MAPPING_VERSION);
    assert.equal(row?.concept, 'revenue');
    assert.equal(row?.currency, sample.currency);
    assert.equal(row?.unit, baseUnit);
    assert.equal(row?.source_unit, sample.unit);
    assert.equal(row?.unit_scale_factor, sample.declaredScaleFactor);
    assert.equal(row?.value, sample.currency === 'HKD' ? '12340000' : '-1.2');
    assert.equal(row?.declared_precision_half_ulp, sample.currency === 'HKD' ? '500' : '0.05');
  }
  assert.deepEqual(resolveFinancialConceptRule('Revenue', IFRS_MAPPING_VERSION, 'general_industrial', 'income_statement'),
    { code: 'revenue', additive: true, periodType: 'duration', unitDimension: 'money' });
  assert.deepEqual(scaleFinancialUnitValue('12.340', 'hkd_million'), {
    scaledValue: '12340000', baseUnit: 'hkd', sourceUnit: 'hkd_million', scaleFactor: '1000000',
    sourceFractionDigits: 3, declaredPrecisionHalfUlp: '500',
  });
  assert.deepEqual(scaleFinancialUnitValue('-0.0012', 'usd_thousand'), {
    scaledValue: '-1.2', baseUnit: 'usd', sourceUnit: 'usd_thousand', scaleFactor: '1000',
    sourceFractionDigits: 4, declaredPrecisionHalfUlp: '0.05',
  });
});

test('US-GAAP L3 maps USD with its own COA and rejects HKD', async () => {
  const profile = defaultFinancialCoaRegistry.getFinancialCoaProfile(US_GAAP_MAPPING_VERSION);
  assert.ok(profile?.kind === 'builtin');
  assert.deepEqual(profile.currencies, ['USD']);
  const sample = { ...usdSample, concept: 'NetIncomeLoss', accountingStandard: 'US-GAAP', unit: 'usd', declaredScaleFactor: '1' };
  assert.equal(inspectFinancialCoaRow(profile, sample, false).scaleIssue, null);
  assert.equal(resolveFinancialConceptRule(sample.concept, US_GAAP_MAPPING_VERSION)?.code, 'net_profit_parent');
  assert.equal(resolveFinancialConceptRule(sample.concept, IFRS_MAPPING_VERSION), null);
  assert.equal(inspectFinancialCoaRow(profile, { ...sample, currency: 'HKD', unit: 'hkd' }, false).scaleIssue, 'currency_mismatch');
  const options = { mappingProfile: US_GAAP_MAPPING_VERSION } as const;
  const projected = await projectFixture(fixedValues(sample, '19.0000'), options,
    { dimension: 'money', currency: 'USD', base_unit: 'usd', scale_factor: '1' });
  const [row] = JSON.parse(projected.jsonBytes.toString()) as WfdRecord[];
  assert.equal(projected.evidence.mappingVersion, US_GAAP_MAPPING_VERSION);
  assert.equal(row?.concept, 'net_profit_parent');
  assert.equal(row?.value, '19.0000');
  assert.equal(row?.currency, 'USD');
  assert.equal(row?.unit, 'usd');
  await assert.rejects(projectFixture(fixedValues({ ...sample, currency: 'HKD', unit: 'hkd' }, '19.0000'), options),
    { code: 'FINANCIAL_FIXED' });
  await assert.rejects(projectFixture({ ...fixedValues(sample, '19.0000'), statement: 'balance_sheet' }, options),
    { code: 'FINANCIAL_FIXED' });
});

test('COA replay and L3 reject undeclared units, conflicting factors and implicit currency conversion', async () => {
  const profile = defaultFinancialCoaRegistry.getFinancialCoaProfile(IFRS_MAPPING_VERSION);
  assert.ok(profile?.kind === 'builtin');
  for (const [patch, issue] of [
    [{ unit: 'hkd_billion' }, 'unknown_unit'],
    [{ declaredScaleFactor: '1000' }, 'scale_factor_mismatch'],
    [{ currency: 'USD' }, 'currency_mismatch'],
    [{ accountingStandard: 'CAS' }, 'accounting_standard_mismatch'],
  ] as const) {
    assert.equal(inspectFinancialCoaRow(profile, { ...ifrsSample, ...patch }, true).scaleIssue, issue);
  }
  assert.equal(inspectFinancialCoaRow(profile, ifrsSample, false).scaleIssue, 'scale_not_enabled');
  assert.throws(() => scaleFinancialUnitValue('12', 'hkd_billion'), { code: 'FINANCIAL_FIXED' });
  const values = fixedValues(ifrsSample, '12');
  const options = { mappingProfile: IFRS_MAPPING_VERSION, allowUnitScale: true } as const;
  for (const patch of [{ unit: 'hkd_billion' }, { unit: 'hkd_per_share' }, { currency: 'USD' }, { accounting_standard: 'CAS' }]) {
    await assert.rejects(projectFixture({ ...values, ...patch }, options), { code: 'FINANCIAL_FIXED' });
  }
  for (const definition of [{ scale_factor: '1000' }, { multiplier: 1000 }, { currency: 'USD' }, { base_unit: 'usd' }]) {
    await assert.rejects(projectFixture(values, options, { dimension: 'money', ...definition }), { code: 'FINANCIAL_FIXED' });
  }
});

test('COA adoption requires a host-verified receipt for the exact successful replay and pins L3 to the candidate digest', async () => {
  const profile = {
    id: 'fixture-coa/1', accountingStandard: 'IFRS', currencies: ['HKD'], rules: [{
      code: 'fixture_revenue', aliases: ['Revenue'], statement: 'income_statement', periodType: 'duration',
      unitDimension: 'money', additive: true, templates: ['general_industrial'],
    }],
  } as const satisfies FinancialCoaProfile;
  const issued = new Set<string>();
  const registry = new ChartOfAccountsRegistry(receipt => issued.has(receipt.receiptDigest));
  const candidate = registry.registerCandidateCoaProfile(profile);
  const unsigned = { authority: 'trusted-host', operatorId: 'fixture-reviewer', candidateDigest: candidate.candidateDigest,
    replayDigest: 'sha256:' + '0'.repeat(64), observedAtUtc: '2025-08-20T01:00:00Z' } as const;
  const confirm = (input: Omit<CoaOperatorConfirmationReceipt, 'receiptDigest'>) => ({ profileId: profile.id,
    confirmationReceipt: { ...input, receiptDigest: financialCoaConfirmationDigest(input) } });
  const pinned = { mappingProfile: profile.id, mappingProfileDigest: candidate.candidateDigest, allowUnitScale: true } as const;
  assert.equal(candidate.status, 'candidate');
  assert.equal(registry.getFinancialCoaProfile(profile.id), null);
  await assert.rejects(projectFixture(fixedValues(ifrsSample, '12'), pinned, undefined, undefined, registry), { code: 'FINANCIAL_FIXED' });
  assert.throws(() => registry.adoptCandidateCoaProfile(confirm(unsigned)), { code: 'FINANCIAL_COA_ADOPTION_REPLAY' });

  const failed = registry.replayCandidateCoaProfile(profile.id, [
    ifrsSample, { ...ifrsSample, declaredScaleFactor: '1000' },
    { ...ifrsSample, periodType: 'instant' }, { ...ifrsSample, concept: 'Unmapped fixture' },
  ]);
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.coverage, { sampleRows: 4, mappedRows: 1, ratio: 0.25 });
  assert.equal(failed.scaleDiagnostics[1]?.issue, 'scale_factor_mismatch');
  assert.deepEqual(failed.periodConflicts.map(row => row.rowIndex), [2]);
  assert.deepEqual(failed.unmappedConcepts.map(row => row.rowIndex), [3]);
  assert.throws(() => registry.adoptCandidateCoaProfile(confirm({ ...unsigned, replayDigest: failed.replayDigest })),
    { code: 'FINANCIAL_COA_ADOPTION_REPLAY' });

  const replay = registry.replayCandidateCoaProfile(profile.id, [ifrsSample]);
  assert.equal(replay.passed, true);
  assert.deepEqual(replay.coverage, { sampleRows: 1, mappedRows: 1, ratio: 1 });
  assert.equal(resolveFinancialConceptRule('Revenue', profile.id, undefined, undefined, registry), null);
  const confirmation = confirm({ ...unsigned, replayDigest: replay.replayDigest });
  const receipt = confirmation.confirmationReceipt;
  assert.throws(() => registry.adoptCandidateCoaProfile(confirmation), { code: 'FINANCIAL_COA_ADOPTION_CONFIRMATION' });
  const spoofedVerifier = () => true;
  assert.throws(() => Reflect.apply(registry.adoptCandidateCoaProfile, registry, [confirmation, spoofedVerifier]),
    { code: 'FINANCIAL_COA_ADOPTION_CONFIRMATION' });
  issued.add(receipt.receiptDigest);
  const unconfigured = new ChartOfAccountsRegistry();
  unconfigured.registerCandidateCoaProfile(profile);
  unconfigured.replayCandidateCoaProfile(profile.id, [ifrsSample]);
  assert.throws(() => Reflect.apply(unconfigured.adoptCandidateCoaProfile, unconfigured, [confirmation, spoofedVerifier]),
    { code: 'FINANCIAL_COA_ADOPTION_CONFIRMATION' });
  assert.equal(unconfigured.getFinancialCoaProfile(profile.id), null);
  assert.throws(() => registry.adoptCandidateCoaProfile({ profileId: profile.id, operatorId: receipt.operatorId } as unknown as CoaOperatorConfirmation), { code: 'FINANCIAL_COA_ADOPTION_CONFIRMATION' });
  for (const patch of [{ operatorId: 'different-reviewer' }, { authority: 'operator-http' }, { observedAtUtc: '2025-02-31T01:00:00Z' },
    { authority: 'self-asserted' }, { replayDigest: undefined }]) {
    const tampered = { ...confirmation, confirmationReceipt: { ...receipt, ...patch } } as CoaOperatorConfirmation;
    assert.throws(() => registry.adoptCandidateCoaProfile(tampered), { code: 'FINANCIAL_COA_ADOPTION_CONFIRMATION' });
  }
  for (const patch of [{ candidateDigest: unsigned.replayDigest }, { replayDigest: failed.replayDigest }]) {
    const unbound = confirm({ ...receipt, ...patch });
    issued.add(unbound.confirmationReceipt.receiptDigest);
    assert.throws(() => registry.adoptCandidateCoaProfile(unbound), { code: 'FINANCIAL_COA_ADOPTION_REPLAY' });
  }
  assert.equal(registry.getFinancialCoaProfile(profile.id), null);
  assert.deepEqual(registry.adoptCandidateCoaProfile(confirmation), { ...confirmation, status: 'adopted' });
  assert.equal(registry.getFinancialCoaProfile(profile.id)?.kind, 'adopted');
  assert.equal(resolveFinancialConceptRule('Revenue', profile.id, undefined, undefined, registry)?.code, 'fixture_revenue');
  const values = fixedValues(ifrsSample, '12');
  for (const mappingProfileDigest of [undefined, 'invalid', unsigned.replayDigest]) {
    await assert.rejects(projectFixture(values, { ...pinned, mappingProfileDigest }, undefined, undefined, registry), { code: 'FINANCIAL_FIXED' });
  }
  assert.equal(defaultFinancialCoaRegistry.getFinancialCoaProfile(profile.id), null);
  await assert.rejects(projectFixture(values, pinned), { code: 'FINANCIAL_FIXED' });
  const projected = await projectFixture(values, pinned, undefined, undefined, registry);
  const [row] = JSON.parse(projected.jsonBytes.toString()) as WfdRecord[];
  assert.equal(row?.concept, 'fixture_revenue');
  assert.equal(projected.evidence.mappingProfileDigest, candidate.candidateDigest);
  assert.equal((projected.evidence.lineage[0]?.source as WfdRecord).mappingProfileDigest, candidate.candidateDigest);
});

const l1Header = { version: FINANCIAL_L1_TEMPLATE_VERSION, preserveOriginalLexeme: true, preserveDeclaredUnit: true } as const;
function pdfTemplate(
  scope = 'consolidated',
  titles = ['合并利润表', '合并利润表（续）'],
): Extract<Parameters<typeof projectFinancialPdf>[1], { kind: 'pdf_regions' }> {
  const selection: FinancialPdfSelection = {
    version: FINANCIAL_PDF_VERSION, sourceSha256: 'a'.repeat(64),
    report: { id: reportId, version: reportVersion, subjectScheme: 'fixture', subjectCode: entityId,
      accountingStandard: 'CAS', currency: 'CNY', auditStatus: 'audited' },
    regions: [{
      page: 1, yMin: 100, yMax: 200, statement: 'income_statement', scope, section: 'main',
      label: [0, 100], expectedLabels: ['营业收入'], rowBands: [{ yMin: 150, yMax: 165 }],
      columns: [{ xMin: 100, xMax: 180, dimension: 'total', periodType: 'duration', startDate: currentPeriod.start_date,
        endDate: currentPeriod.end_date, unit: 'cny_million',
        numericFormat: { decimal: '.', grouping: ',', negative: 'minus', plus: false, percent: 'reject' } }],
      continuations: [{ rowIndex: 0, columnIndex: 0, page: 2, yMin: 150, yMax: 165, xMin: 100, xMax: 180, quote: '120.00' }],
    }],
  };
  return { ...l1Header, kind: 'pdf_regions', selection, regionHeaders: [{
    columns: [{ columnRole: 'current_period', declaredUnit: '人民币百万元' }],
    pages: titles.map((text, index) => ({ page: index + 1, titleRows: [{ text, yMin: 210, yMax: 220 }],
      columnRoles: ['current_period'] })),
  }] };
}

test('L1 PDF accepts same-scope continuations and rejects both directions of scope changes', () => {
  for (const [scope, firstTitle, otherTitle] of [
    ['consolidated', '合并利润表', '母公司利润表'],
    ['parent_only', 'Separate income statement', 'Consolidated income statement'],
  ] as const) {
    const valid = pdfTemplate(scope, [firstTitle, firstTitle + '（续）']);
    assert.deepEqual(validateFinancialL1Template(valid), valid);
    assert.throws(() => validateFinancialL1Template(pdfTemplate(scope, [firstTitle, otherTitle])),
      { code: 'FINANCIAL_L1_SCOPE_MISMATCH' });
  }
  const changedRole = pdfTemplate();
  changedRole.regionHeaders[0]!.pages[1]!.columnRoles = ['prior_period_restated'];
  assert.throws(() => validateFinancialL1Template(changedRole), { code: 'FINANCIAL_L1_SCOPE_MISMATCH' });
});

test('each PDF continuation requires explicit scope evidence, including another segment on the same page', () => {
  const code = { code: 'FINANCIAL_L1_SCOPE_MISMATCH' };
  assert.throws(() => validateFinancialL1Template(pdfTemplate('consolidated', ['合并利润表', '利润表（续）'])), code);
  const template = pdfTemplate();
  const pages = template.regionHeaders[0]!.pages;
  const parts = template.selection.regions[0]!.continuations!;
  const missingTitles = structuredClone(template);
  missingTitles.regionHeaders[0]!.pages[1]!.titleRows = [];
  assert.throws(() => validateFinancialL1Template(missingTitles), code);
  parts.push({ ...parts[0]!, page: 1, yMin: 100, yMax: 120 });
  assert.throws(() => validateFinancialL1Template(template), code);
  pages.push({ page: 1, titleRows: [{ text: '母公司利润表', yMin: 125, yMax: 140 }], columnRoles: ['current_period'] });
  assert.throws(() => validateFinancialL1Template(template), code);
  pages[2]!.titleRows[0]!.text = '合并利润表（续）';
  assert.deepEqual(validateFinancialL1Template(template), template);
});

function continuedPdf(continuationTitle: string, mainAmount = '12'): Buffer {
  return fixturePdf([
    `BT /F1 10 Tf 10 215 Td (Consolidated income statement) Tj ET\nBT /F1 10 Tf 10 156 Td (Revenue) Tj ET\nBT /F1 10 Tf 110 156 Td (${mainAmount}) Tj ET`,
    `BT /F1 10 Tf 10 215 Td (${continuationTitle}) Tj ET\nBT /F1 10 Tf 110 156 Td (.50%) Tj ET`,
  ]);
}

function fixturePdf(streams: string[]): Buffer {
  const pageRefs = streams.map((_, index) => `${4 + index * 2} 0 R`).join(' ');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pageRefs}] /Count ${streams.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [index, content] of streams.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let text = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = Buffer.byteLength(text);
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(text);
  return Buffer.from(`${text}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('PDF rejects scope titles below the crop and opposite titles before either same-page segment', async () => {
  const code = { code: 'FINANCIAL_L1_SCOPE_MISMATCH' };
  for (const [scope, title, opposite] of [
    ['consolidated', 'Consolidated income statement', 'Parent company income statement'],
    ['parent_only', 'Separate income statement', 'Consolidated income statement'],
  ] as const) {
    const bytes = fixturePdf([[
      `BT /F1 10 Tf 10 265 Td (${title}) Tj ET`,
      'BT /F1 10 Tf 10 235 Td (Revenue) Tj ET',
      'BT /F1 10 Tf 110 235 Td (12) Tj ET',
      `BT /F1 10 Tf 205 195 Td (${opposite}) Tj ET`,
      'BT /F1 10 Tf 10 156 Td (Revenue) Tj ET',
      'BT /F1 10 Tf 110 156 Td (99) Tj ET',
      `BT /F1 10 Tf 10 85 Td (${title}) Tj ET`,
    ].join('\n')]);
    const template = pdfTemplate(scope, [title]);
    template.selection.sourceSha256 = wfdSha256(bytes);
    const region = template.selection.regions[0]!;
    delete region.continuations;
    Object.assign(region, { yMax: 170, expectedLabels: ['Revenue'] });
    const pages = template.regionHeaders[0]!.pages;
    pages[0]!.titleRows[0] = { text: title, yMin: 260, yMax: 270 };
    const project = () => projectFinancialPdf(bytes, template, new AbortController().signal);
    await assert.rejects(project(), code);

    const below = structuredClone(template);
    below.regionHeaders[0]!.pages[0]!.titleRows[0] = { text: title, yMin: 80, yMax: 90 };
    assert.throws(() => validateFinancialL1Template(below), code);

    Object.assign(region, { yMin: 230, yMax: 240, rowBands: [{ yMin: 230, yMax: 240 }] });
    assert.equal(JSON.parse((await project()).jsonBytes.toString())[0].value, '12');
    region.continuations = [{ rowIndex: 0, columnIndex: 0, page: 1, yMin: 150, yMax: 165, xMin: 100, xMax: 180, quote: '99' }];
    pages.push(structuredClone(pages[0]!));
    await assert.rejects(project(), code);
  }
});

test('PDF rejects an opposite-scope title wrapped across two lines before the selected rows', async () => {
  const title = 'Consolidated income statement';
  const bytes = fixturePdf([[
    `BT /F1 10 Tf 10 215 Td (${title}) Tj ET`,
    'BT /F1 10 Tf 10 195 Td (Parent company financial) Tj ET',
    'BT /F1 10 Tf 10 180 Td (statements) Tj ET',
    'BT /F1 10 Tf 10 156 Td (Revenue) Tj ET',
    'BT /F1 10 Tf 110 156 Td (99) Tj ET',
  ].join('\n')]);
  const template = pdfTemplate('consolidated', [title]);
  template.selection.sourceSha256 = wfdSha256(bytes);
  const region = template.selection.regions[0]!;
  delete region.continuations;
  Object.assign(region, { yMax: 170, expectedLabels: ['Revenue'] });
  await assert.rejects(projectFinancialPdf(bytes, template, new AbortController().signal),
    { code: 'FINANCIAL_L1_SCOPE_MISMATCH' });
});

test('PDF L1 preserves the reported decimal scale and original lexeme in a ratio column', async () => {
  const template = pdfTemplate('consolidated', ['Consolidated income statement']);
  const region = template.selection.regions[0]!;
  region.expectedLabels = ['Revenue'];
  delete region.continuations;
  region.columns[0]!.unit = 'ratio';
  for (const [amount, state] of [['12.0', 'valid_value'], ['0.00', 'reported_zero']] as const) {
    const bytes = continuedPdf('Consolidated income statement continued', amount);
    template.selection.sourceSha256 = wfdSha256(bytes);
    const result = await projectFinancialPdf(bytes, template.selection, new AbortController().signal);
    const [row] = JSON.parse(result.jsonBytes.toString());
    assert.equal(row.value, amount);
    assert.equal(row.value_state, state);
    assert.equal(result.evidence.records[0]!.originalLexeme, amount);
  }
});

test('PDF projection checks each continuation title and preserves the reported percentage', async () => {
  const title = 'Consolidated income statement';
  const template = pdfTemplate('consolidated', [title, title + ' continued']);
  const { selection, regionHeaders } = template;
  const bytes = continuedPdf(title + ' continued');
  selection.sourceSha256 = wfdSha256(bytes);
  const region = selection.regions[0]!;
  region.expectedLabels = ['Revenue'];
  region.continuations![0]!.quote = '.50%';
  const column = region.columns[0]!;
  column.unit = 'percent';
  column.numericFormat.percent = 'as_reported';
  regionHeaders[0]!.columns[0]!.declaredUnit = '%';
  const scoped = { ...selection, scope: 'consolidated', regionHeaders } as const;
  const project = async (input: Parameters<typeof projectFinancialPdf>[1], pdf = bytes) => {
    const projected = await projectFinancialPdf(pdf, input, new AbortController().signal);
    return { ...projected, row: (JSON.parse(projected.jsonBytes.toString()) as WfdRecord[])[0]! };
  };
  for (const input of [template, scoped]) {
    const result = await project(readFinancialPdfProjection(input));
    assert.equal(result.row.value, '12.50%');
    assert.equal(result.row.unit, 'percent');
    assert.equal(result.evidence.records[0]!.originalLexeme, '12.50%');
    assert.deepEqual(result.evidence.regionHeaders, regionHeaders);
  }
  const switched = continuedPdf('Separate income statement');
  await assert.rejects(project(readFinancialPdfProjection({ ...scoped, sourceSha256: wfdSha256(switched) }), switched),
    { code: 'FINANCIAL_L1_SCOPE_MISMATCH' });
  assert.throws(() => readFinancialPdfProjection({ ...selection, scope: 'consolidated' }), { code: 'FINANCIAL_L1_SCOPE_MISMATCH' });
  await assert.rejects(project(selection), { code: 'FINANCIAL_L1_SCOPE_MISMATCH' });
  const changedQuote = structuredClone(template);
  changedQuote.selection.regions[0]!.continuations![0]!.quote = '.53%';
  await assert.rejects(project(changedQuote), /原文与核定片段不符/u);

  const single = structuredClone(selection);
  delete single.regions[0]!.continuations;
  const singleBytes = continuedPdf(title + ' continued', '12.50%');
  single.sourceSha256 = wfdSha256(singleBytes);
  assert.equal((await project(single, singleBytes)).row.value, '12.50%');
  single.regions[0]!.columns[0]!.numericFormat.percent = 'fraction';
  await assert.rejects(project(single, singleBytes), { code: 'FINANCIAL_L1_TEMPLATE' });
  column.numericFormat.percent = 'fraction';
  for (const input of [template, scoped]) assert.throws(() => readFinancialPdfProjection(input), { code: 'FINANCIAL_L1_TEMPLATE' });
});

test('L1 XLSX preserves units on declared numeric columns', () => {
  const rectangle = {
    selection: { sheetName: '利润表', headerRow: 1, firstDataRow: 2, lastDataRow: 3, firstColumn: 'A', lastColumn: 'B',
      columns: [{ column: 'A', header: '科目', name: 'concept', type: 'string' },
        { column: 'B', header: '本期金额', name: 'amount', type: 'decimal_string' }] },
    declaredUnits: { amount: '人民币百万元' },
  };
  const template = { ...l1Header, kind: 'xlsx_rectangles', rectangles: [rectangle] };
  assert.deepEqual(validateFinancialL1Template(template), template);
  assert.throws(() => validateFinancialL1Template({ ...template, rectangles: [{ ...rectangle, declaredUnits: { concept: '文本' } }] }),
    { code: 'FINANCIAL_L1_TEMPLATE' });
});

test('L1 XBRL binds unique explicit and typed axes', () => {
  const template = { ...l1Header, kind: 'xbrl_dimensions',
    selection: { version: XBRL_ADAPTER_VERSION, reportId, reportVersion, concepts: ['{urn:fixture}Revenue'] },
    axisBindings: [
      { kind: 'explicit', sourceAxis: '{urn:fixture}SegmentAxis', l2Axis: 'operating_segment' },
      { kind: 'typed', sourceAxis: '{urn:fixture}FacilityAxis', l2Axis: 'facility', typedDomain: '{urn:fixture}FacilityId' },
    ],
  };
  assert.deepEqual(validateFinancialL1Template(template), template);
  const [segment, facility] = template.axisBindings;
  assert.throws(() => validateFinancialL1Template({ ...template, axisBindings: [segment, { ...facility, l2Axis: segment?.l2Axis }] }),
    { code: 'FINANCIAL_L1_TEMPLATE' });
});

test('L1 refuses inline unit multiplication and percentage conversion', () => {
  assert.throws(() => validateFinancialL1Template({ ...pdfTemplate(), scaleFactor: '1000000' }),
    { code: 'FINANCIAL_L1_TEMPLATE' });
  const percent = pdfTemplate();
  const column = percent.selection.regions[0]!.columns[0]!;
  column.unit = 'percent';
  column.numericFormat.percent = 'fraction';
  percent.regionHeaders[0]!.columns[0]!.declaredUnit = '%';
  assert.throws(() => validateFinancialL1Template(percent), { code: 'FINANCIAL_L1_TEMPLATE' });
  column.numericFormat.percent = 'as_reported';
  assert.deepEqual(validateFinancialL1Template(percent), percent);
});

const releaseTime = '2025-08-20T01:00:00Z';
const beforeRelease = '2025-08-20T00:59:59Z';
const currentFact: ComparativeFinancialFact = {
  ...currentPeriod, subject_scheme: 'fixture', subject_code: entityId, accounting_standard: 'CAS', currency: 'CNY',
  statement: 'income_statement', scope: 'consolidated', section: 'main', concept: 'revenue', dimension: 'total',
  period_type: 'duration', unit: 'cny', fiscal_calendar: 'calendar-year', report_id: reportId, report_version: reportVersion,
  report_nature: 'formal', audit_status: 'audited', column_role: 'current_period', comparability_basis: 'fixture-policy',
  public_time: '2025-08-01T01:00:00Z',
};
const originalPrior: ComparativeFinancialFact = {
  ...currentFact, ...priorPeriod, report_id: 'fixture-prior-report', public_time: '2024-08-01T01:00:00Z',
};
const restatedPrior: ComparativeFinancialFact = {
  ...originalPrior, report_id: 'fixture-restatement-carrier', public_time: releaseTime,
  report_nature: 'restatement_carrier', column_role: 'prior_period_restated',
};
const pair = (rows: readonly ComparativeFinancialFact[], market_known_at = releaseTime) =>
  pairComparativeFinancialPeriods({ rows, periods: [currentPeriod, priorPeriod], market_known_at });

test('as-of pairing reveals a comparable restatement only at its carrier publication', () => {
  const incompatible = { ...restatedPrior, report_id: 'different-basis-carrier',
    comparability_basis: 'different-policy', public_time: '2025-08-21T01:00:00Z' };
  const rows = [restatedPrior, originalPrior, incompatible, currentFact];
  assert.deepEqual(pair(rows, beforeRelease), {
    status: 'paired', current: currentFact, comparisons: [originalPrior], comparability_basis: currentFact.comparability_basis,
  });
  for (const cutoff of [releaseTime, incompatible.public_time]) {
    assert.deepEqual(pair(rows, cutoff), {
      status: 'paired', current: currentFact, comparisons: [restatedPrior], comparability_basis: currentFact.comparability_basis,
    });
  }
  assert.deepEqual(pair([restatedPrior, currentFact], beforeRelease), {
    status: 'indeterminate', reason: 'compatible_comparative_missing', period: priorPeriod,
  });
});

test('comparative pairing refuses unknown publication times and mixed currencies', () => {
  assert.deepEqual(pair([currentFact, originalPrior, { ...restatedPrior, public_time: null }]), {
    status: 'indeterminate', reason: 'public_time_unresolved',
  });
  assert.deepEqual(pair([currentFact, { ...originalPrior, currency: 'USD', unit: 'usd' }]), {
    status: 'indeterminate', reason: 'incompatible_series',
  });
});

test('future observations of the same report version cannot invalidate a visible pairing', () => {
  const later = { ...restatedPrior, report_id: currentFact.report_id, report_version: currentFact.report_version };
  const otherPeriod = { ...later, start_date: '2022-01-01', end_date: '2022-06-30' };
  const rows = [later, currentFact, originalPrior, otherPeriod];
  assert.deepEqual(pair(rows, beforeRelease), {
    status: 'paired', current: currentFact, comparisons: [originalPrior], comparability_basis: currentFact.comparability_basis,
  });
  assert.deepEqual(pair(rows, releaseTime), { status: 'indeterminate', reason: 'public_time_unresolved' });
  for (const public_time of [null, '2025-08-20']) {
    assert.deepEqual(pair([currentFact, originalPrior, { ...otherPeriod, public_time }], beforeRelease), {
      status: 'indeterminate', reason: 'public_time_unresolved',
    });
  }
});

const forecast = { report_nature: 'forecast', lower_bound: '-12.50', upper_bound: '-10.0' } as const;
const forecastRow = { ...currentFact, ...forecast, concept: '其中：营业收入', value: '-12.50' };

test('forecast ranges route to management claims and reject reversed bounds', () => {
  assert.deepEqual(classifyAndValidateReportNature(forecast), { ...forecast, domain: 'management_claim_or_event' });
  assert.throws(() => classifyAndValidateReportNature({ ...forecast, lower_bound: '-9.9' }), { code: 'FINANCIAL_REPORT_NATURE' });
  assert.throws(() => classifyAndValidateReportNature({ ...forecast, target: 'actual_financial_statements' }),
    { code: 'FINANCIAL_FORECAST_NOT_ACTUAL' });
});

const disguisedForecasts = [
  { lower_bound: '-12.50', upper_bound: '-10.0' },
  { forecast_lower_bound: '-12.50' },
  { forecast_upper_bound: '0' },
  { upper_bound: null },
];
test('L2 financial fact identity refuses forecast labels and any forecast bound field', () => {
  const declaration = { version: FINANCIAL_FACT_VERSION, seriesId: 'fixture-series', periodBasis: 'calendar-year',
    basis: 'fixture-policy', assertion: 'same_fact_across_report_editions' };
  const actual = financialFactIdentity({ ...currentFact }, declaration);
  assert.ok(actual.businessKey);
  assert.throws(() => financialFactIdentity(forecastRow, declaration), { code: 'FINANCIAL_FORECAST_NOT_ACTUAL' });
  for (const bounds of disguisedForecasts) {
    assert.throws(() => financialFactIdentity({ ...currentFact, ...bounds }, declaration), { code: 'FINANCIAL_FORECAST_NOT_ACTUAL' });
  }
  for (const report_nature of ['unknown', 'bogus', null]) {
    assert.throws(() => financialFactIdentity({ ...currentFact, report_nature }, declaration), { code: 'FINANCIAL_REPORT_NATURE' });
  }
  const cells = Object.fromEntries(Object.entries({ ...currentFact, financial_fact_identity: actual.identity })
    .map(([key, value]) => [key, { value, value_state: 'valid_value' }]));
  assert.throws(() => verifyFinancialFactRow({ business_key: actual.businessKey,
    values: { ...cells, lower_bound: { value: null, value_state: 'not_reported' } } }), { code: 'FINANCIAL_FORECAST_NOT_ACTUAL' });
});

test('L3 financial standardization refuses forecast labels and bounds before mapping', async () => {
  await assert.rejects(projectFixture(forecastRow), { code: 'FINANCIAL_FORECAST_NOT_ACTUAL' });
  const actual = { ...currentFact, concept: '其中：营业收入', value: '-12.50' };
  for (const bounds of disguisedForecasts) {
    await assert.rejects(projectFixture({ ...actual, ...bounds }), { code: 'FINANCIAL_FORECAST_NOT_ACTUAL' });
  }
  await assert.rejects(projectFixture(actual, {}, { dimension: 'money' }, { upper_bound: '0' }),
    { code: 'FINANCIAL_FORECAST_NOT_ACTUAL' });
  for (const report_nature of ['unknown', 'bogus', null]) {
    await assert.rejects(projectFixture({ ...actual, report_nature }), { code: 'FINANCIAL_REPORT_NATURE' });
  }
});

test('preliminary reports pair with preliminary facts and remain separate from formal reports', () => {
  assert.deepEqual(classifyAndValidateReportNature({ report_nature: 'preliminary', audit_status: 'unaudited' }), {
    report_nature: 'preliminary', audit_status: 'preliminary_unaudited', domain: 'actual_financial_statements',
  });
  assert.throws(() => classifyAndValidateReportNature({ report_nature: 'preliminary', audit_status: 'audited' }),
    { code: 'FINANCIAL_REPORT_NATURE' });
  assert.throws(() => classifyAndValidateReportNature({ report_nature: 'formal', audit_status: 'preliminary_unaudited' }),
    { code: 'FINANCIAL_REPORT_NATURE' });
  const preliminary = { ...currentFact, report_id: 'fixture-preliminary', report_nature: 'preliminary',
    audit_status: 'unaudited', public_time: '2025-07-20T01:00:00Z' } as const;
  const preliminaryPrior = { ...preliminary, ...priorPeriod, column_role: 'prior_period_comparative_unchanged' } as const;
  assert.deepEqual(pair([preliminary, preliminaryPrior], preliminary.public_time), {
    status: 'paired', current: preliminary, comparisons: [preliminaryPrior], comparability_basis: preliminary.comparability_basis,
  });
  assert.deepEqual(pair([preliminary, preliminaryPrior, currentFact]), {
    status: 'indeterminate', reason: 'compatible_comparative_missing', period: priorPeriod,
  });
  assert.deepEqual(pair([preliminary, preliminaryPrior, originalPrior, currentFact]), {
    status: 'paired', current: currentFact, comparisons: [originalPrior], comparability_basis: currentFact.comparability_basis,
  });
});

const regions: GeoRegionMaster[] = [
  { regionId: 'fixture-bloc', namespace: 'fixture', code: 'bloc', name: '合成聚合地区', aliases: ['海外'], kind: 'regional_bloc',
    memberRegionIds: ['fixture-plant-region', 'fixture-port-region'], statisticalScheme: 'fixture' },
  { regionId: 'fixture-plant-region', namespace: 'fixture', code: 'plant', name: '合成生产地区', kind: 'country_or_region', statisticalScheme: 'fixture' },
  { regionId: 'fixture-port-region', namespace: 'fixture', code: 'port', name: '合成物流地区', kind: 'country_or_region', statisticalScheme: 'fixture' },
];
const noteSource = (businessKey: string) => ({ statement: 'note', entityId, sourceEvidenceKind: 'enterprise_financial_note',
  sourceFact: { businessKey, reportId, reportVersion } } as const);
const segmentRegion = { ...noteSource('operating-region'), section: 'note.operating_segments', disclosedRegionLabel: '海外',
  dimension: { segment_axis: 'by_region', mapped_node_id: 'fixture-bloc' } } as const;
const supplier = { ...noteSource('supplier'), section: 'note.top5_suppliers', disclosedRegionLabel: '合成物流地区',
  dimension: { rank: '1', counterparty_id: 'fixture-supplier', region_code: 'fixture-port-region' } } as const;

test('financial notes derive C07-B2 relations and C07-B3 exposures with pinned lineage', () => {
  const facts: FinancialNoteFact[] = [
    segmentRegion,
    { ...noteSource('operating-product'), section: 'note.operating_segments',
      dimension: { segment_axis: 'by_product', mapped_node_id: 'fixture-product-a' } },
    { ...noteSource('plant'), section: 'note.facilities_and_assets', disclosedRegionLabel: '合成生产地区',
      dimension: { facility_id: 'fixture-plant', region_code: 'fixture-plant-region', role: 'production', location_role: 'produces_in' } },
    { ...noteSource('warehouse'), section: 'note.facilities_and_assets', disclosedRegionLabel: '合成物流地区',
      dimension: { facility_id: 'fixture-warehouse', region_code: 'fixture-port-region', role: 'logistics', location_role: 'facility_operation' } },
    { ...noteSource('customer'), section: 'note.top5_customers', disclosedRegionLabel: '海外',
      dimension: { rank: '2', counterparty_id: 'fixture-customer', region_code: 'fixture-bloc' } },
    supplier,
    { ...noteSource('inventory'), section: 'note.production_sales_inventory', dimension: { product_id: 'fixture-product-b' } },
  ];
  const result = deriveFinancialNoteLinkages({ facts, regions });
  assert.deepEqual(result.relations.map(edge => [edge.relationType, edge.subjectId, edge.objectId, edge.lineage.businessKey]), [
    ['produces_product', entityId, 'fixture-product-a', 'operating-product'],
    ['operated_by', 'fixture-plant', entityId, 'plant'],
    ['located_in', 'fixture-plant', 'fixture-plant-region', 'plant'],
    ['operated_by', 'fixture-warehouse', entityId, 'warehouse'],
    ['located_in', 'fixture-warehouse', 'fixture-port-region', 'warehouse'],
    ['supplies_to', entityId, 'fixture-customer', 'customer'],
    ['purchases_from', entityId, 'fixture-supplier', 'supplier'],
    ['produces_product', entityId, 'fixture-product-b', 'inventory'],
  ]);
  assert.deepEqual(result.exposures.map(exposure => [exposure.entityId, exposure.exposureKind, exposure.regionId, exposure.lineage.businessKey]), [
    [entityId, 'revenue', 'fixture-bloc', 'operating-region'],
    [entityId, 'production', 'fixture-plant-region', 'plant'],
    [entityId, 'logistics', 'fixture-port-region', 'warehouse'],
    [entityId, 'revenue', 'fixture-bloc', 'customer'],
    [entityId, 'procurement', 'fixture-port-region', 'supplier'],
  ]);
  for (const { lineage } of [...result.relations, ...result.exposures]) {
    const source = facts.find(fact => fact.sourceFact.businessKey === lineage.businessKey);
    assert.ok(source);
    assert.deepEqual(lineage, { ...source.sourceFact, section: source.section, sourceEvidenceKind: source.sourceEvidenceKind,
      ...(source.disclosedRegionLabel ? { disclosedRegionLabel: source.disclosedRegionLabel } : {}) });
  }
});

test('financial notes forbid allocating aggregate regions by national macro trade shares', () => {
  assert.throws(() => deriveFinancialNoteLinkages({ facts: [segmentRegion], regions,
    macroShareAllocation: { 'fixture-plant-region': '0.6', 'fixture-port-region': '0.4' } }),
    { code: 'MACRO_SHARE_ALLOCATION_FORBIDDEN' });
  const prorated = { ...segmentRegion, macroTradeShareUsedForProration: true };
  assert.throws(() => deriveFinancialNoteLinkages({ facts: [prorated], regions }),
    { code: 'MACRO_SHARE_ALLOCATION_FORBIDDEN' });
});

test('country bilateral trade and UN Comtrade cannot establish an enterprise supplier edge', () => {
  for (const evidence of [{ sourceId: 'UN Comtrade' }, { evidenceKind: 'macro_bilateral_trade' }]) {
    const fact = { ...supplier, sourceFact: { ...supplier.sourceFact, ...evidence } };
    assert.throws(() => deriveFinancialNoteLinkages({ facts: [fact], regions }), { code: 'FINANCIAL_NOTE_MACRO_EVIDENCE' });
  }
});

test('note facts must explicitly identify enterprise evidence and pin its report and source fact', () => {
  const omitted = structuredClone(supplier);
  Reflect.deleteProperty(omitted, 'sourceEvidenceKind');
  for (const fact of [omitted, { ...supplier, sourceEvidenceKind: 'trade_observation' } as unknown as FinancialNoteFact]) {
    assert.throws(() => deriveFinancialNoteLinkages({ facts: [fact], regions }), { code: 'FINANCIAL_NOTE_LINKAGE' });
  }
  for (const key of ['businessKey', 'reportId', 'reportVersion'] as const) {
    const fact = { ...supplier, sourceFact: { ...supplier.sourceFact, [key]: ' ' } };
    assert.throws(() => deriveFinancialNoteLinkages({ facts: [fact], regions }), { code: 'FINANCIAL_NOTE_LINKAGE' });
  }
});

test('an aggregate disclosure label cannot be relabeled as a country or a smaller region', () => {
  const province = { ...regions[1]!, regionId: 'fixture-province', kind: 'state_or_province', parentRegionId: 'fixture-plant-region' } as const;
  for (const disclosedRegionLabel of ['海外', '境外', '国外', '亚太', '欧美', '其他地区', ' Overseas ', 'abroad', 'ＡＰＡＣ', 'EMEA', 'international']) {
    for (const mapped_node_id of ['fixture-plant-region', province.regionId]) {
      const fact = { ...segmentRegion, disclosedRegionLabel, dimension: { ...segmentRegion.dimension, mapped_node_id } };
      assert.throws(() => deriveFinancialNoteLinkages({ facts: [fact], regions: [...regions, province] }),
        { code: 'MACRO_SHARE_ALLOCATION_FORBIDDEN' });
    }
  }
  assert.throws(() => deriveFinancialNoteLinkages({ facts: [{ ...supplier, disclosedRegionLabel: undefined }], regions }),
    { code: 'FINANCIAL_NOTE_LINKAGE' });
});

test('Europe cannot be mapped to its registered member France', () => {
  const europe: GeoRegionMaster = { regionId: 'fixture-europe', namespace: 'fixture', code: 'eu', name: '欧洲',
    kind: 'continent', statisticalScheme: 'fixture' };
  const france: GeoRegionMaster = { regionId: 'fixture-france', namespace: 'fixture', code: 'fr', name: '法国',
    aliases: ['France'], kind: 'country', parentRegionId: europe.regionId, statisticalScheme: 'fixture' };
  const mappedFrance = { ...segmentRegion, dimension: { ...segmentRegion.dimension, mapped_node_id: france.regionId } };
  for (const disclosure of [
    { disclosedRegionLabel: '欧洲' },
    { disclosedRegionLabel: '法国', disclosedRegionId: europe.regionId },
    { disclosedRegionLabel: 'France market' },
  ]) {
    assert.throws(() => deriveFinancialNoteLinkages({ facts: [{ ...mappedFrance, ...disclosure }], regions: [europe, france] }),
      { code: 'MACRO_SHARE_ALLOCATION_FORBIDDEN' });
  }
  assert.throws(() => deriveFinancialNoteLinkages({
    facts: [{ ...mappedFrance, disclosedRegionLabel: '欧洲' }], regions: [europe, { ...france, aliases: ['欧洲'] }],
  }), { code: 'MACRO_SHARE_ALLOCATION_FORBIDDEN' });
  const exact = { ...mappedFrance, disclosedRegionLabel: 'France', disclosedRegionId: france.regionId };
  assert.equal(deriveFinancialNoteLinkages({ facts: [exact], regions: [europe, france] }).exposures[0]?.regionId, france.regionId);
});

test('anonymous disclosed customers and unknown regions keep the disclosed evidence', () => {
  const customer = { ...noteSource('anonymous-customer'), section: 'note.top5_customers',
    dimension: { rank: '1', counterparty_identity: 'anonymous_disclosed', counterparty_name: '客户甲', region_code: null } } as const;
  const total = { ...noteSource('top5-total'), section: customer.section, dimension: { rank: 'total_top5' } } as const;
  const result = deriveFinancialNoteLinkages({ facts: [customer, total], regions });
  const lineage = { ...customer.sourceFact, section: customer.section, sourceEvidenceKind: customer.sourceEvidenceKind };
  assert.deepEqual(result.relations, [{
    relationType: 'supplies_to', subjectId: entityId, objectId: null, lineage, counterpartyIdentity: 'anonymous_disclosed',
    counterpartyName: '客户甲', disclosureRank: '1', regionId: 'unknown',
  }]);
  assert.deepEqual(result.exposures, [{ entityId, exposureKind: 'revenue', regionId: 'unknown', lineage }]);
  const invented = { ...customer, dimension: { ...customer.dimension, counterparty_id: 'invented-company' } };
  assert.throws(() => deriveFinancialNoteLinkages({ facts: [invented], regions }), { code: 'FINANCIAL_NOTE_LINKAGE' });
});

test('registered and headquarters regions are excluded from facility operating locations', () => {
  const facility = { ...noteSource('facility'), section: 'note.facilities_and_assets', disclosedRegionLabel: '合成生产地区',
    dimension: { facility_id: 'fixture-plant', region_code: 'fixture-plant-region', role: 'production', location_role: 'produces_in' } } as const;
  for (const location_role of ['registered_in', 'headquartered_in'] as const) {
    const nonOperating = { ...facility, dimension: { ...facility.dimension, region_code: 'fixture-port-region', location_role } };
    const result = deriveFinancialNoteLinkages({ facts: [facility, nonOperating], regions });
    assert.deepEqual(result.relations.filter(edge => edge.relationType === 'located_in').map(edge => edge.objectId),
      ['fixture-plant-region']);
    assert.deepEqual(result.exposures.map(exposure => [exposure.exposureKind, exposure.regionId]),
      [['production', 'fixture-plant-region'], ['production', 'unknown']]);
  }
});
