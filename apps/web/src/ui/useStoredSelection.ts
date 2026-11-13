import { useCallback, useEffect, useState } from 'react';

/**
 * 记住"当前选中哪个对象"，只存对象 id，不存业务数据。
 * 键可按上下文再分区（例如按市场），避免不同上下文的同名/同 id 对象互相串选。
 */
function readKey(key: string): string | null {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

function writeKey(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch { /* 仅界面记忆。 */ }
}

export function useStoredSelection(key: string): [string | null, (value: string | null) => void] {
  // 键本身可能随上下文变化（例如切换市场）。用键一起存进 state，
  // 在渲染期同步换键，避免先用旧键的值渲染一帧。
  const [entry, setEntry] = useState<{ key: string; value: string | null }>(() => ({ key, value: readKey(key) }));
  if (entry.key !== key) setEntry({ key, value: readKey(key) });
  const current = entry.key === key ? entry.value : readKey(key);
  const update = useCallback((next: string | null) => {
    setEntry({ key, value: next });
    writeKey(key, next);
  }, [key]);
  return [current, update];
}

export interface ObjectSelection {
  /** 已确认可用的对象 id；`pending` 为真时不能把它当成"未选择"。 */
  id: string | null;
  /** 存了对象但列表还没读回：此时应显示读取中，而不是回落到空/总览。 */
  pending: boolean;
  select(next: string | null): void;
}

/**
 * 对象选择：只认列表里真实存在的 id。
 * - 列表未就绪（`ids` 为 null 或 `ready` 为假）时保持 `pending`，不错误回落；
 * - 完整列表读回后仍找不到该 id（被删除、换了市场、跨版本残留）就回落；部分列表不能判定对象失效。
 */
export function resolveObjectSelection(stored: string | null, ids: readonly string[] | null,
  ready: boolean, fallback: 'none' | 'first' = 'none', complete = true): { id: string | null; pending: boolean } {
  if (!ready || ids === null) return { id: null, pending: stored !== null };
  if (stored !== null && ids.includes(stored)) return { id: stored, pending: false };
  return { id: complete && fallback === 'first' ? ids[0] ?? null : null, pending: false };
}

export function useObjectSelection(key: string, ids: readonly string[] | null, ready: boolean,
  fallback: 'none' | 'first' = 'none', complete = true): ObjectSelection {
  const [stored, setStored] = useStoredSelection(key);
  const resolved = resolveObjectSelection(stored, ids, ready, fallback, complete);
  useEffect(() => {
    if (ready && ids !== null && complete && stored !== resolved.id) setStored(resolved.id);
  }, [ready, ids !== null, complete, stored, resolved.id, setStored]);
  return { ...resolved, select: setStored };
}
