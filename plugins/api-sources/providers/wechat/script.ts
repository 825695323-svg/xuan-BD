import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { JsonValue, TaskResult } from '../../../../contracts/task-contracts.js';
import type { TaskExecutionContext } from '../../../../platform/jobs/tasks.js';
import { DirectError, DirectWorkspace, acquireAuthority, directoryCapability, fileCapability, prepareDestination } from '../../../../platform/runtime/file-workspace.js';
import { DirectProcessError, runDirectProcess } from '../../../../platform/runtime/process.js';
import type { ProcessRuntime } from '../../../../platform/runtime/programs.js';
import type { FileReferenceService } from '../../../../platform/resources/files.js';
import type { SourceSettingsService } from '../../../../platform/config/source-settings.js';
import { WECHAT_EXTRACT_SHA256 } from '../../../../platform/config/source-settings.js';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** 只允许公众号单篇文章短链；没有模型可控的跳转、程序或输出位置。 */
export function wechatArticleUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 300) throw new DirectError('WECHAT_URL_INVALID', '请提供单篇公众号文章链接。');
  let url: URL;
  try { url = new URL(input); } catch { throw new DirectError('WECHAT_URL_INVALID', '公众号文章链接无效。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.port || url.username || url.password
    || !/^\/s\/[A-Za-z0-9_-]{8,128}$/u.test(url.pathname) || url.search || url.hash) {
    throw new DirectError('WECHAT_URL_INVALID', '只接受不带附加参数的公众号单篇文章短链。');
  }
  return url.href;
}

export interface WechatScriptOptions {
  settings: SourceSettingsService;
  files: FileReferenceService;
  artifactRoot: string;
  processRuntime?: ProcessRuntime;
}

/** 固定脚本只取正文与原 HTML，不运行图片 OCR；任务结果是材料候选，不是发布资格。 */
export async function runWechatScript(context: TaskExecutionContext, args: Record<string, JsonValue>, options: WechatScriptOptions): Promise<TaskResult> {
  const url = wechatArticleUrl(args.url);
  const configuration = options.settings.get(), scriptVersion = options.settings.wechatScriptVersion(configuration);
  const assertSetting = () => {
    if (options.settings.get().revision !== configuration.revision) throw new DirectError('SOURCE_CONFIGURATION_CHANGED', '公众号脚本配置修订已变化，本次提取停止。');
    options.settings.wechatScriptVersion();
  };
  const runtime = options.processRuntime;
  if (!runtime) throw new DirectError('WECHAT_PYTHON_UNAVAILABLE', '本机 Python 运行程序尚未绑定。');
  let python: string;
  try { python = runtime.path('python3'); }
  catch { throw new DirectError('WECHAT_PYTHON_UNAVAILABLE', '已登记的 Python 程序不可用。'); }
  const stage = await acquireAuthority(context, 'source.wechat.extract.stage', { url },
    ['read', 'write', 'delete'].map(action => directoryCapability(action as 'read' | 'write' | 'delete', options.artifactRoot)));
  const workspace = new DirectWorkspace(context, options.files, options.artifactRoot, stage);
  let created = false;
  const artifactIds: string[] = [], prefix = 'wechat-' + context.task.id + '-' + randomUUID();
  const publish = async (name: string, path: string, limit: number) => {
    assertSetting();
    const fingerprint = await workspace.fingerprint(path, limit);
    const reference = await workspace.publishFile(path, prepareDestination(join(options.artifactRoot, prefix + '-' + name)),
      'source.wechat.extract', { url }, limit);
    artifactIds.push(reference.id);
    return { reference, ...fingerprint };
  };
  try {
    await workspace.create();
    created = true;
    const source = await acquireAuthority(context, 'source.wechat.extract.script', { sha256: WECHAT_EXTRACT_SHA256 },
      [fileCapability('read', scriptVersion.path)]);
    source.assert();
    const scriptBytes = readFileSync(scriptVersion.path);
    if (hash(scriptBytes) !== WECHAT_EXTRACT_SHA256) throw new DirectError('WECHAT_SCRIPT_CHANGED', '脚本字节与已选固定版不符，未执行。');
    source.assert(); assertSetting();
    const stagedScript = await workspace.createBytes('wechat_extract.py', scriptBytes);
    const process = await acquireAuthority(context, 'source.wechat.extract.process', { url, scriptSha256: WECHAT_EXTRACT_SHA256, ocr: false },
      [fileCapability('execute', python), { action: 'network', target: { kind: 'network', origin: 'https://mp.weixin.qq.com' } }]);
    const effectId = randomUUID();
    await context.emit({ type: 'side_effect_started', effectId, description: '运行已核对的公众号正文提取脚本',
      operation: { url, scriptSha256: WECHAT_EXTRACT_SHA256, ocr: false } });
    let stdout: string, processExitCode: number | null = null;
    try {
      const response = await runDirectProcess({ runtime, binary: 'python3', binaryPath: python,
        args: [stagedScript, url, '--no-ocr', '--keep-html', '--out', workspace.path], cwd: workspace.path,
        signal: context.signal, timeoutMs: 90_000, maxOutputBytes: 32_000,
        onProcessState: event => context.emit({ type: 'process_state', ...event }),
        onHeartbeat: event => context.emit({ type: 'heartbeat', ...event }),
        assertAuthorized: () => { process.assert(); source.assert(); workspace.assertCurrent(); assertSetting(); } });
      stdout = response.stdout;
      processExitCode = response.exitCode;
      await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: 'Python 进程及子进程均已收束；脚本结果另行核对。' });
    } catch (error) {
      if (error instanceof DirectProcessError && error.disposition !== 'unknown') {
        await context.emit({ type: 'side_effect_result', effectId, outcome: error.disposition === 'not_started' ? 'not_applied' : 'failed',
          evidence: '进程未启动或已收束；未发布来源材料。' });
      }
      throw error;
    }
    let summary: unknown;
    try { summary = JSON.parse(stdout); } catch { throw new DirectError('WECHAT_RECEIPT_INVALID', '脚本没有返回可解析的单份 JSON 回执。'); }
    if (!record(summary) || processExitCode !== 0 || typeof summary.file !== 'string' || summary.status !== 'ok' || summary.json_valid !== true
      || typeof summary.word_count !== 'number' || summary.word_count < 50) {
      throw new DirectError('WECHAT_BODY_UNAVAILABLE', '脚本未确认取得公众号文章正文；未把验证页或短页报为成功。');
    }
    const outputPath = summary.file, child = relative(workspace.path, outputPath);
    if (child.startsWith('..' + sep) || child === '..' || child.startsWith(sep)
      || !/^wechat\/[0-9]{8}\/[\s\S]+_cleaned\.json$/u.test(child.replaceAll(sep, '/'))) {
      throw new DirectError('WECHAT_OUTPUT_INVALID', '脚本回执的产物不在本次独立暂存目录。');
    }
    const jsonText = await workspace.readText(outputPath, MAX_JSON_BYTES);
    let cleaned: unknown;
    try { cleaned = JSON.parse(jsonText); } catch { throw new DirectError('WECHAT_OUTPUT_INVALID', '脚本产物不是有效 JSON。'); }
    if (!record(cleaned) || cleaned.url !== url || cleaned.extract_method !== 'curl+regex'
      || typeof cleaned.title !== 'string' || !cleaned.title.trim() || cleaned.title === '未知标题'
      || typeof cleaned.author !== 'string' || !cleaned.author.trim() || cleaned.author === '未知作者'
      || typeof cleaned.content_text !== 'string' || cleaned.content_text.trim().length < 50
      || !Array.isArray(cleaned.paragraphs) || cleaned.paragraphs.length === 0
      || cleaned.paragraphs.some(item => typeof item !== 'string')
      || JSON.stringify(cleaned.paragraphs) !== JSON.stringify(cleaned.content_text.split('\n').map(item => item.trim()).filter(Boolean))
      || cleaned.word_count !== summary.word_count || cleaned.paragraphs.length !== summary.paragraphs
      || cleaned.title !== summary.title || cleaned.author !== summary.author
      || cleaned.publish_time !== summary.publish_time || cleaned.cache_date !== summary.cache_date
      || cleaned.ocr_text !== '' || !Array.isArray(cleaned.images) || cleaned.images.length !== 0
      || !record(cleaned.structured) || Object.keys(cleaned.structured).length !== 0) {
      throw new DirectError('WECHAT_OUTPUT_INVALID', '脚本回执、链接、正文与产物结构未能逐项核对。');
    }
    assertSetting();
    const htmlPath = outputPath.replace(/_cleaned\.json$/u, '.html');
    await workspace.readText(htmlPath, MAX_HTML_BYTES);
    const bodyPath = await workspace.createText('visible.txt', cleaned.content_text);
    const raw = await publish('raw.html', htmlPath, MAX_HTML_BYTES);
    const structured = await publish('cleaned.json', outputPath, MAX_JSON_BYTES);
    const body = await publish('visible.txt', bodyPath, MAX_JSON_BYTES);
    const receiptText = JSON.stringify({ schemaVersion: 1, source: 'wechat-fixed-script', status: 'extracted', url,
      scriptSha256: WECHAT_EXTRACT_SHA256, configurationRevision: configuration.revision,
      title: cleaned.title, author: cleaned.author, publishTime: cleaned.publish_time,
      wordCount: cleaned.word_count, rawRef: raw.reference.id, rawRefVersion: raw.reference.version, rawSha256: raw.sha256,
      jsonRef: structured.reference.id, jsonRefVersion: structured.reference.version, jsonSha256: structured.sha256,
      textRef: body.reference.id, textRefVersion: body.reference.version, textSha256: body.sha256,
      extraction: 'curl+regex', ocr: false, exitCode: processExitCode,
      paragraphCount: cleaned.paragraphs.length, bodyChars: Array.from(cleaned.content_text).length,
      completeness: 'script-validated-body; source-page-completeness-unknown',
      obtainedAt: new Date().toISOString() }) + '\n';
    const receiptPath = await workspace.createText('receipt.json', receiptText);
    const receipt = await publish('receipt.json', receiptPath, MAX_JSON_BYTES);
    assertSetting();
    await workspace.cleanup();
    const data = { source: 'wechat-fixed-script', status: 'extracted', url, title: cleaned.title, author: cleaned.author,
      publishTime: cleaned.publish_time, wordCount: cleaned.word_count, scriptSha256: WECHAT_EXTRACT_SHA256,
      configurationRevision: configuration.revision,
      rawRef: raw.reference.id, rawRefVersion: raw.reference.version, rawSha256: raw.sha256,
      jsonRef: structured.reference.id, jsonRefVersion: structured.reference.version, jsonSha256: structured.sha256,
      textRef: body.reference.id, textRefVersion: body.reference.version, textSha256: body.sha256,
      receiptRef: receipt.reference.id, receiptRefVersion: receipt.reference.version, receiptSha256: receipt.sha256,
      ocr: false, exitCode: processExitCode, paragraphCount: cleaned.paragraphs.length,
      bodyChars: Array.from(cleaned.content_text).length,
      completeness: 'script-validated-body; source-page-completeness-unknown',
      contentIsUntrustedReference: true, readOnly: true, sourceModified: false, modelCalls: 0,
      modelPreview: { status: 'extracted', source: 'wechat-fixed-script', url, title: cleaned.title, author: cleaned.author,
        publishTime: cleaned.publish_time, wordCount: cleaned.word_count, configurationRevision: configuration.revision,
        paragraphCount: cleaned.paragraphs.length,
        bodyChars: Array.from(cleaned.content_text).length, exitCode: processExitCode, textRef: body.reference.id,
        textRefVersion: body.reference.version, textSha256: body.sha256, rawRef: raw.reference.id,
        jsonRef: structured.reference.id, receiptRef: receipt.reference.id,
        textPreview: cleaned.content_text.slice(0, 3600), previewTruncated: cleaned.content_text.length > 3600,
        completeness: 'script-validated-body; source-page-completeness-unknown',
        guidance: '正文来自固定脚本并已核对产物与回执；原页面是否完整、发布时间、许可及业务语义仍须另行判断。可用 textRef 调用 material.read 保管和读取完整正文。' } };
    return { summary: '已取得并保管公众号文章正文、原页面、脚本 JSON 与核对回执；尚未入库。', artifactIds,
      data: data as unknown as JsonValue };
  } catch (error) {
    if (!created) throw error;
    if (error instanceof DirectProcessError && error.disposition === 'unknown' || error instanceof DirectError && error.unknown) {
      await workspace.recordRetained();
      throw error;
    }
    try { await workspace.cleanup(); } catch { await workspace.recordRetained(); throw new DirectError('WECHAT_STAGE_CLEANUP_UNKNOWN', '公众号提取暂存清理结果未知，请按原任务核对。', true); }
    await workspace.recordRetained();
    throw error;
  }
}
