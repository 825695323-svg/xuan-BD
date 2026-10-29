import type { AgentSkillService } from '../agent-skills.js';

/** 旧内置技能只保留不可变历史；固定能力不依赖技能开关，扩展须显式安装。 */
const FORMER_BUILTIN_SOURCES = new Set([
  'mashiro:agent-skill/organize-material', 'mashiro:agent-skill/plan-action',
  'xuan-harness:reviewed-skill/baidu-drive', 'xuan-harness:reviewed-skill/bb-browser@1',
  'xuan-harness:reviewed-skill/mac-transcribe-file@4', 'xuan-harness:reviewed-skill/image-ocr@2',
]);
export function retireFormerBuiltinAgentSkills(service: AgentSkillService): void {
  for (const skill of service.list()) {
    if (skill.enabled && skill.source.kind === 'builtin' && FORMER_BUILTIN_SOURCES.has(skill.source.identifier)) {
      service.setEnabled(skill.id, false, skill.currentRevision);
    }
  }
}
