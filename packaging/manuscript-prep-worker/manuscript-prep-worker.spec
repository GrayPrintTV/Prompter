# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

repo_root = Path(SPECPATH).parents[1]
script_path = repo_root / "python" / "manuscript_prep_worker.py"

a = Analysis([str(script_path)], pathex=[str(repo_root)], binaries=[], datas=[], hiddenimports=[], hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[], noarchive=False, optimize=0)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="manuscript-prep-worker", debug=False, bootloader_ignore_signals=False, strip=False, upx=False, console=True, disable_windowed_traceback=False)
coll = COLLECT(exe, a.binaries, a.zipfiles, a.datas, strip=False, upx=False, name="manuscript-prep-worker")
