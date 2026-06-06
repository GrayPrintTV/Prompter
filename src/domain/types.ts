export type TranscriptSource = 'mock' | 'openai-realtime' | 'local' | 'manual';

export type TranscriptDelta = {
  text: string;
  isFinal: boolean;
  confidence?: number;
  timestampMs: number;
  source: TranscriptSource;
};

export type AsrStatus = 'idle' | 'starting' | 'listening' | 'error' | 'stopped';

export interface AsrProvider {
  id: string;
  label: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onDelta(callback: (delta: TranscriptDelta) => void): () => void;
  getStatus(): AsrStatus;
}

export type ManuscriptToken = {
  text: string;
  originalText: string;
  tokenIndex: number;
  paragraphIndex: number;
  sentenceIndex: number;
  charStart: number;
  charEnd: number;
};

export type ManuscriptSentence = {
  sentenceIndex: number;
  paragraphIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
  tokenStart: number;
  tokenEnd: number;
};

export type ManuscriptParagraph = {
  paragraphIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
  sentenceStart: number;
  sentenceEnd: number;
};

export type ManuscriptModel = {
  rawText: string;
  paragraphs: ManuscriptParagraph[];
  sentences: ManuscriptSentence[];
  tokens: ManuscriptToken[];
  tokenFrequency: Map<string, number>;
};

export type AlignmentResult = {
  tokenIndex: number;
  sentenceIndex: number;
  paragraphIndex: number;
  confidence: number;
  matchedText: string;
  reason: string;
  diagnostics?: {
    retakeBiasApplied: boolean;
    duplicateJumpPenaltyApplied: boolean;
    duplicateJumpCandidateRejected: boolean;
    selectedDirection: 'backward' | 'forward' | 'overlap';
  };
  searchWindow: {
    fromToken: number;
    toToken: number;
  };
};

export type FollowState =
  | 'manual'
  | 'paused'
  | 'following'
  | 'holding'
  | 'uncertain'
  | 'lost'
  | 'resyncing'
  | 'retake';

export type DisplaySettings = {
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  textWidthCh: number;
  paragraphSpacingEm: number;
  readingZonePercent: number;
  theme: 'dark' | 'light';
};
