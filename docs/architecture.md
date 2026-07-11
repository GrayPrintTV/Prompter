# Architecture

## Electron Main, Preload, and Renderer

Electron main lives in `electron/main.ts`. It creates the BrowserWindow, registers IPC handlers, owns file dialogs and window controls, and owns the Local Whisper Python sidecar through a dedicated service. It also contains the default-off experimental OpenAI Realtime network boundary.

The sidecar process implementation is isolated in `electron/whisper/WhisperTranscriptionService.ts`. Electron main supplies runtime paths, Electron `userData`/temp locations, diagnostics, and renderer status publication; the service exclusively owns spawn, JSONL parsing, readiness/model state, pending transcription requests, temporary audio cleanup, and shutdown. The service has no `BrowserWindow` dependency and can later be called by an Electron-hosted tablet server without exposing the Python JSONL protocol externally.

Manuscript file import is also owned by Electron main. The picker accepts TXT, Markdown, DOCX, and PDF; `electron/manuscriptImport.ts` reads the selected path, uses Mammoth for DOCX paragraph text and PDF.js for embedded PDF text, normalizes the result, and returns only safe import metadata and text through preload IPC. The renderer applies the persisted narrator-spacing preference through the same character-preserving cleanup used for pasted text. The renderer never receives unrestricted filesystem access. PDF OCR is not part of this flow.

Electron main also persists desktop window state under Electron `userData`: validated normal bounds are stored separately from the maximized flag, then startup creates the window at the saved normal bounds and maximizes it after creation when requested. Full-screen state is not persisted.

Preload lives in `electron/preload.cts`. It is intentionally CommonJS-compatible and builds to `dist-electron/preload.cjs`, because Electron loads preload scripts through `require()`. It exposes `window.prompterApi` through `contextBridge` and provides `ping() -> "pong"` plus bridge diagnostics. Keep `contextIsolation: true`, `nodeIntegration: false`, and the current sandbox setting stable unless a task explicitly changes the preload strategy.

The renderer is the React app under `src/`. It must not receive permanent API keys or direct Node access. It uses `window.prompterApi` only for trusted Electron capabilities and IPC-backed providers.

## ASR Provider Boundary

ASR providers implement the common provider shape in `src/asr/`. Providers emit `TranscriptDelta` objects and expose status to the UI. The app currently has:

- `ManualAsrProvider`.
- `MockAsrProvider`.
- `OpenAiRealtimeAsrProvider`.
- `LocalWhisperAsrProvider`.

Provider selection is handled through `src/asr/providerRegistry.ts`. Local Whisper is the preferred default when its basic settings are present. Normal product-mode options are Local Whisper and Manual. Mock remains available in Developer mode, and OpenAI Realtime is added to Developer mode only when Electron reports `OPENAI_REALTIME_ENABLED=true`. Manual and Mock must remain available even when live providers fail.

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

## Experimental OpenAI Realtime Flow

The provider is parked and disabled by default. When disabled, it is omitted from the provider registry, saved selections fall back to Manual, and Electron rejects Realtime SDP IPC before reading `OPENAI_API_KEY` or making a network request.

When a developer explicitly sets `OPENAI_REALTIME_ENABLED=true`, the renderer may create a WebRTC offer and pass its SDP through preload IPC. Electron main builds the transcription session, posts multipart `sdp` and `session` fields to OpenAI with the permanent API key, and returns only the SDP answer. Realtime transcript events still enter the common `TranscriptDelta` boundary. Keys, authorization headers, prompts, and full SDP are not logged or stored in renderer state.

## Alignment Engine Flow

The alignment engine lives in `src/domain/alignment.ts` and related domain modules. It receives normalized transcript tokens and searches within a bounded manuscript window around the current token. It scores candidates conservatively, penalizes false jumps and duplicate traps, supports retake/backward matching, and returns an `AlignmentResult`.

`src/domain/scrollModel.ts` maps alignment confidence and movement into follow states such as following, holding, uncertain, lost, paused, manual, resyncing, and retake.

Stateful transcript-to-position behavior is owned by `src/session/SessionCoordinator.ts`. It combines the existing domain functions without changing their thresholds or scoring, and owns transcript buffers, accepted semantic position, reacquisition state, confidence/follow decisions, and movement diagnostics. `App.tsx` projects immutable coordinator state into React while retaining rendering, provider lifecycle, local persistence, and physical scroll animation. The coordinator can emit a JSON-serializable authoritative snapshot that validates against the shared protocol schema.

## Shared Tablet Protocol Foundation

Language-neutral JSON Schemas and compatibility rules live under `shared/protocol/`. They define envelopes, authoritative snapshots, transcript and semantic movement events, audio control metadata, and pairing/authentication placeholders. They do not implement a server, listener, authentication, binary transport, or Android client. Transport protocol versions are independent of session and manuscript revisions; visual lines and pixel positions are intentionally not authoritative cross-platform fields.

## UI and Debug Flow

`src/components/ControlPanel.tsx` owns the main controls, compact ASR provider status, Mic Monitor controls, and the Developer-mode troubleshooting surfaces. Normal mode shows daily narrator controls only; Developer mode reveals Mock playback, Manual transcript injection, Local Whisper internals, bridge diagnostics, movement diagnostics, scroll proof controls, transcript history, shortcuts, torture tests, and raw debug output.

`src/components/NarrationBar.tsx` is the always-visible narration overlay. It exposes the primary Start/Stop control, provider/status label, mic level meter, key warning text, and controls toggle.

`src/components/PrompterView.tsx` renders the manuscript pane. It owns the fixed reading-band overlay and scroll animation refs. Reading-zone geometry and scroll-step math live in `src/domain/prompterScroll.ts` so the component can keep animation state out of React state while still being testable. The scroll controller has two motion paths: correction scroll, which moves confirmed ASR/alignment anchors into the band, and optional Assist Scroll cruise, which predicts near-future reading position between recent high-confidence anchors. Correction scroll uses a deterministic cubic ease-in-out animation plan; Assist cruise remains a separate velocity-based continuous motion layer.

In Developer mode, the Display panel can issue scroll-test requests for 1, 5, and 15-line moves plus reset. `App.tsx` stores a small request object, `ControlPanel` emits it, and `PrompterView` runs the 1/5/15-line requests through the same correction-scroll helper used by live following. Reset uses a traceable direct `scrollTop` write. `PrompterView` also reports a compact animation status object back through `App.tsx` so the panel can show reduced-motion state, distance, duration, easing, Correction feel, and completion frame count. This isolates physical scroll feel from ASR, alignment confidence, token lookahead, and Assist Scroll cruise.

Movement-decision diagnostics live in `src/domain/movementDiagnostics.ts` and are surfaced by `App.tsx` into Developer mode in `ControlPanel`. They consume existing data from `AlignmentResult`, Local Whisper provisional-buffer decisions, PrompterView anchor debug, Assist status, and scroll trace events. The diagnostics classify decisions as on-track, local correction, plausible forward movement, suspicious jump, rollback/retake, suspicious rollback, or held/stale/uncertain. They also show a 160 WPM expected-progress corridor for observability only; the classifier does not change alignment scoring, confidence thresholds, or scroll acceptance.

Narration status labels are derived in `src/domain/narrationStatus.ts` from provider/follow/mic/lag/error inputs. This keeps UI labels such as Idle, Starting, Following, Holding, Lagging, and Error separate from ASR provider internals.

`src/components/DebugPanel.tsx` is gated by Developer mode and shows transcript buffer, current token, best match, confidence, follow state, search window, and reason.

`src/components/TortureTestPanel.tsx` runs simulated transcript chunks through the alignment harness for reproducible failure cases.

## Settings Storage

Local session state is stored in renderer `localStorage` through `src/state/projectStore.ts`. Stored fields include project title, manuscript text, current position, display settings, selected ASR provider, applied Local Whisper settings, mock script, Developer mode, and debug panel visibility. Controls visibility is stored as a separate local convenience preference.

Secrets must not be stored in localStorage. OpenAI API keys belong in environment variables or ignored local env files read by Electron main.
