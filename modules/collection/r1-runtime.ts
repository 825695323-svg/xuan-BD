import { readFileSync } from 'node:fs';
import type { R1ConnectionIdentity } from '../../contracts/r1-contracts.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { ResourceBindings } from '../../platform/resources/bindings.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import { readConnectionRegistry } from '../../platform/config/connections.js';
import type { MaterialService } from './materials/service.js';
import { resolveProductMachineConnection, type ResolvedProductMachineConnection } from '../financial/product-machine-connection.js';
import { R1HandoffService, WfdStructuredIngestClient, type R1CalculationCandidateVerification } from './r1-structured-handoff.js';

/**
 * R1 应用侧受控工厂。
 *
 * 连接只从 ResourceBindings/connections_registry 解析；BD 本地材料只经现有
 * MaterialService 读取。调用方不传存储根、运行根、调用者或权限。连接须由宿主显式选择或来自当前受控登记；
 * 本工厂仅返回对象，不自动提交、不自动采用。
 */
export interface R1RuntimeOptions {
  resources: ResourceBindings;
  database: CoreDatabase;
  materials?: MaterialService;
  processing?: { get(planId: string): unknown; outputArtifact(planId: string, outputId: string): { bytes: Buffer } };
  candidates?: { verifyObject(ref: { kind: 'stored-object'; sha256: string; byte_length: number; media_type: string }): boolean;
    objectBytes(ref: { kind: 'stored-object'; sha256: string; byte_length: number; media_type: string }): Buffer };
  connectionId?: string;
  verifyCalculationCandidate?(input: R1CalculationCandidateVerification): void;
  verifyCalculationCandidateRemote?(taskId: string, signal: AbortSignal): Promise<void>;
  verifyFixedDerivedRemote?(taskId: string, signal: AbortSignal): Promise<void>;
  verifyFixedDerived?(refs: import('./r1-structured-handoff.js').R1LocalReferences, documentSha256: string): void;
  verifyAlgorithmCandidate?(input: R1CalculationCandidateVerification): void;
}
export interface R1Runtime {
  connection: ResolvedProductMachineConnection;
  service: R1HandoffService;
  client: WfdStructuredIngestClient;
  /** Re-resolve the registered identity and hash its actual files before every dispatch/recovery. */
  currentIdentity(): R1ConnectionIdentity;
}
export function createR1HandoffRuntime(options: R1RuntimeOptions): R1Runtime {
  const registeredSelection = () => options.resources.document.resources.connections_registry
    ? readConnectionRegistry(options.resources.path('connections_registry'))?.manualIngestConnectionId : undefined;
  const manualSelection = options.connectionId === undefined ? registeredSelection() : undefined;
  const selectedConnectionId = options.connectionId ?? manualSelection;
  if (!selectedConnectionId) throw new TaskError('R1_CONNECTION_NOT_SELECTED', '请先明确选择并采用 R1（结构化交接）连接。');
  const connectionOptions = { allowProduction: options.connectionId !== undefined || manualSelection !== undefined };
  const connection = resolveProductMachineConnection(options.resources, selectedConnectionId, connectionOptions);
  const service = new R1HandoffService({ database: options.database, materials: options.materials,
    processing: options.processing, candidates: options.candidates, verifyCalculationCandidate: options.verifyCalculationCandidate,
    verifyCalculationCandidateRemote: options.verifyCalculationCandidateRemote,
    verifyFixedDerivedRemote: options.verifyFixedDerivedRemote,
    verifyAlgorithmCandidate: options.verifyAlgorithmCandidate, verifyFixedDerived: options.verifyFixedDerived });
  const client = new WfdStructuredIngestClient(connection.client, connection.schemaPath);
  const initialConfig = JSON.parse(readFileSync(connection.configPath, 'utf8')) as Record<string, unknown>;
  const currentIdentity = (): R1ConnectionIdentity => {
    if ((options.connectionId ?? registeredSelection()) !== selectedConnectionId) {
      throw new TaskError('R1_CONNECTION_RELOAD_REQUIRED', '手动投喂的受控连接选择已变化；须核对后重新装配，原请求不改绑。');
    }
    const actual = resolveProductMachineConnection(options.resources, connection.connectionId, connectionOptions);
    const raw = readFileSync(actual.configPath);
    const config = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    if (canonicalWfdJson(actual.profile) !== canonicalWfdJson(connection.profile)
      || actual.schemaPath !== connection.schemaPath || config.project_root !== initialConfig.project_root) {
      throw new TaskError('R1_CONNECTION_RELOAD_REQUIRED', '连接登记或内部进程入口已变化；现有客户端不能展示新连接却调用旧入口，须核对后重新装配。');
    }
    if (config.profile !== 'data_only') throw new TaskError('R1_PROFILE_REQUIRED', '新交接只允许已登记的 data_only 连接；旧 profile 不能被重放。');
    const usage = actual.profile.mode === 'production'
      ? { mode: 'production' as const, purpose: 'production' as const }
      : { mode: 'user_test' as const, purpose: 'user_test' as const };
    return { connectionId: actual.connectionId, protocol: 'wfd.structured-ingest/1.0', profile: 'data_only',
      ...usage, runtimeIdentity: actual.profile.harness_binding.root_id,
      store: actual.store, runtime: actual.runtime, callerId: actual.callerId, namespace: actual.trustedActorNamespace,
      configSha256: wfdSha256(raw), schemaSha256: wfdSha256(readFileSync(actual.schemaPath)),
      entrySha256: wfdSha256(readFileSync(actual.profile.entry_path)),
      pythonPath: actual.profile.python_path, entryPath: actual.profile.entry_path };
  };
  if (connection.profile.mode === 'production') currentIdentity();
  return { connection, service, client, currentIdentity };
}
