import type { JsonValue } from './task-contracts.js';

export const CONVERSION_ACTION_IDS = ['conversion.inspect', 'conversion.document', 'conversion.structured', 'conversion.archive',
  'conversion.pdf_render', 'conversion.image', 'conversion.media', 'conversion.subtitle'] as const;
export const PDF_EXTRACT_ALIAS = 'pdf.extract';

/** 仅转换原生表达；不执行清洗、缺值填充、业务解释、摘要、特征或数据库提交。 */
export type ConversionStatus = 'complete' | 'partial' | 'failed';
export interface ConversionIssue { code: string; message: string; location?: JsonValue }
export interface ConversionPayload {
  status: ConversionStatus;
  content: JsonValue;
  issues: ConversionIssue[];
  /** 仅为原文顺序拼接的便利视图；新版 PDF 持久产物从 content.pages[].originalItems 按需重建。 */
  text?: string;
}
export interface ConversionSource {
  fileRefId: string;
  fileRefVersion: number;
  sha256: string;
  bytes: number;
  declaredName: string;
  detectedType: string;
  encoding?: string;
}
export interface ConversionEnvelope extends ConversionPayload {
  schemaVersion: '1.0' | '1.1';
  implementation: { name: 'harness-native-conversion'; version: '1.0.0' | '1.1.0' };
  source: ConversionSource;
  operation: string;
}
