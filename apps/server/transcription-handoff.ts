import type { ApplicationServices } from './services.js';
import { readMediaReviewHandoff } from './media-review-handoff.js';
import { CoreError } from '../../platform/runtime/errors.js';

export async function readTranscriptionReviewHandoff(services: ApplicationServices, materialId: string, taskId: string, questionId?: string) {
  try { return await readMediaReviewHandoff(services, materialId, taskId, 'transcription', questionId); }
  catch (error) {
    if (error instanceof CoreError && error.code === 'OCR_HANDOFF_UNAVAILABLE') throw new CoreError('TRANSCRIPTION_HANDOFF_UNAVAILABLE', error.message, error.status);
    throw error;
  }
}
