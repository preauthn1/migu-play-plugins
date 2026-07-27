// 键鼠录制 — 移植自 BetterGI「键鼠录制」：录制页面上的点击序列并循环回放。
// author: preauthn1 (ported from babalae/better-genshin-impact kmscript)
(function () {
  if (window.__miguPlugin_macro_recorder) return;
  window.__miguPlugin_macro_recorder = true;

  var recording = false;
  var playing = false;
  var events = [];
  var t0 = 0;
  var playTimers = [];

  function fire(type, x, y) {
    var el = document.elementFromPoint(x, y) || document.body;
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, button: 0,
      buttons: type === 'mousedown' ? 1 : 0, detail: 1
    }));
  }

  function onDown(e) {
    if (!recording) return;
    if (e.target === recBtn || e.target === playBtn) return;
    events.push({ t: Date.now() - t0, x: e.clientX, y: e.clientY });
  }

  function stopPlay() {
    playing = false;
    playTimers.forEach(clearTimeout);
    playTimers = [];
    playBtn.style.background = 'rgba(0,0,0,0.45)';
  }

  function playOnce(loop) {
    if (!events.length) return;
    events.forEach(function (ev) {
      playTimers.push(setTimeout(function () {
        fire('mousedown', ev.x, ev.y);
        fire('mouseup', ev.x, ev.y);
        fire('click', ev.x, ev.y);
      }, ev.t));
    });
    var total = events[events.length - 1].t + 600;
    playTimers.push(setTimeout(function () {
      if (playing && loop) playOnce(true);
    }, total));
  }

  function mkBtn(text, bottom) {
    var b = document.createElement('div');
    b.textContent = text;
    b.style.cssText =
      'position:fixed;right:8px;bottom:' + bottom + 'px;z-index:2147483647;' +
      'width:40px;height:40px;line-height:40px;text-align:center;' +
      'border-radius:20px;background:rgba(0,0,0,0.45);color:#fff;' +
      'font-size:12px;user-select:none;cursor:pointer;';
    return b;
  }

  var recBtn = mkBtn('\u5f55', 240);
  var playBtn = mkBtn('\u653e', 288);

  recBtn.addEventListener('click', function () {
    if (playing) stopPlay();
    recording = !recording;
    if (recording) {
      events = [];
      t0 = Date.now();
      recBtn.style.background = 'rgba(216,27,96,0.8)';
      recBtn.textContent = '\u505c';
    } else {
      recBtn.style.background = 'rgba(0,0,0,0.45)';
      recBtn.textContent = '\u5f55';
    }
  });

  playBtn.addEventListener('click', function () {
    if (recording) recBtn.click();
    if (playing) { stopPlay(); return; }
    if (!events.length) return;
    playing = true;
    playBtn.style.background = 'rgba(216,27,96,0.8)';
    playOnce(true);
  });

  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('touchstart', function (e) {
    if (!recording || !e.touches.length) return;
    var t = e.touches[0];
    if (e.target === recBtn || e.target === playBtn) return;
    events.push({ t: Date.now() - t0, x: t.clientX, y: t.clientY });
  }, true);

  function mount() {
    if (document.body) {
      document.body.appendChild(recBtn);
      document.body.appendChild(playBtn);
    } else {
      setTimeout(mount, 300);
    }
  }
  mount();
})();
