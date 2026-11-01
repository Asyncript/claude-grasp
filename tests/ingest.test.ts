import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../db';
import { prepareDemo, type DemoData } from '../demo/prepare';
import { SESSION_IDS } from '../fixtures/repo';
import { ingest } from '../ingest/run';
import { llmWorkdir, projectDirName } from '../shared/paths';

let db: DB;
let demo: DemoData;
const count = (sql: string, ...args: SQLInputValue[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const sessionFile = (id: string) => join(demo.roots[0]!, 'projects', '-demo-shop-api', `${id}.jsonl`);

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'claude-grasp-ingest-'));
  demo = prepareDemo(join(home, 'demo'));
  db = openDb(join(home, 'claude-grasp.db'));
});

describe('ingest on fixtures', () => {
  it('stores the expected events', async () => {
    const s = await ingest(db, demo.roots);
    expect(s.errors).toEqual([]);
    expect(s.badLines).toBe(2);
    expect(count("SELECT COUNT(*) n FROM prompts WHERE kind = 'human'")).toBe(12);
    expect(count("SELECT COUNT(*) n FROM prompts WHERE kind = 'human' AND is_bare = 1")).toBe(5);
    expect(count("SELECT COUNT(*) n FROM prompts WHERE kind IN ('interrupt', 'rejection', 'answer')")).toBe(3);
    expect(count('SELECT COUNT(*) n FROM plans WHERE plan_edited = 1')).toBe(1);
    expect(count("SELECT COUNT(*) n FROM edits WHERE rel_path LIKE '/%' OR rel_path LIKE '..%'")).toBe(0);

    const refs = db.prepare('SELECT kind, rel_path FROM file_refs ORDER BY kind').all();
    expect(refs).toEqual([
      { kind: 'external_edit', rel_path: 'src/orders/checkout.ts' },
      { kind: 'ide_open', rel_path: 'src/orders/checkout.ts' },
      { kind: 'rejected_edit', rel_path: 'src/orders/checkout.ts' },
    ]);
  });

  it('keeps only the edits of headless sessions, marked unattended', async () => {
    const s = await ingest(db, demo.roots);
    expect([s.headless, s.unattendedEdits]).toEqual([2, 2]);
    expect(db.prepare('SELECT headless FROM sessions WHERE id = ?').get(SESSION_IDS.headless)).toEqual({ headless: 1 });
    expect(db.prepare('SELECT rel_path, unattended, turn_id FROM edits WHERE session_id = ? ORDER BY rel_path').all(SESSION_IDS.headless)).toEqual([
      { rel_path: 'src/db/migrations.ts', unattended: 1, turn_id: null },
      { rel_path: 'src/reports/daily.ts', unattended: 1, turn_id: null },
    ]);
    expect(count('SELECT COUNT(*) n FROM edits WHERE unattended = 1 AND session_id != ?', SESSION_IDS.headless)).toBe(0);
    for (const id of [SESSION_IDS.headless, SESSION_IDS.readonly]) {
      expect(count('SELECT COUNT(*) n FROM prompts WHERE session_id = ?', id)).toBe(0);
      expect(count('SELECT COUNT(*) n FROM file_refs WHERE session_id = ?', id)).toBe(0);
    }
    expect(count('SELECT COUNT(*) n FROM edits WHERE session_id = ?', SESSION_IDS.readonly)).toBe(0);
  });

  it('maps the project to the fixture repo', async () => {
    await ingest(db, demo.roots);
    expect(db.prepare('SELECT r.path FROM projects p JOIN repos r ON r.id = p.repo_id').all()).toEqual([{ path: demo.repoPath }]);
  });

  it('attributes subagent edits to the parent session turn', async () => {
    await ingest(db, demo.roots);
    const e = db.prepare("SELECT session_id, turn_id, sidechain FROM edits WHERE rel_path = 'src/db/migrations.ts' AND unattended = 0").get() as Record<string, unknown>;
    const continuePrompt = db.prepare("SELECT uuid FROM prompts WHERE session_id = ? AND excerpt = 'continue'").get(SESSION_IDS.pricing) as { uuid: string };
    expect(e).toEqual({ session_id: SESSION_IDS.pricing, turn_id: continuePrompt.uuid, sidechain: 1 });
  });

  it('only processes appended lines on re-run', async () => {
    await ingest(db, demo.roots);
    const file = sessionFile(SESSION_IDS.today);
    const tail = JSON.parse(readFileSync(file, 'utf8').trimEnd().split('\n').at(-2)!);
    appendFileSync(
      file,
      [
        { ...tail, type: 'user', uuid: 'new-prompt', timestamp: '2026-10-30T12:00:00.000Z', message: { role: 'user', content: 'why is shipping free above 50?' } },
        '{"type":"user","message":{"content":"half-written',
      ].map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'),
    );
    const s = await ingest(db, demo.roots);
    expect([s.parsed, s.unchanged, s.prompts, s.edits]).toEqual([1, 6, 1, 0]);
    expect(db.prepare("SELECT is_question FROM prompts WHERE uuid = 'new-prompt'").get()).toEqual({ is_question: 1 });

    // Finishing the half-written line is picked up next time without re-reading the rest.
    appendFileSync(file, '"}}\n');
    const s2 = await ingest(db, demo.roots);
    expect([s2.parsed, s2.prompts]).toEqual([1, 1]);
  });

  it('replaces a rewritten transcript instead of duplicating it', async () => {
    await ingest(db, demo.roots);
    const before = count('SELECT COUNT(*) n FROM edits');
    const file = sessionFile(SESSION_IDS.plan);
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    writeFileSync(file, `${JSON.stringify({ type: 'summary', summary: 'rewritten' })}\n${lines.join('\n')}\n`);
    await ingest(db, demo.roots);
    expect(count('SELECT COUNT(*) n FROM edits')).toBe(before);
    expect(count('SELECT COUNT(*) n FROM prompts WHERE session_id = ?', SESSION_IDS.plan)).toBe(3);
  });
});

describe("Claude Grasp's own claude -p sessions", () => {
  const saved = process.env.CLAUDE_GRASP_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_GRASP_HOME;
    else process.env.CLAUDE_GRASP_HOME = saved;
  });

  it('are never ingested, from any config dir, by folder name or by cwd', async () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-grasp-own-'));
    process.env.CLAUDE_GRASP_HOME = join(home, '.claude-grasp');
    const workdir = llmWorkdir();
    const repoFile = join(demo.repoPath, 'src/orders/checkout.ts');
    const session = (id: string, cwd: string) =>
      [
        { type: 'user', uuid: `${id}-1`, sessionId: id, cwd, entrypoint: 'sdk-cli', timestamp: '2026-10-30T09:00:00.000Z', message: { role: 'user', content: `Write three questions about ${repoFile}` } },
        { type: 'assistant', uuid: `${id}-2`, timestamp: '2026-10-30T09:00:01.000Z', message: { content: [{ type: 'tool_use', id: `${id}-t`, name: 'Write', input: { file_path: repoFile, content: 'x' } }] } },
        { type: 'user', uuid: `${id}-3`, timestamp: '2026-10-30T09:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-t`, content: 'ok' }] }, toolUseResult: { type: 'create', filePath: repoFile, content: 'x' } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n';

    // A second, non-default config dir, as if explain-back ran under another account.
    const root = join(home, '.claude-work');
    const byName = join(root, 'projects', projectDirName(workdir));
    const byCwd = join(root, 'projects', 'renamed-folder');
    mkdirSync(join(byName, 's1', 'subagents'), { recursive: true });
    mkdirSync(join(byCwd, 's2', 'subagents'), { recursive: true });
    writeFileSync(join(byName, 's1.jsonl'), session('s1', workdir));
    writeFileSync(join(byName, 's1', 'subagents', 'agent-1.jsonl'), session('s1', workdir));
    writeFileSync(join(byCwd, 's2.jsonl'), session('s2', join(workdir, 'sub')));
    writeFileSync(join(byCwd, 's2', 'subagents', 'agent-2.jsonl'), session('s2', join(workdir, 'sub')));

    const s = await ingest(db, [...demo.roots, root]);
    expect([s.own, s.errors, s.edits]).toEqual([4, [], 13]);
    expect(count("SELECT COUNT(*) n FROM edits WHERE session_id IN ('s1', 's2')")).toBe(0);
    expect(count("SELECT COUNT(*) n FROM prompts WHERE session_id IN ('s1', 's2')")).toBe(0);
    expect(count("SELECT COUNT(*) n FROM sessions WHERE id IN ('s1', 's2')")).toBe(0);

    // Still skipped after the files grow.
    appendFileSync(join(byCwd, 's2.jsonl'), session('s2', join(workdir, 'sub')));
    const again = await ingest(db, [...demo.roots, root]);
    expect(again.own).toBe(4);
    expect(count("SELECT COUNT(*) n FROM edits WHERE session_id IN ('s1', 's2')")).toBe(0);
  });
});
