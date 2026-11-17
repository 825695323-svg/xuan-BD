import assert from 'node:assert/strict';
import test from 'node:test';
import { algorithmReferenceEvidence, apiReferenceEvidence, captureReferenceEvidence, referenceEvidence } from './object-reference-evidence.js';
import { objectReferenceText } from './object-reference.js';
import { currentWorkspaceObject, setWorkspaceObject } from './ui/workspace-context.js';
const now = Date.parse('2026-01-01T00:01:00Z');
const settings = { revision: 8, checks: [{ id: 'conn-a', checkedAt: '2026-01-01T00:00:00Z', validUntil: '2026-01-01T00:05:00Z', configurationRevision: 8,
  status: 'passed', reason: 'SECRET reason https://private.invalid', configurationDigest: 'SECRET_DIGEST' }],
  connections: [{ id: 'conn-a', pluginId: 'plugin-a', baseUrl: 'https://private.invalid', credential: { token: 'SECRET_TOKEN' } }],
  apiPlugins: [{ id: 'plugin-a', version: 'plugin/2', operations: [{ id: 'daily_bars', parameters: { SECRET_PARAMETERS: true } }] }],
  capture: [{ sourceId: 'capture-a', operation: 'read-page', parameters: { SECRET_PARAMETERS: true }, watchTargets: ['https://private.invalid'] }] } as any;
const parse = (value: ReturnType<typeof apiReferenceEvidence>, at = now) => JSON.parse(objectReferenceText({ page: 'api-sources', kind: 'supplier', id: 'conn-a', label: 'A', market: { id: 'cnMainland', label: 'China' }, evidence: value }, at).slice(8, -4));

test('business reference separates document/plugin revisions, UI market and registered scope without private payloads', () => {
  const evidence = apiReferenceEvidence(settings, 'conn-a', 'cnMainland', 'cn-equity');
  const result = parse(evidence), text = JSON.stringify(result);
  assert.equal(result.schema, 'bd.ui-object-reference/2');
  assert.equal(result.versionRefs.find((v: any) => v.kind === 'source_settings_document').version, 8);
  assert.equal(result.versionRefs.find((v: any) => v.kind === 'api_plugin').version, 'plugin/2');
  assert.equal(result.businessScope.marketId, 'cnMainland'); assert.equal(result.businessScope.scopeId, 'cn-equity');
  assert.equal(result.businessScope.actualCoverage, 'unknown'); assert.deepEqual(result.businessScope.registeredOperations, ['daily_bars']);
  assert.equal(result.diagnosticRefs.latestCheck.kind, 'latest_source_check_observation');
  assert.equal(result.diagnosticRefs.latestCheck.validity, 'current_observation');
  assert.equal(result.diagnosticRefs.latestCheck.historicalDiagnosticId, null);
  assert.equal(result.diagnosticRefs.latestCheck.executionEligibility, 'not_asserted');
  assert.equal(result.diagnosticRefs.stableException.state, 'unknown');
  assert.doesNotMatch(text, /SECRET|https:|reason|credential|watchTargets/u);
});

test('latest check never becomes a historical diagnostic and expiry/configuration change invalidates frozen preview text', () => {
  const evidence = apiReferenceEvidence(settings, 'conn-a', 'cnMainland', 'cn-equity');
  const frozen = parse(evidence);
  const expired = parse(evidence, Date.parse('2026-01-01T00:05:00Z'));
  assert.equal(expired.diagnosticRefs.latestCheck.validity, 'expired'); assert.notDeepEqual(expired, frozen);
  const changed = parse(apiReferenceEvidence({ ...settings, revision: 9 }, 'conn-a', 'cnMainland', 'cn-equity'));
  assert.equal(changed.diagnosticRefs.latestCheck.validity, 'configuration_mismatch');
  assert.equal(changed.diagnosticRefs.latestCheck.executionEligibility, 'not_asserted');
  const missing = parse(apiReferenceEvidence({ ...settings, checks: [] }, 'conn-a', 'cnMainland', 'cn-equity'));
  assert.deepEqual(missing.diagnosticRefs.latestCheck, { state: 'unknown' });
  const object = { page: 'api-sources', kind: 'supplier' as const, id: 'conn-a', label: 'A', market: { id: 'cnMainland', label: 'China' }, evidence };
  setWorkspaceObject(object); const revision = currentWorkspaceObject().revision;
  setWorkspaceObject({ ...object, evidence: apiReferenceEvidence({ ...settings, revision: 9 }, 'conn-a', 'cnMainland', 'cn-equity') });
  assert.ok(currentWorkspaceObject().revision > revision); setWorkspaceObject(null);
});

test('capture refers only registered operations and selected configuration operation, not static topics or inferred coverage', () => {
  const value = referenceEvidence(captureReferenceEvidence('capture-a', [{ operation: 'read-page' }], settings), now);
  assert.equal(value.businessScope.configuredOperation, 'read-page'); assert.equal(value.businessScope.actualCoverage, 'unknown');
  assert.equal(value.versionRefs.find(v => v.kind === 'capture_registry')?.state, 'unknown');
  assert.doesNotMatch(JSON.stringify(value), /SECRET|https:|topics|regions/u);
  const absent = referenceEvidence(captureReferenceEvidence('custom-a', undefined, null), now);
  assert.equal(absent.businessScope.configuredOperation, null); assert.equal(absent.versionRefs[0].state, 'unknown');
});

test('algorithm definition, registry and implementation versions are not interchangeable and no configuration is auto-selected', () => {
  const tool = { id: 'macd', status: 'blocked', reason: 'SECRET_REASON', definition: { id: 'algo.macd', registryId: 'macd',
    semantics: [{ key: 'methodVersion', state: 'fixed', value: 'math/1' }],
    implementations: [{ id: 'impl-a', location: '/SECRET_PATH', note: 'SECRET_NOTE' }],
    configurations: [{ id: 'first-config', parameters: 'SECRET_PARAMETERS' }] } } as any;
  const view = { registry: { version: 'registry/1' }, definitions: { version: 'definitions/2' } } as any;
  const value = referenceEvidence(algorithmReferenceEvidence(view, tool));
  assert.equal(value.versionRefs.find(v => v.kind === 'mathematical_method')?.version, 'math/1');
  assert.equal(value.versionRefs.find(v => v.kind === 'algorithm_implementation')?.version, null);
  assert.equal(value.versionRefs.find(v => v.kind === 'algorithm_implementation')?.state, 'unknown');
  assert.equal(value.businessScope.selectedConfigurationId, null); assert.equal(value.diagnosticRefs.catalogStatus, 'blocked');
  assert.doesNotMatch(JSON.stringify(value), /SECRET|first-config/u);
  const missing = referenceEvidence(algorithmReferenceEvidence({} as any, { id: 'old', status: 'ready' } as any));
  assert.ok(missing.versionRefs.every(v => v.state === 'unknown'));
});

test('invalid or timezone-free observation times, reversed intervals and invalid status never gain current eligibility', () => {
  const original = apiReferenceEvidence(settings, 'conn-a', 'cnMainland', 'cn-equity');
  for (const patch of [
    { checkedAt: '2026-01-01T00:00:00' }, { checkedAt: '2026-02-30T00:00:00Z' },
    { checkedAt: '2026-01-01T00:00:00+00:00' }, { validUntil: '2026-01-01T24:00:00Z' },
    { validUntil: '2025-12-31T23:59:59Z' }, { status: 'unknown-status' },
  ]) {
    const value = structuredClone(original); Object.assign(value.diagnosticRefs.latestCheck!, patch);
    assert.equal(referenceEvidence(value, now).diagnosticRefs.latestCheck.validity, 'unknown');
  }
});
