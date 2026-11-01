import { existsSync } from 'node:fs';
import { transaction, type DB } from '../db';
import { headSha, isAncestor, readCommits } from './log';

/** History older than this before the first Claude edit can't say anything about Claude's code. */
const HISTORY_MARGIN_DAYS = 90;

export interface RepoRow {
  id: number;
  path: string;
  last_head: string | null;
}

/** Reads new commits since the last scan (or the whole relevant history after a rewrite). Returns how many were stored. */
export function scanRepo(db: DB, repo: RepoRow): number {
  if (!existsSync(repo.path)) return 0;
  const head = headSha(repo.path);
  if (!head || head === repo.last_head) return 0;

  const incremental = !!repo.last_head && isAncestor(repo.path, repo.last_head, head);
  let since: string | undefined;
  if (!incremental) {
    const first = db.prepare('SELECT MIN(ts) AS ts FROM edits WHERE repo_id = ?').get(repo.id) as { ts: string | null };
    if (first.ts) since = new Date(Date.parse(first.ts) - HISTORY_MARGIN_DAYS * 86_400_000).toISOString();
  }
  const commits = readCommits(repo.path, incremental ? { range: `${repo.last_head}..${head}` } : { since });

  const insertCommit = db.prepare(
    'INSERT OR REPLACE INTO commits (repo_id, sha, ts, author, email, is_claude, subject) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertFile = db.prepare(
    'INSERT OR REPLACE INTO commit_files (repo_id, sha, rel_path, added, removed) VALUES (?, ?, ?, ?, ?)',
  );
  transaction(db, () => {
    if (!incremental) {
      db.prepare('DELETE FROM commit_files WHERE repo_id = ?').run(repo.id);
      db.prepare('DELETE FROM commits WHERE repo_id = ?').run(repo.id);
    }
    for (const c of commits) {
      insertCommit.run(repo.id, c.sha, c.ts, c.author, c.email, c.isClaude ? 1 : 0, c.subject);
      for (const f of c.files) insertFile.run(repo.id, c.sha, f.path, f.added, f.removed);
    }
    db.prepare('UPDATE repos SET last_head = ?, scanned_at = ? WHERE id = ?').run(head, new Date().toISOString(), repo.id);
  });
  return commits.length;
}
