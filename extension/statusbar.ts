import * as vscode from 'vscode';
import type { GraspService } from './service';
import { BUCKET_COLOR, BUCKET_LABEL } from './tree';

/** The active file's score, bottom right. Hidden for files Claude never edited. */
export class ScoreStatus {
  private item = vscode.window.createStatusBarItem('claudeGrasp.score', vscode.StatusBarAlignment.Right, 100);

  constructor(private service: GraspService) {
    this.item.name = 'Claude Grasp score';
  }

  update() {
    const doc = vscode.window.activeTextEditor?.document;
    const s = doc?.uri.scheme === 'file' ? this.service.scoreForPath(doc.uri.fsPath) : null;
    if (!s) return this.item.hide();
    this.item.text = `$(lightbulb) ${s.score} ${BUCKET_LABEL[s.bucket]}`;
    this.item.color = new vscode.ThemeColor(BUCKET_COLOR[s.bucket]);
    this.item.tooltip = `Claude Grasp: how well you know ${s.path} (${s.score}/100). Click for why.`;
    this.item.command = { command: 'claudeGrasp.openDashboard', title: 'Why this score', arguments: [`#/repo/${s.repoId}/${encodeURIComponent(s.path)}`] };
    this.item.show();
  }

  dispose() {
    this.item.dispose();
  }
}
