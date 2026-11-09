import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateMaterialOriginalSharing, planMaterialOriginalSharing } from '../modules/collection/original-storage.js';

const args = process.argv.slice(2), databaseArg = args.find(arg => arg.startsWith('--database='));
if (!databaseArg || args.some(arg => arg !== databaseArg && arg !== '--apply') || new Set(args).size !== args.length) {
  throw new Error('用法：node --import tsx scripts/share-material-originals.ts --database=/绝对路径/既有库.sqlite [--apply]');
}
const path = databaseArg.slice('--database='.length), apply = args.includes('--apply');
if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !lstatSync(path).isFile()) {
  throw new Error('必须选择已经存在且无符号链接的 SQLite 普通文件；本入口不创建数据库。');
}
const database = new DatabaseSync(path, { readOnly: !apply, enableForeignKeyConstraints: true });
try {
  if (apply) database.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  const result = apply ? migrateMaterialOriginalSharing(database) : { applied: false, plan: planMaterialOriginalSharing(database) };
  console.log(JSON.stringify({ database: path, ...result }, null, 2));
} finally { database.close(); }
