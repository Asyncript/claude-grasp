// Runs ingest and scoring on the fixtures in a throwaway directory and checks the expected
// totals and scores, with the default weights and with every penalty on. If a weight in
// scoring/config.ts changes, these numbers change with it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../db';
import { prepareDemo } from '../demo/prepare';
import { FIXTURE_ANCHOR } from '../fixtures/repo';
import { ingest } from '../ingest/run';
import { STRICT_PENALTIES, withPenalties } from '../scoring/config';
import { loadRepo, scoreRepo, summarize } from '../scoring/repo';

const DAY_MS = 86_400_000;
const EXPECTED: Record<string, [score: number, bucket: string]> = {
  'src/auth/session.ts': [70, 'green'],
  'src/orders/checkout.ts': [74, 'green'],
  'src/orders/pricing.ts': [39, 'red'],
  'src/utils/format.ts': [45, 'yellow'],
  'src/db/migrations.ts': [28, 'red'],
  'src/reports/daily.ts': [0, 'red'],
};
const EXPECTED_STRICT: Record<string, number> = {
  'src/auth/session.ts': 70,
  'src/orders/checkout.ts': 57,
  'src/orders/pricing.ts': 22,
  'src/utils/format.ts': 15,
  'src/db/migrations.ts': 0,
  'src/reports/daily.ts': 0,
};

const REPO_SCORE = 51;
const home = mkdtempSync(join(tmpdir(), 'claude-grasp-smoke-'));
try {
  const { roots } = prepareDemo(join(home, 'demo'));
  const db = openDb(join(home, 'claude-grasp.db'));
  const s = await ingest(db, roots);
  assert.deepEqual(s.errors, []);
  assert.equal(s.transcripts, 7);
  assert.equal(s.headless, 2);
  assert.equal(s.unattendedEdits, 2);
  assert.equal(s.prompts, 15);
  assert.equal(s.edits, 13);
  assert.equal(s.editsOutsideRepo, 1);
  assert.equal(s.commits, 6);

  const again = await ingest(db, roots);
  assert.equal(again.unchanged, 7, 're-run should skip every unchanged transcript');
  assert.equal(again.prompts + again.edits + again.commits, 0);

  const repo = db.prepare("SELECT id FROM repos WHERE name = 'shop-api'").get() as { id: number };
  const data = loadRepo(db, repo.id)!;
  const scores = scoreRepo(data, FIXTURE_ANCHOR + DAY_MS);
  const got = Object.fromEntries(scores.map((f) => [f.path, [f.score, f.bucket]]));
  assert.deepEqual(got, EXPECTED);
  for (const f of scores) {
    // Every score is explainable: base plus the listed contributions is exactly the raw score.
    const sum = f.base + f.contributions.reduce((a, c) => a + c.points, 0);
    assert.ok(Math.abs(sum - f.raw) < 1e-6, `${f.path}: contributions don't add up`);
  }
  const summary = summarize(scores);
  assert.equal(summary.score, REPO_SCORE);
  assert.equal(summary.neverUnderstood, 2);

  const strict = scoreRepo(data, FIXTURE_ANCHOR + DAY_MS, withPenalties(STRICT_PENALTIES));
  assert.deepEqual(Object.fromEntries(strict.map((f) => [f.path, f.score])), EXPECTED_STRICT);
  assert.equal(summarize(strict).score, 38);
  db.close();
  console.log('smoke: ok', { repoScore: summary.score, files: Object.fromEntries(scores.map((f) => [f.path, f.score])) });
} finally {
  rmSync(home, { recursive: true, force: true });
}
