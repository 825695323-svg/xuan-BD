import { useEffect, useState } from 'react';

/**
 * 当前选中业务对象的统一显示引用入口。
 *
 * 只用于展示"当前在看什么"，不写入会话、不自动发送消息、不覆盖已有任务上下文。
 * 主动「问一问」仅预览白名单显示身份；确认后才沿既有草稿管理器追加，页面选择本身不写入。
 */
export interface WorkspaceObjectRef {
  page: string;
  kind: 'market' | 'supplier' | 'source' | 'algorithm';
  id: string;
  label: string;
  detail?: string;
  market?: { id: string; label: string };
}

let current: WorkspaceObjectRef | null = null;
let revision = 0;
export function currentWorkspaceObject(): { object: WorkspaceObjectRef | null; revision: number } {
  return { object: current, revision };
}
const listeners = new Set<(value: WorkspaceObjectRef | null) => void>();

export function setWorkspaceObject(value: WorkspaceObjectRef | null): void {
  if (JSON.stringify(current) !== JSON.stringify(value)) revision += 1;
  current = value;
  for (const listener of listeners) {
    try { listener(value); } catch { /* 单个订阅失败不影响其他订阅者。 */ }
  }
}

export function useWorkspaceObject(page: string): WorkspaceObjectRef | null {
  const [value, setValue] = useState<WorkspaceObjectRef | null>(() => current);
  useEffect(() => {
    listeners.add(setValue);
    setValue(current);
    return () => { listeners.delete(setValue); };
  }, []);
  return value && value.page === page ? value : null;
}
