// Generates the synthetic demo transcripts in fixtures/claude/. Run with `npm run fixtures`
// and commit the output. Line shapes mirror real Claude Code 2.1 transcripts; all content
// is invented. {{REPO}} is replaced with the demo repo path when demo mode materializes them.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from './files';
import { FIXTURE_ANCHOR, SESSION_IDS } from './repo';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'claude');
const PROJECT = join(ROOT, 'projects', '-demo-shop-api');
const REPO = '{{REPO}}';

const USER = { decision: 'accept', source: 'user_temporary' };
const CLASSIFIER = { decision: 'accept', source: 'config', reasonType: 'classifier' };
const MODE = { decision: 'accept', source: 'config', reasonType: 'mode' };

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`;
const toolId = () => `toolu_demo${(++counter).toString().padStart(6, '0')}`;
const src = (p: string) => `${REPO}/${p}`;

type Line = Record<string, unknown>;

class Transcript {
  private lines: (Line | string)[] = [];
  private parent: string | null = null;
  private now = FIXTURE_ANCHOR;

  constructor(
    readonly sessionId: string,
    readonly entrypoint: string,
    public permissionMode: string,
    readonly extra: Line = {},
  ) {}

  at(day: number, hms: string) {
    const [h = 0, m = 0] = hms.split(':').map(Number);
    this.now = FIXTURE_ANCHOR + day * 86_400_000 + (h * 60 + m) * 60_000;
    return this;
  }

  /** Continue from another transcript's clock (a subagent runs during its parent's Agent call). */
  after(other: Transcript) {
    this.now = other.now;
    return this;
  }

  private base(type: string): Line {
    const id = uuid();
    this.now += 7_000;
    const line: Line = {
      parentUuid: this.parent, isSidechain: false, userType: 'external', cwd: REPO, sessionId: this.sessionId,
      version: '2.1.300', gitBranch: 'main', entrypoint: this.entrypoint, ...this.extra, type, uuid: id,
      timestamp: new Date(this.now).toISOString(),
    };
    this.parent = id;
    return line;
  }

  user(text: string, extra: Line = {}) {
    this.lines.push({ ...this.base('user'), message: { role: 'user', content: text }, permissionMode: this.permissionMode, promptSource: 'typed', origin: { kind: 'human' }, ...extra });
    return this;
  }

  /** A user-typed line that isn't a prompt: slash-command echo, meta line, etc. */
  userRaw(content: unknown, extra: Line = {}) {
    this.lines.push({ ...this.base('user'), message: { role: 'user', content }, ...extra });
    return this;
  }

  say(text: string) {
    this.lines.push({ ...this.base('assistant'), requestId: `req_${counter}`, message: { id: `msg_${counter}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
    return this;
  }

  tool(name: string, input: Line): string {
    const id = toolId();
    this.lines.push({ ...this.base('assistant'), requestId: `req_${counter}`, message: { id: `msg_${counter}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } });
    return id;
  }

  result(id: string, toolUseResult: unknown, o: { content?: string; isError?: boolean; decision?: Line; denial?: string; feedback?: string } = {}) {
    this.lines.push({
      ...this.base('user'),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: o.content ?? 'Done', ...(o.isError ? { is_error: true } : {}) }] },
      toolUseResult,
      ...(o.decision ? { permissionDecision: o.decision } : {}),
      ...(o.denial ? { toolDenialKind: o.denial } : {}),
      ...(o.feedback ? { userFeedback: o.feedback } : {}),
    });
    return this;
  }

  attach(attachment: Line) {
    this.lines.push({ ...this.base('attachment'), attachment });
    return this;
  }

  /** A line written as-is: session-level records, unknown types, or deliberately broken JSON. */
  raw(line: Line | string) {
    this.lines.push(line);
    return this;
  }

  write(path: string, content: string, decision: Line) {
    const id = this.tool('Write', { file_path: src(path), content });
    return this.result(id, { type: 'create', filePath: src(path), content, structuredPatch: [], originalFile: null, userModified: false }, { content: `File created successfully at: ${src(path)}`, decision });
  }

  edit(path: string, before: string, after: string, decision?: Line) {
    const h = F.hunk(before, after);
    const oldString = h.lines.filter((l) => l[0] === '-').map((l) => l.slice(1)).join('\n');
    const newString = h.lines.filter((l) => l[0] === '+').map((l) => l.slice(1)).join('\n');
    const id = this.tool('Edit', { file_path: src(path), old_string: oldString, new_string: newString, replace_all: false });
    return this.result(
      id,
      { filePath: src(path), oldString, newString, originalFile: null, structuredPatch: [h], userModified: false, replaceAll: false },
      { content: `The file ${src(path)} has been updated successfully.`, decision },
    );
  }

  save(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, this.lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
}

function planSession() {
  const t = new Transcript(SESSION_IDS.plan, 'cli', 'default').at(-6, '10:00');
  t.user('I want login sessions for the shop API. Sessions should expire after 30 minutes of inactivity and survive a page refresh. Plan it first before writing code.');
  t.raw({ type: 'permission-mode', permissionMode: 'plan', sessionId: t.sessionId });
  t.permissionMode = 'plan';
  t.say('Plan: an in-memory session store in src/auth/session.ts with createSession/getSession, a TTL constant, and a refresh path later.');
  const plan = t.tool('ExitPlanMode', { plan: '1. Session store\n2. TTL\n3. Refresh', planFilePath: '/home/demo/.claude/plans/sessions.md' });
  t.result(plan, { plan: '1. Session store\n2. TTL (30 min)\n3. Refresh rotates id', isAgent: false, filePath: '/home/demo/.claude/plans/sessions.md', planWasEdited: true }, { content: 'User has approved your plan.', decision: USER });
  t.raw({ type: 'permission-mode', permissionMode: 'default', sessionId: t.sessionId });
  t.permissionMode = 'default';
  t.user('Store them in memory for now, we will move to Redis later. Keep the TTL as a constant in session.ts so it is easy to find.');
  t.write('src/auth/session.ts', F.SESSION_V1, USER);
  t.user('Why does getSession delete expired sessions instead of just returning null? And what happens if two requests refresh the same session at the same time?');
  t.say('Deleting keeps the map from growing. For refresh, add refreshSession that rotates the id; the second concurrent refresh gets null.');
  t.edit('src/auth/session.ts', F.SESSION_V1, F.SESSION_V2, USER);
  t.userRaw('<command-name>/cost</command-name>\n<command-message>cost</command-message>');
  t.userRaw('<local-command-stdout>Total cost: $0.42</local-command-stdout>');
  t.raw({ type: 'ai-title', aiTitle: 'Add login sessions', sessionId: t.sessionId });
  t.save(join(PROJECT, `${t.sessionId}.jsonl`));
}

function pricingSession() {
  const t = new Transcript(SESSION_IDS.pricing, 'claude-vscode', 'auto').at(-4, '15:00');
  t.user('add pricing with discount codes, tax by region and a checkout total');
  t.write('src/orders/pricing.ts', F.PRICING_V1, CLASSIFIER);
  t.user('ok');
  t.edit('src/orders/pricing.ts', F.PRICING_V1, F.PRICING_V2, CLASSIFIER);
  t.user('continue');
  t.write('src/orders/checkout.ts', F.CHECKOUT_V1, CLASSIFIER);
  const bash = t.tool('Bash', { command: "mkdir -p src/utils && cat > src/utils/format.ts <<'EOF'\n...\nEOF", description: 'Create money formatter' });
  t.result(bash, {
    stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: true,
    bashEditDiff: { files: [{ filePath: src('src/utils/format.ts'), hunks: [F.hunk('', F.FORMAT_V1)], created: true }], moreFiles: 0, changedFiles: [src('src/utils/format.ts')] },
  }, { content: '(Bash completed with no output)', decision: CLASSIFIER });
  const agent = t.tool('Agent', { description: 'Write order migrations', prompt: 'Create src/db/migrations.ts with orders tables.', subagent_type: 'general-purpose' });
  const sub = new Transcript(SESSION_IDS.pricing, 'claude-vscode', 'auto', { isSidechain: true, agentId: 'a7f3c2' }).after(t);
  sub.userRaw('Create src/db/migrations.ts with orders tables.');
  sub.write('src/db/migrations.ts', F.MIGRATIONS_V1, CLASSIFIER);
  sub.say('Created the migrations file.');
  sub.save(join(PROJECT, SESSION_IDS.pricing, 'subagents', 'agent-a7f3c2.jsonl'));
  t.after(sub).result(agent, { status: 'completed' }, { content: 'Created src/db/migrations.ts', decision: CLASSIFIER });
  t.raw({ type: 'queue-operation', operation: 'enqueue', sessionId: t.sessionId, timestamp: new Date(FIXTURE_ANCHOR - 4 * 86_400_000 + 16 * 3_600_000).toISOString(), content: 'go ahead' });
  t.user('go ahead', { isMeta: true });
  t.user('go ahead');
  t.say('All set.');
  t.raw({ type: 'ai-title', aiTitle: 'Pricing and checkout', sessionId: t.sessionId });
  t.save(join(PROJECT, `${t.sessionId}.jsonl`));
}

function fixSession() {
  const t = new Transcript(SESSION_IDS.fix, 'claude-vscode', 'acceptEdits').at(-2, '14:00');
  t.user(`<ide_opened_file>The user opened the file ${src('src/orders/checkout.ts')} in the IDE. This may or may not be related to the current task.</ide_opened_file>The checkout total is wrong: the discount gets applied twice. Don't call applyDiscount again on the bulk amount, use the discounted value instead.`);
  t.raw('{"type":"assistant","message":{"content":[{"type":"tool_use"'); // truncated mid-write
  t.raw({ type: 'brand-new-line-type', sessionId: t.sessionId, payload: { anything: true } });
  t.raw('[1, 2, 3]');
  t.raw({ type: 'user', sessionId: t.sessionId, message: 42 });
  const failed = t.tool('Edit', { file_path: src('src/orders/checkout.ts'), old_string: 'x', new_string: 'y' });
  t.result(failed, 'Error: File has not been read yet. Read it first before writing to it.', { content: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>', isError: true });
  t.edit('src/orders/checkout.ts', F.CHECKOUT_V1H, F.CHECKOUT_V2, MODE);
  const rejected = t.tool('Edit', { file_path: src('src/orders/checkout.ts'), old_string: 'taxFor(bulk, cart.region)', new_string: 'taxFor(base, cart.region)' });
  t.result(rejected, 'User rejected tool use', {
    content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nno, keep tax on the discounted amount, that is what finance expects",
    isError: true,
    denial: 'user-rejected',
  });
  t.attach({ type: 'edited_text_file', filename: src('src/orders/checkout.ts'), snippet: '...' });
  const test = t.tool('Bash', { command: 'npm test', description: 'Run tests' });
  t.result(test, { stdout: '', stderr: '', interrupted: true, isImage: false, noOutputExpected: false }, { content: 'Interrupted', decision: MODE });
  t.userRaw([{ type: 'text', text: '[Request interrupted by user]' }]);
  t.user('Why does checkoutTotal round only at the very end? What happens if the region is missing from the rates table?');
  t.say('Rounding once avoids compounding errors; a missing region falls back to a 0 tax rate.');
  t.raw({ type: 'ai-title', aiTitle: 'Fix double discount', sessionId: t.sessionId });
  t.save(join(PROJECT, `${t.sessionId}.jsonl`));
}

function todaySession() {
  const t = new Transcript(SESSION_IDS.today, 'claude-vscode', 'auto').at(0, '10:00');
  t.user('add a shipping fee to checkout');
  const ask = t.tool('AskUserQuestion', { questions: [{ question: 'Flat fee or by weight?', header: 'Shipping', options: [{ label: 'Flat' }, { label: 'Weight' }], multiSelect: false }] });
  t.result(ask, { questions: [{ question: 'Flat fee or by weight?' }], answers: { 'Flat fee or by weight?': 'Flat $5 below $50, free above' } }, { content: 'User answered', decision: USER });
  t.edit('src/orders/pricing.ts', F.PRICING_V2, F.PRICING_V3, CLASSIFIER);
  t.edit('src/orders/checkout.ts', F.CHECKOUT_V2, F.CHECKOUT_V3, CLASSIFIER);
  t.user('ok');
  t.edit('src/utils/format.ts', F.FORMAT_V2, F.FORMAT_V3, CLASSIFIER);
  t.user('continue');
  const notes = t.tool('Write', { file_path: '/tmp/grasp-demo-notes.md', content: 'scratch' });
  t.result(notes, { type: 'create', filePath: '/tmp/grasp-demo-notes.md', content: 'scratch', structuredPatch: [], originalFile: null, userModified: false }, { content: 'File created', decision: CLASSIFIER });
  t.say('Shipping fee added.');
  t.raw({ type: 'ai-title', aiTitle: 'Shipping fee', sessionId: t.sessionId });
  t.save(join(PROJECT, `${t.sessionId}.jsonl`));
}

/** A scripted `claude -p` run that edited code nobody watched: its edits count as unattended. */
function headlessSession() {
  const t = new Transcript(SESSION_IDS.headless, 'sdk-cli', 'bypassPermissions').at(-1, '03:00');
  t.raw({ type: 'queue-operation', operation: 'enqueue', sessionId: t.sessionId, timestamp: new Date(FIXTURE_ANCHOR - 21 * 3_600_000).toISOString(), content: 'Add a daily report' });
  t.user('Add a daily sales report module and index the order tables. Do not ask questions.');
  t.write('src/reports/daily.ts', F.DAILY_REPORT, { decision: 'accept', source: 'config', reasonType: 'mode' });
  t.edit('src/db/migrations.ts', F.MIGRATIONS_V1, F.MIGRATIONS_V2, { decision: 'accept', source: 'config', reasonType: 'mode' });
  t.say('Done.');
  t.save(join(PROJECT, `${t.sessionId}.jsonl`));
}

/** A read-only `claude -p` run (a summarizer, say). Leaves no trace in Grasp. */
function readOnlySession() {
  const t = new Transcript(SESSION_IDS.readonly, 'sdk-cli', 'default').at(0, '08:00');
  t.user('Summarize this diff');
  const read = t.tool('Read', { file_path: src('src/orders/checkout.ts') });
  t.result(read, { type: 'text', file: { filePath: src('src/orders/checkout.ts'), content: '...' } }, { content: '...' });
  t.say('It adds a shipping fee.');
  t.save(join(PROJECT, `${t.sessionId}.jsonl`));
}

rmSync(ROOT, { recursive: true, force: true });
planSession();
pricingSession();
fixSession();
todaySession();
headlessSession();
readOnlySession();
console.log(`fixtures written to ${ROOT}`);
