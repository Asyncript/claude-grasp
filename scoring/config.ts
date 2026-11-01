// Every number that shapes a comprehension score. The README's formula section mirrors this file.

export interface Weight {
  points: number;
  cap: number;
}

export interface ScoringConfig {
  base: number;
  buckets: { green: number; yellow: number };
  halfLifeDays: number;
  positive: Record<'plan' | 'question' | 'correction' | 'reference' | 'humanCommit' | 'externalEdit' | 'quizPass', Weight>;
  plan: { minWords: number };
  quizPassGrade: number;
  negative: {
    quizFail: Weight;
    bareApproval: number;
    autoAccept: number;
    volume: { points: number; freeLinesPerWord: number; fullLinesPerWord: number };
    unattended: number;
  };
}

/** The penalty weights a user can set; anything left out keeps its default. */
export interface PenaltySettings {
  bareApproval?: number;
  autoAccept?: number;
  codeVolume?: number;
  failedQuiz?: number;
  unattended?: number;
}

/** What the penalties were before they became settings, for comparison and tests. */
export const STRICT_PENALTIES: Required<PenaltySettings> = { bareApproval: 20, autoAccept: 10, codeVolume: 15, failedQuiz: 10, unattended: 35 };

export function withPenalties(p: PenaltySettings, c: ScoringConfig = SCORING): ScoringConfig {
  const n = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : d);
  return {
    ...c,
    negative: {
      ...c.negative,
      bareApproval: n(p.bareApproval, c.negative.bareApproval),
      autoAccept: n(p.autoAccept, c.negative.autoAccept),
      volume: { ...c.negative.volume, points: n(p.codeVolume, c.negative.volume.points) },
      quizFail: { ...c.negative.quizFail, points: n(p.failedQuiz, c.negative.quizFail.points) },
      unattended: n(p.unattended, c.negative.unattended),
    },
  };
}

export const SCORING: ScoringConfig = {
  /** Where every file starts before any evidence. */
  base: 35,

  /** green >= 70, yellow 40-69, red < 40 */
  buckets: { green: 70, yellow: 40 },

  /** Positive evidence loses half its value every this many days. Penalties don't decay. */
  halfLifeDays: 30,

  /** Positive signals: `points` per piece of evidence, at most `cap` in total. */
  positive: {
    /** An approved plan in a turn that edited the file, with substantive human input (see `plan`). */
    plan: { points: 20, cap: 30 },
    /** A why/how/what-if question in a turn that edited the file, or in the turn right after. */
    question: { points: 6, cap: 18 },
    /** A correction, rejected tool call or interruption in those same turns. */
    correction: { points: 5, cap: 15 },
    /** A prompt naming the file or one of its symbols, or the file opened/selected in the IDE. */
    reference: { points: 4, cap: 16 },
    /** A commit to the file with no Claude trailer and no Claude edit since the previous commit. */
    humanCommit: { points: 10, cap: 20 },
    /** Claude Code saw the file change outside Claude (you or a tool, so it counts for little). */
    externalEdit: { points: 2, cap: 6 },
    /** An explain-back answer about the file, scaled by its grade (0-1). */
    quizPass: { points: 25, cap: 30 },
  },

  /** What makes a plan count: the plan was edited, the prompt had at least `minWords`, or the turn had a question or an answer. */
  plan: { minWords: 15 },

  /** A graded answer at or above this counts as a pass. */
  quizPassGrade: 0.6,

  /**
   * Negative signals. Each is `points` times a share between 0 and 1. Workflows differ (many
   * people keep auto-accept on and type "continue"), so everything except unattended edits is
   * off (0) by default and turned on in settings.
   */
  negative: {
    /** A failed explain-back answer, per answer (decays like positive evidence). */
    quizFail: { points: 0, cap: 20 },
    /** Share of the file's edit turns started by a bare approval ("ok", "continue"). */
    bareApproval: 0,
    /** Share of the file's changed lines approved without you (classifier, permission mode, rule, bypass). */
    autoAccept: 0,
    /**
     * Changed lines per typed word in the turns that touched the file. No penalty at or below
     * `freeLinesPerWord`; full penalty at `fullLinesPerWord` and above.
     */
    volume: { points: 0, freeLinesPerWord: 3, fullLinesPerWord: 15 },
    /** Share of the file's changed lines written by headless `claude -p` runs nobody watched. */
    unattended: 35,
  },
};

export type Bucket = 'green' | 'yellow' | 'red';

export function bucketOf(score: number, c: ScoringConfig = SCORING): Bucket {
  if (score >= c.buckets.green) return 'green';
  if (score >= c.buckets.yellow) return 'yellow';
  return 'red';
}
