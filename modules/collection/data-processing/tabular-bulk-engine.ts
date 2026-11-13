import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, statfs, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalWfdJson, wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import type { TabularBatchChunk, TabularCell } from '../../../contracts/tabular-batch.js';

export const TABULAR_BULK_LIMITS = Object.freeze({
  sourceBytes: 256 * 1024 * 1024, rows: 2_000_000, stagedBytes: 768 * 1024 * 1024,
  recordBytes: 512 * 1024, segmentBytes: 512 * 1024, segmentRows: 1000,
  chunkBytes: 512 * 1024, chunkRows: 5000, chunks: 512,
});
const SORT_FAN_IN = 16;
const RUN_BYTES = 4 * 1024 * 1024;
const FILE_RESERVE = 64 * 1024 * 1024;

type Fail = (code: string, message: string) => never;
export interface BulkLocator { sourceRow: number; sourceLine: number; startByte: number; endByte: number }
export interface BulkRawRecord { locator: BulkLocator; bytes: Buffer }
interface SpoolRow { cells: TabularCell[]; locator: BulkLocator; key: Buffer[]; json: string }
const compare = (a: SpoolRow, b: SpoolRow) => {
  for (let i = 0; i < a.key.length; i++) {
    const order = Buffer.compare(a.key[i]!, b.key[i]!);
    if (order) return order;
  }
  return 0;
};
export const bulkCoordinates = (row: BulkLocator) => `原件第 ${row.sourceRow} 条记录（第 ${row.sourceLine} 行、字节 ${row.startByte}–${row.endByte}）`;
const digest = (value: unknown) => 'sha256:' + wfdSha256(canonicalWfdJson(value));
const sha = (bytes: string | Uint8Array) => 'sha256:' + wfdSha256(bytes);
const shaSyntax = /^sha256:[0-9a-f]{64}$/u;
/** Only frames CSV records by byte. The ordinary candidate CSV parser still validates and decodes all cells. */
export async function* bulkRawRecords(input: AsyncIterable<Uint8Array>, maxBytes: number, hash: ReturnType<typeof createHash>, fail: Fail): AsyncGenerator<BulkRawRecord> {
  const record = Buffer.allocUnsafe(TABULAR_BULK_LIMITS.recordBytes);
  let offset = 0, startByte = 0, size = 0, sourceRow = 0, line = 1, sourceLine = 1;
  let quoted = false, pendingCr = false, wasCr = false;
  const copy = (part: Buffer, begin: number, end: number) => {
    if (size + end - begin > record.length) fail('RECORD_BUDGET', `原件第 ${sourceRow + 1} 条 CSV 记录超过单条字节预算。`);
    part.copy(record, size, begin, end); size += end - begin;
  };
  const emit = (endByte: number) => {
    const locator = { sourceRow: ++sourceRow, sourceLine, startByte, endByte };
    const bytes = Buffer.from(record.subarray(0, size));
    size = 0; startByte = endByte; sourceLine = line;
    return { locator, bytes };
  };
  for await (const value of input) {
    if (!(value instanceof Uint8Array)) fail('SOURCE', '原件流必须提供字节块。');
    if (offset + value.byteLength > maxBytes) fail('SOURCE_CHANGED', '受管原件字节流超过冻结长度。');
    hash.update(value);
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    let segmentStart = 0;
    for (let i = 0; i < bytes.length; i++) {
      const ch = bytes[i]!;
      if (pendingCr) {
        pendingCr = false;
        if (ch === 10) {
          copy(bytes, segmentStart, i + 1); segmentStart = i + 1;
          yield emit(offset + i + 1); wasCr = false;
          continue;
        }
        copy(bytes, segmentStart, i); segmentStart = i;
        yield emit(offset + i);
      }
      if (ch === 13 || ch === 10 && !wasCr) line++;
      wasCr = ch === 13;
      if (ch === 34) quoted = !quoted;
      else if (!quoted && ch === 13) pendingCr = true;
      else if (!quoted && ch === 10) {
        copy(bytes, segmentStart, i + 1); segmentStart = i + 1;
        yield emit(offset + i + 1);
      }
    }
    copy(bytes, segmentStart, bytes.length);
    offset += bytes.length;
  }
  if (quoted) fail('CSV_QUOTES', `原件第 ${sourceRow + 1} 条 CSV 记录到文件末尾仍未闭合引号。`);
  if (size) yield emit(offset);
  if (offset !== maxBytes) fail('SOURCE_CHANGED', '受管原件字节流短于冻结长度。');
}

const locatorValues = (locator: BulkLocator): number[] =>
  [locator.sourceRow, locator.sourceLine, locator.startByte, locator.endByte];
function readLocator(value: unknown, fail: Fail): BulkLocator {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isSafeInteger)
    || value[0] < 2 || value[1] < 2 || value[2] < 1 || value[3] <= value[2])
    return fail('STAGING', '加工定位片段格式或范围无效。');
  return { sourceRow: value[0], sourceLine: value[1], startByte: value[2], endByte: value[3] };
}
const runLine = (row: SpoolRow) => '[' + row.json + ',' + JSON.stringify(locatorValues(row.locator)) + ']\n';

interface BulkRun { path: string; digest: string }

class BulkSpool {
  private bytes = 0;
  constructor(readonly root: string, private readonly fail: Fail, private readonly assertGrowth?: (bytes: number) => void) {}
  async writer(name: string) {
    const path = join(this.root, name);
    const hash = createHash('sha256');
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    return {
      write: async (value: string) => {
        const data = Buffer.from(value, 'utf8');
        if (this.bytes + data.length > TABULAR_BULK_LIMITS.stagedBytes)
          this.fail('STAGING_BUDGET', '原件加工副本达到单件外部暂存上限。');
        const free = await statfs(this.root, { bigint: true });
        if (free.bavail * free.bsize < BigInt(FILE_RESERVE + data.length))
          this.fail('STAGING_BUDGET', '外部加工目录可用空间不足，未继续写入或回退到内部磁盘。');
        this.assertGrowth?.(data.length);
        this.bytes += data.length; hash.update(data);
        for (let at = 0; at < data.length;) {
          const result = await handle.write(data, at, data.length - at);
          if (!result.bytesWritten) this.fail('STAGING', '加工片段写入无进展。');
          at += result.bytesWritten;
        }
      },
      close: async () => { await handle.close(); return { path, digest: 'sha256:' + hash.digest('hex') }; },
    };
  }
  async put(name: string, value: string) {
    const writer = await this.writer(name);
    let stored: BulkRun;
    try { await writer.write(value); } finally { stored = await writer.close(); }
    return stored;
  }
  async removeRun(path: string) {
    const file = await lstat(path);
    if (!file.isFile() || dirname(path) !== this.root || !/^run-\d+-\d+\.ndjson$/u.test(basename(path)))
      this.fail('STAGING', '只允许回收本次生成的排序片段。');
    await unlink(path); this.bytes -= file.size;
  }
}

function makeSpoolRow(cells: TabularCell[], locator: BulkLocator, keyIndices: readonly number[], fail: Fail): SpoolRow {
  const key = keyIndices.map(i => {
    const value = cells[i];
    if (typeof value !== 'string') return fail('STAGING', '排序片段缺少冻结业务键。');
    return Buffer.from(value, 'utf8');
  });
  return { cells, locator, key, json: JSON.stringify(cells) };
}
function isCellMatrix(value: unknown, fieldCount: number): value is TabularCell[][] {
  return Array.isArray(value) && value.every(row => Array.isArray(row) && row.length === fieldCount
    && row.every(cell => cell === null || typeof cell === 'string'));
}

async function* runRows(run: BulkRun, order: BulkOrder): AsyncGenerator<SpoolRow> {
  const { fail, fieldCount, keyIndices } = order;
  const file = await open(run.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  const stream = file.createReadStream({ highWaterMark: 32 * 1024 });
  let remainder: Buffer = Buffer.alloc(0);
  const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  for await (const incoming of stream as AsyncIterable<Buffer>) {
    hash.update(incoming);
    const input = remainder.length ? Buffer.concat([remainder, incoming]) : incoming;
    let start = 0, end = input.indexOf(10);
    while (end !== -1) {
      if (end - start > TABULAR_BULK_LIMITS.chunkBytes + 96) fail('STAGING', '排序片段行超过内部行预算。');
      const value: unknown = JSON.parse(decode.decode(input.subarray(start, end)));
      if (!Array.isArray(value) || value.length !== 2 || !isCellMatrix([value[0]], fieldCount))
        fail('STAGING', '排序片段结构化值格式不符。');
      yield makeSpoolRow((value as [(string | null)[], unknown])[0], readLocator((value as [unknown, unknown])[1], fail), keyIndices, fail);
      start = end + 1; end = input.indexOf(10, start);
    }
    remainder = input.subarray(start);
    if (remainder.length > TABULAR_BULK_LIMITS.chunkBytes + 96) fail('STAGING', '排序片段行超过内部行预算。');
  }
  if (remainder.length || 'sha256:' + hash.digest('hex') !== run.digest) fail('STAGING_CHANGED', '排序片段末尾或内容与生成时不一致。');
}
async function* mergeRuns(paths: BulkRun[], order: BulkOrder): AsyncGenerator<SpoolRow> {
  const { fail, duplicateLabel } = order;
  const sources = paths.map(path => runRows(path, order));
  try {
    const heads = await Promise.all(sources.map(source => source.next()));
    let previous: SpoolRow | undefined;
    for (;;) {
      let first = -1;
      for (let i = 0; i < heads.length; i++) {
        if (!heads[i]!.done && (first === -1 || compare(heads[i]!.value!, heads[first]!.value!) < 0)) first = i;
      }
      if (first === -1) break;
      const row = heads[first]!.value!;
      if (previous && compare(previous, row) >= 0)
        fail('DUPLICATE_KEY', `${bulkCoordinates(previous.locator)}与${bulkCoordinates(row.locator)}的${duplicateLabel}重复，未丢行。`);
      yield row; previous = row;
      heads[first] = await sources[first]!.next();
    }
  } finally { await Promise.allSettled(sources.map(source => source.return(undefined))); }
}
const chunkId = (ordinal: number) => 'c' + ordinal.toString().padStart(6, '0');


interface BulkOrder { fieldCount: number; keyIndices: readonly number[]; fail: Fail; duplicateLabel: string }
export async function assertEmptyBulkStaging(stagingDir: string, fail: Fail) {
  if (!isAbsolute(stagingDir) || await realpath(stagingDir) !== resolve(stagingDir)
    || !(await lstat(stagingDir)).isDirectory() || (await readdir(stagingDir)).length)
    fail('STAGING', '加工须使用调用方指定的已托管空目录，不能复用未知残片或回退到内部磁盘。');
}

export function createBulkSorter(input: { stagingDir: string; signal?: AbortSignal; assertGrowth?: (bytes: number) => void },
  order: BulkOrder) {
  const { fail, keyIndices, duplicateLabel } = order;
  const spool = new BulkSpool(resolve(input.stagingDir), fail, input.assertGrowth);
  let runs: BulkRun[] = [], run: SpoolRow[] = [], runBytes = 0;
  const flushRun = async () => {
    if (!run.length) return;
    run.sort(compare);
    for (let i = 1; i < run.length; i++) if (!compare(run[i - 1]!, run[i]!))
      fail('DUPLICATE_KEY', `${bulkCoordinates(run[i - 1]!.locator)}与${bulkCoordinates(run[i]!.locator)}的${duplicateLabel}重复，未丢行。`);
    runs.push(await spool.put('run-0-' + runs.length + '.ndjson', run.map(runLine).join('')));
    run = []; runBytes = 0;
  };
  return {
    add(cells: TabularCell[], locator: BulkLocator): Promise<void> | undefined {
      const item = makeSpoolRow(cells, locator, keyIndices, fail);
      const bytes = Buffer.byteLength(item.json);
      if (bytes + 2 > TABULAR_BULK_LIMITS.chunkBytes) fail('ROW_BUDGET', `${bulkCoordinates(item.locator)}的结构化单行超过 WFD 分片预算。`);
      const push = () => { run.push(item); runBytes += bytes + 96; };
      if (runBytes + bytes + 96 > RUN_BYTES) return flushRun().then(push);
      push();
    },
    async finish(rowCount: number, report: (stage: 'sort') => Promise<void>) {
      await flushRun();
      await report('sort');
      for (let pass = 1; runs.length > SORT_FAN_IN; pass++) {
        const merged: BulkRun[] = [];
        for (let start = 0; start < runs.length; start += SORT_FAN_IN) {
          input.signal?.throwIfAborted();
          const group = runs.slice(start, start + SORT_FAN_IN);
          if (group.length === 1) { merged.push(group[0]!); continue; }
          const file = await spool.writer('run-' + pass + '-' + merged.length + '.ndjson');
          let closed: BulkRun;
          try {
            let output: string[] = [], bytes = 0;
            for await (const row of mergeRuns(group, order)) {
              const line = runLine(row);
              output.push(line); bytes += Buffer.byteLength(line);
              if (bytes >= RUN_BYTES) { input.signal?.throwIfAborted(); await file.write(output.join('')); output = []; bytes = 0; }
            }
            if (output.length) await file.write(output.join(''));
          } finally { closed = await file.close(); }
          merged.push(closed);
          for (const run of group) await spool.removeRun(run.path);
        }
        runs = merged;
        await report('sort');
      }
      const hash = createHash('sha256'), chunks: TabularBatchChunk[] = [], locatorDigests: string[] = [];
      let chunkRows: string[] = [], chunkLocators: number[][] = [], chunkBytes = 2, sortedRows = 0;
      const flushChunk = async () => {
        if (!chunkRows.length) return;
        input.signal?.throwIfAborted();
        const ordinal = chunks.length;
        if (ordinal >= TABULAR_BULK_LIMITS.chunks) fail('CHUNK_BUDGET', '整件超过 WFD 的分片数量上限，未拆成多次正式发布。');
        const chunk_id = chunkId(ordinal), value = '[' + chunkRows.join(',') + ']', locators = JSON.stringify(chunkLocators);
        await spool.put(chunk_id + '.json', value);
        await spool.put(chunk_id + '.loc.json', locators);
        chunks.push({ chunk_id, ordinal, row_count: chunkRows.length, digest: sha(value) });
        locatorDigests.push(sha(locators));
        chunkRows = []; chunkLocators = []; chunkBytes = 2;
      };
      for await (const row of mergeRuns(runs, order)) {
        const size = Buffer.byteLength(row.json) + (chunkRows.length ? 1 : 0);
        if (chunkRows.length >= TABULAR_BULK_LIMITS.chunkRows || chunkBytes + size > TABULAR_BULK_LIMITS.chunkBytes) await flushChunk();
        chunkBytes += Buffer.byteLength(row.json) + (chunkRows.length ? 1 : 0);
        chunkRows.push(row.json); chunkLocators.push(locatorValues(row.locator));
        hash.update(row.json + '\n'); sortedRows++;
      }
      await flushChunk();
      if (sortedRows !== rowCount) fail('COVERAGE', '排序结果和整件已核对记录数不符。');
      for (const run of runs) await spool.removeRun(run.path);

      return { rowsDigest: 'sha256:' + hash.digest('hex'), chunks, locatorDigests };
    },
  };
}
function checkedChunkId(chunk: TabularBatchChunk, fail: Fail) {
  if (!Number.isInteger(chunk.ordinal) || chunk.ordinal < 0 || chunk.ordinal >= TABULAR_BULK_LIMITS.chunks
    || chunk.chunk_id !== chunkId(chunk.ordinal) || !Number.isInteger(chunk.row_count) || chunk.row_count < 1
    || chunk.row_count > TABULAR_BULK_LIMITS.chunkRows || !shaSyntax.test(chunk.digest))
    fail('CHUNK', '冻结分片编号、行数或摘要无效。');
  return chunk.chunk_id;
}

async function readStagedJson(stagingDir: string, name: string, expected: string, maxBytes: number, fail: Fail): Promise<unknown> {
  const file = await open(join(stagingDir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) return fail('CHUNK', '加工片段存储类型或长度无效。');
    const data = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await file.read(data, size, data.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size || sha(data.subarray(0, size)) !== expected) return fail('CHUNK_CHANGED', '加工片段与冻结摘要不一致。');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, size))) as unknown;
  } finally { await file.close(); }
}

export async function readBulkChunk(stagingDir: string, chunk: TabularBatchChunk, fieldCount: number, fail: Fail): Promise<(string | null)[][]> {
  const value = await readStagedJson(stagingDir, checkedChunkId(chunk, fail) + '.json', chunk.digest, TABULAR_BULK_LIMITS.chunkBytes, fail);
  if (!isCellMatrix(value, fieldCount) || value.length !== chunk.row_count || digest(value) !== chunk.digest)
    return fail('CHUNK_CHANGED', '加工片段与冻结行数、值类型或规范摘要不一致。');
  return value;
}

export async function readBulkLocators(stagingDir: string, chunk: TabularBatchChunk, locatorDigest: string, fail: Fail): Promise<BulkLocator[]> {
  if (!shaSyntax.test(locatorDigest)) return fail('CHUNK', '缺少冻结源行定位片段摘要。');
  const value = await readStagedJson(stagingDir, checkedChunkId(chunk, fail) + '.loc.json', locatorDigest, TABULAR_BULK_LIMITS.chunkBytes, fail);
  if (!Array.isArray(value) || value.length !== chunk.row_count)
    return fail('CHUNK_CHANGED', '加工定位片段与冻结行数不一致。');
  return value.map(item => readLocator(item, fail));
}
