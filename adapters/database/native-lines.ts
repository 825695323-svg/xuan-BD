import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { PermissionService } from '../../platform/security/permissions.js';
import type { ResourceBindings } from '../../platform/resources/bindings.js';
import type { ProcessRuntime } from '../../platform/runtime/programs.js';
import { startRegisteredService, runDirectProcess } from '../../platform/runtime/process.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { createUserCycleBinding, type NativeUserCycleConfiguration } from './user-cycle-config.js';
import { DatabaseLineService, type DatabaseLineIdentity, type DatabaseLineRegistration, type DatabaseLineVerification } from './line-selection.js';
import { createGenericDatabaseBinding, GENERIC_CONTRACT } from './generic-transport.js';
import { canonicalWfdJson, createWfdTransport, isWfdRecord, wfdSha256, type WfdRecord } from './wfd-transport.js';

export interface NativeDatabaseLineConfiguration {
  version: 1; connectionId: string; mode: 'user_test' | 'production'; purpose: 'user_test' | 'production';
  runtimeRoot: string; baseUrl: string; instanceId: string; principalId: string;
  protocol: 'wfd-harness-handoff/v0.1' | 'wfd-harness-handoff/v0.2'; protocolRevision: '0.1.3' | '0.2.0';
  schemaPath: string; schemaSha256: string; credentialReference: string; tokenPath: string; inputDatasetId?: string;
  generic?: { schemaPath: string; schemaSha256: string };
  libraryRoot?: string; storageBindingSha256?: string; storageId?: string; harnessRootId?: string;
}
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
async function readObject(path: string): Promise<WfdRecord> {
  if (!isAbsolute(path)) fail('WFD_CONFIG_INVALID', '原生连接记录必须是绝对路径。');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1_048_576) fail('WFD_CONFIG_INVALID', '原生连接记录不是有界普通文件。');
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isWfdRecord(value)) return fail('WFD_CONFIG_INVALID', '原生连接记录不是对象。');
  return value;
}
async function assertWiringComplete(registryPath: string) {
  try {
    const journal = await readObject(registryPath + '.database-wiring.json');
    if (journal.phase !== 'committed') fail('WFD_WIRING_PENDING', '连接与凭据引用采用尚未完整提交，保持启动封闭，须沿原维护意图恢复。');
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}
function token(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || info.uid !== process.getuid?.()
    || info.size < 16 || info.size > 4096 || realpathSync(path) !== path) fail('WFD_CREDENTIAL_UNAVAILABLE', '数据库凭据不是当前用户的受保护原生文件。');
  return readFileSync(path, 'utf8').trim();
}

/** Mount/check only the already registered image; never initialize, repair, or migrate a library. */
export async function startNativeDatabaseLineHost(input: { connectionId: string; schemaPath: string; inputDatasetId?: string; expectedInstanceId?: string; expectedLibraryRoot?: string }, resources: ResourceBindings, runtime: ProcessRuntime) {
  await assertWiringComplete(resources.path('connections_registry'));
  const registry = await readObject(resources.path('connections_registry'));
  const profiles = Array.isArray(registry.connections) ? registry.connections.filter(item => isWfdRecord(item) && item.id === input.connectionId) : [];
  if (profiles.length !== 1 || !isWfdRecord(profiles[0])) return fail('WFD_CONNECTION_UNBOUND', '所选线路没有唯一的受信连接登记。');
  const profile = profiles[0], production = profile.mode === 'production', mode = production ? 'production' : 'user_test';
  const protocol = production ? 'wfd-harness-handoff/v0.2' : 'wfd-harness-handoff/v0.1', revision = production ? '0.2.0' : '0.1.3';
  if (input.expectedInstanceId && profile.instance_id !== input.expectedInstanceId) return fail('WFD_INSTANCE_MISMATCH', '登记实例与连接固定身份不一致。');
  if (profile.kind !== 'native-loopback-service' || profile.mode !== mode || profile.purpose !== mode
    || profile.protocol !== protocol || profile.protocol_revision !== revision || !isWfdRecord(profile.startup)
    || !isWfdRecord(profile.credential_ref) || !isWfdRecord(profile.endpoint_reference) || !isAbsolute(String(profile.runtime_root))
    || !isAbsolute(String(profile.startup.cwd)) || profile.startup.login_autostart !== false || profile.startup.owner !== 'harness-agents backend'
    || profile.credential_ref.kind !== 'private-file-reference' || typeof profile.credential_ref.registry_id !== 'string'
    || typeof profile.instance_id !== 'string' || typeof profile.principal_id !== 'string' || typeof profile.protocol_schema_sha256 !== 'string') {
    return fail('WFD_CONFIG_INVALID', '线路登记缺少固定实例、主体、模式、凭据或受控启动身份。');
  }
  if (!isWfdRecord(profile.harness_binding) || profile.harness_binding.root !== resources.runtimeRoot
    || profile.harness_binding.root_id !== resources.document.runtimeIdentity) return fail('WFD_HARNESS_BINDING_MISMATCH', '该数据库连接未由提供方明确登记到当前应用固定身份。');
  const inputDatasetId = production ? undefined : profile.input_dataset_id;
  if (!production && (typeof inputDatasetId !== 'string' || !inputDatasetId || input.inputDatasetId !== undefined && input.inputDatasetId !== inputDatasetId)) return fail('WFD_INPUT_TARGET_UNBOUND', '此数据库连接尚未受控登记材料目标，或宿主指定目标与登记不同；请先核对原合同后采用。');
  const cwd = await realpath(String(profile.startup.cwd)), declaredRoot = String(profile.runtime_root);
  const schemaPath = resolve(cwd, production ? 'protocol/harness-handoff-v0.2.schema.json' : 'protocol/harness-handoff-v0.1.schema.json');
  if (schemaPath !== input.schemaPath || profile.endpoint_reference.path !== resolve(declaredRoot, 'server-info.json')
    || profile.instance_manifest !== resolve(declaredRoot, 'instance.json') || profile.credential_ref.path !== resolve(declaredRoot, 'auth/client.token')) return fail('WFD_CONFIG_INVALID', '登记模式、发现、凭据或实例路径不一致。');
  let storage: { binding: WfdRecord; guard: WfdRecord } | undefined;
  const libraryRoot = input.expectedLibraryRoot ?? (typeof profile.library_root === 'string' ? profile.library_root : undefined);
  const harnessRootId = libraryRoot ? resources.document.runtimeIdentity : undefined;
  const extra = harnessRootId ? ['--harness-root-id', harnessRootId] : [];
  const args = ['-B', '-m', 'core.server', 'serve', '--root', declaredRoot, '--port', '0', ...extra];
  if (canonicalWfdJson(profile.startup.argv) !== canonicalWfdJson(['python3', ...args])) return fail('WFD_CONFIG_INVALID', '原生服务启动参数与受信根配对不一致。');
  if (libraryRoot) {
    if (profile.library_root !== libraryRoot || await realpath(libraryRoot) !== libraryRoot
      || declaredRoot !== resolve(libraryRoot, 'data/mount/private/instance')) return fail('WFD_LIBRARY_ROOT_MISMATCH', '登记库根与连接固定位置不一致。');
    const record = await readObject(resolve(libraryRoot, 'data/storage.json'));
    assertStorageRecord(record, { libraryRoot, mode, runtimeRoot: declaredRoot, harnessRoot: resources.runtimeRoot, harnessRootId: harnessRootId! });
    const invoke = async (action: 'mount' | 'check') => {
      const result = await runDirectProcess({ runtime, binary: 'python3', args: ['-B', '-m', 'core.storage', action, '--outer-root', libraryRoot], cwd,
        signal: new AbortController().signal, assertAuthorized: () => { runtime.path('python3'); }, timeoutMs: 30_000, maxOutputBytes: 1_048_576 });
      const value: unknown = JSON.parse(result.stdout);
      if (!isWfdRecord(value)) return fail('WFD_STORAGE_UNVERIFIED', '数据库保管入口未返回明确核对对象。');
      return value;
    };
    const mounted = await invoke('mount');
    if (canonicalWfdJson(mounted) !== canonicalWfdJson(record)) return fail('WFD_STORAGE_UNVERIFIED', '挂载结果与原保管登记不一致。');
    const checked = await invoke('check');
    if (!isWfdRecord(checked.binding) || !isWfdRecord(checked.guard) || canonicalWfdJson(checked.binding) !== canonicalWfdJson(record)) return fail('WFD_STORAGE_UNVERIFIED', '原生保管核对未证明同一映像、物理卷及私有封印。');
    const guard = checked.guard;
    if (guard.record_sha256 !== wfdSha256(canonicalWfdJson(record)) || !Number.isSafeInteger(guard.mount_device)
      || !Array.isArray(guard.image_identity) || !Array.isArray(guard.outer_identity)
      || [...guard.image_identity, ...guard.outer_identity].some(item => !Number.isSafeInteger(item))) return fail('WFD_STORAGE_UNVERIFIED', '保管核对缺少可无损冻结的设备与映像身份。');
    storage = { binding: checked.binding, guard };
  } else if (declaredRoot.startsWith('/Volumes/')) return fail('WFD_STORAGE_UNBOUND', '外盘运行根必须通过已登记的原生容器核验，不能靠路径放行。');
  const runtimeRoot = await realpath(declaredRoot);
  if (runtimeRoot !== declaredRoot) return fail('WFD_CONFIG_INVALID', '原生运行根存在路径别名，未选择其他位置。');
  const schemaBytes = await readFile(schemaPath);
  const manifest = await readObject(String(profile.instance_manifest));
  if (manifest.instance_id !== profile.instance_id || manifest.mode !== mode || manifest.purpose !== mode || manifest.principal_id !== profile.principal_id
    || manifest.schema_sha256 !== profile.protocol_schema_sha256 || manifest.production_enabled !== production
    || wfdSha256(schemaBytes) !== profile.protocol_schema_sha256 || !isWfdRecord(manifest.dataset_bindings)
    || (!production && (!inputDatasetId || !Object.hasOwn(manifest.dataset_bindings, String(inputDatasetId))))
    || (production && Object.keys(manifest.dataset_bindings).length !== 0)) return fail('WFD_INSTANCE_MISMATCH', '线路实例、用途、模式摘要或获准目标与登记不一致。');
  const credentials = await readObject(String(registry.credential_registry)), tokenPath = String(profile.credential_ref.path), credentialId = profile.credential_ref.registry_id;
  if (!Array.isArray(credentials.credentials) || !credentials.credentials.some(item => isWfdRecord(item) && item.id === credentialId
    && item.instance_id === profile.instance_id && item.store === 'private-local-file' && Array.isArray(item.paths) && item.paths.includes(tokenPath))) return fail('WFD_CREDENTIAL_UNBOUND', '线路凭据未登记到同一实例。');
  token(tokenPath);
  const child = startRegisteredService({ runtime, binary: 'python3', args, cwd,
    assertAuthorized: () => { runtime.path('python3'); }, maxOutputBytes: 8_000_000 });
  const shutdown = () => child.shutdown();
  try {
    const deadline = Date.now() + 10_000;
    while (!child.failed && !child.exited && Date.now() < deadline) {
      let info: WfdRecord | undefined;
      try { info = await readObject(String(profile.endpoint_reference.path)); } catch { /* Discovery alone never proves liveness. */ }
      if (info && typeof child.pid === 'number' && info.pid === child.pid) {
        if (info.instance_id !== profile.instance_id || info.root !== runtimeRoot || info.mode !== mode || info.purpose !== mode
          || info.schema_sha256 !== profile.protocol_schema_sha256 || info.production_enabled !== production || info.started !== true
          || typeof info.base_url !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(info.base_url)
          || (storage && (info.storage_id !== storage.binding.storage_id || canonicalWfdJson(info.harness_binding) !== canonicalWfdJson(storage.binding.harness_binding)))) return fail('WFD_INSTANCE_MISMATCH', '本次子进程的实例、协议或保管及框架根配对不同。');
        let generic: NativeDatabaseLineConfiguration['generic'];
        if (!production && info.generic_contract !== undefined) {
          const declared = info.generic_contract, expected = resolve(cwd, 'protocol/data-service-v1.schema.json');
          if (!isWfdRecord(declared) || declared.version !== GENERIC_CONTRACT || declared.revision !== '1.0.0' || declared.protocol_version !== 3
            || declared.route !== '/v3/data-entry' || declared.schema_path !== expected || typeof declared.sha256 !== 'string'
            || wfdSha256(await readFile(expected)) !== declared.sha256) return fail('WFD_GENERIC_DISCOVERY_INVALID', '通用合同发现未通过同进程、固定路径及真实模式摘要核对。');
          generic = { schemaPath: expected, schemaSha256: declared.sha256 };
        }
        const configuration: NativeDatabaseLineConfiguration = { version: 1, connectionId: input.connectionId, mode, purpose: mode, runtimeRoot,
          baseUrl: info.base_url, instanceId: profile.instance_id, principalId: profile.principal_id, protocol, protocolRevision: revision,
          schemaPath, ...(generic ? { generic } : {}), ...(storage ? { libraryRoot: libraryRoot!, harnessRootId: harnessRootId!, storageId: String(storage.binding.storage_id),
            storageBindingSha256: wfdSha256(canonicalWfdJson(storage.binding)) } : {}),
          schemaSha256: profile.protocol_schema_sha256, credentialReference: String(profile.credential_ref.registry_id), tokenPath,
          ...(typeof inputDatasetId === 'string' ? { inputDatasetId } : {}) };
        await verifyNativeDatabaseLine(configuration);
        return { configuration, shutdown };
      }
      await new Promise(done => setTimeout(done, 40));
    }
    return fail('WFD_HOST_UNAVAILABLE', '线路未成为本宿主已核就绪的子进程，未接管其他写进程。');
  } catch (error) { await shutdown(); throw error; }
}

export function assertStorageRecord(record: WfdRecord, expected: { libraryRoot: string; mode: string; runtimeRoot: string; harnessRoot: string; harnessRootId: string }) {
  const fixed = { format: 'wfd-asif-apfs/v1', outer_root: expected.libraryRoot, mode: expected.mode,
    runtime_root: expected.runtimeRoot, image_path: resolve(expected.libraryRoot, 'data/wfd.asif'), mount_path: resolve(expected.libraryRoot, 'data/mount'),
    harness_binding: { root: expected.harnessRoot, root_id: expected.harnessRootId } };
  if (Object.entries(fixed).some(([key, value]) => !Object.hasOwn(record, key) || canonicalWfdJson(record[key]) !== canonicalWfdJson(value))
    || !['storage_id', 'outer_volume_uuid', 'native_volume_uuid'].every(key => typeof record[key] === 'string' && (record[key] as string).length)) {
    fail('WFD_STORAGE_UNVERIFIED', 'ASIF保管位置、物理/原生卷身份或框架根配对不一致。');
  }
}

/** 受信用户测试配置保留其自身实例和凭据位置。 */
export function nativeTestLine(configuration: NativeUserCycleConfiguration): NativeDatabaseLineConfiguration {
  return { ...configuration, connectionId: 'wfd-user-test', purpose: 'user_test', runtimeRoot: dirname(dirname(configuration.tokenPath)),
    protocol: 'wfd-harness-handoff/v0.1', protocolRevision: '0.1.3' };
}
export function createNativeDatabaseLineService(options: {
  database: CoreDatabase; permissions: PermissionService;
  initialConfiguration: NativeUserCycleConfiguration | NativeDatabaseLineConfiguration;
  additionalConfigurations?: readonly NativeDatabaseLineConfiguration[];
}): DatabaseLineService {
  const initial = 'connectionId' in options.initialConfiguration ? options.initialConfiguration : nativeTestLine(options.initialConfiguration);
  const configurations = [initial, ...(options.additionalConfigurations ?? [])];
  const lines = configurations.map(configuration => createNativeDatabaseLineRegistration(configuration, options));
  return new DatabaseLineService({ database: options.database, initialConnectionId: initial.connectionId, lines });
}

export function nativeDatabaseLineIdentity(configuration: NativeDatabaseLineConfiguration): DatabaseLineIdentity {
  if (!['user_test', 'production'].includes(configuration.mode) || configuration.purpose !== configuration.mode
  || configuration.protocol !== (configuration.mode === 'production' ? 'wfd-harness-handoff/v0.2' : 'wfd-harness-handoff/v0.1')
  || configuration.protocolRevision !== (configuration.mode === 'production' ? '0.2.0' : '0.1.3')
  || (configuration.mode === 'production' && configuration.inputDatasetId !== undefined)) return fail('WFD_CONFIG_INVALID', '数据库模式、用途、协议与获准目标必须由本连接明确登记。');
  return { connectionId: configuration.connectionId, instanceId: configuration.instanceId, principalId: configuration.principalId,
  mode: configuration.mode, purpose: configuration.purpose, protocol: configuration.protocol, protocolRevision: configuration.protocolRevision,
  schemaSha256: configuration.schemaSha256, credentialReference: configuration.credentialReference, runtimeRoot: configuration.runtimeRoot,
  ...(configuration.libraryRoot ? { libraryRoot: configuration.libraryRoot } : {}), ...(configuration.storageBindingSha256 ? { storageBindingSha256: configuration.storageBindingSha256 } : {}),
  ...(configuration.storageId ? { storageId: configuration.storageId } : {}), ...(configuration.harnessRootId ? { harnessRootId: configuration.harnessRootId } : {}) };
}
/** 鉴权后核对连接身份、当前权限与固定读回；空正式实例仍只读。 */
export async function verifyNativeDatabaseLine(configuration: NativeDatabaseLineConfiguration): Promise<DatabaseLineVerification> {
  const identity = nativeDatabaseLineIdentity(configuration);
  const transport = createWfdTransport({ binding: configuration.mode === 'production' ? 'registered-production' : 'controlled-user-test',
  schemaPath: configuration.schemaPath, expectedSchemaSha256: configuration.schemaSha256, baseUrl: configuration.baseUrl, instanceId: configuration.instanceId,
  datasetId: configuration.inputDatasetId, ...(configuration.harnessRootId ? { harnessRootId: configuration.harnessRootId, environment: configuration.mode } : {}), resolveToken: () => token(configuration.tokenPath) });

  const capabilities = await transport.call({ protocol_version: 2, request_id: `line-cap-${randomUUID()}`, operation: 'capabilities.search', arguments: {} });
  const items = capabilities.capabilities;
  if (!Array.isArray(items) || items.some(item => !isWfdRecord(item)) || !Array.isArray(capabilities.operations)
    || capabilities.instance_id !== identity.instanceId || capabilities.principal_id !== identity.principalId
    || capabilities.mode !== identity.mode || capabilities.purpose !== identity.purpose
    || capabilities.protocol_schema_sha256 !== identity.schemaSha256 || capabilities.schema_version !== identity.protocol
    || capabilities.schema_revision !== identity.protocolRevision || !capabilities.operations.includes('capabilities.search')) return fail('DATABASE_LINE_CAPABILITIES_MISMATCH', '实际能力缺少明确目标清单。');
  if (configuration.mode === 'production' && (capabilities.production_enabled !== true || capabilities.write_enabled !== false
    || capabilities.admission_profile !== 'production-empty-read-only/v1' || items.length !== 0
    || (capabilities.operations as unknown[]).some(operation => !['capabilities.search', 'data.jobs.get', 'data.read', 'data.snapshots.resolve', 'data.coverage'].includes(String(operation))))) {
    return fail('DATABASE_LINE_CAPABILITIES_MISMATCH', '正式实例不是登记的独立空只读线路。');
  }
  if (configuration.mode === 'user_test') {
    const expected = transport.schema['x-user-test-dataset-bindings'] as WfdRecord[];
    const requiredOperations = ['capabilities.search', 'data.jobs.get', 'data.jobs.resume', 'data.jobs.cancel', 'data.read', 'data.snapshots.resolve', 'data.coverage', 'materials.receive', 'results.publish'];
    if (!Array.isArray(expected) || items.length !== expected.length || !Array.isArray(capabilities.operations)
      || requiredOperations.some(operation => !(capabilities.operations as unknown[]).includes(operation))
      || expected.some(target => {
        const matching = (items as WfdRecord[]).filter(item => item.dataset_id === target.dataset_id);
        if (matching.length !== 1) return true;
        const item = matching[0]!;
        return item.binding_registered !== true || item.mapping_version !== target.mapping_version
          || item.semantics_sha256 !== target.semantics_sha256 || item.contract_version !== target.contract_version
          || canonicalWfdJson(item.allowed_purposes) !== '["user_test"]'
          || canonicalWfdJson(item.descriptor_semantics) !== canonicalWfdJson(target.descriptor_semantics)
          || canonicalWfdJson(item.target) !== canonicalWfdJson({ unit_id: target.unit_id, output_id: target.output_id, definition_rev: target.definition_rev, schema_rev: target.schema_rev });
      })) return fail('DATABASE_LINE_CAPABILITIES_MISMATCH', '测试线路当前目标、语义或实际操作权限不足，不能采用历史权限。');
  }
  const nonempty = (items as WfdRecord[]).filter(item => item.head_snapshot_id !== null || (Array.isArray(item.snapshot_ids) && item.snapshot_ids.length));
  if (!nonempty.length) return { identity, capabilities, fixedRead: { state: 'empty', datasetIds: (items as WfdRecord[]).map(item => String(item.dataset_id)), reason: '实际鉴权能力中无已提交快照，未执行固定读回；此空态不授权业务写入。' } };
  const item = nonempty.find(item => item.readable === true && typeof item.head_snapshot_id === 'string');
  if (!item) return fail('DATABASE_LINE_READ_UNVERIFIED', '线路存在快照但无当前获准读取的明确父快照。');
  const read = await transport.call({ protocol_version: 2, request_id: `line-read-${randomUUID()}`, operation: 'data.read',
    arguments: { dataset_id: item.dataset_id, snapshot_id: item.head_snapshot_id, limit: 1000 } });
  const descriptor = read.descriptor;
  if (read.instance_id !== identity.instanceId || read.mode !== identity.mode || read.purpose !== identity.purpose
    || read.protocol_schema_sha256 !== identity.schemaSha256 || read.dataset_id !== item.dataset_id || read.snapshot_id !== item.head_snapshot_id
    || read.dataset_mapping_version !== item.mapping_version || canonicalWfdJson(read.target) !== canonicalWfdJson(item.target)
    || !isWfdRecord(descriptor) || !isWfdRecord(descriptor.data_resource) || !Array.isArray(read.rows) || read.next_cursor !== null
    || read.row_count !== read.rows.length || read.returned_rows !== read.rows.length
    || wfdSha256(canonicalWfdJson(descriptor)) !== read.descriptor_sha256 || wfdSha256(canonicalWfdJson(read.rows)) !== descriptor.data_resource.sha256) return fail('DATABASE_LINE_READ_UNVERIFIED', '实际固定读取的身份、声明或完整行资源摘要不符。');
  return { identity, capabilities, fixedRead: { state: 'verified', datasetId: String(item.dataset_id), snapshotId: String(read.snapshot_id), sha256: String(descriptor.data_resource.sha256) } };
}
export function createNativeDatabaseLineRegistration(configuration: NativeDatabaseLineConfiguration, options: { database: CoreDatabase; permissions: PermissionService }): DatabaseLineRegistration {
  const identity = nativeDatabaseLineIdentity(configuration);
  const binding = configuration.mode === 'user_test' && configuration.inputDatasetId
  ? createUserCycleBinding({ ...configuration, mode: 'user_test', inputDatasetId: configuration.inputDatasetId }, options) : undefined;
  const generic = configuration.mode === 'user_test' && configuration.generic ? createGenericDatabaseBinding({ baseUrl: configuration.baseUrl,
    instanceId: configuration.instanceId, ...configuration.generic, credentialReference: configuration.credentialReference,
    ...(configuration.harnessRootId ? { harnessRootId: configuration.harnessRootId } : {}), resolveToken: () => token(configuration.tokenPath) }) : undefined;
  return { identity, binding, generic, verify: () => verifyNativeDatabaseLine(configuration) };
}


/** 共享登记中只装配提供方已绑定本应用的连接；不改绑其他运行根或自动选择正式库。 */
export async function startRegisteredDatabaseLineHosts(resources: ResourceBindings, runtime: ProcessRuntime): Promise<{
  configurations: NativeDatabaseLineConfiguration[]; initialConfiguration?: NativeDatabaseLineConfiguration; shutdown(): Promise<void>;
}> {
  const hosts: Awaited<ReturnType<typeof startNativeDatabaseLineHost>>[] = [];
  const shutdown = async () => {
    const errors: unknown[] = [];
    for (const host of [...hosts].reverse()) try { await host.shutdown(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '数据库自有子进程未全部确认收束。');
  };
  if (!resources.document.resources.connections_registry) return { configurations: [], shutdown };
  await assertWiringComplete(resources.path('connections_registry'));
  const registry = await readObject(resources.path('connections_registry'));
  if (!Array.isArray(registry.connections)) return fail('WFD_CONFIG_INVALID', '数据库连接登记缺少明确清单。');
  const profiles = registry.connections.filter(item => isWfdRecord(item) && item.kind === 'native-loopback-service'
    && isWfdRecord(item.harness_binding) && item.harness_binding.root === resources.runtimeRoot
    && item.harness_binding.root_id === resources.document.runtimeIdentity) as WfdRecord[];
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) return fail('WFD_CONNECTION_UNBOUND', '本应用连接编号重复，不能隐式覆盖。');
  try {
    for (const profile of profiles) {
      if (typeof profile.id !== 'string' || typeof profile.instance_id !== 'string' || !isWfdRecord(profile.startup)
        || typeof profile.startup.cwd !== 'string' || !isAbsolute(profile.startup.cwd)) return fail('WFD_CONFIG_INVALID', '本应用连接登记缺少受控启动及实例身份。');
      hosts.push(await startNativeDatabaseLineHost({ connectionId: profile.id, expectedInstanceId: profile.instance_id,
        ...(typeof profile.library_root === 'string' ? { expectedLibraryRoot: profile.library_root } : {}),
        schemaPath: resolve(profile.startup.cwd, profile.mode === 'production' ? 'protocol/harness-handoff-v0.2.schema.json' : 'protocol/harness-handoff-v0.1.schema.json'),
        ...(typeof profile.input_dataset_id === 'string' ? { inputDatasetId: profile.input_dataset_id } : {}) }, resources, runtime));
    }
    const configurations = hosts.map(host => host.configuration), tests = configurations.filter(configuration => configuration.mode === 'user_test');
    const initialConfiguration = tests.find(configuration => configuration.connectionId === 'wfd-user-test') ?? (tests.length === 1 ? tests[0] : undefined);
    return { configurations, initialConfiguration, shutdown };
  } catch (error) {
    try { await shutdown(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], '数据库启动失败且自有子进程未全部确认收束。'); }
    throw error;
  }
}
