/**
 * 检索分词契约：CJK 按 2 字滑窗成 bigram，拉丁字母与数字整段小写为整词。
 * 写入与查询必须用同一规则，否则中文 2 字词无法命中 unicode61 分词。
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/u;
const WORD = /[0-9A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/u;

function isCjk(char: string): boolean { return CJK.test(char); }
function isWord(char: string): boolean { return WORD.test(char); }

/** 索引与查询共用的规范化：兼容分解合成、去除变音符、拉丁小写。 */
export function normalizeForIndex(text: string): string {
  return text.normalize('NFKC').toLowerCase().normalize('NFD').replace(/[\u0300-\u036F]/gu, '').normalize('NFC');
}

export interface TokenizeResult { tokens: string[]; /** 是否存在无法索引的字符（仅用于诊断） */ skipped: number }

export function tokenize(text: string): TokenizeResult {
  const normalized = normalizeForIndex(text);
  const tokens: string[] = [];
  const chars = [...normalized];
  let index = 0, skipped = 0;
  while (index < chars.length) {
    const char = chars[index]!;
    if (isCjk(char)) {
      let end = index;
      while (end < chars.length && isCjk(chars[end]!)) end++;
      const run = chars.slice(index, end);
      if (run.length === 1) tokens.push(run[0]!);
      else for (let cursor = 0; cursor + 1 < run.length; cursor++) tokens.push(run[cursor]! + run[cursor + 1]!);
      index = end;
      continue;
    }
    if (isWord(char)) {
      let end = index;
      while (end < chars.length && isWord(chars[end]!)) end++;
      tokens.push(chars.slice(index, end).join(''));
      index = end;
      continue;
    }
    // 空白与标点是词项分隔符；不做字符级展开，也不猜同义词。
    if (!/\s/u.test(char)) skipped++;
    index++;
  }
  return { tokens, skipped };
}

/** 索引列的词项串；空文本返回空串。 */
export function indexTokens(text: string): string { return tokenize(text).tokens.join(' '); }

/**
 * 查询表达式：所有词项 AND 连接。词项用双引号包成短语，避免被当作 FTS5 运算符。
 * 无可索引词项时返回 null，调用方不得退化成全表扫描。
 */
export function ftsQuery(text: string): string | null {
  const { tokens } = tokenize(text);
  const unique = [...new Set(tokens)].filter(token => token.length > 0);
  if (!unique.length) return null;
  return unique.map(token => `"${token.replace(/"/gu, '""')}"`).join(' AND ');
}
