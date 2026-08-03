// 原神地图叠加 — 把 wiki 全地标点位覆盖在游戏内大地图上。
// 保留 wiki 原有的「点位列表」分类选择，快捷键切换，连续跟随玩家的拖动/缩放。
// author: preauthn1
(function () {
  if (window.__miguPlugin_genshin_map_overlay) return;
  window.__miguPlugin_genshin_map_overlay = true;

  // ---- 诊断：把异常连同堆栈显示出来 ---------------------------------------
  // 手机上看不到控制台，没有堆栈只能猜，所以插件自带日志页：
  // 日志/异常/环境信息收进环形缓冲，可弹出并一键复制。
  var LOGCAP = 400;
  var logs = [];
  var lastError = null;

  function stamp() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' +
           ('0' + d.getMinutes()).slice(-2) + ':' +
           ('0' + d.getSeconds()).slice(-2) + '.' +
           ('00' + d.getMilliseconds()).slice(-3);
  }

  function log(level, msg) {
    var line = stamp() + ' [' + level + '] ' + msg;
    logs.push(line);
    if (logs.length > LOGCAP) logs.shift();
    try {
      if (level === 'ERR') console.error('[map-overlay] ' + msg);
      else console.log('[map-overlay] ' + msg);
    } catch (_) {}
    if (logPane && logPane.style.display !== 'none') renderLog();
  }

  function recordError(where, e) {
    // emscripten 的 C++ 异常在 JS 侧是**裸指针数值**（实测 7030256），
    // 既无 message 也无 stack，必须解码否则日志里只有一串数字。
    var msg;
    if (typeof e === 'number') {
      msg = 'WASM 异常 #' + e;
      try {
        var CV = CVPIN || window.cv;
        if (CV && typeof CV.getExceptionMessage === 'function') {
          var dec = CV.getExceptionMessage(e);
          if (dec) msg += ': ' + dec;
        }
      } catch (_) {}
    } else {
      msg = (e && e.message) ? e.message : String(e);
    }
    var stack = (e && e.stack) ? String(e.stack) : '(无堆栈)';
    lastError = { where: where, message: msg, stack: stack, at: stamp() };
    window.__miguMapOverlayLastError = lastError;
    log('ERR', where + ': ' + msg);
    // 堆栈单独逐行记录，复制出来才有定位价值
    stack.split('\n').slice(0, 8).forEach(function (l) {
      if (l.trim()) log('ERR', '  ' + l.trim());
    });
    return lastError;
  }

  // 未捕获异常 / Promise 拒绝也要收：WASM 陷阱常从 rAF 回调冒出来，
  // 不会经过我们自己的 try/catch。
  window.addEventListener('error', function (ev) {
    if (!ev || !ev.message) return;
    recordError('window.onerror@' + (ev.filename || '?') + ':' + (ev.lineno || 0),
                ev.error || new Error(ev.message));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    recordError('unhandledrejection', (ev && ev.reason) || new Error('unknown'));
  });

  function envInfo() {
    var CV = CVPIN || window.cv;
    var lines = [
      '=== 环境 ===',
      'UA: ' + navigator.userAgent,
      'URL: ' + location.href,
      '视口: ' + innerWidth + 'x' + innerHeight + ' dpr=' + devicePixelRatio,
      'opencv: ' + (CV ? (CV.ORB ? '已就绪' : 'cv存在但ORB缺失') : '未加载') +
        (CV && CV.getBuildInformation ? '' : ''),
      '插件状态: on=' + st.on + ' ready=' + st.ready + ' tracking=' + st.tracking,
      '参照特征: ' + (fitWorkerState === 'ready' ? '在 worker'
                    : (mainStore ? 'kp=' + mainStore.n : '-')),
      '重定位: worker=' + fitWorkerState + (fitReqMeta ? '(在途)' : '') +
        ' 连败=' + st.fitFails + ' 退避=' + st.fitBackoff + 'ms',
      '画面: ' + (st.surface
        ? (st.surface.tagName + ' ' +
           (st.surface.videoWidth || st.surface.width) + 'x' +
           (st.surface.videoHeight || st.surface.height))
        : '未找到'),
      '分类数: ' + (st.cats ? Object.keys(st.cats).length : 0) +
        ' 已选: ' + (st.enabled ? Object.values(st.enabled).filter(Boolean).length : 0),
    ];
    if (lastError) {
      lines.push('=== 最近异常 ===',
                 lastError.at + ' @' + lastError.where,
                 lastError.message, lastError.stack);
    }
    return lines.join('\n');
  }

  function fullLogText() {
    return envInfo() + '\n=== 日志(' + logs.length + ') ===\n' + logs.join('\n');
  }
  window.__miguMapOverlayLog = fullLogText;
  window.__miguMapOverlayDiag = function () {
    return lastError || { message: '（尚未捕获到异常）' };
  };

  // 日志面板（延迟创建，见 buildLogPane）
  var logPane = null, logBody = null;
  function renderLog() {
    if (logBody) logBody.textContent = fullLogText();
  }


  var PLUGIN_VER = '0.9.0';   // 与 plugin.json 同步；日志里可确认设备版本
  var REPO = 'https://raw.githubusercontent.com/preauthn1/migu-play-plugins/main/plugins/genshin-map-overlay/';

  // ---- 标定常量（实测确定，改前先读 README 的"标定"一节）------------------
  var Z = 5, S = 256, LX0 = -16, LY0 = -8, LX1 = 7, LY1 = 7;
  var A = 0.0078125;               // Leaflet CRS.Simple transformation
  // 逐瓦片拼接时的完整参照尺寸（world 坐标就定义在这个尺度上）
  var FULL_W = (LX1 - LX0 + 1) * S;
  var FULL_H = (LY1 - LY0 + 1) * S;
  // 预拼底图的下采样比例。不能直接拉 wiki 瓦片（OSS 无 CORS 头，加不加
  // crossOrigin 两条路都死）→ 底图随插件发布、哈希锁定。下采样到一半：
  // 25.2Mpx 移动端 getImageData 峰值过大；3072x2048 实测仍取满 12000 特征。
  var REF_SCALE = 0.5;
  var REF_W = FULL_W * REF_SCALE;
  var REF_H = FULL_H * REF_SCALE;

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
    surface: null, raf: 0, drift: 0,
    // 重定位调度（依据见 fullFit 前的实测注释）
    lastFitAttempt: 0,        // 最近一次尝试，无论成败——退避靠它，旧代码没有它
    fitFails: 0, fitBackoff: 0,  // 连续失败次数与当前退避间隔(ms)
    moveAccum: 0              // 上次定位成功以来的累计屏幕位移(px)
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
  // 诊断入口：手机上没有控制台，出问题时靠它把日志+堆栈复制出来。
  var btnLog = mkBtn('日志', '查看/复制诊断日志');
  btnLog.onclick = function () { showLog(); };
  head.appendChild(btnLog); head.appendChild(btnFold); head.appendChild(btnClose);

  var status = document.createElement('div');
  status.id = '__migu_ov_status';   // window.onerror 处理器靠它显示堆栈摘要
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

  // ---- 移动端入口：可拖动悬浮球 --------------------------------------------
  // 手机没有 F8；游戏画面要接收滑动/点击，不能用"长按画面"之类手势
  // 抢输入，悬浮球是唯一可靠触摸入口。
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

  // 悬浮球事件不能冒泡到游戏。必须挂**冒泡阶段**（第三参数 false）：
  // 捕获阶段会把下面的 pointerdown/up 开关逻辑一起掐死（"点了没反应"）。
  ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup',
   'click', 'touchstart', 'touchmove', 'touchend'].forEach(function (t) {
    fab.addEventListener(t, function (e) { e.stopPropagation(); }, false);
  });

  // 拖动与点击要区分开：移动超过阈值算拖动，不触发开关。长按（600ms）打开
  // 诊断日志——初始化就失败时面板不会显示，只有悬浮球这条路能看到日志。
  (function () {
    var dragging = false, moved = false, ox = 0, oy = 0, pid = null;
    var holdTimer = null, longPressed = false;
    function clearHold() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    }
    fab.addEventListener('pointerdown', function (e) {
      dragging = true; moved = false; longPressed = false; pid = e.pointerId;
      var r = fab.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      try { fab.setPointerCapture(pid); } catch (_) {}
      clearHold();
      holdTimer = setTimeout(function () {
        if (!moved) { longPressed = true; showLog(); }
      }, 600);
      e.preventDefault();
    });
    fab.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = Math.abs(e.clientX - (fab.getBoundingClientRect().left + ox));
      var dy = Math.abs(e.clientY - (fab.getBoundingClientRect().top + oy));
      if (dx > 4 || dy > 4) { moved = true; clearHold(); }
      fab.style.left = (e.clientX - ox) + 'px';
      fab.style.top = (e.clientY - oy) + 'px';
      fab.style.right = 'auto'; fab.style.bottom = 'auto';
      e.preventDefault();
    });
    fab.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      clearHold();
      try { fab.releasePointerCapture(pid); } catch (_) {}
      // 长按已经打开日志了，这一下不再当作切换
      if (!moved && !longPressed) toggle();
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
    buildLogPane();
  }
  mount();

  // ---- 日志页面 -----------------------------------------------------------
  // 手机没有控制台，诊断信息必须页面内可见可复制。复制走三条退路：
  // clipboard（需安全上下文）→ execCommand（老 WebView）→ 全选手动复制。
  function buildLogPane() {
    if (logPane) return;
    logPane = document.createElement('div');
    logPane.style.cssText =
      'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;' +
      'display:none;flex-direction:column;background:#080c12;' +
      'color:#d6e4f0;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;' +
      'pointer-events:auto';
    // 面板内的所有交互都不能漏给游戏
    ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click',
     'wheel', 'touchstart', 'touchmove', 'touchend'].forEach(function (t) {
      logPane.addEventListener(t, function (e) { e.stopPropagation(); }, false);
    });

    var bar = document.createElement('div');
    bar.style.cssText =
      'display:flex;gap:6px;align-items:center;padding:8px 10px;flex:0 0 auto;' +
      'background:rgba(20,30,44,.98);border-bottom:1px solid rgba(255,255,255,.12)';
    var title = document.createElement('div');
    title.textContent = '叠加层诊断日志';
    title.style.cssText = 'font:600 12px/1.4 system-ui,sans-serif;flex:1 1 auto';

    function paneBtn(text) {
      var b = document.createElement('button');
      b.textContent = text;
      b.style.cssText =
        'flex:0 0 auto;padding:6px 10px;border-radius:6px;cursor:pointer;' +
        'font:600 11px/1 system-ui,sans-serif;color:#eaf4ff;' +
        'background:rgba(56,120,190,.85);border:1px solid rgba(255,255,255,.18)';
      return b;
    }
    var bCopy = paneBtn('复制全部');
    var bRefresh = paneBtn('刷新');
    var bClear = paneBtn('清空');
    var bClose = paneBtn('关闭');

    logBody = document.createElement('pre');
    logBody.style.cssText =
      'margin:0;padding:10px;flex:1 1 auto;overflow:auto;white-space:pre-wrap;' +
      'word-break:break-word;-webkit-user-select:text;user-select:text';

    var hint = document.createElement('div');
    hint.style.cssText =
      'flex:0 0 auto;padding:8px 10px;font:11px/1.45 system-ui,sans-serif;' +
      'color:#8fa6bd;border-top:1px solid rgba(255,255,255,.14);' +
      // 不透明背景：提示文字曾被下层页面内容糊住看不清
      'background:#0b1017;position:relative;z-index:1';
    hint.textContent = '复制后发给开发者即可定位。若复制按钮无效，长按上方文本手动选择。';

    bCopy.onclick = function () {
      var text = fullLogText();
      var done = function (ok) {
        bCopy.textContent = ok ? '已复制' : '已全选';
        // 实测：WebView 里 Clipboard API 常因非安全上下文被拒，会走到全选
        // 退路。此时必须明确告诉用户"下一步做什么"，否则看到一片蓝底
        // 不知道已经可以长按复制了。
        hint.textContent = ok
            ? '已复制到剪贴板，直接粘贴发给开发者即可。'
            : '已为你全选文本 —— 现在长按选中区域，选「复制」即可。';
        hint.style.color = ok ? '#7fd6c0' : '#ffd479';
        setTimeout(function () { bCopy.textContent = '复制全部'; }, 2200);
      };
      // 退路 1：现代 Clipboard API（要求安全上下文，WebView 里不一定可用）
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); },
                                                 function () { legacyCopy(); });
      } else { legacyCopy(); }

      function legacyCopy() {
        // 退路 2：execCommand（老 WebView 仍支持）
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0';
          document.body.appendChild(ta);
          ta.select();
          ta.setSelectionRange(0, text.length);
          var ok = document.execCommand && document.execCommand('copy');
          document.body.removeChild(ta);
          if (ok) { done(true); return; }
        } catch (_) {}
        // 退路 3：把正文全选，用户长按即可复制
        try {
          var r = document.createRange();
          r.selectNodeContents(logBody);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        } catch (_) {}
        done(false);
      }
    };
    bRefresh.onclick = renderLog;
    bClear.onclick = function () { logs.length = 0; renderLog(); };
    bClose.onclick = function () { logPane.style.display = 'none'; };

    bar.appendChild(title);
    [bCopy, bRefresh, bClear, bClose].forEach(function (b) { bar.appendChild(b); });
    logPane.appendChild(bar);
    logPane.appendChild(logBody);
    logPane.appendChild(hint);
    document.body.appendChild(logPane);
  }

  function showLog() {
    buildLogPane();
    renderLog();
    logPane.style.display = 'flex';
  }
  window.__miguMapOverlayShowLog = showLog;

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
  // 帧新鲜度：串流画面常长时间静止，反复 drawImage 浪费 13.9ms/次。用 rVFC 的
  // presentedFrames（浏览器权威计数）判断有无新帧；不要用"方差有没有变"判断
  // ——静止时方差本来就不变，会误判成取到旧帧。
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

  // OpenCV 可能是 thenable、回调式或已就绪模块；三种都要兼容。
  var cvReady = null;         // Promise<boolean>
  var CVPIN = null;           // 第一次就绪的 cv 实例，之后一律用它
  function ensureCv() {
    if (cvReady) return cvReady;
    // 记住第一次解析出的 cv 实例：宿主双注入会建第二个 WASM 实例并替换
    // window.cv，用实例 A 的 Mat 调实例 B 的函数会在 WASM 堆上越界。
    cvReady = new Promise(function (resolve) {
      var give = function () {
        if (window.cv && window.cv.ORB && !CVPIN) CVPIN = window.cv;
        resolve(!!(CVPIN && CVPIN.ORB));
      };
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
        // 快路径也必须设 CVPIN：曾漏设导致硬要求 CVPIN 的守卫永远卡在
        // "等待识别引擎"，而底图特征其实算得好好的（真机 kp=12000）。
        if (m && m.ORB) { if (!CVPIN) CVPIN = m; res(true); return; }
        // 形态 A：Promise（实测 opencv.js 4.x 就是这种）
        if (m && typeof m.then === 'function') {
          m.then(function (mod) {
            if (mod) window.cv = mod;
            if (window.cv && window.cv.ORB && !CVPIN) CVPIN = window.cv;
            res(!!(CVPIN && CVPIN.ORB));
          }).catch(function () { res(false); });
          return;
        }
        // 形态 B：onRuntimeInitialized 回调 + 轮询兜底
        var done = false;
        try {
          m.onRuntimeInitialized = function () {
            if (!done) { done = true;
              if (window.cv && window.cv.ORB && !CVPIN) CVPIN = window.cv;
              res(!!(CVPIN && CVPIN.ORB)); }
          };
        } catch (_) {}
        var t = 0;
        var iv = setInterval(function () {
          t += 150;
          if (window.cv && window.cv.ORB) {
            if (!CVPIN) CVPIN = window.cv;
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

  // 将自由仿射投影回平移+旋转+等比缩放，避免噪声引入剪切。
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

  // 2x3 仿射的复合(A∘B)与求逆。worker 异步重定位需要：结果落地时画面可能
  // 已被光流推着走了一截，要把"发起请求之后累积的增量"补偿到新解上。
  function affMul(A, B) {
    return { a: A.a * B.a + A.b * B.c, b: A.a * B.b + A.b * B.d,
             c: A.c * B.a + A.d * B.c, d: A.c * B.b + A.d * B.d,
             tx: A.a * B.tx + A.b * B.ty + A.tx,
             ty: A.c * B.tx + A.d * B.ty + A.ty };
  }
  function affInv(A) {
    var det = A.a * A.d - A.b * A.c;
    if (!det || !isFinite(det)) return null;
    var ia = A.d / det, ib = -A.b / det, ic = -A.c / det, id = A.a / det;
    return { a: ia, b: ib, c: ic, d: id,
             tx: -(ia * A.tx + ib * A.ty), ty: -(ic * A.tx + id * A.ty) };
  }

  // ---- 定位：ORB 匹配（低频，在 worker）+ 光流跟随（快，每帧）--------------
  //
  // 两层修复（实测依据与匹配管线**正本**都在 vendor/fit_worker.js，一份实现
  // 两个上下文共用，判据不会分叉）：
  //   1) 尺度对齐：画面**缩到底图尺度**再匹配。旧代码反向放大到 960 宽，
  //      尺度差 ~9 倍 → knnMatch 8000×12000 单次 8.7~10.6s、内点率 0.39，
  //      且失败每 60ms 重试把主线程焊死（用户的"拖动卡死/FPS 归 0"）。
  //      重定位用上次 fit 的尺度当先验 + ROI 局部搜索；首次金字塔扫档。
  //   2) 执行位置：匹配跑在 worker，主线程只剩 grab ~20ms；失败指数退避
  //      1s→15s；拖动中/静止无位移不触发；worker 起不来时用同一份核心在
  //      主线程同步回退，仍受退避保护。
  var fitWorker = null, fitWorkerState = 'none';  // none|starting|ready|failed
  var mainCore = null, mainStore = null, mainCtx = null;  // 同步回退用的核心
  var fitReqSeq = 0, fitReqMeta = null;   // 在途请求：{id, t0, fitAtReq}
  var refGrey = null;      // 底图灰度常驻(6MB)：worker 中途死掉时回退建库用
  // 在途超 60s 才算 worker 卡死：跟丢时的全图金字塔慢设备实测可达 ~20s
  var FIT_TIMEOUT = 60000;

  // 资产在宿主侧以 data URL 注入 __miguPluginAssets；独立测试也可能给源码文本
  function assetText(path) {
    var A = window.__miguPluginAssets || {};
    var v = A[path];
    if (!v || typeof v !== 'string') return null;
    if (v.slice(0, 5) === 'data:') {
      var comma = v.indexOf(',');
      if (comma < 0) return null;
      try {
        return /;base64/i.test(v.slice(0, comma))
            ? atob(v.slice(comma + 1)) : decodeURIComponent(v.slice(comma + 1));
      } catch (_) { return null; }
    }
    return v;
  }
  function blobUrlOf(text) {
    return URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  }

  // 起 worker 并把底图特征库建到那边。resolve('worker'|'main')，绝不 reject——
  // 起不来就回退主线程建库（ensureReady 里处理）。
  function startFitWorker() {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (mode) { if (!settled) { settled = true; resolve(mode); } };
      var wsrc = assetText('vendor/fit_worker.js');
      var cvsrc = assetText('vendor/opencv.js');
      if (!wsrc || !cvsrc || typeof Worker === 'undefined') {
        log('WARN', '重定位 worker 资源不可用(worker脚本=' + !!wsrc +
            ' cv=' + !!cvsrc + ')，回退主线程同步重定位');
        fitWorkerState = 'failed';
        finish('main');
        return;
      }
      try {
        fitWorkerState = 'starting';
        fitWorker = new Worker(blobUrlOf(wsrc));
        fitWorker.onmessage = function (ev) {
          var m = ev.data || {};
          if (m.type === 'ready') {
            fitWorkerState = 'ready';
            log('INFO', '重定位 worker 就绪: 底图特征=' + m.kp +
                '（ORB/knnMatch 已离开主线程）');
            finish('worker');
          } else if (m.type === 'fail') {
            workerFailed('初始化失败: ' + m.message);
            finish('main');
          } else if (m.type === 'fit') {
            onWorkerFit(m);
          } else if (m.type === 'log') {
            log(m.level || 'INFO', 'worker: ' + m.msg);
          }
        };
        fitWorker.onerror = function (e) {
          workerFailed('onerror: ' + ((e && e.message) || '未知'));
          finish('main');
        };
        // 传副本：原数组留在 refGrey，worker 死后回退路径还要用
        var copy = new Uint8Array(refGrey);
        fitWorker.postMessage({ type: 'init', cvUrl: blobUrlOf(cvsrc),
          grey: copy.buffer, w: REF_W, h: REF_H }, [copy.buffer]);
        // 慢设备上 WASM 编译 + 12000 特征建库可能要几十秒，超时才放弃
        setTimeout(function () {
          if (fitWorkerState === 'starting') {
            workerFailed('初始化超时(45s)');
            finish('main');
          }
        }, 45000);
      } catch (e) {
        workerFailed('创建失败: ' + ((e && e.message) || e));
        finish('main');
      }
    });
  }

  function workerFailed(why) {
    log('WARN', '重定位 worker 不可用: ' + why + '，回退主线程同步重定位');
    fitWorkerState = 'failed';
    if (fitWorker) { try { fitWorker.terminate(); } catch (_) {} fitWorker = null; }
    fitReqMeta = null;
    // 主线程特征库不在这里补建：fullFitSync 首次被调时才建（refGrey 常驻），
    // 避免在事件回调里凭空插入一次数秒的 longtask
  }

  // worker 起不来时，把同一份匹配核心装载到页面直接调用。new Function 对
  // 声明了 wasm 权限的插件是允许的（opencv.js 胶水自身就依赖它），比在
  // main.js 里复制整条管线安全：只有一份判据。
  function ensureMainCore() {
    if (mainCore) return true;
    var wsrc = assetText('vendor/fit_worker.js');
    if (!wsrc) return false;
    try {
      (new Function(wsrc))();
      mainCore = window.__miguFitCore || null;
      mainCtx = {};
    } catch (e) { recordError('装载匹配核心', e); }
    return !!mainCore;
  }

  // 失败指数退避。旧代码跟丢时每 60ms 重试一次 10s 级的全量 ORB —— FPS 归 0
  // 的直接原因；现在最坏 15s 一次，主线程立即恢复响应。
  function noteFitFail() {
    st.fitFails++;
    st.fitBackoff = Math.min(15000, 1000 * Math.pow(2, Math.min(4, st.fitFails - 1)));
  }

  // 定位成功后的公共收尾（worker 与同步两条路径共用，判据保持一致）
  function applyFitSuccess(nin) {
    st.lastFullFit = Date.now();
    // 本次已对齐真实画面：漂移/位移/缩放累积与失败退避全部归零
    st.drift = 0; st.moveAccum = 0; st.zoomAccum = 1;
    st.fitFails = 0; st.fitBackoff = 0;
    // 不要在这里写 st.prevGrey！fullFit 的抓帧宽度随尺度先验变化、trackStep
    // 恒用 384 宽，塞进跟踪基准会让尺寸检查失配并丢弃下一帧（实测表现为
    // 叠加层稳定滞后真实缩放一步）。只清跟踪点让它自建基准。
    st.prevPts = null;
    st.tracking = true;
    setStatus('已定位 · 内点' + nin);
    draw();
  }

  // 匹配结果落地（worker 异步与主线程同步两条路共用，状态文案保持一致）。
  // 质量闸门/相似变换投影/坐标换算都在核心里做完（vendor/fit_worker.js）。
  function applyFitResult(res, meta, ms) {
    if (res.nQ != null)
      log('INFO', 'ORB[' + (res.path || '?') + ']: 帧特征=' + res.nQ +
          ' 库特征=' + res.nR + ' 匹配=' + (res.matches || 0) +
          (res.skipped ? ' 越界跳过=' + res.skipped : '') +
          ' 内点=' + (res.nin || 0) + ' 耗时=' + ms + 'ms' +
          (meta ? '(worker)' : '(同步)'));
    if (!res.ok) {
      if (res.error) { log('ERR', 'fullFit: ' + res.error); setStatus('定位异常: ' + res.error, 'bad'); }
      else if (res.why === 'nofeat') setStatus('画面无可用特征（请打开大地图）', 'warn');
      else if (res.why === 'few') setStatus('特征不足(' + (res.matches || 0) + ')，请打开大地图', 'warn');
      else if (res.why === 'lowq') {
        setStatus('定位失败(内点' + res.nin + '/' + res.matches + ' ' + res.pct + '%)', 'warn');
        log('WARN', '拒绝低质量解: 内点=' + res.nin + ' 匹配=' + res.matches +
            '（需 >=12 且内点率 >=0.28）');
      } else setStatus('变换退化', 'warn');
      noteFitFail();
      return false;
    }
    // 异步路径的结果对应**发起请求那一刻**的帧。期间玩家可能还在拖动、光流
    // 仍在更新 st.fit，把这段增量 S = F_now ∘ F_req⁻¹ 补偿上，否则点位会
    // 向后跳一步。（同步路径 meta=null，无此问题。）
    var fit = res.fit;
    if (meta && meta.fitAtReq && st.fit) {
      var inv = affInv(meta.fitAtReq);
      if (inv) fit = affMul(affMul(st.fit, inv), fit);
    }
    st.fit = fit;
    applyFitSuccess(res.nin);
    return true;
  }

  function onWorkerFit(res) {
    var meta = fitReqMeta;
    fitReqMeta = null;
    if (!meta || res.id !== meta.id) return;
    applyFitResult(res, meta, Date.now() - meta.t0);
  }

  // ---- 尺度对齐（2026-08-02 实测，probe/match_at_ref_scale.py）------------
  // 游戏画的是底图局部的**放大**（1366 宽屏幕只对应底图 ~379px），匹配前要把
  // 画面缩回底图尺度。st.fit 的 mag = 屏幕 CSS px / 底图 px，所以目标抓帧宽
  // = CSS 宽 / mag；轻微过采样 ×1.1 内点率最高（420 宽 0.78 vs 380 宽 0.62）。
  // 上限 640 而不是 960：帧比底图**粗**是安全方向（底图特征建了 8 层金字塔，
  // 实测帧 0.4~0.8× 底图尺度内点率仍 0.8+），帧比底图细才致命；
  // 压上限省掉低倍缩放时的大半检测像素。
  // 无先验（首次定位）或连败 3 次（先验尺度已不可信）返回 0，走金字塔。
  function fitTargetW(el) {
    var F = st.fit;
    if (!F || st.fitFails >= 3) return 0;
    var mag = Math.sqrt(Math.abs(F.a * F.d - F.b * F.c));
    if (!isFinite(mag) || mag < 0.05) return 0;
    var r = el.getBoundingClientRect();
    return Math.max(220, Math.min(640, Math.round(1.1 * r.width / mag)));
  }

  // ROI 先验：屏幕中心反投影到底图 + 搜索半径 = 视野在底图上的宽度（框=2 倍
  // 视野宽；框更大则截断后留在视野内的特征变少，实测内点 35 vs 30）。
  // 不按帧宽算：帧被 640 上限压过时会盖不住视野。
  function priorOf(f) {
    var F = st.fit, inv = F && affInv(F);
    if (!inv) return null;
    var mag = Math.sqrt(Math.abs(F.a * F.d - F.b * F.c)) || 1;
    var sx = f.cssX + f.w * f.cssK / 2, sy = f.cssY + f.h * f.cssK / 2;
    return { cx: inv.a * sx + inv.b * sy + inv.tx,
             cy: inv.c * sx + inv.d * sy + inv.ty,
             pad: Math.min(1200, Math.max(320,
                  Math.round(f.w * f.cssK / mag))) };
  }

  // 统一入口：worker 可用走异步（主线程只付 grab ~20ms），否则同步回退。
  // 手动"重定位"/F9 也走这里；fitBackoff 只约束 trackStep 的自动触发。
  function fullFit(userAsked) {
    var el = findSurface();
    if (!el) { log('ERR', 'findSurface: 未找到 video/canvas'); setStatus('未找到游戏画面', 'bad'); return false; }
    st.surface = el;
    hookFrameCounter(el);   // 首次定位时挂上帧计数，供跟踪循环跳过静止帧
    st.lastFitAttempt = Date.now();   // 成败都记，退避与去重都靠它
    if (fitWorkerState === 'ready') return fitViaWorker(el);
    var ok = fullFitSync(el);
    if (!ok) noteFitFail();
    return ok;
  }

  function fitViaWorker(el) {
    if (fitReqMeta) {
      // 已有在途请求就不重复排队；超时视为 worker 卡死，降级下次走同步
      if (Date.now() - fitReqMeta.t0 > FIT_TIMEOUT) {
        workerFailed('fit 超过 ' + FIT_TIMEOUT + 'ms 未返回');
        noteFitFail();
      }
      return true;
    }
    var tw = fitTargetW(el);
    var f = grab(el, tw || 960);
    if (f.err) { log('ERR', 'grab 失败: ' + f.err); setStatus('画面不可读: ' + f.err, 'bad'); noteFitFail(); return false; }
    fitReqMeta = {
      id: ++fitReqSeq, t0: Date.now(),
      fitAtReq: st.fit ? { a: st.fit.a, b: st.fit.b, c: st.fit.c, d: st.fit.d,
                           tx: st.fit.tx, ty: st.fit.ty } : null
    };
    // grab 每次都建新 ImageData，buffer 可安全转移（零拷贝）；
    // 画面几何(k/ox/oy)随请求带过去，worker 直接算出 world->屏幕 的 fit
    var msg = { type: 'fit', id: fitReqMeta.id,
      grey: f.grey.buffer, w: f.w, h: f.h,
      k: f.cssK, ox: f.cssX, oy: f.cssY, mode: tw ? 'prior' : 'pyr' };
    if (tw) {
      var pr = priorOf(f);
      if (pr) { msg.cx = pr.cx; msg.cy = pr.cy; msg.pad = pr.pad; }
      else msg.mode = 'pyr';
    }
    fitWorker.postMessage(msg, [f.grey.buffer]);
    if (!st.fit) setStatus('定位中…', 'warn');
    return true;
  }

  // 同步路径（worker 不可用时的回退）：装载同一份核心直接调用。
  // 特征库懒建：第一次走到这里才建（一次数秒的 longtask，只有回退模式才付）。
  function fullFitSync(el) {
    // 守卫必须与调用点用同一个表达式取 CV：曾因守卫查 CVPIN、调用用
    // `CVPIN || window.cv` 的不一致，真机永远卡在"等待识别引擎"。
    var CVCHK = CVPIN || window.cv;
    if (!CVCHK || !CVCHK.ORB || !ensureMainCore()) {
      setStatus('等待识别引擎', 'warn');
      log('WARN', '等待识别引擎: cv=' + (!!CVCHK) +
          ' ORB=' + !!(CVCHK && CVCHK.ORB) + ' core=' + !!mainCore);
      return false;
    }
    if (!CVPIN) CVPIN = CVCHK;
    try {
      if (!mainStore) {
        if (!refGrey) { setStatus('底图灰度不在内存', 'bad'); return false; }
        var tb = Date.now();
        mainStore = mainCore.buildRef(CVPIN, refGrey, REF_W, REF_H);
        log('INFO', '主线程特征库: kp=' + mainStore.n +
            ' 耗时=' + (Date.now() - tb) + 'ms（仅回退模式）');
      }
      var tw = fitTargetW(el);
      var f = grab(el, tw || 960);
      if (f.err) { log('ERR', 'grab 失败: ' + f.err); setStatus('画面不可读: ' + f.err, 'bad'); return false; }
      var m = { grey: f.grey, w: f.w, h: f.h,
                k: f.cssK, ox: f.cssX, oy: f.cssY, mode: tw ? 'prior' : 'pyr' };
      if (tw) {
        var pr = priorOf(f);
        if (pr) { m.cx = pr.cx; m.cy = pr.cy; m.pad = pr.pad; }
        else m.mode = 'pyr';
      }
      var t0 = Date.now();
      var res = mainCore.runFit(CVPIN, mainStore, mainCtx, m) ||
                { ok: false, why: 'nofeat' };
      // 同步路径 fit 立即生效，无在途增量需要补偿（meta=null）
      return applyFitResult(res, null, Date.now() - t0);
    } catch (e) {
      // 记录堆栈：手机上看不到控制台，没有堆栈就只能靠猜
      var d1 = recordError('fullFit(ORB匹配)', e);
      setStatus('定位异常: ' + d1.message, 'bad');
      return false;
    }
  }

  // 每帧：用光流估计"上一帧 -> 当前帧"的相似变换并并进 st.fit——拖动/缩放时
  // 叠加层立即跟着动，不必重跑昂贵的 ORB。追踪分辨率取 384：真机串流上
  // drawImage(video→canvas) 中位 13.9ms（GPU 纹理回读固定开销），取帧已吃掉
  // 20Hz 预算的 29%~54%；canvas 自造流快 50 倍，别用它估这个成本。
  function trackStep() {
    if (!st.on || !st.fit || !st.surface || !CVPIN) return;
    var CV = CVPIN;
    // 旋转时站点可能替换 video/canvas；旧引用会变成 detached/0x0。旧版永久
    // 缓存它并报 NO_SIZE。失效时丢掉光流状态，下一拍重新发现真实 surface。
    if (!st.surface.isConnected) {
      st.surface = null; st.fit = null; st.prevGrey = st.prevPts = null;
      setTimeout(function () { fullFit(false); }, 0); return;
    }
    var f = grab(st.surface, 384);
    if (f.err) {
      setStatus('画面不可读: ' + f.err, 'bad'); st.tracking = false;
      if (f.err === 'NO_SIZE') {
        st.surface = null; st.fit = null; st.prevGrey = st.prevPts = null;
        setTimeout(function () { fullFit(false); }, 0);
      }
      return;
    }
    if (!st.prevGrey || st.prevW !== f.w || st.prevH !== f.h) {
      st.prevGrey = f.grey; st.prevW = f.w; st.prevH = f.h; st.prevPts = null;
      return;
    }
    // 画面没变就别跑光流（LK+RANSAC 一轮实测中位 29.8ms）：抽样 1/251 像素
    // 算平均绝对差（<0.1ms），低于阈值视为静止帧直接返回。防"极慢拖动"
    // 永远低于阈值跟不上：最多 500ms 强制跑一轮。
    var nowMs = Date.now();
    if (nowMs - (st.lastFlowAt || 0) < 500) {
      var dsum = 0, cnt = 0;
      for (var si = 0; si < f.grey.length; si += 251) {
        dsum += Math.abs(f.grey[si] - st.prevGrey[si]); cnt++;
      }
      if (dsum / cnt < 0.6) return;
    }
    st.lastFlowAt = nowMs;
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
      // 同样要查界：calcOpticalFlowPyrLK 因输入退化返回尺寸不符时，
      // data32F[i*2+1] 会越界读（WASM 堆上表现为脏数据或陷阱）。
      var n0 = p0.data32F ? p0.data32F.length : 0;
      var n1 = p1.data32F ? p1.data32F.length : 0;
      var lim = Math.min(stt.rows, Math.floor(n0 / 2), Math.floor(n1 / 2));
      for (var i = 0; i < lim; i++) {
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
            // 累计屏幕位移：周期性重定位只在"上次定位后真的动过"时才有意义
            st.moveAccum += Math.abs(stx) + Math.abs(sty);
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
      // 光流增量累积必然漂移，缩放时尺度还会系统性低估（实测连续 6 次 1.08
      // 倍放大后小 7.4%、偏 150px）。漂移指标必须用**本帧光流自报的缩放增量
      // 累乘**（st.zoomAccum）——曾用"fit 的 scale 与上次校正之差"，光流没
      // 跟上时它自报变化也小，等于用坏尺子量自己，校正永远不触发。
      var now = Date.now();
      var zoomed = Math.abs((st.zoomAccum || 1) - 1) > 0.04;  // 累计缩放超 4%
      // 上次定位以来真的动过（位移 >2px 或有缩放）才值得重定位；
      // 旧代码"放着不动"时每 4s 白跑一次全量 ORB。
      var movedEnough = st.moveAccum > 2 || zoomed;
      var needFit = movedEnough &&
          (st.drift > 40 || zoomed || now - st.lastFullFit > 4000);
      // 再过两道闸：1) 正在拖动（hotUntil 未过期）不跑，等手势停下补上；
      // 2) 失败退避 fitBackoff，跟丢时不再每 60ms 重试。
      //    （worker 在途请求由 fitViaWorker 内部去重。）
      var didFit = false;
      if (needFit && performance.now() >= hotUntil &&
          now - st.lastFitAttempt >= st.fitBackoff) {
        fullFit(false);
        didFit = true;
      }
      if (!didFit) setStatus('跟随中 · 帧' + st.frames + ' · 点' + okCount);
    } catch (e) {
      var d2 = recordError('trackStep(光流)', e);
      setStatus('跟踪异常: ' + d2.message, 'warn');
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
    // 图标半径跟随地图缩放。上限压到 6px 并叠加半透明，
    // 否则多分类上万点连成一片糊住地形（实测 8 类 6409 点时非常明显）。
    var mag = Math.sqrt(Math.abs(F.a * F.d - F.b * F.c)) || 1;
    var rad = Math.max(1.6, Math.min(6, 2.6 * mag * 40));

    // ---- 密度聚合 ------------------------------------------------------
    // 单分类就有 2660 点（普通宝箱），缩小时糊成彩色噪点（用户原话"一大堆
    // 彩色点无法有效分辨"）。屏幕切网格，同格同类合并成带数字的簇；网格边长
    // max(18, rad*4)——点越小聚合越狠；簇内 >1 才聚合，单点照常画不影响定位。
    var CELL = Math.max(18, rad * 4);
    // 放得足够大时不再聚合，直接看真实点。判据必须用 rad 本身（rad 6px 封顶，
    // 取 5.4≈接近上限即已放大）：曾写成 `CELL > rad*3.2`，而 CELL=max(18,rad*4)
    // 恒大于 rad*3.2，条件永真、聚合永远关不掉。
    var clustering = rad < 5.4;

    var shown = 0;
    g.globalAlpha = 0.82;
    for (var mt in st.cats) {
      if (!st.enabled[mt]) continue;
      var pts = st.cats[mt].p, col = colorOf(mt);
      g.fillStyle = col;
      g.strokeStyle = 'rgba(0,0,0,.55)';
      g.lineWidth = Math.max(0.6, rad * 0.26);
      // 批量成一条路径再 fill/stroke：逐点 4 次 canvas 调用实测 7118 点
      // 每帧中位 9.2ms、把 rAF 拖到 4.4fps；同色共路径后降到 2 次调用。
      var cells = clustering ? {} : null;
      g.beginPath();
      var batched = 0;
      for (var i = 0; i < pts.length; i++) {
        // world 坐标定义在**完整**参照尺度上，底图下采样后必须同乘 REF_SCALE，
        // 否则每个点都会偏出一倍。
        var wx = (A * pts[i][0] * scale - LX0 * S) * REF_SCALE;
        var wy = (A * pts[i][1] * scale - LY0 * S) * REF_SCALE;
        // world -> screen(相对画面左上角)
        var sx = F.a * wx + F.b * wy + F.tx - r.left;
        var sy = F.c * wx + F.d * wy + F.ty - r.top;
        if (sx < -12 || sy < -12 || sx > cw + 12 || sy > ch + 12) continue;
        shown++;
        if (cells) {
          // 只累加，最后统一画。键用整数格坐标。
          var k = ((sx / CELL) | 0) + ',' + ((sy / CELL) | 0);
          var c = cells[k];
          if (c) { c.n++; c.x += sx; c.y += sy; }
          else { cells[k] = { n: 1, x: sx, y: sy }; }
          continue;
        }
        g.moveTo(sx + rad, sy);          // moveTo 断开子路径，避免连线
        g.arc(sx, sy, rad, 0, 6.2832);
        batched++;
      }
      if (cells) {
        // 先把所有单点圆批量画掉（同色一条路径，保持原有的性能特性）
        var multi = [];
        for (var k2 in cells) {
          var c2 = cells[k2];
          if (c2.n === 1) {
            g.moveTo(c2.x + rad, c2.y);
            g.arc(c2.x, c2.y, rad, 0, 6.2832);
            batched++;
          } else {
            multi.push(c2);
          }
        }
        if (batched) { g.fill(); g.stroke(); }
        // 再画簇：半径随点数缓增（sqrt），避免密集区一个巨圆盖住半张图
        if (multi.length) {
          g.beginPath();
          for (var j = 0; j < multi.length; j++) {
            var m = multi[j];
            var cx = m.x / m.n, cy = m.y / m.n;
            var cr = Math.min(rad + 5, rad * (1 + 0.42 * Math.sqrt(m.n)));
            g.moveTo(cx + cr, cy);
            g.arc(cx, cy, cr, 0, 6.2832);
          }
          g.fill(); g.stroke();
          // 数字标签：只在簇够大时画，否则文字比圆还大
          g.save();
          g.globalAlpha = 1;
          g.fillStyle = '#fff';
          g.strokeStyle = 'rgba(0,0,0,.85)';
          g.lineWidth = 2.5;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.font = 'bold 10px system-ui,-apple-system,sans-serif';
          for (var j2 = 0; j2 < multi.length; j2++) {
            var m2 = multi[j2];
            var cr2 = Math.min(rad + 5, rad * (1 + 0.42 * Math.sqrt(m2.n)));
            if (cr2 < 7) continue;
            var tx = m2.x / m2.n, ty = m2.y / m2.n;
            var label = m2.n > 99 ? '99+' : String(m2.n);
            g.strokeText(label, tx, ty);
            g.fillText(label, tx, ty);
          }
          g.restore();
        }
      } else if (batched) { g.fill(); g.stroke(); }
    }
    st.shown = shown;
    g.globalAlpha = 1;
    if (!st.tracking) setStatus(st.quality);
  }

  // 渲染循环：跟踪 + 重绘，rAF 驱动。追踪节流按"是否正在动"自适应：明显位移
  // 提到每帧（48ms 间隔实测快速拖动滞后 ~15px），静止退回低频。
  var lastTrack = 0, hotUntil = 0;
  // 上次绘制的变换+开关签名：静止时逐帧画面相同，重绘纯浪费
  // （实测 7118 点中位 9.2ms/帧，把 rAF 拖到 4.4fps）。
  var lastSig = '';
  function drawSig() {
    var f = st.fit;
    if (!f) return '';
    // 变换 + 开启的分类 + 画布尺寸，任一变化才需要重画。
    var on = '';
    for (var k in st.enabled) if (st.enabled[k]) on += k + ',';
    return f.a.toFixed(3) + ',' + f.b.toFixed(3) + ',' + f.c.toFixed(3) + ',' +
           f.d.toFixed(3) + ',' + f.tx.toFixed(1) + ',' + f.ty.toFixed(1) +
           '|' + on + '|' + layer.width + 'x' + layer.height;
  }

  function loop(ts) {
    if (!st.on) { st.raf = 0; return; }
    // 未定位/页面不可见时不能每帧忙转（真机空转曾拖卡设置页），休眠等待；
    // timeout id 单独存：与 st.raf 混用会让 rAF 取消不掉、循环变僵尸。
    if (document.hidden || !st.fit) {
      st.raf = 0;
      st.idleTimer = setTimeout(function () {
        st.idleTimer = 0;
        if (st.on) st.raf = requestAnimationFrame(loop);
      }, document.hidden ? 600 : 250);
      return;
    }
    var moving = ts < hotUntil;
    var interval = moving ? 0 : 60;
    if (st.tracking && ts - lastTrack >= interval && hasFreshFrame()) {
      lastTrack = ts;
      var before = st.fit ? st.fit.tx : 0;
      trackStep();
      // 位移超过 0.5px 视为"正在动"，接下来 500ms 全速追踪
      if (st.fit && Math.abs(st.fit.tx - before) > 0.5) hotUntil = ts + 500;
    }
    // 只在真正变了的时候重绘。
    var sig = drawSig();
    if (sig !== lastSig) { lastSig = sig; draw(); }
    st.raf = requestAnimationFrame(loop);
  }

  // ---- 资源加载 ----------------------------------------------------------
  function loadPoints() {
    var A = window.__miguPluginAssets || {};
    if (A['data/points.json']) {
      try { return Promise.resolve(JSON.parse(A['data/points.json'])); }
      catch (e) { return Promise.reject(new Error('点位数据解析失败: ' + e.message)); }
    }
    return fetch(REPO + 'data/points.json').then(function (r) {
      if (!r.ok) throw new Error('points HTTP ' + r.status);
      return r.json();
    });
  }

  function buildRef() {
    // 单张预拼底图，随插件发布并经 sha256 校验。
    // 不再逐块拉 wiki OSS —— 那些请求在真机上被 CORS 全数拒绝。
    return new Promise(function (resolve, reject) {
      var c = document.createElement('canvas');
      c.width = REF_W; c.height = REF_H;
      var g = c.getContext('2d', { willReadFrequently: true });
      g.fillStyle = '#1b2234'; g.fillRect(0, 0, REF_W, REF_H);
      var im = new Image();
      // 宿主域(raw.githubusercontent)实测返回 access-control-allow-origin: *，
      // 所以 anonymous 能拿到可读像素；缺了它画布会被污染。
      im.crossOrigin = 'anonymous';
      im.onload = function () {
        try {
          g.drawImage(im, 0, 0, REF_W, REF_H);
          log('INFO', '底图载入 ' + im.naturalWidth + 'x' + im.naturalHeight +
              ' → ' + REF_W + 'x' + REF_H);
          resolve({ canvas: c, ctx: g });
        } catch (e) { reject(new Error('底图绘制失败: ' + (e && e.message || e))); }
      };
      im.onerror = function () {
        reject(new Error('底图加载失败（' + REPO + 'data/ref_map.jpg）'));
      };
      setStatus('载入底图…');
      // 优先用宿主注入的已校验资源（data: URL，同源不会污染画布，
      // 也不依赖任何第三方主机的 CORS 头）；独立测试时回退到 REPO。
      var A = window.__miguPluginAssets || {};
      im.src = A['data/ref_map.jpg'] || (REPO + 'data/ref_map.jpg');
    });
  }

  function ensureReady() {
    if (st.ready) { fullFit(true); return; }
    if (st.loading) return;
    st.loading = true;
    log('INFO', 'ensureReady v' + PLUGIN_VER + ': 开始加载（等 opencv → 点位 → 底图特征）');
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
      var CV = CVPIN || window.cv;
      if (!CV || !CV.ORB) throw new Error('识别引擎未就绪');
      // 内存高峰：一次 getImageData 要 100MB RGBA。手机 WebView 堆远小于
      // 桌面（真机在这里拿到过 WASM 陷阱）——分块读取，每步记日志。
      setStatus('提取特征…');
      log('INFO', 'ref 尺寸 ' + REF_W + 'x' + REF_H +
          '（' + (REF_W * REF_H / 1e6).toFixed(1) + 'M px，RGBA 约 ' +
          (REF_W * REF_H * 4 / 1048576).toFixed(0) + 'MB）');
      var n = REF_W * REF_H, grey;
      try {
        grey = new Uint8Array(n);
      } catch (e) {
        throw new Error('内存不足：无法分配 ' + (n / 1048576).toFixed(0) +
                        'MB 灰度缓冲（' + (e && e.message || e) + '）');
      }
      // 按行带分块 getImageData：一次性取 100MB 在移动端极易失败，
      // 分块后峰值只有 REF_W * band * 4。
      var band = 256, done = 0;
      for (var y0 = 0; y0 < REF_H; y0 += band) {
        var hh = Math.min(band, REF_H - y0);
        var d;
        try {
          d = ref.ctx.getImageData(0, y0, REF_W, hh);
        } catch (e) {
          throw new Error('读取底图失败（y=' + y0 + '）: ' + (e && e.message || e));
        }
        var px = d.data, base = y0 * REF_W, m = hh * REF_W;
        for (var i = 0, j = 0; i < m; i++, j += 4) {
          grey[base + i] =
              (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
        }
        done += m;
      }
      log('INFO', '灰度提取完成 ' + (done / 1e6).toFixed(1) + 'M px');
      refGrey = grey;
      // 特征库建到 worker 里（主线程建库+首次匹配曾是一次 17s longtask）；
      // worker 起不来（无资产/CSP/超时）才回退主线程。
      return startFitWorker();
    }).then(function (mode) {
      // 回退模式（mode='main'）不在这里建特征库：fullFitSync 首次调用时懒建
      st.ready = true; st.loading = false;
      setStatus('就绪，正在定位…' + (mode === 'worker' ? '' : '（同步回退）'));
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
      if (!st.raf && !st.idleTimer) st.raf = requestAnimationFrame(loop);
    } else {
      st.tracking = false;
      if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
      if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = 0; }
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
