import { BusinessSidebar } from './BusinessSidebar';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChartCandlestick, Database, RefreshCw, Target } from 'lucide-react';
import type { R1ProductDiscovery } from '../../../../contracts/r1-contracts';
import { localDataGeneration, localDataRevision, subscribeLocalDataRevoked } from '../local-data-context';
import { r1Api } from '../r1-api';
import { sameR1ReadConnection } from '../r1-read-history';
import { RESEARCH_FIELDS, chartBars, researchProducts, type ResearchProduct, type ChartBar } from '../research-bars';
import { ErrorNote, SelectMenu, useWords } from './Controls';
import { PageButton, PageEmpty, PageField, PageHeading } from './PageUI';
import { Button } from './admin/button';
import { WorkbenchCard } from './WorkbenchCard';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from './admin/sheet';
import { SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from './admin/sidebar';
import './ResearchWorkbench.css';

type Result = { data: ReturnType<typeof chartBars>; cursor: string | null; page: number; hasMore: boolean };
type Catalog = { state: 'empty' } | { state: 'found'; discovery: R1ProductDiscovery; products: ResearchProduct[] };
const instrumentLabel = ({ selection }: ResearchProduct) =>
  [selection.subject.namespace, selection.subject.id].filter(value => typeof value === 'string' && value).join(':');

type CandleStyle = 'candles' | 'ohlc' | 'line';
function ResearchPriceChart({ bars, title, style }: { bars: ChartBar[]; title: string; style: CandleStyle }) {
  const words = useWords();
  const figure = useRef<HTMLElement>(null);
  const [{ width: frameWidth, height: frameHeight }, setFrame] = useState({ width: 560, height: 420 });
  useLayoutEffect(() => {
    const element = figure.current;
    if (!element) return;
    const measure = () => {
      const width = Math.max(240, Math.round(element.clientWidth));
      const height = width < 520 ? 280 : Math.max(360, Math.min(680, window.innerHeight - 432));
      setFrame(current => current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const low = Math.min(...bars.map(bar => bar.low)), high = Math.max(...bars.map(bar => bar.high));
  const first = bars[0]!.time, last = bars[bars.length - 1]!.time;
  // Match the view box to rendered width so chart text stays readable without magnifying on desktop.
  const plot = { left: frameWidth < 520 ? 56 : 72, right: frameWidth - 18, top: 16, bottom: frameHeight - 34 };
  const magnitude = Math.max(Math.abs(low), Math.abs(high), Number.MIN_VALUE);
  const normalizedLow = low / magnitude, normalizedHigh = high / magnitude;
  const delta = normalizedHigh - normalizedLow;
  const pad = delta > 0 ? delta * (bars.length === 1 ? 0.6 : 0.1) : 0.005;
  const bottom = Math.max(normalizedLow - pad, -Number.MAX_VALUE / magnitude);
  const top = Math.min(normalizedHigh + pad, Number.MAX_VALUE / magnitude);
  const x = (time: number) => last === first ? (plot.left + plot.right) / 2
    : plot.left + 10 + (time - first) / (last - first) * (plot.right - plot.left - 20);
  const y = (price: number) => plot.top + (top - price / magnitude) / (top - bottom) * (plot.bottom - plot.top);
  const width = Math.min(bars.length === 1 ? 7 : 12, Math.max(1.5, 320 / bars.length));
  const priceTicks = Array.from({ length: 5 }, (_, index) => top - (top - bottom) * index / 4);
  const nonzeroStep = (top - bottom) / 4 * magnitude;
  const decimals = Math.min(12, Math.max(0, 1 - Math.floor(Math.log10(nonzeroStep))));
  const priceLabel = (value: number) => (Math.abs(value) >= 1e9 || nonzeroStep < 1e-10)
    ? value.toExponential(2) : Number(value.toFixed(decimals)).toString();
  const timeTicks = [...new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1])].map(index => bars[index]!.time);
  const spread = last - first;
  const renderTime = (timestamp: number) => {
    const utc = new Date(timestamp * 1000).toISOString();
    return spread >= 86400 ? utc.slice(0, 10) : utc.slice(5, 16).replace('T', ' ');
  };
  const segments: ChartBar[][] = [];
  for (const bar of bars) {
    const tail = segments.at(-1);
    if (tail?.at(-1)?.end === bar.time) tail.push(bar);
    else segments.push([bar]);
  }
  const caption = words(`${title} 的固定快照价格图`, `Fixed snapshot price chart for ${title}`);
  return <figure className="research-plot" ref={figure}>
    <svg viewBox={`0 0 ${frameWidth} ${frameHeight}`} height={frameHeight} role="img" aria-label={caption}>
      <title>{caption}</title>
      {priceTicks.map((tick, index) => {
        const price = tick * magnitude, level = plot.top + (plot.bottom - plot.top) * index / 4;
        return <g className="research-axis" key={index}>
          <line className="research-grid-line" x1={plot.left} x2={plot.right} y1={level} y2={level} />
          <text x={plot.left - 7} y={level} dy=".33em" textAnchor="end">{priceLabel(price)}</text>
        </g>;
      })}
      <line className="research-axis-line" x1={plot.left} x2={plot.left} y1={plot.top} y2={plot.bottom} />
      <line className="research-axis-line" x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} />
      {timeTicks.filter((time, index) => timeTicks.length !== 3 || index !== 1
        || Math.min(x(time) - x(timeTicks[0]!), x(timeTicks[2]!) - x(time)) > 92).map(time =>
        <g className="research-axis" key={time}>
          <line className="research-axis-line" x1={x(time)} x2={x(time)} y1={plot.bottom} y2={plot.bottom + 4} />
          <text x={x(time)} y={plot.bottom + 17} textAnchor={timeTicks.length === 1 ? 'middle' : time === first ? 'start' : time === last ? 'end' : 'middle'}>{renderTime(time)}</text>
        </g>)}
      <text className="research-axis" x={plot.left - 7} y={plot.bottom + 17} textAnchor="end">UTC</text>
      {style === 'line' ? segments.map(segment => segment.length === 1
        ? <circle className="research-close-point" key={segment[0]!.time} cx={x(segment[0]!.time)} cy={y(segment[0]!.close)} r={2} />
        : <polyline key={segment[0]!.time} className="research-close-line" points={segment.map(bar => `${x(bar.time)},${y(bar.close)}`).join(' ')} />)
        : bars.map(bar => {
          const at = x(bar.time), opening = y(bar.open), closing = y(bar.close);
          return <g key={bar.time} className={bar.close >= bar.open ? 'research-rise' : 'research-fall'}>
            <title>{new Date(bar.time * 1000).toISOString()} · O {bar.open} · H {bar.high} · L {bar.low} · C {bar.close}</title>
            <line x1={at} x2={at} y1={y(bar.high)} y2={y(bar.low)} />
            {style === 'ohlc'
              ? <path d={`M ${at - width / 2} ${opening} h ${width / 2} M ${at} ${closing} h ${width / 2}`} />
              : <rect x={at - width / 2} y={Math.min(opening, closing)} width={width} height={Math.max(1, Math.abs(opening - closing))} />}
          </g>;
        })}
    </svg>
    <figcaption>{new Date(first * 1000).toISOString()}{first !== last && ` · ${new Date(last * 1000).toISOString()}`} · {low}–{high}</figcaption>
  </figure>;
}

export function ResearchWorkbench({ ready }: { ready: boolean }) {
  const words = useWords();
  const { setOpenMobile } = useSidebar();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [productId, setProductId] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null);
  const [style, setStyle] = useState<CandleStyle>('candles');
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const epoch = useRef(0);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  useEffect(() => {
    const clear = () => {
      epoch.current++; setBusy(false); setCatalog(null); setProductId(''); setResult(null); setError(null);
    };
    clear();
    const off = subscribeLocalDataRevoked(clear);
    return () => { epoch.current++; off(); };
  }, [ready]);

  const currentProduct = useMemo(() => catalog?.state === 'found' ? catalog.products.find(product =>
    product.selection.productId === productId) : undefined, [catalog, productId]);

  const run = async (work: (current: () => boolean) => Promise<void>) => {
    if (!readyRef.current) return;
    const ticket = ++epoch.current, generation = localDataGeneration(), rev = localDataRevision();
    const current = () => readyRef.current && ticket === epoch.current
      && generation === localDataGeneration() && rev === localDataRevision();
    setBusy(true); setError(null);
    try { await work(current); }
    catch (failure) {
      if (current()) {
        const detail = failure instanceof Error ? failure.message : undefined;
        setError({ text: words('固定快照读取未完成。', 'The fixed snapshot could not be read.'), detail });
      }
    } finally { if (current()) setBusy(false); }
  };

  const load = () => void run(async current => {
    setCatalog(null); setProductId(''); setResult(null);
    const snapshot = await r1Api.snapshotStatus();
    if (!current()) return;
    if (snapshot.snapshotId === null) { setCatalog({ state: 'empty' }); return; }
    const found = await r1Api.discoverProducts(snapshot.snapshotId);
    if (!current()) return;
    if (!sameR1ReadConnection(snapshot.connection, found.connection))
      throw new Error(words('快照与目录的连接不同，请重新读取。', 'The snapshot and catalog bindings differ; reload.'));
    setCatalog({ state: 'found', discovery: found, products: researchProducts(found) });
  });

  const read = (next = false) => {
    if (catalog?.state !== 'found' || !currentProduct || next && !result?.cursor) return;
    const { discovery } = catalog;
    const cursor = next ? result!.cursor : null;
    const page = next ? result!.page + 1 : 1;
    void run(async current => {
      setResult(null);
      const response = await r1Api.readProduct({ snapshotId: discovery.snapshotId, productId, fields: [...RESEARCH_FIELDS],
        cursor, historyMode: 'snapshot_contents', pageSize: Math.min(100, discovery.limits.pageSize) });
      if (!current()) return;
      if (!sameR1ReadConnection(response.connection, discovery.connection))
        throw new Error(words('产品结果属于其他连接，请重新读取。', 'The product result is bound to another connection; reload.'));
      const meta = response.result.page as { next_cursor?: unknown; has_more: boolean };
      if (meta.has_more && (typeof meta.next_cursor !== 'string' || !meta.next_cursor || meta.next_cursor === cursor))
        throw new Error(words('固定结果的下一页无法核对。', 'The next fixed-result page could not be verified.'));
      setResult({ data: chartBars(response.result.rows as unknown[], currentProduct), page, hasMore: meta.has_more, cursor: meta.has_more ? meta.next_cursor as string : null });
    });
  };

  const styles: { value: CandleStyle; label: string }[] = [
    { value: 'candles', label: words('蜡烛图', 'Candlesticks') },
    { value: 'ohlc', label: 'OHLC' },
    { value: 'line', label: words('收盘线', 'Close line') },
  ];

  const bars = result?.data.bars;
  const last = bars?.at(-1);
  const snapshotId = catalog?.state === 'found' ? catalog.discovery.snapshotId : null;
  const utcLabel = (time: number) => new Date(time * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const chooseProduct = (value: string) => {
    epoch.current++; setProductId(value); setResult(null); setError(null);
  };

  return <section className="research-workbench" aria-label={words('研究台', 'Research workbench')}>
    <BusinessSidebar workspace className="research-data-sidebar" aria-label={words('研究工作区目录', 'Research workspace navigation')}>
      <SidebarHeader>
        <SidebarMenu className="research-workspace-menu"><SidebarMenuItem>
          <SidebarMenuButton size="lg" asChild>
            <div className="research-workspace-brand"><span className="research-brand-mark" aria-hidden="true">X</span>
              <span><strong>Xuan BD</strong><small>{words('本地研究工作区', 'Local research workspace')}</small></span>
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem></SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{words('工作空间', 'Workspace')}</SidebarGroupLabel>
          <SidebarMenu className="research-workspace-menu"><SidebarMenuItem>
            <SidebarMenuButton isActive asChild tooltip={words('研究工作台', 'Research workbench')}>
              <a href="#research" aria-current="page" onClick={() => setOpenMobile(false)}><ChartCandlestick aria-hidden="true" /><span>{words('研究工作台', 'Research workbench')}</span></a>
            </SidebarMenuButton>
          </SidebarMenuItem></SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </BusinessSidebar>

    <div className="research-content">
      <PageHeading title={words('研究工作台', 'Research workbench')}
        description={words('在固定快照中观察已发布行情。', 'Observe published prices in a fixed snapshot.')}
        actions={<Sheet open={resourcesOpen} onOpenChange={setResourcesOpen}>
          <SheetTrigger asChild><Button variant="outline" className="research-outline-button">
            <Database aria-hidden="true" />{words('数据与图层', 'Data and layers')}
          </Button></SheetTrigger>
          <SheetContent side="left" className="research-resource-sheet">
            <SheetHeader>
              <SheetTitle>{words('数据与图层', 'Data and layers')}</SheetTitle>
              <SheetDescription>{words('选择 WFD 已发布行情；当前只显示价格，不接实时行情或因子。', 'Select published WFD prices. Live feeds and factors are not connected here.')}</SheetDescription>
            </SheetHeader>
            <div className="research-resource-form">
              {!ready && <PageEmpty state="unavailable">{words('本地资料未启用或尚未核对。', 'Local data is disabled or unverified.')}</PageEmpty>}
              {error && <ErrorNote detail={error.detail}>{error.text}</ErrorNote>}
              {busy && <PageEmpty state="loading">{words('正在读取固定快照…', 'Reading the fixed snapshot…')}</PageEmpty>}
              <Button variant="outline" className="research-outline-button" onClick={load} disabled={!ready || busy}>
                <RefreshCw aria-hidden="true" />{words('载入固定快照', 'Load fixed snapshot')}
              </Button>
              {catalog?.state === 'empty' && <PageEmpty>{words('当前 WFD 连接没有已发布快照。', 'The current WFD connection has no published snapshot.')}</PageEmpty>}
              {!!snapshotId && <PageField label={words('固定快照', 'Fixed snapshot')}><code>{snapshotId}</code></PageField>}
              {catalog?.state === 'found' && catalog.products.length === 0 && <PageEmpty>{words('快照内没有可核对的开、高、低、收行情产品。', 'No published products with verifiable OHLC values were found.')}</PageEmpty>}
              {catalog?.state === 'found' && catalog.products.length > 0 && <>
                <PageField label={words('行情产品', 'Price product')}>
                  <select value={productId} disabled={busy} onChange={event => chooseProduct(event.currentTarget.value)}>
                    <option value="">{words('请选择', 'Choose a product')}</option>
                    {catalog.products.map(product => <option key={product.selection.productId} value={product.selection.productId}>
                      {instrumentLabel(product)} · {product.selection.datasetId} · {product.cadence}
                    </option>)}
                  </select>
                </PageField>
                <PageButton variant="primary" onClick={() => read()} disabled={busy || !currentProduct}>
                  <ChartCandlestick size={15} aria-hidden="true" /> {words('读取图表', 'Read chart')}
                </PageButton>
                {last && <Button variant="outline" className="research-outline-button" onClick={() => setResourcesOpen(false)}>{words('返回画布', 'Back to chart')}</Button>}
              </>}
            </div>
          </SheetContent>
        </Sheet>} />
      <div className="research-dashboard-grid">
        <WorkbenchCard className="research-canvas-card" aria-label={words('研究画布', 'Research canvas')}>
          <header className="research-card-toolbar">
            <h3>{words('研究画布', 'Research canvas')}</h3>
            <SelectMenu<CandleStyle> label={words('图表类型', 'Chart type')} value={style} options={styles} onChange={setStyle} />
          </header>
          {snapshotId && <div className="research-snapshot-strip">{words('固定快照', 'Fixed snapshot')}{last && bars?.length ? <span>{utcLabel(bars[0]!.time)} — {utcLabel(last.time)} UTC</span> : null}</div>}
          {!ready && <PageEmpty state="unavailable">{words('本地资料未启用或尚未核对。', 'Local data is disabled or unverified.')}</PageEmpty>}
          {error && <ErrorNote detail={error.detail}>{error.text}</ErrorNote>}
          {busy && <PageEmpty state="loading">{words('正在读取固定快照…', 'Reading the fixed snapshot…')}</PageEmpty>}
          {ready && !busy && !error && !result && <PageEmpty>{words('从「数据与图层」选择已发布的行情。', 'Choose published prices from Data and layers.')}</PageEmpty>}
          {currentProduct && result && <section className="research-result" aria-label={words('固定快照结果', 'Fixed snapshot result')}>
            {last && <div className="research-quote"><span>{instrumentLabel(currentProduct)} · {currentProduct.unit}</span><strong>{last.close}</strong></div>}
            {result.data.conflict ? <ErrorNote>{words('本页存在重复或重叠区间，或单位定义不一致，未绘图。', 'Overlapping intervals or conflicting units prevent plotting this page.')}</ErrorNote>
              : !last || !bars ? <PageEmpty>{words('本页没有可核对的价格记录。', 'No verifiable price bars were found on this page.')}</PageEmpty>
                : <ResearchPriceChart bars={bars} title={instrumentLabel(currentProduct)} style={style} />}
            {result.data.skipped > 0 && <small>{words(`本页 ${result.data.skipped} 行不能用于绘图，未补值。`, `${result.data.skipped} unplottable rows were not filled.`)}</small>}
            <div className="research-footer">
              <span>{words(`本页 ${result.data.bars.length} 条 · 第 ${result.page} 页`, `${result.data.bars.length} on this page · Page ${result.page}`)}</span>
              {result.hasMore && <PageButton onClick={() => read(true)} disabled={busy}>{words('下一页', 'Next page')}</PageButton>}
            </div>
          </section>}
        </WorkbenchCard>
        <WorkbenchCard variant="inspector" className="research-inspector-card" aria-label={words('数据检查', 'Data inspection')}>
          <header className="research-card-toolbar"><h3><Target size={16} aria-hidden="true" />{words('数据检查', 'Data inspection')}</h3></header>
          <div className="research-inspector-body">
            {last && currentProduct ? <>
              <span className="research-inspector-label">{words('本页最后一条 · UTC', 'Last record on this page · UTC')}</span>
              <strong className="research-inspector-time">{utcLabel(last.time)}</strong>
              <strong className="research-inspector-price">{last.close}</strong>
              <span className="research-inspector-label">{instrumentLabel(currentProduct)} · {currentProduct.unit}</span>
              <dl className="research-price-facts">
                {([[words('开盘', 'Open'),last.open],[words('最高', 'High'),last.high],[words('最低', 'Low'),last.low],[words('收盘', 'Close'),last.close]] as const)
                  .map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
              </dl>
              {snapshotId && <details className="research-source-details"><summary>{words('来源与快照', 'Source and snapshot')}</summary>
                <dl><div><dt>{words('数据集', 'Dataset')}</dt><dd>{currentProduct.selection.datasetId}</dd></div>
                  <div><dt>{words('固定快照', 'Fixed snapshot')}</dt><dd>{snapshotId}</dd></div></dl>
              </details>}
              <small>{words('按记录区间起点显示，不是历史可得性回放。', 'Shown at the interval start, not a point-in-time replay.')}</small>
            </> : <PageEmpty>{words('读取行情后，在这里核对本页最后一条记录。', 'Read prices to inspect the last record on the current page.')}</PageEmpty>}
          </div>
        </WorkbenchCard>
      </div>
    </div>
  </section>;
}
