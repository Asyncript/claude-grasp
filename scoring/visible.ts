import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';

/** Files that are generated or vendored rather than written by anyone: lockfiles, bundles, snapshots. */
export const DEFAULT_IGNORE = [
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lockb', '**/bun.lock', '**/Cargo.lock', '**/poetry.lock', '**/uv.lock',
  '**/composer.lock', '**/Gemfile.lock', '**/go.sum', '**/*.min.js', '**/*.min.css', '**/*.map', '**/dist/**', '**/__snapshots__/**', '**/*.snap',
];

/**
 * A small glob, matched against repo-relative paths: `**` any number of folders, `*` anything
 * but "/", `?` one character. As in .gitignore, a pattern without "/" matches at any depth.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.includes('/') ? glob.replace(/^\//, '') : `**/${glob}`;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Which of a repo's files count: still on disk, not ignored by git, and not matching `ignore`. */
export function fileFilter(db: DB, repo: { id: number; path: string }, ignore: string[]): (relPath: string) => boolean {
  const patterns = ignore.map(globToRegExp);
  const gitIgnored = new Set((db.prepare('SELECT rel_path FROM ignored_files WHERE repo_id = ?').all(repo.id) as { rel_path: string }[]).map((r) => r.rel_path));
  return (rel) => !gitIgnored.has(rel) && !patterns.some((re) => re.test(rel)) && existsSync(join(repo.path, ...rel.split('/')));
}
