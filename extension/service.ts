// Everything the dashboard, tree, badges and status bar ask for. No `vscode` import, so the dev
// preview and the tests use exactly the same code as the extension.
import { basename, relative, sep } from 'node:path';
import type { DB } from '../db';
import { answerQuestion, ensureQuiz, localDay, quizFor, skipQuestion, todaySummary, type QuizView, type TodaySummary } from '../explain/today';
import { ingest, type IngestStats } from '../ingest/run';
import type { QuizModel } from '../llm';
import { SCORING, type Bucket, type ScoringConfig } from '../scoring/config';
import { loadRepo, scoreRepo, summarize, trend, trendStepDays, type RepoData, type RepoSummary } from '../scoring/repo';
import type { FileScore } from '../scoring/score';
import type { GraspConfig } from '../shared/config';

export interface ServiceOptions {
  db: DB;
  config: GraspConfig;
  model: QuizModel;
  /** The Claude config dirs to read, asked again before every ingest (new ones may appear). */
  roots: () => string[];
  demo: boolean;
  quizEnabled: boolean;
  version: string;
}

/** "~/.claude-work" → "work", "~/.claude" → "default". */
export const accountName = (dir: string): string => {
  const b = basename(dir);
  return b === '.claude' ? 'default' : b.replace(/^\.claude[-_.]?/, '') || b;
};

export interface Account {
  dir: string;
  name: string;
  sessions: number;
}

export interface Project {
  id: number;
  name: string;
  path: string;
  accounts: Account[];
  summary: RepoSummary;
  firstEdit: string | null;
  lastEdit: string | null;
  sessions: number;
}

export interface Settings {
  demo: boolean;
  version: string;
  quizEnabled: boolean;
  questionsPerDay: number;
  scoring: ScoringConfig;
}

export interface ProjectsResponse {
  roots: string[];
  accounts: Account[];
  projects: Project[];
  settings: Settings;
}

export interface FileRow {
  path: string;
  score: number;
  bucket: Bucket;
  lines: number;
  edits: number;
  unattendedShare: number;
  neverUnderstood: boolean;
  lastEdit: string | null;
  accounts: string[];
}

export interface FilesResponse {
  repo: RepoData['repo'];
  summary: RepoSummary;
  files: FileRow[];
}

export interface SessionRow {
  id: string;
  title: string | null;
  entrypoint: string | null;
  started_at: string | null;
  ended_at: string | null;
  headless: number;
  root: string | null;
  edits: number;
}

export interface FileDetail {
  repo: RepoData['repo'];
  file: FileScore;
  accounts: { dir: string; name: string; lines: number }[];
  sessions: SessionRow[];
  config: ScoringConfig;
}

export interface TrendPoint {
  at: string;
  score: number;
  files: number;
  green: number;
  yellow: number;
  red: number;
}

export interface ScoresResponse {
  summary: RepoSummary;
  trend: TrendPoint[];
  trendStepDays: number;
  neverUnderstood: { path: string; score: number; lines: number; edits: number; lastEdit: string | null; unattendedShare: number }[];
  config: ScoringConfig;
}

export interface PathScore {
  repoId: number;
  repo: string;
  path: string;
  score: number;
  bucket: Bucket;
}

export class GraspService {
  private cache = new Map<number, { data: RepoData; scores: FileScore[] }>();
  private repoList: { id: number; name: string; path: string }[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private ingesting: Promise<IngestStats> | null = null;
  private listeners = new Set<() => void>();

  constructor(private o: ServiceOptions) {}

  get demo(): boolean {
    return this.o.demo;
  }

  get db(): DB {
    return this.o.db;
  }

  get scoring(): ScoringConfig {
    return this.o.config.scoring ?? SCORING;
  }

  /** New settings re-score everything; nothing is re-read. */
  update(o: Partial<Pick<ServiceOptions, 'config' | 'model' | 'quizEnabled'>>): void {
    Object.assign(this.o, o);
    this.invalidate();
  }

  /** Called after anything that can change a score. */
  onDidChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private invalidate() {
    this.cache.clear();
    this.repoList = null;
    for (const fn of this.listeners) fn();
  }

  /**
   * Writes run one at a time: an ingest keeps a transaction open across awaits, and SQLite
   * can't start a second one on the same connection.
   */
  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private repo(repoId: number) {
    let hit = this.cache.get(repoId);
    if (!hit) {
      const data = loadRepo(this.o.db, repoId);
      if (!data) return null;
      hit = { data, scores: scoreRepo(data, Date.now(), this.scoring) };
      this.cache.set(repoId, hit);
    }
    return hit;
  }

  private repos() {
    this.repoList ??= this.o.db
      .prepare('SELECT id, name, path FROM repos WHERE id IN (SELECT DISTINCT repo_id FROM edits) ORDER BY name')
      .all() as { id: number; name: string; path: string }[];
    return this.repoList;
  }

  /** Files the given account (config dir) wrote lines in; everything without one. */
  private filtered(hit: { data: RepoData; scores: FileScore[] }, account?: string) {
    if (!account) return hit.scores;
    return hit.scores.filter((s) => hit.data.configDirs.get(s.path)?.some((d) => d.dir === account));
  }

  settings(): Settings {
    return { demo: this.o.demo, version: this.o.version, quizEnabled: this.o.quizEnabled, questionsPerDay: this.o.config.questionsPerDay ?? 1, scoring: this.scoring };
  }

  projects(account?: string): ProjectsResponse {
    const dirs = this.o.db
      .prepare(
        `SELECT e.repo_id, p.root, COUNT(DISTINCT s.id) AS sessions FROM edits e
         JOIN sessions s ON s.id = e.session_id JOIN projects p ON p.id = s.project_id GROUP BY e.repo_id, p.root`,
      )
      .all() as { repo_id: number; root: string; sessions: number }[];
    const all = new Map<string, Account>();
    for (const d of dirs) {
      const a = all.get(d.root) ?? { dir: d.root, name: accountName(d.root), sessions: 0 };
      a.sessions += d.sessions;
      all.set(d.root, a);
    }
    const projects: Project[] = [];
    for (const r of this.repos()) {
      const accounts = dirs.filter((d) => d.repo_id === r.id).map((d) => ({ dir: d.root, name: accountName(d.root), sessions: d.sessions }));
      if (account && !accounts.some((a) => a.dir === account)) continue;
      const hit = this.repo(r.id);
      const scores = hit ? this.filtered(hit, account) : [];
      const times = scores.flatMap((s) => [s.stats.firstEdit, s.stats.lastEdit]).filter((t): t is string => !!t).sort();
      projects.push({
        ...r,
        accounts,
        summary: summarize(scores, this.scoring),
        firstEdit: times[0] ?? null,
        lastEdit: times.at(-1) ?? null,
        sessions: new Set(scores.flatMap((s) => s.stats.sessions)).size,
      });
    }
    return { roots: this.o.roots(), accounts: [...all.values()].sort((a, b) => a.name.localeCompare(b.name)), projects, settings: this.settings() };
  }

  files(repoId: number, account?: string): FilesResponse {
    const hit = this.repo(repoId);
    if (!hit) throw new Error('unknown project');
    const scores = this.filtered(hit, account);
    return {
      repo: hit.data.repo,
      summary: summarize(scores, this.scoring),
      files: scores.map((s) => ({
        path: s.path, score: s.score, bucket: s.bucket, lines: s.stats.linesChanged, edits: s.stats.edits,
        unattendedShare: s.stats.unattendedShare, neverUnderstood: s.neverUnderstood, lastEdit: s.stats.lastEdit,
        accounts: (hit.data.configDirs.get(s.path) ?? []).map((d) => d.dir),
      })),
    };
  }

  file(repoId: number, path: string): FileDetail {
    const hit = this.repo(repoId);
    const score = hit?.scores.find((s) => s.path === path);
    if (!hit || !score) throw new Error('unknown file');
    return {
      repo: hit.data.repo,
      file: score,
      accounts: (hit.data.configDirs.get(path) ?? []).map((d) => ({ ...d, name: accountName(d.dir) })),
      sessions: this.sessionsFor(score),
      config: this.scoring,
    };
  }

  scores(repoId: number, account?: string): ScoresResponse {
    const hit = this.repo(repoId);
    if (!hit) throw new Error('unknown project');
    const scores = this.filtered(hit, account);
    const keep = new Set(scores.map((s) => s.path));
    const data = account ? { ...hit.data, files: hit.data.files.filter((f) => keep.has(f.path)) } : hit.data;
    const never = scores.filter((s) => s.neverUnderstood).sort((a, b) => b.stats.linesChanged - a.stats.linesChanged);
    const stepDays = trendStepDays(data);
    return {
      summary: summarize(scores, this.scoring),
      trend: trend(data, Date.now(), stepDays === 1 ? 28 : 12, stepDays, this.scoring),
      trendStepDays: stepDays,
      neverUnderstood: never.map((s) => ({ path: s.path, score: s.score, lines: s.stats.linesChanged, edits: s.stats.edits, lastEdit: s.stats.lastEdit, unattendedShare: s.stats.unattendedShare })),
      config: this.scoring,
    };
  }

  /** The score of a file on disk, if Claude edited it. The deepest repo containing it wins. */
  scoreForPath(absPath: string): PathScore | null {
    let best: { id: number; name: string; path: string } | null = null;
    for (const r of this.repos()) {
      if ((absPath === r.path || absPath.startsWith(r.path + sep)) && (!best || r.path.length > best.path.length)) best = r;
    }
    if (!best) return null;
    const rel = relative(best.path, absPath).split(sep).join('/');
    const s = this.repo(best.id)?.scores.find((x) => x.path === rel);
    return s ? { repoId: best.id, repo: best.name, path: s.path, score: s.score, bucket: s.bucket } : null;
  }

  /** Every scored file by absolute path, for explorer badges. */
  allScores(): Map<string, PathScore> {
    const out = new Map<string, PathScore>();
    for (const r of this.repos()) {
      for (const s of this.repo(r.id)?.scores ?? []) out.set([r.path, ...s.path.split('/')].join(sep), { repoId: r.id, repo: r.name, path: s.path, score: s.score, bucket: s.bucket });
    }
    return out;
  }

  today(): TodaySummary & { quizEnabled: boolean } {
    return { ...todaySummary(this.o.db, this.o.config), quizEnabled: this.o.quizEnabled };
  }

  quiz(): QuizView | null {
    return quizFor(this.o.db, localDay());
  }

  makeQuiz(): Promise<QuizView | null> {
    if (!this.o.quizEnabled) throw new Error('The explain-back quiz is off. Turn it on in Settings (Claude Grasp › Quiz: Enabled).');
    return this.exclusive(() => ensureQuiz(this.o.db, this.o.model, this.o.config));
  }

  answer(id: number, answer: string) {
    if (typeof answer !== 'string') throw new Error('answer must be a string');
    return this.exclusive(async () => {
      const r = await answerQuestion(this.o.db, this.o.model, id, answer);
      this.invalidate();
      return r;
    });
  }

  skip(id: number) {
    return this.exclusive(() => skipQuestion(this.o.db, id));
  }

  /** Reads new transcript lines and commits. Concurrent calls share one run. */
  ingest(): Promise<IngestStats> {
    this.ingesting ??= this.exclusive(() => ingest(this.o.db, this.o.roots())).finally(() => {
      this.ingesting = null;
      this.invalidate();
    });
    return this.ingesting;
  }

  private sessionsFor(s: FileScore): SessionRow[] {
    if (!s.stats.sessions.length) return [];
    return this.o.db
      .prepare(
        `SELECT s.id, s.title, s.entrypoint, s.started_at, s.ended_at, s.headless, p.root,
                (SELECT COUNT(*) FROM edits e WHERE e.session_id = s.id AND e.repo_id = ? AND e.rel_path = ?) AS edits
         FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id IN (${s.stats.sessions.map(() => '?').join(',')})
         ORDER BY s.started_at DESC`,
      )
      .all(s.repoId, s.path, ...s.stats.sessions) as unknown as SessionRow[];
  }

  /**
   * The webview's only way in. Method names are a fixed list, and every argument is checked,
   * so a message can't call anything else.
   */
  async rpc(method: string, params: unknown[]): Promise<unknown> {
    const num = (v: unknown) => {
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error('expected an id');
      return v;
    };
    const str = (v: unknown) => {
      if (typeof v !== 'string') throw new Error('expected a string');
      return v;
    };
    const opt = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : str(v));
    const [a, b] = params;
    switch (method) {
      case 'projects': return this.projects(opt(a));
      case 'files': return this.files(num(a), opt(b));
      case 'file': return this.file(num(a), str(b));
      case 'scores': return this.scores(num(a), opt(b));
      case 'today': return this.today();
      case 'quiz': return this.quiz();
      case 'makeQuiz': return this.makeQuiz();
      case 'answer': return this.answer(num(a), str(b));
      case 'skip': return this.skip(num(a));
      case 'ingest': return this.ingest();
      default: throw new Error(`unknown method ${method}`);
    }
  }
}
