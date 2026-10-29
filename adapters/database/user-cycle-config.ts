import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { PermissionService, PermissionCapability } from '../../platform/security/permissions.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { createUserCyclePort } from '../../modules/collection/user-cycle-port.js';
import { createUserPublicationPort } from '../../modules/collection/user-publication-port.js';
import { canonicalWfdJson, createWfdTransport, type WfdTransportConfig } from './wfd-transport.js';
import { createWfdFinancialReader } from './wfd-financial.js';
import type { ModelTaskOrigin } from '../../modules/agent/model-tools.js';
import type { ConversationUserCycleBinding } from '../../modules/collection/conversation-data-cycle.js';

export interface NativeUserCycleConfiguration {
  version: 1; mode: 'user_test'; baseUrl: string; instanceId: string; principalId: string;
  schemaPath: string; schemaSha256: string; credentialReference: string; tokenPath: string; inputDatasetId: string; harnessRootId?: string;
}
/** 复用本机已登记测试连接；凭据只在实际请求时解析，不进入浏览器或任务载荷。 */
export function nativeUserCycleTransport(configuration: NativeUserCycleConfiguration): WfdTransportConfig {
  return { binding: 'controlled-user-test', schemaPath: configuration.schemaPath,
    expectedSchemaSha256: configuration.schemaSha256, baseUrl: configuration.baseUrl, instanceId: configuration.instanceId,
    datasetId: configuration.inputDatasetId, ...(configuration.harnessRootId ? { harnessRootId: configuration.harnessRootId, environment: 'user_test' as const } : {}),
    timeoutMs: 15_000, maxResponseBytes: 400_000, resolveToken: () => readPrivateToken(configuration.tokenPath) };
}
export function createUserCycleBinding(configuration: NativeUserCycleConfiguration, context: {
  database: CoreDatabase; permissions: PermissionService;
}): ConversationUserCycleBinding {
  const transportConfiguration = nativeUserCycleTransport(configuration);
  const transport = createWfdTransport(transportConfiguration), binding = transport.datasetBinding;
  const semantics = binding.descriptor_semantics as Record<string, unknown>;
  if (binding.operation !== 'materials.receive' || semantics.data_kind !== 'user_submitted'
    || canonicalWfdJson(semantics.allowed_purposes) !== '["user_test"]') throw new TaskError('WFD_CONFIG_INVALID', '指定数据集不是登记的用户测试材料输出。');
  const capabilities: PermissionCapability[] = [
    { action: 'network', target: { kind: 'network', origin: transport.origin } },
    { action: 'secret', target: { kind: 'secret', name: configuration.credentialReference } },
  ];
  const label = `用户测试数据库:${configuration.instanceId}:${configuration.principalId}`;
  if (!context.permissions.listGrants({ includeRevoked: true }).some(grant => grant.label === label)) {
    context.permissions.grant({ capabilities, label, scope: { kind: 'persistent' } });
  }
  context.database.migrate('financial_task_origins', 1, `CREATE TABLE financial_task_origins (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id), origin_json TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  let conversationAuthority: ((origin: ModelTaskOrigin) => void) | undefined;
  const reader = createWfdFinancialReader({ ...transportConfiguration, credentialReference: configuration.credentialReference,
    registry: { database: context.database, providerId: configuration.instanceId, subjectId: configuration.principalId, purpose: 'user_test',
      datasetBinding: { dataset_id: String(binding.dataset_id), mapping_version: String(binding.mapping_version), unit_id: String(binding.unit_id),
        output_id: String(binding.output_id), definition_rev: String(binding.definition_rev), schema_rev: String(binding.schema_rev), contract_version: 'wfd-table/v0.2' },
      dataKind: 'user_submitted', assertReadable: (_reference, declarationOrigin, taskContext) => {
        const row = context.database.connection.prepare('SELECT origin_json FROM financial_task_origins WHERE task_id=?').get(taskContext.task.id);
        if (!row || !conversationAuthority) throw new TaskError('WFD_FINANCIAL_SCOPE_UNBOUND', '金融读取没有原会话任务的受信归属。');
        const origin = JSON.parse(String(row.origin_json)) as ModelTaskOrigin;
        if (origin.conversationId !== declarationOrigin.conversationId || origin.branchId !== declarationOrigin.branchId
          || declarationOrigin.subjectId !== configuration.principalId) throw new TaskError('WFD_FINANCIAL_SCOPE_MISMATCH', '固定快照不属于当前会话分支及受控主体。');
        conversationAuthority(origin);
      } } });
  const port = createUserCyclePort({ transport: transportConfiguration, instanceId: configuration.instanceId, principalId: configuration.principalId, purpose: 'user_test', sourceKind: 'user_submitted',
    sourceId: 'xuan-harness-user-attachment', adapterId: 'user-table-daily', adapterVersion: '1', target: {
      datasetId: String(binding.dataset_id), mappingVersion: String(binding.mapping_version), unitId: String(binding.unit_id), outputId: String(binding.output_id),
      definitionRevision: String(binding.definition_rev), schemaRevision: String(binding.schema_rev), contractVersion: 'wfd-table/v0.2',
      schemaSha256: configuration.schemaSha256, dataKind: 'user_submitted', purpose: 'user_test',
      descriptorSemantics: JSON.parse(canonicalWfdJson(semantics)), semanticsSha256: String(binding.semantics_sha256),
    } });
  const publicationTargets = (transport.schema['x-user-test-dataset-bindings'] as Record<string, unknown>[])
    .filter(item => item.operation === 'results.publish').map(item => {
      const publicationConfig = { ...transportConfiguration, datasetId: String(item.dataset_id) };
      const publicationTransport = createWfdTransport(publicationConfig);
      const target = { datasetId: String(item.dataset_id), mappingVersion: String(item.mapping_version), unitId: String(item.unit_id), outputId: String(item.output_id),
        definitionRevision: String(item.definition_rev), schemaRevision: String(item.schema_rev), contractVersion: 'wfd-table/v0.2' as const,
        schemaSha256: configuration.schemaSha256, dataKind: 'derived', purpose: 'user_test' as const,
        descriptorSemantics: JSON.parse(canonicalWfdJson(item.descriptor_semantics)), semanticsSha256: String(item.semantics_sha256) };
      return { toolId: String(item.tool_id), port: createUserPublicationPort({ transport: publicationConfig, target,
        instanceId: configuration.instanceId, principalId: configuration.principalId, purpose: 'user_test' }), transport: publicationTransport,
        descriptorSemantics: item.descriptor_semantics as Record<string, unknown> };
    });
  return { port, reader, principalId: configuration.principalId, instanceId: configuration.instanceId, capabilities, publicationTargets,
    attachConversationAuthority(check) { if (conversationAuthority) throw new TaskError('WFD_AUTHORITY_ALREADY_BOUND', '用户测试会话宿主已绑定。'); conversationAuthority = check; },
    assertFinancialTaskReadable(taskContext) {
      const row = context.database.connection.prepare('SELECT origin_json FROM financial_task_origins WHERE task_id=?').get(taskContext.task.id);
      if (!row || !conversationAuthority) throw new TaskError('FINANCIAL_ORIGIN_REVOKED', '原金融任务的当前来源资格未能核对。');
      conversationAuthority(JSON.parse(String(row.origin_json)) as ModelTaskOrigin);
    },
    bindFinancialTask(taskId, origin) {
      if (!conversationAuthority) throw new TaskError('WFD_AUTHORITY_UNBOUND', '用户测试会话宿主尚未绑定。');
      conversationAuthority(origin);
      const row = context.database.connection.prepare('SELECT origin_json FROM financial_task_origins WHERE task_id=?').get(taskId);
      if (row) {
        const previous = JSON.parse(String(row.origin_json)) as ModelTaskOrigin;
        if (previous.conversationId !== origin.conversationId || previous.branchId !== origin.branchId) throw new TaskError('WFD_FINANCIAL_SCOPE_MISMATCH', '原金融请求已属于另一个会话分支。');
        return;
      }
      context.database.connection.prepare('INSERT INTO financial_task_origins VALUES(?,?,?)').run(taskId, canonicalWfdJson(origin), Date.now());
    },
  };
}

function readPrivateToken(path: string): string {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0
    || metadata.uid !== process.getuid?.() || metadata.size < 16 || metadata.size > 4096 || realpathSync(path) !== path) {
    throw new TaskError('WFD_CREDENTIAL_UNAVAILABLE', '指定数据库凭据不是当前用户的受保护原生文件。');
  }
  return readFileSync(path, 'utf8').trim();
}
