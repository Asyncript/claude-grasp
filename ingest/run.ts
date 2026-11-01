import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, relative, sep } from 'node:path';
import { llmWorkdir, projectDirName } from '../shared/paths';
import { transaction, type DB } from '../db';
import { RepoResolver } from '../git/repo';
import { scanRepo, type RepoRow } from '../git/scan';
import { discoverTranscripts, type TranscriptFile } from '../parser/discover';
import { headHash, readLines } from '../parser/jsonl-stream';
import { PARSER_VERSION, SessionParser, type ParseOutput, type ParserState, type SessionMeta } from '../parser/session';

export interface IngestStats {
  transcripts: number;
  parsed: number;
  unchanged: number;
  /** Headless (claude -p) transcripts. Only their edits are kept, marked unattended. */
  headless: number;
  /** Transcripts of Claude Grasp's own claude -p calls, always skipped. */
  own: number;
  prompts: number;
  edits: number;
  unattendedEdits: number;
  editsOutsideRepo: number;
  bulkBashSkipped: number;
  plans: number;
  refs: number;
  badLines: number;
  repos: number;
  commits: number;
  errors: string[];
  /** Another VS Code window was ingesting, so this run read nothing. */
  busy: boolean;
  /** Whether this run stored anything a score depends on. */
  changed: boolean;
}

interface TranscriptRow {
  byte_offset: number;
  size: number;
  mtime_ms: number;
  head_hash: string | null;
  state: string | null;
  skipped: string | null;
  parser_version: number;
}

/** Batch size for writing events while streaming a large transcript. */
const FLUSH_EVERY = 5000;
/** How long an ingest may go without renewing its lease before another window may take over. */
const LEASE_MS = 5 * 60_000;

/** Takes the ingest lease unless another window holds a live one. */
function acquireLease(db: DB, owner: string, now = Date.now()): boolean {
  try {
    return transaction(db, () => {
      const row = db.prepare('SELECT owner, expires_at FROM ingest_lease WHERE id = 1').get() as { owner: string; expires_at: number } | undefined;
      if (row && row.owner !== owner && row.expires_at > now) return false;
      db.prepare('INSERT INTO ingest_lease (id, owner, expires_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at').run(
        owner,
        now + LEASE_MS,
      );
      return true;
    });
  } catch {
    // SQLITE_BUSY: another window has held the write lock for longer than busy_timeout.
    return false;
  }
}

/**
 * Reads every transcript under `roots`, storing only what changed since the last run,
 * then scans git history for every repo Claude edited. Never writes outside `db`.
 * Every VS Code window shares the database; only one of them ingests at a time.
 */
export async function ingest(db: DB, roots: string[]): Promise<IngestStats> {
  const stats: IngestStats = {
    transcripts: 0, parsed: 0, unchanged: 0, headless: 0, own: 0, prompts: 0, edits: 0, unattendedEdits: 0, editsOutsideRepo: 0, bulkBashSkipped: 0,
    plans: 0, refs: 0, badLines: 0, repos: 0, commits: 0, errors: [], busy: false, changed: false,
  };
  const owner = randomUUID();
  if (!acquireLease(db, owner)) return { ...stats, busy: true };
  try {
    await ingestAll(db, roots, stats, owner);
    stats.changed ||= stats.parsed > 0 || stats.commits > 0;
  } finally {
    db.prepare('DELETE FROM ingest_lease WHERE owner = ?').run(owner);
  }
  return stats;
}

/**
 * Marks every transcript for a full re-read and every repo for a full git scan; the next ingest
 * does the work. Rows from transcripts Claude Code has since deleted are kept, so their history
 * still counts.
 */
export function markForRebuild(db: DB): void {
  transaction(db, () => {
    db.prepare('UPDATE transcripts SET parser_version = 0').run();
    db.prepare('UPDATE repos SET last_head = NULL, ignore_checked = NULL').run();
  });
}

async function ingestAll(db: DB, roots: string[], stats: IngestStats, owner: string) {
  const store = new Store(db, new RepoResolver(roots), stats, owner);
  const ownDir = projectDirName(llmWorkdir());
  for (const file of discoverTranscripts(roots)) {
    if (file.projectDir === ownDir) {
      stats.transcripts++;
      stats.own++;
      continue;
    }
    await ingestTranscript(db, store, file, stats);
  }

  // A project maps to the repo its sessions edited most; cwd drifts too much to rely on.
  db.exec(`
    UPDATE projects SET repo_id = (
      SELECT e.repo_id FROM edits e JOIN sessions s ON s.id = e.session_id
      WHERE s.project_id = projects.id GROUP BY e.repo_id ORDER BY COUNT(*) DESC LIMIT 1
    )`);

  const repos = db.prepare('SELECT id, path, last_head, user_email, ignore_checked FROM repos').all() as unknown as RepoRow[];
  stats.repos = repos.length;
  for (const repo of repos) {
    try {
      const r = await scanRepo(db, repo);
      stats.commits += r.commits;
      stats.changed ||= r.changed;
    } catch (e) {
      stats.errors.push(`git ${repo.path}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
}

async function ingestTranscript(db: DB, store: Store, f: TranscriptFile, stats: IngestStats) {
  stats.transcripts++;
  let size: number;
  let mtime: number;
  try {
    const st = statSync(f.path);
    size = st.size;
    mtime = Math.floor(st.mtimeMs);
  } catch {
    return;
  }

  const readRow = () =>
    db.prepare('SELECT byte_offset, size, mtime_ms, head_hash, state, skipped, parser_version FROM transcripts WHERE path = ?').get(f.path) as TranscriptRow | undefined;
  const isUnchanged = (r: TranscriptRow | undefined): r is TranscriptRow => !!r && r.size === size && r.mtime_ms === mtime && r.parser_version === PARSER_VERSION;
  const countUnchanged = (r: TranscriptRow) => (r.skipped === 'grasp' ? stats.own++ : stats.unchanged++);
  // Checked once without a lock, so the common case (nothing new) never waits for one.
  const before = readRow();
  if (isUnchanged(before)) {
    countUnchanged(before);
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    // Read again under the write lock: another window may have just stored this file.
    const row = readRow();
    if (isUnchanged(row)) {
      countUnchanged(row);
      db.exec('COMMIT');
      return;
    }
    store.renewLease();
    await parseTranscript(db, store, f, stats, row, size, mtime);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    stats.errors.push(`${f.path}: ${(e as Error).message}`);
  }
}

/** Stores what a transcript added since `row` (or all of it). Runs inside the caller's transaction. */
async function parseTranscript(db: DB, store: Store, f: TranscriptFile, stats: IngestStats, row: TranscriptRow | undefined, size: number, mtime: number) {
  const parent = f.kind === 'subagent' ? parentSession(db, f.sessionId) : null;
  if (row?.skipped === 'grasp' || parent?.own) {
    saveTranscript(db, f, { byte_offset: size, size, mtime_ms: mtime, head_hash: row?.head_hash ?? null, state: null, skipped: 'grasp', parser_version: PARSER_VERSION }, 0);
    stats.own++;
    return;
  }

  const head = await headHash(f.path);
  // A new first line means the file was rewritten; an older parser means its rows may be wrong. Either way, start over.
  const resume = !!row?.state && row.head_hash === head && size >= row.byte_offset && row.parser_version === PARSER_VERSION;
  const parser = new SessionParser({ sidechain: f.kind === 'subagent' }, resume ? (JSON.parse(row!.state!) as ParserState) : undefined);
  const badBefore = parser.state.bad;
  const bulkBefore = parser.state.bulkBash ?? 0;
  let offset = resume ? row!.byte_offset : 0;
  const workdir = llmWorkdir();
  const isOwn = () => !!parser.state.meta.cwd && (parser.state.meta.cwd === workdir || parser.state.meta.cwd.startsWith(workdir + sep));
  // Nobody watched a headless run, so all it can contribute is edits that count against the file.
  const unattended = () => (f.kind === 'main' ? parser.state.meta.entrypoint === 'sdk-cli' : !!parent?.headless);

  if (row && !resume) store.deleteSource(f.path);
  const projectId = store.projectId(f.root, f.projectDir);
  let n = 0;
  let own = false;
  for await (const line of readLines(f.path, offset)) {
    parser.feedLine(line.text);
    offset = line.end;
    if (f.kind === 'main' && isOwn()) {
      own = true;
      break;
    }
    if (++n % FLUSH_EVERY === 0) store.write(f, parser.drain(), unattended());
  }

  if (own) {
    store.deleteSource(f.path);
    saveTranscript(db, f, { byte_offset: size, size, mtime_ms: mtime, head_hash: head, state: null, skipped: 'grasp', parser_version: PARSER_VERSION }, 0);
    stats.own++;
    return;
  }
  store.write(f, parser.drain(), unattended());
  if (f.kind === 'main') store.upsertSession(f.sessionId, projectId, parser.state.meta, unattended());
  saveTranscript(db, f, { byte_offset: offset, size, mtime_ms: mtime, head_hash: head, state: JSON.stringify(parser.state), skipped: null, parser_version: PARSER_VERSION }, parser.state.bad);
  stats.badLines += parser.state.bad - badBefore;
  stats.bulkBashSkipped += (parser.state.bulkBash ?? 0) - bulkBefore;
  stats.parsed++;
  if (unattended()) stats.headless++;
}

/** Main transcripts are ingested first, so a subagent can look up what its parent was. */
function parentSession(db: DB, sessionId: string): { own: boolean; headless: boolean } {
  const t = db.prepare("SELECT skipped FROM transcripts WHERE session_id = ? AND kind = 'main'").get(sessionId) as { skipped: string | null } | undefined;
  const s = db.prepare('SELECT headless FROM sessions WHERE id = ?').get(sessionId) as { headless: number } | undefined;
  return { own: t?.skipped === 'grasp', headless: s?.headless === 1 };
}

function saveTranscript(db: DB, f: TranscriptFile, r: TranscriptRow, bad: number) {
  db.prepare(
    `INSERT INTO transcripts (path, session_id, kind, byte_offset, size, mtime_ms, head_hash, state, skipped, bad_lines, parsed_at, parser_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (path) DO UPDATE SET byte_offset = excluded.byte_offset, size = excluded.size, mtime_ms = excluded.mtime_ms,
       head_hash = excluded.head_hash, state = excluded.state, skipped = excluded.skipped, bad_lines = excluded.bad_lines,
       parsed_at = excluded.parsed_at, parser_version = excluded.parser_version`,
  ).run(f.path, f.sessionId, f.kind, r.byte_offset, r.size, r.mtime_ms, r.head_hash, r.state, r.skipped, bad, new Date().toISOString(), r.parser_version);
}

/** Writes parser output, resolving absolute file paths to (repo, relative path). */
class Store {
  private repoIds = new Map<string, number>();
  private projectIds = new Map<string, number>();
  private stmts;

  constructor(private db: DB, private resolver: RepoResolver, private stats: IngestStats, private owner: string) {
    // OR IGNORE: the unique keys turn a row stored twice (two windows, an overlapping resume) into a no-op.
    this.stmts = {
      prompt: db.prepare(
        `INSERT OR IGNORE INTO prompts (source, session_id, uuid, turn_id, ts, kind, words, pasted_words, is_bare, is_question, is_correction, excerpt, mentions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      edit: db.prepare(
        `INSERT OR IGNORE INTO edits (source, session_id, tool_use_id, turn_id, ts, tool, repo_id, rel_path, added, removed, created, approval, permission_mode, sidechain, symbols, unattended)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      plan: db.prepare('INSERT OR IGNORE INTO plans (source, session_id, tool_use_id, turn_id, ts, outcome, plan_edited) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      ref: db.prepare('INSERT OR IGNORE INTO file_refs (source, session_id, turn_id, ts, repo_id, rel_path, kind) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      lease: db.prepare('UPDATE ingest_lease SET expires_at = ? WHERE owner = ?'),
      parentTurn: db.prepare(
        "SELECT uuid FROM prompts WHERE session_id = ? AND kind = 'human' AND ts <= ? ORDER BY ts DESC LIMIT 1",
      ),
    };
  }

  /** For an unattended (headless) transcript only edits are kept: its "prompts" were written by a program. */
  write(f: TranscriptFile, out: ParseOutput, unattended = false) {
    const s = this.stmts;
    if (unattended) out = { prompts: [], edits: out.edits, plans: [], refs: [] };
    for (const p of out.prompts) {
      const r = s.prompt.run(f.path, f.sessionId, p.uuid, p.turnId, p.ts, p.kind, p.words, p.pastedWords, +p.isBare, +p.isQuestion, +p.isCorrection, p.excerpt, JSON.stringify(p.mentions));
      this.stats.prompts += Number(r.changes);
    }

    for (const e of out.edits) {
      const loc = this.locate(e.filePath);
      if (!loc) {
        this.stats.editsOutsideRepo++;
        continue;
      }
      // Subagent transcripts have no human prompts; their edits belong to the parent's turn at that time.
      const turnId = e.turnId ?? (f.kind === 'subagent' ? this.parentTurn(f.sessionId, e.ts) : null);
      const r = s.edit.run(f.path, f.sessionId, e.toolUseId, unattended ? null : turnId, e.ts, e.tool, loc.repoId, loc.rel, e.added, e.removed, +e.created, e.approval, e.permissionMode, +e.sidechain, JSON.stringify(e.symbols), +unattended);
      if (!r.changes) continue;
      this.stats.edits++;
      if (unattended) this.stats.unattendedEdits++;
    }

    for (const p of out.plans) this.stats.plans += Number(s.plan.run(f.path, f.sessionId, p.toolUseId, p.turnId, p.ts, p.outcome, +p.planEdited).changes);

    for (const r of out.refs) {
      const loc = this.locate(r.filePath);
      if (!loc) continue;
      this.stats.refs += Number(s.ref.run(f.path, f.sessionId, r.turnId, r.ts, loc.repoId, loc.rel, r.kind).changes);
    }
  }

  /** Keeps this run's lease alive; called once per transcript it stores. */
  renewLease() {
    this.stmts.lease.run(Date.now() + LEASE_MS, this.owner);
  }

  deleteSource(path: string) {
    for (const table of ['prompts', 'edits', 'plans', 'file_refs']) this.db.prepare(`DELETE FROM ${table} WHERE source = ?`).run(path);
  }

  projectId(root: string, dirName: string): number {
    const key = `${root}\0${dirName}`;
    let id = this.projectIds.get(key);
    if (id === undefined) {
      this.db.prepare('INSERT OR IGNORE INTO projects (root, dir_name) VALUES (?, ?)').run(root, dirName);
      id = (this.db.prepare('SELECT id FROM projects WHERE root = ? AND dir_name = ?').get(root, dirName) as { id: number }).id;
      this.projectIds.set(key, id);
    }
    return id;
  }

  upsertSession(id: string, projectId: number, m: SessionMeta, headless: boolean) {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, entrypoint, cwd, title, git_branch, version, started_at, ended_at, headless)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET entrypoint = excluded.entrypoint, cwd = excluded.cwd, title = excluded.title,
           git_branch = excluded.git_branch, version = excluded.version, started_at = excluded.started_at,
           ended_at = excluded.ended_at, headless = excluded.headless`,
      )
      .run(id, projectId, m.entrypoint ?? null, m.cwd ?? null, m.title ?? null, m.gitBranch ?? null, m.version ?? null, m.startedAt ?? null, m.endedAt ?? null, +headless);
  }

  private parentTurn(sessionId: string, ts: string): string | null {
    return (this.stmts.parentTurn.get(sessionId, ts) as { uuid: string } | undefined)?.uuid ?? null;
  }

  private locate(file: string): { repoId: number; rel: string } | null {
    const repo = this.resolver.repoOf(file);
    if (!repo) return null;
    let id = this.repoIds.get(repo);
    if (id === undefined) {
      this.db.prepare('INSERT OR IGNORE INTO repos (path, name) VALUES (?, ?)').run(repo, basename(repo));
      id = (this.db.prepare('SELECT id FROM repos WHERE path = ?').get(repo) as { id: number }).id;
      this.repoIds.set(repo, id);
    }
    return { repoId: id, rel: relative(repo, file).split(sep).join('/') };
  }
}
