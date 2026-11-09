import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CoreDatabase } from '../platform/state/database.js';
import { ResourceBindings } from '../platform/resources/bindings.js';
import { createR1HandoffRuntime } from '../modules/collection/r1-runtime.js';
import { WfdProductMachineClient } from '../adapters/database/wfd-product-machine.js';
import { R1HandoffService, WfdStructuredIngestClient } from '../modules/collection/r1-structured-handoff.js';

/**
 * R1 受控 CLI。实际模式只从 ResourceBindings/connections_registry 解析连接；
 * 隔离模式显式 --config，不能用来授权本机 root/权限。无新 UI。
 */
const arg = (name: string): string | undefined => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : undefined; };
const required = (name: string): string => { const v = arg(name); if (!v) throw new Error('missing --' + name); return v; };
const action = required('action');
const dbPath = resolve(required('db'));
const database = new CoreDatabase(dbPath);
try {
  let service: R1HandoffService, client: WfdStructuredIngestClient | undefined, connectionId: string | null = null;
  const configPath = arg('config');
  if (configPath) {
    const config = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as Record<string, unknown>;
    const projectRoot = typeof config.project_root === 'string' ? config.project_root : null;
    if (!projectRoot) throw new Error('config project_root missing');
    client = new WfdStructuredIngestClient(new WfdProductMachineClient({
      pythonPath: resolve(required('python')), entryPath: resolve(required('entry')),
      configPath: resolve(configPath), projectRoot,
    }), resolve(required('schema')));
    service = new R1HandoffService({ database });
  } else {
    const resources = new ResourceBindings(resolve(required('runtime-root')));
    const runtime = createR1HandoffRuntime({ resources, database, connectionId: arg('connection') });
    service = runtime.service; client = runtime.client; connectionId = runtime.connection.connectionId;
  }
  if (action === 'status') {
    const probe = client ? await client.probeProfile() : null;
    console.log(JSON.stringify({ status: connectionId ? 'configured' : 'isolated', connectionId, profile: probe }, null, 2));
  } else if (action === 'local-readback') {
    console.log(JSON.stringify(service.localExplanation(required('request-id')), null, 2));
  } else if (action === 'submit') {
    if (!client) throw new Error('client unavailable');
    console.log(JSON.stringify(await service.submitAndAssociate(required('request-id'), client), null, 2));
  } else if (action === 'recover') {
    if (!client) throw new Error('client unavailable');
    console.log(JSON.stringify(await service.recoverStatus(required('request-id'), client), null, 2));
  } else if (action === 'prepare') {
    const structured = JSON.parse(readFileSync(resolve(required('structured')), 'utf8'));
    const localRefs = JSON.parse(readFileSync(resolve(required('local-refs')), 'utf8'));
    console.log(JSON.stringify(service.prepare({ structured, localRefs }), null, 2));
  } else throw new Error('action must be status|prepare|submit|recover|local-readback');
} finally { database.close(); }
