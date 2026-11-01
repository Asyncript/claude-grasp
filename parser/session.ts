import { isAbsolute, resolve } from 'node:path';
import type { Approval, EditEvent, FileRefEvent, FileRefKind, PlanEvent, PromptEvent, PromptKind } from '../shared/types';
import { classifyUserLine } from './human';
import { arr, hasImage, isObj, parseLine, str, textOf, type Obj } from './lines';
import { cleanPromptText, countPatch, extractSymbols, promptFeatures, splitLines } from './text';

export interface SessionMeta {
  sessionId?: string;
  cwd?: string;
  entrypoint?: string;
  version?: string;
  gitBranch?: string;
  title?: string;
  customTitle?: boolean;
  startedAt?: string;
  endedAt?: string;
}

/** A tool call waiting for its result. Kept small because it is persisted between incremental runs. */
interface PendingTool {
  name: string;
  turnId: string | null;
  paths: string[];
  added: number;
  removed: number;
  symbols: string[];
}

export interface ParserState {
  meta: SessionMeta;
  turnId: string | null;
  permissionMode: string | null;
  pending: Record<string, PendingTool>;
  lines: number;
  bad: number;
  /** Bash calls skipped for touching more than BASH_BULK_LIMIT files. */
  bulkBash?: number;
  /** Last message-bearing line, used to tell tool side effects from human edits. */
  last?: 'human' | 'assistant' | 'tool_result';
}

export interface ParseOutput {
  prompts: PromptEvent[];
  edits: EditEvent[];
  plans: PlanEvent[];
  refs: FileRefEvent[];
}

/**
 * Bump whenever a change here (or in human.ts, text.ts, cues.ts) changes what a transcript
 * produces. Transcripts read by an older version are read again from the start.
 */
export const PARSER_VERSION = 1;

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const MAX_PENDING = 500;
export const BASH_BULK_LIMIT = 20;
const REJECTED_RE = /^The user doesn't want to (proceed|take this action)/;
const ATTACHMENT_REFS: Record<string, FileRefKind> = {
  edited_text_file: 'external_edit',
  opened_file_in_ide: 'ide_open',
  selected_lines_in_ide: 'ide_select',
};

const emptyOutput = (): ParseOutput => ({ prompts: [], edits: [], plans: [], refs: [] });

/**
 * Turns transcript lines into engagement events. A turn starts at a human prompt; every
 * edit, plan, and answer is tagged with the turn it happened in. Feed lines in order;
 * `state` can be saved and passed back in to continue from where a file was last read.
 */
export class SessionParser {
  state: ParserState;
  private out = emptyOutput();
  private readonly sidechain: boolean;

  constructor(opts: { sidechain?: boolean } = {}, state?: ParserState) {
    this.sidechain = opts.sidechain ?? false;
    this.state = state ?? { meta: {}, turnId: null, permissionMode: null, pending: {}, lines: 0, bad: 0 };
  }

  /** Malformed lines are counted, never thrown. Unknown line types are ignored. */
  feedLine(raw: string): void {
    const o = parseLine(raw);
    if (!o) {
      this.state.bad++;
      return;
    }
    try {
      this.feed(o);
    } catch {
      this.state.bad++;
    }
  }

  feed(o: Obj): void {
    this.state.lines++;
    const m = this.state.meta;
    const ts = str(o.timestamp);
    this.trackMeta(o, ts);
    const at = ts ?? m.endedAt ?? '';

    switch (o.type) {
      case 'assistant':
        return this.onAssistant(o);
      case 'user':
        return this.onUser(o, at);
      case 'attachment':
        return this.onAttachment(o, at);
      case 'permission-mode':
        this.state.permissionMode = str(o.permissionMode) ?? this.state.permissionMode;
        return;
      case 'ai-title':
        if (!m.customTitle) m.title = str(o.aiTitle) ?? m.title;
        return;
      case 'custom-title':
        m.title = str(o.customTitle) ?? m.title;
        m.customTitle = true;
        return;
    }
  }

  drain(): ParseOutput {
    const out = this.out;
    this.out = emptyOutput();
    return out;
  }

  private trackMeta(o: Obj, ts: string | undefined) {
    const m = this.state.meta;
    m.sessionId ??= str(o.sessionId);
    m.cwd ??= str(o.cwd);
    m.entrypoint ??= str(o.entrypoint);
    m.gitBranch ??= str(o.gitBranch);
    m.version = str(o.version) ?? m.version;
    if (ts) {
      if (!m.startedAt || ts < m.startedAt) m.startedAt = ts;
      if (!m.endedAt || ts > m.endedAt) m.endedAt = ts;
    }
  }

  private abs(p: string): string {
    const cwd = this.state.meta.cwd;
    return isAbsolute(p) || !cwd ? p : resolve(cwd, p);
  }

  private onAssistant(o: Obj) {
    this.state.last = 'assistant';
    const content = isObj(o.message) ? arr(o.message.content) : [];
    for (const b of content) {
      if (!isObj(b) || b.type !== 'tool_use') continue;
      const id = str(b.id);
      const name = str(b.name);
      if (!id || !name) continue;
      this.state.pending[id] = { name, turnId: this.state.turnId, ...summarizeInput(name, isObj(b.input) ? b.input : {}) };
    }
    const ids = Object.keys(this.state.pending);
    // Tool calls that never got a result (aborted turns) would otherwise pile up in saved state.
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PENDING))) delete this.state.pending[id];
  }

  private onUser(o: Obj, ts: string) {
    const pm = str(o.permissionMode);
    if (pm) this.state.permissionMode = pm;
    const content = isObj(o.message) ? o.message.content : undefined;

    switch (classifyUserLine(o, this.sidechain)) {
      case 'tool_result':
        this.state.last = 'tool_result';
        for (const b of arr(content)) if (isObj(b) && b.type === 'tool_result') this.onToolResult(o, b, ts);
        return;
      case 'interrupt':
        this.state.last = 'human';
        this.prompt(str(o.uuid) ?? this.fallbackId('interrupt'), ts, 'interrupt', '', this.state.turnId);
        return;
      case 'human': {
        const { text, pastedWords, ideFiles } = cleanPromptText(textOf(content));
        if (!text && !pastedWords && !ideFiles.length && !hasImage(content)) return;
        const uuid = str(o.uuid) ?? this.fallbackId('prompt');
        this.state.turnId = uuid;
        this.state.last = 'human';
        for (const f of ideFiles) this.out.refs.push({ ts, turnId: uuid, filePath: this.abs(f.path), kind: f.kind });
        this.prompt(uuid, ts, 'human', text, uuid, pastedWords);
        return;
      }
    }
  }

  private onToolResult(o: Obj, block: Obj, ts: string) {
    const id = str(block.tool_use_id) ?? '';
    const p = this.state.pending[id];
    if (!p) return;
    delete this.state.pending[id];

    const tur = isObj(o.toolUseResult) ? o.toolUseResult : {};
    const resultText = textOf(block.content);
    const denial = str(o.toolDenialKind);
    if (denial === 'user-rejected' || REJECTED_RE.test(resultText)) {
      if (this.sidechain) return;
      // The human just said no, so a change reported next is theirs, not a tool's.
      this.state.last = 'human';
      this.onRejected(o, p, id, resultText, ts);
      return;
    }
    if (block.is_error === true || denial) return;

    const approval = approvalOf(o.permissionDecision, this.state.permissionMode);
    if (EDIT_TOOLS.has(p.name)) return this.fileEdit(p, id, tur, ts, approval);
    if (p.name === 'Bash' && isObj(tur.bashEditDiff)) return this.bashEdit(p, id, tur.bashEditDiff, ts, approval);
    if (this.sidechain) return;
    if (p.name === 'ExitPlanMode') {
      this.out.plans.push({ toolUseId: id, ts, turnId: p.turnId, outcome: 'approved', planEdited: tur.planWasEdited === true });
    } else if (p.name === 'AskUserQuestion' && isObj(tur.answers)) {
      const text = Object.values(tur.answers).filter((v) => typeof v === 'string').join('\n');
      this.prompt(`${id}:answer`, ts, 'answer', text, this.state.turnId);
    }
  }

  private onRejected(o: Obj, p: PendingTool, id: string, resultText: string, ts: string) {
    const feedback = str(o.userFeedback) ?? resultText.match(/the user said:\s*([\s\S]+)$/i)?.[1] ?? '';
    for (const path of p.paths) this.out.refs.push({ ts, turnId: this.state.turnId, filePath: this.abs(path), kind: 'rejected_edit' });
    if (p.name === 'ExitPlanMode') {
      this.out.plans.push({ toolUseId: id, ts, turnId: p.turnId, outcome: 'rejected', planEdited: false });
    }
    this.prompt(`${id}:rejection`, ts, 'rejection', feedback.trim(), this.state.turnId);
  }

  private fileEdit(p: PendingTool, id: string, tur: Obj, ts: string, approval: Approval) {
    const path = str(tur.filePath) ?? p.paths[0];
    if (!path) return;
    let { added, removed, symbols } = p;
    const created = tur.type === 'create';
    const patch = arr(tur.structuredPatch);
    if (created && typeof tur.content === 'string') {
      const lines = splitLines(tur.content);
      added = lines.length;
      removed = 0;
      symbols = extractSymbols(lines);
    } else if (patch.length) {
      const c = countPatch(patch);
      added = c.added;
      removed = c.removed;
      symbols = extractSymbols(c.changed);
    }
    this.pushEdit({ toolUseId: id, ts, turnId: p.turnId, tool: p.name, filePath: this.abs(path), added, removed, created, approval, symbols });
  }

  /**
   * Bash results carry a bashEditDiff when the command changed files (sed -i, heredocs, scripts).
   * Calls that touch many files (git checkout, formatters, codegen) aren't authorship and are skipped.
   */
  private bashEdit(p: PendingTool, id: string, diff: Obj, ts: string, approval: Approval) {
    const touched = new Set([...arr(diff.files).map((f) => (isObj(f) ? str(f.filePath) : undefined)), ...arr(diff.changedFiles).map(str)].filter(Boolean));
    if (touched.size + (Number(diff.moreFiles) || 0) > BASH_BULK_LIMIT) {
      this.state.bulkBash = (this.state.bulkBash ?? 0) + 1;
      return;
    }
    const seen = new Set<string>();
    for (const f of arr(diff.files)) {
      const path = isObj(f) ? str(f.filePath) : undefined;
      if (!isObj(f) || !path) continue;
      const c = countPatch(arr(f.hunks));
      seen.add(path);
      this.pushEdit({ toolUseId: id, ts, turnId: p.turnId, tool: 'Bash', filePath: this.abs(path), added: c.added, removed: c.removed, created: f.created === true, approval, symbols: extractSymbols(c.changed) });
    }
    for (const path of arr(diff.changedFiles)) {
      if (typeof path !== 'string' || seen.has(path)) continue;
      this.pushEdit({ toolUseId: id, ts, turnId: p.turnId, tool: 'Bash', filePath: this.abs(path), added: 0, removed: 0, created: false, approval, symbols: [] });
    }
  }

  private pushEdit(e: Omit<EditEvent, 'permissionMode' | 'sidechain'>) {
    this.out.edits.push({ ...e, permissionMode: this.state.permissionMode, sidechain: this.sidechain });
  }

  private onAttachment(o: Obj, ts: string) {
    if (this.sidechain || !isObj(o.attachment)) return;
    const kind = ATTACHMENT_REFS[str(o.attachment.type) ?? ''];
    const file = str(o.attachment.filename);
    if (!kind || !file) return;
    // A file reported as changed right after a tool result was almost always changed by that
    // tool (Claude's own sed, a formatter, a checkout), not by the human.
    if (kind === 'external_edit' && this.state.last === 'tool_result') return;
    this.out.refs.push({ ts, turnId: this.state.turnId, filePath: this.abs(file), kind });
  }

  private prompt(uuid: string, ts: string, kind: PromptKind, text: string, turnId: string | null, pastedWords = 0) {
    this.out.prompts.push({ uuid, ts, turnId, kind, pastedWords, ...promptFeatures(text) });
  }

  private fallbackId(kind: string): string {
    return `${this.state.meta.sessionId ?? 'session'}:${kind}:${this.state.lines}`;
  }
}

function lineCount(v: unknown): number {
  return typeof v === 'string' ? splitLines(v).length : 0;
}

function summarizeInput(name: string, input: Obj): Omit<PendingTool, 'name' | 'turnId'> {
  const paths = [str(input.file_path), str(input.notebook_path)].filter((p): p is string => !!p);
  const empty = { paths, added: 0, removed: 0, symbols: [] as string[] };
  switch (name) {
    case 'Edit':
      return { paths, added: lineCount(input.new_string), removed: lineCount(input.old_string), symbols: extractSymbols(splitLines(str(input.new_string) ?? '')) };
    case 'MultiEdit': {
      const edits = arr(input.edits).filter(isObj);
      return {
        paths,
        added: edits.reduce((n, e) => n + lineCount(e.new_string), 0),
        removed: edits.reduce((n, e) => n + lineCount(e.old_string), 0),
        symbols: extractSymbols(edits.flatMap((e) => splitLines(str(e.new_string) ?? ''))),
      };
    }
    case 'Write':
      return { paths, added: lineCount(input.content), removed: 0, symbols: extractSymbols(splitLines(str(input.content) ?? '')) };
    case 'NotebookEdit':
      return { paths, added: lineCount(input.new_source), removed: 0, symbols: [] };
    default:
      return empty;
  }
}

export function approvalOf(decision: unknown, mode: string | null): Approval {
  if (isObj(decision)) {
    const source = str(decision.source) ?? '';
    const reason = str(decision.reasonType);
    if (source.startsWith('user')) return 'user';
    if (reason === 'classifier') return 'classifier';
    if (reason === 'mode') return mode === 'bypassPermissions' ? 'bypass' : 'mode';
    return 'rule';
  }
  if (mode === 'bypassPermissions') return 'bypass';
  if (mode === 'acceptEdits') return 'mode';
  return 'unrecorded';
}
