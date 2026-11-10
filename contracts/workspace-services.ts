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
import type { R1CapabilitiesView, R1RequestView } from './r1-contracts.js';
import type { AlgorithmCatalogView, AlgorithmTaskView } from '../modules/financial/algorithm-types.js';

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
  materials?: MaterialService;
  candidates?: CandidateService;
  semantics?: MaterialSemanticService;
  processing?: ProcessingPlanService;
  /** 端点适配登记：会话受控工具只读取/提交/重放/审批后采用。 */
  endpointAdapters?: EndpointAdapterRegistry;
  r1Workspace?: R1ConversationPort;
}
