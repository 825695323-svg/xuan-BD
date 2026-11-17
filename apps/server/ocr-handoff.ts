import type { ApplicationServices } from './services.js';
import { readMediaReviewHandoff } from './media-review-handoff.js';

export const readOcrReviewHandoff = (services: ApplicationServices, materialId: string, taskId: string, questionId?: string) =>
  readMediaReviewHandoff(services, materialId, taskId, 'ocr', questionId);
