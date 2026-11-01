/** Claude Code's commit trailer. Matched on the address, since the model name in it changes. */
export const CLAUDE_TRAILER_RE = /^co-authored-by:.*noreply@anthropic\.com/im;

export function isClaudeCommit(body: string, authorEmail = ''): boolean {
  return CLAUDE_TRAILER_RE.test(body) || authorEmail.toLowerCase() === 'noreply@anthropic.com';
}

/**
 * claude: has the trailer. human: no trailer and no Claude edit explains it.
 * ambiguous: no trailer, but Claude edited the file since the previous commit,
 * so the commit may just be Claude's work committed without a trailer.
 * prior: before Claude ever touched the file, so it says nothing about later understanding.
 */
export type CommitAttribution = 'claude' | 'human' | 'ambiguous' | 'prior';

export interface FileCommit {
  sha: string;
  ts: number;
  isClaude: boolean;
}

/**
 * Attributes each commit that touched one file.
 * @param commits that file's commits, any order
 * @param claudeEditTimes when transcripts show Claude editing that file (ms)
 */
export function attributeFileCommits(commits: FileCommit[], claudeEditTimes: number[]) {
  const sorted = [...commits].sort((a, b) => a.ts - b.ts);
  const edits = [...claudeEditTimes].sort((a, b) => a - b);
  const firstClaude = Math.min(edits[0] ?? Infinity, sorted.find((c) => c.isClaude)?.ts ?? Infinity);
  return sorted.map((c, i) => {
    let attribution: CommitAttribution;
    if (c.isClaude) attribution = 'claude';
    else if (c.ts < firstClaude) attribution = 'prior';
    else {
      const prevTs = i > 0 ? sorted[i - 1]!.ts : -Infinity;
      const explained = edits.some((t) => t > prevTs && t <= c.ts);
      attribution = explained ? 'ambiguous' : 'human';
    }
    return { ...c, attribution };
  });
}
