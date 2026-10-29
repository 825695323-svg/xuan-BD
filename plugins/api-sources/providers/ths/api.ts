import type { ApiSourceDefinition } from '../../manager.js';

/** 本供应商的接入身份与申请入口；只含公开元数据，不含个人密钥或授权结论。 */
export const thsSource: ApiSourceDefinition = Object.freeze({
  id: 'ths',
  displayName: '同花顺金融数据',
  apiBaseUrl: 'https://fuyao.aicubes.cn',
  applicationUrl: 'https://fuyao.aicubes.cn/admin/',
  documentationUrl: 'https://fuyao.aicubes.cn/docs/quickstart/',
  credentialInstructions: '已有 API 密钥时提供本机凭据引用；尚未申请时，在申请页登录并创建 API Key（接口密钥）。换电脑须重新核对本机凭据，旧机器的已配置状态不能代替本机核验。',
});

/** 对应 API（接口）的公开约定；接口执行及逐端点授权须另经明确装配。 */
export const thsApi = Object.freeze({
  baseUrl: thsSource.apiBaseUrl,
  authentication: Object.freeze({ kind: 'api-key', header: 'X-api-key' }),
  referenceUrl: 'https://fuyao.aicubes.cn/docs/api-reference/overview/',
  fullDocumentationUrl: 'https://fuyao.aicubes.cn/llms-full.txt',
  successCode: 0,
  unauthenticatedCode: 2001,
  permissionDeniedCode: 2003,
  rateLimitedCode: 4001,
  automaticRetry: false,
});
