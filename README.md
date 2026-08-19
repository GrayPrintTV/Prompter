# Narration Prompter

Windows-first Electron + React desktop teleprompter for audiobook and voiceover narration. Local Whisper is the intended live narration provider, with Manual and Mock input available for testing and recovery.

Future coding agents should start with `AGENTS.md` and `docs/current-state.md` before changing code.

## What works in Phase 0

- Paste manuscript text or import TXT, Markdown, DOCX, and selectable-text PDF files.
- Large prompter view with an optional current sentence highlight.
- Manual transcript injection for alignment testing.
- Mock ASR playback from scripted transcript chunks.
- Local Whisper transcription using a Python faster-whisper sidecar.
- Conservative fuzzy alignment against a local manuscript window.
- Confidence states: following, holding, uncertain, lost, paused, manual, resyncing, retake.
- Fixed reading band with custom smooth scrolling only on high-confidence alignment.
- Manual sentence and paragraph recovery controls.
- Keyboard shortcuts suitable for Stream Deck hotkey mapping.
- Developer-mode debug panel with transcript buffer, match, confidence, token position, search window, and reason.
- Developer-mode torture-test harness for stepping or autoplaying simulated transcript chunks against the current manuscript.
- Prompter-first narration mode with a minimal Start/Stop/status/mic-level overlay and hideable controls.
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

## Package an unpacked Windows build

```powershell
npm run package:dir
npm run package:self-contained
npm run package:portable
```

`package:dir` creates an unpacked x64 production build under `release/win-unpacked`. It first builds the PyInstaller Local Whisper sidecar and stages the cached `base.en` model into ignored build output so the unpacked app can run Local Whisper without Python or a Hugging Face cache.

`package:self-contained` runs `package:dir`, validates the packaged sidecar/model resources, and runs the sidecar JSONL smoke test. `package:portable` creates `release/Prompter-win-unpacked.zip` from that unpacked directory. The installer command is reserved as `npm run package:win` for a later packaging pass.

## Daily UI and Advanced mode

Fresh sessions open with Advanced mode off. The normal Controls area follows a narrator workflow: open or edit a manuscript, choose a narration mode, use Start / Pause / Stop, optionally pair a tablet, recover the spoken position, and adjust the reading display.

Local Whisper is the intended live provider and is the default when its basic Python/model settings are present. Mock and OpenAI Realtime are hidden from the normal provider list. OpenAI Realtime remains parked and only appears when its experimental flag is enabled and Developer mode is on.

Use `Open Advanced` at the bottom of the controls or `Ctrl+Shift+D` to reveal troubleshooting controls. Advanced mode contains Mock playback, Manual transcript injection, Local Whisper draft settings, bridge/sidecar/chunk counters, transcript history, raw confidence and penalty diagnostics, Movement decision history, scroll proof controls, Reading Lookahead, Correction feel, shortcuts, torture tests, and the Debug panel. `Ctrl+`` toggles the dense Debug panel after Advanced mode is enabled.

## Experimental OpenAI Realtime

OpenAI Realtime is parked as an experimental comparison path. It is disabled by default and absent from the normal provider list. Normal use does not require an OpenAI API key or network access; use Local Whisper for live narration.

Developers explicitly testing the retained provider can enable it in an ignored `.env.local` file, then fully restart Electron:

```powershell
OPENAI_REALTIME_ENABLED=true
OPENAI_API_KEY=replace-with-your-openai-api-key
OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-realtime-whisper
OPENAI_REALTIME_LANGUAGE=en
OPENAI_REALTIME_TRANSCRIPTION_PROMPT=
```

When enabled, it appears in Developer mode as `Live OpenAI Realtime (Experimental)`. Electron main owns the permanent API key and OpenAI network exchange; keys, authorization headers, and prompts are not logged or stored in renderer state. Do not commit `.env.local`; it is ignored by git.

## Local Whisper transcription

Local Whisper is the intended live provider and runs through this repo's sidecar, not the separate audiobook proofing tool. It captures microphone audio as local PCM, encodes short WAV chunks in the renderer, sends them to Electron main, and Electron main sends temporary `.wav` files to the sidecar. In development, Electron launches `python/local_whisper_sidecar.py` through the configured Python executable. In packaged builds, Electron launches the bundled `resources/whisper-sidecar/whisper-sidecar.exe` and passes the bundled model path under `resources/models/base.en` with local-only loading. The sidecar uses faster-whisper and returns transcript chunks in the same `TranscriptDelta` shape used by Manual and Mock.

The Local Whisper defaults are tuned for conservative CPU live following:

- Python executable: `python`
- Whisper model: `base.en`
- Device: `cpu`
- Compute type: `int8`
- Chunk duration: `2` seconds

Live testing has generally favored `base.en / cpu / int8 / 2s` over `turbo` or `tiny.en` for this near-live prompter use.

Install development sidecar dependencies in a Python environment:

```powershell
python -m pip install -r python/requirements.txt
```

The self-contained packaging pass is locked by `python/requirements-whisper-lock.txt` and expects the working project virtual environment at `.venv\Scripts\python.exe` unless `LOCAL_WHISPER_BUILD_PYTHON` is set. The packaged app ignores `LOCAL_WHISPER_PYTHON_EXECUTABLE` during normal use and always uses the bundled sidecar.

Fresh sessions default to `Local Whisper` in the provider dropdown when the Python path and model name are present. Developer mode contains the Local Whisper settings panel for adjusting the Python path, model, device, compute type, and chunk duration. A little chunk latency is expected; the aligner only needs enough recognized words every sentence or two.

Use the always-visible top bar `Start` button or the normal Controls `Start Listening` button for narration. It starts microphone monitoring and following as needed for the selected provider. `Stop` stops transcription/following and returns the narration state to Idle. Developer mode still exposes separate Mic Monitor controls for diagnostics.

Local Whisper settings in Developer mode are draft settings. Typing into Python/model/device/compute/chunk fields does not silently change a running sidecar. Use `Apply` while stopped, or `Restart Whisper` while following; when following is active, the UI labels draft edits as applying after restart.

Normal mode shows compact Local Whisper status such as `Local Whisper ready`, `Starting`, `Listening`, `Mic not detected`, or `Needs resync`, plus the latest heard phrase. Developer mode shows mic state, selected/default input label when Chromium exposes it, sidecar phase, chunk counters, chunk format, MIME type, extension, first-byte header signature such as `RIFF/WAVE`, sample rate, duration, last transcript text, recent ASR transcript history under `Heard`, and warnings for missing PCM/WAV chunks or sidecar response timeouts. Empty Whisper returns are shown as `[empty transcript]` so silence is visible instead of looking like nothing happened. Provider status messages such as `Sidecar is running` are diagnostics only and should not appear in `Heard`, `Last delta`, or feed the aligner.

The sidecar distinguishes process startup from model readiness. `Process started` means Python is running and answering JSONL. `Model loading` means faster-whisper is loading the requested model. `Ready` means the model is loaded and transcription chunks can be processed. The model-ready timeout defaults to 180 seconds and can be overridden with:

```powershell
$env:LOCAL_WHISPER_MODEL_READY_TIMEOUT_MS = "240000"
```

For development diagnostics, the Python executable can also be overridden without changing saved UI settings:

```powershell
$env:LOCAL_WHISPER_PYTHON_EXECUTABLE = "C:\Path\To\python.exe"
```

Run the Local Whisper sidecar self-test without Electron:

```powershell
python python/local_whisper_sidecar.py --self-test --model base.en --device cpu --compute-type int8
```

The self-test verifies Python starts, imports faster-whisper, loads the requested model, generates a small WAV file, and asks faster-whisper to decode/transcribe it. A silent or tone fixture may produce an empty transcript; `wavDecoded: true` is the important decode check.

In Developer mode, the bridge diagnostics show whether the renderer can see Electron preload IPC:

- `Electron bridge`: `window.prompterApi` is available.
- `Whisper bridge`: Local Whisper preload methods are available.
- `IPC handlers`: Electron main answered the bridge diagnostic call.
- `prompterApi` / `ping`: renderer startup checks for `window.prompterApi.ping() -> pong`.
- `App path`, `CWD`, `Main dir`, `Preload`, `Preload exists`, `Dev mode`, and `Dev URL`: Electron main runtime paths printed in the terminal and surfaced in the UI.
- `Preload status` / `Preload error`: whether preload started, exposed the API, or threw while exposing it.

If `Whisper bridge` is `No`, `Start Listening` is disabled and the app shows `Local Whisper bridge unavailable. Are you running inside Electron?`. Mic Monitor can still work in a browser-like renderer because it only uses `getUserMedia`, but transcription needs the Electron preload/main bridge.

After changing `electron/main.ts`, `electron/preload.cts`, Electron build config, or the dev launcher, stop `npm run dev`, close the Electron window, and restart `npm run dev`. Renderer hot reload is not enough for preload/main-process changes.

If `Start Listening` fails before the app asks for microphone permission, check the Local Whisper error and mic diagnostics first. A Python path, missing `faster-whisper` install, or sidecar startup failure is reported as setup failure before `getUserMedia`.

## Legacy Codex environment workaround

Prefer normal Node.js/npm installed on Windows. Older Codex desktop shells may not expose `npm` on `PATH`; in that case only, use the local bundled runtime path for this machine:

```powershell
$env:PATH = 'C:\Users\fmgee\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
& 'C:\Users\fmgee\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' '.tools\npm\bin\npm-cli.js' install
& 'C:\Users\fmgee\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' '.tools\npm\bin\npm-cli.js' run dev
```

## Mock transcript system

Turn on Developer mode to use the Mock Playback box. Enter one transcript chunk per line, then press `Play Mock`. Blank lines or `[pause]` simulate silence. Off-script chunks should hold the prompter instead of moving it.

The Developer-mode Manual Transcript box emits a single transcript delta. Press `Ctrl+Enter` inside the box or click `Inject Transcript`.

## Audition manuscript import

The manuscript editor remains available for text copied from ACX or another audition page. `Import file` accepts TXT, Markdown, DOCX, and PDF files through the Electron file picker. DOCX paragraphs are extracted in document order. PDF import reads embedded/selectable text and joins obvious visual line wraps while retaining larger paragraph gaps where practical.

`Add extra spacing between imported lines` is enabled by default in the Manuscript panel. It applies narrator-friendly blank-line spacing to pasted text and imported files without changing punctuation or the token sequence used for alignment. The cleanup is idempotent, so reprocessing text does not keep adding blank lines.

PDF OCR is intentionally out of scope. Image-only or scanned PDFs show: `No selectable text found in this PDF. Try copy/paste or OCR first.` File reading and document parsing stay in Electron main; the renderer receives only the imported filename, format, and extracted text.

The current manuscript, project title, display settings, and token/sentence/paragraph position continue to save in local session storage and restore on launch. This is last-session restoration, not a project library.

## Prompter reading zone

The prompter uses a fixed horizontal reading band inside the visible manuscript pane. Fresh sessions default the band higher on screen (`readingZonePercent: 38`). The Display controls label this as `38% down from top`; lower values move the band higher and higher values move it lower.

When follow mode advances with high confidence, the manuscript scrolls underneath the fixed band so the top edge of the active sentence lands inside the band. First and last manuscript lines have dynamic spacer padding so they can also align to the same band. Display controls show the current reading-band percent, provide a slider, number input, `Move up` / `Move down` buttons, and a reset button for the default band position.

Active sentence highlighting is optional and defaults off for fresh sessions so the fixed band remains the primary narrator cue. If enabled, the highlight is intentionally subtle. Older saved display settings that placed the band in the lower half are migrated once to the narration default; later manual adjustments persist normally.

Scrolling is controlled by a `requestAnimationFrame` animation loop rather than browser native smooth scrolling. Correction scrolls move confirmed ASR/alignment anchors into the reading band with a deterministic cubic ease-in-out plan: from scrollTop, target scrollTop, duration, easing curve, and Correction feel are logged in the trace. Duration is derived from distance and the Correction feel slider, clamped to roughly 450-2200 ms, and in-flight updates retarget from the current physical scroll position.

Developer mode includes proof buttons for the physical scroll engine: `Test smooth scroll: 1 line`, `5 lines`, `15 lines`, and `Reset test scroll position`. The 1/5/15-line buttons do not use ASR or alignment; they send measured scroll requests through the same correction-scroll engine live following uses, so you can tune the motion independently. Reset is a direct jump back to the top for setup. Developer mode also shows the latest motion status, including reduced-motion state, distance, duration, easing, Correction feel, and frame count. Systems with `prefers-reduced-motion` enabled use minimal motion and make that visible in the trace log.

Optional `Assist Scroll` is a predictive cruise layer and remains off by default. When enabled, recent high-confidence `following` matches become correction anchors; the prompter estimates reading pace from confirmed target movement and keeps the manuscript moving gently between ASR chunks. The normal Display panel includes Assist Scroll on/off and Assist speed (`Slower` / `Faster`); Developer mode adds Correction feel (`Gentle` / `Firm`). Assist cruise slows when Local Whisper is lagging, decays when confidence becomes stale, and stops on holding, lost, paused, manual, retake, or low confidence. Active sentence highlighting can also be hidden from the Display controls.

Developer mode includes a compact `Movement decision` diagnostic area. It shows the latest confirmed manuscript token, proposed lookahead target, prior fresh anchor, token/line delta, current Reading Lookahead, time since the last high-confidence anchor, a 160 WPM diagnostic pace prior, expected progress corridor, confidence, retake/duplicate/jump penalty flags when available, final outcome, plain-English reason, and the last 10 movement decisions. The 160 WPM value is observability only; it does not force scrolling or change alignment acceptance.

## Narration mode

During narration, the left control panel can be hidden with the top-bar `Hide Controls` button or `Ctrl+Alt+C`. The prompter remains full-screen with an always-visible top bar containing:

- `Start` / `Stop`
- selected provider and narration state: Idle, Starting, Listening, Following, Holding, Lagging, or Error
- mic level meter
- key warning text when something needs attention
- `Controls` to bring back the normal panel

If the app starts with controls hidden from a saved preference, it should still open into the same prompter-only view. The top bar `Controls` button and `Ctrl+Alt+C` restore the normal panel, and the app automatically restores controls if hidden mode ever produces an invalid prompter pane size.

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
- `Ctrl+Alt+C`: show/hide controls
- `Ctrl+Shift+D`: toggle Developer mode
- `Ctrl+F`: search
- `Ctrl+=` / `Ctrl+-`: increase/decrease font size
- `F11`: toggle full screen
- `Ctrl+``: toggle debug panel while Developer mode is enabled

## Architecture

- `electron/`: desktop shell, preload bridge, file dialog, window controls.
- `src/asr/`: swappable ASR provider interface plus Manual, Mock, Local Whisper, and a default-off experimental OpenAI Realtime provider.
- `src/domain/`: normalization, segmentation, tokenization, alignment, and scroll policy.
- `src/components/`: control panel, prompter view, status, shortcuts, and debug UI.
- `src/state/`: defaults and local session persistence.
- `src/tests/`: Vitest coverage and fixtures.

ASR is implemented behind a swappable provider boundary. The alignment engine receives the same transcript delta shape from Manual, Mock, and Local Whisper; the parked OpenAI comparison path uses the same boundary only when explicitly enabled.
