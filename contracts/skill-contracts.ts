import type { JsonValue } from './task-contracts.js';

export interface SkillField {
  key: string;
  label: string;
  type: 'file' | 'directory' | 'text' | 'select' | 'number';
  required?: boolean;
  /** 文本内容字段可明确保留空串或空白；路径与选择字段仍要求有效值。 */
  allowEmpty?: boolean;
  options?: { value: string; label: string }[];
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface SkillAvailability { available: boolean; reason?: string }
export interface SkillDescriptor {
  action: string;
  runtimeId: string;
  kind: 'direct' | 'agent' | 'external';
  title: string;
  description: string;
  fields: SkillField[];
  permissionSummary: string[];
  availability: SkillAvailability;
  modelCalls: 0 | 1 | null;
}
export interface RoutedAction { runtimeId: string; action: string; args: JsonValue }
