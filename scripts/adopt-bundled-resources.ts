import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BundledResources, type BundledCapability } from '../platform/resources/bundled.js';
import { ResourceBindings, type MachineBindingDocument } from '../platform/resources/bindings.js';
import { readRuntimeLauncher, assertRuntimeStopped } from '../platform/runtime/runtime-profile.js';
import { ownStateRoot } from '../apps/server/boot.js';
import { CoreDatabase } from '../platform/state/database.js';
import { ToolSettingsService } from '../platform/config/tool-settings.js';
import { parseModelConfiguration } from '../platform/config/model.js';

type Row = Record<string, any>;
type Capability = BundledCapability | 'model' | 'sources';
type ExpectedRoot = { runtimeRoot: string; runtimeIdentity: string; expectedRevision: number; browserHome?: string; expectedModelSha256?: string };
export interface BundledAdoptionRequest {
  codeRoot: string; launcherFile: string; recordRoot: string; expectedManifestSha256: string;
  /** 本次明确选择的来源开发包：资源名到唯一发行清单中的文件路径。 */
  sourceFiles?: Record<string, string>;
  enableModelImages?: true;
  root: ExpectedRoot;
}
type DatabasePlan = { path: string; beforeSettings: Row[]; afterSettings: Row[]; protectedState?: string };
type RootPlan = ExpectedRoot & { before: string; after?: string; mode: number; uid: number; gid: number; bindingChanged: boolean; capabilities: Capability[]; databases: DatabasePlan[];
  model?: { path: string; before: string; after: string; mode: number; uid: number; gid: number } };
type Journal = { version: 1; id: string; phase: 'preparing' | 'prepared' | 'committed'; requestSha256: string; manifestSha256: string; launcherSha256: string; root: RootPlan };
const encode = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { integer: String(item) }
  : item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const fail = (message: string): never => { throw new Error(message); };
function absolute(path: string): string { if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.includes('\0')) fail('维护位置必须是规范绝对路径。'); return path; }
function directory(path: string): void { absolute(path); const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) fail('维护目录必须是真实普通目录。'); }
function inside(parent: string, path: string): boolean { const part = relative(parent, path); return !part || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)); }
function pinned(path: string): string {
  absolute(path); directory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = fstatSync(fd, { bigint: true }); if (!before.isFile() || before.nlink !== 1n || before.size > 16_777_216n) fail('维护记录必须是有界普通单链接文件。');
    const raw = readFileSync(fd, 'utf8'), after = fstatSync(fd, { bigint: true });
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('维护记录在读取期间变化。'); return raw;
  } finally { closeSync(fd); }
}
function atomic(path: string, raw: string, expected: string | null, mode = 0o600, owner?: { uid: number; gid: number }): void {
  directory(dirname(path)); const temporary = path + '.bundled-' + randomUUID();
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { const stat = fstatSync(fd); if (owner && (stat.uid !== owner.uid || stat.gid !== owner.gid)) fail('临时文件不能保持原所有者和组。');
    fchmodSync(fd, mode); writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if (expected === null ? lstatSync(path, { throwIfNoEntry: false }) : sha(pinned(path)) !== expected) fail('维护记录已变化，拒绝覆盖。');
    renameSync(temporary, path); const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary); }
}
function documentAt(root: RootPlan): MachineBindingDocument {
  directory(root.runtimeRoot); const marker = JSON.parse(pinned(join(root.runtimeRoot, '.xuan-runtime.json'))), raw = pinned(join(root.runtimeRoot, 'config/machine.bindings.json'));
  if (raw !== root.before && raw !== root.after) fail('原绑定已出现本维护范围之外的变化。');
  const document = JSON.parse(raw) as MachineBindingDocument;
  if (marker.application !== 'xuan-harness' || marker.version !== 1 || marker.identity !== root.runtimeIdentity || document.runtimeIdentity !== root.runtimeIdentity
    || document.version !== 1 || !document.resources || ![root.expectedRevision, root.expectedRevision + 1].includes(document.revision)) fail('运行根身份或原修订不符。');
  if (root.model && (root.model.path !== join(resolve(root.runtimeRoot, document.resources.config!.path), 'model.json')
    || ![root.model.before, root.model.after].includes(pinned(root.model.path)))) fail('模型配置出现本次明确图像声明之外的变化。');
  const owned: string[] = [];
  for (const [key, binding] of Object.entries(document.resources)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || !binding || typeof binding.path !== 'string' || !binding.path || binding.path.includes('\0') || !['directory', 'file', 'program'].includes(binding.kind)) fail('原资源绑定格式无效。');
    if (!isAbsolute(binding.path) && (/[\\:\u0000-\u001f]/u.test(binding.path) || binding.path.split('/').some(part => !part || part === '.' || part === '..'))) fail('原资源相对路径无效。');
    if (!binding.owned) continue;
    const path = resolve(root.runtimeRoot, binding.path); directory(path); const stat = lstatSync(path, { bigint: true });
    if (binding.kind !== 'directory' || !binding.identity || String(stat.dev) !== binding.device || String(stat.ino) !== binding.inode
      || owned.some(other => inside(other, path) || inside(path, other))) fail('原受管理资源身份不符或重叠。'); owned.push(path);
  }
  return document;
}
const quoted = (value: string) => '"' + value.replaceAll('"', '""') + '"';
function protectedState(db: DatabaseSync): string {
  const hash = createHash('sha256');
  hash.update(encode(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()));
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'tool_settings' ORDER BY name").all()) {
    hash.update(String(row.name)); const statement = db.prepare(`SELECT * FROM ${quoted(String(row.name))}`); statement.setReadBigInts(true);
    for (const item of statement.iterate()) hash.update(encode(item) + '\n');
  }
  return hash.digest('hex');
}
function settings(db: DatabaseSync): Row[] { return db.prepare('SELECT * FROM tool_settings ORDER BY id').all(); }
function databasePaths(root: string, document: MachineBindingDocument): string[] {
  const binding = document.resources.state; if (!binding?.owned || binding.kind !== 'directory') fail('状态位置必须沿用原受管理目录。');
  const state = resolve(root, binding!.path); directory(state);
  const paths: string[] = [];
  for (const entry of readdirSync(state, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail('状态角色不能穿过符号链接。');
    if (!entry.isDirectory()) continue;
    const path = join(state, entry.name, 'core.sqlite'), stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('原状态必须是已有普通单链接数据库。');
    paths.push(path);
  }
  if (!paths.length && readdirSync(state).length) fail('状态位置非空但没有可核对的原账；请先明确核对或归档原对象。');
  return paths.sort();
}
function databasePlan(path: string, model: string): DatabasePlan {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (Number(db.prepare("SELECT version FROM schema_versions WHERE module='tool_settings'").get()?.version) !== 1) fail('原工具设置结构尚未就绪；维护不代替结构升级。');
    const beforeSettings = settings(db); if (beforeSettings.length !== 1) fail('原工具设置没有唯一记录。');
    const value = JSON.parse(beforeSettings[0]!.body), changed = value.whisperModelPath !== model;
    const afterSettings = changed ? [{ ...beforeSettings[0], revision: Number(beforeSettings[0]!.revision) + 1, body: JSON.stringify({ ...value, whisperModelPath: model }) }] : beforeSettings;
    return { path, beforeSettings, afterSettings, ...(changed ? { protectedState: protectedState(db) } : {}) };
  } finally { db.close(); }
}
function assertDatabase(db: DatabaseSync, plan: DatabasePlan): void {
  if (plan.protectedState && protectedState(db) !== plan.protectedState) fail('工具设置以外的状态已变化，不能续接维护。');
  if (![encode(plan.beforeSettings), encode(plan.afterSettings)].includes(encode(settings(db)))) fail('工具设置出现维护范围外变更。');
}
function affected(action: string | undefined, capabilities: readonly Capability[]): boolean {
  if (!capabilities.length) return false;
  if (capabilities.includes('application')) return true;
  if (capabilities.length === 1 && capabilities[0] === 'sources') return action?.startsWith('source.') === true;
  if (action === 'browser.control' || action === 'web.read_public' || action?.startsWith('capture.')) return capabilities.includes('browser');
  if (['audio.transcribe', 'video.transcribe_url', 'media.convert', 'conversion.media'].includes(action ?? '')) return capabilities.includes('transcription');
  if (action?.startsWith('conversion.') || action === 'pdf.extract') return capabilities.includes('conversion');
  if (action === 'image.ocr') return capabilities.includes('model');
  if (action?.startsWith('file.') || action?.startsWith('spotlight.')) return false;
  // 其余任务缺少可靠资源范围声明，实际资源变更时保守保留原版本。
  return true;
}
function assertQuiescent(db: DatabaseSync, capabilities: readonly Capability[]): void {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  const tasks = tables.has('tasks') ? db.prepare('SELECT id,action FROM tasks').all() : [];
  const actions = new Map(tasks.map(row => [String(row.id), String(row.action)]));
  const check = (ids: Row[]) => { if (ids.some(row => affected(actions.get(String(row.task_id)), capabilities))) fail('受影响能力仍有活动或未决事实；先沿原身份核对，再采用其资源。'); };
  if (tables.has('tasks')) check(db.prepare("SELECT id task_id FROM tasks WHERE status IN ('running','waiting','waiting_approval','pausing','cancelling','needs_review') OR requires_review=1 OR json_extract(error,'$.code')='RECOVERY_PENDING'").all());
  if (tables.has('task_attempts')) check(db.prepare('SELECT task_id FROM task_attempts WHERE unconfirmed_effects>0').all());
  if (tables.has('task_effects')) check(db.prepare("SELECT a.task_id FROM task_effects e LEFT JOIN task_attempts a ON a.id=e.attempt_id WHERE e.status='started'").all());
  if (tables.has('task_workers')) check(db.prepare("SELECT a.task_id FROM task_workers w LEFT JOIN task_attempts a ON a.id=w.attempt_id WHERE w.kind='tool' AND w.status<>'exited'").all());
  if (tables.has('runs')) check(db.prepare("SELECT task_id FROM runs WHERE state IN ('starting','running','waiting','stopping')").all());
}
function modelPlan(request: BundledAdoptionRequest, configRoot: string): RootPlan['model'] {
  if (!request.enableModelImages) return undefined;
  const path = join(configRoot, 'model.json'), before = pinned(path), info = lstatSync(path);
  if (sha(before) !== request.root.expectedModelSha256) fail('原模型配置摘要与明确审核不符。');
  const value = JSON.parse(before); parseModelConfiguration(value);
  if (encode(value.customModel.input) === encode(['text', 'image'])) return undefined;
  value.customModel.input = ['text', 'image']; parseModelConfiguration(value);
  return { path, before, after: json(value), mode: info.mode & 0o777, uid: info.uid, gid: info.gid };
}
function nextBindings(root: RootPlan, selected: MachineBindingDocument['resources']): string {
  const document = JSON.parse(root.before) as MachineBindingDocument;
  Object.assign(document.resources, selected);
  if (root.browserHome) {
    for (const [name, binding] of Object.entries(document.resources)) if (name !== 'browser_home' && binding.owned) {
      const path = resolve(root.runtimeRoot, binding.path); if (inside(path, root.browserHome) || inside(root.browserHome, path)) fail('浏览器账号位置不能与其他受管理根重叠。');
    }
    const home = document.resources.browser_home;
    if (!home || resolve(root.runtimeRoot, home.path) !== root.browserHome) {
      directory(dirname(root.browserHome));
      if (!lstatSync(root.browserHome, { throwIfNoEntry: false })) mkdirSync(root.browserHome, { mode: 0o700 });
      directory(root.browserHome); if (readdirSync(root.browserHome).length) fail('不能采用未知非空浏览器账号目录；原账号位置保留。');
      const stat = lstatSync(root.browserHome, { bigint: true });
      document.resources.browser_home = { kind: 'directory', path: root.browserHome, owned: true, identity: randomUUID(), device: String(stat.dev), inode: String(stat.ino) };
    } else if (!home.owned || home.kind !== 'directory') fail('原浏览器账号目录不是受管理位置。');
  }
  document.revision = root.expectedRevision + 1;
  return json(document);
}
function assertTarget(root: RootPlan, selected: MachineBindingDocument['resources']): void {
  if (!root.after) fail('维护意图缺少固定目标绑定。');
  const before = JSON.parse(root.before) as MachineBindingDocument, after = JSON.parse(root.after!) as MachineBindingDocument;
  const target = JSON.parse(root.before) as MachineBindingDocument;
  if (after.revision !== before.revision) {
    Object.assign(target.resources, selected);
    if (root.browserHome && encode(before.resources.browser_home) !== encode(after.resources.browser_home)) {
      const home = after.resources.browser_home, stat = lstatSync(root.browserHome, { bigint: true }); directory(root.browserHome);
      if (home?.kind !== 'directory' || !home.owned || home.path !== root.browserHome || !home.identity || home.device !== String(stat.dev) || home.inode !== String(stat.ino)) fail('维护目标浏览器目录身份不符。');
      target.resources.browser_home = home;
    }
    target.revision = root.expectedRevision + 1;
  }
  if (encode(target) !== encode(after)) fail('维护意图试图改变选定资源以外的绑定。');
  if (root.model) {
    const before = JSON.parse(root.model.before), after = JSON.parse(root.model.after); parseModelConfiguration(before); parseModelConfiguration(after);
    if (encode(after.customModel.input) !== encode(['text', 'image'])) fail('模型输入目标并非本次明确图像声明。');
    delete before.customModel.input; delete after.customModel.input;
    if (encode(before) !== encode(after)) fail('维护意图包含图像声明以外的模型变更。');
  }
}

/** 单根受控采用；只维护实际资源/相关模型声明，不启动宿主、不搬账号、不处理无关技能。 */
export async function adoptBundledResources(request: BundledAdoptionRequest, resumeId?: string) {
  if (process.platform !== 'darwin') fail('既有根采用仅在 macOS 验证；Windows 所有者与原子写入尚未验定，拒绝写入。');
  directory(request.codeRoot); directory(request.recordRoot); absolute(request.launcherFile);
  const expected = request.root;
  if (!expected || !expected.runtimeIdentity || !Number.isSafeInteger(expected.expectedRevision) || expected.expectedRevision < 1) fail('必须明确原运行根身份与绑定修订。');
  directory(expected.runtimeRoot); if (expected.browserHome !== undefined) absolute(expected.browserHome);
  if (request.enableModelImages !== undefined && request.enableModelImages !== true) fail('模型图像声明必须由显式 enableModelImages:true 授权。');
  if (!/^[a-f0-9]{64}$/u.test(request.expectedManifestSha256)) fail('必须明确核定唯一随包清单摘要。');
  if (request.enableModelImages && !/^[a-f0-9]{64}$/u.test(expected.expectedModelSha256 ?? '')) fail('模型图像声明须明确原 model.json 摘要。');
  if ([request.codeRoot, expected.runtimeRoot, ...(expected.browserHome ? [expected.browserHome] : [])].some(root => inside(root, request.recordRoot))) fail('维护原文与记录必须位于源码和运行资源之外。');
  const bundled = new BundledResources(request.codeRoot); if (bundled.manifestSha256 !== request.expectedManifestSha256) fail('随包清单摘要与审核请求不一致。'); bundled.verify();
  const selected = bundled.selectedBindings(), whisperModel = bundled.model('whisper_base'), requestSha256 = sha(encode(request));
  if (request.sourceFiles !== undefined && (!request.sourceFiles || typeof request.sourceFiles !== 'object' || Array.isArray(request.sourceFiles))) fail('来源开发包需要明确资源名与清单文件。');
  for (const [name, path] of Object.entries(request.sourceFiles ?? {})) {
    if (!/^[a-z][a-z0-9_]*_package$/u.test(name) || Object.hasOwn(selected, name)) fail('来源开发包不能覆盖核心资源。');
    const entry = bundled.manifest.files.find(item => item.path === path);
    if (!entry || 'kind' in entry) throw new Error('来源开发包必须是发行清单中的明确文件。');
    selected[name] = { kind: 'file', path: bundled.file(entry), sha256: entry.sha256 };
  }
  if (resumeId && !/^[a-f0-9-]{36}$/u.test(resumeId)) fail('续接必须引用原维护编号。');
  const id = resumeId ?? randomUUID(), record = join(request.recordRoot, `bundled-adoption-${id}`), journalFile = join(record, 'journal.json');
  const original = resumeId ? pinned(journalFile) : undefined;
  let journal: Journal | undefined = original ? JSON.parse(original) as Journal : undefined, journalHash: string | null = original ? sha(original) : null;
  if (journal && (journal.version !== 1 || journal.id !== id || journal.requestSha256 !== requestSha256 || journal.manifestSha256 !== bundled.manifestSha256
    || !['preparing', 'prepared', 'committed'].includes(journal.phase) || !journal.root || Object.entries(expected).some(([key, value]) => journal!.root[key as keyof RootPlan] !== value))) fail('不能以另一请求、运行身份或资源包续接原维护。');
  const launcherBefore = pinned(request.launcherFile), launcherGuard = request.launcherFile + '.runtime-maintenance.lock', token = randomUUID();
  if (journal && journal.launcherSha256 !== sha(launcherBefore)) fail('原应用启动定位发生变化，拒绝续接。');
  if (!journal) {
    const launcher = readRuntimeLauncher(request.launcherFile);
    if (launcher.runtimeRoot !== expected.runtimeRoot || launcher.runtimeIdentity !== expected.runtimeIdentity) fail('维护请求与应用固定运行身份不一致。');
  }
  const guardFd = openSync(launcherGuard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600), guardIdentity = fstatSync(guardFd, { bigint: true });
  try { writeFileSync(guardFd, json({ version: 1, pid: process.pid, token, operation: 'adopt-bundled-resources', id })); fsyncSync(guardFd); } finally { closeSync(guardFd); }
  const releases: (() => Promise<void>)[] = [], databases: CoreDatabase[] = [];
  let bindingGuardIdentity: { dev: bigint; ino: bigint } | undefined;
  const save = () => { const raw = json(journal); atomic(journalFile, raw, journalHash); journalHash = sha(raw); };
  const bindingGuard = join(expected.runtimeRoot, 'config/.bindings-maintenance.lock');
  try {
    if (sha(pinned(request.launcherFile)) !== sha(launcherBefore)) fail('取得维护围栏后启动定位变化。');
    if (!journal) {
      const resources = new ResourceBindings(expected.runtimeRoot);
      if (resources.document.runtimeIdentity !== expected.runtimeIdentity || resources.document.revision !== expected.expectedRevision) fail('原身份或绑定修订已变化。');
      for (const binding of Object.values(resources.document.resources)) if (binding.owned && inside(resolve(expected.runtimeRoot, binding.path), request.recordRoot)) fail('维护记录不能落入已有受管理资源。');
      const before = pinned(join(expected.runtimeRoot, 'config/machine.bindings.json')), stat = lstatSync(join(expected.runtimeRoot, 'config/machine.bindings.json'));
      if (process.getuid && stat.uid !== process.getuid()) fail('维护必须由原绑定所有者执行。');
      const model = modelPlan(request, resources.path('config')), capabilities: Capability[] = bundled.changedCapabilities(resources);
      for (const name of Object.keys(request.sourceFiles ?? {})) {
        const previous = resources.document.resources[name];
        if (previous && previous.kind !== 'file') fail('来源开发包不能替换已登记程序或目录。');
        if (!previous || previous.sha256 !== selected[name]!.sha256 || resources.path(name) !== selected[name]!.path) {
          if (!capabilities.includes('sources')) capabilities.push('sources');
        }
      }
      const plans = databasePaths(expected.runtimeRoot, resources.document).map(path => databasePlan(path, whisperModel));
      const browserChanged = expected.browserHome !== undefined && (!resources.document.resources.browser_home || resources.path('browser_home') !== expected.browserHome);
      const bindingChanged = capabilities.length > 0 || browserChanged;
      if (browserChanged && !capabilities.includes('browser')) capabilities.push('browser');
      if (model) capabilities.push('model');
      if (plans.some(plan => plan.protectedState) && !capabilities.includes('transcription')) capabilities.push('transcription');
      if (!capabilities.length) return { status: 'unchanged', runtimeRoot: expected.runtimeRoot, revision: expected.expectedRevision, capabilities: [] };
      assertRuntimeStopped(expected.runtimeRoot);
      mkdirSync(record, { mode: 0o700 }); directory(record);
      journal = { version: 1, id, phase: 'preparing', requestSha256, manifestSha256: bundled.manifestSha256, launcherSha256: sha(launcherBefore),
        root: { ...expected, before, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid, bindingChanged, capabilities, databases: plans, ...(model ? { model } : {}) } };
      save();
    }
    const root = journal.root, document = documentAt(root);
    const paths = databasePaths(root.runtimeRoot, document);
    if (encode(paths) !== encode(root.databases.map(plan => plan.path))) fail('原状态角色集合发生变化。');
    for (const path of paths) releases.push(await ownStateRoot(path));
    for (const plan of root.databases) {
      const db = new DatabaseSync(plan.path, { readOnly: true }); try { assertQuiescent(db, root.capabilities); assertDatabase(db, plan); } finally { db.close(); }
    }
    if (lstatSync(bindingGuard, { throwIfNoEntry: false })) {
      const guard = JSON.parse(pinned(bindingGuard)); if (guard.id !== id || guard.operation !== 'adopt-bundled-resources' || guard.journal !== journalFile) fail('另一份绑定维护仍未完成。');
    } else atomic(bindingGuard, json({ version: 1, operation: 'adopt-bundled-resources', id, journal: journalFile, runtimeIdentity: root.runtimeIdentity }), null);
    const info = lstatSync(bindingGuard, { bigint: true }); bindingGuardIdentity = { dev: info.dev, ino: info.ino };
    for (const [name, raw] of [['bindings-before.json', root.before], ...(root.model ? [['model-before.json', root.model.before]] : [])] as [string, string][]) {
      const path = join(record, name); if (!lstatSync(path, { throwIfNoEntry: false })) atomic(path, raw, null); else if (pinned(path) !== raw) fail('维护原文备份不一致。');
    }
    if (journal.phase === 'preparing') {
      root.after = root.bindingChanged ? nextBindings(root, selected) : root.before;
      journal.phase = 'prepared'; save();
    }
    assertTarget(root, selected);
    if (root.model && (!request.enableModelImages || sha(root.model.before) !== root.expectedModelSha256)) fail('模型声明未获原请求明确授权。');
    for (const plan of root.databases) {
      if (!plan.protectedState) continue;
      const db = new CoreDatabase(plan.path); databases.push(db); assertQuiescent(db.connection, root.capabilities); assertDatabase(db.connection, plan);
      if (encode(settings(db.connection)) !== encode(plan.afterSettings)) {
        const service = new ToolSettingsService(db), { revision, ...value } = service.get(); service.update({ ...value, whisperModelPath: whisperModel }, revision);
      }
      assertDatabase(db.connection, plan); if (encode(settings(db.connection)) !== encode(plan.afterSettings)) fail('工具设置 API 结果与维护计划不一致。');
    }
    documentAt(root);
    if (root.model && pinned(root.model.path) !== root.model.after) atomic(root.model.path, root.model.after, sha(root.model.before), root.model.mode, root.model);
    const bindingPath = join(root.runtimeRoot, 'config/machine.bindings.json'); if (pinned(bindingPath) !== root.after) atomic(bindingPath, root.after!, sha(root.before), root.mode, root);
    if (sha(pinned(request.launcherFile)) !== journal.launcherSha256 || new BundledResources(request.codeRoot).manifestSha256 !== journal.manifestSha256) fail('提交期间启动定位或随包清单变化。');
    documentAt(root); journal.phase = 'committed'; save();
    const guard = JSON.parse(pinned(bindingGuard)), stat = lstatSync(bindingGuard, { bigint: true });
    if (guard.id !== id || guard.journal !== journalFile || stat.dev !== bindingGuardIdentity.dev || stat.ino !== bindingGuardIdentity.ino) fail('原绑定维护锁身份不符，保留现场。');
    unlinkSync(bindingGuard);
    try { bundled.assertBindings(new ResourceBindings(root.runtimeRoot)); }
    catch (error) { atomic(bindingGuard, json({ version: 1, operation: 'adopt-bundled-resources', id, journal: journalFile, runtimeIdentity: root.runtimeIdentity }), null); throw error; }
    return { status: 'committed', id, journal: journalFile, runtimeRoot: root.runtimeRoot, revision: (JSON.parse(root.after!) as MachineBindingDocument).revision, capabilities: root.capabilities, originalAccountDirectoriesDeleted: false };
  } finally {
    let closed = true; for (const db of databases) try { db.close(); } catch { closed = false; }
    if (closed) for (const release of releases.reverse()) await release();
    const current = lstatSync(launcherGuard, { bigint: true }), guard = JSON.parse(pinned(launcherGuard));
    if (current.dev !== guardIdentity.dev || current.ino !== guardIdentity.ino || guard.token !== token) fail('应用维护锁身份变化，保留现场。'); unlinkSync(launcherGuard);
    // 未完成时保留本根 .bindings-maintenance.lock；必须引用原 id 续接。
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, requestFile, resumeId] = process.argv.slice(2);
  if (!requestFile || command !== 'apply' || process.argv.length > 5) throw new Error('Usage: adopt-bundled-resources.ts apply <absolute-request.json> [original-intent-id]');
  console.log(JSON.stringify(await adoptBundledResources(JSON.parse(pinned(requestFile)), resumeId), null, 2));
}
