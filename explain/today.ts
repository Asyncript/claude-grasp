import { join } from 'node:path';
import { transaction, type DB } from '../db';
import type { FileDiff, QuizModel } from '../llm';
import { isObj, parseLine, str, arr } from '../parser/lines';
import { readLines } from '../parser/jsonl-stream';
import { splitLines } from '../parser/text';
import type { Bucket } from '../scoring/config';
import { loadRepo, scoreRepo } from '../scoring/repo';
import { explainBackAllowed, type GraspConfig } from '../shared/config';

const DAY_MS = 86_400_000;
/** Lines of diff per file sent to the model. */
const MAX_DIFF_LINES = 160;
/** With nothing today, the quiz looks this far back for the latest day with edits. */
const LOOKBACK_DAYS = 7;

/** YYYY-MM-DD in local time. */
export function localDay(ms = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** [start, end) of a local day as ISO strings, comparable with stored timestamps. */
export function dayRange(day: string): [string, string] {
  const [y, m, d] = day.split('-').map(Number);
  const start = new Date(y!, m! - 1, d!).getTime();
  return [new Date(start).toISOString(), new Date(start + DAY_MS).toISOString()];
}

export interface TodayFile {
  repoId: number;
  repo: string;
  path: string;
  edits: number;
  lines: number;
  unattendedLines: number;
  score: number | null;
  bucket: Bucket | null;
  /** The config dir whose sessions changed this file most today: the only account allowed to see it. */
  configDir: string | null;
}

export interface QuizView {
  id: number;
  day: string;
  questions: {
    id: number;
    repoId: number;
    path: string;
    configDir: string;
    question: string;
    answer: string | null;
    score: number | null;
    feedback: string | null;
    expected: string | null;
    /** Skipped questions count neither for nor against the file. */
    skipped: boolean;
  }[];
}

export interface TodaySummary {
  day: string;
  /** The day the numbers are for: today, or the latest day with edits when today has none. */
  dataDay: string;
  totals: { files: number; edits: number; lines: number; unattendedEdits: number; sessions: number; prompts: number; bare: number; questions: number; corrections: number };
  files: TodayFile[];
  quiz: QuizView | null;
  /** Config dirs that changed code that day but have explain-back turned off. */
  explainBackDisabled: string[];
}

interface EditRow {
  repo_id: number;
  repo: string;
  repo_path: string;
  rel_path: string;
  session_id: string;
  source: string;
  tool_use_id: string;
  lines: number;
  unattended: number;
  root: string | null;
}

function editsOn(db: DB, day: string): EditRow[] {
  const [from, to] = dayRange(day);
  return db
    .prepare(
      `SELECT e.repo_id, r.name AS repo, r.path AS repo_path, e.rel_path, e.session_id, e.source, e.tool_use_id,
              e.added + e.removed AS lines, e.unattended, p.root
       FROM edits e JOIN repos r ON r.id = e.repo_id
       LEFT JOIN sessions s ON s.id = e.session_id LEFT JOIN projects p ON p.id = s.project_id
       WHERE e.ts >= ? AND e.ts < ? ORDER BY e.ts`,
    )
    .all(from, to) as unknown as EditRow[];
}

function latestDayWithEdits(db: DB, now: number): string | null {
  const today = localDay(now);
  if (editsOn(db, today).length) return today;
  const [from] = dayRange(localDay(now - LOOKBACK_DAYS * DAY_MS));
  const row = db.prepare('SELECT MAX(ts) AS ts FROM edits WHERE ts >= ? AND unattended = 0').get(from) as { ts: string | null };
  return row.ts ? localDay(Date.parse(row.ts)) : null;
}

export function todaySummary(db: DB, config: GraspConfig, now = Date.now()): TodaySummary {
  const day = localDay(now);
  const dataDay = latestDayWithEdits(db, now) ?? day;
  const rows = editsOn(db, dataDay);

  const files = new Map<string, TodayFile & { dirs: Map<string, number> }>();
  for (const r of rows) {
    const key = `${r.repo_id}\0${r.rel_path}`;
    const f = files.get(key) ?? { repoId: r.repo_id, repo: r.repo, path: r.rel_path, edits: 0, lines: 0, unattendedLines: 0, score: null, bucket: null, configDir: null, dirs: new Map() };
    f.edits++;
    f.lines += r.lines;
    if (r.unattended) f.unattendedLines += r.lines;
    if (r.root) f.dirs.set(r.root, (f.dirs.get(r.root) ?? 0) + Math.max(1, r.lines));
    files.set(key, f);
  }

  for (const repoId of new Set(rows.map((r) => r.repo_id))) {
    const data = loadRepo(db, repoId);
    if (!data) continue;
    for (const s of scoreRepo(data, now, config.scoring)) {
      const f = files.get(`${repoId}\0${s.path}`);
      if (f) Object.assign(f, { score: s.score, bucket: s.bucket });
    }
  }

  const sessions = [...new Set(rows.map((r) => r.session_id))];
  const [from, to] = dayRange(dataDay);
  const p = db
    .prepare(
      `SELECT COUNT(*) AS prompts, COALESCE(SUM(is_bare), 0) AS bare, COALESCE(SUM(is_question), 0) AS questions,
              COALESCE(SUM(is_correction OR kind IN ('rejection', 'interrupt')), 0) AS corrections
       FROM prompts WHERE ts >= ? AND ts < ? AND kind != 'answer'`,
    )
    .get(from, to) as { prompts: number; bare: number; questions: number; corrections: number };

  const list = [...files.values()].map(({ dirs, ...f }) => ({ ...f, configDir: [...dirs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null }));
  list.sort((a, b) => b.lines - a.lines);
  const disabled = [...new Set(list.map((f) => f.configDir).filter((d): d is string => !!d && !explainBackAllowed(config, d)))];

  return {
    day,
    dataDay,
    totals: {
      files: list.length,
      edits: rows.length,
      lines: rows.reduce((n, r) => n + r.lines, 0),
      unattendedEdits: rows.filter((r) => r.unattended).length,
      sessions: sessions.length,
      ...p,
    },
    files: list,
    quiz: quizFor(db, day),
    explainBackDisabled: disabled,
  };
}

export function quizFor(db: DB, day: string, reveal = true): QuizView | null {
  const quiz = db.prepare('SELECT id, day FROM quizzes WHERE day = ?').get(day) as { id: number; day: string } | undefined;
  if (!quiz) return null;
  const rows = db
    .prepare('SELECT id, repo_id, rel_path, config_dir, question, expected, answer, score, feedback, skipped FROM quiz_questions WHERE quiz_id = ? ORDER BY id')
    .all(quiz.id) as { id: number; repo_id: number; rel_path: string; config_dir: string; question: string; expected: string; answer: string | null; score: number | null; feedback: string | null; skipped: number }[];
  return {
    ...quiz,
    questions: rows.map((r) => ({
      id: r.id, repoId: r.repo_id, path: r.rel_path, configDir: r.config_dir, question: r.question, answer: r.answer, score: r.score, feedback: r.feedback, skipped: !!r.skipped,
      // The key points stay hidden until the question is answered.
      expected: reveal && r.score !== null ? r.expected : null,
    })),
  };
}

/**
 * Today's quiz, generated on first request: `questionsPerDay` questions (default 1) about the files Claude changed
 * most with the least understanding. Each file's diff goes only to the account (config dir) that
 * produced it; files from accounts with explain-back disabled are never sent anywhere.
 */
export async function ensureQuiz(db: DB, model: QuizModel, config: GraspConfig, now = Date.now()): Promise<QuizView | null> {
  const day = localDay(now);
  const existing = quizFor(db, day);
  if (existing) return existing;

  const summary = todaySummary(db, config, now);
  const candidates = summary.files
    .filter((f) => f.configDir && explainBackAllowed(config, f.configDir) && f.lines > f.unattendedLines)
    .sort((a, b) => b.lines * (110 - (b.score ?? 0)) - a.lines * (110 - (a.score ?? 0)));

  const perDay = Math.max(1, Math.min(5, Math.round(config.questionsPerDay ?? 1)));
  const picked: (TodayFile & { diff: string })[] = [];
  for (const f of candidates) {
    if (picked.length === perDay) break;
    const diff = await fileDiff(db, summary.dataDay, f);
    if (diff) picked.push({ ...f, diff });
  }
  if (!picked.length) return null;

  // Split the questions across the picked files, then ask each account only about its own files.
  const counts = picked.map((_, i) => Math.floor(perDay / picked.length) + (i < perDay % picked.length ? 1 : 0));
  const byDir = new Map<string, { files: typeof picked; count: number }>();
  picked.forEach((f, i) => {
    const g = byDir.get(f.configDir!) ?? { files: [], count: 0 };
    g.files.push(f);
    g.count += counts[i]!;
    byDir.set(f.configDir!, g);
  });

  const rows: { dir: string; file: (typeof picked)[number]; question: string; expected: string }[] = [];
  for (const [dir, g] of byDir) {
    const diffs: FileDiff[] = g.files.map((f) => ({ path: f.path, diff: f.diff }));
    const qs = await model.questions(diffs, g.count, dir);
    for (const q of qs) rows.push({ dir, file: g.files.find((f) => f.path === q.path) ?? g.files[0]!, question: q.question, expected: q.expected });
  }
  if (!rows.length) return null;

  transaction(db, () => {
    const { lastInsertRowid } = db.prepare('INSERT INTO quizzes (day, created_at, summary) VALUES (?, ?, ?)').run(day, new Date(now).toISOString(), JSON.stringify(summary.totals));
    const ins = db.prepare('INSERT INTO quiz_questions (quiz_id, config_dir, repo_id, rel_path, question, expected, diff) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(lastInsertRowid, r.dir, r.file.repoId, r.file.path, r.question, r.expected, r.file.diff);
  });
  return quizFor(db, day);
}

/** Marks a question skipped. It never affects a score; it can still be answered later the same day. */
export function skipQuestion(db: DB, questionId: number, now = Date.now()): void {
  const r = db.prepare('UPDATE quiz_questions SET skipped = 1, answered_at = ? WHERE id = ? AND score IS NULL').run(new Date(now).toISOString(), questionId);
  if (!r.changes) throw new Error(`no open question ${questionId}`);
}

/** Grades one answer through the same account that wrote the question, and stores the result. */
export async function answerQuestion(db: DB, model: QuizModel, questionId: number, answer: string, now = Date.now()) {
  const q = db.prepare('SELECT id, config_dir, rel_path, question, expected, diff FROM quiz_questions WHERE id = ?').get(questionId) as
    | { id: number; config_dir: string; rel_path: string; question: string; expected: string; diff: string }
    | undefined;
  if (!q) throw new Error(`no question ${questionId}`);
  const text = answer.trim();
  const grade = text ? await model.grade({ path: q.rel_path, question: q.question, expected: q.expected, diff: q.diff }, text, q.config_dir) : { score: 0, feedback: 'No answer.' };
  db.prepare('UPDATE quiz_questions SET answer = ?, score = ?, feedback = ?, answered_at = ?, skipped = 0 WHERE id = ?').run(text, grade.score, grade.feedback, new Date(now).toISOString(), q.id);
  return { ...grade, expected: q.expected };
}

/**
 * The day's changes to one file as a unified-style diff, rebuilt from the transcripts of the
 * file's own config dir (the tool results carry the patches). Read-only.
 */
export async function fileDiff(db: DB, day: string, f: TodayFile): Promise<string> {
  const [from, to] = dayRange(day);
  const rows = db
    .prepare(
      `SELECT e.source, e.tool_use_id, r.path AS repo_path FROM edits e JOIN repos r ON r.id = e.repo_id
       LEFT JOIN sessions s ON s.id = e.session_id LEFT JOIN projects p ON p.id = s.project_id
       WHERE e.repo_id = ? AND e.rel_path = ? AND e.ts >= ? AND e.ts < ? AND e.unattended = 0 AND p.root IS ? ORDER BY e.ts`,
    )
    .all(f.repoId, f.path, from, to, f.configDir) as { source: string; tool_use_id: string; repo_path: string }[];
  if (!rows.length) return '';
  const abs = join(rows[0]!.repo_path, f.path);

  const bySource = new Map<string, Set<string>>();
  for (const r of rows) bySource.set(r.source, (bySource.get(r.source) ?? new Set()).add(r.tool_use_id));
  const out: string[] = [];
  for (const [source, ids] of bySource) {
    try {
      for await (const { text } of readLines(source, 0)) {
        if (!text.includes('tool_use_id')) continue;
        const id = [...ids].find((x) => text.includes(x));
        if (!id) continue;
        const o = parseLine(text);
        if (!o || !isObj(o.toolUseResult)) continue;
        const block = isObj(o.message) ? arr(o.message.content).find((b) => isObj(b) && b.tool_use_id === id) : undefined;
        if (!block) continue;
        out.push(...patchLines(o.toolUseResult, abs));
        if (out.length > MAX_DIFF_LINES) break;
      }
    } catch {
      // A transcript that vanished since ingest just contributes nothing.
    }
    if (out.length > MAX_DIFF_LINES) break;
  }
  return out.length > MAX_DIFF_LINES ? [...out.slice(0, MAX_DIFF_LINES), '... (truncated)'].join('\n') : out.join('\n');
}

function patchLines(r: Record<string, unknown>, abs: string): string[] {
  const hunks = (hs: unknown[]) =>
    hs.flatMap((h) => (isObj(h) ? [`@@ -${h.oldStart ?? '?'} +${h.newStart ?? '?'} @@`, ...arr(h.lines).map((l) => str(l) ?? '')] : []));
  if (r.type === 'create' && typeof r.content === 'string') return [`@@ new file @@`, ...splitLines(r.content).map((l) => `+${l}`)];
  if (arr(r.structuredPatch).length) return hunks(arr(r.structuredPatch));
  if (isObj(r.bashEditDiff)) {
    for (const f of arr(r.bashEditDiff.files)) if (isObj(f) && f.filePath === abs) return hunks(arr(f.hunks));
  }
  return [];
}
