import { Router } from 'express';
import { LocalDataLifecycle, type LocalDataLifecycleRecord } from '../../platform/runtime/local-data-lifecycle.js';
import { CoreError } from '../../platform/runtime/errors.js';

/**
 * 单份本地资料停用/解绑的本机管理接口。
 *
 * 本文件只定义可信本机管理入口的请求与读回结构；不创建 token、账号或前端授权。
 * 宿主必须把它挂在既有的本机来源/客户端检查之后，并且只在控制器实例存在时挂载。
 * 客户端只能请求核对；核对结论、证据和待核任务由宿主重新查询后写入，不能由客户端提供。
 */
export const LOCAL_DATA_LIFECYCLE_ROUTE_SCHEMA = {
  base: '/api/harness/local-data',
  taskBinding: 'task.args.localDataId -> 宿主单一 runtimeIdentity（不接受客户端自报）',
  read: [
    { method: 'GET', path: '/current', response: '{ dataId, record }' },
    { method: 'GET', path: '/', response: 'LocalDataLifecycleRecord[]' },
    { method: 'GET', path: '/operations/:operationId', response: 'LocalDataOperation | null' },
    { method: 'GET', path: '/:dataId', response: 'LocalDataLifecycleRecord' },
  ],
  commands: [
    { method: 'POST', path: '/deactivate', body: ['dataId', 'operationId', 'expectedGeneration', 'reason'] },
    { method: 'POST', path: '/unbind', body: ['dataId', 'operationId', 'expectedGeneration', 'reason'] },
    { method: 'POST', path: '/resume', body: ['dataId', 'operationId', 'expectedGeneration', 'reason'] },
    { method: 'POST', path: '/stop', body: ['dataId', 'operationId'] },
    { method: 'POST', path: '/reconcile', body: ['dataId', 'operationId'], note: '仅请求宿主重新核对；不接受 outcome/evidence/pendingTaskIds。' },
    { method: 'POST', path: '/reload', body: ['dataId', 'operationId', 'expectedGeneration', 'reason'], note: '只保存待重启加载；本进程不打开个人资料。' },
  ],
} as const;

export interface LocalDataLifecycleRouterOptions {
  lifecycle?: LocalDataLifecycle;
  /** 受信启动器解析出的当前唯一本地资料身份；客户端不能指定。 */
  dataId?: string;
  /** 宿主重新查询任务/进程/浏览器/凭据的真实证据后写入控制记录。 */
  verify?: (input: { dataId: string; operationId: string }) => Promise<LocalDataLifecycleRecord>;
  /** 最小无个人内容宿主返回不可用原因；普通宿主缺省为可用。 */
  qualification?: () => { available: boolean; detail: string | null };
  /** 重新加载前核对同一原资料身份；返回原因即拒绝。 */
  assertReload?: (input: { dataId: string; expectedGeneration: number }) => void;
  /** 控制记录变化后立即关闭私有事件流并阻止迟到响应。 */
  onChanged?: () => void;
}

export function createLocalDataLifecycleRouter(options?: LocalDataLifecycleRouterOptions | LocalDataLifecycle): Router {
  const normalized: LocalDataLifecycleRouterOptions = options && 'list' in options && typeof options.list === 'function'
    ? { lifecycle: options as LocalDataLifecycle } : (options ?? {}) as LocalDataLifecycleRouterOptions;
  const { lifecycle, dataId: currentDataId, verify, qualification, assertReload, onChanged } = normalized;
  const router = Router();
  const requireService = (): LocalDataLifecycle => {
    if (!lifecycle) throw new CoreError('LOCAL_DATA_LIFECYCLE_NOT_WIRED', '本地资料控制尚未接入真实宿主；当前不能执行停用或解绑。', 503);
    return lifecycle;
  };

  router.get('/current', (_req, res) => {
    const controller = requireService();
    if (!currentDataId) throw new CoreError('LOCAL_DATA_IDENTITY_UNAVAILABLE', '宿主尚未解析当前本地资料身份。', 503);
    const grade = qualification?.() ?? { available: true, detail: null };
    try {
      res.json({ dataId: currentDataId, record: controller.status(currentDataId), available: grade.available, detail: grade.detail });
    } catch (error) {
      if (error instanceof CoreError && error.code === 'LOCAL_DATA_UNKNOWN') {
        res.json({ dataId: currentDataId, record: null, available: false, detail: grade.detail ?? '当前身份没有控制记录，不能自动重建。' }); return;
      }
      throw error;
    }
  });
  router.get('/', (_req, res) => {
    res.json({ records: requireService().list() });
  });
  router.get('/operations/:operationId', (req, res) => {
    const operation = requireService().operation(id(req.params.operationId, '操作标识'));
    if (!operation) throw new CoreError('OPERATION_NOT_FOUND', '没有找到此控制操作。', 404);
    res.json({ operation });
  });
  router.get('/:dataId', (req, res) => {
    res.json({ record: requireService().status(id(req.params.dataId, '本地资料标识')) });
  });
  router.post('/deactivate', async (req, res) => {
    const body = object(req.body, ['dataId', 'operationId', 'expectedGeneration', 'reason']);
    const record = await requireService().deactivate({ dataId: id(body.dataId, '本地资料标识'), operationId: id(body.operationId, '操作标识'),
      expectedGeneration: generation(body.expectedGeneration), reason: reason(body.reason) });
    onChanged?.();
    res.json({ record });
  });
  router.post('/unbind', (req, res) => {
    const body = object(req.body, ['dataId', 'operationId', 'expectedGeneration', 'reason']);
    const record = requireService().unbind({ dataId: id(body.dataId, '本地资料标识'), operationId: id(body.operationId, '操作标识'),
      expectedGeneration: generation(body.expectedGeneration), reason: reason(body.reason) });
    onChanged?.();
    res.json({ record });
  });
  router.post('/resume', async (req, res) => {
    const body = object(req.body, ['dataId', 'operationId', 'expectedGeneration', 'reason']);
    const record = await requireService().resume({ dataId: id(body.dataId, '本地资料标识'), operationId: id(body.operationId, '操作标识'),
      expectedGeneration: generation(body.expectedGeneration), reason: reason(body.reason) });
    onChanged?.();
    res.json({ record });
  });
  router.post('/stop', (req, res) => {
    const body = object(req.body, ['dataId', 'operationId']);
    const record = requireService().stop({ dataId: id(body.dataId, '本地资料标识'), operationId: id(body.operationId, '操作标识') });
    onChanged?.();
    res.json({ record });
  });
  router.post('/reconcile', async (req, res) => {
    const body = object(req.body, ['dataId', 'operationId']);
    if (!verify) throw new CoreError('LOCAL_DATA_VERIFY_NOT_WIRED', '当前宿主不能重新核对停用证据。', 503);
    const target = id(body.dataId, '本地资料标识');
    const record = await verify({ dataId: target, operationId: id(body.operationId, '操作标识') });
    onChanged?.();
    res.json({ record });
  });
  router.post('/reload', (req, res) => {
    const body = object(req.body, ['dataId', 'operationId', 'expectedGeneration', 'reason']);
    const target = id(body.dataId, '本地资料标识'), expectedGeneration = generation(body.expectedGeneration);
    assertReload?.({ dataId: target, expectedGeneration });
    const record = requireService().requestReload({ dataId: target, operationId: id(body.operationId, '操作标识'),
      expectedGeneration, reason: reason(body.reason) });
    onChanged?.();
    res.json({ record });
  });
  return router;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new CoreError('INVALID_LOCAL_DATA_REQUEST', '本地资料控制只接受明确字段。', 400);
  }
  return value as Record<string, unknown>;
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/u.test(value)) throw new CoreError('INVALID_LOCAL_DATA_REQUEST', `${label}无效。`, 400);
  return value;
}

function generation(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new CoreError('INVALID_LOCAL_DATA_REQUEST', '请先读取当前控制代次。', 400);
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new CoreError('INVALID_LOCAL_DATA_REQUEST', '操作原因需要 1 到 4,000 个字符。', 400);
  return value.trim();
}
