import { SkillError, SkillRegistry } from './registry.js';
import type { RoutedAction } from '../../contracts/skill-contracts.js';

/** 菜单或明确工具调用选择动作；普通聊天由上层继续交给 Pi。 */
export class DirectRouter {
  constructor(readonly registry: SkillRegistry) {}
  route(input: { action: string; args: unknown }): RoutedAction {
    const skill = this.registry.get(input.action);
    if (skill.runtimeId !== 'direct' || skill.kind !== 'direct') throw new SkillError('DIRECT_ACTION_REQUIRED', '此入口只执行明确的确定性动作。');
    return this.registry.route(input);
  }
}
