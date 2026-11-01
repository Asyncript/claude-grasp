import { hasImage, isObj, textOf, type Obj } from './lines';

/**
 * What a `type: "user"` line actually is. Most of them are not the human typing:
 * tool results, meta lines, compaction summaries, local-command echoes, task
 * notifications, and messages from other agents all share the type.
 */
export type UserLineKind = 'tool_result' | 'human' | 'interrupt' | 'command' | 'meta' | 'agent' | 'empty';

export const INTERRUPT_RE = /^\[Request interrupted by user/;

const COMMAND_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  'Caveat:',
  '<task-notification>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<user-memory-input>',
];

const NON_HUMAN_TURN_ORIGINS = new Set(['peer', 'task_notification', 'scheduled']);

export function classifyUserLine(o: Obj, sidechain = false): UserLineKind {
  const content = isObj(o.message) ? o.message.content : undefined;
  if (Array.isArray(content) && content.some((b) => isObj(b) && b.type === 'tool_result')) return 'tool_result';
  if (sidechain || o.isSidechain === true) return 'agent';
  if (o.isMeta === true || o.isCompactSummary === true || o.isVisibleInTranscriptOnly === true) return 'meta';
  if (o.promptSource === 'system') return 'agent';
  if (typeof o.turnOrigin === 'string' && NON_HUMAN_TURN_ORIGINS.has(o.turnOrigin)) return 'agent';
  if (isObj(o.origin) && typeof o.origin.kind === 'string' && o.origin.kind !== 'human') return 'agent';

  const text = textOf(content).trimStart();
  if (INTERRUPT_RE.test(text)) return 'interrupt';
  if (COMMAND_PREFIXES.some((p) => text.startsWith(p))) return 'command';
  if (!text && !hasImage(content)) return 'empty';
  return 'human';
}

export const isHumanPrompt = (o: Obj, sidechain = false): boolean => classifyUserLine(o, sidechain) === 'human';
