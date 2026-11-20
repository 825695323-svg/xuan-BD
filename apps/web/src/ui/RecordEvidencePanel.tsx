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
  return <section className="r1-evidence" data-testid="record-evidence-panel" aria-label={words('原件追溯', 'Original evidence')} aria-busy={busy}>
    <PageHeading level="h3" title={words('原件追溯', 'Original evidence')} />
    {busy && <PageEmpty state="loading">{words('核对中…', 'Verifying…')}</PageEmpty>}
    {error && <ErrorNote>{words('未能核对这条记录关联的原件。', 'The original associated with this record could not be verified.')}</ErrorNote>}
    {evidence && <>
      <p className="r1-help">{words('已核对这条记录与原件的关联及文件内容。', 'The original file and its association with this record were verified.')}</p>
      {evidence.downloadUnavailable && <p>{words('当前没有原件下载链接。', 'No download link is available for this original.')}</p>}
      {evidence.materials.map(material => <div key={material.materialId}>
        <p className="database-scope">{material.filename}</p>
        <PageButton disabled={busy || material.bytes > 25 * 1024 * 1024} onClick={() => void run(material)}>{words('下载已核原件', 'Download verified original')}</PageButton>
        {material.bytes > 25 * 1024 * 1024 && <p>{words('超过本网页25 MiB下载预算；只展示已核关联，不扩大下载能力。', 'Exceeds this browser’s 25 MiB download budget; verified association only.')}</p>}
      </div>)}
    </>}
    <PageButton disabled={busy} onClick={() => void run()}>{words('重新核对原件', 'Verify original again')}</PageButton>
    <details><summary>{words('原件核对详情', 'Evidence details')}</summary>
      <p className="r1-help">{words('核对范围是固定记录关联与原件字节。披露内容、历史资格、加工与证据引用的核验另行进行。',
        'Verification covers the fixed record association and original bytes. Source claims, historical eligibility, processing and evidence references require separate verification.')}</p>
      <DetailFacts items={[
        { label: words('记录与版本', 'Record and version'), value: <><code>{identity.recordId}</code> · <code>{identity.recordVersion}</code></> },
        { label: words('当前读取快照', 'Current read snapshot'), value: snapshotId },
        ...(evidence ? [
          { label: words('原发布证据快照', 'Original publication snapshot'), value: evidence.snapshotId },
          { label: words('原请求', 'Original request'), value: evidence.requestId },
          { label: 'SHA-256', value: <code>{evidence.sha256}</code> },
          { label: words('已核原件字节数', 'Verified original bytes'), value: evidence.bytes },
        ] : []),
      ]} />
    </details>
  </section>;
}
