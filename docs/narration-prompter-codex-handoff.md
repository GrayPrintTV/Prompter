# Narration Prompter: Codex Handoff Brief

Version: 0.1  
Date: 2026-06-05  
Target owner: Steve Schaeffer  
Primary build agent: Codex  
Primary platform: Windows 11 desktop  
Product type: Desktop GUI app, not a CLI app

## 1. Executive summary

Build a Windows-first desktop GUI teleprompter for audiobook and voiceover narration. The app displays a known manuscript, listens to the narrator, estimates the current reading position, and advances the displayed text only when confidence is high.

This is not a general speech-recognition app. It is a manuscript-alignment app. Speech-to-text is only one signal. The app already knows the manuscript, so the key technical problem is matching imperfect live transcript fragments to the expected portion of the script.

The first version should be a focused personal tool for narration, not a PromptSmart clone, not a mobile app, not a video recorder, and not a full DAW companion.

## 2. Product decision: GUI, not CLI

The user-facing app must be a desktop GUI.

A CLI may be useful only as a test harness for the alignment engine, for example: feed a transcript file plus manuscript file into the matcher and print alignment results. The production app is a visual teleprompter with large text, microphone status, confidence state, keyboard shortcuts, and Stream Deck-compatible hotkeys.

## 3. Primary goal

The app should let a narrator read a manuscript naturally with minimal manual control.

Success means:

- The current sentence or phrase stays near the configured reading zone.
- The app stops advancing during silence.
- The app stops advancing during off-script speech, profanity, retake notes, or improvisation.
- The app can recover when the narrator repeats a recent sentence after a flub.
- The app can be controlled entirely by keyboard shortcuts or Stream Deck hotkeys.
- The app avoids catastrophic jumps to the wrong part of the manuscript.

## 4. Product principles

1. Do not lose the narrator's place.
2. A conservative freeze is better than a wrong jump.
3. Manual recovery is a first-class feature, not an edge case.
4. Speech recognition is only evidence, not truth.
5. Long-form narration is the design center.
6. Retakes, pickups, false starts, pauses, and line repeats are normal.
7. Local-first and privacy-respecting architecture are preferred.
8. The app must remain useful in manual mode if transcription fails.

## 5. Competitive baseline and differentiation

PromptSmart publicly describes VoiceTrack as automatic scrolling that follows speech, stops during pauses or improvisation, and resumes when the speaker returns to the script. It also markets offline/device-side recognition, privacy, cue points, and audiobook narrator waypoints.

This app should use those public features only as general market context. Do not reverse engineer PromptSmart, copy UI, copy terminology unnecessarily, or depend on any private PromptSmart behavior.

Differentiation for this app:

- Narrator-first instead of presenter-first.
- Desktop-first instead of mobile-first.
- Retake-aware behavior.
- Conservative alignment.
- Visible confidence state.
- Stream Deck-compatible keyboard controls.
- Long-manuscript stability.
- Debuggable alignment internals.

## 6. Explicit non-goals for the first version

Do not build these in Phase 0 or Phase 1:

- Mobile app.
- Video recording.
- Cloud sync.
- Login/accounts/subscriptions.
- Producer control room.
- Remote display system.
- Collaboration.
- PDF OCR.
- Full DAW integration.
- AI rewriting.
- Spoken command mode.
- Commercial PromptSmart competitor polish.

## 7. Recommended technology stack

Recommended starting stack:

- Electron desktop app.
- React front end.
- TypeScript everywhere.
- Vite for development/build tooling.
- Local JSON project files for app state.
- Vitest for unit tests.
- Playwright or similar later for UI tests.

Rationale:

Electron is heavier than Tauri, but it is straightforward for a desktop GUI with multiple windows, keyboard shortcuts, file import, microphone access, and rapid Codex-assisted iteration. Speed of iteration matters more than binary size for this project.

Avoid making the app depend on the browser Web Speech API as the primary transcription layer. MDN currently marks SpeechRecognition as limited availability and notes that some browsers, including Chrome, may use server-based recognition where audio is sent to a web service and does not work offline. Electron also has a history of Web Speech API problems. Treat Web Speech API as optional experiment only, not the foundation.

Preferred ASR path:

- Phase 0: Mock ASR adapter plus transcript injection harness, so the aligner can be built and tested without live speech.
- Phase 1: OpenAI Realtime transcription adapter or another streaming ASR provider behind an interface.
- Phase 2: Local/offline ASR adapter, such as Whisper/Vosk-style local recognition, if packaging and latency are acceptable.

## 8. Architecture overview

Separate the app into these modules from day one:

1. GUI shell
2. Manuscript ingestion and normalization
3. ASR provider interface
4. Alignment engine
5. Scroll controller
6. Project/session persistence
7. Shortcut/control layer
8. Debug/diagnostic layer

The ASR provider must be swappable. Do not couple the UI or alignment code to any specific transcription provider.

### 8.1 Suggested TypeScript interfaces

```ts
export type TranscriptDelta = {
  text: string;
  isFinal: boolean;
  confidence?: number;
  timestampMs: number;
  source: 'mock' | 'openai-realtime' | 'local' | 'manual';
};

export interface AsrProvider {
  id: string;
  label: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onDelta(callback: (delta: TranscriptDelta) => void): () => void;
  getStatus(): AsrStatus;
}

export type AsrStatus =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'error'
  | 'stopped';

export type ManuscriptToken = {
  text: string;
  originalText: string;
  tokenIndex: number;
  paragraphIndex: number;
  sentenceIndex: number;
  charStart: number;
  charEnd: number;
};

export type AlignmentResult = {
  tokenIndex: number;
  sentenceIndex: number;
  paragraphIndex: number;
  confidence: number;
  matchedText: string;
  reason: string;
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
```

## 9. Core user interface

### 9.1 Control window

The control window should include:

- Import/paste manuscript.
- Project open/save.
- Start/stop listening.
- Follow/manual mode toggle.
- Current state: Following, Holding, Uncertain, Lost, Paused, Manual, Resyncing, Retake.
- Confidence indicator.
- Microphone/input selector.
- Input level meter.
- Current paragraph/sentence position.
- Debug transcript panel, visible only in development/debug mode.
- Search box for manuscript phrase search.
- Settings panel.

For Phase 0, a single window with control panel plus prompter pane is acceptable. By Phase 1, support a separate clean prompter window.

### 9.2 Prompter window

The prompter window should include:

- Large, clean manuscript display.
- Full-screen option.
- Always-on-top option.
- Font size, font family, line height, width, margins, paragraph spacing.
- Dark and light themes.
- Reading zone position, default lower-middle.
- Current sentence highlighting.
- Optional current phrase highlighting.
- No clutter in recording mode.

Later support:

- Horizontal and vertical mirroring for physical teleprompter glass.
- Multi-display selection.

## 10. Manuscript import and normalization

Phase 0 must support:

- Paste plain text.
- Import TXT.

Phase 1 should support:

- DOCX import.
- Local project file save/load.
- Manuscripts at least 100,000 words.
- Paragraph preservation.
- Sentence segmentation.
- Search by phrase.
- Cue points/bookmarks.

Defer:

- PDF support unless text extraction is trivial.
- OCR.
- Google Docs integration.

Normalization requirements:

- Lowercase.
- Normalize curly quotes and straight quotes.
- Normalize apostrophes.
- Remove or soften punctuation for matching.
- Collapse whitespace.
- Keep sentence and paragraph boundaries.
- Keep a mapping from normalized tokens back to original display positions.
- Preserve the original manuscript for display.

Optional later:

- Number normalization, for example `2026` to `twenty twenty-six` and `two thousand twenty-six`.
- Abbreviation normalization.
- Custom pronunciation/alias dictionary.

## 11. Alignment engine requirements

The alignment engine is the core product.

### 11.1 Basic behavior

The engine receives transcript deltas, maintains a rolling buffer of recent recognized words, and fuzzy-matches those words against the normalized manuscript.

The engine should normally search only near the current expected position:

- Default backward window: 300 words.
- Default forward window: 800 words.
- Wider search only when the user presses Resync or when the app has been Lost for several seconds.

Large jumps should require either very high confidence or explicit user action.

### 11.2 Scoring requirements

The score should consider:

- Number of matched words.
- Order of matched words.
- Proximity to current position.
- Rarity/distinctiveness of words.
- Penalty for common words.
- Penalty for large jumps.
- Penalty for matching only one or two generic words.
- Bonus for exact phrase matches.
- Bonus for matching within the expected forward region.
- Allowance for missing words and ASR substitutions.

The engine should not move based on one common word.

### 11.3 Retake and pickup behavior

The app must handle narration messiness:

- Flub line, curse, repeat same sentence.
- Say off-script slate notes.
- Pause for several seconds.
- Restart from previous sentence.
- Skip a word or phrase.
- Repeat a phrase that appears elsewhere in the manuscript.

Minimum Phase 1 behavior:

- Freeze on low confidence.
- If a repeated recent sentence is detected with high confidence, move back to it.
- Provide manual hotkeys for back one sentence, forward one sentence, back paragraph, forward paragraph.
- Provide Resync hotkey that temporarily broadens search.

Do not implement spoken commands in the MVP.

## 12. Scroll controller requirements

Do not directly scroll on every transcript update.

Maintain two separate concepts:

1. Estimated reading position.
2. Visual scroll position.

When confidence is high and stable, smoothly scroll toward the estimated reading position.

When confidence is medium, hold or move slowly.

When confidence is low, freeze.

When silence is detected, freeze.

When off-script speech is detected, freeze.

The app must prefer stable behavior over twitchy precision.

## 13. Keyboard and Stream Deck controls

Every important action must have a keyboard shortcut. Stream Deck support can initially be achieved through normal hotkey mapping.

Required shortcuts:

- Start/stop listening.
- Toggle follow/manual.
- Pause/resume.
- Back one sentence.
- Forward one sentence.
- Back one paragraph.
- Forward one paragraph.
- Previous cue point.
- Next cue point.
- Resync from latest transcript.
- Mark cue point.
- Search.
- Increase font size.
- Decrease font size.
- Toggle full screen.
- Toggle debug panel.

Direct Stream Deck plugin support is not needed for Phase 0 or Phase 1.

## 14. Audio input requirements

The app must not interfere with DAW recording.

Requirements:

- Let user choose an input device.
- Do not require exclusive control of the mic.
- Support standard microphone input.
- Support virtual audio devices or duplicated mic feeds later.
- Display an input level meter.
- Warn if no signal is detected.
- Keep listening and transcription decoupled from DAW recording.

## 15. ASR provider requirements

Build ASR as an adapter interface.

Required providers:

1. MockAsrProvider for testing. It accepts pasted or scripted transcript chunks and emits TranscriptDelta events.
2. ManualAsrProvider for development. It lets the user type transcript fragments into a box to test alignment.

Recommended first live provider:

- OpenAI Realtime transcription adapter using transcription sessions, if the user has an API key available.

OpenAI's Realtime transcription docs describe streaming transcript deltas for live speech-to-text, with `gpt-realtime-whisper` as the low-latency streaming transcription path. Realtime transcription sessions can connect over WebSocket for server-side audio pipelines or WebRTC for browser audio.

Important implementation note:

- Do not expose API keys in the renderer process.
- For personal local use, load API key from environment or local config in the Electron main process.
- For commercial distribution, use a backend or ephemeral key system.

## 16. Project and persistence requirements

Persist:

- Manuscript text.
- Project title.
- Current token/sentence/paragraph position.
- Display settings.
- Shortcut settings.
- Cue points.
- ASR provider setting.
- Last opened project.

Use simple local JSON project files initially.

Autosave session state periodically and on exit.

## 17. Debug and diagnostics

Include a developer/debug panel with:

- Last transcript delta.
- Rolling transcript buffer.
- Current token index.
- Current sentence index.
- Best candidate match.
- Confidence score.
- Follow state.
- Search window.
- Reason string from alignment engine.

This is necessary for tuning the aligner.

## 18. Testing requirements

Unit tests:

- Text normalization.
- Tokenization.
- Sentence segmentation.
- Fuzzy alignment.
- Duplicate phrase handling.
- Retake/backward matching.
- Off-script speech handling.
- Confidence threshold behavior.

Create fixtures:

- A short manuscript with repeated phrases.
- A long manuscript fixture, generated if needed.
- Transcript chunks with pauses.
- Transcript chunks with flubs.
- Transcript chunks with curse/restart behavior.
- Transcript chunks with skipped words.
- Transcript chunks with duplicate phrase traps.

Manual acceptance tests:

1. Load a 50,000-word manuscript.
2. Start reading and keep the current sentence in the reading zone for 5 minutes.
3. Pause for 10 seconds without scrolling.
4. Say an off-script phrase and do not scroll.
5. Repeat the previous sentence and either hold correctly or return to that sentence.
6. Use one shortcut to move back one sentence.
7. Use one shortcut to move forward one paragraph.
8. Search for a phrase and jump there.
9. Close and reopen the project at the same position.
10. Use the app while a DAW is recording without breaking the recording chain.

## 19. Suggested repository structure

```txt
narration-prompter/
  README.md
  package.json
  vite.config.ts
  electron/
    main.ts
    preload.ts
    asr/
      AsrProvider.ts
      MockAsrProvider.ts
      ManualAsrProvider.ts
      OpenAiRealtimeAsrProvider.ts
  src/
    App.tsx
    components/
      ControlPanel.tsx
      PrompterView.tsx
      DebugPanel.tsx
      StatusIndicator.tsx
      ShortcutHelp.tsx
    domain/
      manuscript.ts
      normalize.ts
      tokenize.ts
      segment.ts
      alignment.ts
      scrollModel.ts
      types.ts
    state/
      appStore.ts
      projectStore.ts
    shortcuts/
      shortcuts.ts
    persistence/
      projectFile.ts
    tests/
      normalize.test.ts
      alignment.test.ts
      fixtures/
        short-manuscript.txt
        repeated-phrases.txt
        transcript-flubs.json
```

## 20. Phase plan

### Phase 0: Alignment and GUI proof of concept

Goal: prove the concept without live ASR dependency.

Build:

- Electron + React + TypeScript app.
- Paste/import TXT manuscript.
- Prompter display.
- Manual transcript injection box.
- Mock ASR transcript playback.
- Tokenization and normalization.
- Local-window fuzzy aligner.
- Confidence indicator.
- Smooth scrolling when confidence is high.
- Freeze when confidence is low.
- Manual back/forward sentence controls.
- Basic debug panel.
- Unit tests for aligner.

Phase 0 done when:

- A scripted transcript can drive the prompter through a manuscript.
- Off-script chunks do not advance the prompter.
- Repeated recent sentence chunks can hold or move backward conservatively.
- Keyboard shortcuts work.

### Phase 1: Personal MVP with live transcription

Build:

- Live ASR provider behind the AsrProvider interface.
- Mic/input selector.
- Input level meter.
- Project save/load.
- DOCX import.
- Cue points.
- Search and jump.
- Separate prompter window.
- Font/display settings.
- Autosave current position.

Phase 1 done when:

- Steve can use it for a real narration test session.
- Manual recovery is fast enough to avoid irritation.
- The app fails by freezing rather than jumping.

### Phase 2: Narrator-grade hardening

Build:

- Better retake mode.
- Offline/local ASR option.
- More robust duplicate phrase handling.
- Stream Deck profile.
- Long-session stability testing.
- Multi-display support.
- Teleprompter glass mirroring.
- Better manuscript cleanup tools.

## 21. First task for Codex

Paste the following into Codex as the first task:

```txt
Build Phase 0 of the Narration Prompter app described in docs/narration-prompter-codex-handoff.md.

Create a Windows-first Electron + React + TypeScript desktop GUI app. This is not a CLI app. The first version does not need live microphone transcription. Instead, implement a Mock ASR provider and a manual transcript injection panel so we can test manuscript alignment before adding real ASR.

Requirements for this task:

1. Create the app scaffold with Electron, React, TypeScript, Vite, and Vitest.
2. Implement a prompter view that displays pasted or imported TXT manuscript text in large readable type.
3. Implement manuscript normalization, tokenization, sentence indexing, and paragraph indexing.
4. Implement a fuzzy alignment engine that matches rolling transcript fragments against a bounded local manuscript window.
5. Implement confidence states: following, holding, uncertain, lost, paused, manual, resyncing, retake.
6. Implement smooth scrolling only when confidence is high. Freeze when confidence is low.
7. Add manual controls and keyboard shortcuts for back/forward sentence, back/forward paragraph, pause/resume, toggle follow/manual, and resync.
8. Add a debug panel showing transcript buffer, best match, confidence, current token index, search window, and reason string.
9. Add unit tests for normalization and alignment, including repeated phrases, off-script chunks, skipped words, and retake behavior.
10. Add README instructions for running, testing, and using the mock transcript system.

Do not implement live ASR yet. Do not implement PDF import. Do not implement mobile, cloud sync, accounts, video recording, or spoken commands.

Make reasonable default choices when unspecified. Keep the architecture modular so an OpenAI Realtime transcription provider can be added later behind an AsrProvider interface.
```

## 22. Second task for Codex

After Phase 0 works, use this as the next task:

```txt
Add Phase 1 live transcription support to the existing Narration Prompter app.

Use the existing AsrProvider interface. Add an OpenAI Realtime transcription provider in the Electron main process or another safe boundary so API keys are not exposed in the renderer. Load the API key from local environment/config only. Add a microphone/input selector and input level meter. Wire transcript deltas into the existing alignment engine without changing the alignment engine's public API.

Keep MockAsrProvider and ManualAsrProvider working. Add tests or mocks so the app can still be tested without network access or an API key.

Do not remove the conservative behavior: low confidence freezes; large jumps require explicit resync or very high confidence.
```

## 23. Design risks and mitigations

### Risk: ASR is unreliable or unavailable

Mitigation: Make ASR swappable. Build the aligner and GUI with Mock ASR first.

### Risk: Web Speech API fails in Electron

Mitigation: Do not rely on Web Speech API as the primary provider. Treat it only as optional experiment.

### Risk: The app jumps to the wrong duplicate phrase

Mitigation: Search locally, penalize large jumps, require high confidence, expose resync as explicit user action.

### Risk: The app interferes with DAW recording

Mitigation: Never require exclusive input device access. Support selectable inputs and virtual/duplicated inputs.

### Risk: Auto-scroll is twitchy

Mitigation: Separate estimated reading position from visual scroll position. Smooth the visual motion and freeze when uncertain.

### Risk: Commercial IP exposure

Mitigation: This is an independent tool based on known-script alignment. Do not copy PromptSmart UI or behavior details. Get legal review before commercial distribution.

## 24. Source references

These sources informed the handoff brief:

- OpenAI Codex Quickstart: https://developers.openai.com/codex/quickstart
- OpenAI Codex IDE extension: https://developers.openai.com/codex/ide
- OpenAI Realtime transcription: https://developers.openai.com/api/docs/guides/realtime-transcription
- OpenAI Speech to text guide: https://developers.openai.com/api/docs/guides/speech-to-text
- MDN SpeechRecognition: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- PromptSmart public homepage: https://promptsmart.com/

