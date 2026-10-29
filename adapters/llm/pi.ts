import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ConfigError } from '../../platform/runtime/errors.js';
import type { ThinkingConfiguration, ThinkingLevel } from '../../contracts/contracts.js';
import type { PiBackendConfig, PiCustomModelConfig } from '../../contracts/llm.js';

// 这些协议已核对供应方重试层。其他协议可能在一次Pi准备后自行重发请求。
const CONTROLLED_MODEL_APIS = new Set(['openai-completions', 'openai-responses', 'azure-openai-responses',
  'anthropic-messages', 'google-generative-ai']);
export function supportsControlledModelApi(api: string): boolean { return CONTROLLED_MODEL_APIS.has(api); }

/** 当前只为已核对的官方 Flash 模型开放四档；其他通道不能借用同名档位。 */
export function piThinkingConfiguration(config: PiBackendConfig): ThinkingConfiguration {
  let official = false;
  try {
    official = config.customModel?.api === 'openai-completions' && config.customModel.reasoning === true
      && new URL(config.customModel.baseUrl).origin === 'https://api.deepseek.com'
      && config.model === 'deepseek-flash';
  } catch { /* 无效地址由现有模型配置校验报告。 */ }
  const supportedLevels: readonly ThinkingLevel[] = official ? ['off', 'low', 'high', 'max'] : ['off'];
  const defaultLevel = config.defaultThinkingLevel ?? 'off';
  if (!supportedLevels.includes(defaultLevel)) throw new ConfigError('当前模型通道尚不支持所配置的默认思考档位。');
  return Object.freeze({ defaultLevel, supportedLevels: Object.freeze(supportedLevels) });
}

export async function createPiModelConnection(provider: string, modelId: string, apiKey: string, custom: PiCustomModelConfig | undefined, thinking: ThinkingConfiguration) {
        const credentials = new InMemoryCredentialStore();
        await credentials.modify(provider, async () => ({ type: 'api_key', key: apiKey }));
        const modelRuntime = await ModelRuntime.create({
          credentials,
          modelsPath: null,
          allowModelNetwork: false,
          refreshOnCreate: false,
        });
        if (custom) {
          modelRuntime.registerProvider(provider, {
            api: custom.api,
            baseUrl: custom.baseUrl,
            authHeader: true,
            models: [{
              id: modelId,
              name: custom.name,
              api: custom.api,
              baseUrl: custom.baseUrl,
              reasoning: custom.reasoning ?? false,
              ...(thinking.supportedLevels.includes('max') ? {
                thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
                compat: { thinkingFormat: 'deepseek' as const, supportsReasoningEffort: true,
                  requiresReasoningContentOnAssistantMessages: true },
              } : {}),
              input: [...custom.input],
              contextWindow: custom.contextWindow,
              maxTokens: custom.maxTokens,
              // Pi 必须有价格元数据；此处没有价格资料，也不据此限制请求。
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }],
          });
        }
        const modelProvider = modelRuntime.getProvider(provider);
        if (!modelProvider) throw new ConfigError(`Pi 内建服务表中没有此服务：${provider}。`);
        if (!modelProvider.auth.apiKey) {
          throw new ConfigError('此 Pi 服务只支持授权登录，本阶段需要支持访问密钥的服务。');
        }
        const model = modelRuntime.getModel(provider, modelId);
        if (!model) throw new ConfigError(`Pi 模型表中没有此模型：${provider}/${modelId}。`);
        if (model.api === 'pi-virtual') throw new ConfigError('本阶段需配置明确模型，不能启用隐式模型路由。');
        if (!CONTROLLED_MODEL_APIS.has(model.api)) throw new ConfigError('此模型协议尚未完成受控请求验证；请选择已支持的明确模型协议。');
  return { modelRuntime, model };
}
