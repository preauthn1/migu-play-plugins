// FPS 显示 — 在画面左上角显示实时渲染帧率。
// author: preauthn1
(function () {
  if (window.__miguPlugin_fps_overlay) return;
  window.__miguPlugin_fps_overlay = true;

  var box = document.createElement('div');
  box.style.cssText =
    'position:fixed;left:8px;top:64px;z-index:2147483647;' +
    'padding:2px 8px;border-radius:10px;background:rgba(0,0,0,0.5);' +
    'color:#0f0;font:12px/18px monospace;pointer-events:none;';
  box.textContent = 'FPS --';

  var frames = 0;
  var last = performance.now();
  function tick(now) {
    frames++;
    if (now - last >= 1000) {
      box.textContent = 'FPS ' + Math.round(frames * 1000 / (now - last));
      frames = 0;
      last = now;
    }
    requestAnimationFrame(tick);
  }

  function mount() {
    if (document.body) {
      document.body.appendChild(box);
      requestAnimationFrame(tick);
    } else {
      setTimeout(mount, 300);
    }
  }
  mount();
})();
