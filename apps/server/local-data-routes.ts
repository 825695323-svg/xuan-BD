import { Router } from 'express';
import { LocalDataLifecycle, type LocalDataLifecycleRecord } from '../../platform/runtime/local-data-lifecycle.js';
import { CoreError } from '../../platform/runtime/errors.js';

/**
 * 本地资料身份与代次的只读本机管理接口。
 *
 * 人工停用、解绑、重新采用与重新加载业务已取消；本路由不提供任何改变采用关系的命令。
 * 宿主必须把它挂在既有的本机来源/客户端检查之后，并且只在控制器实例存在时挂载。
 */
export const LOCAL_DATA_LIFECYCLE_ROUTE_SCHEMA = {
  base: '/api/bd/local-data',
  read: [
    { method: 'GET', path: '/current', response: '{ dataId, record, available, detail }' },
    { method: 'GET', path: '/', response: 'LocalDataLifecycleRecord[]' },
    { method: 'GET', path: '/:dataId', response: 'LocalDataLifecycleRecord' },
  ],
} as const;

export interface LocalDataLifecycleRouterOptions {
  lifecycle?: LocalDataLifecycle;
  /** 受信启动器解析出的当前唯一本地资料身份；客户端不能指定。 */
  dataId?: string;
  /** 最小无个人内容宿主返回不可用原因；普通宿主缺省为可用。 */
  qualification?: () => { available: boolean; detail: string | null };
}

export function createLocalDataLifecycleRouter(options?: LocalDataLifecycleRouterOptions | LocalDataLifecycle): Router {
  const normalized: LocalDataLifecycleRouterOptions = options && 'list' in options && typeof options.list === 'function'
    ? { lifecycle: options as LocalDataLifecycle } : (options ?? {}) as LocalDataLifecycleRouterOptions;
  const { lifecycle, dataId: currentDataId, qualification } = normalized;
  const router = Router();
  const requireService = (): LocalDataLifecycle => {
    if (!lifecycle) throw new CoreError('LOCAL_DATA_LIFECYCLE_NOT_WIRED', '本地资料控制尚未接入真实宿主。', 503);
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
  router.get('/:dataId', (req, res) => {
    res.json({ record: requireService().status(id(req.params.dataId, '本地资料标识')) });
  });
  return router;
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/u.test(value)) throw new CoreError('INVALID_LOCAL_DATA_REQUEST', `${label}无效。`, 400);
  return value;
}
