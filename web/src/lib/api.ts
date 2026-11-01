import type { Bucket, ScoringConfig } from '../../../scoring/config';
import type { RepoSummary } from '../../../scoring/repo';
import type { Contribution, FileScore } from '../../../scoring/score';
import type { QuizView, TodaySummary } from '../../../explain/today';
import type { IngestStats } from '../../../ingest/run';
import type { Account, FileDetail, FileRow, FilesResponse, Project, ProjectsResponse, ScoresResponse, SessionRow, Settings, TrendPoint } from '../../../extension/service';

export type { Account, Bucket, Contribution, FileDetail, FileRow, FileScore, FilesResponse, Project, ProjectsResponse, QuizView, RepoSummary, ScoresResponse, ScoringConfig, SessionRow, Settings, TodaySummary, TrendPoint };

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

/** Inside VS Code the page talks to the extension by messages; in the dev preview, over HTTP. */
const vscode: VsCodeApi | null = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
export const inVsCode = vscode !== null;

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Set<(m: { type: string; route?: string }) => void>();

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as { id?: number; result?: unknown; error?: string; type?: string; route?: string };
  if (typeof m?.id === 'number') {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error !== undefined) p?.reject(new Error(m.error));
    else p?.resolve(m.result);
  } else if (typeof m?.type === 'string') {
    for (const fn of listeners) fn(m as { type: string; route?: string });
  }
});

/** Messages from the extension: `changed` (scores may differ) and `navigate`. */
export const onHostMessage = (fn: (m: { type: string; route?: string }) => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

async function call<T>(method: string, ...params: unknown[]): Promise<T> {
  if (vscode) {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      vscode.postMessage({ id, method, params });
    });
  }
  const res = await fetch('rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
  const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body.result as T;
}

export const api = {
  projects: (account?: string) => call<ProjectsResponse>('projects', account),
  files: (repo: number, account?: string) => call<FilesResponse>('files', repo, account),
  file: (repo: number, path: string) => call<FileDetail>('file', repo, path),
  scores: (repo: number, account?: string) => call<ScoresResponse>('scores', repo, account),
  today: () => call<TodaySummary & { quizEnabled: boolean }>('today'),
  makeQuiz: () => call<QuizView | null>('makeQuiz'),
  answer: (id: number, answer: string) => call<{ score: number; feedback: string; expected: string }>('answer', id, answer),
  skip: (id: number) => call<void>('skip', id),
  ingest: () => call<IngestStats>('ingest'),
};

/** Things only the editor can do. The preview just says what would happen. */
export const host = {
  openFile(repoPath: string, path: string) {
    if (vscode) vscode.postMessage({ type: 'openFile', repoPath, path });
    else window.alert(`In VS Code this opens ${repoPath}/${path}.`);
  },
  openSettings(query = '') {
    if (vscode) vscode.postMessage({ type: 'openSettings', query });
    else window.alert(`In VS Code this opens Settings › Claude Grasp${query ? ` (${query})` : ''}.`);
  },
};

/** Small view preferences (theme, dismissed hints) that survive reloads. */
export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const all = (vscode ? vscode.getState() : JSON.parse(localStorage.getItem('claude-grasp') ?? 'null')) as Record<string, unknown> | null;
      return (all?.[key] as T) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      const all = { ...((vscode ? vscode.getState() : JSON.parse(localStorage.getItem('claude-grasp') ?? 'null')) as Record<string, unknown> | null), [key]: value };
      if (vscode) vscode.setState(all);
      else localStorage.setItem('claude-grasp', JSON.stringify(all));
    } catch {
      // Preferences are a convenience; without storage they reset on reload.
    }
  },
};

export const BUCKET_LABEL: Record<Bucket, string> = { green: 'Understood', yellow: 'Partial', red: 'At risk' };

export function relTime(iso: string | null): string {
  if (!iso) return '—';
  const d = (Date.now() - Date.parse(iso)) / 86_400_000;
  if (d < 1 / 24) return 'just now';
  if (d < 1) return `${Math.round(d * 24)}h ago`;
  if (d < 60) return `${Math.round(d)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const pct = (n: number) => `${Math.round(n * 100)}%`;

export const MARKETPLACE = {
  publisher: 'https://marketplace.visualstudio.com/publishers/Asyncript',
  listing: 'https://marketplace.visualstudio.com/items?itemName=Asyncript.claude-grasp',
};
