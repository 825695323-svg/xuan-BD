// Explicit opt-in source acquisition only. Never run automatically or download in tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.argv[2];
if (!root || !isAbsolute(root) || process.argv.length !== 3) throw new Error('Pass one new absolute evidence directory.');
mkdirSync(resolve(root)); // Refuse reuse and overwrite, including an existing empty directory.
const url = 'https://static.cninfo.com.cn/finalpage/2025-06-20/1223934491.PDF';
const expectedSha256 = '8ff3e6e370c75cece700e5474337c8ecf1adb87b01a1a696bae02fd25982af3b';
const manifest = { kind: 'official_company_action_probe', synthetic: false, sources: [] };
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
  if (bytes.subarray(0, 5).toString() !== '%PDF-' || size !== 181135 || sha256 !== expectedSha256)
    throw new Error('Pinned original changed; stop for source re-review, never update automatically');
  writeFileSync(join(root, 'implementation.pdf'), bytes, { flag: 'wx' });
  manifest.sources.push({ id: 'implementation', url, status: response.status, requestedAt, acquiredAt, bytes: size, sha256 });
} catch (error) {
  manifest.sources.push({ id: 'implementation', url, requestedAt, state: 'failed', error: String(error) });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  throw error;
}
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
console.log('OFFICIAL_COMPANY_ACTION_RECEIVED: one pinned PDF; no exact publication time, actual payout or adjustment calculation asserted.');
