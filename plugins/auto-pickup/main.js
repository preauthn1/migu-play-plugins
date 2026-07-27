// 自动拾取 — 移植自 BetterGI「自动拾取」：周期性发送 F 键交互/拾取。
// author: preauthn1 (ported from babalae/better-genshin-impact pick feature)
(function () {
  if (window.__miguPlugin_auto_pickup) return;
  window.__miguPlugin_auto_pickup = true;

  var running = false;
  var timer = null;

  function key(type) {
    var ev = new KeyboardEvent(type, {
      bubbles: true, cancelable: true, key: 'f', code: 'KeyF', keyCode: 70,
      which: 70
    });
    (document.querySelector('video') || document.body).dispatchEvent(ev);
    document.dispatchEvent(ev);
  }

  function press() {
    key('keydown');
    setTimeout(function () { key('keyup'); }, 40);
  }

  var btn = document.createElement('div');
  btn.textContent = '\u62fe\u53d6';
  btn.style.cssText =
    'position:fixed;right:8px;bottom:192px;z-index:2147483647;' +
    'width:40px;height:40px;line-height:40px;text-align:center;' +
    'border-radius:20px;background:rgba(0,0,0,0.45);color:#fff;' +
    'font-size:12px;user-select:none;cursor:pointer;';
  btn.addEventListener('click', function () {
    running = !running;
    btn.style.background = running ? 'rgba(216,27,96,0.8)' : 'rgba(0,0,0,0.45)';
    if (running) {
      timer = setInterval(press, 250);
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
