"""Collect licenses from the exact locked build environment without user data."""
from pathlib import Path
import importlib.metadata as md
import json, shutil, sys, re

root = Path(__file__).resolve().parents[1]
target = root / 'build' / 'licenses' / 'python'
target.mkdir(parents=True, exist_ok=True)
normalize = lambda s: re.sub(r'[-_.]+', '-', s).lower()
expected = dict(line.split('==', 1) for line in (root/'python/requirements-whisper-lock.txt').read_text().splitlines() if line and not line.startswith('#'))
inventory = []
for name, version in expected.items():
    dist = md.distribution(name)
    if dist.version != version: raise SystemExit(f'Build dependency mismatch: {name}')
    copied = []
    for file in dist.files or []:
        if any(word in str(file).lower() for word in ('license', 'copying', 'notice')) and Path(file).suffix.lower() not in ('.pyc','.py'):
            source = Path(dist.locate_file(file))
            if not source.is_file(): continue
            # Package metadata paths only, never machine paths in the output inventory.
            dest = target / normalize(name) / str(file).replace('..', '_parent')
            dest.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source,dest)
            copied.append(str(dest.relative_to(target)))
    inventory.append({'name':name,'version':version,'license':dist.metadata.get('License-Expression') or dist.metadata.get('License'),'licenseFiles':copied})
python_license = Path(sys.base_prefix)/'LICENSE.txt'
if python_license.exists(): shutil.copyfile(python_license,target/'Python-LICENSE.txt')
(target/'inventory.json').write_text(json.dumps(inventory,indent=2)+'\n',encoding='utf-8')
print('Locked Python environment verified; license inventory collected.')
