#!/usr/bin/env python3
"""Validate every plugin in plugins/ against the repo spec.

Usage: python3 tools/validate.py [--build-index]
Exit code 0 = all plugins valid. Also writes index.json with --build-index.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / 'plugins'
MAX_JS_BYTES = 64 * 1024
ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{1,40}$')
VER_RE = re.compile(r'^\d+\.\d+\.\d+$')
REQUIRED = ['id', 'name', 'version', 'author', 'description', 'match',
            'minAppVersion']
ALLOWED = set(REQUIRED + ['homepage', 'permissions'])
BANNED_JS = [
    (re.compile(r'\beval\s*\('), 'eval()'),
    (re.compile(r'\bnew\s+Function\s*\('), 'new Function()'),
    (re.compile(r'document\.write'), 'document.write'),
    (re.compile(r'\bimport\s*\('), 'dynamic import()'),
    (re.compile(r'MiguNative'), 'MiguNative (host-only channel)'),
]


def fail(errors):
    for e in errors:
        print(f'FAIL: {e}')
    sys.exit(1)


def check_plugin(d: Path, errors: list) -> dict | None:
    pj = d / 'plugin.json'
    js = d / 'main.js'
    rd = d / 'README.md'
    for f in (pj, js, rd):
        if not f.is_file():
            errors.append(f'{d.name}: missing {f.name}')
            return None
    try:
        meta = json.loads(pj.read_text(encoding='utf-8'))
    except Exception as e:
        errors.append(f'{d.name}: plugin.json is not valid JSON: {e}')
        return None
    for k in REQUIRED:
        if k not in meta:
            errors.append(f'{d.name}: plugin.json missing "{k}"')
    for k in meta:
        if k not in ALLOWED:
            errors.append(f'{d.name}: plugin.json unknown field "{k}"')
    if meta.get('id') != d.name:
        errors.append(f'{d.name}: id "{meta.get("id")}" != directory name')
    if not ID_RE.match(str(meta.get('id', ''))):
        errors.append(f'{d.name}: id must match {ID_RE.pattern}')
    if not VER_RE.match(str(meta.get('version', ''))):
        errors.append(f'{d.name}: version must be x.y.z')
    if not VER_RE.match(str(meta.get('minAppVersion', ''))):
        errors.append(f'{d.name}: minAppVersion must be x.y.z')
    if len(str(meta.get('name', ''))) > 20:
        errors.append(f'{d.name}: name longer than 20 chars')
    if len(str(meta.get('description', ''))) > 100:
        errors.append(f'{d.name}: description longer than 100 chars')
    m = meta.get('match')
    if not isinstance(m, list) or not m or not all(
            isinstance(x, str) and x for x in m):
        errors.append(f'{d.name}: match must be a non-empty string array')
    if meta.get('permissions') not in (None, []):
        errors.append(f'{d.name}: permissions must be [] (reserved)')

    src = js.read_text(encoding='utf-8')
    raw = js.read_bytes()
    if len(raw) > MAX_JS_BYTES:
        errors.append(f'{d.name}: main.js exceeds {MAX_JS_BYTES} bytes')
    stripped = src.lstrip()
    # allow leading // or /* */ comments before the IIFE
    body = re.sub(r'^(\s*(//[^\n]*\n|/\*.*?\*/\s*))*', '', stripped,
                  flags=re.S)
    if not body.startswith('(function'):
        errors.append(f'{d.name}: main.js must be an IIFE '
                      f'"(function () {{ ... }})();"')
    for pat, label in BANNED_JS:
        if pat.search(src):
            errors.append(f'{d.name}: banned construct: {label}')
    if 'src=' in src and '<script' in src.replace(' ', '').lower():
        errors.append(f'{d.name}: external <script src> is banned')
    return meta


def main():
    errors: list = []
    entries = []
    if not PLUGINS.is_dir():
        fail(['plugins/ directory missing'])
    dirs = sorted(p for p in PLUGINS.iterdir() if p.is_dir())
    if not dirs:
        fail(['plugins/ contains no plugins'])
    seen = set()
    for d in dirs:
        meta = check_plugin(d, errors)
        if meta and meta.get('id'):
            if meta['id'] in seen:
                errors.append(f'duplicate plugin id {meta["id"]}')
            seen.add(meta['id'])
            entries.append({
                'id': meta['id'],
                'name': meta.get('name', ''),
                'version': meta.get('version', ''),
                'author': meta.get('author', ''),
                'description': meta.get('description', ''),
                'match': meta.get('match', []),
                'minAppVersion': meta.get('minAppVersion', ''),
                'homepage': meta.get('homepage', ''),
                'script': f'plugins/{meta["id"]}/main.js',
            })
    if errors:
        fail(errors)
    print(f'OK: {len(entries)} plugin(s) valid')
    if '--build-index' in sys.argv:
        index = {'schema': 1, 'plugins': entries}
        (ROOT / 'index.json').write_text(
            json.dumps(index, ensure_ascii=False, indent=2) + '\n',
            encoding='utf-8')
        print('index.json written')


if __name__ == '__main__':
    main()
