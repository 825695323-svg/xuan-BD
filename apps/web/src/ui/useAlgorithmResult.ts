import { useCallback, useEffect, useRef, useState } from 'react';
import type { AlgorithmTaskView } from '../../../../modules/financial/algorithm-types';
import { readAlgorithmCall, readLatestAlgorithmCall } from '../algorithm-api';

interface ResultState {
  identity: { scope: string | null };
  task: AlgorithmTaskView | null;
  error: string | null;
  loading: boolean;
  loaded: boolean;
}
const empty = (identity: { scope: string | null }): ResultState => ({ identity, task: null, error: null, loading: false, loaded: false });

/** 两个算法展示入口共用只读结果状态；切换对象、重复请求或卸载均使旧回执失效。 */
export function useAlgorithmResult(scope: string | null) {
  const active = useRef(false), sequence = useRef(0), identity = useRef({ scope });
  const [state, setState] = useState<ResultState>(() => empty(identity.current));
  // 渲染即换身份，避免等待 effect 时让旧任务短暂出现在新条目；往返同名也不会复用旧请求。
  if (identity.current.scope !== scope) identity.current = { scope };
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; sequence.current++; };
  }, []);
  const read = useCallback(async (load: () => Promise<AlgorithmTaskView | null>) => {
    if (!active.current || identity.current.scope !== scope) return;
    const current = identity.current, ticket = ++sequence.current;
    const live = () => active.current && identity.current === current && sequence.current === ticket;
    setState({ ...empty(current), loading: true });
    try {
      const task = await load();
      if (live()) setState({ identity: current, task, error: null, loading: false, loaded: true });
    } catch (error) {
      if (live()) setState({ ...empty(current), error: error instanceof Error ? error.message : String(error), loaded: true });
    }
  }, [scope]);
  const loadTask = useCallback((taskId: string, methodId?: string) => read(() => readAlgorithmCall(taskId, methodId)), [read]);
  const loadLatest = useCallback((methodId: string) => read(() => readLatestAlgorithmCall(methodId)), [read]);
  // 已完成结果同样绑定选择身份；不同条目之间不共享显示状态。
  return { ...(state.identity === identity.current ? state : empty(identity.current)), loadTask, loadLatest };
}
