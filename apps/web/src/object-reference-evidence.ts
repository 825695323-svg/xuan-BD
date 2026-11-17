import type { SourceCheck, SourceSettingsView } from '../../../contracts/source-settings';
import type { ToolLibraryTool, ToolLibraryView } from '../../../contracts/tool-library';

export type ReferenceVersionKind = 'source_settings_document' | 'api_plugin' | 'capture_registry' | 'algorithm_registry'
  | 'algorithm_definition_collection' | 'mathematical_method' | 'algorithm_implementation' | 'selected_algorithm_configuration';
export interface ReferenceVersion { kind: ReferenceVersionKind; objectId: string | null; version: string | number | null }
export interface ReferenceCheck { objectId: string; checkedAt: string; configurationRevision: number; validUntil?: string; status: SourceCheck['status'] }
export interface ObjectReferenceEvidence {
  versionRefs: ReferenceVersion[];
  diagnosticRefs: { latestCheck: ReferenceCheck | null; currentConfigurationRevision: number | null; stableExceptionId: null;
    catalogStatus?: 'ready' | 'blocked' | 'unavailable' };
  businessScope: { kind: 'api_market' | 'registered_capture' | 'algorithm_definition'; marketId?: string; scopeId?: string | null;
    definitionId?: string | null; selectedConfigurationId?: null; configuredOperation?: string | null; registeredOperations?: string[] };
}
const version = (kind: ReferenceVersionKind, objectId: string | null, value: unknown): ReferenceVersion => ({ kind, objectId,
  version: typeof value === 'string' && value.length > 0 && value.length <= 512 || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value as string | number : null });
function diagnostics(objectId: string, view: SourceSettingsView | null): ObjectReferenceEvidence['diagnosticRefs'] {
  const check = view?.checks.find(item => item.id === objectId);
  return { latestCheck: check ? { objectId: check.id, checkedAt: check.checkedAt, configurationRevision: check.configurationRevision,
    validUntil: check.validUntil, status: check.status } : null, currentConfigurationRevision: view?.revision ?? null, stableExceptionId: null };
}
export function apiReferenceEvidence(view: SourceSettingsView, connectionId: string | null, marketId: string, scopeId: string | null): ObjectReferenceEvidence {
  const connection = view.connections.find(item => item.id === connectionId), plugin = view.apiPlugins.find(item => item.id === connection?.pluginId);
  return { versionRefs: [version('source_settings_document', 'source-settings', view.revision), version('api_plugin', plugin?.id ?? null, plugin?.version)],
    diagnosticRefs: diagnostics(connectionId ?? '', view),
    businessScope: { kind: 'api_market', marketId, scopeId, registeredOperations: plugin?.operations.map(item => item.id) ?? [] } };
}
export function captureReferenceEvidence(sourceId: string, operations: readonly { operation: string }[] | undefined, view: SourceSettingsView | null): ObjectReferenceEvidence {
  const setting = view?.capture.find(item => item.sourceId === sourceId);
  return { versionRefs: [version('source_settings_document', 'source-settings', view?.revision), version('capture_registry', sourceId, null)],
    diagnosticRefs: diagnostics(sourceId, view), businessScope: { kind: 'registered_capture', configuredOperation: setting?.operation ?? null,
      registeredOperations: operations?.map(item => item.operation) ?? [] } };
}
export function algorithmReferenceEvidence(view: ToolLibraryView, tool: ToolLibraryTool): ObjectReferenceEvidence {
  const definition = tool.definition?.registryId === tool.id ? tool.definition : undefined;
  const methods = Array.isArray(definition?.semantics) ? definition.semantics.filter(item => item?.key === 'methodVersion' && item.state === 'fixed') : [];
  const implementations = Array.isArray(definition?.implementations) ? definition.implementations.filter(item => item && typeof item.id === 'string') : [];
  return { versionRefs: [version('algorithm_registry', 'algorithm-registry', view.registry?.version),
    version('algorithm_definition_collection', 'algorithm-definitions', view.definitions?.version),
    version('mathematical_method', definition?.id ?? null, methods.length === 1 ? methods[0].value : null),
    ...(implementations.length ? implementations.map(item => version('algorithm_implementation', item.id, item.version)) : [version('algorithm_implementation', null, null)]),
    version('selected_algorithm_configuration', null, null)],
    diagnosticRefs: { latestCheck: null, currentConfigurationRevision: null, stableExceptionId: null, catalogStatus: tool.status },
    businessScope: { kind: 'algorithm_definition', definitionId: definition?.id ?? null, selectedConfigurationId: null } };
}

/** Serialize only typed identities. Never spread source records, reason text, parameters, paths, URLs or credentials. */
export function referenceEvidence(value: ObjectReferenceEvidence | undefined, now = Date.now()) {
  const string = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9_.:@/+~-]{1,512}$/u.test(v) && !v.includes('://') ? v : null;
  const number = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const kinds: ReferenceVersionKind[] = ['source_settings_document', 'api_plugin', 'capture_registry', 'algorithm_registry', 'algorithm_definition_collection', 'mathematical_method', 'algorithm_implementation', 'selected_algorithm_configuration'];
  const versionRefs = (value?.versionRefs ?? []).filter(item => kinds.includes(item.kind)).slice(0, 32).map(item => {
    const objectId = string(item.objectId), version = string(item.version) ?? number(item.version);
    return { kind: item.kind, objectId, version, state: objectId !== null && version !== null ? 'known' : 'unknown' };
  });
  const timestamp = (v: unknown): string | null => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(v)) return null;
    const time = Date.parse(v), canonical = v.includes('.') ? v : v.replace('Z', '.000Z');
    return Number.isFinite(time) && new Date(time).toISOString() === canonical ? v : null;
  };
  const raw = value?.diagnosticRefs.latestCheck;
  const checkedAt = timestamp(raw?.checkedAt), validUntil = timestamp(raw?.validUntil), revision = number(raw?.configurationRevision);
  const currentRevision = number(value?.diagnosticRefs.currentConfigurationRevision);
  const reportedStatus = raw && ['passed', 'partial', 'blocked'].includes(raw.status) ? raw.status : null;
  const objectId = string(raw?.objectId);
  const validity = !objectId || !reportedStatus || !checkedAt || !validUntil || revision === null || currentRevision === null || !Number.isFinite(now) || Date.parse(checkedAt) > Date.parse(validUntil) || Date.parse(checkedAt) > now
    ? 'unknown' : revision !== currentRevision ? 'configuration_mismatch' : Date.parse(validUntil) <= now ? 'expired' : 'current_observation';
  const scope = value?.businessScope && ['api_market', 'registered_capture', 'algorithm_definition'].includes(value.businessScope.kind) ? value.businessScope : undefined;
  return { versionRefs: versionRefs.length ? versionRefs : [{ kind: 'object_version', objectId: null, version: null, state: 'unknown' }],
    diagnosticRefs: { stableException: { state: 'unknown', id: null }, latestCheck: raw ? { kind: 'latest_source_check_observation', objectId,
      checkedAt, configurationRevision: revision, validUntil, reportedStatus, validity, historicalDiagnosticId: null, executionEligibility: 'not_asserted' }
      : { state: 'unknown' }, catalogStatus: ['ready', 'blocked', 'unavailable'].includes(value?.diagnosticRefs.catalogStatus ?? '') ? value!.diagnosticRefs.catalogStatus : 'unknown' },
    businessScope: scope ? { kind: scope.kind, marketId: string(scope.marketId), scopeId: string(scope.scopeId), definitionId: string(scope.definitionId),
      selectedConfigurationId: null, configuredOperation: string(scope.configuredOperation), registeredOperations: (scope.registeredOperations ?? []).map(string).filter((item): item is string => item !== null).slice(0, 64),
      actualCoverage: 'unknown', runtimeParameters: 'not_included' } : { state: 'unknown' } };
}
