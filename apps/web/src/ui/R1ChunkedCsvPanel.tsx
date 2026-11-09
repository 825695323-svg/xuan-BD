import { R1DuplicateResult } from './R1DuplicateResult';
import { useEffect, useState } from 'react';
import type { R1SourceDeclaration } from '../../../../contracts/r1-contracts';
import { r1SourceReadyForHandoff } from '../../../../modules/collection/r1-source';
import { r1AutoApi, type R1AutoView, type R1ChunkedCsvView } from '../r1-auto-api';
import { ErrorNote, errorDetail, useWords } from './Controls';

const rememberedKey='xuan-bd.r1-csv-intake';
function remembered() {try{return localStorage.getItem(rememberedKey)??'';}catch{return '';}}
const labels:Record<R1ChunkedCsvView['state'],string>={receiving:'按原字节偏移接收',custody:'保管完整原件',parsing:'完整解析与冻结分页',
  publishing:'逐页交接并固定读回',awaiting_answers:'当前页待补事实',recovering:'核对原页提交结果',completed:'全部原行已处理并读回',conflicts_pending:'无冲突行已处理，冲突页保留待确认',blocked:'保留原件与当前页受阻原因',stopped:'已停止，保留原偏移与页号'};
export function R1ChunkedCsvPanel({source,ready,disabled,onOpenAuto}:{source:R1SourceDeclaration;ready:boolean;disabled:boolean;onOpenAuto(view:R1AutoView):void}) {
  const words=useWords(),[file,setFile]=useState<File|null>(null),[sha256,setSha256]=useState(''),[datasetId,setDatasetId]=useState(''),
    [columns,setColumns]=useState(''),[datePolicy,setDatePolicy]=useState(false),[consent,setConsent]=useState(false),
    [intakeId,setIntakeId]=useState(remembered),[current,setCurrent]=useState<R1ChunkedCsvView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const bind=(value:R1ChunkedCsvView)=>{setCurrent(value);setIntakeId(value.intakeId);try{localStorage.setItem(rememberedKey,value.intakeId);}catch{/* ID remains visible. */}};
  useEffect(()=>{
    if(!intakeId||busy)return;let live=true,timer:ReturnType<typeof setTimeout>;
    const read=async()=>{try{const value=await r1AutoApi.chunkedCsv(intakeId);if(live)setCurrent(value);}catch(failure){if(live)setError(errorDetail(failure));}
      if(live)timer=setTimeout(()=>void read(),2000);};void read();return()=>{live=false;clearTimeout(timer);};
  },[intakeId,busy]);
  const action=async(work:()=>Promise<void>)=>{setError(null);setBusy(true);try{await work();}catch(failure){setError(errorDetail(failure));}finally{setBusy(false);}};
  const select=async(value:File|undefined)=>{
    setFile(null);setSha256('');setConsent(false);if(!value)return;
    if(!/\.csv$/iu.test(value.name)||!value.size||value.size>256*1024*1024)throw new Error('请选择一份 256 MiB 内非空 CSV 原件。');
    const hash=await crypto.subtle.digest('SHA-256',await value.arrayBuffer());
    setFile(value);setSha256(Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join(''));
  };
  const transmit=async(initial:R1ChunkedCsvView)=>{
    if(!file||file.size!==initial.byteLength||sha256!==initial.sha256)throw new Error('请重新选择与原编号摘要及长度完全相符的原 CSV。');
    let value=initial;
    while(value.receivedBytes<file.size){value=await r1AutoApi.uploadCsvChunk(value.intakeId,value.receivedBytes,
      file.slice(value.receivedBytes,Math.min(file.size,value.receivedBytes+value.chunkBytes)));bind(value);}
    bind(await r1AutoApi.advanceChunkedCsv(value.intakeId));
  };
  const start=async()=>{
    if(!ready||!file||!sha256||!datasetId.trim()||!consent||!r1SourceReadyForHandoff(source))throw new Error('请选定完整 CSV、目标数据集，核对来源并允许逐页交接。');
    const originalUrl=new URL(source.requested_url);if(originalUrl.hash||originalUrl.search)throw new Error('来源系列地址不能含查询或片段。');
    const value=await r1AutoApi.startChunkedCsv({intakeId:'web-csv-'+crypto.randomUUID(),name:file.name,sha256,byteLength:file.size,
      source:{...source,requested_url:originalUrl.href.replace(/\/?$/u,'/')+encodeURIComponent(file.name)},datasetId:datasetId.trim(),
      ...(datePolicy?{datePolicy:'a_share_calendar_day_asia_shanghai' as const}:{}),
      ...(columns.trim()?{sourceValueColumns:columns.split(/\r?\n/u).filter(column=>column.trim())}:{})});
    bind(value);await transmit(value);
  };
  return <details><summary>{words('大 CSV 原件分块交接','Chunked CSV original intake')}</summary><section className="r1-stage" aria-label={words('大 CSV 原件分块交接','Chunked CSV original intake')} aria-busy={busy}>
    <h3>{words('大 CSV 原件分块交接','Chunked CSV original intake')}</h3>
    <p className="r1-help">{words('完整原件按小块接收并核对摘要，整份扫描完成后冻结全部行与字节范围，再逐页加工、发布和固定读回。页面分别显示保管、完整解析与实际已发布覆盖；重开后按原编号、偏移和页号继续。','The complete original is received in chunks and verified by its digest. A full scan freezes row and byte ranges before each page is processed, published and read back. Custody, complete parsing and published coverage are reported separately and resume under the original ID.')}</p>
    {error&&<ErrorNote>{error}</ErrorNote>}
    <label>{words('选择完整 CSV 原件（256 MiB 内）','Choose a complete CSV original, up to 256 MiB')}<input type="file" accept=".csv,text/csv" disabled={busy||disabled} onChange={event=>{const value=event.target.files?.[0];event.target.value='';void action(()=>select(value));}}/></label>
    {file&&<p>{file.name} · {file.size} {words('字节','bytes')} · SHA-256（{words('完整字节摘要','full original digest')}）{sha256}</p>}
    {!current&&<form className="r1-form" onSubmit={event=>event.preventDefault()}><fieldset disabled={busy||disabled}>
      <label>{words('大 CSV 目标数据集','Chunked CSV dataset')}<input value={datasetId} onChange={event=>{setDatasetId(event.target.value);setConsent(false);}}/></label>
      <label>{words('交接原列（可选，每行一个原列名）','Source columns, optional, one per line')}<textarea value={columns} onChange={event=>{setColumns(event.target.value);setConsent(false);}}/></label>
      <label className="r1-confirm"><input type="checkbox" checked={datePolicy} onChange={event=>{setDatePolicy(event.target.checked);setConsent(false);}}/>{words('境内 A 股原报交易日期按北京时间日历日解释；历史可得时间未知。','Interpret original mainland A-share date labels as Asia/Shanghai calendar days; historical availability remains unknown.')}</label>
      <p className="r1-help">{words('沿用上方来源与本次授权。原件保留全部列；明确选列时，仅这些原列进入结构化产品。每页保留原行字节和父原件定位。','Uses the source and authorization above. The original retains every column. Explicitly selected columns alone enter the structured product; every page retains exact parent row byte ranges.')}</p>
      <label className="r1-confirm"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>{words('允许完整保管并对本件全部分页自动加工、交接与固定读回；未知结果沿原编号核对。','Allow custody and automatic processing, handoff and fixed readback for every page of this original; unknown outcomes retain the original identity.')}</label>
      <button type="button" disabled={!ready||!file||!datasetId.trim()||!consent} onClick={()=>void action(start)}>{words('开始完整原件分块交接','Start chunked intake')}</button>
    </fieldset></form>}
    {current&&<>
      <p role="status">{labels[current.state]} · {current.intakeId}</p>
      <p>{words('已接收原字节','Original bytes received')} {current.receivedBytes} / {current.byteLength}；{words('完整解析','Complete parsing')} {current.parsed?words('已完成','complete'):words('尚未完成','pending')}；{current.totalRows} {words('行','rows')} / {current.totalPages} {words('页','pages')}。</p>
      <p>{words('已处理原行','Original rows processed')} {current.processedRows} / {current.totalRows} {words('行','rows')}；{current.processedPages} / {current.totalPages} {words('页','pages')}。</p>
      {current.rowSummary&&<p>{words(`新增 ${current.rowSummary.inserted} 行；相同跳过 ${current.rowSummary.duplicate_skipped} 行；冲突待确认 ${current.rowSummary.conflict_pending} 行。`, 'Row outcomes are preserved in the original receipt.')}</p>}
      {current.conflictPages.map(page=><p key={page.ordinal}>{words('待确认原行范围','Original rows awaiting confirmation')} {page.rowStart}–{page.rowEnd} · {page.conflictCount} {words('处冲突','conflicts')} <button type="button" onClick={()=>void action(async()=>onOpenAuto(await r1AutoApi.get(page.autoRequestId)))}>{words('查看冲突新旧值','Review incoming and original values')}</button></p>)}
      {current.activePage?.auto?.currentRequest&&<R1DuplicateResult request={current.activePage.auto.currentRequest} rowStart={current.activePage.rowStart}/>}
      {current.error&&<ErrorNote>{current.error.code}: {current.error.message}</ErrorNote>}
      {current.activePage&&<p>{words('当前原行范围','Current original rows')} {current.activePage.rowStart}–{current.activePage.rowEnd}；{words('原字节范围','Original byte range')} [{current.activePage.byteStart}, {current.activePage.byteEnd})。</p>}
      {current.activePage?.auto&&<button type="button" onClick={()=>onOpenAuto(current.activePage!.auto!)}>{words('查看当前页并补答事实','Inspect current page and answer missing facts')}</button>}
      {current.state==='recovering'&&current.activePage?.auto?.currentRequest&&<button type="button" disabled={busy||disabled}
        onClick={()=>void action(async()=>bind(await r1AutoApi.resumeChunkedCsv(current.intakeId,current.activePage!.auto!.currentRequest!.documentSha256)))}>
        {words('明确续办已受理原页（按原确认写入）','Resume the accepted original page with its original confirmation')}</button>}
      <div className="r1-actions"><button type="button" disabled={busy||disabled} onClick={()=>void action(async()=>{const value=await r1AutoApi.chunkedCsv(current.intakeId);if(value.receivedBytes<value.byteLength)await transmit(value);else bind(await r1AutoApi.advanceChunkedCsv(value.intakeId));})}>{words('按原偏移和页号继续','Continue original offset and page')}</button>
        <button type="button" disabled={busy} onClick={()=>{setCurrent(null);setIntakeId('');setConsent(false);try{localStorage.removeItem(rememberedKey);}catch{/* ID remains in backend list. */}}}>{words('选择另一份原件','Choose another original')}</button></div>
    </>}
    <label>{words('已保存的分块接收编号','Saved chunked intake ID')}<input value={intakeId} disabled={busy} onChange={event=>{setCurrent(null);setIntakeId(event.target.value);}}/></label>
  </section></details>;
}
