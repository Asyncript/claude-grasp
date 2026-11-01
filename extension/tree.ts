import * as vscode from 'vscode';
import type { Bucket } from '../scoring/config';
import type { GraspService } from './service';

export const BUCKET_LABEL: Record<Bucket, string> = { green: 'Understood', yellow: 'Partial', red: 'At risk' };
export const BUCKET_COLOR: Record<Bucket, string> = { green: 'claudeGrasp.understood', yellow: 'claudeGrasp.partial', red: 'claudeGrasp.atRisk' };

type Node =
  | { kind: 'project'; id: number; name: string; path: string; score: number; bucket: Bucket; files: number; accounts: string[] }
  | { kind: 'file'; repoId: number; repoPath: string; path: string; score: number; bucket: Bucket; lines: number };

const icon = (b: Bucket) => new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(BUCKET_COLOR[b]));

/** The "Projects" view: every project Claude edited, then its files, lowest score first. */
export class ProjectsTree implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private service: GraspService) {}

  refresh() {
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.service
        .projects()
        .projects.sort((a, b) => b.summary.linesChanged - a.summary.linesChanged)
        .map((p) => ({ kind: 'project', id: p.id, name: p.name, path: p.path, score: p.summary.score, bucket: p.summary.bucket, files: p.summary.files, accounts: p.accounts.map((a) => a.name) }));
    }
    if (node.kind !== 'project') return [];
    return this.service
      .files(node.id)
      .files.sort((a, b) => a.score - b.score || b.lines - a.lines)
      .map((f) => ({ kind: 'file', repoId: node.id, repoPath: node.path, path: f.path, score: f.score, bucket: f.bucket, lines: f.lines }));
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'project') {
      const item = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${n.score} · ${BUCKET_LABEL[n.bucket]} · ${n.accounts.join(', ')}`;
      item.tooltip = new vscode.MarkdownString(`**${n.name}** — ${n.score}/100 (${BUCKET_LABEL[n.bucket]})\n\n${n.files} files Claude changed · accounts: ${n.accounts.join(', ')}\n\n\`${n.path}\``);
      item.iconPath = icon(n.bucket);
      item.contextValue = 'project';
      item.command = { command: 'claudeGrasp.openDashboard', title: 'Open', arguments: [`#/repo/${n.id}`] };
      return item;
    }
    const name = n.path.split('/').at(-1)!;
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.description = `${n.score} · ${BUCKET_LABEL[n.bucket]}`;
    item.tooltip = `${n.path}\n${n.score}/100 (${BUCKET_LABEL[n.bucket]}) · ${n.lines} lines changed by Claude\nClick for why.`;
    item.iconPath = icon(n.bucket);
    item.resourceUri = vscode.Uri.file(`${n.repoPath}/${n.path}`);
    item.contextValue = 'file';
    item.command = { command: 'claudeGrasp.openDashboard', title: 'Why this score', arguments: [`#/repo/${n.repoId}/${encodeURIComponent(n.path)}`] };
    return item;
  }
}
