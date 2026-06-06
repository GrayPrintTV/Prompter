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
- Unit tests for normalization and alignment edge cases.

## Install

```powershell
npm install
```

If `npm` is not on PATH in this Codex desktop environment, use the local bootstrap that was created during setup:

```powershell
$env:PATH = 'C:\Users\fmgee\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
& 'C:\Users\fmgee\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' '.tools\npm\bin\npm-cli.js' install
```

## Run

```powershell
npm run dev
```

The dev script starts Vite, compiles the Electron main process, and opens the desktop app.

With the local npm bootstrap:

```powershell
$env:PATH = 'C:\Users\fmgee\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
& 'C:\Users\fmgee\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' '.tools\npm\bin\npm-cli.js' run dev
```

## Test

```powershell
npm test
```

## Build

```powershell
npm run build
npm start
```

## Mock transcript system

Use the Mock Playback box to enter one transcript chunk per line, then press `Play Mock`. Blank lines or `[pause]` simulate silence. Off-script chunks should hold the prompter instead of moving it.

The Manual Transcript box emits a single transcript delta. Press `Ctrl+Enter` inside the box or click `Inject Transcript`.

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
