/**
 * 浏览器只记住本页已冻结的原请求编号，不保存正文或配置。
 * 原请求的受理事实仍由服务端命令/任务核对；本地记忆用于刷新后按同一编号查回，
 * 存储不可用时只影响本页自动找回，不影响服务端持久记录。
 */
export interface RememberedSend {
  requestId: string;
  conversationId: string;
  branchId: string;
  createdAt: string;
}
export interface SendRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const keyFor = (conversationId: string) => `mashiro.send-request.${conversationId}`;
const maxEntries = 12;
const maxAgeMs = 7 * 24 * 60 * 60 * 1_000;
const valid = (value: unknown): value is RememberedSend => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.requestId === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(item.requestId)
    && typeof item.conversationId === 'string' && !!item.conversationId
    && typeof item.branchId === 'string' && !!item.branchId
    && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt));
};
function storage(): SendRecoveryStorage | null {
  try { return window.localStorage; } catch { return null; }
}
function read(conversationId: string, store: SendRecoveryStorage, now: number): RememberedSend[] {
  try {
    const value: unknown = JSON.parse(store.getItem(keyFor(conversationId)) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(valid).filter((item) => now - Date.parse(item.createdAt) <= maxAgeMs).slice(0, maxEntries);
  } catch { return []; }
}
function write(conversationId: string, entries: RememberedSend[], store: SendRecoveryStorage): void {
  try { store.setItem(keyFor(conversationId), JSON.stringify(entries.slice(0, maxEntries))); }
  catch { /* 浏览器存储不可用时，服务端待核记录仍可找回未受理请求。 */ }
}
export function readRememberedSends(conversationId: string, provided?: SendRecoveryStorage | null, now = Date.now()): RememberedSend[] {
  const store = provided === undefined ? storage() : provided;
  if (!store) return [];
  return read(conversationId, store, now);
}
export function rememberSend(conversationId: string, requestId: string, branchId: string,
  provided?: SendRecoveryStorage | null, now = Date.now()): void {
  const store = provided === undefined ? storage() : provided;
  if (!store || !requestId || !branchId) return;
  const entry: RememberedSend = { requestId, conversationId, branchId, createdAt: new Date(now).toISOString() };
  const entries = read(conversationId, store, now).filter((item) => item.requestId !== requestId);
  write(conversationId, [entry, ...entries], store);
}
export function forgetSend(conversationId: string, requestId: string, provided?: SendRecoveryStorage | null, now = Date.now()): void {
  const store = provided === undefined ? storage() : provided;
  if (!store) return;
  write(conversationId, read(conversationId, store, now).filter((item) => item.requestId !== requestId), store);
}
