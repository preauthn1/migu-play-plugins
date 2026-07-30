// 原神地图叠加 — 把 wiki 全地标点位覆盖在游戏内大地图上。
// 保留 wiki 原有的「点位列表」分类选择，快捷键切换，连续跟随玩家的拖动/缩放。
// author: preauthn1
(function () {
  if (window.__miguPlugin_genshin_map_overlay) return;
  window.__miguPlugin_genshin_map_overlay = true;

  var REPO = 'https://raw.githubusercontent.com/preauthn1/migu-play-plugins/main/plugins/genshin-map-overlay/';
  var TILE = 'https://wiki-dev-patch-oss.oss-cn-hangzhou.aliyuncs.com/res/ys/map-6.7/1/tiles-G/';

  // ---- 标定常量（实测确定，改前先读 README 的"标定"一节）------------------
  var Z = 5, S = 256, LX0 = -16, LY0 = -8, LX1 = 7, LY1 = 7;
  var A = 0.0078125;               // Leaflet CRS.Simple transformation
  var REF_W = (LX1 - LX0 + 1) * S; // 参照拼图尺寸
  var REF_H = (LY1 - LY0 + 1) * S;

  // ---- 状态 ---------------------------------------------------------------
  var st = {
    on: false, ready: false, loading: false, listOpen: true,
    cats: null,                 // {markType: {n, p:[[lng,lat],...]}}
    enabled: {},                // markType -> bool
    // world(参照拼图像素) -> screen(画面 CSS 像素)：screen = w*k + (tx,ty)
    fit: null,                  // {k, tx, ty}
    tracking: false,            // 是否正在用光流维持 fit
    prevGrey: null, prevPts: null, prevW: 0, prevH: 0,
    lastFullFit: 0, zoomAccum: 1, frames: 0, quality: '未定位',
    surface: null, raf: 0, drift: 0
  };

  // ---- DOM：叠加画布 + 点位列表面板 ---------------------------------------
  // 关键：画布 pointer-events:none，面板只在自身区域接收事件，
  // 其余全部落到游戏，保证游戏照常操作。
  var layer = document.createElement('canvas');
  layer.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483000;' +
    'pointer-events:none;display:none';

  var panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:10px;top:10px;z-index:2147483600;' +
    'width:230px;max-height:78vh;display:none;flex-direction:column;' +
    'background:rgba(12,16,24,.90);border:1px solid rgba(255,255,255,.13);' +
    'border-radius:10px;color:#dbe4ee;font:12px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;' +
    'box-shadow:0 8px 28px rgba(0,0,0,.5);overflow:hidden;' +
    // 面板自身要能点，但绝不把事件冒泡给游戏
    'pointer-events:auto;user-select:none';

  var head = document.createElement('div');
  head.style.cssText = 'padding:7px 10px;background:rgba(255,255,255,.06);' +
    'display:flex;align-items:center;gap:6px;cursor:move;font-weight:600';
  head.innerHTML = '<span style="flex:1">点位列表</span>';
  var btnFold = mkBtn('—', '折叠列表');
  var btnClose = mkBtn('✕', '关闭叠加（桌面端 F8）');
  head.appendChild(btnFold); head.appendChild(btnClose);

  var status = document.createElement('div');
  status.style.cssText = 'padding:4px 10px;font:11px/1.5 monospace;color:#7fd6c0;' +
    'background:rgba(0,0,0,.25)';

  var search = document.createElement('input');
  search.placeholder = '搜索分类…';
  search.style.cssText = 'margin:7px 10px 4px;padding:5px 8px;border-radius:6px;' +
    'border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);' +
    'color:#eaf1f8;font-size:12px;outline:none';

  var tools = document.createElement('div');
  tools.style.cssText = 'display:flex;gap:6px;padding:0 10px 6px';
  var btnAll = mkTool('全选'), btnNone = mkTool('清空'), btnRefit = mkTool('重定位');
  tools.appendChild(btnAll); tools.appendChild(btnNone); tools.appendChild(btnRefit);

  var list = document.createElement('div');
  list.style.cssText = 'overflow-y:auto;padding:0 4px 8px;flex:1';

  panel.appendChild(head); panel.appendChild(status);
  panel.appendChild(search); panel.appendChild(tools); panel.appendChild(list);

  function mkBtn(txt, title) {
    var b = document.createElement('div');
    b.textContent = txt; b.title = title || '';
    b.style.cssText = 'width:18px;height:18px;display:flex;align-items:center;' +
      'justify-content:center;border-radius:4px;cursor:pointer;' +
      'background:rgba(255,255,255,.10);font-size:11px';
    return b;
  }
  function mkTool(txt) {
    var b = document.createElement('div');
    b.textContent = txt;
    b.style.cssText = 'flex:1;text-align:center;padding:4px 0;border-radius:6px;' +
      'cursor:pointer;background:rgba(255,255,255,.09);font-size:11px';
    return b;
  }

  // ---- 移动端入口：一个可拖动的悬浮按钮 ------------------------------------
  // 手机上没有 F8。之前只绑了 keydown，等于叠加层在 Android 上根本打不开
  // （面板默认 display:none），功能形同不存在。悬浮球是唯一可靠的触摸入口：
  // 云游戏画面本身要接收滑动/点击，不能靠"长按画面"之类的手势去抢输入。
  var fab = document.createElement('div');
  fab.textContent = '图';
  fab.title = '原神地图叠加（桌面端快捷键 F8）';
  fab.style.cssText = 'position:fixed;right:14px;bottom:96px;z-index:2147483500;' +
    'width:44px;height:44px;border-radius:50%;display:flex;align-items:center;' +
    'justify-content:center;font:600 15px/1 system-ui,-apple-system,sans-serif;' +
    'color:#eaf4ff;background:rgba(18,26,40,.82);' +
    'border:1px solid rgba(255,255,255,.22);' +
    'box-shadow:0 4px 14px rgba(0,0,0,.45);' +
    'pointer-events:auto;user-select:none;-webkit-user-select:none;' +
    'touch-action:none;cursor:pointer';

  // 悬浮球自身的事件绝不能冒泡到游戏，否则点它会同时操作游戏。
  //
  // 关键：这里必须用**冒泡阶段**（第三参数 false）。用捕获阶段
  // (true) 会在事件到达元素之前就 stopPropagation，把下面那套
  // pointerdown/up 开关逻辑一起掐死 —— 实测表现为"点了没反应"，
  // 且只有 capture handler 被触发、bubble handler 从不执行。
  ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup',
   'click', 'touchstart', 'touchmove', 'touchend'].forEach(function (t) {
    fab.addEventListener(t, function (e) { e.stopPropagation(); }, false);
  });

  // 拖动与点击要区分开：移动超过阈值算拖动，不触发开关。
  (function () {
    var dragging = false, moved = false, ox = 0, oy = 0, pid = null;
    fab.addEventListener('pointerdown', function (e) {
      dragging = true; moved = false; pid = e.pointerId;
      var r = fab.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      try { fab.setPointerCapture(pid); } catch (_) {}
      e.preventDefault();
    });
    fab.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = Math.abs(e.clientX - (fab.getBoundingClientRect().left + ox));
      var dy = Math.abs(e.clientY - (fab.getBoundingClientRect().top + oy));
      if (dx > 4 || dy > 4) moved = true;
      fab.style.left = (e.clientX - ox) + 'px';
      fab.style.top = (e.clientY - oy) + 'px';
      fab.style.right = 'auto'; fab.style.bottom = 'auto';
      e.preventDefault();
    });
    fab.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      try { fab.releasePointerCapture(pid); } catch (_) {}
      if (!moved) toggle();          // 轻点 = 切换叠加层
      e.preventDefault();
    });
  })();

  function syncFab() {
    fab.style.background = st.on
        ? 'rgba(56,120,190,.92)' : 'rgba(18,26,40,.82)';
  }

  function mount() {
    if (!document.body) { setTimeout(mount, 250); return; }
    document.body.appendChild(layer);
    document.body.appendChild(panel);
    document.body.appendChild(fab);
  }
  mount();

  // 阻止面板上的事件流向游戏（否则拖动面板会同时拖动地图）
  ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click',
   'wheel', 'touchstart', 'touchmove', 'dblclick'].forEach(function (t) {
    panel.addEventListener(t, function (e) { e.stopPropagation(); }, true);
  });

  // 面板可拖动，避免挡住游戏关键区域
  (function () {
    var dragging = false, ox = 0, oy = 0;
    head.addEventListener('pointerdown', function (e) {
      if (e.target === btnFold || e.target === btnClose) return;
      dragging = true;
      var r = panel.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      panel.style.left = (e.clientX - ox) + 'px';
      panel.style.top = (e.clientY - oy) + 'px';
      panel.style.right = 'auto';
    });
    window.addEventListener('pointerup', function () { dragging = false; });
  })();

  btnClose.addEventListener('click', function () { toggle(false); });
  btnFold.addEventListener('click', function () {
    st.listOpen = !st.listOpen;
    [search, tools, list].forEach(function (el) {
      el.style.display = st.listOpen ? '' : 'none';
    });
    btnFold.textContent = st.listOpen ? '—' : '+';
  });
  btnAll.addEventListener('click', function () { setAll(true); });
  btnNone.addEventListener('click', function () { setAll(false); });
  btnRefit.addEventListener('click', function () { fullFit(true); });
  search.addEventListener('input', renderList);

  function setAll(v) {
    for (var k in st.cats) st.enabled[k] = v;
    renderList(); saveEnabled(); draw();
  }

  var LS_KEY = 'migu_map_overlay_enabled_v1';
  function saveEnabled() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(st.enabled)); } catch (_) {}
  }
  function loadEnabled() {
    try {
      var s = localStorage.getItem(LS_KEY);
      if (s) return JSON.parse(s);
    } catch (_) {}
    return null;
  }

  var COLORS = ['#ff5a5a', '#ffd24a', '#8de85f', '#38bdf8', '#c084fc',
                '#fb7185', '#4ade80', '#f59e0b', '#a5f3fc', '#fca5a5'];
  function colorOf(mt) {
    var h = 0, s = String(mt);
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return COLORS[Math.abs(h) % COLORS.length];
  }

  function renderList() {
    if (!st.cats) return;
    var q = (search.value || '').trim();
    list.innerHTML = '';
    var keys = Object.keys(st.cats).sort(function (a, b) {
      return st.cats[b].p.length - st.cats[a].p.length;
    });
    keys.forEach(function (mt) {
      var c = st.cats[mt];
      if (q && c.n.indexOf(q) < 0) return;
      var row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:7px;padding:3px 7px;' +
        'border-radius:6px;cursor:pointer';
      row.addEventListener('mouseenter', function () { row.style.background = 'rgba(255,255,255,.07)'; });
      row.addEventListener('mouseleave', function () { row.style.background = ''; });
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!st.enabled[mt];
      cb.style.cssText = 'accent-color:' + colorOf(mt) + ';margin:0';
      cb.addEventListener('change', function () {
        st.enabled[mt] = cb.checked; saveEnabled(); draw();
      });
      var dot = document.createElement('span');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:none;' +
        'background:' + colorOf(mt);
      var nm = document.createElement('span');
      nm.textContent = c.n; nm.style.cssText = 'flex:1;overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap';
      var ct = document.createElement('span');
      ct.textContent = c.p.length;
      ct.style.cssText = 'font:10px monospace;color:#8b9bb0';
      row.appendChild(cb); row.appendChild(dot); row.appendChild(nm); row.appendChild(ct);
      list.appendChild(row);
    });
  }

  function setStatus(s, cls) {
    st.quality = s;
    status.textContent = s;
    status.style.color = cls === 'bad' ? '#ff8f8f' : (cls === 'warn' ? '#ffd479' : '#7fd6c0');
  }

  // ---- 画面获取 -----------------------------------------------------------
  // 帧新鲜度：真机实测串流画面经常长时间静止（例如停在游戏自己的账号登录框），
  // 此时反复 drawImage 纯属浪费 13.9ms/次。用 requestVideoFrameCallback 的
  // presentedFrames（浏览器权威计数）判断"有没有新帧"，没有就跳过这一轮。
  // 不要用"方差有没有变"来判断——画面静止时方差本来就不变，会误判成取到旧帧。
  var frameTick = { last: -1, now: 0, hooked: false };
  function hookFrameCounter(el) {
    if (frameTick.hooked || !el || !el.requestVideoFrameCallback) return;
    frameTick.hooked = true;
    var cb = function (ts, meta) {
      frameTick.now = meta && meta.presentedFrames != null
          ? meta.presentedFrames : frameTick.now + 1;
      try { el.requestVideoFrameCallback(cb); } catch (_) { frameTick.hooked = false; }
    };
    try { el.requestVideoFrameCallback(cb); } catch (_) { frameTick.hooked = false; }
  }
  // 有新帧才返回 true；不支持 rVFC 的环境一律返回 true（退化为每轮都处理）
  function hasFreshFrame() {
    if (!frameTick.hooked) return true;
    if (frameTick.now === frameTick.last) return false;
    frameTick.last = frameTick.now;
    return true;
  }

  function findSurface() {
    var best = null, area = 0;
    var els = [].slice.call(document.querySelectorAll('video,canvas'));
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e === layer) continue;
      var w = e.videoWidth || e.width || e.clientWidth || 0;
      var h = e.videoHeight || e.height || e.clientHeight || 0;
      if (w * h > area) { area = w * h; best = e; }
    }
    return area > 10000 ? best : null;
  }

  // 抓一帧灰度（缩到 targetW 宽）。返回 {grey,w,h,cssScale} 或 {err}
  function grab(el, targetW) {
    var vw = el.videoWidth || el.width || el.clientWidth;
    var vh = el.videoHeight || el.height || el.clientHeight;
    if (!vw || !vh) return { err: 'NO_SIZE' };
    var tw = Math.min(targetW, vw), th = Math.max(1, Math.round(tw * vh / vw));
    var c = grab._c || (grab._c = document.createElement('canvas'));
    if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; }
    var g = c.getContext('2d', { willReadFrequently: true });
    var d;
    try {
      g.drawImage(el, 0, 0, tw, th);
      d = g.getImageData(0, 0, tw, th);
    } catch (e) {
      return { err: e && e.name === 'SecurityError' ? 'TAINTED' : ('ERR:' + (e && e.name)) };
    }
    var px = d.data, n = tw * th, grey = new Uint8Array(n);
    var sum = 0, sq = 0;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      var v = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
      grey[i] = v; sum += v; sq += v * v;
    }
    var mean = sum / n, std = Math.sqrt(Math.max(0, sq / n - mean * mean));
    if (std < 3) return { err: 'BLANK' };
    // 画面 CSS 尺寸 / 抓帧尺寸：把识别结果换算到屏幕像素
    var r = el.getBoundingClientRect();
    return { grey: grey, w: tw, h: th, cssX: r.left, cssY: r.top,
             cssK: r.width / tw, std: std };
  }

  // ---- OpenCV 运行时就绪 ---------------------------------------------------
  // 宿主把 opencv.js（emscripten 胶水，wasm 以 base64 内嵌）作为**已校验资源**
  // 在本脚本之前注入。实测（headless Chromium + 文本注入路径）：
  //   * 注入本身约 600ms，不阻塞；
  //   * 注入后 window.cv 是一个 **Promise**，此时 cv.ORB 还不存在；
  //   * await 之后 ORB / estimateAffine2D / calcOpticalFlowPyrLK 才可用。
  // 所以绝不能拿到 window.cv 就当模块用 —— 必须先解析。
  // 同时兼容旧构建的 onRuntimeInitialized 回调与直接可用两种形态。
  var cvReady = null;         // Promise<boolean>
  function ensureCv() {
    if (cvReady) return cvReady;
    cvReady = new Promise(function (resolve) {
      var give = function () { resolve(!!(window.cv && window.cv.ORB)); };
      if (!window.cv) {
        // 资源尚未注入：轮询等待宿主注入完成（切换开关的瞬间可能还没到）
        var waited = 0;
        var iv0 = setInterval(function () {
          waited += 200;
          if (window.cv) { clearInterval(iv0); ensureCvInner().then(resolve); }
          else if (waited > 30000) { clearInterval(iv0); resolve(false); }
        }, 200);
        return;
      }
      ensureCvInner().then(resolve);
    });
    return cvReady;

    function ensureCvInner() {
      return new Promise(function (res) {
        var m = window.cv;
        if (m && m.ORB) { res(true); return; }
        // 形态 A：Promise（实测 opencv.js 4.x 就是这种）
        if (m && typeof m.then === 'function') {
          m.then(function (mod) {
            if (mod) window.cv = mod;
            res(!!(window.cv && window.cv.ORB));
          }).catch(function () { res(false); });
          return;
        }
        // 形态 B：onRuntimeInitialized 回调 + 轮询兜底
        var done = false;
        try {
          m.onRuntimeInitialized = function () {
            if (!done) { done = true; res(!!(window.cv && window.cv.ORB)); }
          };
        } catch (_) {}
        var t = 0;
        var iv = setInterval(function () {
          t += 150;
          if (window.cv && window.cv.ORB) {
            clearInterval(iv);
            if (!done) { done = true; res(true); }
          } else if (t > 30000) {
            clearInterval(iv);
            if (!done) { done = true; res(false); }
          }
        }, 150);
      });
    }
  }

  // ---- 变换工具 -----------------------------------------------------------
  // opencv.js 只导出 estimateAffine2D（6 自由度，含剪切/非等比），
  // 没有 estimateAffinePartial2D（4 自由度相似变换）。地图只会平移+等比缩放
  // （实测旋转 0°），所以必须把 6 自由度结果**投影回相似变换**，
  // 否则噪声会引入剪切，叠加层被拉歪、比例失真。
  // 做法：对 2x2 线性部分取最接近的"旋转×统一缩放"（Procrustes/极分解的解析解）。
  function similarityFrom(a11, a12, a21, a22, b1, b2) {
    // 相似变换的线性部分形如 [[s·cosθ, -s·sinθ], [s·sinθ, s·cosθ]]
    var c = (a11 + a22) / 2;   // s·cosθ 的最小二乘估计
    var s = (a21 - a12) / 2;   // s·sinθ 的最小二乘估计
    var scale = Math.sqrt(c * c + s * s);
    if (!isFinite(scale) || scale <= 1e-9) return null;
    return { a: c, b: -s, c: s, d: c, tx: b1, ty: b2, scale: scale };
  }

  function matFromEstimate(M) {
    return similarityFrom(
      M.doubleAt(0, 0), M.doubleAt(0, 1),
      M.doubleAt(1, 0), M.doubleAt(1, 1),
      M.doubleAt(0, 2), M.doubleAt(1, 2));
  }

  // ---- 定位：ORB 全图匹配（慢，低频）+ 光流跟随（快，每帧）----------------
  function fullFit(userAsked) {
    var el = findSurface();
    if (!el) { setStatus('未找到游戏画面', 'bad'); return false; }
    st.surface = el;
    hookFrameCounter(el);   // 首次定位时挂上帧计数，供跟踪循环跳过静止帧
    var f = grab(el, 960);
    if (f.err) { setStatus('画面不可读: ' + f.err, 'bad'); return false; }
    if (!window.cv || !window.cv.ORB || !st.refDesc) {
      setStatus('等待识别引擎', 'warn'); return false;
    }
    try {
      var CV = window.cv;
      var q = CV.matFromArray(f.h, f.w, CV.CV_8UC1, f.grey);
      var orb = new CV.ORB(8000, 1.2, 8, 31, 0, 2, CV.ORB_HARRIS_SCORE, 31, 8);
      var k1 = new CV.KeyPointVector(), d1 = new CV.Mat(), mask = new CV.Mat();
      orb.detectAndCompute(q, mask, k1, d1);
      var bf = new CV.BFMatcher(CV.NORM_HAMMING, false);
      var mm = new CV.DMatchVectorVector();
      bf.knnMatch(d1, st.refDesc, mm, 2);
      var src = [], dst = [];
      for (var i = 0; i < mm.size(); i++) {
        var m = mm.get(i);
        if (m.size() < 2) continue;
        var a = m.get(0), b = m.get(1);
        if (a.distance < 0.8 * b.distance) {
          var p = k1.get(a.queryIdx).pt, r = st.refKp.get(a.trainIdx).pt;
          src.push(p.x, p.y); dst.push(r.x, r.y);
        }
      }
      [q, d1, mask, mm].forEach(function (o) { try { o.delete(); } catch (_) {} });
      orb.delete(); bf.delete(); k1.delete();
      if (src.length < 24) { setStatus('特征不足(' + (src.length / 2) + ')，请打开大地图', 'warn'); return false; }
      var sm = CV.matFromArray(src.length / 2, 1, CV.CV_32FC2, src);
      var dm = CV.matFromArray(dst.length / 2, 1, CV.CV_32FC2, dst);
      var inl = new CV.Mat();
      // 帧 -> 参照图。opencv.js 只有 estimateAffine2D，结果随后投影回相似变换。
      var M = CV.estimateAffine2D(sm, dm, inl, CV.RANSAC, 4, 2000, 0.99, 10);
      var nin = CV.countNonZero(inl);
      var sim = M.empty() ? null : matFromEstimate(M);
      [sm, dm, inl, M].forEach(function (o) { try { o.delete(); } catch (_) {} });
      if (!sim) { setStatus('变换退化', 'warn'); return false; }
      if (nin < 12) { setStatus('定位失败(内点' + nin + ')', 'warn'); return false; }
      var det = sim.a * sim.d - sim.b * sim.c;
      if (!det) { setStatus('变换退化', 'warn'); return false; }
      // 反解：参照图 -> 帧
      var i11 = sim.d / det, i12 = -sim.b / det, i21 = -sim.c / det, i22 = sim.a / det;
      var itx = -(i11 * sim.tx + i12 * sim.ty), ity = -(i21 * sim.tx + i22 * sim.ty);
      // 帧 -> 屏幕 CSS
      st.fit = {
        a: i11 * f.cssK, b: i12 * f.cssK, c: i21 * f.cssK, d: i22 * f.cssK,
        tx: itx * f.cssK + f.cssX, ty: ity * f.cssK + f.cssY
      };
      st.lastFullFit = Date.now();
      st.drift = 0;
      // 归零缩放累积器：本次已对齐真实画面，重新开始计缩放偏离
      st.zoomAccum = 1;
      // 不要在这里写 st.prevGrey！
      // fullFit 用 960 宽抓帧，而 trackStep 用 480 宽；把 960 的帧塞进
      // 跟踪基准会让 trackStep 的尺寸检查失配并**直接丢弃下一帧**，
      // 于是每次硬校正后光流都白跑一帧。缩放时校正频繁，表现为叠加层
      // 稳定滞后真实缩放一步（实测 dS 恒为 -7.4%，dx 150px）。
      // 只清跟踪点，让 trackStep 用它自己尺寸的帧重建基准。
      st.prevPts = null;
      st.tracking = true;
      setStatus('已定位 · 内点' + nin);
      draw();
      return true;
    } catch (e) {
      setStatus('定位异常: ' + (e && e.message || e), 'bad');
      return false;
    }
  }

  // 每帧：用光流估计"上一帧 -> 当前帧"的相似变换，并把它并进 st.fit。
  // 这样玩家拖动/缩放地图时叠加层立即跟着动，而不必重跑昂贵的 ORB。
  //
  // 追踪分辨率取 384（不是 480）：真机实测在咪咕串流上
  // drawImage(video→canvas) 中位 13.9ms、峰值 27ms（WebRTC 硬解是 GPU 纹理，
  // 回读到 CPU 有固定开销），而 getImageData 只要 0.4ms。取帧本身就吃掉
  // 20Hz 预算的 29%~54%，所以宁可少几个像素也要把取帧成本压下来。
  // 注意：不要用 canvas.captureStream() 自造的流去估这个成本——那种流
  // 实测只有 0.24ms/帧，比真实串流快 50 倍，会得出错误的性能结论。
  function trackStep() {
    if (!st.on || !st.fit || !st.surface || !window.cv) return;
    var CV = window.cv;
    var f = grab(st.surface, 384);
    if (f.err) { setStatus('画面不可读: ' + f.err, 'bad'); st.tracking = false; return; }
    if (!st.prevGrey || st.prevW !== f.w || st.prevH !== f.h) {
      st.prevGrey = f.grey; st.prevW = f.w; st.prevH = f.h; st.prevPts = null;
      return;
    }
    try {
      var prev = CV.matFromArray(st.prevH, st.prevW, CV.CV_8UC1, st.prevGrey);
      var cur = CV.matFromArray(f.h, f.w, CV.CV_8UC1, f.grey);
      var p0 = st.prevPts;
      if (!p0 || p0.rows < 60) {
        if (p0) { try { p0.delete(); } catch (_) {} }
        p0 = new CV.Mat();
        CV.goodFeaturesToTrack(prev, p0, 220, 0.01, 12);
      }
      if (p0.rows < 12) {
        prev.delete(); cur.delete();
        st.prevGrey = f.grey; st.prevPts = p0;
        return;
      }
      var p1 = new CV.Mat(), stt = new CV.Mat(), err = new CV.Mat();
      CV.calcOpticalFlowPyrLK(prev, cur, p0, p1, stt, err,
        new CV.Size(21, 21), 3);
      var oldPts = [], newPts = [];
      for (var i = 0; i < stt.rows; i++) {
        if (stt.data[i] !== 1) continue;
        oldPts.push(p0.data32F[i * 2], p0.data32F[i * 2 + 1]);
        newPts.push(p1.data32F[i * 2], p1.data32F[i * 2 + 1]);
      }
      var okCount = oldPts.length / 2;
      if (okCount >= 12) {
        var om = CV.matFromArray(okCount, 1, CV.CV_32FC2, oldPts);
        var nm = CV.matFromArray(okCount, 1, CV.CV_32FC2, newPts);
        var inl = new CV.Mat();
        // M: 上一帧 -> 当前帧（帧坐标系）。同样投影回相似变换，避免累积剪切。
        var M = CV.estimateAffine2D(om, nm, inl, CV.RANSAC, 3, 2000, 0.99, 10);
        var sim = M.empty() ? null : matFromEstimate(M);
        if (sim) {
          var det = sim.a * sim.d - sim.b * sim.c;
          if (det) {
            // 推导（坐标系务必按这里走，这一处曾经错过两次）：
            //   F 维护 world -> screen。
            //   帧坐标 P_f 与屏幕坐标 P_s：P_s = P_f * k + off。
            //   光流 M: P_f(prev) -> P_f(cur)，是同一世界点在相邻两帧的位置。
            //   世界点没动，所以"world -> 当前屏幕"= S ∘ "world -> 上一屏幕"，
            //   其中 S 就是 M 提升到屏幕尺度的版本（**不取逆**：M 已经是
            //   prev->cur 的正向映射，正是我们要追加的增量）。
            //   S = K ∘ M ∘ K⁻¹，K 为纯缩放 k + 平移 off，于是相似变换
            //   M=(L,t) 提升为 S=(L, k·t + (I-L)·off)。
            var L11 = sim.a, L12 = sim.b, L21 = sim.c, L22 = sim.d;
            var k = f.cssK, ox = f.cssX, oy = f.cssY;
            var stx = k * sim.tx + (ox - (L11 * ox + L12 * oy));
            var sty = k * sim.ty + (oy - (L21 * ox + L22 * oy));
            // F_new = S ∘ F_old
            var F = st.fit;
            st.fit = {
              a: L11 * F.a + L12 * F.c,
              b: L11 * F.b + L12 * F.d,
              c: L21 * F.a + L22 * F.c,
              d: L21 * F.b + L22 * F.d,
              tx: L11 * F.tx + L12 * F.ty + stx,
              ty: L21 * F.tx + L22 * F.ty + sty
            };
            st.drift++;
            // 累计本帧的缩放增量（见下方漂移判定的说明）
            st.zoomAccum = (st.zoomAccum || 1) *
                (Math.sqrt(Math.abs(L11 * L22 - L12 * L21)) || 1);
          }
        }
        [om, nm, inl, M].forEach(function (o) { try { o.delete(); } catch (_) {} });
      }
      // 用跟踪成功的点作为下一帧基准
      if (st.prevPts) { try { st.prevPts.delete(); } catch (_) {} }
      st.prevPts = (okCount >= 60) ? CV.matFromArray(okCount, 1, CV.CV_32FC2, newPts) : null;
      if (p0 !== st.prevPts) { try { p0.delete(); } catch (_) {} }
      [prev, cur, p1, stt, err].forEach(function (o) { try { o.delete(); } catch (_) {} });
      st.prevGrey = f.grey; st.prevW = f.w; st.prevH = f.h;
      st.frames++;
      // 光流是增量累积，必然漂移；缩放时尤其严重，因为尺度估计会**系统性低估**
      // （实测：连续 6 次 1.08 倍放大后叠加层比真实小 7.4%，误差 150px）。
      //
      // 这里曾经踩过一个陷阱：用"光流估计出的 scale 与上次校正的 scale 之差"
      // 当漂移指标。那是用坏了的尺子量自己 —— 光流没跟上时它自报的 scale
      // 变化也小，差值始终不超阈值，校正永远不触发。
      //
      // 正确做法：累乘**本帧光流自身报告的缩放增量**（在上面累积到
      // st.zoomAccum）。只要画面在缩放，累计偏离 1 超过阈值就重跑 ORB，
      // 不管我们的 fit 自己以为漂了多少。
      var zoomed = Math.abs((st.zoomAccum || 1) - 1) > 0.04;  // 累计缩放超 4%
      if (st.drift > 40 || zoomed ||
          Date.now() - st.lastFullFit > 4000) {
        fullFit(false);
      } else {
        setStatus('跟随中 · 帧' + st.frames + ' · 点' + okCount);
      }
    } catch (e) {
      setStatus('跟踪异常: ' + (e && e.message || e), 'warn');
    }
  }

  // ---- 绘制 --------------------------------------------------------------
  function draw() {
    if (!st.on || !st.fit || !st.cats) return;
    var el = st.surface || findSurface();
    if (!el) return;
    var r = el.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var cw = Math.round(r.width), ch = Math.round(r.height);
    if (layer.width !== cw * dpr || layer.height !== ch * dpr) {
      layer.width = cw * dpr; layer.height = ch * dpr;
    }
    layer.style.left = r.left + 'px'; layer.style.top = r.top + 'px';
    layer.style.width = cw + 'px'; layer.style.height = ch + 'px';
    var g = layer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);

    var F = st.fit, scale = Math.pow(2, Z);
    // 图标半径跟随地图缩放，保证"比例大小正确"：地图放大时点变大、缩小时变小。
    // mag 是 world->screen 的等效缩放；乘以经验系数换算成可见半径。
    // 上限压到 6px 并叠加半透明填充，否则同时开多个分类（上万点）时
    // 圆点会连成一片把地形完全糊住（实测 8 类 6409 点时非常明显）。
    var mag = Math.sqrt(Math.abs(F.a * F.d - F.b * F.c)) || 1;
    var rad = Math.max(1.6, Math.min(6, 2.6 * mag * 40));
    var shown = 0;
    g.globalAlpha = 0.82;
    for (var mt in st.cats) {
      if (!st.enabled[mt]) continue;
      var pts = st.cats[mt].p, col = colorOf(mt);
      g.fillStyle = col;
      g.strokeStyle = 'rgba(0,0,0,.55)';
      g.lineWidth = Math.max(0.6, rad * 0.26);
      for (var i = 0; i < pts.length; i++) {
        var wx = A * pts[i][0] * scale - LX0 * S;
        var wy = A * pts[i][1] * scale - LY0 * S;
        // world -> screen(相对画面左上角)
        var sx = F.a * wx + F.b * wy + F.tx - r.left;
        var sy = F.c * wx + F.d * wy + F.ty - r.top;
        if (sx < -12 || sy < -12 || sx > cw + 12 || sy > ch + 12) continue;
        g.beginPath(); g.arc(sx, sy, rad, 0, 6.2832); g.fill(); g.stroke();
        shown++;
      }
    }
    g.globalAlpha = 1;
    if (!st.tracking) setStatus(st.quality);
  }

  // 渲染循环：跟踪 + 重绘。用 rAF 保证与画面同步且不抢游戏 CPU。
  //
  // 追踪节流的取舍：间隔越大越省算力，但拖动时叠加层会滞后（实测 48ms 间隔
  // 下快速拖动有约 15px 滞后）。所以按"是否正在动"自适应：检测到明显位移就
  // 提到每帧追踪（跟手），静止时退回低频（省算力给游戏）。
  var lastTrack = 0, hotUntil = 0;
  function loop(ts) {
    if (!st.on) { st.raf = 0; return; }
    var moving = ts < hotUntil;
    var interval = moving ? 0 : 60;
    if (st.tracking && ts - lastTrack >= interval && hasFreshFrame()) {
      lastTrack = ts;
      var before = st.fit ? st.fit.tx : 0;
      trackStep();
      // 位移超过 0.5px 视为"正在动"，接下来 500ms 全速追踪
      if (st.fit && Math.abs(st.fit.tx - before) > 0.5) hotUntil = ts + 500;
    }
    draw();
    st.raf = requestAnimationFrame(loop);
  }

  // ---- 资源加载 ----------------------------------------------------------
  function loadPoints() {
    return fetch(REPO + 'data/points.json').then(function (r) {
      if (!r.ok) throw new Error('points HTTP ' + r.status);
      return r.json();
    });
  }

  function buildRef() {
    var c = document.createElement('canvas');
    c.width = REF_W; c.height = REF_H;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#1b2234'; g.fillRect(0, 0, REF_W, REF_H);
    var jobs = [];
    for (var lx = LX0; lx <= LX1; lx++)
      for (var ly = LY0; ly <= LY1; ly++) jobs.push([lx, ly]);
    var total = jobs.length, done = 0, idx = 0, active = 0;
    return new Promise(function (resolve) {
      function pump() {
        if (idx >= jobs.length && active === 0) { resolve({ canvas: c, ctx: g }); return; }
        while (active < 12 && idx < jobs.length) {
          (function (j) {
            active++;
            var lx = j[0], ly = j[1], uy = -ly - 1;   // 实测：URL y = -leafletY - 1
            var im = new Image();
            im.crossOrigin = 'anonymous';             // 否则参照图污染，无法读像素
            im.onload = function () {
              try { g.drawImage(im, (lx - LX0) * S, (ly - LY0) * S, S, S); } catch (_) {}
              active--; done++; setStatus('底图 ' + done + '/' + total); pump();
            };
            im.onerror = function () { active--; done++; pump(); };
            im.src = TILE + Z + '/tile-' + lx + '_' + uy + '.png';
          })(jobs[idx++]);
        }
      }
      pump();
    });
  }

  function ensureReady() {
    if (st.ready) { fullFit(true); return; }
    if (st.loading) return;
    st.loading = true;
    setStatus('等待识别引擎…');
    // 先等 opencv 运行时（window.cv 初始为 Promise，必须解析），
    // 再拼底图算特征 —— 顺序颠倒会拿到 cv.ORB undefined。
    ensureCv().then(function (ok) {
      if (!ok) throw new Error('opencv 运行时不可用（宿主未注入或校验失败）');
      setStatus('加载点位…');
      return loadPoints();
    }).then(function (cats) {
      st.cats = cats;
      var saved = loadEnabled();
      for (var k in cats) {
        st.enabled[k] = saved ? !!saved[k] : (k === '201' || k === '100');
      }
      renderList();
      setStatus('拼接底图…');
      return buildRef();
    }).then(function (ref) {
      var CV = window.cv;
      if (!CV || !CV.ORB) throw new Error('识别引擎未就绪');
      var d = ref.ctx.getImageData(0, 0, REF_W, REF_H);
      var n = REF_W * REF_H, grey = new Uint8Array(n);
      for (var i = 0, j = 0; i < n; i++, j += 4) {
        grey[i] = (d.data[j] * 299 + d.data[j + 1] * 587 + d.data[j + 2] * 114) / 1000;
      }
      st.refMat = CV.matFromArray(REF_H, REF_W, CV.CV_8UC1, grey);
      st.refKp = new CV.KeyPointVector();
      st.refDesc = new CV.Mat();
      var orb = new CV.ORB(12000, 1.2, 8, 31, 0, 2, CV.ORB_HARRIS_SCORE, 31, 8);
      orb.detectAndCompute(st.refMat, new CV.Mat(), st.refKp, st.refDesc);
      orb.delete();
      st.ready = true; st.loading = false;
      setStatus('就绪，正在定位…');
      fullFit(true);
    }).catch(function (e) {
      st.loading = false;
      setStatus('加载失败: ' + (e && e.message || e), 'bad');
    });
  }

  function toggle(force) {
    st.on = (typeof force === 'boolean') ? force : !st.on;
    layer.style.display = st.on ? 'block' : 'none';
    panel.style.display = st.on ? 'flex' : 'none';
    syncFab();
    if (st.on) {
      ensureReady();
      if (!st.raf) st.raf = requestAnimationFrame(loop);
    } else {
      st.tracking = false;
      if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    }
  }

  // 桌面端快捷键（F8 切换 / F9 重定位）。这是**额外**入口，不是唯一入口 ——
  // 手机上没有这两个键，触摸端靠上面那个悬浮球开关。
  window.addEventListener('keydown', function (e) {
    if (e.key === 'F8') { e.preventDefault(); toggle(); }
    else if (e.key === 'F9' && st.on) { e.preventDefault(); fullFit(true); }
  }, true);

  window.addEventListener('resize', function () { if (st.on) draw(); });

  // 测试/调试接口（靶场用它核对精度；不读任何真值）
  window.__miguMapOverlay = {
    toggle: toggle, fullFit: fullFit, trackStep: trackStep, draw: draw,
    state: st,
    fit: function () { return st.fit; },
    setCats: function (c) {
      st.cats = c;
      for (var k in c) if (!(k in st.enabled)) st.enabled[k] = true;
      renderList();
    },
    grab: function () { var el = findSurface(); return el ? grab(el, 320) : { err: 'NO_SURFACE' }; }
  };
  setStatus('按 F8 开启叠加');
})();
