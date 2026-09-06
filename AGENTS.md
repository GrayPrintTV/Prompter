# Agent Handoff Guide

## Project Summary

Narration Prompter is a Windows-first Electron + React + TypeScript desktop app for audiobook and voiceover narration. It displays a manuscript, accepts transcript chunks from swappable ASR providers, aligns those chunks to the manuscript, and scrolls conservatively only when confidence is high.

The product center is known-script alignment, not speech recognition by itself. ASR providers feed transcript evidence into the same alignment engine used by manual and mock testing.

## Architecture Summary

- `electron/main.ts`: Electron shell, file dialogs, window controls, Local Whisper sidecar process, IPC handlers, bridge diagnostics, and the default-off experimental OpenAI Realtime boundary.
- `electron/preload.cts`: CommonJS preload bridge exposed as `window.prompterApi` with `contextBridge`. It must compile to `dist-electron/preload.cjs`.
- `src/asr/`: ASR provider boundary and providers for Manual, Mock, Local Whisper, and parked experimental OpenAI Realtime.
- `src/domain/`: manuscript model, normalization, tokenization, fuzzy alignment, follow/scroll state.
- `src/components/`: prompter UI, control panel, debug panel, torture-test panel.
- `src/state/`: default settings and local session persistence.
- `python/local_whisper_sidecar.py`: JSONL faster-whisper sidecar owned by Electron main.

## Do-Not-Break Rules

- Do not change the alignment engine for ASR plumbing work unless explicitly asked.
- Do not remove or regress Manual, Mock, or Local Whisper providers. Keep OpenAI Realtime default-off and experimental unless a task explicitly targets it.
- Keep ASR provider logic behind the provider boundary.
- Keep `TranscriptDelta` handoff shape consistent across providers.
- Keep `contextIsolation: true` and `nodeIntegration: false`.
- Keep API keys and secrets out of renderer code and committed files.
- Keep Mic Monitor usable even when Local Whisper bridge/sidecar setup fails.
- Prefer conservative alignment behavior: freeze or hold is better than a wrong jump.

## Test/Build Commands

```powershell
npm test
npm run build
git diff --check
```

If the Codex shell lacks normal `npm` on `PATH`, use the legacy workaround in `README.md`. Normal Windows npm is preferred.

## Security Rules

- Do not commit API keys, `.env`, `.env.local`, microphone recordings, temp audio chunks, or logs.
- OpenAI API keys must remain in Electron main/environment handling and must never reach renderer state or logs.
- Electron main owns secret-bearing setup and Local Whisper sidecar process.
- Do not print secrets to logs or diagnostics.
- Confirm `.gitignore` coverage before adding new local config, logs, or generated assets.

## Git Workflow

- Start with `git status --short`.
- Do not revert or overwrite user changes unless explicitly asked.
- Keep changes scoped to the task.
- At each verified feature or fix stopping point, commit the task's changes and push the current branch to `origin`.
- Leave work uncommitted only when the user explicitly says it is exploratory or not ready.
- Before committing, run tests/build when available and `git diff --check`.
- Report untracked/generated files clearly.

## Required Reporting Format

Report these items at the end of implementation work:

- Exact diagnosis or fix summary.
- Files changed.
- Tests run and result.
- Build result.
- Whether requested diagnostics or acceptance checks pass.
- Git branch, commit hash, and successful push result.
- Remaining caveats or fragile areas.
- Any required manual restart or smoke-test steps.
