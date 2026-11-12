import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const REQUIRED = [
  'README.md','LICENSE','.gitignore','.env.example','AGENTS.md','package.json','package-lock.json',
  'tsconfig.json','vite.config.ts','.nvmrc','.node-version',
  'config/local-web.example.json','config/local-web-toolchain.json','config/local-web-python-requirements.txt',
  'config/local-web-python.lock.txt','config/polars-requirements.txt','config/polars.lock.txt',
  'config/resource-sources.lock.json','config/connections.example.json','config/source-field-profile.example.json',
  'config/semantic-products.example.json','config/wfd-machine.example.json',
  'config/wfd-wiring.example.json','config/model.example.json',
  'resources/browser/package.json','resources/browser/package-lock.json',
  'scripts/local-web.mjs','scripts/bootstrap-local-web.ts','scripts/bootstrap-resources.py','scripts/lock-build-inputs.py',
  'scripts/create-local-config.mjs','scripts/test-local.mjs',
  'modules/agent/instructions/AGENTS.md','modules/agent/instructions/rules.ts',
  'wfd/product/wfd_sdk/product_machine.py','wfd/product/protocol/schemas/wfd-structured-ingest.schema.json',
  'wfd/product/legacy_samples/old_codec_example.parquet',
  '.github/workflows/bd-repository-recipe.yml','docs/REBUILD.md','docs/REPOSITORY-POLICY.md',
  'docs/SOURCE-SEMANTIC-ADOPTION.md',
];

export function isOutputPath(path) {
  return /(?:^|\/)(?:node_modules|vendor|\.venv|__pycache__|\.pytest_cache|dist|build|target|\.next|coverage|\.private|\.local|\.codegraph|staging|audit-output|work|var|\.idea|\.vscode)(?:\/|$)/u.test(path)
    || path.startsWith('resources/bundled/')
    || /(?:^|\/)(?:\.env(?:\..+)?|\.DS_Store|Thumbs\.db)$/u.test(path) && path !== '.env.example'
    || /\.(?:pyc|pyo|sqlite|sqlite3|sqlite-wal|sqlite-shm|db-wal|db-shm|log|pem|key)$/u.test(path)
    || /^config\/(?:.*\.local|launcher|machine\.bindings|connections|r1-machine)\.json$/u.test(path);
}
export function sameDependencies(pkg, lock) {
  return lock.lockfileVersion === 3 && pkg.name === lock.name && pkg.version === lock.version
    && ['dependencies','devDependencies','optionalDependencies'].every(key =>
      JSON.stringify(Object.entries(pkg[key] ?? {}).sort()) === JSON.stringify(Object.entries(lock.packages?.['']?.[key] ?? {}).sort()));
}
export function validateResourceLock(lock, pins) {
  const errors = [];
  if (lock.version !== 1 || !Array.isArray(lock.artifacts)) return ['资源来源锁格式无效'];
  for (const key of ['node','npm','python']) if (lock.toolchain?.[key] !== pins[key]) errors.push(`资源锁工具链版本不符：${key}`);
  const seen = new Set(), hosts = new Set(['nodejs.org','github.com','raw.githubusercontent.com','storage.googleapis.com','huggingface.co']);
  for (const item of lock.artifacts) {
    const key = `${item.platform}:${item.id}`;
    if (seen.has(key)) errors.push(`重复资源：${key}`);
    seen.add(key);
    let url;
    try { url = new URL(item.url); } catch { errors.push(`资源地址无效：${key}`); }
    if (url && (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password
      || /\/(?:latest|main)(?:\/|$)/u.test(url.pathname))) errors.push(`资源地址未固定或来源未登记：${key}`);
    if (!/^[a-f0-9]{64}$/u.test(item.sha256 ?? '') || !Number.isSafeInteger(item.bytes) || item.bytes < 1
      || item.bytes > 1024 ** 3 || !/^[A-Za-z0-9_.+-]+$/u.test(item.filename ?? '')) errors.push(`资源校验字段无效：${key}`);
  }
  for (const platform of ['darwin-arm64','win32-x64','linux-x64']) for (const id of ['node','python'])
    if (!seen.has(`${platform}:${id}`)) errors.push(`缺少基础程序来源：${platform}:${id}`);
  for (const platform of ['darwin-arm64','win32-x64']) for (const id of ['chrome','ffmpeg','ffprobe','yt-dlp'])
    if (!seen.has(`${platform}:${id}`)) errors.push(`缺少可选资源来源：${platform}:${id}`);
  return errors;
}
export function checkPythonLock(requirements, locked) {
  const pins = requirements.split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const lines = locked.replace(/\\\r?\n[ \t]*/gu, ' ').split(/\r?\n/u).filter(line => line.trim() && !line.trim().startsWith('#'));
  return pins.length === lines.length && pins.every(pin => lines.some(line => line.split(/\s+/u)[0] === pin
    && line.split(/\s+/u).slice(1).every(flag => /^--hash=sha256:[a-f0-9]{64}$/u.test(flag))
    && line.includes('--hash=sha256:')));
}

export function checkRepository(root, tracked) {
  const errors = [], text = p => readFileSync(resolve(root, p), 'utf8'), json = p => JSON.parse(text(p));
  for (const path of REQUIRED) if (!tracked.includes(path) || !existsSync(resolve(root, path)) || lstatSync(resolve(root, path)).size === 0)
    errors.push(`缺少已跟踪的重建依据：${path}`);
  if (errors.length) return errors;
  for (const path of tracked) {
    if (isOutputPath(path)) errors.push(`可重建产物或机器状态误入库：${path}`);
    if (!existsSync(resolve(root, path))) { errors.push(`已跟踪文件未拉取：${path}`); continue; }
    const info = lstatSync(resolve(root, path));
    if (info.isFile() && info.size < 1024 && text(path).startsWith('version https://git-lfs.github.com/spec/v1\n'))
      errors.push(`只有LFS指针，缺少实际文件：${path}`);
  }
  const modelExample = json('config/model.example.json');
  if (modelExample.credential?.kind !== 'keychain' || !modelExample.credential.service || !modelExample.credential.account)
    errors.push('模型配置示例必须采用有明确身份的系统钥匙串引用，不能重新引入弃用的 DSH 文件引用');
  const pins = json('config/local-web-toolchain.json');
  if (text('.nvmrc').trim() !== pins.node || text('.node-version').trim() !== pins.node) errors.push('Node版本选择文件与工具链不符');
  if (json('package.json').packageManager !== `npm@${pins.npm}`) errors.push('npm版本声明与工具链不符');
  for (const prefix of ['', 'resources/browser/']) if (!sameDependencies(json(prefix+'package.json'), json(prefix+'package-lock.json')))
    errors.push(`依赖清单与锁文件不一致：${prefix || '根目录'}`);
  for (const name of ['local-web-python','polars']) if (!checkPythonLock(text(`config/${name}-requirements.txt`), text(`config/${name}.lock.txt`)))
    errors.push(`Python完整哈希锁与精确依赖不一致：${name}`);
  errors.push(...validateResourceLock(json('config/resource-sources.lock.json'), pins));
  const rules = text('modules/agent/instructions/rules.ts'), body = text('modules/agent/instructions/AGENTS.md');
  const binding = /INTERNAL_AGENT_RULES = Object\.freeze\(\{ id: '([^']+)', version: (\d+),\s*digest: '([a-f0-9]{64})'/u.exec(rules);
  const digest = binding && createHash('sha256').update(JSON.stringify({ body, id: binding[1], version: Number(binding[2]) })).digest('hex');
  if (!binding || digest !== binding[3]) errors.push('内置AGENTS规则摘要不匹配');
  for (const path of tracked.filter(p => p.endsWith('.md'))) {
    const content = text(path).replace(/```[^]*?```/gu, '');
    for (const match of content.matchAll(/\[[^\]\n]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/gu)) {
      const link = match[1] ?? match[2];
      if (/^(?:[a-z]+:|#|\/\/)/iu.test(link)) continue;
      let target;
      try { target = resolve(dirname(resolve(root,path)),decodeURIComponent(link.split('#')[0])); }
      catch { errors.push(`文档链接编码错误：${path}`); continue; }
      const inside = relative(root,target);
      if (isAbsolute(inside) || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || !existsSync(target))
        errors.push(`文档依赖仓库外或不存在的文件：${path} -> ${link}`);
    }
  }
  for (const path of tracked.filter(p => p.startsWith('wfd/product/protocol/') && p.endsWith('.json'))) {
    let doc;
    try { doc = json(path); } catch { errors.push(`协议JSON无效：${path}`); continue; }
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      if (typeof value.$ref === 'string' && !/^(?:#|[a-z]+:)/iu.test(value.$ref)) {
        const target = resolve(dirname(resolve(root,path)),value.$ref.split('#')[0]);
        if (!existsSync(target)) errors.push(`协议引用缺失：${path} -> ${value.$ref}`);
      }
      for (const child of Object.values(value)) visit(child);
    }
    visit(doc);
  }
  return [...new Set(errors)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    const tracked = execFileSync('git', ['ls-files','-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    const stages = execFileSync('git', ['ls-files','--stage'], { cwd: root, encoding: 'utf8' });
    if (/^160000 /mu.test(stages)) throw new Error('检测到子模块；须单独核验递归拉取，不能将空目录当完整源码。');
    const errors = checkRepository(root, tracked);
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(`REPOSITORY_RECIPE_OK: ${tracked.length} 个已跟踪文件；锁、模板、规则摘要、文档和协议引用核对通过。`);
    console.log('只证明配方完整性；安装、构建、真实外部连接和平台运行须分别验收。');
  } catch (error) {
    console.error('REPOSITORY_RECIPE_FAILED: ' + error.message);
    process.exitCode = 1;
  }
}
