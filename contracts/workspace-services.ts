import type { CoreDatabase } from '../platform/state/database.js';
import type { FileReferenceService } from '../platform/resources/files.js';
import type { PermissionService } from '../platform/security/permissions.js';
import type { TaskService } from '../platform/jobs/tasks.js';
import type { BdService } from '../modules/agent/service.js';
import type { FinancialService } from '../modules/financial/service.js';
import type { MaterialService } from '../modules/collection/materials/service.js';
import type { MaterialSemanticService } from '../modules/collection/materials/semantic.js';
import type { ProcessingPlanService } from '../modules/collection/processing-plan.js';
import type { EndpointAdapterRegistry } from '../modules/collection/endpoint-adapter-registry.js';
import type { JsonValue } from './task-contracts.js';
import type { TaskRecord } from '../platform/jobs/tasks.js';
import type { R1CapabilitiesView, R1RequestView, R1ProductRead, R1ProductDiscovery, R1SnapshotStatus } from './r1-contracts.js';
import type { AlgorithmCatalogView, AlgorithmTaskView } from '../modules/financial/algorithm-types.js';
import type { UnifiedPolarsExecution } from '../modules/financial/unified-polars-execution.js';
import type { ProductionCalculation } from '../modules/collection/production-calculation.js';
import type { ProductionModuleId } from '../modules/collection/production-module-ports.js';

/** Trusted companion services used by material and result handoff, independent of HTTP startup. */
import type { CandidateService } from '../modules/collection/candidate-service.js';

/** 会话代理可见的最小算法接口：发现、计算和查原结果；没有采用或提交入口。 */
export interface AlgorithmConversationPort {
  readonly versionBinding: Record<string, string | null>;
  readonly runtime: { readonly id: string };
  catalog(): AlgorithmCatalogView;
  submit(requestId: string, call: unknown): AlgorithmTaskView;
  view(taskId: string): AlgorithmTaskView;
}

/** Host-selected personal R1 bridge port: no model submit and no global request listing. */
export interface R1ConversationPort {
  readonly versionBinding: Record<string, string | null>;
  capabilities(): R1CapabilitiesView;
  /** 只读查询当前已发布快照身份，后续查询必须固定此快照，不接收当前/最新的动态别名。 */
  snapshotStatus?(signal?: AbortSignal): Promise<R1SnapshotStatus>;
  /** 仅宿主实际装配时开放的 WFD 固定快照只读分页，非模型自报来源。 */
  readProduct?(input: unknown, signal?: AbortSignal): Promise<R1ProductRead>;
  /** 语义词典只读取实际 WFD 冻结快照的已发布产品声明，不推断或采用模板。 */
  discoverProducts?(input: unknown, signal?: AbortSignal): Promise<R1ProductDiscovery>;
  prepare(input: unknown): R1RequestView;
  prepareWithRestriction(input: unknown): Promise<R1RequestView>;
  get(requestId: string): R1RequestView;
  recover(requestId: string, lookupId: string): Promise<TaskRecord>;
  checkProfile(): Promise<unknown>;
}

export interface WorkspaceServices {
  core: { readonly healthy: boolean };
  database: CoreDatabase;
  files: FileReferenceService;
  permissions: PermissionService;
  tasks: TaskService;
  attachmentRoot: string;
  bd?: BdService;
  financial?: FinancialService;
  algorithms?: AlgorithmConversationPort;
  /** 相同 algorithms.calculate 公共动作内部的方法执行器，不增加第二套 AGENTS 工具目录。 */
  unifiedPolars?: UnifiedPolarsExecution;
  /** 服务侧唯一发布者，AGENTS 只能按原成功任务身份要求发布，不能传任意结构化行。 */
  derivedPublisher?: { publish(taskId: string, signal?: AbortSignal): Promise<{
    requestId: string; state: string; published: boolean; requiresRecovery: boolean;
    fixedReadback: boolean; error: unknown } > };
  materials?: MaterialService;
  candidates?: CandidateService;
  semantics?: MaterialSemanticService;
  /** 计算与清洗是并列入口，只复用生产核对及原 R1/WFD 发布服务。 */
  productionCalculation?: ProductionCalculation;
  /** Host-fixed independent module availability; model/HTTP requests cannot mutate it. */
  productionModuleSwitches?: Partial<Record<ProductionModuleId, boolean>>;
  processing?: ProcessingPlanService;
  /** 端点适配登记：会话受控工具只读取/提交/重放/审批后采用。 */
  endpointAdapters?: EndpointAdapterRegistry;
  r1Workspace?: R1ConversationPort;
}
