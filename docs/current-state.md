# Current State

## Current Phase

Phase 1 is in progress. The app has Phase 0/0.5 manuscript alignment, torture-test harnesses, Manual and Mock ASR, and Local Whisper ASR working end-to-end through the Python sidecar. Local Whisper is the intended live narration provider. OpenAI Realtime is retained only as a default-off experimental comparison path.

## What Works

- Electron + React + TypeScript + Vite desktop app.
- Paste/import TXT or Markdown manuscript text.
- Manual transcript injection.
- Mock transcript playback.
- Alignment torture-test panel and Vitest fixture coverage.
- Conservative fuzzy manuscript alignment with confidence states.
- OpenAI Realtime code remains behind the ASR boundary but is parked and hidden unless `OPENAI_REALTIME_ENABLED=true`.
- Local Whisper provider behind the ASR boundary, including microphone capture, WAV chunks, sidecar transcription, Heard transcript display, and manuscript following.
- Mic Monitor for Local Whisper with input level meter and microphone state diagnostics.
- Local Whisper sidecar launch path and chunk counters.
- Local Whisper PCM/WAV chunking path: renderer encodes microphone samples as WAV and Electron main writes `.wav` temp files for the Python sidecar.
- Bridge diagnostics for Electron preload, Local Whisper IPC, ping, preload path, preload existence, preload status, and preload errors.
- Prompter reading zone uses a fixed higher-on-screen band, dynamic top/bottom manuscript spacers, visible Display tuning controls, and a custom `requestAnimationFrame` scroll controller instead of native smooth scrolling.
- Correction scroll now uses a deterministic cubic ease-in-out plan with explicit from/target scrollTop, duration, easing curve, Correction feel, cancellation, reduced-motion, and frame-count diagnostics. The Display panel has scroll proof buttons for 1, 5, and 15-line tests plus reset so physical scroll feel can be tested without ASR or alignment.
- The Display panel now has a compact Movement decision diagnostic area showing confirmed token, proposed lookahead target, prior fresh anchor, token/line delta, Reading Lookahead, high-confidence anchor age, a 160 WPM diagnostic expected-progress corridor, movement classification, confidence, penalty flags, final outcome, reason, and the last 10 decisions.
- Fresh sessions default `readingZonePercent` to 38 and active sentence highlighting off. The Display controls show the value as percent down from top, include Move up / Move down buttons, and migrate older bottom-half saved band positions once to the narration default.
- Optional Assist Scroll is now predictive: high-confidence following matches become correction anchors, estimated reading pace drives gentle cruise between ASR chunks, and Display controls expose Assist speed plus Correction feel.
- Prompter-first narration mode can hide the left control panel and keeps a minimal Start/Stop/status/mic-level overlay visible.
- Persisted hidden-controls mode is recoverable: the prompter-only view keeps the NarrationBar visible, and controls are restored automatically if the prompter pane reports an invalid size.
- Electron window state persists the last normal window bounds plus maximized state. Maximized windows reopen maximized on the same validated monitor; full-screen state is intentionally not preserved.
- Local Whisper settings use draft/apply semantics; changes made while following are labeled as applying after Restart Whisper.
- Optional predictive Assist Scroll is implemented and off by default.

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
- OpenAI Realtime: parked experimental comparison provider; absent from normal UI and blocked before key checks or network calls unless `OPENAI_REALTIME_ENABLED=true`.

## Known Fragile Areas

- Local Whisper bridge should be manually smoke-tested after full Electron restart when Electron main/preload/build files change.
- Local Whisper transcription quality and following behavior remain model/chunk-duration sensitive; the app now defaults to `base.en` with 2-second chunks on `cpu`/`int8` because it has looked better in live narration than `turbo` or `tiny.en`.
- Local Whisper sidecar self-test exists, but model download/load can take time on first run.
- Audio input selector is not implemented yet; Chromium default device is used.
- Number and abbreviation normalization is intentionally narrow.
- Duplicate sentence/phrase handling is improved but may still need context, cue, or paragraph-aware refinements for long manuscripts.

## Next Likely Tasks

- Restart dev app and confirm Local Whisper bridge diagnostics show Yes/Yes/Yes.
- Run the Local Whisper sidecar self-test.
- Add an input-device selector.
- Tune Local Whisper model/chunk defaults further from longer real narration sessions if needed.
- Continue prompter reading-zone tuning after real narration sessions, especially band height and whether sentence top-edge targeting is enough for long wrapped sentences.
- Evaluate predictive Assist Scroll in real narration; it is intentionally conservative and may need speed/correction tuning.
- Use the Display panel scroll proof buttons to tune Correction feel before blaming ASR/alignment for motion feel.
- Use Movement decision diagnostics during Mock and Local Whisper following to separate ASR timing, alignment confidence, lookahead target choice, Assist cruise, correction retargeting, and suspicious jump candidates before changing alignment or jump-governor behavior.

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
python python/local_whisper_sidecar.py --self-test --model base.en --device cpu --compute-type int8
```
