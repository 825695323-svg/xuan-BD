import { useEffect, useRef, useState } from 'react';
import type { R1ReadConnection } from '../../../../contracts/r1-contracts';
import { recordEvidenceApi, type RecordEvidence, type RecordIdentity, type EvidenceMaterial } from '../record-evidence-api';
import { localDataGeneration, localDataRevision, subscribeLocalDataRevoked } from '../local-data-context';
import { PageButton, PageHeading, PageEmpty } from './PageUI';
import { ErrorNote, useWords } from './Controls';
import { DetailFacts } from './ObjectDetailPanel';

/** Mounted only by an explicit click on an actual snapshot row. Never supplies historical qualification. */
export function RecordEvidencePanel({ identity, snapshotId, connection }: { identity: RecordIdentity; snapshotId: string; connection: R1ReadConnection }) {
  const words = useWords();
  const [evidence, setEvidence] = useState<RecordEvidence | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const epoch = useRef(0), mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void run();
    const stop = subscribeLocalDataRevoked(() => { epoch.current++; setEvidence(null); setBusy(false); setError(true); });
    return () => { mounted.current = false; epoch.current++; stop(); };
  }, []);
  async function run(material?: EvidenceMaterial) {
    const current = ++epoch.current, generation = localDataGeneration(), revision = localDataRevision();
    const active = () => mounted.current && epoch.current === current && generation === localDataGeneration() && revision === localDataRevision();
    setBusy(true); setError(false);
    if (!material) setEvidence(null);
    try {
      if (material) {
        const blob = await recordEvidenceApi.download(material, connection);
        if (!active()) return;
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = material.filename.replace(/[\\/]/gu, '_'); link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const response = await recordEvidenceApi.read(identity, connection);
        if (active()) setEvidence(response);
      }
    } catch { if (active()) { setEvidence(null); setError(true); } }
    finally { if (active()) setBusy(false); }
  }
  return <section data-testid="record-evidence-panel" aria-label={words('原件追溯', 'Original evidence')} aria-busy={busy}>
    <PageHeading level="h3" title={words('原件追溯', 'Original evidence')} description={words(
      '仅核本地固定行关联和原件字节，不证明披露内容正确或历史可知资格。加工与证据引用仍仅冻结登记，未重新核验。',
      'Verifies local fixed-row association and original bytes, not source claims or historical eligibility. Processing and evidence references remain frozen, not revalidated.')} />
    <p className="database-scope">{identity.recordId} · {identity.recordVersion}</p>
    <PageButton disabled={busy} onClick={() => void run()}>{words('读取原件证据', 'Read original evidence')}</PageButton>
    {busy && <PageEmpty state="loading">{words('核对中…', 'Verifying…')}</PageEmpty>}
    {error && <ErrorNote>{words('无法核对或范围已变化，旧证据已清除。未找到关联不等于原件不存在；未执行发布或任务。',
      'Verification failed or scope changed; old evidence cleared. A missing association does not prove the original is absent. No publication or task was started.')}</ErrorNote>}
    {evidence && <>
      <DetailFacts items={[
        { label: words('当前读取快照', 'Current read snapshot'), value: snapshotId },
        { label: words('原发布证据快照', 'Original publication snapshot'), value: evidence.snapshotId },
        { label: words('原请求', 'Original request'), value: evidence.requestId },
      ]} />
      <p className="database-scope">SHA-256: {evidence.sha256}</p><p>{words('已核原件字节数', 'Verified original bytes')}: {evidence.bytes}</p>
      <p className="r1-help">{words('原发布证据快照可能早于本次读取快照；没有改读最新行。此入口没有新增逐文档权限。',
        'The publication snapshot may precede this read snapshot; no latest-row fallback. This entry does not add per-document permissions.')}</p>
      {evidence.downloadUnavailable && <p>{words('原件字节已核，但没有材料下载链接；不拼造链接或传输到网盘。',
        'Original bytes verified, but no material download link is available. No link or cloud-drive transfer is synthesized.')}</p>}
      {evidence.materials.map(material => <div key={material.materialId}>
        <p className="database-scope">{material.filename}</p>
        <PageButton disabled={busy || material.bytes > 25 * 1024 * 1024} onClick={() => void run(material)}>{words('下载已核原件', 'Download verified original')}</PageButton>
        {material.bytes > 25 * 1024 * 1024 && <p>{words('超过本网页25 MiB下载预算；只展示已核关联，不扩大下载能力。', 'Exceeds this browser’s 25 MiB download budget; verified association only.')}</p>}
      </div>)}
    </>}
  </section>;
}
