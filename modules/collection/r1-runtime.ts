import type { ResourceBindings } from '../../platform/resources/bindings.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { MaterialService } from './materials/service.js';
import { resolveProductMachineConnection, type ResolvedProductMachineConnection } from '../financial/product-machine-connection.js';
import { R1HandoffService, WfdStructuredIngestClient } from './r1-structured-handoff.js';

/**
 * R1 应用侧受控工厂。
 *
 * 连接只从 ResourceBindings/connections_registry 解析；BD 本地材料只经现有
 * MaterialService 读取。调用方不传 store/runtime/principal/权限。默认 prod 连接
 * 和旧任务不因此改变；本工厂仅返回对象，不自动提交、不自动采用。
 */
export interface R1RuntimeOptions {
  resources: ResourceBindings;
  database: CoreDatabase;
  materials?: MaterialService;
  processing?: { get(planId: string): unknown; outputArtifact(planId: string, outputId: string): { bytes: Buffer } };
  candidates?: { verifyObject(ref: { kind: 'stored-object'; sha256: string; byte_length: number; media_type: string }): boolean;
    objectBytes(ref: { kind: 'stored-object'; sha256: string; byte_length: number; media_type: string }): Buffer };
  connectionId?: string;
}
export interface R1Runtime {
  connection: ResolvedProductMachineConnection;
  service: R1HandoffService;
  client: WfdStructuredIngestClient;
}
export function createR1HandoffRuntime(options: R1RuntimeOptions): R1Runtime {
  const connection = resolveProductMachineConnection(options.resources, options.connectionId ?? 'wfd-product-local-20261027');
  const service = new R1HandoffService({ database: options.database, materials: options.materials,
    processing: options.processing, candidates: options.candidates });
  const client = new WfdStructuredIngestClient(connection.client, connection.schemaPath);
  return { connection, service, client };
}
