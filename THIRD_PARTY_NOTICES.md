# Third-Party Notices

This document summarizes third-party components redistributed with packaged Prompter builds. It is packaging documentation, not legal advice. Review upstream license files before publishing an installer.

## Desktop Runtime

- Electron: MIT License. Packaged builds redistribute Electron and Chromium/Node runtime components.
- React and React DOM: MIT License.
- Vite/TypeScript build tooling is used to create the application but is not intentionally redistributed at runtime.
- Runtime npm dependencies packaged in ASAR include Mammoth, pdfjs-dist, JSZip, React, React DOM, and their production transitive dependencies. Preserve their license metadata from `node_modules` in any final installer/legal review.

## Local Whisper Sidecar

The self-contained Local Whisper sidecar is produced with PyInstaller onedir and is distributed under `resources/whisper-sidecar`.

- Python 3.13.2: Python Software Foundation License.
- PyInstaller: GPLv2-or-later with the PyInstaller bootloader exception.
- faster-whisper: MIT License.
- CTranslate2: MIT License.
- PyAV: BSD 3-Clause License. PyAV wheels include or depend on FFmpeg libraries; FFmpeg components are commonly LGPL/GPL depending on build configuration. Confirm the exact wheel contents before public distribution.
- NumPy: BSD 3-Clause License.
- tokenizers: Apache License 2.0.
- huggingface-hub: Apache License 2.0.
- onnxruntime: MIT License.
- Other locked Python dependencies are listed in `python/requirements-whisper-lock.txt`.

## Whisper Model

The packaged CPU model is `Systran/faster-whisper-base.en`, staged as `resources/models/base.en`.

Model redistribution terms come from the upstream model repository and any inherited Whisper model license terms. Include the upstream model card/license files with the final distributable when required. This pass validates and copies the required local model runtime files but does not add a full legal review of model redistribution.

## Installer Follow-Up

Before creating the NSIS installer:

- Include any required upstream license files in the packaged resources or installer notices.
- Re-check FFmpeg/PyAV wheel licensing for the exact redistributed binaries.
- Confirm Microsoft Visual C++ runtime redistribution requirements for native sidecar DLLs.
- Confirm the final packaged npm dependency list and license metadata.
