import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectWorkspace, type DirectAuthority } from './file-workspace.js';
import type { TaskExecutionContext } from '../jobs/tasks.js';
import type { FileReferenceService } from '../resources/files.js';

// Real private files/fs-safe handles; trusted authority injection exercises authorization boundaries, not a mock SHA reader.
async function fixture() {
  const directory = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'fingerprint-')));
  const controller = new AbortController();
  let checks = 0, hook = () => {};
  const authority = { assert() { checks++; hook(); controller.signal.throwIfAborted(); } } as DirectAuthority;
  const context = { signal: controller.signal, emit: async () => {}, task: { id: 'fingerprint-test' } } as unknown as TaskExecutionContext;
  const workspace = new DirectWorkspace(context, {} as FileReferenceService, directory, authority);
  await workspace.create();
  checks = 0;
  return { directory, workspace, controller, get checks() { return checks; },
    reset(fn = () => {}) { checks = 0; hook = fn; },
    close() { rmSync(directory, { recursive: true, force: true }); } };
}

test('fingerprint hashes complete multiblock and empty files with bounded per-read authorization', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x69), path = join(f.workspace.path, 'source');
    writeFileSync(path, bytes);
    assert.deepEqual(await f.workspace.fingerprint(path, bytes.length), {
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    assert.equal(f.checks, 7, 'initial + four data reads + EOF read + final full authorization');
    await assert.rejects(f.workspace.fingerprint(path, bytes.length - 1), /上限/);
    writeFileSync(join(f.workspace.path, 'empty'), '');
    f.reset();
    assert.deepEqual(await f.workspace.fingerprint(join(f.workspace.path, 'empty'), 0), {
      bytes: 0, sha256: createHash('sha256').digest('hex'),
    });
    assert.equal(f.checks, 3);
  } finally { f.close(); }
});

test('revocation between blocks and at the final boundary refuses the digest', async () => {
  for (const at of [3, 5]) {
    const f = await fixture();
    try {
      const path = join(f.workspace.path, 'source');
      writeFileSync(path, Buffer.alloc(1024 * 1024 + 1));
      f.reset(() => { if (f.checks === at) throw new Error('authority revoked'); });
      await assert.rejects(f.workspace.fingerprint(path, 2 * 1024 * 1024), /authority revoked/);
    } finally { f.close(); }
  }
});

test('block-boundary abort and mutation both refuse the digest', async () => {
  for (const kind of ['abort', 'mutate']) {
    const f = await fixture();
    try {
      const path = join(f.workspace.path, 'source'), bytes = Buffer.alloc(2 * 1024 * 1024);
      writeFileSync(path, bytes);
      f.reset(() => {
        if (f.checks !== 3) return;
        if (kind === 'abort') f.controller.abort(new Error('cancelled between blocks'));
        else writeFileSync(path, Buffer.alloc(bytes.length, 1));
      });
      await assert.rejects(f.workspace.fingerprint(path, bytes.length), kind === 'abort' ? /cancelled/ : /已变化/);
    } finally { f.close(); }
  }
});

test('fingerprint rejects a real replacement of its scratch directory', async () => {
  // Windows can deny renaming a parent with an open child. All platforms test
  // replacement immediately before open; POSIX also tests it between reads.
  for (const at of process.platform === 'win32' ? [1] : [1, 3]) {
    const f = await fixture();
    try {
      const path = join(f.workspace.path, 'source'), bytes = Buffer.alloc(2 * 1024 * 1024);
      writeFileSync(path, bytes);
      let replaced = false;
      f.reset(() => {
        if (f.checks !== at) return;
        renameSync(f.workspace.path, f.workspace.path + '-old');
        mkdirSync(f.workspace.path);
        writeFileSync(path, bytes);
        replaced = true;
      });
      await assert.rejects(f.workspace.fingerprint(path, bytes.length), { code: 'STAGE_CHANGED' });
      assert.equal(replaced, true, 'the original pathname was reused by a different directory containing the same bytes');
      assert.equal(f.checks, at, 'the identity guard rejects at the authorization boundary that changed the directory');
    } finally { f.close(); }
  }
});
