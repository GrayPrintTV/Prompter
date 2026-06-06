import type { TortureDiagnosticCode } from './tortureHarness';
import type { FollowState } from './types';

const FAR_AHEAD_PADDING = Array.from(
  { length: 95 },
  (_, index) =>
    `Corridor marker ${index + 1} stayed in sequence while the crew waited for the quiet signal.`
).join(' ');

export const TORTURE_MANUSCRIPT = [
  'Chapter 7: The Narrow Bridge',
  'Dr. Smith checked Room 214 at 6 p.m. The amber recorder clicked twice, and Lina began the test. Lina read the first line with an even voice, then carried the second line across the room.',
  'The brass lantern swung above the map table while the rain counted the windows. Mira closed the red ledger, cursed softly, and started the sentence again. The brass lantern swung above the map table while the rain counted the windows.',
  'The courier crossed the empty platform, ignored the broken clock, and stepped onto the midnight train.',
  'In the narrow hall, she said that was the way of it before the door opened. Later in the narrow hall, she said that was the way of it before the door opened.',
  'Rafe placed the blue enamel compass under the folded chart. He checked the lock, lost his place, and stared at the margin. The crew waited for him to begin again.',
  FAR_AHEAD_PADDING,
  'Far ahead, the captain opened the silver reliquary beneath the northern window.'
].join('\n\n');

export type TortureFixtureExpectation = {
  expectedState: FollowState;
  expectedMovement: 'advance' | 'hold' | 'move-backward' | 'reject-jump';
  diagnosticCode: TortureDiagnosticCode;
  reasonIncludes: string;
  retakeBiasApplied?: boolean;
  duplicateJumpPenaltyApplied?: boolean;
  duplicateJumpCandidateRejected?: boolean;
  minFinalConfidence?: number;
  maxFinalConfidence?: number;
  matchedTextIncludes?: string;
};

export type TortureFixtureCase = {
  id: string;
  label: string;
  description: string;
  manuscriptText: string;
  startTokenSearch?: string;
  startTokenSearchOccurrence?: number;
  chunks: string[];
  expectation: TortureFixtureExpectation;
};

export const TORTURE_FIXTURES: TortureFixtureCase[] = [
  {
    id: 'normal-reading',
    label: 'Normal reading',
    description: 'A clean two-chunk forward read near the expected position.',
    manuscriptText: TORTURE_MANUSCRIPT,
    startTokenSearch: 'the amber recorder clicked twice',
    chunks: ['The amber recorder clicked twice', 'and Lina began the test'],
    expectation: {
      expectedState: 'following',
      expectedMovement: 'advance',
      diagnosticCode: 'moved-high-confidence',
      reasonIncludes: 'Moved on high confidence',
      minFinalConfidence: 0.76,
      matchedTextIncludes: 'Lina began the test'
    }
  },
  {
    id: 'long-pause',
    label: 'Long pause',
    description: 'A silence marker should hold after the previous high-confidence move.',
    manuscriptText: TORTURE_MANUSCRIPT,
    startTokenSearch: 'the amber recorder clicked twice',
    chunks: ['The amber recorder clicked twice', '[pause]'],
    expectation: {
      expectedState: 'holding',
      expectedMovement: 'hold',
      diagnosticCode: 'held-empty-transcript',
      reasonIncludes: 'No transcript words',
      maxFinalConfidence: 0
    }
  },
  {
    id: 'off-script-profanity-slate',
    label: 'Off-script profanity/slate',
    description: 'A slate note with profanity should not move the prompter.',
    manuscriptText: TORTURE_MANUSCRIPT,
    startTokenSearch: 'lina read the first line',
    chunks: ['take four damn it slate note from steve ignore this'],
    expectation: {
      expectedState: 'holding',
      expectedMovement: 'hold',
      diagnosticCode: 'held-low-confidence',
      reasonIncludes: 'generic/short guard',
      maxFinalConfidence: 0.54,
    }
  },
  {
    id: 'repeated-sentence-after-flub',
    label: 'Repeated sentence after flub',
    description: 'A repeated previous sentence should retreat instead of jumping to the later duplicate.',
    manuscriptText: TORTURE_MANUSCRIPT,
    startTokenSearch: 'started the sentence again',
    chunks: ['the brass lantern swung above the map table while the rain counted the windows'],
    expectation: {
      expectedState: 'retake',
      expectedMovement: 'move-backward',
      diagnosticCode: 'moved-high-confidence',
      reasonIncludes: 'retake bias applied',
      retakeBiasApplied: true,
      duplicateJumpPenaltyApplied: true,
      duplicateJumpCandidateRejected: true,
      minFinalConfidence: 0.76,
      matchedTextIncludes: 'brass lantern swung'
    }
  },
  {
    id: 'skipped-phrase',
    label: 'Skipped phrase',
    description: 'Transcript skips several manuscript words but keeps enough ordered anchors to advance.',
    manuscriptText: TORTURE_MANUSCRIPT,
    startTokenSearch: 'the courier crossed the empty platform',
    chunks: ['the courier crossed the platform and stepped onto the midnight train'],
    expectation: {
      expectedState: 'following',
      expectedMovement: 'advance',
      diagnosticCode: 'moved-high-confidence',
      reasonIncludes: 'Moved on high confidence',
      minFinalConfidence: 0.76,
      matchedTextIncludes: 'courier crossed'
    }
  },
  {
    id: 'duplicate-common-phrases',
    label: 'Duplicate common phrases',
    description: 'A repeated common phrase should prefer the occurrence nearest the expected position.',
    manuscriptText: TORTURE_MANUSCRIPT,
    startTokenSearch: 'she said that was the way of it',
    startTokenSearchOccurrence: 1,
    chunks: ['she said that was the way of it before the door opened'],
    expectation: {
      expectedState: 'following',
      expectedMovement: 'advance',
      diagnosticCode: 'moved-high-confidence',
      reasonIncludes: 'near expected position',
      minFinalConfidence: 0.76,
      matchedTextIncludes: 'she said that was the way'
    }
  },
  {
    id: 'backward-retake-local',
    label: 'Backward retake within local window',
    description: 'A distinctive earlier sentence inside the local window should be allowed to retake backward.',
    manuscriptText: TORTURE_MANUSCRIPT,
    startTokenSearch: 'the crew waited for him to begin again',
    chunks: ['Rafe placed the blue enamel compass under the folded chart'],
    expectation: {
      expectedState: 'retake',
      expectedMovement: 'move-backward',
      diagnosticCode: 'moved-high-confidence',
      reasonIncludes: 'backward candidate',
      minFinalConfidence: 0.76,
      matchedTextIncludes: 'blue enamel compass'
    }
  },
  {
    id: 'false-jump-far-ahead',
    label: 'Attempted false jump far ahead',
    description: 'A highly distinctive phrase beyond the forward search window should not move without resync.',
    manuscriptText: TORTURE_MANUSCRIPT,
    startTokenSearch: 'the amber recorder clicked twice',
    chunks: ['the captain opened the silver reliquary beneath the northern window'],
    expectation: {
      expectedState: 'holding',
      expectedMovement: 'reject-jump',
      diagnosticCode: 'held-low-confidence',
      reasonIncludes: 'below 0.76',
      maxFinalConfidence: 0.54,
    }
  },
  {
    id: 'chapter-heading',
    label: 'Chapter heading / section heading',
    description: 'A heading paragraph should align like manuscript text.',
    manuscriptText: TORTURE_MANUSCRIPT,
    startTokenSearch: 'chapter 7 the narrow bridge',
    chunks: ['chapter 7 the narrow bridge'],
    expectation: {
      expectedState: 'following',
      expectedMovement: 'advance',
      diagnosticCode: 'moved-high-confidence',
      reasonIncludes: 'exact phrase bonus',
      minFinalConfidence: 0.76,
      matchedTextIncludes: 'Chapter 7'
    }
  },
  {
    id: 'numbers-abbreviations',
    label: 'Numbers and abbreviations',
    description: 'Conservative spoken number and abbreviation aliases should align with manuscript digits and initials.',
    manuscriptText: TORTURE_MANUSCRIPT,
    startTokenSearch: 'dr smith checked room',
    chunks: ['doctor smith checked room two fourteen at six pm'],
    expectation: {
      expectedState: 'following',
      expectedMovement: 'advance',
      diagnosticCode: 'moved-high-confidence',
      reasonIncludes: 'Moved on high confidence',
      minFinalConfidence: 0.76,
      matchedTextIncludes: 'Dr Smith checked Room 214 at 6 p.m.'
    }
  }
];
