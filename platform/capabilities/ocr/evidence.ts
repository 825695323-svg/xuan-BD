/** Local OCR observations are recognition evidence, not verified source truth. */
export const VISION_EVIDENCE_SCHEMA = 'xuan.apple-vision-ocr/1' as const;
export const VISION_LIMITS = Object.freeze({ inputBytes: 25 * 1024 * 1024, pixels: 40_000_000, side: 20_000, observations: 10_000, textBytes: 8 * 1024 * 1024, jsonBytes: 16 * 1024 * 1024 });
export interface VisionObservation {
  page: 1;
  text: string;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
}
export interface VisionEvidence {
  schema: typeof VISION_EVIDENCE_SCHEMA;
  width: number;
  height: number;
  revision: number;
  osVersion: string;
  languages: ['zh-Hans', 'en-US'];
  observations: VisionObservation[];
}
function fail(): never { throw new Error('OCR_EVIDENCE_INVALID'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) return fail();
  return record;
}
function integer(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) return fail();
  return value;
}
function normalized(value: unknown, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1 || (positive && value === 0)) return fail();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) || Buffer.byteLength(value, 'utf8') > max) return fail();
  return value;
}
/** Reject malformed observations and any mismatch with the separate text artifact. */
export function parseVisionEvidence(json: string, plainText: string): VisionEvidence {
  if (typeof json !== 'string' || typeof plainText !== 'string' || Buffer.byteLength(json) > VISION_LIMITS.jsonBytes || Buffer.byteLength(plainText) > VISION_LIMITS.textBytes) return fail();
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return fail(); }
  const root = object(parsed, ['schema', 'width', 'height', 'revision', 'osVersion', 'languages', 'observations']);
  if (root.schema !== VISION_EVIDENCE_SCHEMA) return fail();
  const width = integer(root.width, VISION_LIMITS.side), height = integer(root.height, VISION_LIMITS.side);
  if (width * height > VISION_LIMITS.pixels) return fail();
  if (!Array.isArray(root.languages) || root.languages.length !== 2 || root.languages[0] !== 'zh-Hans' || root.languages[1] !== 'en-US') return fail();
  if (!Array.isArray(root.observations) || root.observations.length > VISION_LIMITS.observations) return fail();
  const observations = root.observations.map(value => {
    const item = object(value, ['page', 'text', 'confidence', 'boundingBox']);
    if (item.page !== 1) return fail();
    const box = object(item.boundingBox, ['x', 'y', 'width', 'height']);
    const boundingBox = { x: normalized(box.x), y: normalized(box.y), width: normalized(box.width, true), height: normalized(box.height, true) };
    if (boundingBox.x + boundingBox.width > 1 || boundingBox.y + boundingBox.height > 1) return fail();
    return { page: 1 as const, text: text(item.text, VISION_LIMITS.textBytes), confidence: normalized(item.confidence), boundingBox };
  });
  if (observations.map(item => item.text).join('\n') !== plainText) return fail();
  return { schema: VISION_EVIDENCE_SCHEMA, width, height, revision: integer(root.revision, 1_000_000), osVersion: text(root.osVersion, 256), languages: ['zh-Hans', 'en-US'], observations };
}
