import { readdirSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';

export interface TranscriptFile {
  root: string;
  projectDir: string;
  path: string;
  sessionId: string;
  kind: 'main' | 'subagent';
}

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Finds <root>/projects/<project>/<session>.jsonl and the subagent transcripts in
 * <root>/projects/<project>/<session>/subagents/*.jsonl. Main files come first so
 * subagent edits can be matched to their parent's turns.
 */
export function discoverTranscripts(roots: string[]): TranscriptFile[] {
  const main: TranscriptFile[] = [];
  const sub: TranscriptFile[] = [];
  for (const root of roots) {
    for (const project of entries(join(root, 'projects'))) {
      if (!project.isDirectory()) continue;
      const projectPath = join(root, 'projects', project.name);
      for (const e of entries(projectPath)) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          main.push({ root, projectDir: project.name, path: join(projectPath, e.name), sessionId: basename(e.name, '.jsonl'), kind: 'main' });
        } else if (e.isDirectory()) {
          const subDir = join(projectPath, e.name, 'subagents');
          for (const s of entries(subDir)) {
            if (s.isFile() && s.name.endsWith('.jsonl')) {
              sub.push({ root, projectDir: project.name, path: join(subDir, s.name), sessionId: e.name, kind: 'subagent' });
            }
          }
        }
      }
    }
  }
  return [...main, ...sub];
}
