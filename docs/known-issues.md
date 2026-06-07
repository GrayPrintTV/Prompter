# Known Issues

## Local Whisper Preload/Module-Format Bridge Issue

Recent failure: Electron tried to `require()` `dist-electron/preload.js`, but the file was emitted as an ES module because the package uses `"type": "module"`. That prevented `contextBridge.exposeInMainWorld` from running and left `window.prompterApi` undefined.

Current fix: `electron/preload.cts` builds to `dist-electron/preload.cjs`, and Electron main points BrowserWindow preload at `preload.cjs`. After any main/preload/build change, fully restart `npm run dev` and the Electron window.

## Local Whisper Quality/Latency Tuning

Local Whisper no longer relies on Chromium MediaRecorder WebM chunks. The renderer captures PCM with Web Audio and encodes WAV chunks with `RIFF/WAVE` headers, and live microphone transcription now works end-to-end through the Python sidecar. Following quality is still sensitive to model choice, chunk duration, silence suppression, and CPU latency; the app now defaults to `base.en` with 2-second chunks on `cpu`/`int8` because it has looked better in live narration than `turbo` or `tiny.en`.

## Local Whisper Sidecar Self-Test Can Be Slow

The sidecar self-test exists:

```powershell
python python/local_whisper_sidecar.py --self-test --model base.en --device cpu --compute-type int8
```

It verifies Python, faster-whisper import, model load, and WAV decode/transcribe. First model download/load can take time and may fail if the model name, device, compute type, or local faster-whisper install is wrong.

## Audio Input Selector Needed

The app currently relies on Chromium's default audio input. It shows the selected/default label after permission is granted, but it does not yet offer an input-device picker.

## Number Normalization Is Narrow

Number and abbreviation normalization intentionally covers only conservative common cases such as `two fourteen`, `twenty twenty-six`, `doctor`, and `p.m.`. It is not a general spoken-number parser.

## Duplicate Sentence Handling May Need More Context

Repeated sentence and duplicate phrase handling is improved, including retake bias and duplicate/jump penalties. Long manuscripts may still need paragraph context, cue points, or stronger recent-history modeling.

## Reading Zone Targets Sentence Top Edge

The fixed reading band currently targets the top edge of the active sentence into the band. It does not try to center an entire multi-line sentence block or choose a spoken word's exact wrapped line yet. This is intentional for the first narration-feel pass, but long wrapped sentences may still need finer cueing after real sessions.

## Predictive Assist Scroll Needs Real-Session Tuning

Optional Assist Scroll is intentionally conservative and off by default. It now estimates reading pace from recent high-confidence correction anchors, cruises between ASR chunks, slows for stale confidence or Local Whisper lag, and stops on holds, lost/manual/paused/retake states, or low confidence. Its default speed, correction feel, stale timing, and lag slowdown may need tuning after longer audiobook sessions.

## Generated and Local Files

Build outputs, local env files, logs, temp audio chunks, Python caches, virtual environments, and `node_modules/` should remain uncommitted. Some smoke-test images under `logs/` may already be tracked from earlier work; do not remove tracked files unless the task explicitly asks.
