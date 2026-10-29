import type { MaterialService } from '../collection/materials/service.js';
import type { MaterialCell } from '../collection/materials/contracts.js';
import { parseTableSource } from '../collection/candidate-pipeline.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { ManagedTableData, ManagedTableCell, ManagedTableReader, ManagedTableRow, ManagedTableSummary } from './algorithm-types.js';

/** 计算入口自己的整表解析预算：不沿用预览的 2 MiB / 50 行截断。 */
const ALGORITHM_TABLE_PARSE_BYTES = 64 * 1024 * 1024;
const ALGORITHM_TABLE_PARSE_ROWS = 100_000;

/**
 * 只通过既有材料服务的公开只读方法读取已受管材料。
 * 不扫描目录、不把路径交给算法进程，也不解析任意用户文件。
 *
 * 预览只是目录展示；计算输入必须从已冻结原件重新完整解析。`parseTableSource` 复用既有的 CSV /
 * JSON 行表适配器，但使用独立预算（64 MiB、100k 行、预览不截断）。完整源解析成功后才允许按
 * 声明范围切片，选定行数上限由算法服务另行核对。
 */
export function createMaterialTableReader(materials: MaterialService): ManagedTableReader {
  function read(materialId: string): ManagedTableData {
    const record = materials.get(materialId);
    if (record.envelope.category !== 'data') throw new TaskError('MANAGED_TABLE_CATEGORY', '只能选择已接收类别为数据的受管材料。');
    if (!['csv', 'json-table'].includes(record.preview.format)) throw new TaskError('MANAGED_TABLE_FORMAT', '受管材料不是当前支持的 CSV 或 JSON 行表。');
    const original = materials.readOriginal(materialId);
    if (original.sha256 !== record.envelope.sha256) throw new TaskError('MANAGED_TABLE_CHANGED', '受管材料原件摘要与材料记录不一致，拒绝解析。');
    if (original.bytes.byteLength > ALGORITHM_TABLE_PARSE_BYTES) {
      throw new TaskError('MANAGED_TABLE_PARSE_BUDGET', `受管原件超过计算入口的独立解析预算 ${ALGORITHM_TABLE_PARSE_BYTES} 字节；没有采用截断预览。`);
    }
    let parsed;
    try {
      parsed = parseTableSource(original.bytes, { materialId, format: record.preview.format === 'json-table' ? 'json' : 'csv' });
    } catch (error) {
      if (error instanceof TaskError) throw new TaskError('MANAGED_TABLE_PARSE', `完整源解析被拒绝（${error.code}）：${error.message}`);
      throw error;
    }
    if (parsed.total_rows > ALGORITHM_TABLE_PARSE_ROWS) throw new TaskError('MANAGED_TABLE_PARSE_BUDGET', `完整源超过 ${ALGORITHM_TABLE_PARSE_ROWS} 行解析预算，未截断采用。`);
    const columns = parsed.source_columns.map(column => column.trim());
    if (columns.some(column => !column) || new Set(columns).size !== columns.length) {
      throw new TaskError('MANAGED_TABLE_COLUMNS', '受管表存在空字段名或去除首尾空白后的重名字段，不能静默映射。');
    }
    const rows: ManagedTableRow[] = parsed.rows.map(row => ({ values: row.map(cell => cellValue(cell)) }));
    return { materialId, displayName: record.envelope.filename, format: record.preview.format === 'json-table' ? 'json' : 'csv',
      sha256: original.sha256, rowCount: rows.length, columns, createdAt: record.envelope.createdAt, rows };
  }

  return {
    list(limit = 25): ManagedTableSummary[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TaskError('INVALID_TABLE_LIMIT', '受管表列表上限须在 1 到 50 之间。');
      const page = materials.listPage({ limit });
      const items: ManagedTableSummary[] = [];
      for (const envelope of page.items) {
        if (envelope.category !== 'data') continue;
        let record;
        try { record = materials.get(envelope.materialId); }
        catch { continue; }
        const table = record.preview.table;
        if (table) {
          const columns = table.columns.map(column => column.proposedName);
          if (columns.some(column => !column.trim()) || new Set(columns).size !== columns.length) continue;
          items.push(summary(envelope.materialId, record.envelope.filename, record.envelope.sha256, record.preview.format, columns,
            table.totalRows, record.envelope.createdAt));
          continue;
        }
        // 预览因 2 MiB / 50 行预算被阻断时，仍按同一完整解析器读取目录身份；不能凭预览失败断言没有适配能力。
        if (!['csv', 'json-table'].includes(record.preview.format)) continue;
        try {
          const full = read(envelope.materialId);
          items.push(summary(full.materialId, full.displayName, full.sha256, record.preview.format, full.columns, full.rowCount, full.createdAt));
        } catch { continue; }
      }
      return items;
    },
    read,
  };
}

function summary(materialId: string, displayName: string, sha256: string, format: string, columns: string[], rowCount: number, createdAt: number): ManagedTableSummary {
  return { materialId, displayName, format: format === 'json-table' ? 'json' : 'csv', sha256, rowCount, columns: [...columns], createdAt };
}
function cellValue(cell: Pick<MaterialCell, 'sourceType' | 'original'>): ManagedTableCell {
  if (cell.sourceType === 'missing') return { type: 'missing', value: null };
  if (cell.sourceType === 'null') return { type: 'null', value: null };
  if (cell.sourceType === 'boolean') return { type: 'boolean', value: cell.original === true };
  // 数值保留原文字符串，由算法输入适配器严格解析；不在这里转成可能失真的浮点数。
  if (cell.sourceType === 'number') return { type: 'number', value: typeof cell.original === 'string' ? cell.original : String(cell.original ?? '') };
  return { type: 'string', value: typeof cell.original === 'string' ? cell.original : null };
}
