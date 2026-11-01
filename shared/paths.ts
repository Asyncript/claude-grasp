import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let homeOverride: string | null = null;

/** Where Claude Grasp keeps its database and demo data. The extension points it at its global storage. */
export function graspHome(): string {
  return homeOverride ?? process.env.CLAUDE_GRASP_HOME ?? join(homedir(), '.claude-grasp');
}

export function setGraspHome(dir: string): void {
  homeOverride = dir;
}

export function dbPath(demo = false): string {
  return join(graspHome(), demo ? 'demo.db' : 'claude-grasp.db');
}

export function demoDir(): string {
  return join(graspHome(), 'demo');
}

/** Where Claude Grasp runs its own `claude -p` calls, so their sessions can always be told apart and skipped. */
export function llmWorkdir(): string {
  return join(graspHome(), 'llm-workdir');
}

/** Claude Code's folder name for a project: every character other than a letter or digit becomes "-". */
export const projectDirName = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

export const expandHome = (p: string): string => resolve(p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

export const DEFAULT_CONFIG_DIR = (): string => join(homedir(), '.claude');

/**
 * Claude Code config dirs to read, in order of precedence:
 * 1. `explicit` (--config-dir flags), or CLAUDE_GRASP_ROOTS (colon-separated)
 * 2. `configDirs` from ~/.claude-grasp/config.json, plus CLAUDE_CONFIG_DIR
 * 3. every ~/.claude* directory with a projects/ folder, plus CLAUDE_CONFIG_DIR
 */
export function configDirs(explicit: string[] = [], fromConfig?: string[]): string[] {
  if (explicit.length) return unique(explicit.map(expandHome));
  if (process.env.CLAUDE_GRASP_ROOTS) return unique(process.env.CLAUDE_GRASP_ROOTS.split(':').filter(Boolean).map(expandHome));

  const dirs: string[] = [];
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(expandHome(process.env.CLAUDE_CONFIG_DIR));
  if (fromConfig?.length) {
    dirs.push(...fromConfig.map(expandHome));
  } else {
    const home = homedir();
    // ~/.claude-grasp is Claude Grasp's own (older) data folder, not a Claude config dir.
    for (const name of readdirSync(home)) if (name.startsWith('.claude') && name !== '.claude-grasp' && join(home, name) !== graspHome()) dirs.push(join(home, name));
  }
  return unique(dirs.filter((r) => existsSync(join(r, 'projects')))).sort();
}

const unique = (xs: string[]): string[] => [...new Set(xs)];

export const PACKAGE_NAME = 'claude-grasp';

let root: string | null = null;

/** The extension sets this to its install folder (where fixtures/claude ships). */
export function setPackageRoot(dir: string): void {
  root = dir;
}

/** The package root: as set, or found by walking up from this module (works from source). */
export function packageRoot(): string {
  if (root) return root;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === PACKAGE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('claude-grasp package root not found');
    dir = parent;
  }
}
