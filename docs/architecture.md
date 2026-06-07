# Architecture

## Electron Main, Preload, and Renderer

Electron main lives in `electron/main.ts`. It creates the BrowserWindow, registers IPC handlers, owns file dialogs and window controls, reads local environment config, owns OpenAI Realtime secret-bearing setup, and owns the Local Whisper Python sidecar process.

Preload lives in `electron/preload.cts`. It is intentionally CommonJS-compatible and builds to `dist-electron/preload.cjs`, because Electron loads preload scripts through `require()`. It exposes `window.prompterApi` through `contextBridge` and provides `ping() -> "pong"` plus bridge diagnostics. Keep `contextIsolation: true`, `nodeIntegration: false`, and the current sandbox setting stable unless a task explicitly changes the preload strategy.

The renderer is the React app under `src/`. It must not receive permanent API keys or direct Node access. It uses `window.prompterApi` only for trusted Electron capabilities and IPC-backed providers.

## ASR Provider Boundary

ASR providers implement the common provider shape in `src/asr/`. Providers emit `TranscriptDelta` objects and expose status to the UI. The app currently has:

- `ManualAsrProvider`.
- `MockAsrProvider`.
- `OpenAiRealtimeAsrProvider`.
- `LocalWhisperAsrProvider`.

Provider selection is handled through `src/asr/providerRegistry.ts`. Manual and Mock must remain available even when live providers fail.

## TranscriptDelta Flow

All ASR providers emit transcript chunks as `TranscriptDelta`:

- `text`: recognized transcript text.
- `isFinal`: final/interim marker.
- `timestampMs`: provider timestamp.
- `source`: `manual`, `mock`, `openai-realtime`, or `local-whisper`.
- `confidence`: optional provider confidence.

`src/App.tsx` subscribes to provider deltas, normalizes transcript text into tokens, appends to the rolling buffer, and calls the alignment engine.

## Local Whisper Sidecar Flow

1. Renderer Local Whisper provider requests/holds microphone access for Mic Monitor.
2. Start Following captures microphone samples with Web Audio.
3. Renderer accumulates a few seconds of mono PCM and encodes each chunk as WAV.
4. Renderer sends WAV payloads over `window.prompterApi.transcribeLocalWhisperChunk`.
5. Electron main writes each chunk to a temporary `.wav` file under the OS temp directory.
6. Electron main starts or reuses `python/local_whisper_sidecar.py`.
7. Main sends JSONL commands to sidecar stdin with format, MIME, byte-size, sample-rate, duration, and header diagnostics.
8. Sidecar uses faster-whisper and returns JSONL transcript responses on stdout.
9. Main returns transcript text to renderer.
10. Renderer emits a normal `TranscriptDelta` with source `local-whisper`.
11. The same alignment engine processes the result.

The sidecar is chunk-based and may be delayed. Word-level realtime behavior is not required yet.

Sidecar readiness has two separate stages. `ready` from the Python process means the process is alive and accepting JSONL. `model-loaded` means faster-whisper has loaded the requested model and transcription can begin.

## OpenAI Realtime Flow

1. Electron main reads `.env.local`, `.env`, or process environment.
2. Renderer asks main for configuration status.
3. If configured, renderer asks main for an ephemeral OpenAI Realtime client secret.
4. Main uses the real `OPENAI_API_KEY`; renderer never receives it.
5. Renderer opens the WebRTC session using the ephemeral client secret.
6. Realtime transcript events are converted into normal `TranscriptDelta` objects.

## Alignment Engine Flow

The alignment engine lives in `src/domain/alignment.ts` and related domain modules. It receives normalized transcript tokens and searches within a bounded manuscript window around the current token. It scores candidates conservatively, penalizes false jumps and duplicate traps, supports retake/backward matching, and returns an `AlignmentResult`.

`src/domain/scrollModel.ts` maps alignment confidence and movement into follow states such as following, holding, uncertain, lost, paused, manual, resyncing, and retake.

## UI and Debug Flow

`src/components/ControlPanel.tsx` owns the main controls, ASR provider status, Mic Monitor controls, Local Whisper counters, and Heard transcript history.

`src/components/NarrationBar.tsx` is the always-visible narration overlay. It exposes the primary Start/Stop control, provider/status label, mic level meter, key warning text, and controls toggle.

`src/components/PrompterView.tsx` renders the manuscript pane. It owns the fixed reading-band overlay and scroll animation refs. Reading-zone geometry and scroll-step math live in `src/domain/prompterScroll.ts` so the component can keep animation state out of React state while still being testable. The scroll controller has two motion paths: correction scroll, which moves confirmed ASR/alignment anchors into the band, and optional Assist Scroll cruise, which predicts near-future reading position between recent high-confidence anchors.

Narration status labels are derived in `src/domain/narrationStatus.ts` from provider/follow/mic/lag/error inputs. This keeps UI labels such as Idle, Starting, Following, Holding, Lagging, and Error separate from ASR provider internals.

`src/components/DebugPanel.tsx` shows transcript buffer, current token, best match, confidence, follow state, search window, and reason.

`src/components/TortureTestPanel.tsx` runs simulated transcript chunks through the alignment harness for reproducible failure cases.

## Settings Storage

Local session state is stored in renderer `localStorage` through `src/state/projectStore.ts`. Stored fields include project title, manuscript text, current position, display settings, selected ASR provider, applied Local Whisper settings, mock script, and debug panel visibility. Controls visibility is stored as a separate local convenience preference.

Secrets must not be stored in localStorage. OpenAI API keys belong in environment variables or ignored local env files read by Electron main.
