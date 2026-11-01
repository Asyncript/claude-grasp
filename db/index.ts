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

/**
 * Runs `fn` inside BEGIN IMMEDIATE/COMMIT, rolling back if it throws. IMMEDIATE takes the write
 * lock up front: every VS Code window opens this database, and a deferred transaction that
 * reads first can't be upgraded to a write while another window holds the lock.
 */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** One migration per transaction. The version is read under the write lock, so two windows starting together can't both run it. */
function migrate(db: DB) {
  for (;;) {
    const done = transaction(db, () => {
      const { user_version: v } = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (v >= MIGRATIONS.length) return true;
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      return false;
    });
    if (done) return;
  }
}
