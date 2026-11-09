import { resolve } from 'node:path';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { TaskService } from '../../platform/jobs/tasks.js';
import type { PermissionCapability, PermissionService } from '../../platform/security/permissions.js';
import type { ResourceBindings } from '../../platform/resources/bindings.js';
import type { ServiceOptions } from './services.js';
import { captureAssets, verifyAssets } from '../../plugins/financial/local-compute/assets.js';
import { LocalAlgorithmService, captureCodeBinding } from '../../modules/financial/algorithm-service.js';
import type { AlgorithmEnvironment, AlgorithmSnapshotPort, ManagedTableReader } from '../../modules/financial/algorithm-types.js';
import type { MaterialService } from '../../modules/collection/materials/service.js';
import { createMaterialTableReader } from '../../modules/financial/managed-table.js';

/** 仅可信启动器装配已核第一方代码；浏览器不能传入运行环境或实现路径。 */
export function localFinancialConfiguration(resources: ResourceBindings): ServiceOptions['configureFinancial'] {
  const binding = resources.document.resources.compute_assets;
  if (!binding) return undefined;
  const computeAssetsRoot = resources.path('compute_assets'), bundle = captureAssets(computeAssetsRoot);
  verifyAssets(bundle);
  if (binding.kind !== 'directory' || binding.identity !== bundle.version) throw new Error('金融计算资产与受控采用的摘要身份不同，请核对维护记录。');
  return ({ permissions }) => {
    const processRuntime = new ProcessRuntime(resources);
    const pythonExecutable = processRuntime.path('python3'), label = `首包封闭金融计算:${pythonExecutable}`;
    if (!permissions.listGrants({ includeRevoked: true }).some(grant => grant.label === label)) permissions.grant({
      capabilities: [{ action: 'execute', target: { kind: 'file', path: pythonExecutable } }], scope: { kind: 'persistent' }, label });
    return { environment: 'local-review', computeAssetsRoot, expectedAssetsVersion: binding.identity, pythonExecutable, processRuntime };
  };
}

/**
 * 已有基础算法的受控本机装配工厂。
 *
 * 与旧 `compute_assets` 绑定无关：直接封闭当前源码目录中的第一方实现，只要求宿主显式提供受管表
 * 只读端口、环境、是否启用和 Python 运行入口。本函数不写 machine.bindings、不登记插件、不授予权限。
 */
export interface LocalAlgorithmAssemblyOptions {
  projectRoot: string;
  resources: ResourceBindings;
  /** 可直接给端口，或给一个由已装配 MaterialService 构造只读端口的函数。 */
  tables?: ManagedTableReader | ((materials: MaterialService) => ManagedTableReader);
  /** 只接受受信宿主明确装配的固定快照端口；缺少时具体报告未装配。 */
  snapshots?: AlgorithmSnapshotPort | ((context: LocalAlgorithmAssemblyContext) => AlgorithmSnapshotPort | undefined);
  /** 仅隔离合成测试的静态开关；本机预览必须由持久采用记录驱动，静态 true 会被忽略。 */
  enabled?: boolean;
  environment?: AlgorithmEnvironment;
  expectedAssetsVersion?: string;
  /** 受控采用时冻结的 TS 输入转换/结果校验代码摘要。 */
  expectedCodeVersion?: string;
}
export interface LocalAlgorithmAssemblyContext {
  database: CoreDatabase;
  tasks(): TaskService;
  permissions: PermissionService;
  materials?: MaterialService;
}
export type LocalAlgorithmFactory = (context: LocalAlgorithmAssemblyContext) => LocalAlgorithmService;

export function localAlgorithmConfiguration(options: LocalAlgorithmAssemblyOptions): LocalAlgorithmFactory {
  const assetsRoot = resolve(options.projectRoot, 'plugins/financial/local-compute/assets');
  const bundle = captureAssets(assetsRoot);
  verifyAssets(bundle);
  if (options.expectedAssetsVersion !== undefined && bundle.version !== options.expectedAssetsVersion) {
    throw new Error('算法实现源码摘要与受控采用记录不一致，请先核对维护记录。');
  }
  if (options.expectedCodeVersion !== undefined && captureCodeBinding().version !== options.expectedCodeVersion) {
    throw new Error('算法 TS 输入转换/结果校验代码摘要与受控采用记录不一致，请先核对维护记录。');
  }
  const processRuntime = new ProcessRuntime(options.resources);
  const pythonExecutable = processRuntime.path('python3');
  return context => {
    const tables = typeof options.tables === 'function' ? context.materials ? options.tables(context.materials) : undefined
      : options.tables ?? (context.materials ? createMaterialTableReader(context.materials) : undefined);
    const snapshots = typeof options.snapshots === 'function' ? options.snapshots(context) : options.snapshots;
    return new LocalAlgorithmService({ database: context.database, tasks: context.tasks, permissions: context.permissions,
      computeAssetsRoot: assetsRoot, expectedAssetsVersion: bundle.version,
      pythonExecutable, processRuntime, tables, snapshots, environment: options.environment ?? 'local-review',
      enabled: options.enabled });
  };
}

/** 现场采用所需的精确对象与摘要；读取和返回本对象不授予权限、不写任何登记。 */
export function localAlgorithmAdoption(resources: ResourceBindings, projectRoot: string) {
  const assetsRoot = resolve(projectRoot, 'plugins/financial/local-compute/assets');
  const bundle = captureAssets(assetsRoot), code = captureCodeBinding();
  verifyAssets(bundle);
  const processRuntime = new ProcessRuntime(resources);
  const pythonExecutable = processRuntime.path('python3');
  const capabilities: PermissionCapability[] = [{ action: 'execute', target: { kind: 'file', path: pythonExecutable } }];
  return { assetsRoot, assetsVersion: bundle.version, codeVersion: code.version, codeFiles: code.files,
    fileHashes: bundle.hashes, pythonExecutable, capabilities, permissionLabel: `基础算法受控执行:${pythonExecutable}`,
    permission: { approvalMode: 'per_task' as const, persistentGrant: false as const },
    note: '不自动授予持续 Python execute 权限；宿主按原任务走既有审批，提交时才请求本次授权。请在下一轮 DSH 集成任务中统一采用，不手改 machine.bindings。' };
}
