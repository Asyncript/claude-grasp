import { chmodSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../db';
import { demoShiftMs, prepareDemo } from '../demo/prepare';
import { answerQuestion, ensureQuiz, quizFor, skipQuestion, todaySummary } from '../explain/today';
import { SESSION_IDS } from '../fixtures/repo';
import { ingest } from '../ingest/run';
import { FakeQuizModel, extractJson, type FileDiff, type QuizModel } from '../llm';
import { ClaudeCli, claudeEnv } from '../llm/claude';
import { llmWorkdir } from '../shared/paths';

/** Records which account each call went to and what it was shown. */
class RecordingModel implements QuizModel {
  calls: { kind: string; dir: string; paths: string[] }[] = [];
  private fake = new FakeQuizModel();
  async questions(files: FileDiff[], count: number, dir: string) {
    this.calls.push({ kind: 'questions', dir, paths: files.map((f) => f.path) });
    return this.fake.questions(files, count);
  }
  async grade(q: { path: string; question: string; expected: string; diff: string }, answer: string, dir: string) {
    this.calls.push({ kind: 'grade', dir, paths: [q.path] });
    return this.fake.grade(q, answer);
  }
}

let db: DB;
let rootA: string;
let rootB: string;

beforeEach(async () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-grasp-explain-'));
  // Shifted so the fixture's day 0 is today, as in `claude-grasp --demo`.
  const demo = prepareDemo(join(home, 'demo'), demoShiftMs());
  rootA = demo.roots[0]!;
  // Today's session moves to a second account: its code may only go to that account.
  rootB = join(home, 'claude-work');
  const project = join('projects', '-demo-shop-api');
  mkdirSync(join(rootB, project), { recursive: true });
  renameSync(join(rootA, project, `${SESSION_IDS.today}.jsonl`), join(rootB, project, `${SESSION_IDS.today}.jsonl`));
  db = openDb(join(home, 'claude-grasp.db'));
  await ingest(db, [rootA, rootB]);
});

describe('today summary', () => {
  it("summarizes today's changes and names the account each file came from", () => {
    const s = todaySummary(db, {});
    expect(s.dataDay).toBe(s.day);
    expect(s.files.map((f) => [f.path, f.configDir]).sort()).toEqual([
      ['src/orders/checkout.ts', rootB],
      ['src/orders/pricing.ts', rootB],
      ['src/utils/format.ts', rootB],
    ]);
    expect(s.totals).toMatchObject({ files: 3, edits: 3, sessions: 1, bare: 2 });
    expect(s.files.every((f) => f.score !== null)).toBe(true);
  });
});

describe('explain-back quiz', () => {
  it("sends each file's diff only to its own account and grades through the same one", async () => {
    const model = new RecordingModel();
    const quiz = (await ensureQuiz(db, model, { questionsPerDay: 3 }))!;
    expect(quiz.questions).toHaveLength(3);
    expect(model.calls.map((c) => ({ ...c, paths: c.paths.sort() }))).toEqual([
      { kind: 'questions', dir: rootB, paths: ['src/orders/checkout.ts', 'src/orders/pricing.ts', 'src/utils/format.ts'] },
    ]);
    expect(quiz.questions.every((q) => q.configDir === rootB && q.expected === null)).toBe(true);

    // Asking again returns the same quiz without calling the model.
    await ensureQuiz(db, model, {});
    expect(model.calls).toHaveLength(1);

    const q = quiz.questions[0]!;
    const g = await answerQuestion(db, model, q.id, 'It applies the shipping fee only below the free threshold, so orders over 50 ship free.');
    expect(model.calls.at(-1)).toEqual({ kind: 'grade', dir: rootB, paths: [q.path] });
    expect(g.score).toBeGreaterThanOrEqual(0);
    const stored = db.prepare('SELECT answer, score, answered_at FROM quiz_questions WHERE id = ?').get(q.id) as Record<string, unknown>;
    expect(stored.score).toBe(g.score);
    expect(stored.answered_at).toBeTruthy();
  });

  it('never calls the model for an account with explain-back disabled', async () => {
    const model = new RecordingModel();
    const quiz = await ensureQuiz(db, model, { explainBackDisabled: [rootB] });
    expect(quiz).toBeNull();
    expect(model.calls).toEqual([]);
    expect(todaySummary(db, { explainBackDisabled: [rootB] }).explainBackDisabled).toEqual([rootB]);
  });

  it('feeds graded answers into the file score', async () => {
    const { loadRepo, scoreRepo } = await import('../scoring/repo');
    const quiz = (await ensureQuiz(db, new FakeQuizModel(), {}))!;
    const q = quiz.questions[0]!;
    const before = scoreRepo(loadRepo(db, q.repoId)!).find((s) => s.path === q.path)!;
    db.prepare('UPDATE quiz_questions SET answer = ?, score = 1, answered_at = ? WHERE id = ?').run('good', new Date().toISOString(), q.id);
    const after = scoreRepo(loadRepo(db, q.repoId)!).find((s) => s.path === q.path)!;
    expect(after.contributions.find((c) => c.key === 'quizPass')!.points).toBe(25);
    expect(after.score).toBeGreaterThan(before.score);
  });

  it('asks one question a day by default, and a skipped one never changes the score', async () => {
    const { loadRepo, scoreRepo } = await import('../scoring/repo');
    const quiz = (await ensureQuiz(db, new FakeQuizModel(), {}))!;
    expect(quiz.questions).toHaveLength(1);
    const q = quiz.questions[0]!;
    const before = scoreRepo(loadRepo(db, q.repoId)!).find((s) => s.path === q.path)!.score;
    skipQuestion(db, q.id);
    expect(quizFor(db, quiz.day)!.questions[0]).toMatchObject({ skipped: true, score: null });
    expect(scoreRepo(loadRepo(db, q.repoId)!).find((s) => s.path === q.path)!.score).toBe(before);
    expect(() => skipQuestion(db, 999)).toThrow(/no open question/);
  });

  it('grades each question once, and treats an empty answer as no answer', async () => {
    const model = new RecordingModel();
    const quiz = (await ensureQuiz(db, model, {}))!;
    const q = quiz.questions[0]!;
    await expect(answerQuestion(db, model, q.id, '   ')).rejects.toThrow(/Write an answer/);
    expect(db.prepare('SELECT score FROM quiz_questions WHERE id = ?').get(q.id)).toEqual({ score: null });

    // Two submits racing: only the first is stored, the second is refused.
    const answers = await Promise.allSettled([answerQuestion(db, model, q.id, 'first try'), answerQuestion(db, model, q.id, 'second try')]);
    expect(answers.map((a) => a.status)).toEqual(['fulfilled', 'rejected']);
    expect(db.prepare('SELECT answer FROM quiz_questions WHERE id = ?').get(q.id)).toEqual({ answer: 'first try' });
    await expect(answerQuestion(db, model, q.id, 'third try')).rejects.toThrow(/already answered/);
  });
});

describe('claude -p wrapper', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('sets CLAUDE_CONFIG_DIR per account, unsets it for ~/.claude, and drops parent-session variables', () => {
    const base = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/wrong', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' };
    expect(claudeEnv('/x/.claude-work', base)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/x/.claude-work' });
    expect(claudeEnv(join(homedir(), '.claude'), base)).toEqual({ PATH: '/bin' });
  });

  it("runs from Claude Grasp's own workdir with that account's config dir", async () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-grasp-bin-'));
    process.env.CLAUDE_GRASP_HOME = join(home, '.claude-grasp');
    const bin = join(home, 'claude');
    writeFileSync(bin, '#!/bin/sh\ncat >/dev/null\nprintf \'{"is_error":false,"result":"%s|%s|%s"}\' "$CLAUDE_CONFIG_DIR" "$(pwd)" "$*"\n');
    chmodSync(bin, 0o755);
    const reply = await new ClaudeCli({ claudeBin: bin }).complete('hi', '/x/.claude-work');
    const [dir, cwd, args] = reply.split('|');
    expect(dir).toBe('/x/.claude-work');
    expect(cwd).toBe(llmWorkdir());
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--strict-mcp-config');
    await expect(new ClaudeCli({ claudeBin: bin, explainBackDisabled: ['/x/.claude-work'] }).complete('hi', '/x/.claude-work')).rejects.toThrow(/disabled/);
  });

  it('pulls JSON out of a chatty reply', () => {
    expect(extractJson('Sure!\n```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(extractJson('{"score": 0.5, "feedback": "ok"} thanks')).toEqual({ score: 0.5, feedback: 'ok' });
  });
});
