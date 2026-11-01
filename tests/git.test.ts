import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { prepareDemo } from '../demo/prepare';
import { attributeFileCommits, isClaudeCommit } from '../git/attribution';
import { parseLog, readCommits } from '../git/log';
import { FIXTURE_AUTHOR } from '../fixtures/repo';
import { ingest } from '../ingest/run';
import { loadRepo, type LoadOptions } from '../scoring/repo';

describe('isClaudeCommit', () => {
  it('matches the trailer by address, any model name, any case', () => {
    expect(isClaudeCommit('Fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')).toBe(true);
    expect(isClaudeCommit('Fix\n\nco-authored-by: Claude <noreply@anthropic.com>')).toBe(true);
    expect(isClaudeCommit('Fix', 'noreply@anthropic.com')).toBe(true);
    expect(isClaudeCommit('Fix\n\nCo-Authored-By: Sam <sam@example.com>')).toBe(false);
    expect(isClaudeCommit('Mention noreply@anthropic.com in docs')).toBe(false);
  });
});

describe('parseLog', () => {
  it('parses records, numstat and binary files', () => {
    const out = '\x1eabc\x1f1700000000\x1fDana\x1fd@x.com\x1fSubject\n\nBody\n\x1f\n\n3\t1\tsrc/a.ts\n-\t-\timg.png\n\x1edef\x1f1700000100\x1fDana\x1fd@x.com\x1fEmpty\n\x1f\n';
    expect(parseLog(out)).toEqual([
      { sha: 'abc', ts: 1_700_000_000_000, author: 'Dana', email: 'd@x.com', subject: 'Subject', isClaude: false, files: [{ path: 'src/a.ts', added: 3, removed: 1 }, { path: 'img.png', added: 0, removed: 0 }] },
      { sha: 'def', ts: 1_700_000_100_000, author: 'Dana', email: 'd@x.com', subject: 'Empty', isClaude: false, files: [] },
    ]);
  });
});

describe('attributeFileCommits', () => {
  const c = (sha: string, ts: number, isClaude = false) => ({ sha, ts, isClaude });

  it('separates human, ambiguous, claude and prior commits', () => {
    const result = attributeFileCommits([c('h2', 400), c('p', 50), c('a', 200), c('cl', 300, true), c('h1', 250)], [150, 280]);
    expect(result.map((r) => [r.sha, r.attribution])).toEqual([
      ['p', 'prior'],
      ['a', 'ambiguous'],
      ['h1', 'human'],
      ['cl', 'claude'],
      ['h2', 'human'],
    ]);
  });

  it('treats everything as prior when Claude never touched the file', () => {
    expect(attributeFileCommits([c('x', 1), c('y', 2)], []).map((r) => r.attribution)).toEqual(['prior', 'prior']);
  });
});

describe('commit authors', () => {
  const c = (sha: string, ts: number, email: string) => ({ sha, ts, isClaude: false, email });

  it("never counts someone else's commit as yours", () => {
    const mine = (e: string) => e === 'me@x.com';
    const result = attributeFileCommits([c('teammate', 300, 'sam@x.com'), c('me', 400, 'me@x.com')], [100], mine);
    expect(result.map((r) => [r.sha, r.attribution])).toEqual([
      ['teammate', 'other'],
      ['me', 'human'],
    ]);
  });

  it('uses the repo user.email and gitEmails when scoring', async () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-grasp-git-'));
    const { roots, repoPath } = prepareDemo(join(home, 'demo'));
    const db = openDb(join(home, 'claude-grasp.db'));
    await ingest(db, roots);
    const repo = db.prepare('SELECT id, user_email FROM repos WHERE path = ?').get(repoPath) as { id: number; user_email: string };
    expect(repo.user_email).toBe(FIXTURE_AUTHOR.email);
    const humanCommits = (o?: LoadOptions) => loadRepo(db, repo.id, o)!.files.find((f) => f.path === 'src/utils/format.ts')!.commits.map((x) => x.attribution);
    expect(humanCommits()).toEqual(['ambiguous', 'human']);

    // Someone else's clone: Dana's commits are a teammate's now, unless listed as yours.
    db.prepare('UPDATE repos SET user_email = ?').run('sam@example.com');
    expect(humanCommits()).toEqual(['other', 'other']);
    expect(humanCommits({ gitEmails: [FIXTURE_AUTHOR.email.toUpperCase()] })).toEqual(['ambiguous', 'human']);
    db.close();
  });
});

describe('fixture repo', () => {
  it('reads history and attributes each file as the fixture story says', async () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-grasp-git-'));
    const { roots, repoPath } = prepareDemo(join(home, 'demo'));
    const commits = await readCommits(repoPath);
    expect(commits).toHaveLength(6);
    expect(commits.filter((x) => x.isClaude).map((x) => x.subject)).toEqual(['Fix double discount in checkout total', 'Add in-memory sessions with refresh']);

    const db = openDb(join(home, 'claude-grasp.db'));
    await ingest(db, roots);
    const attribution = (path: string) => {
      const fileCommits = db
        .prepare('SELECT c.sha, c.ts, c.is_claude FROM commits c JOIN commit_files f ON f.sha = c.sha AND f.repo_id = c.repo_id WHERE f.rel_path = ?')
        .all(path) as { sha: string; ts: number; is_claude: number }[];
      const editTimes = (db.prepare('SELECT ts FROM edits WHERE rel_path = ?').all(path) as { ts: string }[]).map((e) => Date.parse(e.ts));
      return attributeFileCommits(fileCommits.map((x) => ({ sha: x.sha, ts: x.ts, isClaude: !!x.is_claude })), editTimes).map((r) => r.attribution);
    };
    expect(attribution('README.md')).toEqual(['prior']);
    expect(attribution('src/auth/session.ts')).toEqual(['claude']);
    expect(attribution('src/orders/checkout.ts')).toEqual(['ambiguous', 'human', 'claude']);
    expect(attribution('src/utils/format.ts')).toEqual(['ambiguous', 'human']);
    expect(attribution('src/db/migrations.ts')).toEqual(['ambiguous']);
    db.close();
  });
});
