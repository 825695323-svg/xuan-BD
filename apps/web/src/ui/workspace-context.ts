import { useEffect, useState } from 'react';

/**
 * 当前选中业务对象的统一引用入口（预留）。
 *
 * 只用于展示"当前在看什么"，不写入会话、不自动发送消息、不覆盖已有任务上下文。
 * 后续接右键「问一问」时从这里取对象身份，页面本身不执行任何配置写入。
 */
export interface WorkspaceObjectRef {
  page: string;
  kind: 'market' | 'supplier' | 'source' | 'algorithm';
  id: string;
  label: string;
  detail?: string;
}

let current: WorkspaceObjectRef | null = null;
const listeners = new Set<(value: WorkspaceObjectRef | null) => void>();

export function setWorkspaceObject(value: WorkspaceObjectRef | null): void {
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
