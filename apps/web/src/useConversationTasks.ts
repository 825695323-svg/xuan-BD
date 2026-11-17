import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskRecord } from '../../../contracts/task-contracts';
import { getTasks, mergeTasks, readTaskUpdate } from './platform-api';
import { localDataGeneration, localDataRevision, notifyLocalDataRevoked, subscribeLocalDataRevoked } from './local-data-context';

export interface ConversationTaskFeed {
  scope: string;
  tasks: TaskRecord[];
  status: 'idle' | 'loading' | 'ready' | 'stale' | 'error';
  refreshing: boolean;
  refresh(): void;
}
/** One read-only subscription at App level. Snapshots and events share the existing per-task sequence merge. */
export function useConversationTasks(conversationId: string | null | undefined): ConversationTaskFeed {
  const id = conversationId ?? null, generation = localDataGeneration(), revision = localDataRevision();
  const scope = JSON.stringify([id, generation, revision]);
  const [state, setState] = useState<{ scope: string; tasks: TaskRecord[]; status: ConversationTaskFeed['status']; refreshing: boolean }>(
    { scope, tasks: [], status: id ? 'loading' : 'idle', refreshing: false });
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    let disposed = false, request = 0, eventRevision = 0, hasSnapshot = false, disconnected = false;
    let current: TaskRecord[] = [];
    const valid = () => !disposed && localDataGeneration() === generation && localDataRevision() === revision;
    const publish = (status: ConversationTaskFeed['status'], refreshing = false) => {
      if (valid()) setState({ scope, tasks: current, status, refreshing });
    };
    if (!id || generation === null) {
      setState({ scope, tasks: [], status: 'idle', refreshing: false });
      refreshRef.current = () => {};
      return;
    }
    publish('loading');
    let source: EventSource;
    const refreshNow = () => {
      if (!valid()) return;
      if (disconnected) { source.close(); source = connect(); }
      const ticket = ++request, eventsAtStart = eventRevision;
      publish(hasSnapshot ? (disconnected ? 'stale' : 'ready') : 'loading', true);
      void getTasks(id).then(value => {
        if (!valid() || request !== ticket) return;
        const update = readTaskUpdate(JSON.stringify({ tasks: value }));
        current = mergeTasks(current, update, id); hasSnapshot = true;
        publish(disconnected ? 'stale' : 'ready');
      }).catch(() => {
        if (!valid() || request !== ticket) return;
        // A newer real SSE snapshot/event supersedes an older failed GET, not vice versa.
        publish(eventRevision !== eventsAtStart && hasSnapshot && !disconnected ? 'ready' : hasSnapshot ? 'stale' : 'error');
      });
    };
    refreshRef.current = refreshNow;
    const connect = () => {
      const connection = new EventSource(`/api/tasks/events?conversationId=${encodeURIComponent(id)}&localDataGeneration=${generation}`);
      connection.addEventListener('tasks', event => {
        if (!valid() || source !== connection) return;
        try {
          const update = readTaskUpdate((event as MessageEvent<string>).data);
          current = mergeTasks(current, update, id);
          ++eventRevision;
          if (update.tasks) { hasSnapshot = true; disconnected = false; }
          publish(hasSnapshot && !disconnected ? 'ready' : 'stale');
        } catch { disconnected = true; publish(hasSnapshot ? 'stale' : 'error'); }
      });
      connection.addEventListener('error', () => {
        if (!valid() || source !== connection) return;
        disconnected = true; publish(hasSnapshot ? 'stale' : 'error');
      });
      connection.addEventListener('lifecycle', () => {
        if (valid() && source === connection) notifyLocalDataRevoked('本地资料资格已停用。');
      });
      return connection;
    };
    source = connect();
    refreshNow();
    // EventSource reconnects to the existing endpoint; its first message is a real full snapshot.
    const unsubscribe = subscribeLocalDataRevoked(() => {
      disposed = true; ++request; source.close(); current = [];
      setState({ scope, tasks: [], status: 'idle', refreshing: false });
    });
    return () => { disposed = true; ++request; unsubscribe(); source.close(); refreshRef.current = () => {}; };
  }, [id, generation, revision, scope]);
  // Never expose the previous conversation during the render preceding effect cleanup.
  return { ...(state.scope === scope ? state : { scope, tasks: [], status: id && generation !== null ? 'loading' as const : 'idle' as const, refreshing: false }), refresh };
}
