import { resolve } from 'node:path';
import { LocalAlgorithmService } from '../../modules/financial/algorithm-service.js';
import { createWfdProductMachineSnapshotPort } from '../../modules/financial/product-machine-snapshot.js';
import type { R1Runtime } from '../../modules/collection/r1-runtime.js';
import { TaskError, type TaskService } from '../../platform/jobs/tasks.js';
import type { ProcessRuntime } from '../../platform/runtime/programs.js';
import { digestOperationArgs, type PermissionService } from '../../platform/security/permissions.js';
import type { CoreDatabase } from '../../platform/state/database.js';

interface LocalAlgorithmAssemblyContext {
  database: CoreDatabase;
  tasks(): TaskService;
  permissions: PermissionService;
  r1Runtime?: R1Runtime;
}
export type LocalAlgorithmFactory = (context: LocalAlgorithmAssemblyContext) => LocalAlgorithmService | undefined;

/** 使用已绑定的 Python 与工作台 WFD 连接装配 MACD。 */
export function localAlgorithmConfiguration(codeRoot: string, processRuntime: ProcessRuntime): LocalAlgorithmFactory {
  return ({ database, tasks, permissions, r1Runtime }) => {
    let pythonExecutable: string;
    try { pythonExecutable = processRuntime.path('python3'); }
    catch { return undefined; }
    return new LocalAlgorithmService({
      database, tasks, permissions, processRuntime, pythonExecutable,
      computeAssetsRoot: resolve(codeRoot, 'plugins/financial/local-compute/assets'),
      snapshots: r1Runtime ? macdSnapshotPort(r1Runtime) : undefined,
    });
  };
}

function macdSnapshotPort(runtime: R1Runtime) {
  let digest: string;
  try { digest = digestOperationArgs(runtime.currentIdentity()); }
  catch { return undefined; }
  const port = createWfdProductMachineSnapshotPort({
    client: runtime.connection.client, instanceId: runtime.connection.connectionId,
  });
  const assertIdentity = () => {
    if (digestOperationArgs(runtime.currentIdentity()) !== digest)
      throw new TaskError('ALGORITHM_SNAPSHOT_BINDING_CHANGED', 'MACD 的 WFD 连接已变化，请核对连接后重新装配。');
  };
  return {
    status() {
      try { assertIdentity(); return port.status(); }
      catch { return { status: 'unavailable' as const, reason: 'MACD 的 WFD 连接无法按装配时身份核对。' }; }
    },
    async read(...args: Parameters<typeof port.read>) {
      assertIdentity();
      const result = await port.read(...args);
      assertIdentity();
      return { ...result, connectionIdentityDigest: digest };
    },
  };
}
