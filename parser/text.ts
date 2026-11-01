import type { FileRefKind } from '../shared/types';
import { BARE_APPROVAL_WORDS, CORRECTION_PATTERNS, MAX_BARE_WORDS, QUESTION_PATTERNS } from './cues';
import { arr, isObj, str } from './lines';

export const EXCERPT_CHARS = 300;

const TAG_RE = /<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics)>([\s\S]*?)<\/\1>/g;
const PASTED_RE = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content\b[^>]*>/g;
const ABS_PATH_RE = /(\/[^\s:'"`<>]+)/;

/**
 * Strips injected tags from a prompt and returns the files the IDE tags pointed at.
 * Pasted blocks (specs, logs) are removed too and only counted: they aren't the human's own
 * words, and their "do not"/"how"/file paths would otherwise look like engagement.
 */
export function cleanPromptText(raw: string): { text: string; pastedWords: number; ideFiles: { path: string; kind: FileRefKind }[] } {
  const ideFiles: { path: string; kind: FileRefKind }[] = [];
  let pastedWords = 0;
  const text = raw
    .replace(PASTED_RE, (_m, body: string) => {
      pastedWords += wordCount(body);
      return ' ';
    })
    .replace(TAG_RE, (_m, tag: string, body: string) => {
      if (tag === 'ide_opened_file' || tag === 'ide_selection') {
        const path = body.match(ABS_PATH_RE)?.[1]?.replace(/[.,;)]+$/, '');
        if (path) ideFiles.push({ path, kind: tag === 'ide_selection' ? 'ide_select' : 'ide_open' });
      }
      return ' ';
    })
    .trim();
  return { text, pastedWords, ideFiles };
}

export const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export function isBareApproval(text: string): boolean {
  if (!text.trim()) return false;
  const words = text
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // Emoji- or punctuation-only replies ("👍", "!") are approvals too.
  if (words.length === 0) return true;
  return words.length <= MAX_BARE_WORDS && words.every((w) => BARE_APPROVAL_WORDS.has(w));
}

export const isQuestion = (text: string): boolean => QUESTION_PATTERNS.some((re) => re.test(text));

export const isCorrection = (text: string): boolean => CORRECTION_PATTERNS.some((re) => re.test(text));

const TICK_RE = /`([^`\n]{2,80})`/g;
const PATH_RE = /(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,5}\b/g;
const CALL_RE = /\b([A-Za-z_$][\w$]{2,})\s*\(/g;
const IDENT_RE = /\b(?:[a-z]+[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g;

/** Tokens that might name a file or symbol. Matched against real files and symbols during scoring. */
export function extractMentions(text: string, limit = 40): string[] {
  const found = new Set<string>();
  const add = (s: string | undefined) => {
    const t = s?.trim().replace(/[.,;:]+$/, '');
    if (t && t.length >= 3 && found.size < limit) found.add(t);
  };
  for (const m of text.matchAll(TICK_RE)) add(m[1]);
  for (const m of text.matchAll(PATH_RE)) add(m[0]);
  for (const m of text.matchAll(CALL_RE)) add(m[1]);
  for (const m of text.matchAll(IDENT_RE)) add(m[0]);
  return [...found];
}

const DECL_RES = [
  /\b(?:function\*?|class|interface|type|enum|def|func|fn|struct|trait)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
];
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor']);

/** Names declared on changed lines, so prompts that mention a function can be linked to the file. */
export function extractSymbols(lines: string[], limit = 30): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    for (const re of DECL_RES) {
      const name = line.match(re)?.[1];
      if (name && !NOT_NAMES.has(name)) found.add(name);
    }
    if (found.size >= limit) break;
  }
  return [...found].slice(0, limit);
}

export const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));

/** Counts +/- lines in structuredPatch-style hunks and returns the changed lines without their prefix. */
export function countPatch(hunks: unknown[]): { added: number; removed: number; changed: string[] } {
  let added = 0;
  let removed = 0;
  const changed: string[] = [];
  for (const h of hunks) {
    if (!isObj(h)) continue;
    for (const l of arr(h.lines)) {
      const line = str(l);
      if (!line) continue;
      if (line[0] === '+') added++;
      else if (line[0] === '-') removed++;
      else continue;
      changed.push(line.slice(1));
    }
  }
  return { added, removed, changed };
}

export function promptFeatures(text: string) {
  return {
    words: wordCount(text),
    isBare: isBareApproval(text),
    isQuestion: isQuestion(text),
    isCorrection: isCorrection(text),
    excerpt: text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS),
    mentions: extractMentions(text),
  };
}
