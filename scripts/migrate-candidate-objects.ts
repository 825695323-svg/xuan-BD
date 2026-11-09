import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateCandidateObjects } from '../modules/collection/candidate-object-storage.js';

const [flag, path, ...extra] = process.argv.slice(2);
if (flag !== '--apply' || !path || extra.length || !isAbsolute(path) || path !== resolve(path)
  || realpathSync(path) !== path || !lstatSync(path).isFile()) {
  throw new Error('用法：--apply <既有工作台库的绝对路径>。路径必须指向普通文件。');
}
const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
try {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
  console.log(JSON.stringify(migrateCandidateObjects(db)));
} finally { db.close(); }
