import type { ConversionEnvelope, ConversionPayload } from '../../../contracts/conversion.js';
import type { JsonValue } from '../../../contracts/task-contracts.js';
import { DirectError } from '../../runtime/file-workspace.js';

export const CONVERSION_SCHEMA_VERSION = '1.1';
export const CONVERSION_IMPLEMENTATION = { name: 'harness-native-conversion', version: '1.1.0' } as const;
export const PDF_TEXT_REPRESENTATION = 'pdf-original-items/1';

function object(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 原文字项的数组顺序与 hasEOL（原生行尾）是正文依据；不作几何重排或规范化。 */
function nativePageText(page: Record<string, JsonValue>): string {
  if (!Array.isArray(page.originalItems)) throw new DirectError('PDF_TEXT_VIEW_INVALID', 'PDF 页面没有可重建正文的原文字项。');
  return page.originalItems.map(item => object(item) && typeof item.str === 'string'
    ? item.str + (item.hasEOL ? '\n' : '') : '').join('');
}

/** 兼容旧产物的逐页 text；新产物从原文字项按需取得同样的原生顺序正文。 */
export function pdfPageText(value: unknown): string {
  if (!object(value)) throw new DirectError('PDF_TEXT_VIEW_INVALID', 'PDF 页面结构无效。');
  return typeof value.text === 'string' ? value.text : nativePageText(value);
}

/** 旧版直接读取 text；只对明确声明了本表示版本的 PDF 重建全文。 */
export function conversionText(payload: Pick<ConversionPayload, 'text' | 'content'>): string | undefined {
  if (payload.text !== undefined) return payload.text;
  const content = payload.content;
  if (!object(content) || content.format !== 'pdf' || content.textRepresentation !== PDF_TEXT_REPRESENTATION) return undefined;
  if (!Array.isArray(content.pages)) throw new DirectError('PDF_TEXT_VIEW_INVALID', 'PDF 转换内容缺少页面清单。');
  return content.pages.map(pdfPageText).join('\f');
}

/** 仅为当前新转换生成持久化视图，不改写旧版信封或已登记产物。 */
export function storedConversionEnvelope(envelope: ConversionEnvelope): ConversionEnvelope {
  const content = envelope.content;
  if (envelope.schemaVersion !== CONVERSION_SCHEMA_VERSION || envelope.implementation.version !== CONVERSION_IMPLEMENTATION.version
    || !object(content) || content.format !== 'pdf' || !Array.isArray(content.pages)) return envelope;
  const texts: string[] = [];
  const pages = content.pages.map(page => {
    if (!object(page)) throw new DirectError('PDF_TEXT_VIEW_INVALID', 'PDF 页面结构无效。');
    const text = nativePageText(page);
    if (page.text !== text) throw new DirectError('PDF_TEXT_VIEW_MISMATCH', '逐页正文与原文字项不能无损核对，不省略正文。');
    texts.push(text);
    const { text: _text, ...stored } = page;
    return stored;
  });
  if (envelope.text !== texts.join('\f')) throw new DirectError('PDF_TEXT_VIEW_MISMATCH', '全文与原文字项不能无损核对，不省略正文。');
  const { text: _text, ...stored } = envelope;
  return { ...stored, content: { ...content, textRepresentation: PDF_TEXT_REPRESENTATION, pages } };
}
