import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { GraspService } from './service';
import { openSettings } from './settings';

/** Messages the dashboard may send besides RPC calls. */
type HostMessage =
  | { id: number; method: string; params?: unknown[] }
  | { type: 'openFile'; repoPath: string; path: string }
  | { type: 'openSettings'; query?: string };

/** The dashboard, in an editor tab. One per service (your data, and the demo). */
export class Dashboard {
  private static open = new Map<GraspService, Dashboard>();

  static show(context: vscode.ExtensionContext, service: GraspService, route = ''): Dashboard {
    const existing = Dashboard.open.get(service);
    if (existing) {
      existing.panel.reveal();
      if (route) void existing.panel.webview.postMessage({ type: 'navigate', route });
      return existing;
    }
    const d = new Dashboard(context, service, route);
    Dashboard.open.set(service, d);
    return d;
  }

  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(context: vscode.ExtensionContext, private service: GraspService, route: string) {
    const root = vscode.Uri.file(join(context.extensionPath, 'dist', 'webview'));
    this.panel = vscode.window.createWebviewPanel('claudeGrasp.dashboard', service.demo ? 'Claude Grasp (demo)' : 'Claude Grasp', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [root],
    });
    this.panel.iconPath = vscode.Uri.file(join(context.extensionPath, 'media', 'icon.png'));
    this.panel.webview.html = html(this.panel.webview, root, route);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: HostMessage) => this.receive(m)),
      { dispose: service.onDidChange(() => void this.panel.webview.postMessage({ type: 'changed' })) },
    );
    this.panel.onDidDispose(() => {
      Dashboard.open.delete(service);
      for (const d of this.disposables) d.dispose();
    });
  }

  private async receive(m: HostMessage) {
    if ('id' in m) {
      try {
        const result = await this.service.rpc(m.method, m.params ?? []);
        void this.panel.webview.postMessage({ id: m.id, result });
      } catch (e) {
        void this.panel.webview.postMessage({ id: m.id, error: (e as Error).message });
      }
      return;
    }
    if (m.type === 'openSettings') void openSettings(m.query);
    if (m.type === 'openFile' && typeof m.repoPath === 'string' && typeof m.path === 'string') {
      // Only files inside a project Claude Grasp knows, never an arbitrary path from the page.
      const known = this.service.projects().projects.some((p) => p.path === m.repoPath);
      if (!known || m.path.split('/').includes('..')) return;
      void vscode.window.showTextDocument(vscode.Uri.file(join(m.repoPath, ...m.path.split('/'))), { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }
  }
}

function html(webview: vscode.Webview, root: vscode.Uri, route: string): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', f)).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    // Svelte sets inline style attributes (treemap positions, colors).
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('index.css')}">
<title>Claude Grasp</title>
</head>
<body>
<div id="app" data-route="${attr(route)}"></div>
<script type="module" nonce="${nonce}" src="${asset('index.js')}"></script>
</body>
</html>`;
}
