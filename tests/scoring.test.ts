import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { prepareDemo } from '../demo/prepare';
import { FIXTURE_ANCHOR } from '../fixtures/repo';
import { ingest } from '../ingest/run';
import { bucketOf, SCORING, STRICT_PENALTIES, withPenalties } from '../scoring/config';
import { loadRepo, mentionMatcher, scoreRepo, summarize, trend } from '../scoring/repo';
import { scoreFile, type FileEdit, type FileInput, type Prompt, type Turn } from '../scoring/score';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 30, 12);
/** Every penalty on, at the weights they had before they became settings. */
const STRICT = withPenalties(STRICT_PENALTIES);

const prompt = (uuid: string, ts: number, o: Partial<Prompt> = {}): Prompt => ({
  uuid, sessionId: 's', ts, kind: 'human', words: 10, isBare: false, isQuestion: false, isCorrection: false, excerpt: uuid, ...o,
});

function turnsOf(...starters: Prompt[]): Map<string, Turn> {
  const m = new Map<string, Turn>();
  starters.forEach((p, i) => m.set(p.uuid, { id: p.uuid, sessionId: p.sessionId, starter: p, prev: starters[i - 1]?.uuid ?? null, next: starters[i + 1]?.uuid ?? null, prompts: [p], plans: [] }));
  return m;
}

const edit = (turnId: string | null, ts: number, o: Partial<FileEdit> = {}): FileEdit => ({ ts, sessionId: 's', turnId, tool: 'Edit', lines: 10, approval: 'user', unattended: false, ...o });

const file = (o: Partial<FileInput> = {}): FileInput => ({
  repoId: 1, path: 'src/a.ts', edits: [], rejections: [], mentions: [], ideRefs: [], externalEdits: [], commits: [], quizzes: [], ...o,
});

const points = (s: ReturnType<typeof scoreFile>, key: string) => s.contributions.find((c) => c.key === key)!.points;

describe('scoreFile', () => {
  it('adds up exactly: base plus every contribution is the raw score', () => {
    const t = turnsOf(prompt('p1', NOW - 40 * DAY, { isQuestion: true }), prompt('p2', NOW - 39 * DAY, { isBare: true, words: 1 }), prompt('p3', NOW - 2 * DAY, { isCorrection: true }));
    t.get('p1')!.plans.push({ ts: NOW - 40 * DAY, outcome: 'approved', planEdited: true });
    const s = scoreFile(
      file({
        edits: [edit('p1', NOW - 40 * DAY, { lines: 120 }), edit('p2', NOW - 39 * DAY, { approval: 'classifier' }), edit(null, NOW - DAY, { unattended: true, lines: 30 })],
        mentions: [{ ts: NOW - 3 * DAY, sessionId: 's', excerpt: 'look at a.ts', matched: 'a.ts' }],
        commits: [{ sha: 'h', ts: NOW - 5 * DAY, subject: 'tweak', attribution: 'human' }, { sha: 'x', ts: NOW - 6 * DAY, subject: 'wip', attribution: 'ambiguous' }],
        quizzes: [{ id: 1, ts: NOW - DAY, question: 'q', grade: 0.8 }, { id: 2, ts: NOW - DAY, question: 'q2', grade: 0.2 }],
      }),
      t,
      NOW,
    );
    const sum = s.base + s.contributions.reduce((n, c) => n + c.points, 0);
    expect(s.raw).toBeCloseTo(sum, 6);
    expect(s.score).toBe(Math.round(Math.min(100, Math.max(0, s.raw))));
    for (const c of s.contributions) {
      if (c.key === 'decay' || !c.evidence.length) continue;
      // Positive signals list exactly the evidence they count.
      if (c.points > 0) expect(c.evidence.reduce((n, e) => n + e.points, 0)).toBeCloseTo(c.points, 6);
    }
    expect(points(s, 'decay')).toBeLessThan(0);
    expect(s.contributions.find((c) => c.key === 'humanCommit')!.detail).toContain('1 commit without a trailer');
  });

  it('caps a signal and keeps the newest evidence', () => {
    const qs = Array.from({ length: 6 }, (_, i) => prompt(`q${i}`, NOW - i * 1000, { isQuestion: true }));
    const t = turnsOf(...qs);
    const s = scoreFile(file({ edits: qs.map((q) => edit(q.uuid, q.ts)) }), t, NOW);
    expect(points(s, 'question')).toBe(SCORING.positive.question.cap);
    const ev = s.contributions.find((c) => c.key === 'question')!.evidence;
    expect(ev.map((e) => e.points)).toEqual([6, 6, 6, 0, 0, 0]);
  });

  it('halves positive evidence every half-life', () => {
    const t = turnsOf(prompt('p', NOW - SCORING.halfLifeDays * DAY, { isQuestion: true }));
    const s = scoreFile(file({ edits: [edit('p', NOW - SCORING.halfLifeDays * DAY)] }), t, NOW);
    expect(points(s, 'question')).toBe(6);
    expect(points(s, 'decay')).toBeCloseTo(-3, 6);
  });

  it('penalizes unattended edits more than bare approvals and gives them no credit', () => {
    const unattended = scoreFile(file({ edits: [edit(null, NOW - DAY, { unattended: true })] }), new Map(), NOW);
    const t = turnsOf(prompt('ok', NOW - DAY, { isBare: true, words: 1 }));
    const bare = scoreFile(file({ edits: [edit('ok', NOW - DAY)] }), t, NOW, STRICT);
    expect(points(unattended, 'unattended')).toBe(-SCORING.negative.unattended);
    expect(points(bare, 'bareApproval')).toBe(-STRICT.negative.bareApproval);
    expect(unattended.score).toBeLessThan(bare.score);
    expect(unattended.stats).toMatchObject({ unattendedEdits: 1, unattendedLines: 10, unattendedShare: 1 });
    expect(unattended.neverUnderstood).toBe(true);
  });

  it('credits a plan approved in the turn before the edits, only with substantive input', () => {
    const plan = (words: number, planEdited: boolean) => {
      const t = turnsOf(prompt('plan', NOW - 2000, { words }), prompt('go', NOW - 1000, { words: 3 }));
      t.get('plan')!.plans.push({ ts: NOW - 1500, outcome: 'approved', planEdited });
      return points(scoreFile(file({ edits: [edit('go', NOW - 500)] }), t, NOW), 'plan');
    };
    expect(plan(30, false)).toBe(SCORING.positive.plan.points);
    expect(plan(3, true)).toBe(SCORING.positive.plan.points);
    expect(plan(3, false)).toBe(0);
  });

  it('penalizes lots of code for few words', () => {
    const t = turnsOf(prompt('p', NOW - 1000, { words: 2 }));
    const s = scoreFile(file({ edits: [edit('p', NOW - 500, { lines: 400 })] }), t, NOW, STRICT);
    expect(points(s, 'volume')).toBe(-STRICT.negative.volume.points);
    const chatty = turnsOf(prompt('p', NOW - 1000, { words: 200 }));
    expect(points(scoreFile(file({ edits: [edit('p', NOW - 500, { lines: 400 })] }), chatty, NOW, STRICT), 'volume')).toBe(0);
  });

  it('keeps every penalty but unattended off by default, and shows them as off', () => {
    const t = turnsOf(prompt('ok', NOW - 1000, { isBare: true, words: 1 }));
    const f = file({ edits: [edit('ok', NOW - 500, { lines: 400, approval: 'mode' })] });
    const s = scoreFile(f, t, NOW);
    for (const key of ['bareApproval', 'autoAccept', 'volume', 'quizFail']) {
      expect(s.contributions.find((c) => c.key === key)).toMatchObject({ points: 0, off: true });
    }
    expect(s.contributions.find((c) => c.key === 'unattended')!.off).toBe(false);
    expect(scoreFile(f, t, NOW, withPenalties({ bareApproval: 20 })).score).toBe(s.score - 20);
    expect(withPenalties({ autoAccept: -5, unattended: Number.NaN }).negative).toMatchObject({ autoAccept: 0, unattended: 35 });
  });

  it('ignores evidence after `now`, so older scores can be replayed', () => {
    const t = turnsOf(prompt('p', NOW - DAY, { isQuestion: true }));
    const f = file({ edits: [edit('p', NOW - DAY)] });
    expect(scoreFile(f, t, NOW - 2 * DAY).stats.edits).toBe(0);
    expect(scoreFile(f, t, NOW).stats.edits).toBe(1);
  });

  it('buckets at 70 and 40', () => {
    expect([bucketOf(70), bucketOf(69), bucketOf(40), bucketOf(39)]).toEqual(['green', 'yellow', 'yellow', 'red']);
  });
});

describe('mentionMatcher', () => {
  const match = mentionMatcher('/repo', ['src/orders/checkout.ts', 'src/a/index.ts', 'src/b/index.ts'], new Map([['applyDiscount', new Set(['src/orders/checkout.ts'])], ['shared', new Set(['src/a/index.ts', 'src/b/index.ts'])]]));
  it('matches paths, unique basenames and unique symbols', () => {
    expect(match('checkout.ts')).toEqual(['src/orders/checkout.ts']);
    expect(match('orders/checkout.ts')).toEqual(['src/orders/checkout.ts']);
    expect(match('/repo/src/a/index.ts')).toEqual(['src/a/index.ts']);
    expect(match('applyDiscount')).toEqual(['src/orders/checkout.ts']);
    expect(match('index.ts')).toEqual([]);
    expect(match('shared')).toEqual([]);
  });
});

describe('scoring the fixture repo', () => {
  it('ranks the files the way the demo story says', async () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-grasp-score-'));
    const demo = prepareDemo(join(home, 'demo'));
    const db = openDb(join(home, 'claude-grasp.db'));
    await ingest(db, demo.roots);
    const repoId = (db.prepare('SELECT id FROM repos').get() as { id: number }).id;
    const data = loadRepo(db, repoId)!;
    // The demo story was written with every penalty on.
    const scores = new Map(scoreRepo(data, FIXTURE_ANCHOR + DAY, STRICT).map((s) => [s.path, s]));

    const session = scores.get('src/auth/session.ts')!;
    expect(session.contributions.filter((c) => c.points > 0).map((c) => c.key)).toEqual(['plan', 'question', 'correction', 'reference']);
    expect(scores.get('src/reports/daily.ts')).toMatchObject({ score: 0, neverUnderstood: true, stats: { unattendedShare: 1 } });
    expect(scores.get('src/db/migrations.ts')!.stats.unattendedEdits).toBe(1);
    expect(points(scores.get('src/orders/checkout.ts')!, 'humanCommit')).toBe(10);

    const order = [...scores.values()].sort((a, b) => b.score - a.score).map((s) => s.path);
    expect(order.slice(0, 2)).toEqual(['src/auth/session.ts', 'src/orders/checkout.ts']);
    expect(summarize([...scores.values()]).files).toBe(6);
    // Three days earlier, daily.ts (headless, day -1) didn't exist yet.
    expect(trend(data, FIXTURE_ANCHOR - 3 * DAY, 1, 7, STRICT).map((p) => p.files)).toEqual([5]);
  });
});
