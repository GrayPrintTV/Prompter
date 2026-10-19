# Desktop narration release candidate

This candidate includes the reviewed local Prep, narration checkpoint and USB work based on `ce5e1d21e1f729785b5ba852b208293d121b863a`, plus verified approval selection/export and release qualification changes. It uses a separate candidate application ID, installation name and userData directory; it does not migrate production data.

## Build

Use Windows x64, Node and the locked npm dependencies (`npm ci`). Use Python 3.13.2 with `python/requirements-whisper-lock.txt` in a dedicated build environment. Set `LOCAL_WHISPER_BUILD_PYTHON` and `MANUSCRIPT_PREP_BUILD_PYTHON` to its Python executable. These are build inputs only; installed workers are self-contained. `collect-python-licenses.py` verifies exact installed versions and preserves their license files.

Provision the exact model snapshot identified in `packaging/model-lock.json`, or set `LOCAL_WHISPER_MODEL_SOURCE_DIR` to its four verified files. Provisioning rejects any mismatched hash. No model download occurs during normal installed launch. Upstream model notices are in `packaging/licenses`.

1. Run `npm test` and `npm run build`.
2. Review and commit source. The two historically tracked TypeScript build-info files are generated artifacts, not release inputs; do not commit regenerated versions.
3. Run `node scripts/write-build-identity.mjs` from the clean reviewed commit.
4. Run `npm run prepare:self-contained`. Worker builds are fresh by default. Reuse flags are development-only.
5. Run `npm run build`, then `node node_modules/electron-builder/cli.js --win nsis`.
6. Run `npm run validate:self-contained`, `npm run smoke:whisper-sidecar`, and `node scripts/release-manifest.mjs`. The manifest hashes every packaged file and every ASAR file, alongside source/dependency/model identities. Record the installer hash separately.

Byte-for-byte repeatability of Windows compiler/signing timestamps is not claimed. Reproducibility here means explicit source/dependency/resource inputs and complete verification of the resulting candidate. Do not substitute old compiled output or package only an Electron executable.

## Data and acceptance

Candidate data defaults to `Prompter Release Candidate` below the user's roaming application-data directory. `PROMPTER_USER_DATA_DIR` accepts an absolute isolated directory for qualification, before the single-instance lock is acquired. `PROMPTER_DISABLE_TABLET=1` disables listeners during isolated tests. Release candidates default tablet transport off; explicitly setting `PROMPTER_ENABLE_TABLET=1` retains the existing tablet functionality for separate qualification. Production-version builds retain their ordinary behavior.

Prep reads TXT, DOCX and selectable-text PDF. PDF uses the existing bundled PDF.js parser through Electron main, preserving extracted line boundaries for review, with mandatory reading-order acknowledgement. It rejects pages without selectable text; OCR is not qualified. The worker independently checks the original source hash and owns review revisions and immutable approval writes.

Choose **Use this approved manuscript** to select exact approved bytes. Selection remains separate from approval. The reader persists project/approval/hash identity, verifies it again before starting, and marks directly edited/imported legacy text unapproved. **Export UTF-8 for Proofer** creates a new file containing exactly the verified approved bytes; it refuses overwrites. Proofer's existing explicit UTF-8 selection remains the handoff. No transport or schema extension is added.

The old production-targeting installer smoke script is deliberately disabled. Install this candidate only into its separate location; verify production executable/archive hashes and shortcut targets before and after. Reinstall the same candidate with isolated data, confirm a saved sentinel and approved artifacts persist, and verify all application resource hashes. Never stop processes by generic name or install over the production directory.

For rollback, close only the candidate. Its separate uninstall entry removes the candidate application and preserves candidate data. The original production shortcut and data remain the fallback; do not copy newer candidate data over production data. A later production deployment requires separate authorization.

A real 20-minute narrator-operated session is required for B3. Synthetic fixtures and offline worker tests do not establish microphone routing, reading-band timing or booth usability. B8 tablet acceptance is separate. This candidate is for local qualification; public binary distribution additionally needs review of the exact native-library redistribution obligations, including FFmpeg libraries bundled by the locked PyAV wheel.
