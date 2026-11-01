import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { openDb } from '../db';
import { demoShiftMs, prepareDemo } from '../demo/prepare';
import { localDay } from '../explain/today';
import { FakeQuizModel, quizModel } from '../llm';
import { configDirs, dbPath, demoDir, setGraspHome, setPackageRoot } from '../shared/paths';
import { ScoreBadges } from './decorations';
import { Dashboard } from './panel';
import { GraspService } from './service';
import { openSettings, readSettings, SECTION } from './settings';
import { ScoreStatus } from './statusbar';
import { ProjectsTree } from './tree';

/**
 * The extension keeps its data in VS Code's global storage. A database from the earlier
 * command-line version (~/.claude-grasp) is copied over once, so nothing is read twice.
 */
function useStorage(context: vscode.ExtensionContext) {
  const home = context.globalStorageUri.fsPath;
  mkdirSync(home, { recursive: true });
  setGraspHome(home);
  setPackageRoot(context.extensionPath);
  const legacy = join(homedir(), '.claude-grasp', 'claude-grasp.db');
  if (!existsSync(dbPath()) && existsSync(legacy)) {
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(legacy + suffix)) copyFileSync(legacy + suffix, dbPath() + suffix);
  }
}

export async function start(context: vscode.ExtensionContext) {
  useStorage(context);
  let settings = readSettings();
  const version = String((context.extension.packageJSON as { version?: string }).version ?? '');

  const service = new GraspService({
    db: openDb(dbPath()),
    config: settings.config,
    model: quizModel(settings.config, false),
    roots: () => configDirs([], settings.configDirs.length ? settings.configDirs : undefined),
    demo: false,
    quizEnabled: settings.quizEnabled,
    version,
  });

  let demo: GraspService | null = null;
  const openDemo = async () => {
    if (!demo) {
      const file = dbPath(true);
      for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
      const { roots } = prepareDemo(demoDir(), demoShiftMs());
      demo = new GraspService({ db: openDb(file), config: {}, model: new FakeQuizModel(), roots: () => roots, demo: true, quizEnabled: true, version });
      await demo.ingest();
    }
    Dashboard.show(context, demo);
  };

  const tree = new ProjectsTree(service);
  const badges = new ScoreBadges(service, settings.explorerBadges);
  const status = new ScoreStatus(service);
  let pending: NodeJS.Timeout | undefined;
  // Several changes in a row (ingest, then a settings change) re-score once.
  const redraw = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      tree.refresh();
      badges.refresh();
      status.update();
    }, 200);
  };

  const refresh = (quiet = true) =>
    vscode.window.withProgress({ location: quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title: 'Claude Grasp: reading new Claude Code sessions…' }, async () => {
      try {
        const s = await service.ingest();
        if (!quiet) void vscode.window.showInformationMessage(`Claude Grasp: ${s.parsed} sessions read, ${s.edits} new edits, ${s.commits} new commits.`);
        if (s.errors.length) console.warn('Claude Grasp ingest errors', s.errors.slice(0, 20));
        void remind();
      } catch (e) {
        void vscode.window.showErrorMessage(`Claude Grasp: ${(e as Error).message}`);
      }
    });

  // At most once a day, and only when the quiz is on and there is something to ask about.
  const remind = async () => {
    const day = localDay();
    if (!settings.quizEnabled || !settings.quizReminder || context.globalState.get('reminded') === day) return;
    const today = service.today();
    if (!today.files.length || today.dataDay !== day || today.quiz?.questions.every((q) => q.answer !== null || q.skipped)) return;
    await context.globalState.update('reminded', day);
    const pick = await vscode.window.showInformationMessage('Claude Grasp: one quick question about the code Claude wrote today?', 'Answer', 'Not today', 'Turn off reminders');
    if (pick === 'Answer') Dashboard.show(context, service, '#/today');
    if (pick === 'Turn off reminders') await vscode.workspace.getConfiguration(SECTION).update('quiz.reminder', false, vscode.ConfigurationTarget.Global);
  };

  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearInterval(timer);
    if (settings.refreshIntervalMinutes > 0) timer = setInterval(() => void refresh(), settings.refreshIntervalMinutes * 60_000);
  };

  const show = (route?: unknown) => Dashboard.show(context, service, typeof route === 'string' ? route : '');
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudeGrasp.projects', tree),
    vscode.window.registerFileDecorationProvider(badges),
    status,
    { dispose: service.onDidChange(redraw) },
    { dispose: () => clearInterval(timer) },
    vscode.window.onDidChangeActiveTextEditor(() => status.update()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      const before = settings;
      settings = readSettings();
      badges.enabled = settings.explorerBadges;
      service.update({ config: settings.config, model: quizModel(settings.config, false), quizEnabled: settings.quizEnabled });
      if (before.refreshIntervalMinutes !== settings.refreshIntervalMinutes) schedule();
      if (before.configDirs.join('\n') !== settings.configDirs.join('\n')) void refresh();
    }),
    vscode.commands.registerCommand('claudeGrasp.openDashboard', show),
    vscode.commands.registerCommand('claudeGrasp.refresh', () => refresh(false)),
    vscode.commands.registerCommand('claudeGrasp.showFileScore', (uri?: unknown) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      const s = target?.scheme === 'file' ? service.scoreForPath(target.fsPath) : null;
      if (!s) return vscode.window.showInformationMessage('Claude Grasp: Claude Code never edited this file, so it has no score.');
      show(`#/repo/${s.repoId}/${encodeURIComponent(s.path)}`);
    }),
    vscode.commands.registerCommand('claudeGrasp.openToday', () => show('#/today')),
    vscode.commands.registerCommand('claudeGrasp.openGuide', () => show('#/guide')),
    vscode.commands.registerCommand('claudeGrasp.openAbout', () => show('#/about')),
    vscode.commands.registerCommand('claudeGrasp.openSettings', () => openSettings()),
    vscode.commands.registerCommand('claudeGrasp.openDemo', () => openDemo().catch((e: Error) => vscode.window.showErrorMessage(`Claude Grasp demo: ${e.message}`))),
  );

  schedule();
  redraw();
  await refresh();
}
