import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { TaskError, type TaskExecutionContext } from '../../../platform/jobs/tasks.js';
import { digestOperationArgs } from '../../../platform/security/permissions.js';
import { runDirectProcess } from '../../../platform/runtime/process.js';
import type { ProcessRuntime } from '../../../platform/runtime/programs.js';
import { cleanCandidateTable, structureCandidateTable, type CandidateTablePlan,
  type CleanedCandidateTable, type ParsedCandidateTable, type StructuredCandidateTable } from '../candidate-pipeline.js';
import { normalizeNumericLexeme } from './numeric-format.js';
import { POLARS_DEPENDENCY_VERSION } from './polars-fixed.js';

/**
 * 清洗引擎独立于算法/因子引擎。仅对已解析并保留原值、原句与原位置的
 * 列执行受信 Polars trim/empty_to_null。TypeScript 规则只充当独立等价核对；
 * 最终单元格值必须来自 Python/Polars 的真实回执，不能自动回退到 JS。
 */
export const POLARS_CLEAN_VERSION = 'bd.polars-clean/1';
const worker = fileURLToPath(new URL('./polars-clean-worker.py', import.meta.url));
const workerSha256 = wfdSha256(readFileSync(worker));
export const POLARS_STRUCTURE_VERSION = 'bd.polars-structure/1';
const structureWorker = fileURLToPath(new URL('./polars-structure-worker.py', import.meta.url));
const structureWorkerSha256 = wfdSha256(readFileSync(structureWorker));
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const digest = (value: unknown) => wfdSha256(canonicalWfdJson(value));
const BATCH_ROWS = 2500;
const BATCH_INPUT_BYTES = 800_000;

interface Rules { trim: string[]; emptyToNull: string[] }
export interface PolarsCleanResult { cleaned: CleanedCandidateTable; evidence: WfdRecord }

export class PolarsSourceCleaner {
  readonly versionBinding = Object.freeze({
    polarsClean: POLARS_CLEAN_VERSION, polarsCleanWorker: workerSha256,
    polarsCleanDependency: POLARS_DEPENDENCY_VERSION,
    polarsStructure: POLARS_STRUCTURE_VERSION, polarsStructureWorker: structureWorkerSha256,
  });
  constructor(private readonly runtime: ProcessRuntime) {}

  capabilities() {
    let reason: string | null = null;
    try {
      const path = this.runtime.path('polars-python');
      if (!statSync(realpathSync(path)).isFile()) throw Error('受信 Polars Python 不是普通文件。');
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    return { engine: 'polars' as const, status: reason ? 'blocked' as const : 'ready' as const,
      reason, version: POLARS_CLEAN_VERSION, methods: ['trim', 'empty_to_null', 'strict_structure'] as const,
      policy: 'strict_utf8_values_no_auto_null_no_fallback' };
  }

  async clean(context: TaskExecutionContext, parsed: ParsedCandidateTable, rules: Rules): Promise<PolarsCleanResult> {
    const caps = this.capabilities();
    if (caps.status !== 'ready') return fail('POLARS_CLEAN_UNAVAILABLE', caps.reason ?? '严格清洗引擎未装配。');
    const allowed = new Set(parsed.columns);
    if ([...rules.trim, ...rules.emptyToNull].some(name => !allowed.has(name))
      || new Set(rules.trim).size !== rules.trim.length
      || new Set(rules.emptyToNull).size !== rules.emptyToNull.length)
      return fail('POLARS_CLEAN_RULES', '显式清洗规则含不存在或重复的字段。');
    // 原既有声明式规则是独立核对器，不让 Polars 自动猜类型或把错误值改写为 null。
    const expected = cleanCandidateTable(parsed, rules);
    const original = parsed.rows, values = original.map(row => row.map(cell => typeof cell.value === 'string' ? cell.value : null));
    const resultRows: (string | null)[][] = [];
    const receipts: string[] = [];
    const registeredPython = this.runtime.path('polars-python');
    const frozenPython = realpathSync(registeredPython);
    const assertAuthorized = () => {
      context.signal.throwIfAborted();
      if (realpathSync(this.runtime.path('polars-python')) !== frozenPython
        || wfdSha256(readFileSync(worker)) !== workerSha256) {
        return fail('POLARS_CLEAN_CHANGED', 'Polars 程序或清洗实现字节已变化，不允许以原任务继续执行。');
      }
      context.assertAuthorized({ operationId: 'processing.polars.clean.execute', operationVersion: 1,
        approvalMode: 'automatic', argsDigest: digestOperationArgs(context.task.args),
        targets: [{ kind: 'file', path: registeredPython }] },
        [{ action: 'execute', target: { kind: 'file', path: registeredPython } }]);
    };
    let index = 0;
    while (index < values.length) {
      context.signal.throwIfAborted();
      let chunk: (string | null)[][] = [], bytes = 0;
      for (let j = index; j < values.length && chunk.length < BATCH_ROWS; j++) {
        const next = [...chunk, values[j]!];
        const sample = { version: POLARS_CLEAN_VERSION, operation: 'clean', columns: parsed.columns,
          rows: next, rules };
        const n = Buffer.byteLength(canonicalWfdJson(sample));
        if (n > BATCH_INPUT_BYTES) {
          if (!chunk.length) return fail('POLARS_CLEAN_INPUT_BUDGET', '单行清洗输入超过受信预算；未截断行或扩张界限。');
          break;
        }
        chunk = next; bytes = n;
      }
      if (!chunk.length || !bytes) return fail('POLARS_CLEAN_INPUT_BUDGET', '清洗批次没有完整原值。');
      const request = { version: POLARS_CLEAN_VERSION, operation: 'clean', columns: parsed.columns,
        rows: chunk, rules };
      const input = canonicalWfdJson(request);
      assertAuthorized();
      const output = await runDirectProcess({ binary: 'polars-python', binaryPath: registeredPython,
        runtime: this.runtime, args: ['-I', '-B', worker], stdin: input, cwd: '/', signal: context.signal,
        assertAuthorized, timeoutMs: 15_000, maxOutputBytes: 2_100_000,
        onProcessState: event => context.emit({ type: 'process_state', ...event }),
        onHeartbeat: event => context.emit({ type: 'heartbeat', ...event }) });
      assertAuthorized();
      let response: unknown;
      try { response = JSON.parse(output.stdout); }
      catch { return fail('POLARS_CLEAN_RESPONSE', '清洗引擎没有返回可核对的完整 JSON 回执。'); }
      if (isWfdRecord(response) && response.ok === false)
        return fail('POLARS_CLEAN_' + String(response.code), String(response.message ?? '严格清洗被拒绝。'));
      if (!isWfdRecord(response) || response.version !== POLARS_CLEAN_VERSION
        || response.executor !== 'polars' || response.polars_version !== POLARS_DEPENDENCY_VERSION
        || response.operation !== 'clean' || response.input_sha256 !== digest(request)
        || !Array.isArray(response.rows) || response.rows.length !== chunk.length) {
        return fail('POLARS_CLEAN_RESPONSE', '清洗回执引擎、版本、输入摘要或行数不匹配。');
      }
      for (let r = 0; r < chunk.length; r++) {
        const projected = response.rows[r];
        if (!Array.isArray(projected) || projected.length !== parsed.columns.length
          || projected.some(value => value !== null && typeof value !== 'string'))
          return fail('POLARS_CLEAN_RESPONSE', '返回列数或单元格类型与冻结请求不同。');
        for (let c = 0; c < parsed.columns.length; c++) {
          const before = original[index + r]![c]!.value;
          const expectedValue = expected.rows[index + r]![c]!.value;
          const actual = projected[c];
          if (typeof before === 'string' ? actual !== expectedValue : actual !== null || before !== expectedValue)
            return fail('POLARS_CLEAN_MISMATCH', '严格列式清洗与已冻结原值的独立规则不一致；未采用错误候选。');
        }
        resultRows.push(projected as (string | null)[]);
      }
      receipts.push(digest(response));
      await context.emit({ type: 'checkpoint', checkpoint: {
        stage: 'clean', engine: 'polars', lastVerifiedRow: index + chunk.length,
        workerSha256, sourceSha256: parsed.source_sha256, chunkReceiptSha256: receipts[receipts.length - 1],
      } });
      index += chunk.length;
    }
    if (resultRows.length !== expected.rows.length) return fail('POLARS_CLEAN_MISMATCH', 'Polars 严格清洗没有覆盖全部来源行。');
    const cleaned: CleanedCandidateTable = { ...expected,
      rows: original.map((row, ri) => row.map((cell, ci) => ({ ...cell,
        value: typeof cell.value === 'string' ? resultRows[ri]![ci] : cell.value }))) };
    if (canonicalWfdJson(cleaned) !== canonicalWfdJson(expected))
      return fail('POLARS_CLEAN_MISMATCH', 'Polars 输出字节与独立清洗结果不一致，拒绝发布。');
    return { cleaned, evidence: {
      engine: 'polars', version: POLARS_CLEAN_VERSION, workerSha256, polarsVersion: POLARS_DEPENDENCY_VERSION,
      inputSha256: digest({ source: parsed.source_sha256, columns: parsed.columns, rules }),
      outputSha256: digest(cleaned), rows: cleaned.rows.length,
      chunkCount: receipts.length, chunkReceiptsSha256: digest(receipts),
      strictConversion: true, fallback: false,
    } };
  }
  /** 与金融计算隔离的显式 schema 结构化；Polars 执行声明类型，原 TS 数值规则独立校核。 */
  async structure(context: TaskExecutionContext,
    cleaned: CleanedCandidateTable | ParsedCandidateTable, types?: CandidateTablePlan['types'],
  ): Promise<{ structured: StructuredCandidateTable; evidence: WfdRecord }> {
    const caps = this.capabilities();
    if (caps.status !== 'ready') return fail('POLARS_STRUCTURE_UNAVAILABLE', caps.reason ?? '受信 Polars 结构化进程未装配。');
    const applied = types ?? cleaned.types ?? {};
    if (Object.entries(applied).some(([field, type]) => !cleaned.columns.includes(field)
      || !['string', 'safe_integer', 'decimal_string', 'boolean', 'binary64_hex'].includes(type)))
      return fail('POLARS_STRUCTURE_DECLARATION', '固定类型声明含不在来源表中的字段或未知类型。');
    const expected = structureCandidateTable(cleaned, types);
    const values = cleaned.rows.map(row => row.map((cell, col) => {
      const value = cell.value, format = cleaned.numericFormats?.[cleaned.columns[col]!];
      const lexeme = format && value !== null
        ? typeof value === 'string' ? normalizeNumericLexeme(value, format)
          : fail('POLARS_STRUCTURE_NUMERIC_FORMAT', '地域数值规则只接收原文字符串，禁止浮点倒推原词。')
        : value;
      return { value: lexeme === null ? null : String(lexeme),
        kind: lexeme === null ? 'null' : typeof lexeme };
    }));
    const results: unknown[][] = [];
    const receipts: string[] = [];
    const registeredPython = this.runtime.path('polars-python'), frozenPython = realpathSync(registeredPython);
    const assertAuthorized = () => {
      context.signal.throwIfAborted();
      if (realpathSync(this.runtime.path('polars-python')) !== frozenPython
        || wfdSha256(readFileSync(structureWorker)) !== structureWorkerSha256)
        return fail('POLARS_STRUCTURE_CHANGED', '受信 Polars 可执行程序或结构化实现发生改变。');
      context.assertAuthorized({ operationId: 'processing.polars.structure.execute', operationVersion: 1,
        approvalMode: 'automatic', argsDigest: digestOperationArgs(context.task.args),
        targets: [{ kind: 'file', path: registeredPython }] },
        [{ action: 'execute', target: { kind: 'file', path: registeredPython } }]);
    };
    let offset = 0;
    while (offset < values.length) {
      context.signal.throwIfAborted();
      let chunk: typeof values = [];
      for (let i = offset; i < values.length && chunk.length < BATCH_ROWS; i++) {
        const next = [...chunk, values[i]!];
        if (Buffer.byteLength(canonicalWfdJson({ version: POLARS_STRUCTURE_VERSION,
          operation: 'structure', columns: cleaned.columns, rows: next, types: applied })) > BATCH_INPUT_BYTES) {
          if (!chunk.length) return fail('POLARS_STRUCTURE_INPUT_BUDGET', '单行结构化输入超预算，拒绝截断。');
          break;
        }
        chunk = next;
      }
      if (!chunk.length) return fail('POLARS_STRUCTURE_INPUT_BUDGET', '结构化批次没有完整原始行。');
      const request = { version: POLARS_STRUCTURE_VERSION,
        operation: 'structure', columns: cleaned.columns, rows: chunk, types: applied };
      assertAuthorized();
      const output = await runDirectProcess({ binary: 'polars-python', binaryPath: registeredPython,
        runtime: this.runtime, args: ['-I', '-B', structureWorker], stdin: canonicalWfdJson(request), cwd: '/',
        signal: context.signal, assertAuthorized, timeoutMs: 15_000, maxOutputBytes: 2_100_000,
        onProcessState: event => context.emit({ type: 'process_state', ...event }),
        onHeartbeat: event => context.emit({ type: 'heartbeat', ...event }) });
      assertAuthorized();
      let received: unknown;
      try { received = JSON.parse(output.stdout); } catch {
        return fail('POLARS_STRUCTURE_RESPONSE', '结构化进程未返回有效的 JSON 回执。');
      }
      if (isWfdRecord(received) && received.ok === false)
        return fail('POLARS_STRUCTURE_' + String(received.code), String(received.message ?? '严格类型转换拒绝。'));
      if (!isWfdRecord(received) || received.version !== POLARS_STRUCTURE_VERSION
        || received.executor !== 'polars' || received.polars_version !== POLARS_DEPENDENCY_VERSION
        || received.operation !== 'structure' || received.input_sha256 !== digest(request)
        || !Array.isArray(received.rows) || received.rows.length !== chunk.length)
        return fail('POLARS_STRUCTURE_RESPONSE', '结构化回执的执行器、版本、原值摘要或完整行数不匹配。');
      for (let row = 0; row < chunk.length; row++) {
        const actual = received.rows[row];
        if (!Array.isArray(actual) || actual.length !== cleaned.columns.length)
          return fail('POLARS_STRUCTURE_RESPONSE', '结构化回执行宽与原字段不一致。');
        const mapped: unknown[] = [];
        for (let col = 0; col < cleaned.columns.length; col++) {
          const name = cleaned.columns[col]!, declared = applied[name];
          const expectedCell = expected.rows[offset + row]![col]!.value;
          // 未声明类型不授权隐式转换；沿原数据契约保留原/精度校核的值。
          const candidate = declared ? actual[col] : expectedCell;
          if (candidate !== expectedCell) return fail('POLARS_STRUCTURE_MISMATCH',
            'Polars 严格转换与原已验收的无损类型规则不一致，拒绝采用或生成空值。');
          mapped.push(candidate);
        }
        results.push(mapped);
      }
      receipts.push(digest(received));
      await context.emit({ type: 'checkpoint', checkpoint: {
        stage: 'structure', engine: 'polars', verifiedRows: offset + chunk.length,
        workerSha256: structureWorkerSha256, sourceSha256: cleaned.source_sha256,
        chunkReceiptSha256: receipts[receipts.length - 1],
      } });
      offset += chunk.length;
    }
    if (results.length !== expected.rows.length) return fail('POLARS_STRUCTURE_MISMATCH', '未处理完全部固定来源行。');
    const structured: StructuredCandidateTable = { ...expected,
      rows: expected.rows.map((row, ri) => row.map((cell, ci) => ({ ...cell, value: results[ri]![ci] as typeof cell.value }))) };
    if (canonicalWfdJson(structured) !== canonicalWfdJson(expected))
      return fail('POLARS_STRUCTURE_MISMATCH', '类型产物或原始证据与冻结独立核验不一致。');
    return { structured, evidence: {
      engine: 'polars', version: POLARS_STRUCTURE_VERSION, workerSha256: structureWorkerSha256,
      inputSha256: digest({ source: cleaned.source_sha256, columns: cleaned.columns, types: applied }),
      outputSha256: digest(structured), rows: structured.rows.length,
      chunkCount: receipts.length, chunkReceiptsSha256: digest(receipts),
      strictConversion: true, silentNullFallback: false,
    } };
  }

}
