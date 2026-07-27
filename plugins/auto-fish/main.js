// 自动钓鱼 — 移植自 BetterGI「半自动钓鱼」思路的定时按键版：循环按 F 抛竿/收杆。
// author: preauthn1 (ported from babalae/better-genshin-impact fish concept)
(function () {
  if (window.__miguPlugin_auto_fish) return;
  window.__miguPlugin_auto_fish = true;

  var running = false;
  var timer = null;
  var phase = 0;

  function key(type, k, code, kc) {
    var ev = new KeyboardEvent(type, {
      bubbles: true, cancelable: true, key: k, code: code, keyCode: kc,
      which: kc
    });
    (document.querySelector('video') || document.body).dispatchEvent(ev);
    document.dispatchEvent(ev);
  }

  function press(k, code, kc, holdMs) {
    key('keydown', k, code, kc);
    setTimeout(function () { key('keyup', k, code, kc); }, holdMs || 60);
  }

  // BGI uses AI frame recognition to time the strike. A cloud page cannot see
  // frames, so this port uses a fixed cast/wait/reel cadence the user can tune
  // mentally: F (interact/cast) ... wait ... F (strike) ... repeat.
  function tick() {
    phase = (phase + 1) % 12;
    if (phase === 0) press('f', 'KeyF', 70);          // cast / collect
    if (phase === 6) press('f', 'KeyF', 70, 300);     // strike / reel
  }

  var btn = document.createElement('div');
  btn.textContent = '\u9493\u9c7c';
  btn.style.cssText =
    'position:fixed;right:8px;bottom:384px;z-index:2147483647;' +
    'width:40px;height:40px;line-height:40px;text-align:center;' +
    'border-radius:20px;background:rgba(0,0,0,0.45);color:#fff;' +
    'font-size:12px;user-select:none;cursor:pointer;';
  btn.addEventListener('click', function () {
    running = !running;
    btn.style.background = running ? 'rgba(216,27,96,0.8)' : 'rgba(0,0,0,0.45)';
    if (running) {
      phase = -1;
      timer = setInterval(tick, 1000);
    } else {
      clearInterval(timer);
    }
  });

  function mount() {
    if (document.body) document.body.appendChild(btn);
    else setTimeout(mount, 300);
  }
  mount();
})();
