import type { CoreDatabase } from '../../platform/state/database.js';
import { CoreError } from '../../platform/runtime/errors.js';

export type InputMatcher = 'video-url' | 'transcribe-command' | 'open-command' | 'read-command' | 'audio-attachment';
export interface InputRule { id: string; title: string; description: string; matcher: InputMatcher; enabled: boolean; priority: number; revision: number }
const DEFAULTS: Omit<InputRule, 'revision'>[] = [
  { id: 'video-link', title: '公开视频链接', description: '单独发送 YouTube 或哔哩哔哩链接时，优先提取字幕，再按需本机转录。', matcher: 'video-url', enabled: true, priority: 10 },
  { id: 'transcribe-file', title: '明确转录指令', description: '输入“转录 /绝对路径”或“/转录 @文件编号”时，直接创建本机转录任务。', matcher: 'transcribe-command', enabled: true, priority: 20 },
  { id: 'open-file', title: '明确打开指令', description: '输入“打开文件 /绝对路径”时，直接请求系统打开文件。', matcher: 'open-command', enabled: true, priority: 30 },
  { id: 'read-file', title: '明确读取指令', description: '输入“读取文件 /绝对路径”时，直接读取文本并在任务中展示。', matcher: 'read-command', enabled: true, priority: 40 },
  { id: 'audio-upload', title: '音频附件', description: '上传音频后，在会话空闲时直接创建本机转录任务；仍逐项申请文件和执行权限。', matcher: 'audio-attachment', enabled: true, priority: 50 },
];
export class InputRuleService {
  constructor(private readonly database: CoreDatabase) {
    database.migrate('input_rules', 1, 'CREATE TABLE input_rules (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, priority INTEGER NOT NULL, revision INTEGER NOT NULL);');
    for (const value of DEFAULTS) database.connection.prepare('INSERT OR IGNORE INTO input_rules VALUES(?,?,?,1)').run(value.id, Number(value.enabled), value.priority);
  }
  list(): InputRule[] { return DEFAULTS.map((definition) => {
    const row = this.database.connection.prepare('SELECT enabled,priority,revision FROM input_rules WHERE id=?').get(definition.id)!;
    return { ...definition, enabled: !!row.enabled, priority: Number(row.priority), revision: Number(row.revision) };
  }).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)); }
  update(id: string, input: { enabled: boolean; priority: number; revision: number }): InputRule {
    if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 999 || !Number.isSafeInteger(input.revision)) throw new CoreError('INVALID_RULE', '规则状态、顺序或版本无效。', 400);
    if (!DEFAULTS.some((rule) => rule.id === id)) throw new CoreError('RULE_NOT_FOUND', '没有此输入规则。', 404);
    const result = this.database.connection.prepare('UPDATE input_rules SET enabled=?,priority=?,revision=revision+1 WHERE id=? AND revision=?').run(Number(input.enabled), input.priority, id, input.revision);
    if (result.changes !== 1) throw new CoreError('RULE_CONFLICT', '输入规则已变化，请重新读取。', 409);
    return this.list().find((rule) => rule.id === id)!;
  }
  match(text: string): { rule: InputRule; action: string; value: string; isReference: boolean } | null {
    const input = text.trim();
    for (const rule of this.list()) {
      if (!rule.enabled) continue;
      if (rule.matcher === 'video-url' && /^https:\/\/[^\s]+$/u.test(input)) {
        try { const url = new URL(input); if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'].includes(url.hostname.toLowerCase())) return { rule, action: 'video.transcribe_url', value: input, isReference: false }; } catch { /* 非链接留给普通输入。 */ }
      }
      const pattern = rule.matcher === 'transcribe-command' ? /^(?:\/转录|转录)\s+(.+)$/u : rule.matcher === 'open-command' ? /^打开文件\s+(.+)$/u : rule.matcher === 'read-command' ? /^读取文件\s+(.+)$/u : null;
      const match = pattern?.exec(input);
      if (match && (match[1]!.startsWith('/') || /^@[a-zA-Z0-9-]+$/u.test(match[1]!))) return { rule, action: rule.matcher === 'transcribe-command' ? 'audio.transcribe' : rule.matcher === 'open-command' ? 'file.open' : 'file.read', value: match[1]!, isReference: match[1]!.startsWith('@') };
    }
    return null;
  }
}
