# Narration Prompter

Windows-first Electron + React desktop teleprompter for audiobook and voiceover narration. Phase 0 proves manuscript alignment without live microphone transcription.

## What works in Phase 0

- Paste or import TXT/Markdown manuscript text.
- Large prompter view with current sentence highlighting.
- Manual transcript injection for alignment testing.
- Mock ASR playback from scripted transcript chunks.
- Conservative fuzzy alignment against a local manuscript window.
- Confidence states: following, holding, uncertain, lost, paused, manual, resyncing, retake.
- Smooth scrolling only on high-confidence alignment.
- Manual sentence and paragraph recovery controls.
- Keyboard shortcuts suitable for Stream Deck hotkey mapping.
- Debug panel with transcript buffer, match, confidence, token position, search window, and reason.
- Developer torture-test harness for stepping or autoplaying simulated transcript chunks against the current manuscript.
- Unit tests for normalization and alignment edge cases.

## Install

```powershell
npm install
```

## Run

```powershell
npm run dev
```

The dev script starts Vite, compiles the Electron main process, and opens the desktop app.

## Test

```powershell
npm test
```

## Build

```powershell
npm run build
npm start
```

## Legacy Codex environment workaround

Prefer normal Node.js/npm installed on Windows. Older Codex desktop shells may not expose `npm` on `PATH`; in that case only, use the local bundled runtime path for this machine:

```powershell
$env:PATH = 'C:\Users\fmgee\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
& 'C:\Users\fmgee\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' '.tools\npm\bin\npm-cli.js' install
& 'C:\Users\fmgee\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' '.tools\npm\bin\npm-cli.js' run dev
```

## Mock transcript system

Use the Mock Playback box to enter one transcript chunk per line, then press `Play Mock`. Blank lines or `[pause]` simulate silence. Off-script chunks should hold the prompter instead of moving it.

The Manual Transcript box emits a single transcript delta. Press `Ctrl+Enter` inside the box or click `Inject Transcript`.

## Alignment torture-test harness

Use the `Torture Test` panel to stress-test the aligner without live ASR:

1. Pick a fixture from the dropdown and click `Load Case`, or paste transcript chunks directly into the panel.
2. Click `Step` to process one transcript chunk at a time.
3. Click `Auto` to autoplay the sequence, and adjust `Delay` for chunk timing.
4. Click `Reset` to rerun the sequence from the fixture start point.
5. Click `Start Current` to run the current script against the app's current manuscript position.

After each chunk, the panel shows the raw chunk, normalized transcript tokens, best manuscript match, confidence score, previous/new/alignment positions, app state, diagnostic code, search window, and movement or hold reason.

Included fixtures cover normal reading, long pauses, off-script profanity/slate notes, repeated sentence flubs, skipped phrases, duplicate common phrases, local backward retakes, false jumps far ahead, chapter headings, and numbers/abbreviations.

Phase 0.5 alignment hardening covers the repeated-sentence-after-flub fixture, duplicate common phrases, and conservative number/abbreviation forms such as `two fourteen`, `twenty twenty-six`, `doctor`, and `p.m.`. The diagnostics call out when retake bias or duplicate/jump penalties affect candidate selection.

## Keyboard shortcuts

- `Ctrl+Alt+L`: start/stop listening
- `Ctrl+Alt+F`: toggle follow/manual
- `Ctrl+Alt+P`: pause/resume
- `Alt+Left` / `Alt+Right`: back/forward one sentence
- `Alt+Up` / `Alt+Down`: back/forward one paragraph
- `Ctrl+Alt+R`: resync using a wider search on the next transcript chunk
- `Ctrl+F`: search
- `Ctrl+=` / `Ctrl+-`: increase/decrease font size
- `F11`: toggle full screen
- `Ctrl+``: toggle debug panel

## Architecture

- `electron/`: desktop shell, preload bridge, file dialog, window controls.
- `src/asr/`: swappable ASR provider interface plus mock/manual providers.
- `src/domain/`: normalization, segmentation, tokenization, alignment, and scroll policy.
- `src/components/`: control panel, prompter view, status, shortcuts, and debug UI.
- `src/state/`: defaults and local session persistence.
- `src/tests/`: Vitest coverage and fixtures.

Live ASR is intentionally not implemented in Phase 0. The OpenAI Realtime provider can be added later behind the existing ASR provider boundary without changing the alignment engine API.
