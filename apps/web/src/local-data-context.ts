/**
 * 当前页面已核实的本地资料代次。
 *
 * 只作为本机请求资格上下文，不替代既有本机来源检查，也不创建账号或令牌。
 * 私有请求必须带上此代次；停用、解绑、重新核对都会推进代次并使旧响应失效。
 */

interface Session {
  dataId: string;
  generation: number;
}

let session: Session | null = null;
let revokedAt = 0;
const listeners = new Set<(reason: string | null) => void>();

export function setLocalDataSession(dataId: string, generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) return;
  session = { dataId, generation };
  try { sessionStorage.setItem('mashiro.local-data-generation', JSON.stringify(session)); } catch { /* 仅本页上下文。 */ }
}

export function clearLocalDataSession(reason: string | null = null): void {
  session = null;
  revokedAt += 1;
  try { sessionStorage.removeItem('mashiro.local-data-generation'); } catch { /* 仅本页上下文。 */ }
  notify(reason);
}

export function forgetLocalDataSession(): void {
  session = null;
  try { sessionStorage.removeItem('mashiro.local-data-generation'); } catch { /* 仅本页上下文。 */ }
}

export function localDataGeneration(): number | null {
  if (session) return session.generation;
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem('mashiro.local-data-generation') ?? 'null');
    if (value && typeof value === 'object' && typeof (value as Session).dataId === 'string'
      && Number.isSafeInteger((value as Session).generation) && (value as Session).generation > 0) {
      session = value as Session;
      return session.generation;
    }
  } catch { /* 未核实时不提供私有请求上下文。 */ }
  return null;
}

export function localDataRevision(): number { return revokedAt; }

export function subscribeLocalDataRevoked(listener: (reason: string | null) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 服务端明确拒绝资格时立即通知所有页面；旧代次不能继续渲染私有内容。 */
export function notifyLocalDataRevoked(reason: string | null = null): void {
  session = null;
  revokedAt += 1;
  try { sessionStorage.removeItem('mashiro.local-data-generation'); } catch { /* 仅本页上下文。 */ }
  notify(reason);
}

function notify(reason: string | null): void {
  for (const listener of listeners) {
    try { listener(reason); } catch { /* 页面清理失败不能阻止其他页面失效。 */ }
  }
}
