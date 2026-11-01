import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Runs a read-only git command. GIT_OPTIONAL_LOCKS=0 stops git from refreshing the
 * index as a side effect, so Claude Grasp never writes inside a user's repo. Asynchronous,
 * so a long `git log` never freezes the editor's extension host.
 */
export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

/**
 * Which of these repo-relative paths git ignores (`git check-ignore --stdin`). Tracked files
 * never count as ignored, even under an ignored folder. Exit code 1 means none are ignored.
 */
export function gitIgnored(repo: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, '-c', 'core.quotepath=off', 'check-ignore', '-z', '--stdin'], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 || code === 1 ? resolve(out.split('\0').filter(Boolean)) : reject(new Error(err.trim() || `git check-ignore exited with ${code}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(paths.join('\0') + '\0');
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
