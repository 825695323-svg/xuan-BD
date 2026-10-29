import type { ApiSourceDefinition } from '../../manager.js';

/** 官方后台开发包的逻辑连接；不假定本机客户端HTTP服务已存在。 */
export const tdxSource: ApiSourceDefinition = Object.freeze({
  id: 'tdx', displayName: '通达信官方后台数据服务',
  apiBaseUrl: 'tdxaidata://data-service',
  applicationUrl: 'https://www.tdx.com.cn/',
  documentationUrl: 'https://help.tdx.com.cn/quant/docs/markdown/mindoc-1hjbgqpdhv114.html',
  credentialInstructions: '在通达信商城会员中心创建数据服务类型Key（密钥），通过本机安全凭据引用提供；客户端接口、其他产品密钥及旧机器验证不能替代本次核验。',
});
