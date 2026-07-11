from __future__ import annotations

import json
import sys
from pathlib import Path

import pefile


def imported_dlls(file_path: Path) -> list[str]:
    try:
        pe = pefile.PE(str(file_path), fast_load=True)
        pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"]])
    except Exception:
        return []

    imports: list[str] = []
    for entry in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []) or []:
        try:
            imports.append(entry.dll.decode("utf-8", errors="replace"))
        except Exception:
            pass
    return sorted(set(imports), key=str.lower)


def main(argv: list[str]) -> int:
    summary_only = "--summary" in argv
    path_args = [arg for arg in argv[1:] if arg != "--summary"]
    root = Path(path_args[0] if path_args else "build/whisper-sidecar/dist/whisper-sidecar").resolve()
    if not root.exists():
        print(f"Sidecar directory not found: {root}", file=sys.stderr)
        return 1

    files = sorted(
        [*root.rglob("*.exe"), *root.rglob("*.dll"), *root.rglob("*.pyd")],
        key=lambda path: str(path).lower(),
    )
    imports_by_file = {str(file.relative_to(root)): imported_dlls(file) for file in files}
    all_imports = sorted({dll for imports in imports_by_file.values() for dll in imports}, key=str.lower)
    gpu_markers = ["cuda", "cudnn", "cublas", "cufft", "curand", "rocm", "hip"]
    gpu_imports = [dll for dll in all_imports if any(marker in dll.lower() for marker in gpu_markers)]
    gpu_files = [
        str(file.relative_to(root))
        for file in files
        if any(marker in file.name.lower() for marker in gpu_markers)
    ]
    vc_runtime_imports = [
        dll for dll in all_imports
        if dll.lower().startswith(("vcruntime", "msvcp", "concrt")) or dll.lower() == "ucrtbase.dll"
    ]

    summary = {
        "sidecarDir": str(root),
        "peFileCount": len(files),
        "allImports": all_imports,
        "vcRuntimeImports": vc_runtime_imports,
        "gpuImports": gpu_imports,
        "gpuFiles": gpu_files,
    }
    if not summary_only:
        summary["importsByFile"] = imports_by_file
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
