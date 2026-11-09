import { dirname, isAbsolute, relative, sep } from 'node:path';
import { lstatSync } from 'node:fs';
import { inspectPath, normalizePermissionPath, samePathIdentity, type PermissionCapability } from './permissions.js';
import { DirectError } from '../runtime/file-workspace.js';

/** Core 显式提供控制面路径；只读元数据，绝不发现或读取其他凭据位置。 */
export class DirectPathProtection {
  private readonly paths: string[];
  private readonly initial: ReturnType<typeof inspectPath>[];
  constructor(paths: readonly string[], private readonly artifactRoot: string, private readonly references: {
    isRegisteredExecutable?: (path: string) => boolean;
    credentialPaths?: () => readonly string[];
  } = {}) {
    this.paths = paths.map(normalizePermissionPath);
    this.initial = this.paths.map((path) => inspectPath(path, { allowMissing: true }));
    if (this.paths.includes(artifactRoot)) throw new DirectError('INVALID_PROTECTION', '产物目录不能与受保护控制面目录相同。');
  }

  add(path: string): void {
    this.prepareAdd(path)();
  }

  /** 先核对象身份，提交后只登记已观察值；不替换已有保护快照。 */
  prepareAdd(path: string): () => void {
    const normalized = normalizePermissionPath(path);
    if (this.paths.includes(normalized)) return () => {};
    const initial = inspectPath(normalized, { allowMissing: true });
    return () => {
      if (this.paths.includes(normalized)) return;
      this.paths.push(normalized);
      this.initial.push(initial);
    };
  }

  assertPath(path: string, allowSystemHardlinks = false, trustedAncestor?: string): void {
    for (const credential of this.references.credentialPaths?.() ?? []) this.add(credential);
    const candidate = inspectPath(path, { allowMissing: true });
    const artifact = within(this.artifactRoot, candidate.canonicalPath) && within(this.artifactRoot, candidate.invocationPath);
    const trustedRoot = trustedAncestor ? normalizePermissionPath(trustedAncestor) : undefined;
    const ancestors = new Set<string>();
    let parent = candidate.object?.kind === 'directory' ? candidate.canonicalPath : dirname(candidate.canonicalPath);
    while (true) {
      try { const stat = lstatSync(parent, { bigint: true }); if (stat.isDirectory()) ancestors.add(`${stat.dev}:${stat.ino}`); } catch { /* 缺失目标继续核对已有祖先。 */ }
      const next = dirname(parent); if (next === parent) break; parent = next;
    }
    for (let index = 0; index < this.paths.length; index += 1) {
      const initial = this.initial[index]!, current = inspectPath(this.paths[index]!, { allowMissing: true });
      for (const protectedIdentity of [initial, current]) {
        const exact = candidate.invocationPath === protectedIdentity.invocationPath || candidate.canonicalPath === protectedIdentity.canonicalPath;
        const sameObject = !!candidate.object && !!protectedIdentity.object && candidate.object.device === protectedIdentity.object.device
          && candidate.object.inode === protectedIdentity.object.inode;
        const under = within(protectedIdentity.invocationPath, candidate.invocationPath) || within(protectedIdentity.canonicalPath, candidate.canonicalPath);
        const protectedAncestor = protectedIdentity.object?.kind === 'directory'
          && ancestors.has(`${protectedIdentity.object.device}:${protectedIdentity.object.inode}`);
        // 产物仅豁免覆盖它的控制面父目录；显式保护的产物文件仍不可访问。
        const artifactException = artifact && protectedIdentity.object?.kind !== 'file'
          && within(protectedIdentity.canonicalPath, this.artifactRoot) && protectedIdentity.canonicalPath !== this.artifactRoot;
        // 内部固定资源只可豁免同一对象身份的包根祖先；其他显式保护和凭据仍拒绝。
        const trustedException = trustedRoot === this.paths[index] && candidate.object?.kind === 'file'
          && current.object?.kind === 'directory'
          && samePathIdentity(initial, current) && within(current.invocationPath, candidate.invocationPath)
          && within(current.canonicalPath, candidate.canonicalPath);
        if ((exact || sameObject || under || protectedAncestor) && !artifactException && !trustedException) {
          throw new DirectError('PROTECTED_RESOURCE', '此资源属于应用控制面或凭据，不能通过普通文件动作访问或修改。');
        }
      }
    }
    if (!allowSystemHardlinks && candidate.object?.kind === 'file' && lstatSync(candidate.canonicalPath, { bigint: true }).nlink !== 1n) {
      throw new DirectError('HARDLINK_REFUSED', '普通文件入口拒绝多链接文件，防止硬链接绕过控制面保护。');
    }
  }

  assertCapabilities(capabilities: readonly PermissionCapability[], trustedAncestorFor?: (capability: PermissionCapability) => string | undefined): void {
    for (const capability of capabilities) if (capability.target.kind === 'file' || capability.target.kind === 'directory') {
      const systemTool = capability.action === 'execute' && this.references.isRegisteredExecutable?.(capability.target.path) === true;
      this.assertPath(capability.target.path, systemTool, trustedAncestorFor?.(capability));
    }
  }
}

function within(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return !child || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
