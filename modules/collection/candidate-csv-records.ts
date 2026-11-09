import { MaterialError } from './data-processing/material-inspector/index.js';
import type { MaterialLimits, MaterialLocation } from './materials/contracts.js';

export interface CandidateCsvField { value: string; location: MaterialLocation }

/** 沿用材料 CSV 引号/列/单元格规则，逐条扫描；不收集整表或清洗原值。位置为原文 UTF-16 偏移。 */
export function* candidateCsvRecords(text: string,
  limits: Pick<MaterialLimits, 'maxColumns' | 'maxCellCharacters'>): Generator<CandidateCsvField[], void> {
  let i = text.startsWith('\ufeff') ? 1 : 0, line = 1, lineStart = 0, record = 1;
  if (i === text.length) throw new MaterialError('EMPTY_MATERIAL', 'CSV 没有表头。');
  while (i <= text.length) {
    const fields: CandidateCsvField[] = [];
    while (true) {
      const start = i, startLine = line, column = start - lineStart + 1;
      const locate = (): MaterialLocation => ({ start, end: i, line: startLine, column, row: record, field: fields.length + 1 });
      let value: string;
      if (text[i] === '"') {
        i++; let segment = i, parts: string[] | undefined, closed = false, escaped = 0;
        const contentStart = i;
        while (i < text.length) {
          const char = text[i];
          if (char === '"') {
            if (text[i + 1] === '"') {
              (parts ??= []).push(text.slice(segment, i), '"'); i += 2; segment = i; escaped++;
            } else {
              value = parts ? parts.join('') + text.slice(segment, i) : text.slice(segment, i);
              i++; closed = true; break;
            }
          } else if (char === '\r' || char === '\n') {
            i += char === '\r' && text[i + 1] === '\n' ? 2 : 1;
            line++; lineStart = i;
          } else i++;
          if (i - contentStart - escaped > limits.maxCellCharacters) throw new MaterialError('CELL_BUDGET', 'CSV 字段超过字符预算。', locate());
        }
        if (!closed || (i < text.length && ![',', '\r', '\n'].includes(text[i]!))) throw new MaterialError('INVALID_CSV_QUOTES', 'CSV 引号未闭合或引号后有非分隔内容。', locate());
      } else {
        while (i < text.length && ![',', '\r', '\n'].includes(text[i]!)) {
          if (text[i] === '"') throw new MaterialError('INVALID_CSV_QUOTES', '未加引号字段中出现引号。', { ...locate(), start: i, end: i + 1, column: i - lineStart + 1 });
          i++;
          if (i - start > limits.maxCellCharacters) throw new MaterialError('CELL_BUDGET', 'CSV 字段超过字符预算。', locate());
        }
        value = text.slice(start, i);
      }
      fields.push({ value: value!, location: locate() });
      if (fields.length > limits.maxColumns) throw new MaterialError('COLUMN_BUDGET', 'CSV 列数超过预算。');
      if (text[i] !== ',') break;
      i++;
    }
    yield fields;
    if (i >= text.length) break;
    i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    line++; lineStart = i; record++;
    if (i === text.length) break;
  }
}
