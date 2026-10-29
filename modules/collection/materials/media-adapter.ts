import type { DirectRuntimeBundle } from '../../../contracts/direct-runtime.js';
import { DirectError } from '../../../platform/runtime/file-workspace.js';
import { DirectProcessError } from '../../../platform/runtime/process.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import type { MaterialMediaAdapter } from './plugins.js';
import { transcriptionSegmentPreview } from '../../../platform/capabilities/transcription/local.js';

/** 薄适配器只连接现有 Direct 受控转录；不修改任务身份，不调用额外模型。 */
export function createMaterialTranscriptionAdapter(executor: () => DirectRuntimeBundle['localTranscription'] | undefined): MaterialMediaAdapter {
  return {
    id: 'material.transcribe', version: '1', acceptedFormats: ['audio', 'video'],
    availability: () => executor()?.availability() ?? { available: false, reason: '受控本机转录执行器尚未装配。' },
    async execute(source, context) {
      const selected = executor();
      if (!selected || !selected.availability().available) return { status: 'not_configured', reason: selected?.availability().reason ?? '受控本机转录组件尚未装配。', result: null };
      if (context.task.action !== 'material.transcribe' || !/^[a-f0-9]{64}$/u.test(source.sha256)) throw new TaskError('MATERIAL_BINDING_MISMATCH', '媒体适配器需要当前材料任务和已核对的原件摘要。');
      try {
        const extracted = await selected.execute(context, { fileRefId: source.fileRefId, fileRefVersion: source.fileRefVersion, expectedSha256: source.sha256 });
        return { status: 'extracted', result: { source: { ...source }, plugin: { id: 'material.transcribe', version: '1' },
          textReference: extracted.textReference, evidenceReference: extracted.evidenceReference, ...transcriptionSegmentPreview(extracted.segments) } };
      } catch (error) {
        // 未确认副作用必须继续交给 TaskService 判为 needs_review，不能包装成普通失败。
        if (context.signal.aborted || error instanceof DirectError && error.unknown || error instanceof DirectProcessError && error.disposition === 'unknown') throw error;
        if (!(error instanceof TaskError)) throw error;
        return { status: error.code === 'EMPTY_TRANSCRIPT' ? 'empty' : 'failed', code: error.code, reason: error.message, result: null };
      }
    },
  };
}
