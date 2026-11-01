import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { explainBackAllowed, type GraspConfig } from '../shared/config';
import { DEFAULT_CONFIG_DIR, expandHome, llmWorkdir } from '../shared/paths';

/** Raw text completion. The only way Claude Grasp talks to a model. */
export interface Completer {
  complete(prompt: string, configDir: string): Promise<string>;
}

const TIMEOUT_MS = 180_000;

/**
 * Flags for every call: print mode, no transcript, no tools, no MCP servers, no slash commands,
 * no user/project settings (so no hooks). --bare would also skip hooks but it skips OAuth too.
 */
export const CLAUDE_ARGS = ['-p', '--no-session-persistence', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', ''];

/**
 * The environment for a call under one Claude config dir. CLAUDE_CONFIG_DIR is always set
 * explicitly (or removed, for the default ~/.claude, whose login lives in ~/.claude.json), so a
 * Claude Grasp started from inside another account's session can't leak into that account.
 */
export function claudeEnv(configDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$)/.test(k)) env[k] = v;
  const dir = expandHome(configDir);
  if (dir !== DEFAULT_CONFIG_DIR()) env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

/**
 * The `claude` binary. An editor started from a desktop launcher often has a shorter PATH than
 * a terminal, so the usual install locations are tried before relying on PATH.
 */
export function findClaude(configured?: string): string {
  if (process.env.CLAUDE_GRASP_BIN) return process.env.CLAUDE_GRASP_BIN;
  if (configured) return expandHome(configured);
  const win = process.platform === 'win32';
  const exe = win ? 'claude.exe' : 'claude';
  const candidates = [join(homedir(), '.local', 'bin', exe), join(homedir(), '.claude', 'local', exe)];
  if (win) candidates.push(...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm', 'claude.cmd')] : []));
  else candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  return candidates.find((c) => existsSync(c)) ?? 'claude';
}

/**
 * On Windows an npm install is a .cmd script (or just `claude` on PATH), which only a shell can
 * run: Node refuses to spawn .cmd/.bat files directly. Every argument is then quoted for cmd.exe.
 */
function command(bin: string, args: string[]): { file: string; args: string[]; shell: boolean } {
  if (process.platform !== 'win32' || /\.exe$/i.test(bin)) return { file: bin, args, shell: false };
  const quote = (a: string) => `"${a.replace(/"/g, '""')}"`;
  return { file: quote(bin), args: args.map(quote), shell: true };
}

/** Runs the local `claude -p`, always from Claude Grasp's own working directory so ingest can skip it. */
export class ClaudeCli implements Completer {
  constructor(private config: GraspConfig) {}

  complete(prompt: string, configDir: string): Promise<string> {
    if (!explainBackAllowed(this.config, configDir)) return Promise.reject(new Error(`explain-back is disabled for ${configDir}`));
    const cwd = llmWorkdir();
    mkdirSync(cwd, { recursive: true });
    const bin = findClaude(this.config.claudeBin);
    const args = [...CLAUDE_ARGS, ...(this.config.model ? ['--model', this.config.model] : [])];

    return new Promise((resolvePromise, reject) => {
      const cmd = command(bin, args);
      const child = spawn(cmd.file, cmd.args, { cwd, env: claudeEnv(configDir), stdio: ['pipe', 'pipe', 'pipe'], shell: cmd.shell, windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
      child.stdout.on('data', (d: Buffer) => (out += d));
      child.stderr.on('data', (d: Buffer) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`could not run ${bin}: ${e.message}. Set the path in Settings › Claude Grasp › Claude Path.`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          const res = JSON.parse(out) as { result?: string; is_error?: boolean };
          if (res.is_error || typeof res.result !== 'string') throw new Error(res.result || 'empty result');
          resolvePromise(res.result);
        } catch (e) {
          reject(new Error(`claude -p failed (exit ${code}): ${(err || out || (e as Error).message).trim().slice(0, 500)}`));
        }
      });
      child.stdin.end(prompt);
    });
  }
}
