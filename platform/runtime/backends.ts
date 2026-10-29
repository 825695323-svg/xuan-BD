import type { Backend } from '../../contracts/backend.js';
import { ConfigError } from './errors.js';

/** 外部运行框架与 Pi 并列注册，禁止在 Pi 的模型调用内再嵌套一层循环。 */
export class BackendRegistry {
  private readonly entries = new Map<string, Backend>();
  register(backend: Backend): void {
    if (this.entries.has(backend.id)) throw new Error(`Duplicate backend: ${backend.id}`);
    this.entries.set(backend.id, backend);
  }
  get(id: string): Backend {
    const backend = this.entries.get(id);
    if (!backend) throw new ConfigError(`未注册运行后端：${id}`);
    return backend;
  }
}
