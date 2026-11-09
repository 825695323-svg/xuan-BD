import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startupIdentityDecision, type StartupIdentity } from './configured-app.js';
import { LocalDataLifecycle } from '../../platform/runtime/local-data-lifecycle.js';
import { CoreDatabase } from '../../platform/state/database.js';

const base = { service: false, sharedControl: false, active: true, adopted: true, firstBinding: false };
const decide = (identity: StartupIdentity, patch: Partial<typeof base> = {}) => startupIdentityDecision({ ...base, identity, ...patch });

test('startup identity allows matched and a genuinely new first binding only', () => {
  assert.equal(decide('matched').allowed, true);
  assert.equal(decide('unbound', { firstBinding: true }).allowed, true);
  const denied = decide('unbound', { firstBinding: false });
  assert.equal(denied.allowed, false);
  assert.match(denied.detail ?? '', /缺少状态库身份绑定/);
  assert.equal(decide('missing').allowed, false);
  assert.equal(decide('replaced').allowed, false);
  assert.equal(decide('matched', { active: false }).allowed, false);
  assert.equal(decide('matched', { adopted: false }).allowed, false);
});

test('independent service role cannot skip identity verification', () => {
  assert.equal(startupIdentityDecision({ ...base, service: true, sharedControl: true, identity: 'matched' }).allowed, true);
  const withoutSharedControl = startupIdentityDecision({ ...base, service: true, sharedControl: false, identity: 'matched' });
  assert.equal(withoutSharedControl.allowed, false);
  assert.match(withoutSharedControl.detail ?? '', /共享/);
  assert.equal(startupIdentityDecision({ ...base, service: true, sharedControl: true, identity: 'replaced' }).allowed, false);
});

test('isolated control library: first binding, lost identity row, replaced and missing state file', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xuan-startup-identity-')));
  const controlPath = join(root, 'control.sqlite'), statePath = join(root, 'core.sqlite');
  writeFileSync(statePath, 'isolated state');
  const lifecycle = new LocalDataLifecycle({ controlDatabasePath: controlPath, dataIdFromTask: () => 'isolated' });
  const control = new CoreDatabase(controlPath);
  try {
    // 首次绑定：控制库确实从零新建了一条记录。
    const before = lifecycle.list().length;
    assert.equal(before, 0);
    const record = lifecycle.register('isolated');
    const firstBinding = lifecycle.list().length === before + 1;
    assert.equal(firstBinding, true);
    assert.equal(lifecycle.identityStatus('isolated', statePath), 'unbound');
    assert.equal(decide('unbound', { firstBinding, active: record.status === 'active', adopted: record.adopted }).allowed, true);

    lifecycle.bindIdentity('isolated', statePath);
    assert.equal(lifecycle.identityStatus('isolated', statePath), 'matched');
    assert.equal(decide('matched').allowed, true);

    // 已有记录但身份行丢失：不允许重新绑定。
    control.connection.prepare('DELETE FROM local_data_lifecycle_identity WHERE data_id=?').run('isolated');
    assert.equal(lifecycle.identityStatus('isolated', statePath), 'unbound');
    assert.equal(decide('unbound', { firstBinding: false }).allowed, false, 'existing record without identity row must not rebind');

    // 原状态库对象被替换（新 inode）。
    lifecycle.bindIdentity('isolated', statePath);
    renameSync(statePath, `${statePath}.previous`);
    writeFileSync(statePath, 'replacement object with a different inode');
    assert.equal(lifecycle.identityStatus('isolated', statePath), 'replaced');
    assert.equal(decide('replaced').allowed, false);

    // 原状态库缺失。
    rmSync(statePath);
    assert.equal(lifecycle.identityStatus('isolated', statePath), 'missing');
    assert.equal(decide('missing').allowed, false);
  } finally {
    control.close();
    await lifecycle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
