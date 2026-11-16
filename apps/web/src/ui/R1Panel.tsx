import { useState } from 'react';
import { R1Panel as SingleOutputPanel } from './R1SingleOutputPanel';
import { R1PlanReviewPanel } from './R1PlanReviewPanel';
import { PageActions, PageButton } from './PageUI';
import { useWords } from './Controls';

/** Keep the public page entry stable; the existing editor is moved unchanged, not copied. */
export function R1Panel() {
  const words = useWords();
  const [mode, setMode] = useState<'editor' | 'review'>('editor');
  return <>
    <PageActions>
      <PageButton aria-pressed={mode === 'editor'} onClick={() => setMode('editor')}>{words('原件与单输出编辑', 'Original and single-output editor')}</PageButton>
      <PageButton aria-pressed={mode === 'review'} onClick={() => setMode('review')}>{words('已有计划多输出审阅', 'Review outputs of an existing plan')}</PageButton>
    </PageActions>
    <div hidden={mode !== 'editor'}><SingleOutputPanel /></div>
    {mode === 'review' && <R1PlanReviewPanel />}
  </>;
}
