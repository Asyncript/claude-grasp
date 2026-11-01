import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { FIXTURE_ANCHOR, FIXTURE_AUTHOR, FIXTURE_COMMITS, FIXTURE_UNCOMMITTED } from '../fixtures/repo';
import { packageRoot } from '../shared/paths';

const DAY_MS = 86_400_000;

export interface DemoData {
  roots: string[];
  repoPath: string;
}

/**
 * How far to move the fixtures so that day 0 is today. Fixture times are written as UTC but
 * mean wall-clock times, so day 0 at 10:00 lands on today at 10:00 local time.
 */
export function demoShiftMs(now = new Date()): number {
  const localMidnightAsUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return localMidnightAsUtc - FIXTURE_ANCHOR + now.getTimezoneOffset() * 60_000;
}

/**
 * Materializes the demo into `target`: the fixture git repo plus the fixture transcripts
 * pointing at it, every timestamp shifted by `shiftMs`. `target` is wiped first, so it
 * must be a directory named "demo".
 */
export function prepareDemo(target: string, shiftMs = 0): DemoData {
  if (basename(target) !== 'demo') throw new Error(`refusing to reset ${target}: demo dir must be named "demo"`);
  rmSync(target, { recursive: true, force: true });

  const repoPath = join(target, 'shop-api');
  buildFixtureRepo(repoPath, shiftMs);

  const from = join(packageRoot(), 'fixtures', 'claude');
  const to = join(target, 'claude');
  const repoJson = JSON.stringify(repoPath).slice(1, -1);
  for (const file of walk(from)) {
    const text = readFileSync(file, 'utf8').replaceAll('{{REPO}}', repoJson);
    const out = join(to, relative(from, file));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, shiftTimestamps(text, shiftMs));
  }
  return { roots: [to], repoPath };
}

export function shiftTimestamps(text: string, ms: number): string {
  if (!ms) return text;
  return text.replace(/"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/g, (_m, iso: string) => JSON.stringify(new Date(Date.parse(iso) + ms).toISOString()));
}

function buildFixtureRepo(dir: string, shiftMs: number) {
  mkdirSync(dir, { recursive: true });
  // Ignore the user's global hooks, signing and templates so the demo repo is identical everywhere.
  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', ...args], {
      cwd: dir,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env },
    });
  run(['init', '-q', '-b', 'main']);
  // The repo's own identity, so its commits are "yours" whatever the machine's global git email is.
  run(['config', 'user.name', FIXTURE_AUTHOR.name]);
  run(['config', 'user.email', FIXTURE_AUTHOR.email]);
  for (const c of FIXTURE_COMMITS) {
    for (const [path, content] of Object.entries(c.files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    const [h = 0, m = 0] = c.time.split(':').map(Number);
    const when = new Date(FIXTURE_ANCHOR + shiftMs + c.day * DAY_MS + (h * 60 + m) * 60_000).toISOString();
    run(['add', '-A']);
    run(['commit', '-q', '-m', c.message], {
      GIT_AUTHOR_NAME: FIXTURE_AUTHOR.name,
      GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR.email,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: FIXTURE_AUTHOR.name,
      GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR.email,
      GIT_COMMITTER_DATE: when,
    });
  }
  for (const [path, content] of Object.entries(FIXTURE_UNCOMMITTED)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
