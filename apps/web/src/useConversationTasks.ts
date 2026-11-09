import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskRecord } from '../../../contracts/task-contracts';
import { getTasks, mergeTasks, readTaskUpdate } from './platform-api';
import { localDataGeneration, notifyLocalDataRevoked } from './local-data-context';

/**
 * 当前会话的真实任务流（`GET /api/tasks` + `/api/tasks/events`）。
 *
 * 只在应用层订阅一次，会话视图与任务中心共用同一份结果；不新建第二套任务状态，
 * 也不从聊天消息里反推任务。仅读取，不派发、不重试、不改变任何任务。
 */
export function useConversationTasks(conversationId: string | null | undefined): TaskRecord[] {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const epoch = useRef(0);
  const id = conversationId ?? undefined;
  const refresh = useCallback(() => {
    if (!id) return;
    const ticket = ++epoch.current;
    void getTasks(id).then((value) => {
      if (epoch.current === ticket) setTasks((current) => mergeTasks(current, { tasks: value }, id));
    }).catch(() => {});
  }, [id]);
  useEffect(() => {
    setTasks([]); ++epoch.current;
    if (!id) return;
    const generation = localDataGeneration();
    if (generation === null) return;
    refresh();
    let disposed = false;
    const source = new EventSource(`/api/tasks/events?conversationId=${encodeURIComponent(id)}&localDataGeneration=${generation}`);
    source.addEventListener('tasks', (event) => {
      if (disposed || localDataGeneration() !== generation) return;
      try { setTasks((current) => mergeTasks(current, readTaskUpdate((event as MessageEvent<string>).data), id)); }
      catch { refresh(); }
    });
    source.addEventListener('lifecycle', () => {
      if (disposed) return;
      notifyLocalDataRevoked('本地资料资格已停用。');
      source.close();
      setTasks([]);
    });
    return () => { disposed = true; ++epoch.current; source.close(); };
  }, [id, refresh]);
  return tasks;
}
