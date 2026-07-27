// 转圈助手 — 移植自 BetterGI「那维莱特转圈」：按住按钮持续水平旋转视角。
// author: preauthn1 (ported from babalae/better-genshin-impact macro)
(function () {
  if (window.__miguPlugin_spin_helper) return;
  window.__miguPlugin_spin_helper = true;

  var spinning = false;
  var raf = null;

  function target() {
    return document.querySelector('video') ||
        document.querySelector('canvas') || document.body;
  }

  function step() {
    if (!spinning) return;
    var el = target();
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    // Continuous small horizontal drags: pointerdown -> moves -> pointerup,
    // repeated. Cloud streams read them as camera rotation.
    var seq = [
      ['mousedown', cx, cy, 1],
      ['mousemove', cx + 60, cy, 1],
      ['mousemove', cx + 120, cy, 1],
      ['mouseup', cx + 120, cy, 0]
    ];
    seq.forEach(function (s, i) {
      setTimeout(function () {
        el.dispatchEvent(new MouseEvent(s[0], {
          bubbles: true, cancelable: true, view: window,
          clientX: s[1], clientY: s[2], button: 0, buttons: s[3], detail: 1
        }));
      }, i * 16);
    });
    raf = setTimeout(step, 90);
  }

  var btn = document.createElement('div');
  btn.textContent = '\u8f6c\u5708';
  btn.style.cssText =
    'position:fixed;right:8px;bottom:336px;z-index:2147483647;' +
    'width:40px;height:40px;line-height:40px;text-align:center;' +
    'border-radius:20px;background:rgba(0,0,0,0.45);color:#fff;' +
    'font-size:12px;user-select:none;cursor:pointer;';
  btn.addEventListener('click', function () {
    spinning = !spinning;
    btn.style.background =
        spinning ? 'rgba(216,27,96,0.8)' : 'rgba(0,0,0,0.45)';
    if (spinning) step();
    else clearTimeout(raf);
  });

  function mount() {
    if (document.body) document.body.appendChild(btn);
    else setTimeout(mount, 300);
  }
  mount();
})();
