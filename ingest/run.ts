import { statSync } from 'node:fs';
import { basename, relative, sep } from 'node:path';
import { llmWorkdir, projectDirName } from '../shared/paths';
import type { DB } from '../db';
import { RepoResolver } from '../git/repo';
import { scanRepo, type RepoRow } from '../git/scan';
import { discoverTranscripts, type TranscriptFile } from '../parser/discover';
import { headHash, readLines } from '../parser/jsonl-stream';
import { SessionParser, type ParseOutput, type ParserState, type SessionMeta } from '../parser/session';

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
}

interface TranscriptRow {
  byte_offset: number;
  size: number;
  mtime_ms: number;
  head_hash: string | null;
  state: string | null;
  skipped: string | null;
}

/** Batch size for writing events while streaming a large transcript. */
const FLUSH_EVERY = 5000;

/**
 * Reads every transcript under `roots`, storing only what changed since the last run,
 * then scans git history for every repo Claude edited. Never writes outside `db`.
 */
export async function ingest(db: DB, roots: string[]): Promise<IngestStats> {
  const stats: IngestStats = {
    transcripts: 0, parsed: 0, unchanged: 0, headless: 0, own: 0, prompts: 0, edits: 0, unattendedEdits: 0, editsOutsideRepo: 0, bulkBashSkipped: 0,
    plans: 0, refs: 0, badLines: 0, repos: 0, commits: 0, errors: [],
  };
  const store = new Store(db, new RepoResolver(roots), stats);
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

  const repos = db.prepare('SELECT id, path, last_head FROM repos').all() as unknown as RepoRow[];
  stats.repos = repos.length;
  for (const repo of repos) {
    try {
      stats.commits += scanRepo(db, repo);
    } catch (e) {
      stats.errors.push(`git ${repo.path}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return stats;
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

  const row = db.prepare('SELECT byte_offset, size, mtime_ms, head_hash, state, skipped FROM transcripts WHERE path = ?').get(f.path) as
    | TranscriptRow
    | undefined;
  if (row && row.size === size && row.mtime_ms === mtime) {
    if (row.skipped === 'grasp') stats.own++;
    else stats.unchanged++;
    return;
  }
  const parent = f.kind === 'subagent' ? parentSession(db, f.sessionId) : null;
  if (row?.skipped === 'grasp' || parent?.own) {
    saveTranscript(db, f, { byte_offset: size, size, mtime_ms: mtime, head_hash: row?.head_hash ?? null, state: null, skipped: 'grasp' }, 0);
    stats.own++;
    return;
  }

  const head = await headHash(f.path);
  const resume = !!row?.state && row.head_hash === head && size >= row.byte_offset;
  const parser = new SessionParser({ sidechain: f.kind === 'subagent' }, resume ? (JSON.parse(row!.state!) as ParserState) : undefined);
  const badBefore = parser.state.bad;
  const bulkBefore = parser.state.bulkBash ?? 0;
  let offset = resume ? row!.byte_offset : 0;
  const workdir = llmWorkdir();
  const isOwn = () => !!parser.state.meta.cwd && (parser.state.meta.cwd === workdir || parser.state.meta.cwd.startsWith(workdir + sep));
  // Nobody watched a headless run, so all it can contribute is edits that count against the file.
  const unattended = () => (f.kind === 'main' ? parser.state.meta.entrypoint === 'sdk-cli' : !!parent?.headless);

  db.exec('BEGIN');
  try {
    // A file that shrank or got a new first line was rewritten: replace everything it produced.
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
      saveTranscript(db, f, { byte_offset: size, size, mtime_ms: mtime, head_hash: head, state: null, skipped: 'grasp' }, 0);
      stats.own++;
    } else {
      store.write(f, parser.drain(), unattended());
      if (f.kind === 'main') store.upsertSession(f.sessionId, projectId, parser.state.meta, unattended());
      saveTranscript(db, f, { byte_offset: offset, size, mtime_ms: mtime, head_hash: head, state: JSON.stringify(parser.state), skipped: null }, parser.state.bad);
      stats.badLines += parser.state.bad - badBefore;
      stats.bulkBashSkipped += (parser.state.bulkBash ?? 0) - bulkBefore;
      stats.parsed++;
      if (unattended()) stats.headless++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    stats.errors.push(`${f.path}: ${(e as Error).message}`);
  }
}

/** Main transcripts are ingested first, so a subagent can look up what its parent was. */
function parentSession(db: DB, sessionId: string): { own: boolean; headless: boolean } {
  const t = db.prepare("SELECT skipped FROM transcripts WHERE session_id = ? AND kind = 'main'").get(sessionId) as { skipped: string | null } | undefined;
  const s = db.prepare('SELECT headless FROM sessions WHERE id = ?').get(sessionId) as { headless: number } | undefined;
  return { own: t?.skipped === 'grasp', headless: s?.headless === 1 };
}

function saveTranscript(db: DB, f: TranscriptFile, r: TranscriptRow, bad: number) {
  db.prepare(
    `INSERT INTO transcripts (path, session_id, kind, byte_offset, size, mtime_ms, head_hash, state, skipped, bad_lines, parsed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (path) DO UPDATE SET byte_offset = excluded.byte_offset, size = excluded.size, mtime_ms = excluded.mtime_ms,
       head_hash = excluded.head_hash, state = excluded.state, skipped = excluded.skipped, bad_lines = excluded.bad_lines,
       parsed_at = excluded.parsed_at`,
  ).run(f.path, f.sessionId, f.kind, r.byte_offset, r.size, r.mtime_ms, r.head_hash, r.state, r.skipped, bad, new Date().toISOString());
}

/** Writes parser output, resolving absolute file paths to (repo, relative path). */
class Store {
  private repoIds = new Map<string, number>();
  private projectIds = new Map<string, number>();
  private stmts;

  constructor(private db: DB, private resolver: RepoResolver, private stats: IngestStats) {
    this.stmts = {
      prompt: db.prepare(
        `INSERT INTO prompts (source, session_id, uuid, turn_id, ts, kind, words, pasted_words, is_bare, is_question, is_correction, excerpt, mentions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      edit: db.prepare(
        `INSERT INTO edits (source, session_id, tool_use_id, turn_id, ts, tool, repo_id, rel_path, added, removed, created, approval, permission_mode, sidechain, symbols, unattended)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      plan: db.prepare('INSERT INTO plans (source, session_id, tool_use_id, turn_id, ts, outcome, plan_edited) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      ref: db.prepare('INSERT INTO file_refs (source, session_id, turn_id, ts, repo_id, rel_path, kind) VALUES (?, ?, ?, ?, ?, ?, ?)'),
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
      s.prompt.run(f.path, f.sessionId, p.uuid, p.turnId, p.ts, p.kind, p.words, p.pastedWords, +p.isBare, +p.isQuestion, +p.isCorrection, p.excerpt, JSON.stringify(p.mentions));
    }
    this.stats.prompts += out.prompts.length;

    for (const e of out.edits) {
      const loc = this.locate(e.filePath);
      if (!loc) {
        this.stats.editsOutsideRepo++;
        continue;
      }
      // Subagent transcripts have no human prompts; their edits belong to the parent's turn at that time.
      const turnId = e.turnId ?? (f.kind === 'subagent' ? this.parentTurn(f.sessionId, e.ts) : null);
      s.edit.run(f.path, f.sessionId, e.toolUseId, unattended ? null : turnId, e.ts, e.tool, loc.repoId, loc.rel, e.added, e.removed, +e.created, e.approval, e.permissionMode, +e.sidechain, JSON.stringify(e.symbols), +unattended);
      this.stats.edits++;
      if (unattended) this.stats.unattendedEdits++;
    }

    for (const p of out.plans) s.plan.run(f.path, f.sessionId, p.toolUseId, p.turnId, p.ts, p.outcome, +p.planEdited);
    this.stats.plans += out.plans.length;

    for (const r of out.refs) {
      const loc = this.locate(r.filePath);
      if (!loc) continue;
      s.ref.run(f.path, f.sessionId, r.turnId, r.ts, loc.repoId, loc.rel, r.kind);
      this.stats.refs++;
    }
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
