// Defensive accessors for transcript lines. Transcripts are an undocumented format,
// so nothing here assumes a field exists or has the expected type.

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseLine(raw: string): Obj | null {
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** Text of a message content field: either a plain string or the text blocks of a block array. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .map((b) => (isObj(b) && b.type === 'text' ? (str(b.text) ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

export const hasImage = (content: unknown): boolean => arr(content).some((b) => isObj(b) && b.type === 'image');
