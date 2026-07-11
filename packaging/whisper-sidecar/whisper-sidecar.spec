# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)


repo_root = Path(SPECPATH).parents[1]
script_path = repo_root / "python" / "local_whisper_sidecar.py"

runtime_packages = [
    "av",
    "ctranslate2",
    "faster_whisper",
    "huggingface_hub",
    "numpy",
    "onnxruntime",
    "tokenizers",
    "yaml",
]

metadata_packages = [
    "av",
    "ctranslate2",
    "faster-whisper",
    "huggingface-hub",
    "numpy",
    "onnxruntime",
    "tokenizers",
    "PyYAML",
]

datas = []
for package in metadata_packages:
    try:
        datas += copy_metadata(package)
    except Exception:
        pass

for package in runtime_packages:
    try:
        datas += collect_data_files(package, include_py_files=False)
    except Exception:
        pass

binaries = []
for package in ["av", "ctranslate2", "numpy", "onnxruntime", "tokenizers"]:
    try:
        binaries += collect_dynamic_libs(package)
    except Exception:
        pass

gpu_binary_markers = [
    "cublas",
    "cuda",
    "cudnn",
    "cufft",
    "curand",
    "cusolver",
    "cusparse",
    "hip",
    "nvrtc",
    "nvidia",
    "rocm",
]


def is_gpu_binary(entry):
    source = Path(entry[0]).name.lower()
    destination = str(entry[1]).lower() if len(entry) > 1 else ""
    return any(marker in source or marker in destination for marker in gpu_binary_markers)


binaries = [entry for entry in binaries if not is_gpu_binary(entry)]
datas = [entry for entry in datas if not is_gpu_binary(entry)]

hiddenimports = []
for package in runtime_packages:
    try:
        hiddenimports += collect_submodules(package)
    except Exception:
        hiddenimports.append(package)

excludes = [
    "cuda",
    "cudnn",
    "nvidia",
    "tensorflow",
    "torch",
    "torchaudio",
    "torchvision",
    "triton",
]

a = Analysis(
    [str(script_path)],
    pathex=[str(repo_root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="whisper-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="whisper-sidecar",
)
