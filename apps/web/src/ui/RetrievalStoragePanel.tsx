import { useEffect, useRef, useState } from 'react';
import { readRetrievalStorage, type RetrievalStorageView } from '../retrieval-storage-api';
import { localDataGeneration, localDataRevision, subscribeLocalDataRevoked } from '../local-data-context';
import { ErrorNote, useWords } from './Controls';
import { PageActions, PageButton, PageEmpty, PageHeading } from './PageUI';
import { DetailFacts, DetailSection } from './ObjectDetailPanel';

/** Explicit local maintenance read, not a cleanup/rebuild or Harness command. */
export function RetrievalStoragePanel() {
  const words = useWords();
  const [report, setReport] = useState<RetrievalStorageView | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const epoch = useRef(0), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const stop = subscribeLocalDataRevoked(() => { epoch.current++; setReport(null); setBusy(false); setError(true); });
    return () => { mounted.current = false; epoch.current++; stop(); };
  }, []);
  async function read() {
    const current = ++epoch.current, generation = localDataGeneration(), revision = localDataRevision();
    setReport(null); setBusy(true); setError(false);
    const active = () => mounted.current && current === epoch.current && generation === localDataGeneration() && revision === localDataRevision();
    try { const value = await readRetrievalStorage(); if (active()) setReport(value); }
    catch { if (active()) setError(true); }
    finally { if (active()) setBusy(false); }
  }
  const number = (value: number) => value.toLocaleString();
  const time = (value: number | null) => value === null ? words('未知', 'Unknown') : new Date(value).toISOString();
  return <div className="database-list-page" data-testid="retrieval-storage" aria-busy={busy}>
    <PageHeading title={words('检索容量', 'Retrieval storage')} description={words('只读查看当前 BD 检索工作区；不扫描目录、不迁移旧库、不清理或重建。', 'Read the current BD retrieval workspace only. No directory scan, migration, cleanup or rebuild.')} />
    <PageActions><PageButton disabled={busy} aria-busy={busy} onClick={() => void read()}>{words('读取容量', 'Read storage')}</PageButton></PageActions>
    {busy && <PageEmpty state="loading">{words('正在读取容量。', 'Reading storage.')}</PageEmpty>}
    {error && <ErrorNote>{words('容量未知或暂不可读取，未用零或旧报告替代。', 'Storage is unknown or unavailable; neither zero nor a stale report is substituted.')}</ErrorNote>}
    {!report && !busy && !error && <PageEmpty>{words('尚未读取；没有报告不代表占用为零。', 'Not read yet. No report does not mean zero usage.')}</PageEmpty>}
    {report && <div data-testid="retrieval-storage-report">
      <DetailSection title={words('文件字节长度', 'File byte lengths')}>
        <DetailFacts items={[
          { label: words('主数据库文件（字节）', 'Main database file (bytes)'), value: number(report.bytes) },
          { label: words('WAL 文件（字节）', 'WAL file (bytes)'), value: number(report.walBytes) },
        ]} />
        <p>{words('这是分别观测的文件长度，不是物理磁盘分配量或全工作区总量；未相加。', 'These are separately observed file lengths, not physical allocation or a workspace total; they are not summed.')}</p>
      </DetailSection>
      <DetailSection title={words('库内内容与索引', 'Database contents and indexes')}>
        <DetailFacts items={[
          { label: words('片段正文逻辑字节', 'Logical segment text bytes'), value: number(report.textBytes) },
          { label: words('FTS 索引页字节', 'FTS index page bytes'), value: number(report.ftsIndexBytes) },
          { label: words('另存词项正文逻辑字节', 'Separately stored token text bytes'), value: number(report.ftsTokenBytes) },
        ]} />
        <p>{words('这些是库内内容或索引子集，不能再加到数据库文件长度上；词项正文为零不代表索引免费。', 'These are content/index subsets, not extra bytes to add to the database file; zero token text does not mean a free index.')}</p>
        <DetailFacts items={[
          { label: words('文档版本数', 'Document versions'), value: number(report.documents) },
          { label: words('片段数', 'Segments'), value: number(report.segments) },
          { label: words('索引版本数', 'Index versions'), value: number(report.indexVersions) },
        ]} />
        <DetailFacts items={[
          { label: words('显式索引成员行', 'Explicit index membership rows'), value: number(report.indexMembershipRows) },
          { label: words('共享成员索引版本', 'Shared-member index versions'), value: number(report.sharedIndexVersions) },
        ]} />
        <p>{words('各计数不是去重原件数；不把历史页计数当原件总页保证。', 'Counts are not unique original files; historical page counts are not asserted as original page totals.')}</p>
      </DetailSection>
      <DetailSection title={words('解析记录与保留边界', 'Parse records and retention boundaries')}>
        <DetailFacts items={[
          { label: words('最早解析时间', 'Oldest parse time'), value: time(report.oldestParsedAt) },
          { label: words('最近解析时间', 'Newest parse time'), value: time(report.newestParsedAt) },
        ]} />
        <p>{words('时间是解析记录，不是取得、公开或归档时间。片段是证据，程序不自动删除；索引可重建不代表现在可删除。原件归档和 WFD 正式数据不在本报告范围。', 'Times describe parse records, not acquisition, publication or archiving. Segments are evidence and are not automatically deleted. Rebuildable indexes are not permission to delete. Original archiving and formal WFD data are outside this report.')}</p>
      </DetailSection>
    </div>}
  </div>;
}
