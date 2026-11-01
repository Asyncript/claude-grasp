import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as Database } from 'node:sqlite';
import { MIGRATIONS } from './schema';

// Built into Node ≥ 22.13 (and so into VS Code's Electron), so there is no native module to ship.
// Loaded this way because bundlers rewrite `import 'node:sqlite'` to a bare 'sqlite', which isn't a builtin.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export type DB = Database;

export function openDb(file: string): DB {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // The dashboard reads while an ingest may be writing.
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

/** Runs `fn` inside BEGIN/COMMIT, rolling back if it throws. */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function migrate(db: DB) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
