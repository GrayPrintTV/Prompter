# Narration Prompter

Windows-first Electron + React desktop teleprompter for audiobook and voiceover narration. Phase 1 adds optional live OpenAI Realtime transcription behind the same alignment engine used by manual and mock transcript input.

## What works in Phase 0

- Paste or import TXT/Markdown manuscript text.
- Large prompter view with current sentence highlighting.
- Manual transcript injection for alignment testing.
- Mock ASR playback from scripted transcript chunks.
- Optional live OpenAI Realtime transcription provider, disabled until configured.
- Optional Local Whisper transcription provider using a Python faster-whisper sidecar.
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

## Live OpenAI Realtime transcription

Live ASR is optional. Manual transcript injection and Mock Playback continue to work without an API key.

1. Copy `.env.example` to `.env.local`.
2. Set `OPENAI_API_KEY` in `.env.local` or in the Windows environment.
3. Restart the Electron app.
4. Select `Live OpenAI Realtime` in the ASR Provider dropdown.
5. Press `Start` and allow microphone access.

The renderer never receives the real OpenAI API key. Electron main reads environment/local config and requests a short-lived Realtime client secret over IPC. The renderer uses that ephemeral client secret for the WebRTC microphone session and emits normal `TranscriptDelta` objects into the existing aligner.

Supported local config values:

```powershell
OPENAI_API_KEY=replace-with-your-openai-api-key
OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-4o-transcribe
OPENAI_REALTIME_LANGUAGE=en
OPENAI_REALTIME_TRANSCRIPTION_PROMPT=
```

Do not commit `.env.local`; it is ignored by git.

## Local Whisper transcription

Local Whisper is optional and runs through this repo's Python sidecar, not the separate audiobook proofing tool. It records short microphone chunks in the renderer, sends them to Electron main, and Electron main sends temporary audio files to `python/local_whisper_sidecar.py`. The sidecar uses faster-whisper and returns transcript chunks in the same `TranscriptDelta` shape used by Manual, Mock, and OpenAI Realtime.

The defaults match the existing proofing tool's local setup closely:

- Python executable: `python`
- Whisper model: `turbo`
- Device: `cpu`
- Compute type: `int8`
- Chunk duration: `4` seconds

Install sidecar dependencies in a Python environment:

```powershell
python -m pip install -r python/requirements.txt
```

Then select `Local Whisper` in the ASR Provider dropdown. The settings panel lets you adjust the Python path, model, device, compute type, and chunk duration. A little chunk latency is expected; the aligner only needs enough recognized words every sentence or two.

Use `Start Monitor` first. Mic Monitor only requests microphone access and holds the input stream for the live level meter; it does not start Whisper transcription or move the prompter. When the meter is moving, press `Start Following` to start MediaRecorder chunking, send chunks through Electron main to the Python sidecar, receive transcript text, and feed normal transcript deltas into the existing aligner. `Stop Following` stops transcription and following, but leaves Mic Monitor visible/running when it was started separately.

The Local Whisper panel shows mic state, selected/default input label when Chromium exposes it, sidecar phase, chunk counters, last chunk size, last transcript text, recent ASR transcript history under `Heard`, and warnings for missing MediaRecorder chunks or sidecar response timeouts. Empty Whisper returns are shown as `[empty transcript]` so silence is visible instead of looking like nothing happened.

The bridge diagnostics show whether the renderer can see Electron preload IPC:

- `Electron bridge`: `window.prompterApi` is available.
- `Whisper bridge`: Local Whisper preload methods are available.
- `IPC handlers`: Electron main answered the bridge diagnostic call.
- `prompterApi` / `ping`: renderer startup checks for `window.prompterApi.ping() -> pong`.
- `App path`, `CWD`, `Main dir`, `Preload`, `Preload exists`, `Dev mode`, and `Dev URL`: Electron main runtime paths printed in the terminal and surfaced in the UI.
- `Preload status` / `Preload error`: whether preload started, exposed the API, or threw while exposing it.

If `Whisper bridge` is `No`, `Start Following` is disabled and the app shows `Local Whisper bridge unavailable. Are you running inside Electron?`. Mic Monitor can still work in a browser-like renderer because it only uses `getUserMedia`, but transcription needs the Electron preload/main bridge.

After changing `electron/main.ts`, `electron/preload.ts`, or the dev launcher, stop `npm run dev`, close the Electron window, and restart `npm run dev`. Renderer hot reload is not enough for preload/main-process changes.

If `Start Following` fails before the app asks for microphone permission, check the Local Whisper error and mic diagnostics first. A Python path, missing `faster-whisper` install, or sidecar startup failure is reported as setup failure before `getUserMedia`.

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
- `src/asr/`: swappable ASR provider interface plus manual, mock, live OpenAI Realtime, and Local Whisper providers.
- `src/domain/`: normalization, segmentation, tokenization, alignment, and scroll policy.
- `src/components/`: control panel, prompter view, status, shortcuts, and debug UI.
- `src/state/`: defaults and local session persistence.
- `src/tests/`: Vitest coverage and fixtures.

Live ASR is implemented as a swappable provider behind the existing ASR boundary. The alignment engine receives the same transcript delta shape from manual, mock, and live providers.
