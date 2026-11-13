import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import iconv from 'iconv-lite';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import type { SourceCheck, SourceConnection, SourceOperationId } from '../../contracts/source-settings.js';
import type { SourceSettingsService } from '../../platform/config/source-settings.js';
import { readDshCredential, readKeychainCredential } from '../../platform/config/model.js';
import type { ProcessRuntime } from '../../platform/runtime/programs.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { acquireAuthority, DirectError, DirectWorkspace, directoryCapability, prepareDestination, type DirectAuthority } from '../../platform/runtime/file-workspace.js';
import { pinnedGet, resolvePublic, validatePublicWebUrl, assertPublicWebAddress } from '../../platform/capabilities/browser/public-web.js';
import { eastmoneyMinuteRequest } from '../capture-sources/eastmoney/minute.js';
import { readTdxMinutes, tdxAvailability, tdxVersions, type TdxPackageBinding } from './providers/tdx/runtime.js';
import { decodePublicDailyBars, normalizePublicDailyRequest, publicKlineProvider, publicKlineProviders, type PublicDailyProviderId, type PublicKlineOperationId } from './public-kline.js';
import { cacheUrl, parseWerssFeed, readWerssCache, WERSS_CACHE_LIMIT, WERSS_PROJECTION_VERSION } from './providers/werss/cache.js';
import { runWechatScript, wechatArticleUrl } from './providers/wechat/script.js';

const MAX = 2 * 1024 * 1024;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): v is Record<string, JsonValue> => !!v && typeof v === 'object' && !Array.isArray(v);
const officialHost = (hostname: string) => ['sse.com.cn', 'szse.cn', 'cninfo.com.cn', 'csindex.com.cn'].some(host => hostname === host || hostname.endsWith('.' + host));
interface SourceBytes { url: string; status: number; bytes: Buffer; contentType: string; observedAt: string }
const accountLanes = new Map<string, Promise<void>>();
const accountLastCall = new Map<string, number>();
export const SOURCE_ACTIONS = ['source.fetch', 'source.api.read', 'source.kline.read', 'source.werss.read', 'source.wechat.extract'] as const;

export interface SourceRuntimeOptions { settings: SourceSettingsService; files: FileReferenceService; artifactRoot: string; processRuntime?: ProcessRuntime; tdxaidataPackage?: TdxPackageBinding }
export function sourceParameters(args: Record<string, JsonValue>): Record<string, JsonValue> {
  let value: unknown; try { value = JSON.parse(String(args.parameters ?? '{}')); } catch { throw new DirectError('SOURCE_PARAMETERS_INVALID', '来源参数需要明确JSON对象。'); }
  if (!object(value)) throw new DirectError('SOURCE_PARAMETERS_INVALID', '来源参数需要明确JSON对象。');
  return value;
}
export function assertSourceCheckCurrent(settings: Pick<SourceSettingsService, 'get' | 'checkIdentity'>, connectionId: string, expectedDigest: string): void {
  if (settings.checkIdentity(connectionId) !== expectedDigest) throw new DirectError('SOURCE_CONFIGURATION_CHANGED', '此连接的相关配置已变化，本次检查已停止；请按新配置重新检查。');
  const now = settings.get(), connection = now.connections.find(item => item.id === connectionId);
  if (!connection?.enabled || !now.plugins.find(item => item.id === connection.pluginId)?.enabled) throw new DirectError('SOURCE_DISABLED', '来源插件或连接已停用。');
}
/** 同一任务不把同一账号的另一个别名当作新的重试资格。 */
export function claimSourceAccountAttempt(attempted: Set<string>, accountId: string): boolean {
  if (attempted.has(accountId)) return false;
  attempted.add(accountId); return true;
}

/** 来源原件下载共用原TaskService任务。 */
export function createSourceRuntime(options: SourceRuntimeOptions) {
  const { settings } = options;
  const downloadBoundary = ['只下载原件并保存来源定位、覆盖范围和回执；不自动附加清洗、转录、OCR（文字识别）、入库或持续计划，不以数据库目标已建立为前提',
    '供应商限额以官方资料为准；未公开的数值保持未知，不探测并发上限'];
  // 串行是本机默认策略，不宣称供应商额度；同一账号的多个连接共享此闸门。
  async function serial<T>(connection: SourceConnection, operation: () => Promise<T>): Promise<T> {
    const key = settings.accountId(connection), previous = accountLanes.get(key) ?? Promise.resolve();
    let release!: () => void; const current = new Promise<void>(resolve => { release = resolve; }); accountLanes.set(key, current);
    await previous.catch(() => {});
    try {
      const interval = settings.get().execution.minimumIntervalMs, delay = interval - (Date.now() - (accountLastCall.get(key) ?? 0));
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      accountLastCall.set(key, Date.now());
      settings.recordAttempt(connection);
      return await operation();
    } finally { release(); if (accountLanes.get(key) === current) accountLanes.delete(key); }
  }
  async function readWerss(context: TaskExecutionContext, args: Record<string, JsonValue>): Promise<TaskResult> {
    const connectionId = String(args.connectionId), feedId = String(args.feedId), limit = Number(args.limit), offset = Number(args.offset);
    const connection = settings.assertWerssConnectionEnabled(connectionId, feedId), expectedDigest = settings.checkIdentity(connectionId);
    const url = cacheUrl(connection.baseUrl, feedId, limit, offset);
    const assertCurrent = () => {
      context.signal.throwIfAborted();
      if (settings.checkIdentity(connectionId) !== expectedDigest) throw new DirectError('SOURCE_CONFIGURATION_CHANGED', 'WeRSS 连接或启停配置已变化，本次读取已停止。');
      settings.assertWerssConnectionEnabled(connectionId, feedId);
    };
    assertCurrent();
    const stage = await acquireAuthority(context, 'source.werss.read.stage', { connectionId, feedId, limit, offset },
      ['read', 'write', 'delete'].map(action => directoryCapability(action as 'read' | 'write' | 'delete', options.artifactRoot)));
    const workspace = new DirectWorkspace(context, options.files, options.artifactRoot, stage), prefix = `werss-${context.task.id}-${randomUUID()}`;
    const artifactIds: string[] = [];
    const publish = async (name: string, bytes: Uint8Array | string) => {
      assertCurrent();
      const staged = typeof bytes === 'string' ? await workspace.createText(name, bytes) : await workspace.createBytes(name, bytes);
      const reference = await workspace.publishFile(staged, prepareDestination(join(options.artifactRoot, `${prefix}-${name}`)),
        'source.werss.read', { connectionId, feedId, limit, offset }, WERSS_CACHE_LIMIT);
      artifactIds.push(reference.id); return reference;
    };
    try {
      await workspace.create();
      const network = await acquireAuthority(context, 'source.werss.read.cache', { connectionId, origin: url.origin },
        [{ action: 'network', target: { kind: 'network', origin: url.origin } }]);
      network.assert(); assertCurrent();
      const response = await serial(connection, async () => {
        network.assert(); assertCurrent();
        return readWerssCache(url, context.signal, () => { network.assert(); assertCurrent(); });
      });
      network.assert(); assertCurrent();
      const bytes = response.bytes, raw = await publish('raw.json', bytes), rawSha256 = hash(bytes);
      const observedAt = response.observedAt, contentType = response.contentType;
      const responseEvidence = { schemaVersion: 1, source: 'werss-local-cache', connectionId, feedId, limit, offset,
        requestURL: url.href, observedAt, httpStatus: response.status, contentType, contentEncoding: response.contentEncoding,
        rawRef: raw.id, rawRefVersion: raw.version, rawSha256, rawBytes: bytes.byteLength,
        cacheFreshness: 'unknown', historyCoverage: 'unknown', articleCompleteness: 'unknown', license: 'unknown',
        providerTimeMapping: 'WeRSS item.updated is derived from its DB publish_time with UTC+8 datetime formatting; original string is retained.' };
      if (response.status !== 200 || response.contentEncoding && response.contentEncoding.toLowerCase() !== 'identity'
        || !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|\s*$)/iu.test(contentType)) {
        await publish('receipt.json', JSON.stringify({ ...responseEvidence, status: 'rejected', reason: response.status === 429 ? 'rate_limited'
          : response.status >= 300 && response.status < 400 ? 'redirect_not_followed' : response.status === 401 || response.status === 403 ? 'authorization_failed'
            : response.contentEncoding && response.contentEncoding.toLowerCase() !== 'identity' ? 'compressed_response_not_decoded'
              : 'http_or_content_type_invalid' }) + '\n');
        throw new DirectError(response.status === 429 ? 'SOURCE_RATE_LIMITED' : 'WERSS_RESPONSE_REJECTED',
          'WeRSS 本地缓存端点未返回可接收的 JSON；原响应和失败回执已保留，未重试或跟随跳转。');
      }
      let parsed: ReturnType<typeof parseWerssFeed>;
      try { parsed = parseWerssFeed(bytes, feedId, limit); }
      catch (error) {
        await publish('receipt.json', JSON.stringify({ ...responseEvidence, status: 'rejected',
          reason: error instanceof DirectError ? error.code : 'response_invalid' }) + '\n');
        throw error;
      }
      const articles: Array<{ id: string; index: number; title: string; updatedRaw: string; htmlRef: string; htmlRefVersion: number;
        htmlSha256: string; textRef: string; textRefVersion: number; textSha256: string; contentJsonPath: string;
        reasons: string[]; locations: Array<{ selector: string; textNode: number; start: number; end: number }> }> = [];
      for (const article of parsed.articles) {
        const html = await publish(`${article.index + 1}-content.html`, article.html);
        const body = await publish(`${article.index + 1}-visible.txt`, article.text);
        articles.push({ id: article.id, index: article.index, title: article.title, updatedRaw: article.updated,
          htmlRef: html.id, htmlRefVersion: html.version, htmlSha256: hash(article.html),
          textRef: body.id, textRefVersion: body.version, textSha256: hash(article.text),
          contentJsonPath: `$.items[${article.index}].content`, reasons: article.reasons, locations: article.locations });
      }
      const table = parsed.articles.length ? await publish('derived-article-table.json', parsed.articleTable) : null;
      const locatorText = JSON.stringify({ ...responseEvidence, status: parsed.articles.length ? 'received_page' : 'received_empty',
        projectionVersion: WERSS_PROJECTION_VERSION, articleTableRef: table?.id ?? null, articleTableRefVersion: table?.version ?? null,
        articleTableSha256: table ? parsed.articleTableSha256 : null, articles }) + '\n';
      if (Buffer.byteLength(locatorText) > WERSS_CACHE_LIMIT) throw new DirectError('WERSS_LOCATOR_BUDGET', 'WeRSS 定位回执超出预算，原响应已保留，未截断成成功结果。');
      const locator = await publish('locator.json', locatorText), locatorSha256 = hash(locatorText);
      const receiptText = JSON.stringify({ ...responseEvidence,
        status: parsed.articles.length ? 'received_page' : 'received_empty', locatorRef: locator.id, locatorRefVersion: locator.version,
        locatorSha256, projectionVersion: WERSS_PROJECTION_VERSION, articleCount: articles.length }) + '\n';
      const receipt = await publish('receipt.json', receiptText), receiptSha256 = hash(receiptText);
      await workspace.cleanup();
      const data = { ...responseEvidence, status: parsed.articles.length ? 'received_page' : 'received_empty',
        projectionVersion: WERSS_PROJECTION_VERSION,
        articleCount: articles.length, articleTableRef: table?.id ?? null, articleTableRefVersion: table?.version ?? null,
        articleTableSha256: table ? parsed.articleTableSha256 : null, locatorRef: locator.id, locatorRefVersion: locator.version,
        locatorSha256, receiptRef: receipt.id, receiptRefVersion: receipt.version, receiptSha256,
        articles: articles.map(item => ({ id: item.id, index: item.index, title: item.title.slice(0, 160),
          titleTruncated: item.title.length > 160, updatedRaw: item.updatedRaw.slice(0, 200),
          updatedRawTruncated: item.updatedRaw.length > 200,
          textRef: item.textRef, textRefVersion: item.textRefVersion, textSha256: item.textSha256,
          htmlRef: item.htmlRef, htmlRefVersion: item.htmlRefVersion, htmlSha256: item.htmlSha256 })),
        contentIsUntrustedReference: true, modelCalls: 0, readOnly: true, sourceModified: false,
        guidance: '仅取得单页本机 WeRSS 缓存响应。description 是摘要，textRef 是结构抽取可见文字，articleTableRef 是原值投影；文章完整性、许可、缓存新鲜度和历史覆盖未知。后续材料保管及五步处理须另行执行。' };
      return { summary: parsed.articles.length ? `已保留 ${articles.length} 篇 WeRSS 缓存文章的原件、可见文字与原值投影。`
        : 'WeRSS 缓存页为空；已保留原响应与回执，没有生成文章正文。', artifactIds,
        data: { ...data, modelPreview: data } as unknown as JsonValue };
    } catch (error) {
      try { await workspace.cleanup(); } catch { await workspace.recordRetained(); throw new DirectError('WERSS_STAGE_CLEANUP_FAILED', 'WeRSS 暂存清理结果未知，请按原任务检查。', true); }
      await workspace.recordRetained(); throw error;
    }
  }
  const registrations: SkillRegistration[] = [
    { action: 'source.fetch', runtimeId: 'direct', kind: 'direct', modelCalls: 0, title: '下载来源原件',
      description: '从明确选择的来源下载原始响应及页面直接列出的PDF附件，保存原件与来源回执。',
      fields: [{ key: 'sourceId', label: '来源插件', type: 'select', required: true, options: [{ value: 'tdx', label: '通达信' }, { value: 'eastmoney', label: '东方财富' }, { value: 'official_web', label: '官方网页' }] },
        { key: 'scopeId', label: '国家市场范围', type: 'text', required: true, maxLength: 100 }, { key: 'parameters', label: '下载参数JSON', type: 'text', required: true, maxLength: 16_000 }],
      permissionSummary: [...downloadBoundary, '只读明确来源，保存本任务原件和回执', '使用原账号、权限与任务停止机制', '不隐式建立订阅，不使用配置之外的账号'],
      available: () => ({ available: true }), validate: args => validateFetchArgs(args) },
    { action: 'source.api.read', runtimeId: 'direct', kind: 'direct', modelCalls: 0, title: '读取已配置接口源',
      description: '按已配置组合下载同花顺公开GET端点的原始响应。',
      fields: [{ key: 'scopeId', label: '国家市场范围', type: 'text', required: true, maxLength: 100 },
        { key: 'operation', label: '公开接口动作', type: 'select', required: true, options: [{ value: 'index_constituents', label: '当前指数成分' }, { value: 'daily_bars', label: '日线行情' }] },
        { key: 'parameters', label: '明确接口参数JSON', type: 'text', required: true, maxLength: 16_000 }],
      permissionSummary: [...downloadBoundary, '只解析原连接的安全凭据引用', '按已配置顺序选择，未配置账号不调用', '同一账号串行读取，额度与时效未知保持未知'],
      available: () => ({ available: settings.get().plugins.some(item => item.id === 'ths' && item.enabled), reason: '接口源插件已停用。' }),
      validate: args => { thsUrl('https://fuyao.aicubes.cn', String(args.operation), sourceParameters(args)); } },
    { action: 'source.kline.read', runtimeId: 'direct', kind: 'direct', modelCalls: 0, title: '读取公开K线',
      description: '按当前接口类型的来源编排，从公开行情接口读取分钟或日线原始响应。',
      fields: [{ key: 'scopeId', label: '国家市场范围', type: 'text', required: true, maxLength: 100 },
        { key: 'operation', label: 'K线类型', type: 'select', required: true, options: [{ value: 'minute_bars', label: '分钟K线' }, { value: 'daily_bars', label: '日线行情' }] },
        { key: 'parameters', label: 'K线参数JSON', type: 'text', required: true, maxLength: 16_000 }],
      permissionSummary: [...downloadBoundary, '只读取已启用的公开行情接口并保存原始响应', '按接口类型的主备顺序选择，未入选连接不调用', '同一账号串行读取，额度和时效未知保持未知'],
      available: () => {
        const value = settings.get();
        const available = value.connections.some(connection => !!publicKlineProvider(connection.pluginId) && connection.enabled
          && !!value.plugins.find(plugin => plugin.id === connection.pluginId)?.enabled);
        return { available, reason: '没有已启用的公开K线来源。' };
      },
      validate: args => validateKlineArgs(args) },
    { action: 'source.werss.read', runtimeId: 'direct', kind: 'direct', modelCalls: 0, title: '读取 WeRSS 本地缓存 feed',
      description: '按下方已登记连接和 feed 的明确组合读取一页本机缓存；不读取订阅清单或任意 URL。',
      fields: [{ key: 'connectionId', label: '已登记本地连接', type: 'select', required: true, options: [] },
        { key: 'feedId', label: '已登记 WeRSS feed', type: 'select', required: true, options: [] },
        { key: 'limit', label: '本页条数', type: 'number', required: true, minimum: 1, maximum: 20 },
        { key: 'offset', label: '本页偏移', type: 'number', required: true, minimum: 0, maximum: 1_000_000 }],
      fieldsForRequest: () => {
        const current = settings.get(), enabled = current.plugins.some(plugin => plugin.id === 'werss' && plugin.enabled);
        const connections = enabled ? current.connections.filter(item => item.pluginId === 'werss' && item.enabled) : [];
        const feedOptions = new Map<string, string[]>();
        for (const connection of connections) for (const feedId of connection.feedIds ?? []) {
          feedOptions.set(feedId, [...(feedOptions.get(feedId) ?? []), connection.id]);
        }
        return [{ key: 'connectionId', label: '已登记本地连接', type: 'select', required: true,
          options: connections.map(item => ({ value: item.id, label: `${item.alias} (${item.id})` })) },
        { key: 'feedId', label: '已登记 WeRSS feed（标签列出所属连接）', type: 'select', required: true,
          options: [...feedOptions].map(([feedId, ids]) => ({ value: feedId,
            label: connections.length === 1 ? feedId : `${feedId} · ${ids.join(', ')}` })) },
        { key: 'limit', label: '本页条数', type: 'number', required: true, minimum: 1, maximum: 20 },
        { key: 'offset', label: '本页偏移', type: 'number', required: true, minimum: 0, maximum: 1_000_000 }];
      },
      permissionSummary: ['只读取明确连接的本机 WeRSS feed 缓存 JSON，不触发 fresh/update 或任意文章链接',
        '只保留单页原件和结构投影，不声明全文、许可、历史覆盖或发布资格'],
      available: () => {
        const current = settings.get(), available = current.plugins.some(item => item.id === 'werss' && item.enabled)
          && current.connections.some(item => item.pluginId === 'werss' && item.enabled && item.feedIds?.length);
        return available ? { available: true } : { available: false, reason: 'WeRSS 本地连接和 feed 尚未启用。' };
      },
      validate: args => { settings.assertWerssConnectionEnabled(String(args.connectionId), String(args.feedId));
        cacheUrl('http://127.0.0.1:1', String(args.feedId), Number(args.limit), Number(args.offset)); } },
    { action: 'source.wechat.extract', runtimeId: 'direct', kind: 'direct', modelCalls: 0, title: '提取微信公众号单篇文章正文',
      description: '使用本机已核对、已启用的固定 Python 脚本提取一篇公众号文章，保管原 HTML、脚本 JSON、可见正文与回执。',
      fields: [{ key: 'url', label: '公众号文章短链', type: 'text', required: true, maxLength: 300 }],
      permissionSummary: ['仅接受 https://mp.weixin.qq.com/s/ 下的单篇短链；不能提交脚本路径、命令或额外参数',
        '固定使用 --no-ocr，不下载正文图片或运行 OCR；原脚本内部 HTTP 客户端可能跟随站点跳转',
        '只保管本次页面和正文，不自动清洗、标注、提交 WFD 或声明文章完整性'],
      available: () => { try { settings.wechatScriptVersion(); options.processRuntime?.path('python3');
        return options.processRuntime ? { available: true } : { available: false, reason: '本机 Python 程序尚未绑定。' }; }
      catch { return { available: false, reason: '固定公众号脚本或本机 Python 尚未登记启用。' }; } },
      validate: args => { wechatArticleUrl(args.url); settings.wechatScriptVersion(); } },
  ];
  return { registrations, handles: (action: string) => SOURCE_ACTIONS.includes(action as typeof SOURCE_ACTIONS[number]),
    configuration(action: string, args: Record<string, JsonValue>): unknown {
      if (action === 'source.wechat.extract') {
        const current = settings.get();
        return { configurationRevision: current.revision, url: wechatArticleUrl(args.url), script: settings.wechatScriptVersion(current),
          python: options.processRuntime?.path('python3') ?? null, ocr: false };
      }
      if (action === 'source.werss.read') return { ...settings.werssConnectionVersion(String(args.connectionId)) as Record<string, unknown>,
        feedId: args.feedId, limit: args.limit, offset: args.offset, cacheRoute: 'feed/{id}.json?ctype=html&is_update=false' };
      if (action === 'source.kline.read') return settings.connectionVersion(String(args.scopeId), undefined,
        { operationId: String(args.operation) as SourceOperationId });
      if (action === 'source.api.read') return settings.connectionVersion(String(args.scopeId), 'ths', { operationId: String(args.operation) as SourceOperationId });
      if (args.sourceId === 'eastmoney') settings.assertCaptureEnabled('eastmoney');
      if (args.sourceId === 'tdx') return { sourceId: 'tdx', scopeId: args.scopeId, combination: settings.connectionVersion(String(args.scopeId), 'tdx', { operationId: 'minute_bars' }),
        sdk: settings.operationCandidates(String(args.scopeId), 'minute_bars').filter(connection => connection.pluginId === 'tdx').map(connection => tdxVersions(connection, options.tdxaidataPackage)) };
      return { sourceId: args.sourceId, scopeId: args.scopeId, adapter: args.sourceId === 'eastmoney' ? 'eastmoney-download/1' : 'official-download/1' };
    },
    async check(connectionId: string): Promise<SourceCheck> {
      const current = settings.get(), connection = current.connections.find(item => item.id === connectionId), configurationDigest = settings.checkIdentity(connectionId);
      if (!connection) throw new DirectError('SOURCE_CONNECTION_UNKNOWN', '没有此共享来源连接。');
      if (connection.pluginId === 'werss') return settings.saveCheck({ id: connectionId, checkedAt: new Date().toISOString(), configurationRevision: current.revision,
        configurationDigest, status: connection.enabled && current.plugins.find(item => item.id === 'werss')?.enabled ? 'partial' : 'blocked',
        reachable: null, authorized: null, capabilityAvailable: null, freshness: 'unknown',
        reason: '仅核对本机 WeRSS 连接配置；未读取缓存、未发送网络请求，端点可用性尚未验证。' });
      if (connection.pluginId === 'tdx') {
        const verified = settings.checks().find(check => check.id === connectionId && check.configurationDigest === configurationDigest && check.status === 'passed');
        if (verified) return verified;
        const available = tdxAvailability(connection, options.tdxaidataPackage, options.processRuntime);
        return settings.saveCheck({ id: connectionId, checkedAt: new Date().toISOString(), configurationRevision: current.revision, configurationDigest, status: !connection.enabled || !available.available ? 'blocked' : 'partial',
          reachable: null, authorized: null, capabilityAvailable: available.available, freshness: 'unknown', reason: !connection.enabled ? '此连接已停用，未读取凭据或发送请求。'
            : available.reason ?? '官方开发包与依赖已就绪；数据服务密钥类型和分钟权限须由明确的真实读取任务核验。' });
      }
      if (connection.pluginId !== 'ths') {
        // 没有真实检测器的来源不准误用同花顺私有凭据/端点；未知结果不伪装成检查通过。
        const enabled = connection.enabled && current.plugins.some(item => item.id === connection.pluginId && item.enabled);
        const registered = !!publicKlineProvider(connection.pluginId);
        return settings.saveCheck({ id: connectionId, checkedAt: new Date().toISOString(),
          configurationRevision: current.revision, configurationDigest,
          status: enabled ? 'partial' : 'blocked',
          reachable: null, authorized: null, capabilityAvailable: null, freshness: 'unknown',
          reason: !enabled ? '此连接或插件已停用，未发送网络请求。'
            : registered ? '已登记公开行情适配器；尚未发起真实读取，网络可达性和业务数据有效性未验证。'
              : '此来源尚未登记专用检查方法，未借用其他供应商凭据或协议。' });
      }
      let reachable: boolean | null = null, authorized: boolean | null = null, capabilityAvailable: boolean | null = null, reason = '';
      const assert = () => assertSourceCheckCurrent(settings, connectionId, configurationDigest);
      try {
        assert(); const key = await credential(connection, options.processRuntime);
        assert();
        const response = await serial(connection, () => { assert(); return readBytes(new URL(connection.baseUrl + '/api/a-share-index/constituents/ths-stock-list?thscode=000300.SH'), assert, undefined, { 'X-api-key': key }); });
        reachable = true;
        const value = json(response); authorized = response.status === 200 && value.code === 0; capabilityAvailable = authorized;
        reason = authorized ? '指定凭据与当前指数成分GET端点已实际核验；其他端点权限、剩余额度和数据及时性仍未知。' : `服务已响应，当前端点未通过授权或业务检查（HTTP ${response.status}，code ${String(value.code ?? 'unknown')}）。`;
      } catch (error) { reason = safeFailure(error); }
      return settings.saveCheck({ id: connectionId, checkedAt: new Date().toISOString(), configurationRevision: current.revision, configurationDigest,
        status: capabilityAvailable ? 'passed' : 'blocked', reachable, authorized, capabilityAvailable, freshness: 'unknown', reason });
    },
    async execute(context: TaskExecutionContext, action: string, args: Record<string, JsonValue>): Promise<TaskResult> {
      if (action === 'source.wechat.extract') return runWechatScript(context, args, options);
      if (action === 'source.werss.read') return readWerss(context, args);
      const p = sourceParameters(args), scopeId = String(args.scopeId), sourceId = String(args.sourceId ?? 'ths');
      const assert = () => { context.signal.throwIfAborted(); if (action === 'source.fetch' && sourceId === 'eastmoney') settings.assertCaptureEnabled('eastmoney'); };
      assert();
      const authority = await acquireAuthority(context, `${action}.stage`, { action, scopeId }, ['read', 'write', 'delete'].map(a => directoryCapability(a as 'read' | 'write' | 'delete', options.artifactRoot)));
      const workspace = new DirectWorkspace(context, options.files, options.artifactRoot, authority), prefix = `source-${context.task.id}-${randomUUID()}`;
      const networkAuthorities = new Map<string, DirectAuthority>();
      const saveDownload = (id: string, success: boolean, reason: string, identity = { configurationDigest: settings.checkIdentity(id), configurationRevision: settings.get().revision }) => settings.saveCheck({
        id, ...identity, checkedAt: new Date().toISOString(), status: success ? 'passed' : 'blocked',
        reachable: success ? true : null, authorized: success ? true : null, capabilityAvailable: success, freshness: 'unknown', reason,
      });
      const artifacts: string[] = [], receipts: Array<{ url: string; sha256: string; fileRefId: string; contentType: string; status: number | null; transport: 'https' | 'native-tcp' }> = [];
      const publish = async (name: string, bytes: Buffer | string) => {
        const staged = typeof bytes === 'string' ? await workspace.createText(name, bytes) : await workspace.createBytes(name, bytes);
        const reference = await workspace.publishFile(staged, prepareDestination(join(options.artifactRoot, `${prefix}-${name}`)), action, { scopeId }, MAX);
        artifacts.push(reference.id); return reference;
      };
      const fetchRetain = async (url: URL, assertCurrent = assert, headers?: Record<string, string>, accountScope = sourceId) => {
        const key = JSON.stringify([url.origin, accountScope]);
        let networkAuthority = networkAuthorities.get(key);
        if (!networkAuthority) {
          networkAuthority = await acquireAuthority(context, `source.read.${hash(url.origin).slice(0, 16)}`, { origin: url.origin }, [{ action: 'network', target: { kind: 'network', origin: url.origin } }]);
          networkAuthorities.set(key, networkAuthority);
        }
        networkAuthority.assert(); assertCurrent();
        const result = await readBytes(url, assertCurrent, context, headers, networkAuthority);
        const name = `${receipts.length + 1}-raw.${result.contentType.includes('pdf') ? 'pdf' : result.contentType.includes('html') ? 'html' : 'json'}`;
        const reference = await publish(name, result.bytes); receipts.push({ url: result.url, sha256: hash(result.bytes), fileRefId: reference.id, contentType: result.contentType, status: result.status, transport: 'https' });
        await context.emit({ type: 'checkpoint', checkpoint: { sourceReceipts: receipts as unknown as JsonValue, artifactIds: artifacts, complete: false } });
        if (result.status === 429) throw new DirectError('SOURCE_RATE_LIMITED', '来源触发HTTP 429限流；原响应已保留，本任务停止，不立即重试或切换同账号别名。');
        if (result.status < 200 || result.status >= 300) throw new DirectError('SOURCE_HTTP_ERROR', `来源返回HTTP ${result.status}；原响应已保留，未假报成功。`);
        return result;
      };
      try {
        await workspace.create();
        if (action === 'source.kline.read') {
          const operation = String(args.operation) as PublicKlineOperationId;
          if (operation !== 'minute_bars' && operation !== 'daily_bars') throw new DirectError('SOURCE_PARAMETERS_INVALID', 'K线类型必须是分钟或日线。');
          const dailyRequest = p.adjustment === undefined ? null : normalizePublicDailyRequest(p);
          if (dailyRequest && scopeId !== 'CN/A_STOCK') throw new DirectError('SOURCE_SCOPE_UNSUPPORTED', '受控不复权日线目前只登记中国A股范围。');
          const attempts: Array<{ connectionId: string; outcome: string; reason?: string }> = [];
          // 只解析并遍历明确配置的主源与备用源；未入选连接不自动补入。
          const candidates = settings.operationCandidates(scopeId, operation);
          for (const candidate of candidates) {
            const provider = publicKlineProvider(candidate.pluginId), downloadIdentity = { configurationDigest: settings.checkIdentity(candidate.id), configurationRevision: settings.get().revision };
            try {
              const assertConnection = () => {
                context.signal.throwIfAborted();
                settings.assertOperationConnectionEnabled(candidate.id, scopeId, operation);
              };
              // 停用先于能力与参数判断；停用连接不会因为其他实现不可用而被绕过。
              assertConnection();
              if (!provider || !provider.operations.some(item => item.id === operation)) throw new DirectError('SOURCE_KIND_UNSUPPORTED', '此连接不支持所选K线类型，已跳过。');
              if (dailyRequest && (!['tencent', 'eastmoney'].includes(provider.id) || candidate.baseUrl !== provider.baseUrl)) {
                throw new DirectError('SOURCE_KIND_UNSUPPORTED', '此连接没有匹配的受控不复权日线实现与服务地址，未扩大来源范围。');
              }
              const requestURL = provider.buildUrl(operation, p);
              const sourceAuthority = await acquireAuthority(context, `${action}.source`, { connectionId: candidate.id, origin: requestURL.origin }, [
                { action: 'network', target: { kind: 'network', origin: requestURL.origin } },
              ]);
              networkAuthorities.set(JSON.stringify([requestURL.origin, settings.accountId(candidate)]), sourceAuthority);
              sourceAuthority.assert(); assertConnection();
              const result = await serial(candidate, async () => { sourceAuthority.assert(); assertConnection(); return fetchRetain(requestURL, () => { sourceAuthority.assert(); assertConnection(); }, provider.headers, settings.accountId(candidate)); });
              const decoded = dailyRequest ? decodePublicDailyBars(provider.id as PublicDailyProviderId, dailyRequest, result.bytes) : null;
              const dailyValidation = decoded ? { decoderVersion: decoded.decoderVersion, symbol: decoded.symbol, adjustment: decoded.adjustment,
                requestedStart: decoded.requestedStart, requestedEnd: decoded.requestedEnd, actualStart: decoded.actualStart, actualEnd: decoded.actualEnd,
                recordCount: decoded.recordCount, rawSha256: decoded.rawSha256, database: 'not_submitted', historicalAvailability: 'not_established' } : undefined;
              attempts.push({ connectionId: candidate.id, outcome: 'used' });
              const receipt = { status: 'downloaded', sourceId: candidate.pluginId, connectionId: candidate.id, scopeId, operation, requested: p, observedAt: result.observedAt,
                actualSource: candidate.id, attempts, sourceReceipts: receipts, sourceConfigurationDigest: context.task.versions.directConfiguration,
                ...(dailyValidation ? { dailyValidation } : {}) };
              await publish('receipt.json', JSON.stringify(receipt, null, 2)); await workspace.cleanup();
              saveDownload(candidate.id, true, dailyValidation ? '不复权日线原件与业务字段已核对；历史可得性、完整覆盖及数据库准入须由后续契约核对。'
                : `已下载${operation === 'minute_bars' ? '分钟K线' : '日线'}原始响应。`, downloadIdentity);
              return { summary: '公开K线原始响应下载完成。', artifactIds: artifacts,
                data: { ...receipt, modelPreview: { status: 'downloaded', sourceId: candidate.pluginId, connectionId: candidate.id, operation,
                  observedAt: result.observedAt, sourceReceipts: receipts, artifactIds: artifacts, ...(dailyValidation ? { dailyValidation } : {}) } } as unknown as JsonValue };
            } catch (error) {
              if (context.signal.aborted || error instanceof DirectError && (error.unknown || error.code === 'SOURCE_RATE_LIMITED')) throw error;
              saveDownload(candidate.id, false, safeFailure(error), downloadIdentity);
              attempts.push({ connectionId: candidate.id, outcome: 'skipped_or_failed', reason: safeFailure(error) });
              await context.emit({ type: 'progress', message: `连接 ${candidate.alias} 未完成：${safeFailure(error)}`, data: { connectionId: candidate.id } });
            }
          }
          throw new DirectError('SOURCE_NO_ELIGIBLE_CONNECTION', dailyRequest ? '已配置主备中没有通过本次不复权日线请求核对的连接；原响应已保留，未调用未入选连接。'
            : '已配置的明确主备中没有完成此请求的公开K线连接。');
        }
        if (action === 'source.api.read') {
          const attempts: Array<{ connectionId: string; outcome: string; reason?: string }> = [];
          const operation = String(args.operation) as SourceOperationId;
          for (const candidate of settings.operationCandidates(scopeId, operation)) {
            const downloadIdentity = { configurationDigest: settings.checkIdentity(candidate.id), configurationRevision: settings.get().revision };
            try {
              if (candidate.pluginId !== 'ths') throw new DirectError('SOURCE_KIND_UNSUPPORTED', '此连接不支持所选同花顺公开接口动作，已跳过；不会向其他供应商发送同花顺协议。');
              const assertConnection = () => { context.signal.throwIfAborted(); settings.assertOperationConnectionEnabled(candidate.id, scopeId, operation); };
              assertConnection();
              const requestURL = thsUrl(candidate.baseUrl, String(args.operation), p), accountScope = settings.accountId(candidate);
              const sourceAuthority = await acquireAuthority(context, `${action}.source`, { connectionId: candidate.id, origin: requestURL.origin }, [
                { action: 'secret', target: { kind: 'secret', name: `api-source.${candidate.id}` } },
                { action: 'network', target: { kind: 'network', origin: requestURL.origin } },
              ]);
              networkAuthorities.set(JSON.stringify([requestURL.origin, accountScope]), sourceAuthority);
              sourceAuthority.assert(); assertConnection();
              const key = await credential(candidate, options.processRuntime);
              const result = await serial(candidate, async () => { sourceAuthority.assert(); assertConnection(); return fetchRetain(requestURL, () => { sourceAuthority.assert(); assertConnection(); }, { 'X-api-key': key }, accountScope); });
              const value = json(result);
              if (value.code === 4001) throw new DirectError('SOURCE_RATE_LIMITED', '来源触发code 4001限流；本任务停止，不立即重试或切换同账号别名。');
              if (value.code !== 0) throw new DirectError('SOURCE_BUSINESS_ERROR', `来源业务状态code ${String(value.code ?? 'unknown')}，未将响应当作成功数据。`);
              attempts.push({ connectionId: candidate.id, outcome: 'used' });
              const receipt = { status: 'downloaded', sourceId: candidate.pluginId, connectionId: candidate.id, scopeId, operation: args.operation, requested: p, observedAt: result.observedAt,
                actualSource: candidate.id, attempts, sourceReceipts: receipts, sourceConfigurationDigest: context.task.versions.directConfiguration };
              await publish('receipt.json', JSON.stringify(receipt, null, 2)); await workspace.cleanup();
              saveDownload(candidate.id, true, `已下载${String(args.operation)}原始响应。`, downloadIdentity);
              return { summary: '接口原始响应下载完成。', artifactIds: artifacts,
                data: { ...receipt, modelPreview: { status: 'downloaded', sourceId: candidate.pluginId, connectionId: candidate.id, operation: args.operation,
                  observedAt: result.observedAt, sourceReceipts: receipts, artifactIds: artifacts } } as unknown as JsonValue };
            } catch (error) {
              if (context.signal.aborted || error instanceof DirectError && (error.unknown || error.code === 'SOURCE_RATE_LIMITED')) throw error;
              saveDownload(candidate.id, false, safeFailure(error), downloadIdentity);
              attempts.push({ connectionId: candidate.id, outcome: 'skipped_or_failed', reason: safeFailure(error) });
              await context.emit({ type: 'progress', message: `连接 ${candidate.alias} 未完成：${safeFailure(error)}`, data: { connectionId: candidate.id } });
            }
          }
          throw new DirectError('SOURCE_NO_ELIGIBLE_CONNECTION', '已配置组合中没有完成此请求的合格连接；未调用名单外账号。');
        }
        let actualConnectionId: string | null = null;
        if (sourceId === 'tdx') {
          let acquired = false; const attemptedAccounts = new Set<string>();
          const operation: SourceOperationId = 'minute_bars';
          for (const connection of settings.operationCandidates(scopeId, operation)) {
            if (connection.pluginId !== 'tdx') continue;
            const downloadIdentity = { configurationDigest: settings.checkIdentity(connection.id), configurationRevision: settings.get().revision };
            try {
              const assertConnection = () => { context.signal.throwIfAborted(); settings.assertOperationConnectionEnabled(connection.id, scopeId, operation); };
              assertConnection();
              if (!claimSourceAccountAttempt(attemptedAccounts, settings.accountId(connection))) continue;
              const raw = await serial(connection, async () => { assertConnection(); return readTdxMinutes({ ...context,
                assertAuthorized: (operation, capabilities, input) => { assertConnection(); return context.assertAuthorized(operation, capabilities, input); },
                requestApproval: async (operation, capabilities, input) => { assertConnection(); const receipt = await context.requestApproval(operation, capabilities, input); assertConnection(); return receipt; } },
              connection, p, options.processRuntime, options.tdxaidataPackage); });
              const reference = await publish(`${receipts.length + 1}-raw.json`, raw.bytes);
              receipts.push({ url: raw.url, sha256: hash(raw.bytes), fileRefId: reference.id, contentType: raw.contentType, status: raw.status, transport: 'native-tcp' });
              await context.emit({ type: 'checkpoint', checkpoint: { sourceReceipts: receipts as unknown as JsonValue, artifactIds: artifacts, complete: false } });
              actualConnectionId = connection.id; acquired = true;
              saveDownload(connection.id, true, `已下载${String(p.symbol)}的1分钟原始响应。`, downloadIdentity); break;
            } catch (error) {
              saveDownload(connection.id, false, safeFailure(error), downloadIdentity);
              if (context.signal.aborted || error instanceof DirectError && (error.unknown || error.code === 'SOURCE_RATE_LIMITED')) throw error;
              await context.emit({ type: 'progress', message: `${connection.alias}下载未完成：${safeFailure(error)}` });
            }
          }
          if (!acquired) throw new DirectError('SOURCE_NO_ELIGIBLE_CONNECTION', '已配置组合中没有完成下载的通达信连接。');
        } else if (sourceId === 'eastmoney') {
          await fetchRetain(eastmoneyMinuteRequest(p));
          saveDownload('eastmoney', true, '已下载东方财富原始JSON。');
        } else {
          const raw = await fetchRetain(validatePublicWebUrl(String(p.url)));
          if (raw.contentType.includes('html')) {
            const { document } = parseHTML(decode(raw));
            const pdfs = [...new Set([...document.querySelectorAll('a[href]')].map(anchor => { try { return new URL(anchor.getAttribute('href')!, raw.url).href; } catch { return ''; } }).filter(url => /\.pdf(?:$|\?)/iu.test(url)))];
            if (pdfs.length > 4) throw new DirectError('SOURCE_ATTACHMENT_LIMIT', '页面PDF附件超过本次4份上限；原页面已保管。');
            for (const url of pdfs) {
              if (!officialHost(new URL(url).hostname)) throw new DirectError('SOURCE_ATTACHMENT_SCOPE', '附件不在明确的官方来源范围内，未自动下载。');
              await fetchRetain(validatePublicWebUrl(url));
            }
          }
        }
        const receipt = { status: 'downloaded', sourceId, actualConnectionId, sourceReceipts: receipts, sourceConfigurationDigest: context.task.versions.directConfiguration };
        await publish('receipt.json', JSON.stringify(receipt, null, 2)); await workspace.cleanup();
        return { summary: `原件下载完成，共${receipts.length}份。`, artifactIds: artifacts,
          data: { ...receipt, modelPreview: { ...receipt, artifactIds: artifacts } } as unknown as JsonValue };
      } catch (error) {
        if (sourceId === 'eastmoney') saveDownload('eastmoney', false, safeFailure(error));
        await workspace.recordRetained();
        if (!(error instanceof DirectError && error.unknown)) { try { await workspace.cleanup(); } catch { /* 原任务检查点保留自有暂存，不能掩盖已保管的来源。 */ } }
        throw error;
      }
    },
  };
}

function validateFetchArgs(args: Record<string, JsonValue>): void {
  const p = sourceParameters(args);
  if (args.sourceId === 'tdx') {
    if (Object.keys(p).some(key => !['symbol', 'count', 'end'].includes(key)) || typeof p.symbol !== 'string' || !/^\d{6}\.(SH|SZ|BJ)$/u.test(p.symbol)
      || p.count !== undefined && (!Number.isSafeInteger(p.count) || Number(p.count) < 1 || Number(p.count) > 500)
      || p.end !== undefined && (typeof p.end !== 'string' || p.end !== '' && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(p.end))) throw new DirectError('SOURCE_PARAMETERS_INVALID', '通达信下载需要明确代码、1至500条及可选结束时间。');
  } else if (args.sourceId === 'eastmoney') {
    if (Object.keys(p).some(key => !['symbol', 'start', 'end'].includes(key))) throw new DirectError('SOURCE_PARAMETERS_INVALID', '东方财富下载参数包含未定义字段。');
    eastmoneyMinuteRequest(p);
  } else {
    const url = validatePublicWebUrl(String(p.url));
    if (args.sourceId !== 'official_web' || Object.keys(p).some(key => key !== 'url') || !officialHost(url.hostname)) throw new DirectError('SOURCE_PARAMETERS_INVALID', '请提供明确的交易所、巨潮或中证官方网页或PDF网址。');
  }
}
function validateKlineArgs(args: Record<string, JsonValue>): void {
  const operation = String(args.operation);
  if (operation !== 'minute_bars' && operation !== 'daily_bars') throw new DirectError('SOURCE_PARAMETERS_INVALID', 'K线类型必须是分钟或日线。');
  const parameters = sourceParameters(args);
  if (parameters.adjustment !== undefined) {
    if (operation !== 'daily_bars' || args.scopeId !== 'CN/A_STOCK') throw new DirectError('SOURCE_PARAMETERS_INVALID', '受控不复权请求只支持中国A股日线。');
    normalizePublicDailyRequest(parameters);
    return;
  }
  let accepted = false, first: unknown;
  for (const provider of publicKlineProviders) {
    if (!provider.operations.some(item => item.id === operation)) continue;
    try { provider.buildUrl(operation as PublicKlineOperationId, parameters); accepted = true; break; }
    catch (error) { if (first === undefined) first = error; }
  }
  if (!accepted) throw first instanceof Error ? first : new DirectError('SOURCE_PARAMETERS_INVALID', 'K线参数不符合任何公开行情接口的要求。');
}
function thsUrl(base: string, operation: string, p: Record<string, JsonValue>): URL {
  const allowed = operation === 'index_constituents' ? ['thscode'] : operation === 'daily_bars' ? ['thscode', 'start', 'end'] : [];
  if (!allowed.length || Object.keys(p).some(key => !allowed.includes(key))) throw new DirectError('SOURCE_PARAMETERS_INVALID', '接口参数包含当前动作未定义的字段；凭据只能通过共享连接安全引用提供。');
  const symbol = p.thscode;
  if (typeof symbol !== 'string' || !/^[A-Z0-9]{4,12}\.(?:SH|SZ|TI)$/u.test(symbol)) throw new DirectError('SOURCE_PARAMETERS_INVALID', '请明确所选接口的完整证券或指数代码。');
  const url = new URL(operation === 'index_constituents' ? '/api/a-share-index/constituents/ths-stock-list' : '/api/a-share/prices/historical', base);
  url.searchParams.set('thscode', symbol);
  if (operation === 'daily_bars') {
    if (!Number.isSafeInteger(p.start) || !Number.isSafeInteger(p.end) || Number(p.start) <= 0 || Number(p.end) < Number(p.start)) throw new DirectError('SOURCE_PARAMETERS_INVALID', '日线需要明确的起止毫秒时间戳。');
    for (const [key, value] of Object.entries({ interval: '1d', start: String(p.start), end: String(p.end), adjust: 'none' })) url.searchParams.set(key, value);
  }
  return url;
}
async function credential(connection: SourceConnection, runtime?: ProcessRuntime): Promise<string> {
  const ref = connection.credential;
  if (!ref) throw new DirectError('SOURCE_CREDENTIAL_MISSING', '此连接尚缺本机安全凭据引用，请提供已有引用或前往申请页。');
  try { return ref.kind === 'keychain' ? await readKeychainCredential(ref.service, ref.account, runtime) : await readDshCredential(ref.path, ref.ref); }
  catch { throw new DirectError('SOURCE_CREDENTIAL_UNAVAILABLE', '本机无法读取此连接指定的凭据引用；未尝试其他账号。'); }
}
function safeFailure(error: unknown): string {
  return error instanceof DirectError || error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('SOURCE_')
    ? String((error as { message: string }).message) : '来源调用未完整完成；未返回底层异常或敏感请求信息。';
}
function json(source: SourceBytes): Record<string, JsonValue> {
  try { const value: unknown = JSON.parse(decode(source)); if (object(value)) return value; } catch { /* 原响应已经保管。 */ }
  throw new DirectError('SOURCE_RESPONSE_INVALID', '来源响应不是预期的JSON对象，原件已保留。');
}
function decode(source: SourceBytes): string {
  const charset = /charset\s*=\s*([\w-]+)/iu.exec(source.contentType)?.[1] ?? 'utf-8';
  if (!iconv.encodingExists(charset)) throw new DirectError('SOURCE_ENCODING_UNSUPPORTED', '来源声明了未支持的编码；未猜测字符集。');
  return iconv.decode(source.bytes, charset);
}
async function readBytes(url: URL, assertCurrent: () => void, context?: TaskExecutionContext, headers?: Record<string, string>, existingAuthority?: DirectAuthority): Promise<SourceBytes> {
  validatePublicWebUrl(url.href);
  const signal = context ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const authority = existingAuthority ?? (context ? await acquireAuthority(context, `source.read.${hash(url.origin).slice(0, 16)}`, { origin: url.origin }, [{ action: 'network', target: { kind: 'network', origin: url.origin } }]) : undefined);
  const assert = () => { signal.throwIfAborted(); authority?.assert(); assertCurrent(); };
  assert();
  const addresses = await resolvePublic(url.hostname, signal); addresses.forEach(assertPublicWebAddress);
  if (!addresses.length) throw new DirectError('SOURCE_NETWORK_UNAVAILABLE', '来源域名没有可用公开地址。');
  const effectId = randomUUID();
  if (context) await context.emit({ type: 'side_effect_started', effectId, description: '读取明确来源的公开或已授权对象', operation: { url: url.href, method: 'GET', credentials: headers ? 'reference' : 'none' } });
  let response: Awaited<ReturnType<typeof pinnedGet>> | undefined, completed = false;
  try {
    assert(); response = await pinnedGet({ url, address: addresses[0]!, signal, headers, assertAuthorized: assert });
    const chunks: Buffer[] = []; let count = 0;
    for await (const chunk of response.body) { assert(); count += chunk.byteLength; if (count > MAX) throw new DirectError('SOURCE_SIZE_LIMIT', '来源原件超过单份2MiB上限；未把截断内容当完整结果。'); chunks.push(Buffer.from(chunk)); }
    const contentType = String(response.headers['content-type'] ?? 'application/octet-stream');
    if (response.status >= 300 && response.status < 400) throw new DirectError('SOURCE_REDIRECT_UNSUPPORTED', '本次明确来源发生重定向；为保留身份与凭据范围，未自动改用目标。');
    completed = true; return { url: url.href, status: response.status, bytes: Buffer.concat(chunks), contentType, observedAt: new Date().toISOString() };
  } finally {
    await response?.close();
    if (context) await context.emit({ type: 'side_effect_result', effectId, outcome: completed ? 'succeeded' : 'failed', evidence: completed ? '来源响应已完整读取且自有网络资源已收束；内容与权限另按业务合同核对。' : '本次来源读取未完整完成，未自动重试。' });
  }
}
