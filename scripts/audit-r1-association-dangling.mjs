#!/usr/bin/env node
/**
 * 只读体检：R1 关联（r1_record_associations）里引用的计划、输出和候选对象是否还在。
 *
 * 关联是 JSON 文本快照而不是外键，因此「候选已删、正式记录仍引用」在结构上是可能的。
 * 本脚本只读打开工作台库，输出悬空引用计数与样例；不写库、不修数据、不导出正文。
 *
 * 用法：node scripts/audit-r1-association-dangling.mjs [工作台库路径]
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// 工作台库在工程外的「运行数据」；scripts 位于「Xuan BD/scripts」，故向上一级到工程根、再上一级到外层目录。
const databasePath = process.argv[2] ?? resolve(here, '../../运行数据/runtime/state/workspace/core.sqlite');
if (!existsSync(databasePath)) {
  console.error(JSON.stringify({ error: 'WORKSPACE_DATABASE_NOT_FOUND', databasePath }));
  process.exit(2);
}

const db = new DatabaseSync(databasePath, { readOnly: true });
const hasTable = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
const parse = text => { try { return JSON.parse(String(text)); } catch { return null; } };
const stripPrefix = value => String(value).replace(/^sha256:/u, '');

const summary = { associations: 0, danglingPlan: 0, danglingOutput: 0, danglingObject: 0, samples: [] };
const addSample = (entry) => { if (summary.samples.length < 10) summary.samples.push(entry); };

if (!hasTable('r1_record_associations')) {
  console.log(JSON.stringify({ databasePath, readOnly: true, error: 'ASSOCIATION_TABLE_MISSING' }, null, 2));
  db.close();
  process.exit(0);
}

const plans = hasTable('processing_plans');
const outputs = hasTable('processing_plan_outputs');
const layouts = hasTable('candidate_object_layouts');
const planExists = db.prepare('SELECT 1 FROM processing_plans WHERE plan_id=?');
const outputExists = db.prepare('SELECT 1 FROM processing_plan_outputs WHERE plan_id=? AND output_id=?');
const objectExists = db.prepare('SELECT 1 FROM candidate_object_layouts WHERE sha256=?');

for (const row of db.prepare('SELECT request_id, process_refs_json, evidence_refs_json FROM r1_record_associations').iterate()) {
  summary.associations += 1;
  const processes = parse(row.process_refs_json);
  const evidences = parse(row.evidence_refs_json);
  for (const ref of Array.isArray(processes) ? processes : []) {
    const planId = typeof ref?.plan_id === 'string' ? ref.plan_id : '';
    const outputId = typeof ref?.output_id === 'string' ? ref.output_id : '';
    if (plans && planId && !planExists.get(planId)) {
      summary.danglingPlan += 1;
      addSample({ requestId: String(row.request_id), kind: 'plan', id: planId });
    }
    if (outputs && planId && outputId && !outputExists.get(planId, outputId)) {
      summary.danglingOutput += 1;
      addSample({ requestId: String(row.request_id), kind: 'output', id: `${planId}/${outputId}` });
    }
    const outputSha = typeof ref?.output_sha256 === 'string' ? stripPrefix(ref.output_sha256) : '';
    if (layouts && outputSha && !objectExists.get(outputSha)) {
      summary.danglingObject += 1;
      addSample({ requestId: String(row.request_id), kind: 'candidate_object', id: outputSha.slice(0, 16) });
    }
  }
  for (const evidence of Array.isArray(evidences) ? evidences : []) {
    const contentSha = typeof evidence?.content_sha256 === 'string' ? stripPrefix(evidence.content_sha256) : '';
    if (layouts && contentSha && !objectExists.get(contentSha)) {
      summary.danglingObject += 1;
      addSample({ requestId: String(row.request_id), kind: 'evidence', id: contentSha.slice(0, 16) });
    }
  }
}
db.close();

const dangling = summary.danglingPlan + summary.danglingOutput + summary.danglingObject;
console.log(JSON.stringify({ databasePath, readOnly: true, ...summary, dangling, verdict: dangling === 0 ? 'no_dangling_reference' : 'dangling_reference_found' }, null, 2));
process.exit(dangling === 0 ? 0 : 1);
