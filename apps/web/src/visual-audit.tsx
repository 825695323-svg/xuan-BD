import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip } from 'radix-ui';
import { PageActions, PageButton, PageEmpty, PageField, PageHeading, PageSearch } from './ui/PageUI';
import { FilterSelect } from './ui/FilterSelect';
import { CanvasContext } from './ui/canvas';
import { ControlTooltip } from './ui/Controls';
import { DetailFacts, DetailHeader, DetailSection, ObjectDetailPanel } from './ui/ObjectDetailPanel';
import './styles.css';
import './ui/WorkspaceLayout.css';

/** 只渲染真实 UI 组件及其布局样式，不读取后端、账号、用户数据或运行状态。 */
const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const view = params.get('view') === 'modal' ? 'modal' : 'layout';
document.documentElement.dataset.theme = theme;
document.documentElement.style.fontSize = '15px';

function auditMetrics() {
  const selectors: Record<string, string> = {
    workspace: '.workspace', main: '.workspace-content', nav: '.page-panes > .data-nav',
    cards: '.page-panes > .page-cards', detail: '.page-panes > .object-detail',
    agent: '.workspace-agent', agentFloat: '.workspace-rail--agent',
    search: '.ui-page-search', heading: '.ui-page-heading-title',
    metadata: '.object-card-meta', state: '.object-card-state', hint: '.ui-page-field-hint',
    action: '.ui-page-actions .primary-button', filter: '.filter-trigger',
    dropdown: '.filter-options', dialog: '.ui-dialog',
  };
  const nodes: Record<string, unknown> = {};
  for (const [key, selector] of Object.entries(selectors)) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) { nodes[key] = null; continue; }
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    nodes[key] = {
      x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height, font: Number.parseFloat(style.fontSize),
      display: style.display, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
    };
  }
  document.getElementById('visual-report')!.textContent = JSON.stringify({
    theme, view, viewport: { width: window.innerWidth, height: window.innerHeight },
    rootFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize), nodes,
  });
}

function VisualAuditFixture() {
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [selectedFilter, setSelectedFilter] = useState('全部');
  const narrow = window.innerWidth <= 1180;
  useEffect(() => {
    const open = window.setTimeout(() => {
      if (view === 'modal') document.querySelector<HTMLDialogElement>('#audit-dialog')?.showModal();
      else {
        const trigger = document.querySelector<HTMLButtonElement>('.filter-trigger');
        // Radix 菜单通过 pointerdown 打开，脚本 click() 不会触发实际的开启手势。
        trigger?.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        }));
      }
    }, 250);
    const report = window.setTimeout(auditMetrics, 1300);
    return () => { window.clearTimeout(open); window.clearTimeout(report); };
  }, []);
  return <div className="design-canvas" ref={setCanvas}>
    <CanvasContext.Provider value={canvas}><Tooltip.Provider delayDuration={0}>
      <div className="app-shell">
        <header className="app-header" />
        <nav className="global-nav" aria-label="主导航"><div className="nav-main">
          {['来源', '算法', '数据库'].map(label => <button key={label} className="icon-button nav-button" aria-label={label}>{label[0]}</button>)}
        </div></nav>
        <main className="page-host">
          <div className="workspace" data-agent-open={!narrow}>
            <div className="workspace-content">
              <div className="data-page page-panes page-panes--api">
                <aside className="data-nav" aria-label="分类">
                  <div className="sidebar-search-slot"><PageSearch compact label="搜索来源分类" value={query} onChange={setQuery} /></div>
                  {['全部市场', '中国大陆', '中国香港', '美国市场', '欧洲市场', '日本市场', '新加坡市场', '其他地区'].map((name, i) =>
                    <button className="data-nav-item" key={name} aria-current={i === 0 ? 'true' : undefined}>
                      <span>{name}</span><span className="data-nav-dot" /></button>)}
                </aside>
                <div className="page-cards" aria-label="来源列表"><div className="page-card-list">
                  {Array.from({ length: 8 }, (_, i) => <button className="object-card" key={i} aria-current={i === 0 ? 'true' : undefined}>
                    <span className="object-card-main"><span className="object-card-title">
                      {i === 0 ? '东方财富公开行情' : '采集接口来源 ' + (i + 1)}</span>
                      <span className="object-card-meta">历史行情与来源状态 · CN/A_STOCK</span></span>
                    <span className="object-card-state" data-state="ready">已配置</span>
                  </button>)}
                </div></div>
                <ObjectDetailPanel label="来源详情"
                  header={<DetailHeader title="东方财富公开行情与历史数据" status="已启用" tone="ready" meta="数据来源 · 更新状态" />}
                  summary={<DetailFacts items={[{ label: '支持范围', value: '中国 A 股市场' }, { label: '最近检查', value: '已登记，尚未验证' }]} />}>
                  <PageHeading title="来源详情与操作" description="统一标题、控件间距及密集内容的可读性验收。" />
                  <DetailSection title="筛选与操作">
                    <PageActions>
                      <FilterSelect label="市场" value={selectedFilter} options={['全部', '中国大陆 A 股', '中国香港股票市场', '美国证券交易所']} onChange={setSelectedFilter} />
                      <PageButton>核对状态</PageButton><PageButton variant="primary">读取一次</PageButton>
                    </PageActions>
                  </DetailSection>
                  <DetailSection title="字段"><PageField label="证券代码" hint="按来源登记的业务身份填写。">
                    <input defaultValue="600519.SH" /></PageField></DetailSection>
                  <PageEmpty state="unavailable">当前没有经过认证的网络读取结果，尚不能声明数据可用。</PageEmpty>
                  <div className="ui-page-actions" style={{ marginTop: 12 }}>
                    <ControlTooltip label="这个提示应始终在画布内"><button type="button" className="icon-button" aria-label="说明">?</button></ControlTooltip>
                  </div>
                </ObjectDetailPanel>
              </div>
            </div>
            {narrow ? <aside className="workspace-rail workspace-rail--agent"><button className="workspace-rail-button" aria-label="展开 Agent 工作台">▤</button></aside>
              : <aside className="workspace-agent" data-open="true" style={{ width: 400 }}>
                <header className="workspace-panel-head"><span className="workspace-panel-title">Agent 工作台</span></header>
                <p className="agent-context">上下文 · 来源</p>
                <div className="workspace-agent-body"><div className="agent-conversation"><PageEmpty>会话预览</PageEmpty></div></div>
              </aside>}
          </div>
        </main>
      </div>
      {view === 'modal' && <dialog id="audit-dialog" className="ui-dialog" aria-label="视觉验收对话框">
        <div className="dialog-heading"><h2>运行来源动作</h2><button className="icon-button" aria-label="关闭">×</button></div>
        <p>对话框在小屏上必须完整可见，内容较长时自身滚动。</p>
        {Array.from({ length: 18 }, (_, i) =>
          <p key={i} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
            运行参数 {i + 1} · 证券代码与可用时间说明，需要保留请求回执以免误判任务完成。
          </p>)}
        <div className="dialog-actions"><PageButton>关闭</PageButton><PageButton variant="primary">核对后执行</PageButton></div>
      </dialog>}
      <pre id="visual-report" hidden />
    </Tooltip.Provider></CanvasContext.Provider>
  </div>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Visual audit root missing');
createRoot(root).render(<VisualAuditFixture />);
