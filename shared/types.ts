/** How an edit got approved. Taken from the tool result's permissionDecision, else inferred from the permission mode. */
export type Approval = 'user' | 'classifier' | 'mode' | 'rule' | 'bypass' | 'unrecorded';

/** human: a typed prompt that starts a turn. The rest are engagement events inside a turn. */
export type PromptKind = 'human' | 'answer' | 'interrupt' | 'rejection';

export type FileRefKind = 'ide_open' | 'ide_select' | 'external_edit' | 'rejected_edit';

export interface PromptEvent {
  uuid: string;
  ts: string;
  turnId: string | null;
  kind: PromptKind;
  /** Words the human typed. Pasted blocks are counted separately in pastedWords. */
  words: number;
  pastedWords: number;
  isBare: boolean;
  isQuestion: boolean;
  isCorrection: boolean;
  excerpt: string;
  mentions: string[];
}

export interface EditEvent {
  toolUseId: string;
  ts: string;
  turnId: string | null;
  tool: string;
  filePath: string;
  added: number;
  removed: number;
  created: boolean;
  approval: Approval;
  permissionMode: string | null;
  sidechain: boolean;
  symbols: string[];
}

export interface PlanEvent {
  toolUseId: string;
  ts: string;
  turnId: string | null;
  outcome: 'approved' | 'rejected';
  planEdited: boolean;
}

export interface FileRefEvent {
  ts: string;
  turnId: string | null;
  filePath: string;
  kind: FileRefKind;
}
