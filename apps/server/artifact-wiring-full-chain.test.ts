import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { isModelActionAllowed, modelActionApprovalMode } from '../../modules/agent/model-tools.js';
import { artifactReleaseBlockers } from '../../modules/collection/artifact-lifecycle.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';

test('real host exposes all artifact tools and accepts frozen versions for read-only actions', async () => {
  const fixture = createFullChainFixture({ name: 'artifact-tool-wiring-fixed' });
  const host = await openFullChainHost(fixture);
  try {
    const registry = host.services.direct.registry;
    const actions = ['artifact.manifest', 'artifact.archive', 'artifact.restore', 'artifact.inspect',
      'artifact.release', 'artifact.candidates.inspect', 'artifact.candidates.prune'];
    for (const action of actions) {
      const entry = registry.get(action);
      assert.equal(entry.runtimeId, 'direct', action);
      assert.equal(entry.kind, 'direct', action);
      assert.equal(isModelActionAllowed(action), true, action);
    }
    assert.equal(modelActionApprovalMode('artifact.release', {}), 'review');
    assert.equal(modelActionApprovalMode('artifact.candidates.prune', {}), 'review');
    const manifest = registry.captureVersions('artifact.manifest', { sourceTaskId: 'audit-source' });
    assert.match(manifest.directImplementation, /^[a-f0-9]{64}$/u);
    const candidate = registry.captureVersions('artifact.candidates.inspect', {});
    assert.match(candidate.directImplementation, /^[a-f0-9]{64}$/u);
    assert.notEqual(manifest.directImplementation, candidate.directImplementation);
  } finally { await host.close(); }
});

test('real host current processing and segment tables no longer block unrelated file release', async () => {
  const fixture = createFullChainFixture({ name: 'artifact-release-real-schema-fixed' });
  const host = await openFullChainHost(fixture);
  try {
    const path = join(host.services.artifactRoot, 'isolated-source-generated.txt');
    writeFileSync(path, 'isolated source with no business consumers\n');
    const reference = host.services.files.register({ path, source: 'generated', taskId: 'source-isolated' });
    const blockers = () => artifactReleaseBlockers(host.database, host.services.files,
      'source-isolated', host.services.files.getRef(reference.id), host.services.artifactRoot);
    assert.deepEqual(blockers(), [], '真实数据表存在但没有引用时必须允许进入后续远端核验');
    host.services.files.link(reference.id, { conversationId: 'conversation-consumer' });
    assert.ok(blockers().includes('other-file-relations'), '会话仍持有文件引用时继续阻断清理');
  } finally { await host.close(); }
});
