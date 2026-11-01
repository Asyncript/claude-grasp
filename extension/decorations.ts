import * as vscode from 'vscode';
import type { GraspService, PathScore } from './service';
import { BUCKET_COLOR, BUCKET_LABEL } from './tree';

/** A score badge on every file Claude edited, in the Explorer and on editor tabs. */
export class ScoreBadges implements vscode.FileDecorationProvider {
  private changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private scores: Map<string, PathScore> | null = null;

  constructor(private service: GraspService, public enabled: boolean) {}

  refresh() {
    this.scores = null;
    this.changed.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.enabled || uri.scheme !== 'file') return undefined;
    this.scores ??= this.service.allScores();
    const s = this.scores.get(uri.fsPath);
    if (!s) return undefined;
    // Badges hold at most two characters.
    return new vscode.FileDecoration(s.score >= 100 ? '✓' : String(s.score), `Claude Grasp: ${s.score}/100 · ${BUCKET_LABEL[s.bucket]}`, new vscode.ThemeColor(BUCKET_COLOR[s.bucket]));
  }
}
