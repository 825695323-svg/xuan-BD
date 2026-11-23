import type { ReportSubjectEvidence } from '../../contracts/source-settings.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { DirectError } from '../../platform/runtime/file-workspace.js';
import { sourceOperations } from './operations.js';
import { thsSource } from './providers/ths/api.js';
import { buildThsRequest, decodeThsResponse, projectThsFinancials } from './providers/ths/requests.js';
import { buildEastmoneyReportRequest, buildEastmoneyReportDetailRequest,
  decodeEastmoneyReports, decodeEastmoneyReportDetail } from './providers/eastmoney-reports/api.js';

export interface ApiReadProjection {
  projection: unknown | null;
  recordCount?: number;
  subjectId?: string;
  statement?: string;
  encodeUrl?: string;
  subject?: ReportSubjectEvidence;
  start?: string;
  end?: string;
  pagination?: { page: number; nextPage: number | null; continuation: string; total: number | null };
}
export interface ApiReadRequest {
  url: URL; method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string;
  requiresCredential: boolean;
  decode(bytes: Uint8Array, decodedText?: string): ApiReadProjection;
}

/** 只构造已登记的读取协议。网络、凭据、原件、失败回执继续由 source runtime 负责。 */
export function buildApiReadRequest(providerId: string, baseUrl: string, operation: string,
  parameters: Record<string, JsonValue>): ApiReadRequest {
  if (!sourceOperations(providerId).some(item => item.id === operation && item.run.action === 'source.api.read'))
    throw new DirectError('SOURCE_KIND_UNSUPPORTED', '此供应商没有登记所选接口读取动作。');
  if (providerId === 'ths') {
    const url = buildThsRequest(baseUrl, operation, parameters);
    return { url, method: 'GET', requiresCredential: true, decode(bytes, decodedText) {
      if (operation === 'financial_statements') {
        const projection = projectThsFinancials(parameters, bytes);
        return { projection, recordCount: projection.recordCount, subjectId: String(parameters.thscode), statement: String(parameters.statement) };
      }
      decodeThsResponse(decodedText ?? bytes);
      return { projection: null, subjectId: String(parameters.thscode) };
    } };
  }
  if (providerId === 'eastmoney' && baseUrl === 'https://push2his.eastmoney.com') {
    if (operation === 'research_reports') {
      const request = buildEastmoneyReportRequest(parameters);
      return { ...request, requiresCredential: false, decode(bytes) {
        const projection = decodeEastmoneyReports(request.request, bytes);
        return { projection, recordCount: projection.recordCount,
          subjectId: request.request.symbol ?? `reports:${request.request.category}`,
          subject: projection.subject, start: request.request.start, end: request.request.end,
          pagination: { page: projection.page, nextPage: projection.nextPage, continuation: projection.continuation, total: projection.total } };
      } };
    }
    const request = buildEastmoneyReportDetailRequest(parameters);
    return { ...request, requiresCredential: false,
      decode: bytes => ({ projection: decodeEastmoneyReportDetail(request.request, bytes),
        subjectId: `reports:${request.request.category}`, encodeUrl: request.request.encodeUrl }) };
  }
  throw new DirectError('SOURCE_KIND_UNSUPPORTED', '来源身份与固定服务地址不符。');
}

/** 参数校验不读取账号，也不试探未登记的供应商。 */
export function validateApiReadRequest(operation: string, parameters: Record<string, JsonValue>): void {
  const provider = operation === 'research_reports' || operation === 'research_report_detail' ? 'eastmoney' : 'ths';
  buildApiReadRequest(provider, provider === 'ths' ? thsSource.apiBaseUrl : 'https://push2his.eastmoney.com', operation, parameters);
}
