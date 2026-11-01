import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

/**
 * Runs a read-only git command. GIT_OPTIONAL_LOCKS=0 stops git from refreshing the
 * index as a side effect, so Claude Grasp never writes inside a user's repo.
 */
export function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

/** Maps file paths to the git repo that contains them, caching every directory it checks. */
export class RepoResolver {
  private cache = new Map<string, string | null>();

  /** @param excluded paths never treated as repo content (Claude config roots, scratch dirs). */
  constructor(private excluded: string[] = []) {}

  repoOf(file: string): string | null {
    if (this.excluded.some((r) => file === r || file.startsWith(r + sep))) return null;
    return this.lookup(dirname(file));
  }

  private lookup(dir: string): string | null {
    const hit = this.cache.get(dir);
    if (hit !== undefined) return hit;
    let found: string | null;
    if (existsSync(join(dir, '.git'))) found = dir;
    else {
      const parent = dirname(dir);
      found = parent === dir ? null : this.lookup(parent);
    }
    this.cache.set(dir, found);
    return found;
  }
}
