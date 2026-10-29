import type { AgentSkillDefinition, AgentSkillRecord } from './agent-skill-contracts.js';

export type PersonalResourceKind = 'persona' | 'identity' | 'rule';
export interface PersonalResourceSource {
  kind: 'import' | 'user'; identifier: string; revision: string; contentHash: string; originalPath?: string;
}
export interface PersonalResourceDefinition {
  id: string; profileId: string; kind: PersonalResourceKind; title: string; version: number;
  body: string; originalBody: string; source: PersonalResourceSource; adaptationNotes: string[]; enabled?: boolean;
}
export interface PersonalResourceRecord extends Omit<PersonalResourceDefinition, 'enabled'> {
  digest: string; enabled: boolean; currentRevision: number; latest: boolean; createdAt: string; updatedAt: string;
}
export interface PersonaSelection {
  personaId: string | null; personaVersion: number | null; revision: number; updatedAt: string;
}
export interface PersonalResourceContext {
  text: string; records: Array<{ id: string; version: number; digest: string }>; warnings: string[];
}
export interface ResourceImportPreview {
  directory: string; digest: string; profileId: string; resources: PersonalResourceDefinition[];
  skills: AgentSkillDefinition[]; warnings: string[]; skipped: string[]; fileCount: number; totalBytes: number;
}
export interface ResourceImportResult {
  digest: string; resources: PersonalResourceRecord[]; skills: AgentSkillRecord[]; warnings: string[];
}
