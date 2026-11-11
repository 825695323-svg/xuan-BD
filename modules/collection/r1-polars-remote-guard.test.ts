import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { R1HandoffService } from './r1-structured-handoff.js';

function fixture(hasUploads = true) {
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'r1-polars-recheck-')));
  const db = new CoreDatabase(join(root, 'db.sqlite'));
  const seen: string[] = [];
  const service = new R1HandoffService({ database: db,
    verifyCalculationCandidateRemote: async (taskId, signal) => {
      signal.throwIfAborted(); seen.push(taskId);
    } });
  db.connection.exec('CREATE TABLE material_objects (material_id TEXT PRIMARY KEY,envelope_json TEXT NOT NULL)');
  db.connection.prepare('INSERT INTO material_objects VALUES(?,?)')
    .run('derived-material-1', JSON.stringify({ taskId: 'custody-1' }));
  if (hasUploads) {
    db.connection.exec('CREATE TABLE harness_material_uploads (request_id TEXT PRIMARY KEY,task_id TEXT)');
    db.connection.prepare('INSERT INTO harness_material_uploads VALUES(?,?)')
      .run('polars-stage:original-polars-task', 'custody-1');
  }
  const refs = { originalIds: [], materialIds: ['derived-material-1'], sourceRefs: [],
    processRefs: [{ process_id: 'processing-1' }], evidenceRefs: [] };
  const now = Date.now();
  db.connection.prepare([
    'INSERT INTO r1_handoff_attempts(',
    'request_id,dataset_id,actor_namespace,document_json,document_sha256,',
    'local_refs_json,local_refs_sha256,state,created_at,updated_at)',
    'VALUES(?,?,?,?,?,?,?,?,?,?)',
  ].join(' ')).run('request-1', 'dataset-1', 'actor',
    '{}', 'a'.repeat(64), JSON.stringify(refs), 'b'.repeat(64), 'prepared', now, now);
  return { root, db, service, seen, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('R1 first-send remote check looks up only the frozen staged Polars task identity', async () => {
  const f = fixture();
  try {
    await f.service.assertRemoteCalculationReadyToSend('request-1', new AbortController().signal);
    assert.deepEqual(f.seen, ['original-polars-task']);
  } finally { f.close(); }
});
test('R1 remote Polars source check ignores already externally pending requests', async () => {
  const f = fixture();
  try {
    f.db.connection.prepare("UPDATE r1_handoff_attempts SET state='pending_unknown' WHERE request_id='request-1'").run();
    await f.service.assertRemoteCalculationReadyToSend('request-1', new AbortController().signal);
    assert.deepEqual(f.seen, []);
  } finally { f.close(); }
});
test('absence of a staged upload ledger never fabricates a Polars source proof', async () => {
  const f = fixture(false);
  try {
    await f.service.assertRemoteCalculationReadyToSend('request-1', new AbortController().signal);
    assert.deepEqual(f.seen, []);
  } finally { f.close(); }
});
test('aborted first-send cannot perform the remote Polars source check', async () => {
  const f = fixture();
  const abort = new AbortController(); abort.abort();
  try {
    await assert.rejects(f.service.assertRemoteCalculationReadyToSend('request-1', abort.signal),
      (error: unknown) => (error as { name?: string }).name === 'AbortError');
    assert.deepEqual(f.seen, []);
  } finally { f.close(); }
});
