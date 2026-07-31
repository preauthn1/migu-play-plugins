#!/usr/bin/env python3
"""Validate every plugin in plugins/ against the repo spec.

Usage: python3 tools/validate.py [--build-index]
Exit code 0 = all plugins valid. Also writes index.json with --build-index.
"""
import hashlib
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
ALLOWED = set(REQUIRED + ['homepage', 'permissions', 'assets', 'hosts'])
BANNED_JS = [
    (re.compile(r'\beval\s*\('), 'eval()'),
    (re.compile(r'\bnew\s+Function\s*\('), 'new Function()'),
    (re.compile(r'document\.write'), 'document.write'),
    (re.compile(r'\bimport\s*\('), 'dynamic import()'),
    (re.compile(r'MiguNative'), 'MiguNative (host-only channel)'),
]

# --- 大体积资源（WASM/数据集）支持 -------------------------------------------
# 背景：地图叠加这类插件需要 opencv 级别的 WASM 与 MB 级数据集，装不进 64KB
# main.js。放开体积的前提是**内容可校验**：每个资源必须在 plugin.json 里登记
# sha256，校验器与 App 双侧比对，避免仓库/CDN 被替换后静默加载不同代码。
PERMISSIONS_ALLOWED = {'wasm', 'large-assets', 'frame-capture', 'remote-tiles'}
ASSET_EXT_ALLOWED = {'.wasm', '.json', '.bin', '.png', '.webp', '.csv',
                     # 照片类底图：地图参照图用 JPEG 比 PNG 小一个数量级
                     # （3072x2048 实测 0.27MB vs 数 MB），而它只用于特征
                     # 匹配，不需要无损。仍受 sha256 与体积上限约束。
                     '.jpg', '.jpeg'}
# emscripten 的 WASM 胶水层就是一个 .js（opencv.js 把 wasm 以 base64 内嵌其中），
# 所以声明了 wasm 权限的插件必须能带 .js 资产。这不等于"可以随便塞代码"：
# 每个资产都用 sha256 锁死，App 侧下载后先校验哈希再执行，
# 内容与评审时逐字节一致，改一个字符就会被拒。
ASSET_EXT_WASM_ONLY = {'.js', '.mjs'}
MAX_ASSET_BYTES = 12 * 1024 * 1024       # 单个资源
MAX_ASSETS_TOTAL_BYTES = 24 * 1024 * 1024  # 单插件资源合计
ASSET_PATH_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}$')
SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
# 默认允许的主机：仅本仓库。声明 remote-tiles 权限的插件可额外访问
# hosts 白名单里登记的**只读图片/数据**源（如地图瓦片 CDN），
# 每个主机必须在 plugin.json 的 hosts 里显式登记并在审核中说明用途。
REPO_HOSTS = {'raw.githubusercontent.com', 'github.com'}
HOST_RE = re.compile(r'^[a-z0-9][a-z0-9.\-]{2,120}$')
# WASM 需要这些构造，仅在声明 wasm 权限时解禁；其余插件仍然全面禁止。
WASM_ONLY_JS = [
    (re.compile(r'WebAssembly\s*\.'), 'WebAssembly.*'),
    (re.compile(r'\bnew\s+Function\s*\('), 'new Function()'),
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

    perms = meta.get('permissions', [])
    if perms is None:
        perms = []
    if not isinstance(perms, list) or not all(isinstance(p, str) for p in perms):
        errors.append(f'{d.name}: permissions must be a string array')
        perms = []
    for p in perms:
        if p not in PERMISSIONS_ALLOWED:
            errors.append(f'{d.name}: unknown permission "{p}" '
                          f'(allowed: {sorted(PERMISSIONS_ALLOWED)})')
    perms = set(perms)

    assets = validate_assets(d, meta, perms, errors)

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
    # 声明 wasm 权限的插件解禁 WebAssembly.* 与 new Function（emscripten 胶水
    # 代码必需），但 eval / document.write / 动态 import / MiguNative 仍然禁止。
    wasm_ok = 'wasm' in perms
    exempt = {label for _, label in WASM_ONLY_JS} if wasm_ok else set()
    for pat, label in BANNED_JS:
        if label in exempt:
            continue
        if pat.search(src):
            errors.append(f'{d.name}: banned construct: {label}')
    if 'src=' in src and '<script' in src.replace(' ', '').lower():
        errors.append(f'{d.name}: external <script src> is banned')
    # 大资源只能来自本仓库；声明 remote-tiles 权限的插件可访问 hosts 里
    # 显式登记的只读源。出现未登记主机即拒绝（防止把插件变成远程加载器）。
    hosts = validate_hosts(d, meta, perms, errors)
    allowed_hosts = REPO_HOSTS | hosts
    # 只扫**代码**里的主机名。不剥注释会把"为什么不再访问某主机"的说明
    # 判成违规（实测：修复 CORS 问题时，注释里引用的报错文本触发了误报），
    # 逼作者删掉正好最该保留的解释。
    code = strip_js_comments(src)
    for host in re.findall(r'https?://([A-Za-z0-9.\-]+)', code):
        if host not in allowed_hosts:
            errors.append(f'{d.name}: external network host "{host}" is not '
                          f'declared (add it to "hosts" with the remote-tiles '
                          f'permission, or ship the asset in this repo)')
    if assets:
        meta['assets'] = assets
    if hosts:
        meta['hosts'] = sorted(hosts)
    return meta


def strip_js_comments(src: str) -> str:
    """Remove /* */ and // comments so scans see code, not explanations.

    Naive on purpose: it can also strip a `//` inside a string literal, which
    for host scanning is harmless (a URL in a string still has its host on the
    same line before any `//`). Being slightly over-eager here is much better
    than flagging a comment that documents why a host is no longer used.
    """
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    out = []
    for line in src.split('\n'):
        i = line.find('//')
        # keep protocol separators like https://
        while i != -1 and i >= 1 and line[i - 1] == ':':
            i = line.find('//', i + 2)
        out.append(line if i == -1 else line[:i])
    return '\n'.join(out)


def validate_hosts(d: Path, meta: dict, perms: set, errors: list) -> set:
    """校验 hosts 白名单：必须配 remote-tiles 权限，且只允许 https 主机名。"""
    hosts = meta.get('hosts')
    if hosts in (None, []):
        return set()
    if not isinstance(hosts, list) or not all(isinstance(h, str) for h in hosts):
        errors.append(f'{d.name}: hosts must be a string array')
        return set()
    if 'remote-tiles' not in perms:
        errors.append(f'{d.name}: hosts require the "remote-tiles" permission')
    out = set()
    for h in hosts:
        h = h.strip().lower()
        if not HOST_RE.match(h) or '/' in h:
            errors.append(f'{d.name}: invalid host "{h}" (bare hostname only)')
            continue
        out.add(h)
    return out


def validate_assets(d: Path, meta: dict, perms: set, errors: list) -> list:
    """校验 assets 清单：路径安全、扩展名白名单、体积、sha256 与实际文件一致。

    返回补全了 size 的 assets 列表（写入 index.json，供 App 侧再次校验）。
    """
    assets = meta.get('assets')
    if assets in (None, []):
        return []
    if not isinstance(assets, list):
        errors.append(f'{d.name}: assets must be an array')
        return []
    if 'large-assets' not in perms:
        errors.append(f'{d.name}: assets require the "large-assets" permission')
    out = []
    total = 0
    seen = set()
    for i, a in enumerate(assets):
        if not isinstance(a, dict):
            errors.append(f'{d.name}: assets[{i}] must be an object')
            continue
        extra = set(a) - {'path', 'sha256', 'size'}
        if extra:
            errors.append(f'{d.name}: assets[{i}] unknown fields {sorted(extra)}')
        path = a.get('path', '')
        sha = str(a.get('sha256', '')).lower()
        if not isinstance(path, str) or not ASSET_PATH_RE.match(path):
            errors.append(f'{d.name}: assets[{i}] invalid path "{path}"')
            continue
        # 路径穿越防护：拼接后必须仍在插件目录内。
        if '..' in Path(path).parts or Path(path).is_absolute():
            errors.append(f'{d.name}: assets[{i}] path escapes plugin dir')
            continue
        if path in seen:
            errors.append(f'{d.name}: assets[{i}] duplicate path "{path}"')
        seen.add(path)
        f = d / path
        try:
            resolved = f.resolve()
            if not str(resolved).startswith(str(d.resolve())):
                errors.append(f'{d.name}: assets[{i}] resolves outside plugin dir')
                continue
        except Exception:
            errors.append(f'{d.name}: assets[{i}] unresolvable path')
            continue
        if f.suffix.lower() not in ASSET_EXT_ALLOWED:
            if f.suffix.lower() in ASSET_EXT_WASM_ONLY:
                # .js/.mjs 只对声明了 wasm 权限的插件开放（emscripten 胶水层）
                if 'wasm' not in perms:
                    errors.append(f'{d.name}: assets[{i}] "{path}" needs the '
                                  f'"wasm" permission to ship a '
                                  f'{f.suffix} asset')
            else:
                errors.append(f'{d.name}: assets[{i}] extension "{f.suffix}" not '
                              f'allowed {sorted(ASSET_EXT_ALLOWED)}')
        if not f.is_file():
            errors.append(f'{d.name}: assets[{i}] missing file "{path}"')
            continue
        blob = f.read_bytes()
        size = len(blob)
        total += size
        if size > MAX_ASSET_BYTES:
            errors.append(f'{d.name}: assets[{i}] "{path}" is {size} bytes '
                          f'(max {MAX_ASSET_BYTES})')
        if not SHA256_RE.match(sha):
            errors.append(f'{d.name}: assets[{i}] sha256 must be 64 lowercase hex')
        else:
            actual = hashlib.sha256(blob).hexdigest()
            if actual != sha:
                errors.append(f'{d.name}: assets[{i}] "{path}" sha256 mismatch '
                              f'(manifest {sha[:12]}…, actual {actual[:12]}…)')
        if 'size' in a and a['size'] != size:
            errors.append(f'{d.name}: assets[{i}] "{path}" size {a["size"]} '
                          f'!= actual {size}')
        out.append({'path': path, 'sha256': sha, 'size': size})
    if total > MAX_ASSETS_TOTAL_BYTES:
        errors.append(f'{d.name}: assets total {total} bytes exceeds '
                      f'{MAX_ASSETS_TOTAL_BYTES}')
    return out


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
                'permissions': sorted(meta.get('permissions', []) or []),
                'assets': meta.get('assets', []),
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
