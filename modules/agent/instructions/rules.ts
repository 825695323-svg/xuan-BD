import fs from 'node:fs';
import { CoreError } from '../../../platform/runtime/errors.js';
import { digestOperationArgs } from '../../../platform/security/permissions.js';
import type { FrozenRunConfiguration } from '../../../contracts/ui-contracts.js';

/** 只读取本代码根的产品规则，不扫描配置根、个人目录、施工指令或上传材料。 */
const AGENTS_FILE = new URL('./AGENTS.md', import.meta.url);

/** 与已审核正文绑定；规则改版同步更新版本与可信摘要。 */
export const INTERNAL_AGENT_RULES = Object.freeze({ id: 'xuan-bd-internal-agent', version: 19,
  digest: '38342f494b3a83fc5f0512c1fd42515a49877ea61f70e62c6ce3089b257ff45c' });
/** 旧任务携带的完整冻结规则仅按原版本/摘要验真，不能被新版 AGENTS 正文替换。 */
const FROZEN_PRIOR_AGENT_RULES = Object.freeze({ version: 18,
  digest: 'fb576a22f1942ea217a66180149c737f5388392e32112ec28589a592140d124c' });

export function captureInternalAgentRules(): Pick<FrozenRunConfiguration, 'internalAgentRules' | 'internalAgentRulesText'> {
  let body: string;
  try { body = fs.readFileSync(AGENTS_FILE, 'utf8'); }
  catch { throw new CoreError('RUN_CONFIGURATION_UNAVAILABLE', '产品 AGENTS.md 运行规则无法读取，不能建立新运行；请恢复已审核的规则文件。'); }
  const { id, version, digest } = INTERNAL_AGENT_RULES;
  if (digestOperationArgs({ id, version, body }) !== digest) {
    throw new CoreError('RUN_CONFIGURATION_UNAVAILABLE', '产品 AGENTS.md 运行规则与受信版本摘要不符，不能建立新运行；请核对已审核版本。');
  }
  return { internalAgentRules: { ...INTERNAL_AGENT_RULES }, internalAgentRulesText: body };
}

/** 旧记录仍可显示，但执行时不能把缺失或未知的规则快照替换成当前正文。 */
export function assertInternalAgentRules(configuration: FrozenRunConfiguration): void {
  const reference = configuration.internalAgentRules, body = configuration.internalAgentRulesText;
  const trusted = !!reference && (reference.version === INTERNAL_AGENT_RULES.version
    && reference.digest === INTERNAL_AGENT_RULES.digest || reference.version === FROZEN_PRIOR_AGENT_RULES.version
    && reference.digest === FROZEN_PRIOR_AGENT_RULES.digest);
  if (!reference || typeof body !== 'string' || reference.id !== INTERNAL_AGENT_RULES.id
    || !trusted || digestOperationArgs({ id: reference.id, version: reference.version, body }) !== reference.digest) {
    throw new CoreError('RUN_CONFIGURATION_UNAVAILABLE', '原任务的内置代理运行规则缺失、摘要不符或版本不可用，不能套用当前规则恢复；请核对后明确建立新任务。');
  }
}

export function internalAgentRulesContext(configuration: FrozenRunConfiguration): string {
  assertInternalAgentRules(configuration);
  return `本轮固定的内置代理运行规则：${JSON.stringify(configuration.internalAgentRules)}\n\n${configuration.internalAgentRulesText}`;
}
