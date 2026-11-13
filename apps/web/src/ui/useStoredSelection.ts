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
 * - 就绪后仍找不到该 id（被删除、换了市场、跨版本残留）就清掉记录，不留幽灵选择。
 */
export function useObjectSelection(key: string, ids: readonly string[] | null, ready: boolean): ObjectSelection {
  const [stored, setStored] = useStoredSelection(key);
  const valid = ready && ids !== null && stored !== null && ids.includes(stored);
  const pending = stored !== null && (!ready || ids === null);
  // 列表每次渲染都是新数组；用内容签名做依赖，避免无谓地重跑清理。
  const signature = ids === null ? null : ids.join('\u0000');
  useEffect(() => {
    // 只在列表真正读回后清理；读取失败或进行中一律保留原记录。
    if (!ready || signature === null || stored === null) return;
    if (!signature.split('\u0000').includes(stored)) setStored(null);
  }, [ready, signature, stored, setStored]);
  return { id: valid ? stored : null, pending, select: setStored };
}
