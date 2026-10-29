import type { CoreDatabase } from '../platform/state/database.js';
import type { FileReferenceService } from '../platform/resources/files.js';
import type { PermissionService } from '../platform/security/permissions.js';
import type { TaskService } from '../platform/jobs/tasks.js';
import type { HarnessService } from '../modules/agent/service.js';
import type { FinancialService } from '../modules/financial/service.js';
import type { MaterialService } from '../modules/collection/materials/service.js';
import type { MaterialSemanticService } from '../modules/collection/materials/semantic.js';
import type { ProcessingPlanService } from '../modules/collection/processing-plan.js';
import type { ConversationUserCycleBinding } from '../modules/collection/conversation-data-cycle.js';
import type { JsonValue } from './task-contracts.js';
import type { AlgorithmCatalogView, AlgorithmTaskView } from '../modules/financial/algorithm-types.js';

/** Trusted companion services used by material and result handoff, independent of HTTP startup. */
import type { CandidateService } from '../modules/collection/candidate-service.js';

/**
 * 候选唯一接受的算法结果引用。只包含原算法任务与两个持久摘要，不携带 rows、参数或来源；
 * 读取器必须按原任务重新核对 `algorithm_calls.result_digest` 并重建对象字节。
 */
export interface AlgorithmResultReference {
  kind: 'algorithm-result';
  taskId: string;
  /** 原任务持久保管结果 `AlgorithmComputedResult` 的规范 JSON 摘要。 */
  resultDigest: string;
  /** 受信读取器把原结果转成 WFD 可用表示后得到的对象字节摘要。 */
  objectSha256: string;
  byteLength: number;
  mediaType: 'application/json';
}

/** 只读谱系：来自原持久结果，不来自候选客户端。 */
export interface AlgorithmResultLineage {
  taskId: string;
  resultDigest: string;
  objectSha256: string;
  methodId: string;
  methodVersion: string;
  implementationVersion: string;
  contractVersion: string;
  environment: string;
  parameters: JsonValue;
  inputDigest: string;
  source: JsonValue;
  rows: number;
  rowCount: number;
  validInterval: JsonValue;
  invalidIntervals: JsonValue;
  coverage: JsonValue;
  gaps: JsonValue;
  limitations: JsonValue;
  publication: JsonValue;
  representation: JsonValue;
}

export interface VerifiedAlgorithmResult {
  reference: AlgorithmResultReference;
  /** 由原持久结果确定性投影的规范 UTF-8 字节；不是调用方上传的内容。 */
  bytes: Buffer;
  lineage: AlgorithmResultLineage;
}

/** 候选服务只依赖此只读端口；算法服务实现它，构造时可使用惰性 getter。 */
export interface AlgorithmResultReader {
  readCandidateResult(reference: AlgorithmResultReference): VerifiedAlgorithmResult;
}

/** 受信算法桥准备候选时显式提供的 WFD 目标；不包含 rows 或结果摘要。 */
export interface AlgorithmCandidateBinding {
  outputId: string;
  namespace: string;
  productRef?: Record<string, unknown>;
  declaration?: Record<string, unknown>;
  expectedSnapshotId?: string | null;
}

export interface AlgorithmCandidateDraft {
  input: { outputs: Record<string, unknown>[] };
  reference: AlgorithmResultReference;
  lineage: AlgorithmResultLineage;
}

/** 会话代理可见的最小算法接口：发现、计算、查原结果和准备候选；没有采用或提交入口。 */
export interface AlgorithmConversationPort extends AlgorithmResultReader {
  readonly versionBinding: Record<string, string | null>;
  readonly runtime: { readonly id: string };
  catalog(): AlgorithmCatalogView;
  submit(requestId: string, call: unknown): AlgorithmTaskView;
  view(taskId: string): AlgorithmTaskView;
  prepareCandidate(taskId: string, binding: AlgorithmCandidateBinding): AlgorithmCandidateDraft;
}

export interface WorkspaceServices {
  core: { readonly healthy: boolean };
  database: CoreDatabase;
  files: FileReferenceService;
  permissions: PermissionService;
  tasks: TaskService;
  attachmentRoot: string;
  harness?: HarnessService;
  financial?: FinancialService;
  algorithms?: AlgorithmConversationPort;
  materials?: MaterialService;
  candidates?: CandidateService;
  semantics?: MaterialSemanticService;
  processing?: ProcessingPlanService;
  userCycle?: ConversationUserCycleBinding;
}
