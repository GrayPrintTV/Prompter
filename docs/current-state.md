# Current State

## Current Phase

Phase 1 is in progress. The app has Phase 0/0.5 manuscript alignment, torture-test harnesses, Manual and Mock ASR, OpenAI Realtime provider scaffolding, and Local Whisper provider scaffolding. The current focus is making Local Whisper live provider plumbing reliable before tuning transcription quality.

## What Works

- Electron + React + TypeScript + Vite desktop app.
- Paste/import TXT or Markdown manuscript text.
- Manual transcript injection.
- Mock transcript playback.
- Alignment torture-test panel and Vitest fixture coverage.
- Conservative fuzzy manuscript alignment with confidence states.
- OpenAI Realtime provider behind the ASR boundary, disabled until configured.
- Local Whisper provider behind the ASR boundary.
- Mic Monitor for Local Whisper with input level meter and microphone state diagnostics.
- Local Whisper sidecar launch path and chunk counters.
- Local Whisper PCM/WAV chunking path: renderer encodes microphone samples as WAV and Electron main writes `.wav` temp files for the Python sidecar.
- Bridge diagnostics for Electron preload, Local Whisper IPC, ping, preload path, preload existence, preload status, and preload errors.

## Current Active Bug/Fix Status

The recent Local Whisper bridge failure was caused by a module-format mismatch: Electron loads preload scripts with `require()`, while `dist-electron/preload.js` was emitted as an ES module under package `"type": "module"`.

The intended fix is now:

- Source file: `electron/preload.cts`.
- Build output: `dist-electron/preload.cjs`.
- BrowserWindow preload path: `dist-electron/preload.cjs`.
- Dev launcher runs a one-shot Electron compile, then waits for `dist-electron/preload.cjs`.

After this change, a renderer hot reload is not enough. Stop `npm run dev`, close the Electron window, and restart `npm run dev`.

Expected Local Whisper diagnostics after restart:

- Electron bridge: Yes.
- Whisper bridge: Yes.
- IPC handlers: Yes.
- `prompterApi`: object.
- `ping`: pong.
- Preload path: `C:\dev\Prompter\dist-electron\preload.cjs`.
- Preload exists: Yes.

The active Local Whisper audio fix changes chunks from Chromium MediaRecorder WebM to Web Audio PCM/WAV. Expected chunk diagnostics after Start Following:

- Format: `wav`.
- MIME: `audio/wav`.
- Ext: `wav`.
- Header: `RIFF/WAVE`.
- Rate: the active AudioContext sample rate.

Sidecar readiness is now split:

- `Process started`: Python sidecar process is running and answering JSONL.
- `Model loading`: faster-whisper is loading the requested model.
- `Ready`: model is loaded and chunks can be transcribed.

## ASR Providers

- Manual: local typed transcript chunks; always available.
- Mock: scripted chunks; always available.
- Local Whisper: mic PCM/WAV chunks from renderer to Electron main, then Python faster-whisper sidecar; local and optional.
- OpenAI Realtime: WebRTC transcription provider using main-process config/ephemeral client-secret setup; optional and disabled until configured.

## Known Fragile Areas

- Local Whisper bridge should be manually smoke-tested after full Electron restart when Electron main/preload/build files change.
- Local Whisper WAV chunks still need real microphone testing in the target Python/faster-whisper environment.
- Local Whisper sidecar self-test exists, but model download/load can take time on first run.
- Audio input selector is not implemented yet; Chromium default device is used.
- Number and abbreviation normalization is intentionally narrow.
- Duplicate sentence/phrase handling is improved but may still need context, cue, or paragraph-aware refinements for long manuscripts.

## Next Likely Tasks

- Restart dev app and confirm Local Whisper bridge diagnostics show Yes/Yes/Yes.
- Run the Local Whisper sidecar self-test.
- Verify WAV chunks can be decoded by faster-whisper in the user's Python environment.
- Add an input-device selector.
- Continue Local Whisper UX diagnostics only after bridge and sidecar path are proven.
- Tune Local Whisper chunk duration and silence handling.

## Local Whisper Manual Smoke-Test Steps

1. Stop `npm run dev`, close all Electron windows, then run `npm run dev`.
2. Select `Local Whisper`.
3. Confirm bridge diagnostics show Electron bridge Yes, Whisper bridge Yes, IPC handlers Yes, `prompterApi` object, and `ping` pong.
4. Click `Start Monitor`.
5. Confirm mic state becomes Stream Active and the level meter moves.
6. Confirm the selected/default input label appears when Chromium exposes it.
7. Click `Start Following`.
8. Confirm Sidecar moves from Starting to Process started to Model loading to Ready, or displays a clear Python/faster-whisper setup error.
9. Speak one or two manuscript sentences.
10. Confirm chunk counters advance: Recorded, Sent, Sidecar, Returned.
11. Confirm chunk diagnostics show Format `wav`, MIME `audio/wav`, Ext `wav`, Header `RIFF/WAVE`.
12. Confirm `Heard` shows raw transcript text or `[empty transcript]`, not provider status text.
13. Confirm Manual and Mock still work if Local Whisper fails.

Sidecar self-test:

```powershell
python python/local_whisper_sidecar.py --self-test --model turbo --device cpu --compute-type int8
```
