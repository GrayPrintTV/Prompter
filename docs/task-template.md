# Task Template

## Repo Path

`C:\dev\Prompter`

## Current Branch/Commit

- Branch:
- Commit:

## Task

Describe the requested change or investigation.

## Observed Behavior

Describe what is happening now, including exact UI labels, terminal output, errors, and reproduction steps.

## Expected Behavior

Describe what should happen after the task is complete.

## Relevant Files

- `electron/main.ts`
- `electron/preload.cts`
- `src/asr/`
- `src/domain/`
- `src/components/`
- `python/local_whisper_sidecar.py`

Adjust this list for the actual task.

## Constraints / Do Not Change

- Do not change the alignment engine unless the task explicitly asks.
- Do not remove Manual, Mock, or Local Whisper providers. Leave parked OpenAI Realtime disabled unless the task explicitly targets it.
- Do not expose API keys or secrets to renderer code.
- Do not commit local env files, logs, temp audio, or generated build output.
- Preserve existing Phase 0/0.5 behavior unless the task requires otherwise.

## Verification Commands

```powershell
npm test
npm run build
git diff --check
```

Add manual smoke-test steps when the task touches Electron, preload, microphone capture, or sidecars.

## Required Report Format

- Exact diagnosis or fix.
- Files changed.
- Tests run and result.
- Build result.
- Manual verification or expected smoke-test result.
- Remaining caveats.
- Restart instructions if Electron main/preload/build config changed.
