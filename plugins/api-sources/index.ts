import { thsSource } from './providers/ths/api.js';
import { checkApiSourceReadiness, type ApiSourceCredentialBinding, type ApiSourceReadiness, type ApiSourceReadinessOptions } from './manager.js';

export { checkApiSourceReadiness } from './manager.js';
export type { ApiSourceDefinition, ApiSourceCredentialBinding, ApiSourceReadiness, ApiSourceReadinessOptions } from './manager.js';

export type ApiSourceRole = 'primary' | 'backup';
/** 宿主显式列出主备角色与供应商；目录复制不会自动注册、授权或执行。 */
export const apiSourceRegistrations = Object.freeze([
  Object.freeze({ role: 'primary' as const, source: thsSource }),
]);
export const apiSources = Object.freeze(apiSourceRegistrations.map(item => item.source));

/** 新机器按自己的应用身份检查；未提供本机绑定时返回申请/提供密钥提醒。 */
export async function apiSourceSetupReminders(
  runtimeIdentity: string,
  options: { bindings?: readonly ApiSourceCredentialBinding[]; verifyCredential?: ApiSourceReadinessOptions['verifyCredential'] } = {},
): Promise<Array<ApiSourceReadiness & { role: ApiSourceRole }>> {
  const bindings = options.bindings ?? [];
  if (new Set(bindings.map(binding => binding.sourceId)).size !== bindings.length
    || bindings.some(binding => !apiSources.some(source => source.id === binding.sourceId))) {
    throw new Error('接口源凭据绑定重复或没有对应的受信供应商。');
  }
  return Promise.all(apiSourceRegistrations.map(async ({ role, source }) => ({
    ...await checkApiSourceReadiness(source, {
      runtimeIdentity, binding: bindings.find(binding => binding.sourceId === source.id), verifyCredential: options.verifyCredential,
    }), role,
  })));
}
