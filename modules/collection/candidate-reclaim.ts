import { createHash } from 'node:crypto';
import type { CoreDatabase } from '../../platform/state/database.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import { R1_SETTLED_STATES } from './r1-structured-handoff.js';

const SCHEMA = [
  'CREATE TABLE candidate_reclaim_audit (',
  ' plan_digest TEXT PRIMARY KEY, cursor_sha256 TEXT, removed_count INTEGER NOT NULL,',
  ' released_logical_bytes INTEGER NOT NULL, performed_at INTEGER NOT NULL',
  ');',
].join('\n');
const MAX_PAGE = 50;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const validDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
type PlanItem = { sha256: string; byteLength: number };
type Plan = { afterSha256: string | null; nextCursor: string | null; scanned: number;
  candidates: PlanItem[]; blocked: number; sourceMode: 'table' | 'view';
  planDigest: string; globalBlockers: string[] };

export function createCandidateReclaimActions(options: { database: CoreDatabase }) {
  options.database.migrate('candidate-reclaim-audit', 1, SCHEMA);
  const db = options.database.connection;
  const exists = (name: string, type?: string): boolean => !!db.prepare(
    'SELECT 1 FROM sqlite_master WHERE name=? AND type IN (' + (type ? "'" + type + "'" : "'table','view'") + ')')
    .get(name);
  const mode = () => db.prepare("SELECT type FROM sqlite_master WHERE name='candidate_objects'").get()?.type as 'table' | 'view' | undefined;
  const available = () => ({ available: !!mode(),
    ...(mode() ? {} : { reason: '当前实例没有候选加工对象仓储；不创建空数据或扫描磁盘。' }) });
  const query = (after: string | null) => {
    if (!mode()) throw new TaskError('CANDIDATE_RECLAIM_UNAVAILABLE', '没有候选对象存储。');
    const rows = db.prepare('SELECT sha256,byte_length FROM candidate_objects WHERE sha256>? ORDER BY sha256 LIMIT ?')
      .all(after ?? '', MAX_PAGE) as { sha256: string; byte_length: number }[];
    return rows;
  };
  const globalBlockers = (): string[] => {
    const result: string[] = [];
    if (!exists('processing_plan_steps', 'table') || !exists('processing_plan_outputs', 'table'))
      result.push('processing-ledger-unavailable');
    if (exists('candidate_objects_before_sharing', 'table')) result.push('candidate-migration-unfinished');
    if (mode() === 'view' && (!exists('candidate_object_layouts', 'table') || !exists('candidate_row_blocks', 'table')))
      result.push('candidate-layout-unverifiable');
    if (exists('r1_handoff_attempts', 'table')) {
      const rows = db.prepare('SELECT DISTINCT state FROM r1_handoff_attempts').all() as { state: string }[];
      if (rows.some(item => !R1_SETTLED_STATES.has(item.state) && item.state !== 'rejected'))
        result.push('unsettled-r1-handoff');
    }
    const active = db.prepare([
      "SELECT 1 FROM tasks WHERE status NOT IN ('succeeded','failed','cancelled')",
      " AND (action LIKE 'processing.%' OR action LIKE 'data.processing.%' OR action LIKE 'data.r1.%'",
      " OR action LIKE 'algorithms.%' OR action LIKE 'material.%') LIMIT 1",
    ].join('')).get();
    if (active) result.push('active-processing-or-r1-tasks');
    return result;
  };
  const referenced = (digest: string): boolean => {
    const sources = [
      ['processing_plan_steps', ['input_json', 'output_json', 'parameters_json', 'spec_digest']],
      ['processing_plan_outputs', ['structured_json']],
      ['processing_plans', ['plan_json', 'material_manifest_json', 'policy_json', 'operator_json']],
      ['r1_handoff_attempts', ['local_refs_json', 'document_json', 'receipt_json']],
      ['r1_originals', ['source_json']],
      ['routing_decisions', ['dimensions_json', 'suggestions_json', 'gaps_json']],
    ] as const;
    for (const [table, columns] of sources) {
      if (!exists(table, 'table')) continue;
      const info = new Set((db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[]).map(x => x.name));
      const clauses = columns.filter(column => info.has(column));
      if (!clauses.length) continue;
      if (db.prepare('SELECT 1 FROM ' + table + ' WHERE ' + clauses.map(column => 'instr(' + column + ',?)>0').join(' OR ') + ' LIMIT 1')
        .get(...clauses.map(() => digest))) return true;
    }
    // A task can hold a frozen reference without an active processing plan.
    if (db.prepare([
      'SELECT 1 FROM tasks t WHERE t.action NOT IN (\'artifact.candidates.inspect\',\'artifact.candidates.prune\') AND (EXISTS(SELECT 1 FROM json_tree(t.args) WHERE atom=? AND type=\'text\')',
      ' OR EXISTS(SELECT 1 FROM json_tree(t.result) WHERE atom=? AND type=\'text\')',
      ' OR EXISTS(SELECT 1 FROM json_tree(t.checkpoint) WHERE atom=? AND type=\'text\')) LIMIT 1',
    ].join('')).get(digest, digest, digest)) return true;
    return false;
  };
  const preview = (after: string | null): Plan => {
    const sourceMode = mode();
    if (!sourceMode) throw new TaskError('CANDIDATE_RECLAIM_UNAVAILABLE', '没有候选加工对象仓储。');
    const rows = query(after), blockers = globalBlockers(), candidates: PlanItem[] = [];
    let blocked = 0;
    for (const item of rows) {
      if (!validDigest(item.sha256) || !Number.isSafeInteger(item.byte_length) || item.byte_length < 0
        || blockers.length || referenced(item.sha256)) { blocked++; continue; }
      candidates.push({ sha256: item.sha256, byteLength: item.byte_length });
    }
    const nextCursor = rows.length === MAX_PAGE ? rows.at(-1)!.sha256 : null;
    const frozen = { afterSha256: after, nextCursor, scanned: rows.length, candidates, blocked,
      sourceMode, globalBlockers: blockers };
    return { ...frozen, planDigest: sha(JSON.stringify(frozen)) };
  };
  const parse = (args: Record<string, JsonValue>, prune: boolean): { after: string | null; expected: string | null } => {
    const allowed = prune ? ['afterSha256', 'expectedPlanDigest'] : ['afterSha256'];
    if (Object.keys(args).some(key => !allowed.includes(key))
      || args.afterSha256 !== undefined && !validDigest(args.afterSha256)
      || prune && !validDigest(args.expectedPlanDigest))
      throw new TaskError('CANDIDATE_RECLAIM_INPUT', '游标及执行确认须为完整对象摘要；不接受目录或任意 SQL。');
    return { after: (args.afterSha256 as string | undefined) ?? null,
      expected: (args.expectedPlanDigest as string | undefined) ?? null };
  };
  const registration: readonly SkillRegistration[] = [
    { action: 'artifact.candidates.inspect', runtimeId: 'direct', kind: 'direct', modelCalls: 0,
      title: '预览无引用五步加工对象', description: '只读按摘要分页统计无引用的候选对象和阻断原因，不删除对象。',
      fields: [{ key: 'afterSha256', label: '上一页的对象摘要游标', type: 'text', maxLength: 64 }],
      permissionSummary: ['只读加工对象摘要、R1 状态和任务引用', '只列可回收候选，不读取敏感业务内容'], available },
    { action: 'artifact.candidates.prune', runtimeId: 'direct', kind: 'direct', modelCalls: 0,
      title: '明确清理不被引用的五步加工候选对象',
      description: '凭同一页冻结计划摘要，在单数据库事务内再次核对引用，仅删除无引用对象；保留正式 WFD、R1、材料原字节。',
      fields: [{ key: 'afterSha256', label: '上一页的对象摘要游标', type: 'text', maxLength: 64 },
        { key: 'expectedPlanDigest', label: '预览返回的冻结计划摘要', type: 'text', required: true, maxLength: 64 }],
      permissionSummary: ['需要明确受控授权及冻结计划摘要', '任何 R1 未决或加工任务活跃时拒绝操作',
        '正式 WFD 快照、材料原件与历史回执不可删除'], available },
  ];
  return { registrations: registration, handles(action: string) { return registration.some(x => x.action === action); },
    versionBinding() { return { candidateReclaim: 'bd.candidate-reclaim/1' }; },
    async execute(context: TaskExecutionContext, action: string, args: Record<string, JsonValue>): Promise<TaskResult> {
      const prune = action === 'artifact.candidates.prune';
      if (!prune && action !== 'artifact.candidates.inspect') throw new TaskError('CANDIDATE_RECLAIM_ACTION', '未知候选回收动作。');
      const { after, expected } = parse(args, prune);
      if (!prune) {
        const plan = preview(after);
        return { summary: '已完成候选对象的只读分页回收检查，不改变数据库。', data: { ...plan,
          logicalBytesPotentiallyReclaimable: plan.candidates.reduce((sum, row) => sum + row.byteLength, 0) } };
      }
      const authority = await acquireAuthority(context, 'artifact.candidates.prune', { afterSha256: after,
        expectedPlanDigest: expected }, [{ action: 'secret', target: { kind: 'secret', name: 'bd-candidate-storage-maintenance' } }]);
      authority.assert(); context.signal.throwIfAborted();
      const outcome = options.database.transaction(() => {
        const plan = preview(after);
        if (plan.planDigest !== expected) throw new TaskError('CANDIDATE_RECLAIM_STALE', '加工对象候选及引用状态已变化，须重新预览。');
        if (plan.globalBlockers.length) throw new TaskError('CANDIDATE_RECLAIM_BLOCKED',
          '存在未收束的 R1 或加工任务，禁止删除候选对象。');
        if (!plan.candidates.length) return { plan, removed: 0, logicalBytes: 0 };
        const currentMode = mode();
        let removed = 0, logicalBytes = 0;
        for (const item of plan.candidates) {
          // 以原字节再确认内容身份，防止坏对象被静默清理而抹除损坏证据。
          const row = db.prepare('SELECT bytes FROM candidate_objects WHERE sha256=?').get(item.sha256);
          if (!(row?.bytes instanceof Uint8Array) || row.bytes.byteLength !== item.byteLength
            || sha(row.bytes) !== item.sha256)
            throw new TaskError('CANDIDATE_RECLAIM_CORRUPT', '候选对象已损坏；保留现场，不删除。');
          if (currentMode === 'table') {
            db.prepare('DELETE FROM candidate_objects WHERE sha256=?').run(item.sha256);
          } else if (currentMode === 'view') {
            db.prepare('DELETE FROM candidate_object_layouts WHERE sha256=?').run(item.sha256);
          } else throw new TaskError('CANDIDATE_RECLAIM_LAYOUT', '候选对象存储布局无法核对。');
          removed++; logicalBytes += item.byteLength;
        }
        if (currentMode === 'view')
          db.prepare('DELETE FROM candidate_row_blocks WHERE NOT EXISTS (SELECT 1 FROM candidate_object_layouts WHERE block_id=candidate_row_blocks.id)').run();
        db.prepare('INSERT INTO candidate_reclaim_audit VALUES(?,?,?,?,?)')
          .run(plan.planDigest, after, removed, logicalBytes, Date.now());
        return { plan, removed, logicalBytes };
      });
      return { summary: '已按冻结计划明确回收无引用候选对象，保留 WFD 正式数据与材料原件。',
        data: { state: 'reclaimed', removed: outcome.removed, reclaimedLogicalBytes: outcome.logicalBytes,
          nextCursor: outcome.plan.nextCursor, planDigest: outcome.plan.planDigest,
          note: 'SQLite 内部空页可复用；未执行在线 VACUUM，数据库物理文件可能暂不缩小。' } };
    },
  };
}
