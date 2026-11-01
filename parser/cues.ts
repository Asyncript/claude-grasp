// Word lists and patterns used to classify human prompts. Tune here; scoring weights live in scoring/.
// Includes a few romanized Bangla cues seen in real prompts.

/** A prompt made only of these words (at most MAX_BARE_WORDS of them) is a bare approval. */
export const BARE_APPROVAL_WORDS = new Set([
  'ok', 'okay', 'okk', 'k', 'kk', 'yes', 'y', 'yep', 'yup', 'yeah', 'ya', 'sure', 'continue', 'cont', 'go',
  'ahead', 'proceed', 'do', 'it', 'lgtm', 'looks', 'look', 'good', 'great', 'nice', 'fine', 'next', 'task',
  'approved', 'approve', 'accept', 'accepted', 'thanks', 'thank', 'you', 'ty', 'please', 'pls', 'plz', 'carry',
  'on', 'keep', 'going', 'cool', 'perfect', 'alright', 'right', 'done', 'ship', 'sounds', 'works', 'lets', 'let',
  'start', 'now', 'and', 'then', 'hmm', 'accha', 'acha', 'thik', 'ache', 'ase', 'koro', 'kor', 'haan', 'ha', 'ji',
]);

export const MAX_BARE_WORDS = 6;

export const QUESTION_PATTERNS: RegExp[] = [
  /\bwhy\b/i,
  /\bhow (come|does|do|did|is|are|was|would|will|can|could|should)\b/i,
  /\bwhat (if|happens|happened|does|did|would)\b/i,
  /\bwhat(?:'s| is) the (reason|point|difference|purpose)\b/i,
  /\b(explain|walk me through|help me understand)\b/i,
  /\bwhere (is|does|do|would|should)\b/i,
  /\b(keno|kivabe|kibhabe|kemne|ki hobe|ki hoy)\b/i,
];

export const CORRECTION_PATTERNS: RegExp[] = [
  /^(no|nope|nah|na|wait)\b/i,
  /\b(don't|dont|do not|instead|wrong|incorrect|revert|undo|roll ?back|rather than|shouldn't|should not|stop)\b/i,
  /\b(not what i|that's not|thats not|not right|doesn't work|does not work|isn't working|not working|broke|broken)\b/i,
  /\b(vul|bhul|hocche na|hoyni|hoy ni|thik na)\b/i,
];
