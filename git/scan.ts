import { existsSync } from 'node:fs';
import { transaction, type DB } from '../db';
import { headSha, isAncestor, readCommits } from './log';
import { git, gitIgnored } from './repo';

/** History older than this before the first Claude edit can't say anything about Claude's code. */
const HISTORY_MARGIN_DAYS = 90;

export interface RepoRow {
  id: number;
  path: string;
  last_head: string | null;
  user_email?: string | null;
  ignore_checked?: number | null;
}

/** The repo's git user.email (local, else global), or null when none is set. */
async function userEmail(repo: string): Promise<string | null> {
  try {
    return (await git(repo, ['config', 'user.email'])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Records which edited files git ignores, when there are new edits or a new HEAD (which may
 * bring a new .gitignore) since the last check.
 */
async function checkIgnored(db: DB, repo: RepoRow, headChanged: boolean): Promise<boolean> {
  const { last } = db.prepare('SELECT MAX(rowid) AS last FROM edits WHERE repo_id = ?').get(repo.id) as { last: number | null };
  if (last === null || (!headChanged && repo.ignore_checked === last)) return false;
  const paths = (db.prepare('SELECT DISTINCT rel_path FROM edits WHERE repo_id = ?').all(repo.id) as { rel_path: string }[]).map((r) => r.rel_path);
  let ignored: string[];
  try {
    ignored = await gitIgnored(repo.path, paths);
  } catch {
    return false;
  }
  const before = (db.prepare('SELECT rel_path FROM ignored_files WHERE repo_id = ? ORDER BY rel_path').all(repo.id) as { rel_path: string }[]).map((r) => r.rel_path);
  ignored.sort();
  const insert = db.prepare('INSERT INTO ignored_files (repo_id, rel_path) VALUES (?, ?)');
  transaction(db, () => {
    db.prepare('DELETE FROM ignored_files WHERE repo_id = ?').run(repo.id);
    for (const p of ignored) insert.run(repo.id, p);
    db.prepare('UPDATE repos SET ignore_checked = ? WHERE id = ?').run(last, repo.id);
  });
  return before.join('\0') !== ignored.join('\0');
}

/**
 * Reads new commits since the last scan (or the whole relevant history after a rewrite).
 * Returns how many were stored, and whether anything (commits, your identity) changed.
 */
export async function scanRepo(db: DB, repo: RepoRow): Promise<{ commits: number; changed: boolean }> {
  if (!existsSync(repo.path)) return { commits: 0, changed: false };
  const head = await headSha(repo.path);
  if (!head) return { commits: 0, changed: false };
  // Checked even without new commits: the identity can change on its own.
  const email = await userEmail(repo.path);
  const identityChanged = email !== (repo.user_email ?? null);
  if (identityChanged) db.prepare('UPDATE repos SET user_email = ? WHERE id = ?').run(email, repo.id);
  const ignoreChanged = await checkIgnored(db, repo, head !== repo.last_head);
  if (head === repo.last_head) return { commits: 0, changed: identityChanged || ignoreChanged };

  const incremental = !!repo.last_head && (await isAncestor(repo.path, repo.last_head, head));
  let since: string | undefined;
  if (!incremental) {
    const first = db.prepare('SELECT MIN(ts) AS ts FROM edits WHERE repo_id = ?').get(repo.id) as { ts: string | null };
    if (first.ts) since = new Date(Date.parse(first.ts) - HISTORY_MARGIN_DAYS * 86_400_000).toISOString();
  }
  const commits = await readCommits(repo.path, incremental ? { range: `${repo.last_head}..${head}` } : { since });

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
  return { commits: commits.length, changed: true };
}
