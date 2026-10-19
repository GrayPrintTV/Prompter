export const MANUSCRIPT_PREP_PROTOCOL_VERSION = 1;

export type PrepDraftState = 'ready' | 'review_required' | 'incomplete' | 'failed';
export type PrepDiagnosticSeverity = 'blocking' | 'review_required' | 'check' | 'information';

export type PrepDiagnostic = {
  id: string;
  severity: PrepDiagnosticSeverity;
  category: string;
  message: string;
  suggestedAction?: string;
  blockIds?: string[];
  groupId?: string;
};

export type PrepBlock = {
  id: string;
  position: number;
  type: 'paragraph' | 'heading' | 'note';
  generatedText: string;
  replacementText?: string;
  included: boolean;
  source?: { documentOrder: number; paragraphIndex: number; story: 'body' | 'header' | 'footer' | 'footnote' | 'endnote'; styleId?: string; headingLevel?: number; inTable?: boolean; reviewGroup?: string };
};

export type PrepReviewOperation = {
  operationId: string;
  kind: 'replace_block_text' | 'restore_generated_text' | 'set_block_inclusion' | 'resolve_diagnostic' | 'apply_repetition_rule';
  blockId?: string;
  text?: string;
  included?: boolean;
  reason?: string;
  diagnosticId?: string;
  resolution?: 'keep_included' | 'exclude' | 'reviewed';
  groupId?: string;
};

export type PrepDraft = {
  draftId: string;
  displayName: string;
  state: PrepDraftState;
  route: 'direct';
  revision: number;
  source: { displayName: string; format: 'txt' | 'docx' | 'pdf'; sha256: string; sizeBytes: number };
  blocks: PrepBlock[];
  diagnostics: PrepDiagnostic[];
  reviewOperations: PrepReviewOperation[];
  resolvedDiagnostics?: Record<string, string>;
  createdAt: string;
  incompleteReason?: string;
};

export type PrepApproved = {
  approvedId: string;
  textSha256: string;
  sizeBytes: number;
  approvedAt: string;
  sourceDisplayName: string;
  route: 'direct';
};

export type PrepProjectSummary = {
  projectId: string;
  drafts: Array<Pick<PrepDraft, 'draftId' | 'displayName' | 'state' | 'route' | 'revision' | 'createdAt'>>;
  approved: PrepApproved[];
};

export type PrepOperationError = { code: string; message: string; retryable: boolean };

export type PrepOperationResult<T> = { ok: true; payload: T } | { ok: false; error: PrepOperationError };
