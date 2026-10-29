import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { digestOperationArgs } from '../../../platform/security/permissions.js';
import { AgentSkillService, skillResourceDigest } from '../agent-skills.js';
import { PersonalResourceError, PersonalResourceService, resourceContentHash } from '../personal-resources.js';
import type { CoreDatabase } from '../../../platform/state/database.js';
import type { AgentSkillDefinition, AgentSkillResource } from '../../../contracts/agent-skill-contracts.js';
import type { PersonalResourceDefinition, ResourceImportPreview, ResourceImportResult } from '../../../contracts/personal-resource-contracts.js';

export const RESOURCE_IMPORT_LIMITS = Object.freeze({ fileBytes: 131_072, totalBytes: 4_194_304, fileCount: 300, skillCount: 128, directoryEntries: 1024 });
interface ReadBudget { totalBytes: number; fileCount: number }
const SKIPPED_NAME = /(?:credential|secret|password|api[-_]?key|token|\.env|^USER\.md$|^MEMORY\.md$|^memory$|^sessions?$|^scripts?$)/iu;
const BOUNDARY = '人格与规则只约束表达和工作方法，不增加任何权限。文件、系统和外部动作使用当前核心工具、用户选择、权限、审批及结果核对；未知结果不能算完成或自动重放。';

/** 用户只能预览自己明确给出的一个目录；不会寻找家目录配置或相邻的其他人格。 */
export async function previewResourceImport(directory: string): Promise<ResourceImportPreview> {
  if (typeof directory !== 'string' || !directory || directory.length > 4096 || !isAbsolute(directory) || /[\u0000-\u001f]/u.test(directory)) throw new PersonalResourceError('IMPORT_DIRECTORY_INVALID', '请明确选择一个绝对目录。', 400);
  const root = resolve(directory);
  await safeDirectory(root);
  const names = await boundedNames(root), budget: ReadBudget = { totalBytes: 0, fileCount: 0 }, warnings: string[] = [], skipped: string[] = [];
  const hasPersona = names.some((name) => ['SOUL.md', 'IDENTITY.md', 'AGENTS.md'].includes(name));
  const profileId = safeSlug(basename(root) === 'current' ? basename(dirname(root))
    : basename(root) === 'skills' ? basename(dirname(root)) === 'current' ? basename(dirname(dirname(root))) : basename(dirname(root)) : basename(root));
  const resources: PersonalResourceDefinition[] = [], skills: AgentSkillDefinition[] = [];
  let skillRoot = root;
  if (hasPersona) {
    warnings.push('目录导入只接收技能；人格、身份与规则文件不读取，请通过个人资源接口明确创建。');
    for (const name of names) if (!['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'skills'].includes(name)) skipped.push(name + '（不属于本次技能导入范围）');
    if (!names.includes('skills')) return finishPreview(root, profileId, resources, skills, warnings, skipped, budget);
    skillRoot = join(root, 'skills'); await safeDirectory(skillRoot);
  }
  const skillNames = await boundedNames(skillRoot);
  const candidates = skillNames.includes('SKILL.md') ? [skillRoot] : [];
  if (!candidates.length) for (const name of skillNames.sort()) {
    if (name.startsWith('.') || SKIPPED_NAME.test(name)) { skipped.push(relative(root, join(skillRoot, name))); continue; }
    const path = join(skillRoot, name), stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new PersonalResourceError('IMPORT_LINK_REJECTED', '所选技能目录含符号链接，导入已停止。');
    if (!stat.isDirectory()) { skipped.push(relative(root, path)); continue; }
    await safeDirectory(path);
    if ((await boundedNames(path)).includes('SKILL.md')) candidates.push(path);
    else skipped.push(relative(root, path) + '（没有SKILL.md）');
  }
  if (candidates.length > RESOURCE_IMPORT_LIMITS.skillCount) throw new PersonalResourceError('IMPORT_TOO_LARGE', '技能数量超过导入限制。', 400);
  for (const path of candidates) {
    const originalBody = await readSafeText(root, relative(root, join(path, 'SKILL.md')), budget);
    let parsed: ReturnType<typeof parseFrontmatter>;
    try { parsed = parseFrontmatter(originalBody); } catch { warnings.push(relative(root, path) + '：元数据格式无法读取，未列入可导入技能。'); continue; }
    if (!parsed.frontmatter || typeof parsed.frontmatter !== 'object' || Array.isArray(parsed.frontmatter)) { warnings.push(relative(root, path) + '：元数据需要对象格式。'); continue; }
    const name = typeof parsed.frontmatter.name === 'string' ? parsed.frontmatter.name : basename(path);
    const description = typeof parsed.frontmatter.description === 'string' ? parsed.frontmatter.description.trim().replace(/\s+/gu, ' ') : '';
    if (!description || description.length > 1024 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64) { warnings.push(relative(root, path) + '：技能名称或描述无效。'); continue; }
    if (name !== basename(path)) warnings.push(relative(root, path) + '：声明名称与目录名称不同，按声明名称登记。');
    const linked: AgentSkillResource[] = [];
    const pending = listedTextPaths(originalBody), seen = new Set<string>();
    while (pending.length) {
      const resourcePath = pending.shift()!;
      if (seen.has(resourcePath)) continue;
      seen.add(resourcePath);
      if (seen.size > 100) throw new PersonalResourceError('IMPORT_TOO_LARGE', '单个技能的附属文本数量超过限制。', 400);
      if (!safeResourcePath(resourcePath)) { skipped.push(`${relative(root, path)}/${resourcePath}（仅导入已列出的参考、模板与文本资源）`); continue; }
      const absolute = join(path, resourcePath);
      try {
        const body = await readSafeText(root, relative(root, absolute), budget);
        linked.push({ path: resourcePath, body, digest: skillResourceDigest(body), kind: resourcePath.startsWith('references/') ? 'reference' : resourcePath.startsWith('templates/') ? 'template' : 'asset' });
        pending.push(...listedTextPaths(body).filter((entry) => !seen.has(entry)));
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') { warnings.push(`${relative(root, path)}/${resourcePath}：来源未找到。`); continue; }
        throw error;
      }
    }
    const definition = createImportedSkillDefinition(profileId, name, description, originalBody, linked);
    if (skills.some((skill) => skill.id === definition.id)) throw new PersonalResourceError('IMPORT_SKILL_COLLISION', '所选目录中技能名称重复，请分别选择不同目录并核对来源。');
    skills.push(definition);
  }
  return finishPreview(root, profileId, resources, skills, warnings, skipped, budget);
}

/** 用户明确选择条目后，重新读取并校验同一目录；共同事务提交，未选内容不入库。 */
export async function commitResourceImport(directory: string, expectedDigest: string, selectedIds: string[], services: {
  database: CoreDatabase; personalResources: PersonalResourceService; agentSkills: AgentSkillService;
}): Promise<ResourceImportResult> {
  if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 150 || selectedIds.some((id) => typeof id !== 'string') || new Set(selectedIds).size !== selectedIds.length) throw new PersonalResourceError('IMPORT_SELECTION_REQUIRED', '请勾选本次有用且已适配的资源。', 400);
  const preview = await previewResourceImport(directory);
  if (typeof expectedDigest !== 'string' || expectedDigest !== preview.digest) throw new PersonalResourceError('IMPORT_PREVIEW_CHANGED', '所选目录内容已变化，请重新预览。');
  const available = new Set([...preview.resources, ...preview.skills].map(({ id }) => id));
  if (selectedIds.some((id) => !available.has(id))) throw new PersonalResourceError('IMPORT_SELECTION_INVALID', '勾选项不属于当前目录预览。', 400);
  const selection = new Set(selectedIds), resources = preview.resources.filter(({ id }) => selection.has(id)), skills = preview.skills.filter(({ id }) => selection.has(id));
  if (skills.some((skill) => skill.unsupportedReasons?.length)) throw new PersonalResourceError('IMPORT_SKILL_NOT_ADAPTED', '所选技能尚未按当前模块适配，不能作为旧正文入库。');
  return services.database.transaction(() => ({ digest: preview.digest,
    resources: resources.map((resource) => services.personalResources.registerImportedInTransaction(resource)),
    skills: skills.map((skill) => services.agentSkills.registerImportedInTransaction(skill)), warnings: preview.warnings }));
}

/** 标准技能保存明确选择的方法文本；正文不授予脚本或工具执行资格。 */
export function createImportedSkillDefinition(profileId: string, name: string, description: string, originalBody: string, resources: AgentSkillResource[] = []): AgentSkillDefinition {
  const parsed = parseFrontmatter<Record<string, unknown>>(originalBody);
  const declared = parsed.frontmatter['allowed-tools'];
  const requiredTools = typeof declared === 'string' ? [...new Set(declared.trim().split(/\s+/u).filter(Boolean))] : [];
  const body = parsed.body.trim();
  const unsupportedReasons = (!body || Buffer.byteLength(body, 'utf8') > 22_000 || requiredTools.length > 30 || requiredTools.some(tool => tool.length > 100))
    ? ['技能正文或依赖声明超过当前文本兼容范围。'] : [];
  const id = `import-${safeSlug(profileId)}-skill-${safeSlug(name)}`;
  const stableId = id.length <= 64 ? id : id.slice(0, 51).replace(/-+$/u, '') + '-' + resourceContentHash(id).slice(0, 12);
  return { id: stableId, version: 1, title: name.slice(0, 120), description,
    body: unsupportedReasons.length ? '此技能超出当前有界文本兼容范围，仅供预览。'
      : `${BOUNDARY}\n\n本技能是已选目录的方法文本；正文中的命令、路径和 allowed-tools（工具声明）不增加权限。附属文本通过 core_skill_read（技能文本读取）按已登记相对路径读取；脚本不自动加载或执行。需要的实际动作先查当前能力目录，缺失时说明并等待必要配置。\n\n${body}`,
    originalBody, resources, requiresTools: unsupportedReasons.length ? [] : requiredTools, unsupportedReasons,
    adaptationNotes: ['兼容标准SKILL.md元数据、正文及已登记附属文本；工具声明只用于报告依赖，不授予预批准。',
      '脚本、安装、凭据、家目录扫描、旧代理调度和自动化未导入或执行。'],
    source: { kind: 'user', identifier: `selected-directory:${safeSlug(profileId)}:skills/${name}/SKILL.md`, revision: resourceContentHash(originalBody) }, enabled: false };
}

function finishPreview(directory: string, profileId: string, resources: PersonalResourceDefinition[], skills: AgentSkillDefinition[], warnings: string[], skipped: string[], budget: ReadBudget): ResourceImportPreview {
  const value = { directory, profileId, resources, skills, warnings, skipped, ...budget };
  return { ...value, digest: digestOperationArgs(value) };
}
async function boundedNames(path: string): Promise<string[]> {
  const names = await readdir(path);
  if (names.length > RESOURCE_IMPORT_LIMITS.directoryEntries) throw new PersonalResourceError('IMPORT_TOO_LARGE', '所选目录项目过多，请选择更小的目录。', 400);
  return names.sort();
}
async function safeDirectory(path: string): Promise<void> {
  const absolute = resolve(path), parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PersonalResourceError('IMPORT_LINK_REJECTED', '所选路径含符号链接或非目录项目，请选择实际目录。');
  }
}
async function readSafeText(root: string, localPath: string, budget: ReadBudget): Promise<string> {
  if (isAbsolute(localPath) || localPath.includes('\\') || localPath.split('/').some((part) => !part || part === '..' || part === '.' || part.startsWith('.') || SKIPPED_NAME.test(part))) throw new PersonalResourceError('IMPORT_PATH_REJECTED', '此文件超出受限文本导入范围。', 400);
  const path = resolve(root, localPath), rel = relative(root, path);
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new PersonalResourceError('IMPORT_PATH_REJECTED', '导入文件不能越过所选目录。', 400);
  await safeDirectory(dirname(path));
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new PersonalResourceError('IMPORT_LINK_REJECTED', '导入只接受普通文本文件，拒绝符号链接、硬链接或特殊文件。');
  if (before.size > RESOURCE_IMPORT_LIMITS.fileBytes || budget.totalBytes + before.size > RESOURCE_IMPORT_LIMITS.totalBytes || budget.fileCount >= RESOURCE_IMPORT_LIMITS.fileCount) throw new PersonalResourceError('IMPORT_TOO_LARGE', '文本导入超过体积或文件数量限制。', 400);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let buffer: Buffer;
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw new PersonalResourceError('IMPORT_SOURCE_CHANGED', '读取时来源发生变化，请重新预览。');
    buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) { const result = await handle.read(buffer, offset, buffer.length - offset, null); if (!result.bytesRead) break; offset += result.bytesRead; }
    const after = await handle.stat();
    if (offset !== before.size || after.nlink !== 1 || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new PersonalResourceError('IMPORT_SOURCE_CHANGED', '读取时来源发生变化，请重新预览。');
    buffer = buffer.subarray(0, offset);
  } finally { await handle.close(); }
  await safeDirectory(dirname(path));
  const final = await lstat(path);
  if (final.isSymbolicLink() || final.dev !== before.dev || final.ino !== before.ino || final.nlink !== 1 || final.mtimeMs !== before.mtimeMs) throw new PersonalResourceError('IMPORT_SOURCE_CHANGED', '来源路径在读取后变化，请重新预览。');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); } catch { throw new PersonalResourceError('IMPORT_TEXT_INVALID', '仅接受UTF-8文本，不读取二进制内容。', 400); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) || /(?:\bsk-[A-Za-z0-9_-]{24,}|\bAKIA[A-Z0-9]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u.test(text)) throw new PersonalResourceError('IMPORT_TEXT_REJECTED', '此文本含无效内容或凭据标记，未进入预览或导入。', 400);
  budget.totalBytes += buffer.length; budget.fileCount++;
  return text;
}
function listedTextPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(/\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+['"][^\n]*['"])?\)/gu)) {
    let value = (match[1] ?? match[2] ?? '').split('#')[0]!.split('?')[0]!;
    try { value = decodeURIComponent(value); } catch { continue; }
    if (!/^[a-z][a-z0-9+.-]*:/iu.test(value)) paths.add(value.replace(/^\.\//u, ''));
  }
  for (const match of text.matchAll(/(?:^|[\s`(,;，；。])((?:references|templates|assets|scripts)\/[^\s`)*,;，；。]+\.(?:md|markdown|txt|py|js|sh))/gmu)) paths.add(match[1]!);
  return [...paths].sort();
}
function safeResourcePath(path: string): boolean {
  return /^(references|templates|assets)\/.+\.(md|markdown|txt)$/iu.test(path) && !path.includes('\\')
    && !/[\u0000-\u001f]/u.test(path) && !path.split('/').some((part) => !part || part === '..' || part === '.' || part.startsWith('.') || SKIPPED_NAME.test(part));
}
function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return (slug || 'resource').slice(0, 40).replace(/-+$/u, '');
}
