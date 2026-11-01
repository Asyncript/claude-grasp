import * as vscode from 'vscode';
import type { GraspService } from './service';
import { BUCKET_LABEL } from './tree';

/** Above the first line of a file Claude edited: its score, and a way to say you read the changes. */
export class ScoreLens implements vscode.CodeLensProvider {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private service: GraspService, public enabled: boolean) {}

  refresh() {
    this.changed.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.enabled || doc.uri.scheme !== 'file') return [];
    const s = this.service.scoreForPath(doc.uri.fsPath);
    if (!s) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(top, {
        title: `$(lightbulb) Grasp ${s.score} · ${BUCKET_LABEL[s.bucket]}`,
        tooltip: `How well you know ${s.path}. Click for every point behind it.`,
        command: 'claudeGrasp.openDashboard',
        arguments: [`#/repo/${s.repoId}/${encodeURIComponent(s.path)}`],
      }),
      s.reviewDue
        ? new vscode.CodeLens(top, { title: 'Mark as reviewed', tooltip: "You read Claude's latest changes to this file", command: 'claudeGrasp.markReviewed', arguments: [doc.uri] })
        : new vscode.CodeLens(top, { title: '$(check) Reviewed', tooltip: 'No Claude changes since you last marked it reviewed', command: '' }),
    ];
  }

  dispose() {
    this.changed.dispose();
  }
}
