import { basename } from 'node:path';
import type { DB } from '../db';
import { attributeFileCommits } from '../git/attribution';
import type { Approval, PromptKind } from '../shared/types';
import { bucketOf, SCORING, type Bucket, type ScoringConfig } from './config';
import { DEFAULT_IGNORE, fileFilter } from './visible';
import { scoreFile, type FileInput, type FileScore, type Prompt, type Turn } from './score';

export interface RepoData {
  repo: { id: number; path: string; name: string };
  files: FileInput[];
  turns: Map<string, Turn>;
  /** Claude config dirs whose sessions edited each file, most lines first. */
  configDirs: Map<string, { dir: string; lines: number }[]>;
}

const ms = (t: string | null) => (t ? Date.parse(t) : 0);
/** A symbol shorter than this ("get", "run") names too many things to link a prompt to a file. */
const MIN_SYMBOL = 4;

export interface LoadOptions {
  /** Your git emails besides the repo's user.email. */
  gitEmails?: string[];
  /** Globs of files that never get a score, besides DEFAULT_IGNORE. Deleted and git-ignored files never do either. */
  ignore?: string[];
}

/** Everything needed to score every file Claude edited in one repo. Read-only. */
export function loadRepo(db: DB, repoId: number, o: LoadOptions = {}): RepoData | null {
  const row = db.prepare('SELECT id, path, name, user_email FROM repos WHERE id = ?').get(repoId) as (RepoData['repo'] & { user_email: string | null }) | undefined;
  if (!row) return null;
  const { user_email: userEmail, ...repo } = row;
  const keep = fileFilter(db, repo, [...DEFAULT_IGNORE, ...(o.ignore ?? [])]);

  const allEditRows = db
    .prepare(
      `SELECT e.session_id, e.turn_id, e.ts, e.tool, e.rel_path, e.added + e.removed AS lines, e.approval, e.unattended, e.symbols, p.root
       FROM edits e LEFT JOIN sessions s ON s.id = e.session_id LEFT JOIN projects p ON p.id = s.project_id
       WHERE e.repo_id = ? ORDER BY e.ts`,
    )
    .all(repoId) as {
    session_id: string; turn_id: string | null; ts: string; tool: string; rel_path: string; lines: number;
    approval: Approval; unattended: number; symbols: string; root: string | null;
  }[];
  const visible = new Map<string, boolean>();
  const shown = (path: string) => visible.get(path) ?? (visible.set(path, keep(path)), visible.get(path)!);
  const editRows = allEditRows.filter((e) => shown(e.rel_path));

  const sessionFilter = `session_id IN (SELECT DISTINCT session_id FROM edits WHERE repo_id = @repo)
    OR session_id IN (SELECT s.id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.repo_id = @repo)`;
  const promptRows = db
    .prepare(`SELECT uuid, session_id, turn_id, ts, kind, words, is_bare, is_question, is_correction, excerpt, mentions FROM prompts WHERE ${sessionFilter} ORDER BY session_id, ts`)
    .all({ repo: repoId }) as {
    uuid: string; session_id: string; turn_id: string | null; ts: string; kind: PromptKind; words: number;
    is_bare: number; is_question: number; is_correction: number; excerpt: string; mentions: string;
  }[];
  const planRows = db.prepare(`SELECT turn_id, ts, outcome, plan_edited FROM plans WHERE ${sessionFilter}`).all({ repo: repoId }) as {
    turn_id: string | null; ts: string; outcome: 'approved' | 'rejected'; plan_edited: number;
  }[];
  const refRows = (db.prepare('SELECT session_id, turn_id, ts, rel_path, kind FROM file_refs WHERE repo_id = ?').all(repoId) as {
    session_id: string; turn_id: string | null; ts: string; rel_path: string; kind: string;
  }[]).filter((r) => shown(r.rel_path));
  const commitRows = db
    .prepare('SELECT cf.rel_path, c.sha, c.ts, c.subject, c.is_claude, c.email FROM commit_files cf JOIN commits c ON c.repo_id = cf.repo_id AND c.sha = cf.sha WHERE cf.repo_id = ?')
    .all(repoId) as { rel_path: string; sha: string; ts: number; subject: string; is_claude: number; email: string | null }[];
  const quizRows = db
    .prepare('SELECT id, rel_path, question, score, answered_at FROM quiz_questions WHERE repo_id = ? AND score IS NOT NULL')
    .all(repoId) as { id: number; rel_path: string; question: string; score: number; answered_at: string }[];

  // Turns: each human prompt opens one; answers, rejections and interruptions join the turn they happened in.
  const turns = new Map<string, Turn>();
  let prev: Turn | null = null;
  const prompts: Prompt[] = [];
  for (const r of promptRows) {
    const p: Prompt = {
      uuid: r.uuid, sessionId: r.session_id, ts: ms(r.ts), kind: r.kind, words: r.words,
      isBare: !!r.is_bare, isQuestion: !!r.is_question, isCorrection: !!r.is_correction, excerpt: r.excerpt ?? '',
    };
    prompts.push(p);
    if (p.kind !== 'human') continue;
    const t: Turn = { id: p.uuid, sessionId: p.sessionId, starter: p, prev: null, next: null, prompts: [], plans: [] };
    if (prev && prev.sessionId === p.sessionId) {
      prev.next = t.id;
      t.prev = prev.id;
    }
    turns.set(t.id, t);
    prev = t;
  }
  for (const [i, p] of prompts.entries()) {
    const turnId = promptRows[i]!.turn_id;
    const t = turnId ? turns.get(turnId) : undefined;
    if (t) t.prompts.push(p);
  }
  for (const r of planRows) {
    const t = r.turn_id ? turns.get(r.turn_id) : undefined;
    t?.plans.push({ ts: ms(r.ts), outcome: r.outcome, planEdited: !!r.plan_edited });
  }

  // How many files each turn changed, so a turn's credit can be split between them.
  const turnFiles = new Map<string, Set<string>>();
  const touch = (turnId: string | null, path: string) => {
    if (turnId) turnFiles.set(turnId, (turnFiles.get(turnId) ?? new Set()).add(path));
  };
  for (const e of editRows) if (!e.unattended) touch(e.turn_id, e.rel_path);
  for (const r of refRows) if (r.kind === 'rejected_edit') touch(r.turn_id, r.rel_path);
  for (const [id, paths] of turnFiles) {
    const t = turns.get(id);
    if (t) t.files = paths.size;
  }

  const files = new Map<string, FileInput>();
  const dirLines = new Map<string, Map<string, number>>();
  const symbolFiles = new Map<string, Set<string>>();
  for (const e of editRows) {
    let f = files.get(e.rel_path);
    if (!f) {
      f = { repoId, path: e.rel_path, edits: [], rejections: [], mentions: [], ideRefs: [], externalEdits: [], commits: [], quizzes: [], reviews: [] };
      files.set(e.rel_path, f);
    }
    f.edits.push({ ts: ms(e.ts), sessionId: e.session_id, turnId: e.turn_id, tool: e.tool, lines: e.lines, approval: e.approval, unattended: !!e.unattended });
    if (e.root) {
      const m = dirLines.get(e.rel_path) ?? new Map<string, number>();
      m.set(e.root, (m.get(e.root) ?? 0) + Math.max(1, e.lines));
      dirLines.set(e.rel_path, m);
    }
    for (const s of JSON.parse(e.symbols) as string[]) {
      if (s.length < MIN_SYMBOL) continue;
      const set = symbolFiles.get(s) ?? new Set();
      set.add(e.rel_path);
      symbolFiles.set(s, set);
    }
  }

  for (const r of refRows) {
    const f = files.get(r.rel_path);
    if (!f) continue;
    const ts = ms(r.ts);
    if (r.kind === 'rejected_edit') f.rejections.push({ ts, turnId: r.turn_id });
    else if (r.kind === 'external_edit') f.externalEdits.push({ ts, sessionId: r.session_id });
    else if (r.kind === 'ide_open' || r.kind === 'ide_select') f.ideRefs.push({ ts, sessionId: r.session_id, kind: r.kind });
  }

  const match = mentionMatcher(repo.path, [...files.keys()], symbolFiles);
  for (const [i, r] of promptRows.entries()) {
    if (r.kind !== 'human') continue;
    const hits = new Map<string, string>();
    for (const m of JSON.parse(r.mentions) as string[]) {
      for (const path of match(m)) if (!hits.has(path)) hits.set(path, m);
    }
    for (const [path, matched] of hits) files.get(path)!.mentions.push({ uuid: r.uuid, ts: prompts[i]!.ts, sessionId: r.session_id, excerpt: r.excerpt ?? '', matched });
  }

  // With no identity known at all, every author counts as you (the behaviour before identities).
  const mine = new Set([userEmail, ...(o.gitEmails ?? [])].filter((e): e is string => !!e?.trim()).map((e) => e.trim().toLowerCase()));
  const isMine = mine.size ? (email: string) => mine.has(email.toLowerCase()) : undefined;
  const byFile = new Map<string, typeof commitRows>();
  for (const c of commitRows) if (files.has(c.rel_path)) byFile.set(c.rel_path, [...(byFile.get(c.rel_path) ?? []), c]);
  for (const [path, rows] of byFile) {
    const f = files.get(path)!;
    const subjects = new Map(rows.map((r) => [r.sha, r.subject]));
    f.commits = attributeFileCommits(rows.map((r) => ({ sha: r.sha, ts: r.ts, isClaude: !!r.is_claude, email: r.email ?? '' })), f.edits.map((e) => e.ts), isMine).map((c) => ({
      sha: c.sha, ts: c.ts, subject: subjects.get(c.sha) ?? '', attribution: c.attribution,
    }));
  }

  for (const q of quizRows) files.get(q.rel_path)?.quizzes.push({ id: q.id, ts: ms(q.answered_at), question: q.question, grade: q.score });
  for (const r of db.prepare('SELECT rel_path, ts FROM reviews WHERE repo_id = ?').all(repoId) as { rel_path: string; ts: string }[]) {
    files.get(r.rel_path)?.reviews!.push({ ts: ms(r.ts) });
  }

  const configDirs = new Map<string, { dir: string; lines: number }[]>();
  for (const [path, m] of dirLines) configDirs.set(path, [...m].map(([dir, lines]) => ({ dir, lines })).sort((a, b) => b.lines - a.lines));

  return { repo, files: [...files.values()], turns, configDirs };
}

/** Maps a mention from a prompt to the files it names: a path, a unique basename, or a symbol only one file declares. */
export function mentionMatcher(repoPath: string, paths: string[], symbolFiles: Map<string, Set<string>>) {
  const byBase = new Map<string, string[]>();
  for (const p of paths) byBase.set(basename(p), [...(byBase.get(basename(p)) ?? []), p]);
  return (mention: string): string[] => {
    let m = mention.replace(/^\.\//, '');
    if (m.startsWith(repoPath + '/')) m = m.slice(repoPath.length + 1);
    if (m.includes('/')) return paths.filter((p) => p === m || p.endsWith('/' + m));
    const base = byBase.get(m);
    if (base?.length === 1) return base;
    const sym = symbolFiles.get(m);
    return sym?.size === 1 ? [...sym] : [];
  };
}

export interface RepoSummary {
  /** Mean of file scores weighted by changed lines. */
  score: number;
  bucket: Bucket;
  files: number;
  buckets: Record<Bucket, number>;
  linesChanged: number;
  unattendedShare: number;
  neverUnderstood: number;
}

export function summarize(scores: FileScore[], c: ScoringConfig = SCORING): RepoSummary {
  const buckets: Record<Bucket, number> = { green: 0, yellow: 0, red: 0 };
  let weighted = 0;
  let lines = 0;
  let unattended = 0;
  for (const s of scores) {
    buckets[s.bucket]++;
    const w = Math.max(1, s.stats.linesChanged);
    weighted += s.score * w;
    lines += w;
    unattended += s.stats.unattendedLines;
  }
  const score = lines ? Math.round(weighted / lines) : 0;
  return {
    score,
    bucket: bucketOf(score, c),
    files: scores.length,
    buckets,
    linesChanged: lines,
    unattendedShare: lines ? Math.round((unattended / lines) * 1000) / 1000 : 0,
    neverUnderstood: scores.filter((s) => s.neverUnderstood).length,
  };
}

export function scoreRepo(data: RepoData, now = Date.now(), c: ScoringConfig = SCORING): FileScore[] {
  return data.files.map((f) => scoreFile(f, data.turns, now, c)).filter((s) => s.stats.edits > 0);
}

/** Weekly, or daily when Claude's first edit in the repo is less than four weeks old. */
export function trendStepDays(data: RepoData, now = Date.now()): number {
  let first = now;
  for (const f of data.files) for (const e of f.edits) first = Math.min(first, e.ts);
  return now - first < 28 * 86_400_000 ? 1 : 7;
}

/** The repo's score at each of the last `count` steps, for files Claude had edited by then. */
export function trend(data: RepoData, now = Date.now(), count = 12, stepDays = 7, c: ScoringConfig = SCORING) {
  const points = [];
  for (let i = count - 1; i >= 0; i--) {
    const at = now - i * stepDays * 86_400_000;
    const scores = scoreRepo(data, at, c);
    if (!scores.length) continue;
    const s = summarize(scores, c);
    points.push({ at: new Date(at).toISOString(), score: s.score, files: s.files, ...s.buckets });
  }
  return points;
}

export { SCORING };
