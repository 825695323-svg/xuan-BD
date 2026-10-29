import type { JsonValue, TaskRecord } from '../../contracts/task-contracts.js';
import { digestOperationArgs } from '../security/permissions.js';
import type { RoutedAction, SkillAvailability, SkillDescriptor, SkillField } from '../../contracts/skill-contracts.js';
import { TaskError } from '../jobs/tasks.js';

export class SkillError extends TaskError {
  constructor(code: string, message: string) { super(code, message); this.name = 'SkillError'; }
}

export interface SkillRegistration extends Omit<SkillDescriptor, 'availability'> {
  available(): SkillAvailability;
  fieldsForRequest?(): SkillField[];
  validate?(args: Record<string, JsonValue>): void;
}

/** 同一份 fields 同时用于界面表单与基础参数校验；注册表不执行动作或推断文本意图。 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillRegistration>();
  private readonly versionResolvers = new Map<string, (args: Record<string, JsonValue>, task?: TaskRecord) => Record<string, string | null>>();

  constructor(registrations: readonly SkillRegistration[]) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: SkillRegistration): void {
      if (!/^[a-z][a-z0-9._-]+$/u.test(registration.action) || this.skills.has(registration.action)) {
        throw new SkillError('INVALID_SKILL', '技能动作编号无效或重复。');
      }
      const keys = new Set<string>();
      for (const field of registration.fields) {
        if (!field.key || keys.has(field.key)) throw new SkillError('INVALID_SKILL', '技能字段编号重复。');
        keys.add(field.key);
        if (field.type === 'select' && (!field.options || field.options.some((option) => typeof option.value !== 'string'))) {
          throw new SkillError('INVALID_SKILL', '选择字段需要明确选项。');
        }
      }
      this.skills.set(registration.action, { ...registration, fields: structuredClone(registration.fields), permissionSummary: [...registration.permissionSummary] });
  }

  list(): SkillDescriptor[] { return [...this.skills.keys()].map((action) => this.get(action)); }

  /** 仅宿主装配登记；表单、模型参数及任务命令不能提交或替换依赖版本。 */
  bindVersions(action: string, resolve: (args: Record<string, JsonValue>, task?: TaskRecord) => Record<string, string | null>): void {
    if (this.registration(action).runtimeId !== 'direct' || this.versionResolvers.has(action)) throw new SkillError('DIRECT_VERSION_REGISTRATION', '直接动作的依赖解析器无效或重复。');
    this.versionResolvers.set(action, resolve);
  }
  captureVersions(action: string, args: JsonValue, task?: TaskRecord): Record<string, string | null> {
    const resolve = this.versionResolvers.get(action);
    if (!resolve || !args || typeof args !== 'object' || Array.isArray(args)) throw new SkillError('DIRECT_VERSION_UNAVAILABLE', '直接动作尚无受信依赖版本，不能接收新任务。');
    return structuredClone(resolve(args, task));
  }
  assertTaskVersions(task: TaskRecord): void {
    if (task.runtimeId !== 'direct') throw new SkillError('RUNTIME_MISMATCH', '依赖核对只接受原直接任务。');
    if (task.versions.directContract !== 'direct-dependencies/1') throw new SkillError('DIRECT_VERSION_MISSING', '旧直接任务没有完整依赖版本；保留原输入和事实，请明确建立关联新任务，不能补用当前版本。');
    const expected = this.captureVersions(task.action, task.args, task);
    // 模型桥有自己的附加绑定；基础动作只核本宿主解析出的精确字段集合。
    const actual = Object.fromEntries(Object.entries(task.versions).filter(([key]) => !key.startsWith('directModel')));
    if (digestOperationArgs(expected) !== digestOperationArgs(actual)) throw new SkillError('DIRECT_VERSION_CONFLICT', '原直接任务的实现、资源或相关配置已变化；原输入、请求与事实已保留，不能换版继续。');
  }

  get(action: string): SkillDescriptor {
    const skill = this.registration(action);
    return structuredClone({ action: skill.action, runtimeId: skill.runtimeId, kind: skill.kind, title: skill.title,
      description: skill.description, fields: skill.fieldsForRequest?.() ?? skill.fields, permissionSummary: skill.permissionSummary,
      availability: skill.available(), modelCalls: skill.modelCalls });
  }

  route(input: { action: string; args: unknown }): RoutedAction {
    const skill = this.registration(input.action);
    const availability = skill.available();
    if (!availability.available) throw new SkillError('SKILL_UNAVAILABLE', availability.reason ?? '此动作当前不可用。');
    if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) throw new SkillError('INVALID_ARGS', '动作参数需要是字段对象。');
    const source = input.args as Record<string, unknown>;
    const fields = skill.fieldsForRequest?.() ?? skill.fields;
    if (Object.keys(source).some((key) => !fields.some((field) => field.key === key))) {
      throw new SkillError('INVALID_ARGS', '动作包含未定义的参数。');
    }
    const args: Record<string, JsonValue> = {};
    for (const field of fields) {
      const value = source[field.key];
      if (value === undefined || (value === '' && !(field.type === 'text' && field.allowEmpty))) {
        if (field.required) throw new SkillError('INVALID_ARGS', `请填写${field.label}。`);
        continue;
      }
      validateField(field, value);
      args[field.key] = value as string | number;
    }
    skill.validate?.(args);
    return { runtimeId: skill.runtimeId, action: skill.action, args };
  }

  private registration(action: string): SkillRegistration {
    const skill = this.skills.get(action);
    if (!skill) throw new SkillError('UNKNOWN_ACTION', '没有此确定性动作，请选择已有动作。');
    return skill;
  }
}

function validateField(field: SkillField, value: unknown): void {
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (field.minimum ?? 0) || value > (field.maximum ?? Number.MAX_SAFE_INTEGER)) {
      throw new SkillError('INVALID_ARGS', `${field.label}超出允许范围。`);
    }
    return;
  }
  if (typeof value !== 'string' || (!(field.type === 'text' && field.allowEmpty) && !value.trim()) || value.length > (field.maxLength ?? 4096) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    throw new SkillError('INVALID_ARGS', `${field.label}无效。`);
  }
  if (field.type === 'select' && !field.options?.some((option) => option.value === value)) throw new SkillError('INVALID_ARGS', `请选择已有的${field.label}。`);
  if ((field.type === 'file' || field.type === 'directory') && (value.length > 256 || /[\s/\\]/u.test(value))) throw new SkillError('INVALID_ARGS', `${field.label}需要已登记的引用编号。`);
}
