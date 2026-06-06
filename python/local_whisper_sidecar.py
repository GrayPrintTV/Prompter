#!/usr/bin/env python
"""JSONL sidecar for chunked local faster-whisper transcription.

The Electron main process owns this process and sends commands on stdin:
  {"type": "configure", "modelName": "turbo", "device": "cpu", "computeType": "int8"}
  {"type": "transcribe", "requestId": "abc", "audioPath": "C:/.../chunk.webm"}
  {"type": "shutdown"}

Responses are JSON objects on stdout. Diagnostic text should go to stderr.
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path
from typing import Any

try:
    from faster_whisper import WhisperModel
except Exception as exc:  # pragma: no cover - exercised in an installed sidecar env.
    WhisperModel = None  # type: ignore[assignment]
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


model: Any | None = None
model_config: dict[str, str] | None = None


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def load_model(model_name: str, device: str, compute_type: str) -> None:
    global model, model_config
    if IMPORT_ERROR is not None:
        raise RuntimeError(f"faster-whisper is not installed: {IMPORT_ERROR}")

    requested = {
        "modelName": model_name,
        "device": device,
        "computeType": compute_type,
    }
    if model is not None and model_config == requested:
        emit({"type": "model-loaded", **requested})
        return

    emit({"type": "model-loading", **requested})
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    model_config = requested
    emit({"type": "model-loaded", **requested})


def configure(command: dict[str, Any]) -> None:
    load_model(
        str(command.get("modelName") or "turbo"),
        str(command.get("device") or "cpu"),
        str(command.get("computeType") or "int8"),
    )


def transcribe(command: dict[str, Any]) -> None:
    if model is None:
        configure(command)
    if model is None:
        raise RuntimeError("Whisper model is not loaded.")

    request_id = str(command.get("requestId") or "")
    audio_path = Path(str(command.get("audioPath") or ""))
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio chunk not found: {audio_path}")

    segments, info = model.transcribe(
        str(audio_path),
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    emit(
        {
            "type": "transcript",
            "requestId": request_id,
            "text": text,
            "durationSeconds": getattr(info, "duration", None),
        }
    )


def handle(command: dict[str, Any]) -> bool:
    command_type = command.get("type")
    if command_type == "configure":
        configure(command)
    elif command_type == "transcribe":
        transcribe(command)
    elif command_type == "shutdown":
        emit({"type": "stopped"})
        return False
    else:
        emit({"type": "error", "message": f"Unknown command type: {command_type}"})
    return True


def main() -> int:
    emit({"type": "ready"})
    for line in sys.stdin:
        try:
            command = json.loads(line)
            if not handle(command):
                return 0
        except Exception as exc:  # pragma: no cover - defensive runtime path.
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            emit({"type": "error", "message": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
