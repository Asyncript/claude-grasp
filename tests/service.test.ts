import { mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db';
import { prepareDemo } from '../demo/prepare';
import { accountName, GraspService } from '../extension/service';
import { FIXTURE_ANCHOR, SESSION_IDS } from '../fixtures/repo';
import { FakeQuizModel } from '../llm';
import { STRICT_PENALTIES, withPenalties } from '../scoring/config';

const DAY = 86_400_000;
// Same numbers as scripts/smoke.ts, read through the service the dashboard uses.
const DEFAULT_SCORES = {
  'src/auth/session.ts': 70,
  'src/orders/checkout.ts': 74,
  'src/orders/pricing.ts': 39,
  'src/utils/format.ts': 45,
  'src/db/migrations.ts': 28,
  'src/reports/daily.ts': 0,
};

let service: GraspService;
let rootA: string;
let rootB: string;
let repoId: number;
let repoPath: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXTURE_ANCHOR + DAY);
  const home = mkdtempSync(join(tmpdir(), 'claude-grasp-service-'));
  const demo = prepareDemo(join(home, 'demo'));
  rootA = demo.roots[0]!;
  // Today's session belongs to a second account.
  rootB = join(home, '.claude-work');
  const project = join('projects', '-demo-shop-api');
  mkdirSync(join(rootB, project), { recursive: true });
  renameSync(join(rootA, project, `${SESSION_IDS.today}.jsonl`), join(rootB, project, `${SESSION_IDS.today}.jsonl`));
  service = new GraspService({
    db: openDb(join(home, 'claude-grasp.db')),
    config: {},
    model: new FakeQuizModel(),
    roots: () => [rootA, rootB],
    demo: true,
    quizEnabled: false,
    version: '0.0.0',
  });
  await service.ingest();
  const p = service.projects().projects[0]!;
  repoId = p.id;
  repoPath = p.path;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GraspService', () => {
  it('scores with every penalty but unattended off by default', () => {
    const files = service.files(repoId).files;
    expect(Object.fromEntries(files.map((f) => [f.path, f.score]))).toEqual(DEFAULT_SCORES);
    expect(service.files(repoId).summary.score).toBe(51);

    const detail = service.file(repoId, 'src/orders/checkout.ts');
    const off = detail.file.contributions.filter((c) => c.off).map((c) => c.key).sort();
    expect(off).toEqual(['autoAccept', 'bareApproval', 'quizFail', 'volume']);
    expect(detail.file.contributions.filter((c) => c.off).every((c) => c.points === 0)).toBe(true);
  });

  it('turns penalties on from settings and tells listeners', () => {
    const changed = vi.fn();
    service.onDidChange(changed);
    service.update({ config: { scoring: withPenalties(STRICT_PENALTIES) } });
    expect(changed).toHaveBeenCalled();
    expect(service.file(repoId, 'src/orders/checkout.ts').file.score).toBe(57);
    expect(service.files(repoId).summary.score).toBe(38);
    expect(service.file(repoId, 'src/orders/checkout.ts').file.contributions.some((c) => c.off)).toBe(false);
  });

  it('explains every score: base plus contributions is the raw score', () => {
    for (const f of service.files(repoId).files) {
      const { file } = service.file(repoId, f.path);
      const sum = file.base + file.contributions.reduce((a, c) => a + c.points, 0);
      expect(sum).toBeCloseTo(file.raw, 1);
      expect(file.score).toBe(Math.max(0, Math.min(100, Math.round(file.raw))));
    }
  });

  it('lists both accounts and filters a project by account', () => {
    const all = service.projects();
    expect(all.accounts.map((a) => a.name)).toEqual(['claude', 'work']);
    expect(all.projects[0]!.accounts.map((a) => a.dir).sort()).toEqual([rootA, rootB].sort());

    const work = service.files(repoId, rootB).files.map((f) => f.path).sort();
    expect(work).toEqual(['src/orders/checkout.ts', 'src/orders/pricing.ts', 'src/utils/format.ts']);
    expect(service.files(repoId, rootB).files.every((f) => f.accounts.includes(rootB))).toBe(true);
    expect(service.projects(join(tmpdir(), 'nobody')).projects).toEqual([]);
  });

  it('finds the score of a file on disk', () => {
    const hit = service.scoreForPath([repoPath, 'src', 'orders', 'pricing.ts'].join(sep));
    expect(hit).toMatchObject({ repoId, path: 'src/orders/pricing.ts', score: 39, bucket: 'red' });
    expect(service.scoreForPath([repoPath, 'README.md'].join(sep))).toBeNull();
    expect(service.scoreForPath(repoPath + '-other' + sep + 'src/orders/pricing.ts')).toBeNull();
    expect(service.allScores().get([repoPath, 'src', 'reports', 'daily.ts'].join(sep))?.score).toBe(0);
  });

  it('refuses the quiz while it is off, and a skip never changes a score', async () => {
    await expect(service.rpc('makeQuiz', [])).rejects.toThrow(/quiz is off/);
    service.update({ quizEnabled: true });
    const quiz = await service.makeQuiz();
    expect(quiz?.questions).toHaveLength(1);
    const before = service.files(repoId).files;
    await service.skip(quiz!.questions[0]!.id);
    expect(service.quiz()?.questions[0]).toMatchObject({ skipped: true, score: null });
    expect(service.files(repoId).files).toEqual(before);
    await expect(service.skip(9999)).rejects.toThrow(/no open question/);
  });

  it("doesn't hold up reading sessions while the model writes or grades a question", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = new FakeQuizModel();
    const calls: string[] = [];
    const slow = {
      questions: async (...a: Parameters<FakeQuizModel['questions']>) => (calls.push('questions'), await gate, fake.questions(...a)),
      grade: async (...a: Parameters<FakeQuizModel['grade']>) => (calls.push('grade'), await gate, fake.grade(...a)),
    };
    service.update({ quizEnabled: true, model: slow });
    const quiz = Promise.all([service.makeQuiz(), service.makeQuiz()]);
    await expect(service.ingest()).resolves.toMatchObject({ busy: false });
    release();
    const [a, b] = await quiz;
    expect(a).toEqual(b);
    expect(calls).toEqual(['questions']);
  });

  it('marks a file reviewed once per round of Claude changes', async () => {
    const before = service.scoreForPath([repoPath, 'src', 'orders', 'pricing.ts'].join(sep))!;
    expect(before.reviewDue).toBe(true);
    await service.rpc('markReviewed', [repoId, 'src/orders/pricing.ts']);
    const after = service.scoreForPath([repoPath, 'src', 'orders', 'pricing.ts'].join(sep))!;
    expect(after).toMatchObject({ reviewDue: false, score: before.score + 8 });
    await expect(service.markReviewed(repoId, 'src/nope.ts')).rejects.toThrow(/unknown file/);
  });

  it('only answers known rpc methods with checked arguments', async () => {
    await expect(service.rpc('constructor', [])).rejects.toThrow(/unknown method/);
    await expect(service.rpc('files', [String(repoId)])).rejects.toThrow(/expected an id/);
    await expect(service.rpc('file', [repoId, 7])).rejects.toThrow(/expected a string/);
    await expect(service.rpc('files', [repoId, 42])).rejects.toThrow(/expected a string/);
    await expect(service.rpc('file', [repoId, '../etc/passwd'])).rejects.toThrow(/unknown file/);
    expect(await service.rpc('files', [repoId, ''])).toMatchObject({ summary: { score: 51 } });
  });
});

describe('accountName', () => {
  it('names config dirs the way the account filter shows them', () => {
    expect(accountName('/home/me/.claude')).toBe('default');
    expect(accountName('/home/me/.claude-work')).toBe('work');
    expect(accountName('/home/me/.claude_personal')).toBe('personal');
  });
});
