import { isClaudeCommit } from './attribution';
import { git } from './repo';

export interface CommitFile {
  path: string;
  added: number;
  removed: number;
}

export interface Commit {
  sha: string;
  ts: number;
  author: string;
  email: string;
  subject: string;
  isClaude: boolean;
  files: CommitFile[];
}

const RS = '\x1e';
const FS = '\x1f';
const FORMAT = `--format=${RS}%H${FS}%at${FS}%an${FS}%ae${FS}%B${FS}`;

export function headSha(repo: string): string | null {
  try {
    return git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

export function isAncestor(repo: string, ancestor: string, head: string): boolean {
  try {
    git(repo, ['merge-base', '--is-ancestor', ancestor, head]);
    return true;
  } catch {
    return false;
  }
}

export function readCommits(repo: string, opts: { range?: string; since?: string } = {}): Commit[] {
  const args = ['log', '--no-merges', '--no-renames', FORMAT, '--numstat'];
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.range) args.push(opts.range);
  return parseLog(git(repo, args));
}

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of out.split(RS)) {
    const [sha, at, author, email, body, rest] = record.split(FS);
    if (!sha || !at || body === undefined) continue;
    const files: CommitFile[] = [];
    for (const line of (rest ?? '').split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      // Binary files show "-" for both counts.
      if (m) files.push({ path: m[3]!, added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) });
    }
    commits.push({
      sha: sha.trim(),
      ts: Number(at) * 1000,
      author: author ?? '',
      email: email ?? '',
      subject: body.split('\n')[0] ?? '',
      isClaude: isClaudeCommit(body, email),
      files,
    });
  }
  return commits;
}
