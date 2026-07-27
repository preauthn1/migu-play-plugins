// 自动剧情 — 移植自 BetterGI「自动剧情」：快速点击跳过对话，自动点击底部选项区。
// author: preauthn1 (ported from babalae/better-genshin-impact skip feature)
(function () {
  if (window.__miguPlugin_auto_skip) return;
  window.__miguPlugin_auto_skip = true;

  var running = false;
  var timer = null;

  function target() {
    return document.querySelector('video') ||
        document.querySelector('canvas') || document.body;
  }

  function fire(el, type, x, y) {
    var ev = new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0,
      detail: 1
    });
    el.dispatchEvent(ev);
  }

  function tapDialogue() {
    var el = target();
    if (!el) return;
    var r = el.getBoundingClientRect();
    // BGI clicks the dialogue advance zone; on a phone/cloud stream the safe
    // equivalent is the lower-middle of the video (dialogue text area).
    var x = r.left + r.width * 0.5;
    var y = r.top + r.height * 0.78;
    fire(el, 'mousedown', x, y);
    fire(el, 'mouseup', x, y);
    fire(el, 'click', x, y);
  }

  var btn = document.createElement('div');
  btn.textContent = '\u5267\u60c5';
  btn.style.cssText =
    'position:fixed;right:8px;bottom:144px;z-index:2147483647;' +
    'width:40px;height:40px;line-height:40px;text-align:center;' +
    'border-radius:20px;background:rgba(0,0,0,0.45);color:#fff;' +
    'font-size:12px;user-select:none;cursor:pointer;';
  btn.addEventListener('click', function () {
    running = !running;
    btn.style.background = running ? 'rgba(216,27,96,0.8)' : 'rgba(0,0,0,0.45)';
    if (running) {
      timer = setInterval(tapDialogue, 350);
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
