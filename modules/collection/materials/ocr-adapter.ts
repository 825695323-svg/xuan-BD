import type { DirectRuntimeBundle } from '../../../contracts/direct-runtime.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import type { MaterialMediaAdapter } from './plugins.js';

/** 只接当前材料入口与原 Direct 执行器；不另开识别服务或降级为外部模型。 */
export function createMaterialOcrAdapter(executor: () => DirectRuntimeBundle['localOcr'] | undefined): MaterialMediaAdapter {
  return {
    id: 'material.ocr', version: '1', acceptedFormats: ['image'],
    availability: () => executor()?.availability() ?? { available: false, reason: '本机 OCR 尚未装配。' },
    async execute(source, context) {
      const selected = executor();
      if (!selected?.availability().available) return { status: 'not_configured', reason: selected?.availability().reason ?? '本机 OCR 尚未装配。', result: null };
      if (context.task.action !== 'material.ocr') throw new TaskError('MATERIAL_BINDING_MISMATCH', 'OCR 必须属于当前材料任务。');
      const extracted = await selected.execute(context, { fileRefId: source.fileRefId, fileRefVersion: source.fileRefVersion, expectedSha256: source.sha256 });
      const segments: typeof extracted.segments = []; let bytes = 0;
      for (const segment of extracted.segments) {
        const size = Buffer.byteLength(JSON.stringify(segment));
        if (segments.length >= 200 || bytes + size > 80_000) break;
        segments.push(segment); bytes += size;
      }
      return { status: 'extracted', result: { source: { ...source }, plugin: { id: 'material.ocr', version: '1' },
        textReference: extracted.textReference, evidenceReference: extracted.evidenceReference,
        segments, segmentCount: extracted.segments.length, segmentsTruncated: segments.length !== extracted.segments.length } };
    },
  };
}
