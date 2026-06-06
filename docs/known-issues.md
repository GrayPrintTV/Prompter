# Known Issues

## Local Whisper Preload/Module-Format Bridge Issue

Recent failure: Electron tried to `require()` `dist-electron/preload.js`, but the file was emitted as an ES module because the package uses `"type": "module"`. That prevented `contextBridge.exposeInMainWorld` from running and left `window.prompterApi` undefined.

Current fix: `electron/preload.cts` builds to `dist-electron/preload.cjs`, and Electron main points BrowserWindow preload at `preload.cjs`. After any main/preload/build change, fully restart `npm run dev` and the Electron window.

## Local Whisper WAV Path Needs Real Mic Validation

Local Whisper no longer relies on Chromium MediaRecorder WebM chunks. The renderer captures PCM with Web Audio and encodes WAV chunks with `RIFF/WAVE` headers. This should be more reliable for faster-whisper, but it still needs real microphone validation in the target Python/faster-whisper environment.

## Local Whisper Sidecar Self-Test Can Be Slow

The sidecar self-test exists:

```powershell
python python/local_whisper_sidecar.py --self-test --model turbo --device cpu --compute-type int8
```

It verifies Python, faster-whisper import, model load, and WAV decode/transcribe. First model download/load can take time and may fail if the model name, device, compute type, or local faster-whisper install is wrong.

## Audio Input Selector Needed

The app currently relies on Chromium's default audio input. It shows the selected/default label after permission is granted, but it does not yet offer an input-device picker.

## Number Normalization Is Narrow

Number and abbreviation normalization intentionally covers only conservative common cases such as `two fourteen`, `twenty twenty-six`, `doctor`, and `p.m.`. It is not a general spoken-number parser.

## Duplicate Sentence Handling May Need More Context

Repeated sentence and duplicate phrase handling is improved, including retake bias and duplicate/jump penalties. Long manuscripts may still need paragraph context, cue points, or stronger recent-history modeling.

## Generated and Local Files

Build outputs, local env files, logs, temp audio chunks, Python caches, virtual environments, and `node_modules/` should remain uncommitted. Some smoke-test images under `logs/` may already be tracked from earlier work; do not remove tracked files unless the task explicitly asks.
