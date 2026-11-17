// Explicit opt-in, bounded official originals only. Never invoked by startup or CI.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.argv[2];
if (!root || !isAbsolute(root) || process.argv.length !== 3) throw new Error('Pass one new absolute evidence directory.');
mkdirSync(resolve(root)); // refuse reuse/overwrite of an existing evidence directory
const sources = [
  ['original-q1', 'https://static.cninfo.com.cn/finalpage/2024-04-27/1219876115.PDF', '4cdaa8a953995c5bfe0dc5ef056706b89e22c9cc25ce1658e9c81664f398b91f'],
  ['corrected-q1', 'https://static.cninfo.com.cn/finalpage/2025-04-30/1223426121.PDF', '0675d50c70d2f130b404853c43427d233b19e764aa944dfb3795972a8637b929'],
  ['correction-2024', 'https://static.cninfo.com.cn/finalpage/2025-04-30/1223426127.PDF', '3ffffb22d327f84001562d3f8de047fff6a6fc25be181ade6440374098c4ebeb'],
];
const manifest = { kind: 'official_financial_correction_probe', synthetic: false, sources: [] };
for (const [id, url, expectedSha] of sources) {
  const requestedAt = new Date().toISOString();
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error('Original exceeds 8 MiB evidence budget');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks), acquiredAt = new Date().toISOString();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.subarray(0, 5).toString() !== '%PDF-' || sha256 !== expectedSha) throw new Error('Original format or pinned digest changed; re-review source, never update automatically');
    writeFileSync(join(root, id + '.pdf'), bytes, { flag: 'wx' });
    manifest.sources.push({ id, url, status: response.status, requestedAt, acquiredAt, bytes: size, sha256 });
  } catch (error) {
    manifest.sources.push({ id, url, requestedAt, state: 'failed', error: String(error) });
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    throw error;
  }
}
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
console.log('OFFICIAL_ORIGINALS_RECEIVED: three pinned PDFs; no disclosure-time, financial-correction or publication qualification asserted.');
