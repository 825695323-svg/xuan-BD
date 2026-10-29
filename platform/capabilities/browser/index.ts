import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { inspectPath, PermissionError, samePathIdentity, type PermissionCapability } from '../../security/permissions.js';
import type { SkillRegistration } from '../../plugins/registry.js';
import type { FileReferenceService } from '../../resources/files.js';
import { TaskError, type TaskExecutionContext } from '../../jobs/tasks.js';
import type { JsonValue, TaskResult } from '../../../contracts/task-contracts.js';
import { acquireAuthority, DirectError } from '../../runtime/file-workspace.js';
import { readBrowserBoundFile } from './sites.js';
import { validatePublicWebUrl, type PublicWebOptions } from './public-web.js';
import { captureOwnedPage } from './owned-page.js';
import { extractPublicWebHtml, publishRawPage } from './raw-page.js';

/** 旧站点目录字段仅作既有宿主结构兼容；core（基础能力）不访问或装配其中脚本。 */
export interface BrowserConfiguration { daemonConfigPath: string; adapterRoot?: string; privateRoot?: string }
const OPERATIONS = ['status', 'extract_url'] as const;
type Operation = typeof OPERATIONS[number];
interface DaemonInfo { pid: number; host: string; port: number; token: string; cdpHost: string; cdpPort: number }
const NATIVE_SECRET: PermissionCapability = { action: 'secret', target: { kind: 'secret', name: 'bb-browser.native-session' } };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function validateBrowserArgs(args: Record<string, JsonValue>): Operation {
  const operation = args.operation as Operation;
  if (!OPERATIONS.includes(operation) || Object.keys(args).some(key => !['operation', ...(operation === 'extract_url' ? ['url'] : [])].includes(key))) {
    throw new DirectError('BROWSER_ARGS_INVALID', '浏览器只提供状态与明确网址的原始提取；站点专用动作已退出固定能力。');
  }
  if (operation === 'extract_url') validatePublicWebUrl(args.url as string);
  return operation;
}
function validateConfiguration(configuration: BrowserConfiguration): void {
  const paths = [configuration.daemonConfigPath, ...[configuration.adapterRoot, configuration.privateRoot].filter((path): path is string => path !== undefined)];
  if (paths.some(path => !isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f]/u.test(path))) throw new DirectError('BROWSER_BINDING_INVALID', '浏览器绑定需要受信宿主提供明确的绝对路径。');
  const root = dirname(configuration.daemonConfigPath);
  if (configuration.adapterRoot !== undefined && configuration.adapterRoot !== join(root, 'bb-sites')
    || configuration.privateRoot !== undefined && configuration.privateRoot !== join(root, 'sites')) throw new DirectError('BROWSER_BINDING_INVALID', '历史目录字段不能指向另一份浏览器状态。');
}
async function loadDaemon(configuration: BrowserConfiguration): Promise<DaemonInfo> {
  let value: Partial<DaemonInfo>;
  try { value = JSON.parse((await readBrowserBoundFile(configuration.daemonConfigPath, 32_000)).toString('utf8')) as Partial<DaemonInfo>; }
  catch { throw new DirectError('BROWSER_DAEMON_UNAVAILABLE', '原浏览器守护配置无法核对；不自动启动、重启、安装或登录。'); }
  const loopback = (host: unknown) => host === '127.0.0.1' || host === '::1';
  const port = (number: unknown) => Number.isSafeInteger(number) && Number(number) > 0 && Number(number) <= 65535;
  if (!value || !loopback(value.host) || !loopback(value.cdpHost) || !port(value.port) || !port(value.cdpPort)
    || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.token !== 'string' || !/^[^\s\u0000-\u001f\u007f-\u009f]{16,2048}$/u.test(value.token)) {
    throw new DirectError('BROWSER_BINDING_INVALID', '浏览器守护配置不是获准的本机认证连接，不能尝试其他端点。');
  }
  try { process.kill(value.pid!, 0); } catch { throw new DirectError('BROWSER_DAEMON_UNAVAILABLE', '原浏览器守护进程已不在运行；不自动启动或接管。'); }
  return value as DaemonInfo;
}
const origin = (host: string, port: number) => `http://${host === '::1' ? '[::1]' : host}:${port}`;

/** 只查询原 daemon（守护进程）的鉴权状态路由，不使用自动生命周期 CLI（命令行）。 */
function daemonStatus(info: DaemonInfo, context: TaskExecutionContext, assertAuthorized: () => void): Promise<unknown> {
  return new Promise((done, fail) => {
    let settled = false, bytes = 0; const chunks: Buffer[] = [];
    const finish = (error?: DirectError, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); context.signal.removeEventListener('abort', abort);
      error ? fail(error) : done(value);
    };
    const req = httpRequest({ hostname: info.host, port: info.port, path: '/status', method: 'GET', headers: { Authorization: `Bearer ${info.token}` } }, response => {
      response.on('data', (chunk: Buffer) => {
        try { assertAuthorized(); } catch { req.destroy(); finish(new DirectError('BROWSER_REQUEST_STOPPED', '浏览器状态等待已停止。')); return; }
        if ((bytes += chunk.length) > 64_000) { req.destroy(); finish(new DirectError('BROWSER_OUTPUT_LIMIT', '浏览器状态返回超过本轮预算。')); return; }
        chunks.push(chunk);
      });
      response.once('aborted', () => finish(new DirectError('BROWSER_STATUS_INVALID', '浏览器状态响应中断。')));
      response.once('error', () => finish(new DirectError('BROWSER_STATUS_INVALID', '浏览器状态响应未完整收束。')));
      response.once('end', () => {
        if (response.statusCode !== 200) { finish(new DirectError('BROWSER_DAEMON_REJECTED', '浏览器拒绝原身份状态查询；不会外发诊断正文。')); return; }
        try { assertAuthorized(); finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(new DirectError('BROWSER_STATUS_INVALID', '浏览器没有返回可核对的完整状态。')); }
      });
    });
    const abort = () => { req.destroy(); finish(new DirectError('BROWSER_REQUEST_STOPPED', '已停止浏览器状态等待。')); };
    const timer = setTimeout(() => { req.destroy(); finish(new DirectError('BROWSER_DAEMON_UNAVAILABLE', '原浏览器状态查询超时。')); }, 2000);
    req.once('error', () => finish(new DirectError('BROWSER_DAEMON_UNAVAILABLE', '原浏览器连接不可用；不自动启动或切换。')));
    context.signal.addEventListener('abort', abort, { once: true });
    try { assertAuthorized(); req.end(); } catch { abort(); }
  });
}

export function createBrowserActions(options: { configuration?: BrowserConfiguration; unavailableReason?: string; files?: FileReferenceService; artifactRoot?: string; publicWeb?: PublicWebOptions }) {
  const configuration = options.configuration;
  const available = () => {
    if (!configuration) return { available: false, reason: options.unavailableReason ?? '内置浏览器程序或独立宿主尚未就绪；未使用其他浏览器或自动下载。' };
    try { validateConfiguration(configuration); return { available: true }; }
    catch { return { available: false, reason: '原生浏览器连接绑定不符；没有访问历史站点脚本。' }; }
  };
  const registration: SkillRegistration = { action: 'browser.control', runtimeId: 'direct', kind: 'direct', modelCalls: 0,
    title: '原始网页提取', description: '查询自有浏览器状态，或按明确公网 HTTPS（加密网页）网址保留原始 HTML（网页源码）及静态正文。仅同来源主文档 GET（读取请求），禁脚本与子资源；不使用登录态、站点 API（专用接口）或评论。动态、登录与验证码内容标记为未完整读取。',
    fields: [
      { key: 'operation', label: '只读动作', type: 'select', required: true, options: OPERATIONS.map(value => ({ value, label: value })) },
      { key: 'url', label: '明确公开 HTTPS（加密网页）网址', type: 'text', maxLength: 4096 },
    ], permissionSummary: ['原生浏览器连接按秘密权限核对', '网页只访问本次明确获准来源，公网地址逐请求钉住', '原始网页、正文及定位按原文件权限保留；模型只取正文预览', '只做结构转换；未知结果不自动重放，取消不冒称远端未收到请求'],
    available, validate: validateBrowserArgs };
  return { registrations: [registration], handles: (action: string) => action === registration.action,
    async execute(context: TaskExecutionContext, args: Record<string, JsonValue>): Promise<TaskResult> {
      try {
        const operation = validateBrowserArgs(args);
        if (!configuration) throw new DirectError('BROWSER_UNAVAILABLE', available().reason!);
        validateConfiguration(configuration);
        if (operation === 'extract_url' && (!options.files || !options.artifactRoot)) throw new DirectError('BROWSER_ARTIFACTS_UNBOUND', '原始网页保管入口尚未绑定，未发送导航。');
        const bindingAuthority = await acquireAuthority(context, `browser.control.${operation}.bindings`, args, [NATIVE_SECRET]);
        bindingAuthority.assert();
        const binding = inspectPath(configuration.daemonConfigPath), info = await loadDaemon(configuration);
        const source = operation === 'extract_url' ? validatePublicWebUrl(String(args.url)) : undefined;
        const origins = [origin(info.host, info.port), ...(source ? [origin(info.cdpHost, info.cdpPort), source.origin] : [])];
        const authority = await acquireAuthority(context, `browser.control.${operation}.request`, args,
          [NATIVE_SECRET, ...[...new Set(origins)].map(value => ({ action: 'network' as const, target: { kind: 'network' as const, origin: value } }))]);
        const assertCurrent = () => {
          bindingAuthority.assert(); authority.assert();
          if (!samePathIdentity(binding, inspectPath(configuration.daemonConfigPath), true)) throw new DirectError('BROWSER_BINDING_CHANGED', '浏览器原连接已变化，本轮不切换身份或端点。');
        };
        assertCurrent();
        const status = await daemonStatus(info, context, assertCurrent);
        if (!object(status) || status.running !== true || typeof status.cdpConnected !== 'boolean' || !Array.isArray(status.tabs)
          || status.cdpHost !== info.cdpHost || status.cdpPort !== info.cdpPort) throw new DirectError('BROWSER_STATUS_INVALID', '浏览器状态与本轮原生连接不符。');
        if (operation === 'status') {
          const result = { operation, complete: true, modelCalls: 0, running: true, connected: status.cdpConnected, tabCount: status.tabs.length };
          return { summary: status.cdpConnected ? '原自有浏览器已响应状态查询。' : '守护进程运行，原浏览器尚未连接；未自动启动或重启。', data: { ...result, modelPreview: result } };
        }
        if (!status.cdpConnected) throw new DirectError('BROWSER_DAEMON_UNAVAILABLE', '原浏览器未连接，未发送网页导航。');
        const effectId = randomUUID();
        await context.emit({ type: 'side_effect_started', effectId, description: '在本次独占空白目标中读取明确网址的原始网页', operation: { sourceURL: source!.href, mode: 'public-static-html', readOnly: true } });
        let capture: Awaited<ReturnType<typeof captureOwnedPage>>;
        try { capture = await captureOwnedPage(context, { host: info.cdpHost, port: info.cdpPort }, source!, assertCurrent, options.publicWeb); }
        catch (error) {
          if (error instanceof DirectError && !error.unknown) await context.emit({ type: 'side_effect_result', effectId, outcome: 'failed', evidence: '本次目标与网络资源已收束，原始网页未完整取得；此记录不证明远端未收到 GET（读取请求）。' });
          throw error;
        }
        assertCurrent();
        let html: string;
        try { html = new TextDecoder(capture.charset, { fatal: true }).decode(capture.bytes); }
        catch { await context.emit({ type: 'side_effect_result', effectId, outcome: 'failed', evidence: '原始响应已完整取回且本次目标关闭，但字符编码不支持，未生成正文。' }); throw new DirectError('WEB_TEXT_ENCODING_INVALID', '网页字符编码不支持或内容不是有效文字。'); }
        await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '同来源主文档逐请求钉住公网地址，原始响应完整且本次自有目标已关闭；HTTP（网页响应）成功不代表正文完整。', data: { sourceURL: capture.sourceURL, finalURL: capture.finalURL, rawBytes: capture.bytes.byteLength, ...capture.observation } });
        return await publishRawPage(context, options.files!, options.artifactRoot!, { action: 'browser.control', ...capture, sourceKind: 'http-response', extraction: extractPublicWebHtml(html) });
      } catch (error) {
        if (error instanceof TaskError || error instanceof PermissionError) throw error;
        throw new DirectError('BROWSER_UNAVAILABLE', '浏览器原身份或原始网页无法核对，未自动修复、安装、切换或重放。');
      }
    },
  };
}
