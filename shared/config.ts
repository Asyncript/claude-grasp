import type { ScoringConfig } from '../scoring/config';
import { expandHome } from './paths';

/** Runtime settings. In VS Code they come from the `claudeGrasp.*` settings. Every field is optional. */
export interface GraspConfig {
  /** Claude Code config dirs to read instead of auto-discovering ~/.claude*. */
  configDirs?: string[];
  /** Config dirs whose code must never be sent to `claude -p` for explain-back. */
  explainBackDisabled?: string[];
  /** Path to the real `claude` binary (shell functions and aliases aren't visible to Claude Grasp). */
  claudeBin?: string;
  /** Model passed to `claude -p --model`. Default: the account's default. */
  model?: string;
  /** Explain-back questions per day (1-5). Default 1. */
  questionsPerDay?: number;
  /** Your git author emails besides each repo's user.email; commits by anyone else never count as yours. */
  gitEmails?: string[];
  /** Globs of files that never get a score, besides lockfiles, bundles and snapshots. */
  ignore?: string[];
  /** Weights; default `SCORING`. */
  scoring?: ScoringConfig;
}

export const explainBackAllowed = (config: GraspConfig, dir: string): boolean => !config.explainBackDisabled?.map(expandHome).includes(expandHome(dir));
