#!/usr/bin/env python
"""JSONL sidecar for chunked local faster-whisper transcription.

The Electron main process owns this process and sends commands on stdin:
  {"type": "configure", "modelName": "turbo", "device": "cpu", "computeType": "int8"}
  {"type": "transcribe", "requestId": "abc", "audioPath": "C:/.../chunk.wav"}
  {"type": "shutdown"}

Responses are JSON objects on stdout. Diagnostic text should go to stderr.
"""

from __future__ import annotations

import json
import argparse
import math
import sys
import tempfile
import traceback
import wave
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


def header_signature(audio_path: Path) -> str:
    data = audio_path.read_bytes()[:16]
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "RIFF/WAVE"
    if len(data) >= 4 and data[:4] == b"\x1a\x45\xdf\xa3":
        return "WebM"
    return " ".join(f"{byte:02X}" for byte in data[:8])


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

    emit(
        {
            "type": "transcribe-start",
            "requestId": request_id,
            "audioPath": str(audio_path),
            "audioFormat": str(command.get("audioFormat") or audio_path.suffix.lstrip(".") or "unknown"),
            "mimeType": str(command.get("mimeType") or ""),
            "fileSizeBytes": audio_path.stat().st_size,
            "headerSignature": header_signature(audio_path),
            "sampleRate": command.get("sampleRate"),
            "chunkDurationSeconds": command.get("chunkDurationSeconds"),
        }
    )
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
            "diagnostics": {
                "audioPath": str(audio_path),
                "fileSizeBytes": audio_path.stat().st_size,
                "headerSignature": header_signature(audio_path),
            },
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
        command: dict[str, Any] = {}
        try:
            command = json.loads(line)
            if not handle(command):
                return 0
        except Exception as exc:  # pragma: no cover - defensive runtime path.
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            emit(
                {
                    "type": "error",
                    "requestId": str(command.get("requestId") or ""),
                    "stage": str(command.get("type") or "command"),
                    "message": str(exc),
                }
            )
    return 0


def write_self_test_wav(audio_path: Path, sample_rate: int = 16000, duration_seconds: float = 0.75) -> None:
    frame_count = int(sample_rate * duration_seconds)
    with wave.open(str(audio_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        frames = bytearray()
        for index in range(frame_count):
            value = int(math.sin(2 * math.pi * 440 * index / sample_rate) * 0.15 * 32767)
            frames.extend(value.to_bytes(2, byteorder="little", signed=True))
        wav_file.writeframes(bytes(frames))


def run_self_test(args: argparse.Namespace) -> int:
    result: dict[str, Any] = {
        "type": "self-test-result",
        "python": sys.executable,
        "fasterWhisperImport": IMPORT_ERROR is None,
        "modelName": args.model,
        "device": args.device,
        "computeType": args.compute_type,
        "modelLoaded": False,
        "wavDecoded": False,
        "transcriptText": "",
        "error": None,
    }
    if IMPORT_ERROR is not None:
        result["error"] = f"faster-whisper is not installed: {IMPORT_ERROR}"
        print(json.dumps(result, indent=2), flush=True)
        return 1

    try:
        load_model(args.model, args.device, args.compute_type)
        result["modelLoaded"] = True
        with tempfile.TemporaryDirectory(prefix="narration-prompter-sidecar-test-") as temp_dir:
            audio_path = Path(temp_dir) / "self-test.wav"
            write_self_test_wav(audio_path)
            result["wavPath"] = str(audio_path)
            result["headerSignature"] = header_signature(audio_path)
            segments, _info = model.transcribe(
                str(audio_path),
                beam_size=1,
                vad_filter=False,
                condition_on_previous_text=False,
            )
            text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
            result["wavDecoded"] = True
            result["transcriptText"] = text
    except Exception as exc:
        result["error"] = str(exc)
        print(json.dumps(result, indent=2), flush=True)
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        return 1

    print(json.dumps(result, indent=2), flush=True)
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local Whisper sidecar for Narration Prompter.")
    parser.add_argument("--self-test", action="store_true", help="Run import/model/WAV decode self-test and exit.")
    parser.add_argument("--model", default="turbo", help="faster-whisper model name for --self-test.")
    parser.add_argument("--device", default="cpu", help="faster-whisper device for --self-test.")
    parser.add_argument("--compute-type", default="int8", help="faster-whisper compute type for --self-test.")
    return parser.parse_args(argv)


if __name__ == "__main__":
    parsed_args = parse_args(sys.argv[1:])
    if parsed_args.self_test:
        raise SystemExit(run_self_test(parsed_args))
    raise SystemExit(main())
