import * as vscode from 'vscode';
import { withPenalties } from '../scoring/config';
import type { GraspConfig } from '../shared/config';

export const SECTION = 'claudeGrasp';

export interface ExtensionSettings {
  config: GraspConfig;
  configDirs: string[];
  quizEnabled: boolean;
  quizReminder: boolean;
  explorerBadges: boolean;
  refreshIntervalMinutes: number;
}

/** `claudeGrasp.*` from the user's settings, mapped onto the scoring and quiz options. */
export function readSettings(): ExtensionSettings {
  const s = vscode.workspace.getConfiguration(SECTION);
  const list = (key: string) => (s.get<unknown[]>(key) ?? []).filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  const text = (key: string) => s.get<string>(key)?.trim() || undefined;
  return {
    config: {
      configDirs: list('configDirs'),
      explainBackDisabled: list('quiz.disabledConfigDirs'),
      claudeBin: text('claudePath'),
      model: text('model'),
      questionsPerDay: s.get<number>('quiz.questionsPerDay', 1),
      scoring: withPenalties({
        bareApproval: s.get<number>('penalties.bareApproval'),
        autoAccept: s.get<number>('penalties.autoAccept'),
        codeVolume: s.get<number>('penalties.codeVolume'),
        failedQuiz: s.get<number>('penalties.failedQuiz'),
        unattended: s.get<number>('penalties.unattended'),
      }),
    },
    configDirs: list('configDirs'),
    quizEnabled: s.get<boolean>('quiz.enabled', false),
    quizReminder: s.get<boolean>('quiz.reminder', true),
    explorerBadges: s.get<boolean>('explorerBadges', true),
    refreshIntervalMinutes: Math.max(0, s.get<number>('refreshIntervalMinutes', 5)),
  };
}

export const openSettings = (query = SECTION) => vscode.commands.executeCommand('workbench.action.openSettings', query.startsWith(SECTION) ? query : `${SECTION}.${query}`);
