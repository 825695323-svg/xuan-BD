import { Router, type ErrorRequestHandler } from 'express';
import { CoreError } from '../../platform/runtime/errors.js';
import { PermissionError } from '../../platform/security/permissions.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { LocalAlgorithmService } from '../../modules/financial/algorithm-service.js';
import { ALGORITHM_CONTRACT_VERSION, ALGORITHM_RUNTIME, type AlgorithmCatalogView } from '../../modules/financial/algorithm-types.js';

export interface AlgorithmRouteServices { algorithms?: LocalAlgorithmService }

/**
 * 只由受信宿主挂载：`app.use('/api/ui/algorithms', createAlgorithmRouter({ algorithms }))`。
 * 本工厂不监听端口、不读绑定文件、不写权限；独立测试可以显式装配真实服务后直接挂载。
 */
export function createAlgorithmRouter(services: AlgorithmRouteServices) {
  const router = Router();
  const service = () => {
    if (!services.algorithms) throw new CoreError('ALGORITHM_SERVICE_UNAVAILABLE', '算法计算入口尚未装配；当前只保留只读目录。', 503);
    return services.algorithms;
  };
  router.get('/', (req, res) => {
    if (Object.keys(req.query).length) throw new CoreError('INVALID_ALGORITHM_QUERY', '算法目录不接受检索参数。', 400);
    res.json(services.algorithms ? services.algorithms.catalog() : unavailableCatalog('算法计算入口尚未装配；当前只保留只读目录。'));
  });
  router.get('/adoption', (req, res) => {
    if (Object.keys(req.query).length) throw new CoreError('INVALID_ALGORITHM_QUERY', '采用状态不接受检索参数。', 400);
    res.json(services.algorithms ? services.algorithms.adoptionStatus() : unavailableAdoption('算法计算入口尚未装配；不能记录采用。'));
  });
  router.post('/adoption', (req, res) => {
    const body = objectBody(req.body);
    if (Object.keys(body).some(key => !['expectedAssetsVersion', 'expectedCodeVersion', 'confirmation'].includes(key))
      || typeof body.expectedAssetsVersion !== 'string' || typeof body.expectedCodeVersion !== 'string' || typeof body.confirmation !== 'string') {
      throw new CoreError('INVALID_ALGORITHM_BODY', '受控采用只接受当前两个摘要与逐字确认短语。', 400);
    }
    res.status(201).json(service().adopt(body));
  });
  router.get('/calls', (_req, res) => res.json({ items: services.algorithms ? services.algorithms.list() : [] }));
  router.get('/calls/:taskId', (req, res) => {
    if (typeof req.params.taskId !== 'string' || !req.params.taskId) throw new CoreError('INVALID_ALGORITHM_TASK', '缺少任务编号。', 400);
    res.json(service().view(req.params.taskId));
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const code = error instanceof TaskError || error instanceof PermissionError || error instanceof CoreError ? error.code : 'ALGORITHM_ROUTE_FAILED';
    const message = error instanceof Error && error.message ? error.message : '算法入口未完成本次请求。';
    const status = error instanceof CoreError ? error.status
      : /REQUEST_CONFLICT|UNKNOWN_RESULT|TASK_BUSY|TASK_VERSION_CONFLICT|RESULT_MISSING|RESULT_CHANGED/.test(code) ? 409
      : /PERMISSION|APPROVAL|AUTH/.test(code) ? 403
      : /NOT_FOUND|TASK_NOT_FOUND/.test(code) ? 404
      : /ADOPTION.*(CONFIRMATION|MISMATCH|SCOPE)|INVALID|UNSUPPORTED|MISMATCH|CHANGED|MISSING|BUDGET|EMPTY|FREQUENCY|ADJUSTMENT|CALENDAR|SEQUENCE|TIME|UNIT|VALUE|DATE|MAPPING|PARSE|PRECISION|INCOMPLETE/.test(code) ? 400
      : /UNAVAILABLE|UNBOUND|NOT_ENABLED|NOT_CONFIGURED/.test(code) ? 503
      : 500;
    res.status(status).json({ error: message, code });
  };
  router.use(errors);
  return router;
}

function unavailableCatalog(reason: string): AlgorithmCatalogView {
  return { contractVersion: ALGORITHM_CONTRACT_VERSION, runtime: ALGORITHM_RUNTIME, environment: 'local-review',
    status: 'unavailable', enabled: false, reason,
    implementation: { version: '', files: {}, codeVersion: '', codeFiles: {}, binding: 'source-code', bindingRequired: false },
    execution: { pythonDigest: null, permission: 'unavailable', reason },
    adoption: unavailableAdoption(reason),
    methods: [], inputs: { managedTables: { status: 'unavailable', reason, items: [] },
      fixedSnapshots: { status: 'unavailable', reason, contract: { contract: 'wfd.data-service/v1', protocolVersion: 3,
        operation: 'data.read', referenceShape: '固定实例/产品/快照/定义/字段/分页' } } },
    limitations: ['没有装配算法服务时不提供计算入口，也不读取旧测试快照或自动采用。'] };
}
function unavailableAdoption(reason: string) {
  return { state: 'not_adopted' as const, reason,
    current: { environment: 'local-review' as const, assetsVersion: '', codeVersion: '', pythonDigest: '' },
    record: null, required: { environment: 'local-review' as const, expectedAssetsVersion: '', expectedCodeVersion: '',
      confirmation: 'adopt-local-review' as const } };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function objectBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CoreError('INVALID_ALGORITHM_BODY', '请求正文须为 JSON 对象。', 400);
  return value;
}
