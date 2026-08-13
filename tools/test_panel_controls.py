#!/usr/bin/env python3
"""Regression: panel header controls must receive their own pointer/click events.

The panel deliberately blocks events from reaching the cloud game.  The blocker
must run in bubble phase; a capture-phase stopPropagation on the panel prevents
its descendant buttons from ever receiving clicks.
"""
import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
MAIN_JS = ROOT / "plugins" / "genshin-map-overlay" / "main.js"


async def main() -> None:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            executable_path="/usr/bin/chromium",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            page = await browser.new_page(viewport={"width": 800, "height": 600})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            await page.set_content("<!doctype html><html><body></body></html>")
            await page.add_script_tag(content=MAIN_JS.read_text(encoding="utf-8"))
            await page.wait_for_function("() => !!window.__miguMapOverlayShowLog")

            # No network/data initialization is needed to test the header itself.
            await page.evaluate("""() => {
                const status = document.getElementById('__migu_ov_status');
                const panel = status.parentElement;
                panel.style.display = 'flex';
            }""")

            buttons = page.locator("#__migu_ov_status").locator("xpath=preceding-sibling::div[1]").locator("div")
            # Header children are: title span, 日志, —, ✕.
            log_button = buttons.filter(has_text="日志")
            fold_button = buttons.filter(has_text="—")
            close_button = buttons.filter(has_text="✕")

            await log_button.click()
            log_open = await page.evaluate("""() => [...document.body.children].some(
                e => e.style.zIndex === '2147483646' && e.style.display === 'flex')""")
            assert log_open, "日志按钮点击后未打开日志页"
            await page.evaluate("""() => [...document.body.children].find(
                e => e.style.zIndex === '2147483646').style.display = 'none'""")

            await fold_button.click()
            search_display = await page.locator("input[placeholder='搜索分类…']").evaluate("e => e.style.display")
            assert search_display == "none", f"折叠按钮未隐藏列表，display={search_display!r}"

            await close_button.click()
            panel_display = await page.locator("#__migu_ov_status").evaluate("e => e.parentElement.style.display")
            assert panel_display == "none", f"关闭按钮未关闭面板，display={panel_display!r}"
            assert not errors, f"页面异常: {errors}"
            print("PASS: 日志、折叠、关闭三个按钮均可点击")
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
