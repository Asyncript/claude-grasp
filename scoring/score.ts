import type { CommitAttribution } from '../git/attribution';
import type { Approval, PromptKind } from '../shared/types';
import { bucketOf, SCORING, type Bucket, type ScoringConfig } from './config';

const DAY_MS = 86_400_000;
const AUTO_APPROVALS = new Set<Approval>(['classifier', 'mode', 'rule', 'bypass']);

export interface Prompt {
  uuid: string;
  sessionId: string;
  ts: number;
  kind: PromptKind;
  words: number;
  isBare: boolean;
  isQuestion: boolean;
  isCorrection: boolean;
  excerpt: string;
}

export interface Turn {
  id: string;
  sessionId: string;
  /** The human prompt that opened the turn. */
  starter: Prompt;
  /** The session's previous and next turns, if any. */
  prev: string | null;
  next: string | null;
  /** Every prompt in the turn, starter included: answers, rejections, interruptions. */
  prompts: Prompt[];
  plans: { ts: number; outcome: 'approved' | 'rejected'; planEdited: boolean }[];
  /** Distinct files Claude changed (or you rejected a change to) in this turn. Default 1. */
  files?: number;
}

export interface FileEdit {
  ts: number;
  sessionId: string;
  turnId: string | null;
  tool: string;
  lines: number;
  approval: Approval;
  unattended: boolean;
}

export interface FileInput {
  repoId: number;
  path: string;
  edits: FileEdit[];
  /** Turns in which you rejected an edit to this file. */
  rejections: { ts: number; turnId: string | null }[];
  /** Prompts naming the file or its symbols, already matched. */
  mentions: { ts: number; sessionId: string; excerpt: string; matched: string; uuid?: string }[];
  ideRefs: { ts: number; sessionId: string; kind: 'ide_open' | 'ide_select' }[];
  externalEdits: { ts: number; sessionId: string }[];
  commits: { sha: string; ts: number; subject: string; attribution: CommitAttribution }[];
  quizzes: { id: number; ts: number; question: string; grade: number }[];
  /** Times you marked the file reviewed. */
  reviews?: { ts: number }[];
}

export interface Evidence {
  ts: string;
  text: string;
  sessionId?: string;
  sha?: string;
  /** Points this item added before time decay. */
  points: number;
}

export interface Contribution {
  key: string;
  label: string;
  /** Exactly what this signal added to the score (negative for penalties). */
  points: number;
  detail: string;
  evidence: Evidence[];
  /** A penalty whose weight is 0 in settings: shown as "off", never counted. */
  off?: boolean;
}

export interface FileStats {
  edits: number;
  linesChanged: number;
  unattendedEdits: number;
  unattendedLines: number;
  /** Share (0-1) of changed lines written by unattended runs. */
  unattendedShare: number;
  sessions: string[];
  firstEdit: string | null;
  lastEdit: string | null;
  lastReview: string | null;
}

export interface FileScore {
  repoId: number;
  path: string;
  /** base + every contribution, before clamping to 0-100. */
  raw: number;
  score: number;
  bucket: Bucket;
  base: number;
  contributions: Contribution[];
  /** No positive evidence at all: no plan, question, correction, reference, own commit, review or quiz pass. */
  neverUnderstood: boolean;
  stats: FileStats;
}

const iso = (ms: number) => new Date(ms).toISOString();
// `|| 0` turns -0 into 0 so a zero penalty prints as 0.
const round1 = (n: number) => Math.round(n * 10) / 10 || 0;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

interface Item {
  ts: number;
  points: number;
  text: string;
  sessionId?: string;
  sha?: string;
}

/**
 * Scores one file as of `now`. Pure: everything it needs is in `file` and `turns`, so the
 * same input scored at an earlier `now` gives the score the file had back then.
 */
export function scoreFile(file: FileInput, turns: Map<string, Turn>, now: number, c: ScoringConfig = SCORING): FileScore {
  const upTo = <T extends { ts: number }>(xs: T[]) => xs.filter((x) => x.ts <= now);
  const edits = upTo(file.edits);
  const attended = edits.filter((e) => !e.unattended);
  const unattended = edits.filter((e) => e.unattended);
  const fade = (ts: number) => 0.5 ** (Math.max(0, now - ts) / (c.halfLifeDays * DAY_MS));
  const decay = (ts: number) => c.decayFloor + (1 - c.decayFloor) * fade(ts);

  // The turns where Claude changed this file (or you rejected a change), plus the turn after each.
  const editTurns = new Set<string>();
  for (const e of attended) if (e.turnId && turns.has(e.turnId)) editTurns.add(e.turnId);
  for (const r of upTo(file.rejections)) if (r.turnId && turns.has(r.turnId)) editTurns.add(r.turnId);
  const engaged = new Set(editTurns);
  for (const id of editTurns) {
    const next = turns.get(id)!.next;
    if (next && turns.get(next)!.starter.ts <= now) engaged.add(next);
  }
  const engagedTurns = [...engaged].map((id) => turns.get(id)!);

  // A turn that changed many files can't show which of them a question or plan was about, so
  // the credit is split, unless the prompt named this file.
  const named = new Set(upTo(file.mentions).flatMap((m) => (m.uuid ? [m.uuid] : [])));
  const filesOf = (id: string | null) => (id && editTurns.has(id) ? Math.max(1, turns.get(id)!.files ?? 1) : 1);
  const share = (n: number, uuid: string) => (named.has(uuid) ? 1 : Math.min(1, c.fullCreditFiles / n));
  const sharedNote = (n: number, s: number) => (s < 1 ? ` (shared by ${n} files changed in that turn)` : '');
  // The turn after an edit turn shares that edit turn's files.
  const promptsInTurns = engagedTurns.flatMap((t) => t.prompts.filter((p) => p.ts <= now).map((p) => ({ p, n: Math.max(filesOf(t.id), filesOf(t.prev)) })));

  const contributions: Contribution[] = [];
  let decayLoss = 0;
  const positive = (key: keyof ScoringConfig['positive'], label: string, items: Item[], detail: string) => {
    const x = capped(key, label, items, c.positive[key].cap, detail, decay);
    const { decayed, ...contribution } = x;
    decayLoss += x.points - decayed;
    contributions.push(contribution);
  };

  // Plans with substantive input, approved in a turn that changed the file or the turn before it
  // (plan, then "go ahead, and keep X in Y" is the usual shape).
  const planTurns = new Set<string>();
  for (const id of editTurns) {
    planTurns.add(id);
    const prev = turns.get(id)!.prev;
    if (prev) planTurns.add(prev);
  }
  const planItems: Item[] = [];
  const split = c.fullCreditFiles;
  for (const id of planTurns) {
    const t = turns.get(id)!;
    const hasQuestionOrAnswer = t.prompts.some((p) => p.ts <= now && (p.isQuestion || p.kind === 'answer'));
    // The plan was carried out in its own turn or the next one.
    const n = Math.max(filesOf(t.id), filesOf(t.next));
    const s = share(n, t.starter.uuid);
    for (const p of t.plans) {
      if (p.ts > now || p.outcome !== 'approved') continue;
      const why = p.planEdited ? 'you edited the plan' : t.starter.words >= c.plan.minWords ? `${t.starter.words}-word prompt` : hasQuestionOrAnswer ? 'you answered or asked questions' : null;
      if (why) planItems.push({ ts: p.ts, points: c.positive.plan.points * s, text: `Plan approved (${why}): "${t.starter.excerpt}"${sharedNote(n, s)}`, sessionId: t.sessionId });
    }
  }
  positive('plan', 'Planned with your input', planItems, `+${c.positive.plan.points} per approved plan with substantive input, split when it changed more than ${split} files`);

  const questions = promptsInTurns.filter(({ p }) => p.isQuestion && p.kind !== 'rejection');
  positive(
    'question',
    'Asked why / how / what if',
    questions.map(({ p, n }) => {
      const s = share(n, p.uuid);
      return { ts: p.ts, points: c.positive.question.points * s, text: p.excerpt + sharedNote(n, s), sessionId: p.sessionId };
    }),
    `+${c.positive.question.points} per question in a turn that changed the file or the turn after, split when it changed more than ${split} files`,
  );

  const corrections = promptsInTurns.filter(({ p }) => p.kind === 'rejection' || p.kind === 'interrupt' || (p.kind === 'human' && p.isCorrection));
  positive(
    'correction',
    'Corrected or rejected Claude',
    corrections.map(({ p, n }) => {
      const s = share(n, p.uuid);
      const text = p.kind === 'interrupt' ? 'Interrupted Claude' : p.kind === 'rejection' ? `Rejected a tool call${p.excerpt ? `: "${p.excerpt}"` : ''}` : p.excerpt;
      return { ts: p.ts, points: c.positive.correction.points * s, text: text + sharedNote(n, s), sessionId: p.sessionId };
    }),
    `+${c.positive.correction.points} per correction, rejection or interruption in those turns, split the same way`,
  );

  const refItems: Item[] = [
    ...upTo(file.mentions).map((m) => ({ ts: m.ts, points: c.positive.reference.points, text: `Named \`${m.matched}\`: "${m.excerpt}"`, sessionId: m.sessionId })),
    ...upTo(file.ideRefs).map((r) => ({ ts: r.ts, points: c.positive.reference.points, text: r.kind === 'ide_select' ? 'Selected lines in the IDE' : 'Opened in the IDE while prompting', sessionId: r.sessionId })),
  ];
  positive('reference', 'Referred to the file', refItems, `+${c.positive.reference.points} per prompt naming the file or its symbols, or IDE open/selection`);

  const commits = upTo(file.commits);
  const ambiguous = commits.filter((x) => x.attribution === 'ambiguous').length;
  const others = commits.filter((x) => x.attribution === 'other').length;
  positive(
    'humanCommit',
    'Changed it yourself (git)',
    commits.filter((x) => x.attribution === 'human').map((x) => ({ ts: x.ts, points: c.positive.humanCommit.points, text: x.subject, sha: x.sha })),
    `+${c.positive.humanCommit.points} per commit with no Claude trailer and no Claude edit since the previous commit` +
      (ambiguous ? `. ${ambiguous} commit${ambiguous > 1 ? 's' : ''} without a trailer followed Claude edits, so they count for nothing` : '') +
      (others ? `. ${others} commit${others > 1 ? 's' : ''} by other people count for nothing` : ''),
  );

  positive(
    'externalEdit',
    'Changed outside Claude',
    upTo(file.externalEdits).map((x) => ({ ts: x.ts, points: c.positive.externalEdit.points, text: 'Claude Code saw the file change outside Claude (you or a tool)', sessionId: x.sessionId })),
    `+${c.positive.externalEdit.points} each; weak, since a formatter or another tool can cause it too`,
  );

  // A review counts only when Claude changed the file since your previous one: reading the
  // same code again shows nothing new.
  const reviews = upTo(file.reviews ?? []).sort((a, b) => a.ts - b.ts);
  const reviewItems: Item[] = [];
  let since = -Infinity;
  for (const r of reviews) {
    if (edits.some((e) => e.ts > since && e.ts <= r.ts)) reviewItems.push({ ts: r.ts, points: c.positive.reviewed.points, text: "You marked it reviewed after Claude's changes" });
    since = r.ts;
  }
  positive('reviewed', 'Marked reviewed', reviewItems, `+${c.positive.reviewed.points} per review you marked after Claude changed the file`);

  const quizzes = upTo(file.quizzes);
  const passed = quizzes.filter((q) => q.grade >= c.quizPassGrade);
  const failed = quizzes.filter((q) => q.grade < c.quizPassGrade);
  positive(
    'quizPass',
    'Explained it back',
    passed.map((q) => ({ ts: q.ts, points: c.positive.quizPass.points * q.grade, text: `${Math.round(q.grade * 100)}%: ${q.question}` })),
    `+${c.positive.quizPass.points} × grade per explain-back answer graded ${Math.round(c.quizPassGrade * 100)}% or better`,
  );

  const totalLines = edits.reduce((n, e) => n + e.lines, 0);
  const attendedLines = attended.reduce((n, e) => n + e.lines, 0);
  const unattendedLines = unattended.reduce((n, e) => n + e.lines, 0);

  // Time decay: what the positive evidence was worth when it happened minus what it is worth now.
  for (const x of contributions) x.points = round1(x.points);
  contributions.push({
    key: 'decay',
    label: 'Time decay',
    points: round1(-decayLoss),
    detail: `Positive evidence halves in value every ${c.halfLifeDays} days, but keeps at least ${Math.round(c.decayFloor * 100)}% of it`,
    evidence: [],
  });

  const fail = capped('quizFail', 'Failed explain-back', failed.map((q) => ({ ts: q.ts, points: c.negative.quizFail.points, text: `${Math.round(q.grade * 100)}%: ${q.question}` })), c.negative.quizFail.cap, `−${c.negative.quizFail.points} per answer graded below ${Math.round(c.quizPassGrade * 100)}%, fading with the same half-life`, fade);
  contributions.push({ key: fail.key, label: fail.label, detail: fail.detail, points: round1(-fail.decayed), off: !c.negative.quizFail.points, evidence: fail.evidence.map((e) => ({ ...e, points: -e.points })) });

  // Bare approvals: share of the edit turns that a bare "ok" / "continue" started.
  const editTurnList = [...editTurns].map((id) => turns.get(id)!);
  const bare = editTurnList.filter((t) => t.starter.isBare);
  const bareShare = editTurnList.length ? bare.length / editTurnList.length : 0;
  contributions.push({
    key: 'bareApproval',
    label: 'Bare approvals',
    off: !c.negative.bareApproval,
    points: round1(-c.negative.bareApproval * bareShare),
    detail: `−${c.negative.bareApproval} × ${bare.length}/${editTurnList.length} edit turns started by a bare approval`,
    evidence: bare.map((t) => ({ ts: iso(t.starter.ts), text: `"${t.starter.excerpt}"`, sessionId: t.sessionId, points: 0 })),
  });

  const autoLines = attended.filter((e) => AUTO_APPROVALS.has(e.approval)).reduce((n, e) => n + e.lines, 0);
  const autoShare = attendedLines ? autoLines / attendedLines : 0;
  contributions.push({
    key: 'autoAccept',
    label: 'Accepted without you',
    off: !c.negative.autoAccept,
    points: round1(-c.negative.autoAccept * autoShare),
    detail: `−${c.negative.autoAccept} × ${autoLines}/${attendedLines} changed lines approved by a classifier, permission mode, rule or bypass`,
    evidence: [],
  });

  const words = engagedTurns.reduce((n, t) => n + t.prompts.filter((p) => p.ts <= now).reduce((m, p) => m + p.words, 0), 0);
  const perWord = attendedLines / Math.max(1, words);
  const v = c.negative.volume;
  const volumeShare = clamp01((perWord - v.freeLinesPerWord) / (v.fullLinesPerWord - v.freeLinesPerWord));
  contributions.push({
    key: 'volume',
    label: 'Code volume vs. your words',
    off: !v.points,
    points: round1(-v.points * volumeShare),
    detail: `${attendedLines} changed lines for ${words} words you typed (${round1(perWord)} per word). No penalty up to ${v.freeLinesPerWord}, full −${v.points} at ${v.fullLinesPerWord}`,
    evidence: [],
  });

  const unattendedShare = totalLines ? unattendedLines / totalLines : unattended.length && !attended.length ? 1 : 0;
  contributions.push({
    key: 'unattended',
    label: 'Unattended (headless) edits',
    off: !c.negative.unattended,
    points: round1(-c.negative.unattended * unattendedShare),
    detail: `−${c.negative.unattended} × ${unattendedLines}/${totalLines} changed lines written by claude -p runs nobody watched`,
    evidence: unattended.map((e) => ({ ts: iso(e.ts), text: `${e.tool}, ${e.lines} lines`, sessionId: e.sessionId, points: 0 })),
  });

  const raw = round1(c.base + contributions.reduce((n, x) => n + x.points, 0));
  const score = Math.round(Math.min(100, Math.max(0, raw)));
  const neverUnderstood = (['plan', 'question', 'correction', 'reference', 'humanCommit', 'reviewed', 'quizPass'] as const).every(
    (k) => !contributions.find((x) => x.key === k)?.evidence.length,
  );
  const sessions = [...new Set(edits.map((e) => e.sessionId))];
  const times = edits.map((e) => e.ts).sort((a, b) => a - b);

  return {
    repoId: file.repoId,
    path: file.path,
    raw,
    score,
    bucket: bucketOf(score, c),
    base: c.base,
    contributions,
    neverUnderstood,
    stats: {
      edits: edits.length,
      linesChanged: totalLines,
      unattendedEdits: unattended.length,
      unattendedLines,
      unattendedShare: round1(unattendedShare * 1000) / 1000,
      sessions,
      firstEdit: times.length ? iso(times[0]!) : null,
      lastEdit: times.length ? iso(times.at(-1)!) : null,
      lastReview: reviews.length ? iso(reviews.at(-1)!.ts) : null,
    },
  };
}

/**
 * Newest evidence first, until the cap. `points` is what fit under the cap (each item rounded,
 * so the evidence adds up to it); `decayed` is that amount after time decay.
 */
function capped(key: string, label: string, items: Item[], cap: number, detail: string, decay: (ts: number) => number): Contribution & { decayed: number } {
  const sorted = [...items].sort((a, b) => b.ts - a.ts);
  let room = cap;
  let points = 0;
  let decayed = 0;
  const evidence: Evidence[] = [];
  for (const it of sorted) {
    const p = round1(Math.min(it.points, room));
    room -= p;
    points += p;
    decayed += p * decay(it.ts);
    evidence.push({ ts: iso(it.ts), text: it.text, sessionId: it.sessionId, sha: it.sha, points: p });
  }
  return { key, label, points, decayed, detail: `${detail} (max ${cap})`, evidence };
}
