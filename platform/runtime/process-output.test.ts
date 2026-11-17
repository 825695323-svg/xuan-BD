import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ResourceBindings } from '../resources/bindings.js';
import { ProcessRuntime } from './programs.js';
import { runDirectProcess } from './process.js';
import { createWhisperProgressParser } from '../capabilities/transcription/progress.js';

function fixture() {
  const root = mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'output-observer-'));
  mkdirSync(join(root, 'config'));
  const resources: Record<string, unknown> = { node: { path: process.execPath, kind: 'program' } };
  for (const key of ['cache', 'temp', 'downloads']) {
    const path = join(root, key); mkdirSync(path); const stat = statSync(path, { bigint: true });
    resources[key] = { path, kind: 'directory', owned: true, identity: key, device: String(stat.dev), inode: String(stat.ino) };
  }
  writeFileSync(join(root, '.xuan-runtime.json'), JSON.stringify({ version: 1, application: 'xuan-bd', identity: 'output-test' }));
  writeFileSync(join(root, 'config/machine.bindings.json'), JSON.stringify({ version: 1, revision: 1, runtimeIdentity: 'output-test', resources }));
  return { root, runtime: new ProcessRuntime(new ResourceBindings(root)) };
}

test('actual controlled process output is observed in order without turning arbitrary activity into native progress', async () => {
  const { root, runtime } = fixture(), parser = createWhisperProgressParser(), observed: number[] = [];
  let pending = 0, maximum = 0;
  try {
    const result = await runDirectProcess({ binary: 'node', runtime, cwd: root, signal: new AbortController().signal,
      assertAuthorized() {}, args: ['-e', `process.stdout.write('whisper_print_progress_callback: progress = 100%\\n');
        process.stderr.write('whisper_print_progress_callback: progress =  10%\\n');
        setTimeout(()=>process.stderr.write('ordinary activity\\nwhisper_print_progress_callback: progress =  10%\\nwhisper_print_progress_callback: progress =   5%\\nwhisper_print_progress_callback: progress =  20%\\n'),30);`],
      async onOutput(stream, chunk) { maximum = Math.max(maximum, ++pending); await new Promise(r => setTimeout(r, 5)); observed.push(...parser.push(stream, chunk)); pending--; },
    });
    assert.deepEqual(observed, [10, 20]); assert.equal(maximum, 1); assert.equal(pending, 0);
    assert.match(result.stdout, /100%/); assert.match(result.stderr, /ordinary activity/);
  } finally { runtime.closeTemporaryRetention(); }
});

test('failed output observation refuses a successful process result instead of silently losing evidence', async () => {
  const { root, runtime } = fixture();
  try {
    await assert.rejects(runDirectProcess({ binary: 'node', runtime, cwd: root, signal: new AbortController().signal,
      assertAuthorized() {}, args: ['-e', 'process.stderr.write("bounded synthetic output");'],
      onOutput() { throw new Error('synthetic observer refusal'); },
    }), { code: 'PROCESS_OBSERVATION_FAILED', disposition: 'unknown' });
  } finally { runtime.closeTemporaryRetention(); }
});
