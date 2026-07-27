// 护眼滤镜 — 给游戏页面叠加可开关的暖色滤镜，降低夜间蓝光刺激。
// author: preauthn1
(function () {
  if (window.__miguPlugin_eye_care) return;
  window.__miguPlugin_eye_care = true;

  var on = false;
  var overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483646;' +
    'background:rgba(255,140,0,0.14);mix-blend-mode:multiply;display:none;';

  var btn = document.createElement('div');
  btn.textContent = '\u62a4\u773c';
  btn.style.cssText =
    'position:fixed;right:8px;bottom:96px;z-index:2147483647;' +
    'width:40px;height:40px;line-height:40px;text-align:center;' +
    'border-radius:20px;background:rgba(0,0,0,0.45);color:#fff;' +
    'font-size:12px;user-select:none;cursor:pointer;';
  btn.addEventListener('click', function () {
    on = !on;
    overlay.style.display = on ? 'block' : 'none';
    btn.style.background = on ? 'rgba(216,27,96,0.8)' : 'rgba(0,0,0,0.45)';
  });

  function mount() {
    if (document.body) {
      document.body.appendChild(overlay);
      document.body.appendChild(btn);
    } else {
      setTimeout(mount, 300);
    }
  }
  mount();
})();
