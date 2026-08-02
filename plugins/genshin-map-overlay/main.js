// 原神地图叠加 — 把 wiki 全地标点位覆盖在游戏内大地图上。
// 保留 wiki 原有的「点位列表」分类选择，快捷键切换，连续跟随玩家的拖动/缩放。
// author: preauthn1
(function () {
  if (window.__miguPlugin_genshin_map_overlay) return;
  window.__miguPlugin_genshin_map_overlay = true;

  // ---- 诊断：把异常连同堆栈显示出来 ---------------------------------------
  // 用户在移动端遇到过 "table index is out of bounds"（WASM 运行时陷阱，
  // 该文本不在任何 JS 源码里，也不在引擎二进制里，所以无法靠搜索定位）。
  // 手机上看不到控制台，没有堆栈就只能猜——已经因此否证了四个假设。
  //
  // 所以插件自带一个日志页：所有日志/异常/环境信息都收进环形缓冲，
  // 点「日志」按钮弹出、可一键复制。用户把复制内容发来即可定位。
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
    // emscripten 抛出的 C++ 异常在 JS 侧是一个**裸指针数值**（实测 7030256，
    // 真机见过 7084592），既无 message 也无 stack。必须解码，否则日志里只有
    // 一串数字，无从下手 —— 这正是之前几轮定位失败的原因。
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
      '参照特征: kp=' + (st.refKp ? st.refKp.size() : '-') +
        ' desc=' + (st.refDesc ? st.refDesc.rows : '-'),
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


  var PLUGIN_VER = '0.7.0';   // 与 plugin.json 同步；日志里可确认设备版本
  var REPO = 'https://raw.githubusercontent.com/preauthn1/migu-play-plugins/main/plugins/genshin-map-overlay/';

  // ---- 标定常量（实测确定，改前先读 README 的"标定"一节）------------------
  var Z = 5, S = 256, LX0 = -16, LY0 = -8, LX1 = 7, LY1 = 7;
  var A = 0.0078125;               // Leaflet CRS.Simple transformation
  // 逐瓦片拼接时的完整参照尺寸（world 坐标就定义在这个尺度上）
  var FULL_W = (LX1 - LX0 + 1) * S;
  var FULL_H = (LY1 - LY0 + 1) * S;
  // 预拼底图的下采样比例。真机日志证明必须放弃直接拉 wiki 瓦片：
  //   Access to image at '<wiki OSS>/tiles-G/5/tile--16_5.png' from
  //   origin '<the cloud-game page>' has been blocked by CORS policy
  // 该 OSS 不返回 access-control-allow-origin，用 crossOrigin='anonymous'
  // 会 384 块全灭（底图变纯色，ORB 无特征）；去掉 crossOrigin 则画布被污染，
  // getImageData 抛 SecurityError。两条路都不通。
  // 所以底图改为随插件发布的**哈希锁定资源**（raw.githubusercontent 返回
  // access-control-allow-origin: *，实测可跨域读像素）。
  // 同时下采样到一半：6144x4096=25.2Mpx 在移动端 getImageData 峰值过大。
  // 实测 3072x2048 仍能取满 12000 特征，比例误差 0.1%、原点误差 0.1px。
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
  // 另外支持长按（600ms）打开诊断日志 —— 这条路很重要：如果初始化就失败，
  // 面板根本不会显示，那时「日志」按钮也点不到，只有悬浮球还在。
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
  // 手机上没有开发者控制台，所以诊断信息必须在页面内可见且可复制。
  // 复制走三条退路：navigator.clipboard（需要安全上下文）→
  // document.execCommand('copy')（老 WebView）→ 全选文本让用户手动复制。
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
      // 不透明背景：日志页是半透明的，提示文字曾被下层页面内容糊住看不清
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
  var CVPIN = null;           // 第一次就绪的 cv 实例，之后一律用它
  function ensureCv() {
    if (cvReady) return cvReady;
    // 记住第一次解析出的 cv 实例。宿主若把 opencv.js 注入两次，emscripten
    // 会建第二个 WASM 实例并替换 window.cv —— 用实例 A 造的 Mat 去调实例 B
    // 的函数，函数表索引就是无意义的，运行时抛
    // "table index is out of bounds"。用户真机日志里出现过两条相隔 3 秒的
    // `inject 4 script(s)`，正是这种情况（宿主侧已修，这里再兜一层）。
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
        // 这条"已经就绪"的快路径以前直接 res(true) 就返回，**忘了设 CVPIN**。
        // 后果很隐蔽：ensureReady 里取 CV 用的是 `CVPIN || window.cv`，所以底图
        // 特征照样算得出来（真机日志 kp=12000 desc=12000 一切正常），可
        // fullFit 的守卫是 `if (!CVPIN || ...)` —— 硬要求 CVPIN —— 于是永远
        // 卡在"等待识别引擎"，看起来像 opencv 没加载，其实它好得很。
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
    if (!el) { log('ERR', 'findSurface: 未找到 video/canvas'); setStatus('未找到游戏画面', 'bad'); return false; }
    st.surface = el;
    hookFrameCounter(el);   // 首次定位时挂上帧计数，供跟踪循环跳过静止帧
    var f = grab(el, 960);
    if (f.err) { log('ERR', 'grab 失败: ' + f.err); setStatus('画面不可读: ' + f.err, 'bad'); return false; }
    // 守卫用与调用点**同一个**表达式取 CV。以前守卫查 CVPIN、下面却用
    // `CVPIN || window.cv`，两者不一致时会永远卡在"等待识别引擎"——真机上
    // 就是这么卡住的（底图特征明明已经算完 kp=12000）。
    var CVCHK = CVPIN || window.cv;
    if (!CVCHK || !CVCHK.ORB || !st.refDesc) {
      setStatus('等待识别引擎', 'warn');
      log('WARN', '等待识别引擎: cv=' + (!!CVCHK) +
          ' ORB=' + !!(CVCHK && CVCHK.ORB) + ' refDesc=' + !!st.refDesc);
      return false;
    }
    if (!CVPIN) CVPIN = CVCHK;
    try {
      var CV = CVPIN || window.cv;
      var q = CV.matFromArray(f.h, f.w, CV.CV_8UC1, f.grey);
      var orb = new CV.ORB(8000, 1.2, 8, 31, 0, 2, CV.ORB_HARRIS_SCORE, 31, 8);
      var k1 = new CV.KeyPointVector(), d1 = new CV.Mat(), mask = new CV.Mat();
      orb.detectAndCompute(q, mask, k1, d1);
      var bf = new CV.BFMatcher(CV.NORM_HAMMING, false);
      var mm = new CV.DMatchVectorVector();
      // 两侧描述子都必须非空。空描述子进 knnMatch 会抛裸指针数值，
      // 表现为无堆栈的神秘错误（实测复现：7030256）。
      if (!d1 || d1.rows === 0 || d1.empty() ||
          !st.refDesc || st.refDesc.rows === 0 || st.refDesc.empty()) {
        [q, d1, mask, mm].forEach(function (o) { try { o.delete(); } catch (_) {} });
        orb.delete(); bf.delete(); k1.delete();
        setStatus('画面无可用特征（请打开大地图）', 'warn');
        return false;
      }
      bf.knnMatch(d1, st.refDesc, mm, 2);
      var src = [], dst = [];
      // 索引必须逐个查界。DMatch 的 queryIdx/trainIdx 来自 WASM 侧，
      // 一旦与当前 KeyPointVector 长度不符（例如底图特征被重建过、
      // 或某次 detectAndCompute 没产生描述子），KeyPointVector.get()
      // 会在 WASM 里越界，浏览器抛出
      //   RuntimeError: table index is out of bounds
      // ——这个文本不在任何 JS 源码里，所以很难靠搜索定位。
      // 用户实测正是在开启叠加层时看到它。
      var nQ = k1.size(), nR = st.refKp.size();
      var skipped = 0;
      for (var i = 0; i < mm.size(); i++) {
        var m = mm.get(i);
        if (m.size() < 2) continue;
        var a = m.get(0), b = m.get(1);
        if (a.distance < 0.8 * b.distance) {
          if (a.queryIdx < 0 || a.queryIdx >= nQ ||
              a.trainIdx < 0 || a.trainIdx >= nR) { skipped++; continue; }
          var p = k1.get(a.queryIdx).pt, r = st.refKp.get(a.trainIdx).pt;
          src.push(p.x, p.y); dst.push(r.x, r.y);
        }
      }
      if (skipped) {
        // 出现即说明参照特征与描述子不同步，重建一次比继续用坏数据更安全。
        console.warn('[map-overlay] 跳过 ' + skipped + ' 个越界匹配，重建参照特征');
        st.refDirty = true;
      }
      [q, d1, mask, mm].forEach(function (o) { try { o.delete(); } catch (_) {} });
      orb.delete(); bf.delete(); k1.delete();
      log('INFO', 'ORB: 帧特征=' + nQ + ' 底图特征=' + nR +
          ' 匹配=' + (src.length / 2) + (skipped ? ' 越界跳过=' + skipped : ''));
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
      // 记录堆栈：手机上看不到控制台，没有堆栈就只能靠猜
      var d1 = recordError('fullFit(ORB匹配)', e);
      setStatus('定位异常: ' + d1.message, 'bad');
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
    if (!st.on || !st.fit || !st.surface || !CVPIN) return;
    var CV = CVPIN;
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
      // 同样要查界：stt.rows 与 p0/p1 的 data32F 长度理论上一致，但一旦
      // calcOpticalFlowPyrLK 因输入退化而返回尺寸不符的结果，
      // data32F[i*2+1] 就会越界读 —— 在 WASM 堆上表现为脏数据或陷阱。
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
    // 图标半径跟随地图缩放，保证"比例大小正确"：地图放大时点变大、缩小时变小。
    // mag 是 world->screen 的等效缩放；乘以经验系数换算成可见半径。
    // 上限压到 6px 并叠加半透明填充，否则同时开多个分类（上万点）时
    // 圆点会连成一片把地形完全糊住（实测 8 类 6409 点时非常明显）。
    var mag = Math.sqrt(Math.abs(F.a * F.d - F.b * F.c)) || 1;
    var rad = Math.max(1.6, Math.min(6, 2.6 * mag * 40));

    // ---- 密度聚合 ------------------------------------------------------
    // 单个分类就有 2660 个点（普通宝箱），在缩小的地图上必然糊成一片彩色噪点，
    // 既看不出哪里有东西，也挡住地形。用户原话："一大堆彩色点无法有效分辨"。
    //
    // 做法：把屏幕切成网格，同格同类的点合并成一个"簇"，画一个略大的圆并标数字。
    // 网格边长取 max(18, rad*4)，即点小的时候（地图缩小）聚合得更狠。
    // 只有当簇内点数 >1 才聚合；单点照常画，不影响精确定位。
    var CELL = Math.max(18, rad * 4);
    // 放得足够大时不再聚合，直接看真实点。
    // 判据必须用 rad 本身：之前写的是 `CELL > rad * 3.2`，而 CELL 又等于
    // max(18, rad*4)，rad*4 恒大于 rad*3.2 —— 条件永真，聚合永远关不掉，
    // 所谓"放大后显示真实点"根本不会发生。
    // rad 在 6px 封顶（见上面的 min），所以取 5.4：接近上限即视为已放大。
    var clustering = rad < 5.4;

    var shown = 0;
    g.globalAlpha = 0.82;
    for (var mt in st.cats) {
      if (!st.enabled[mt]) continue;
      var pts = st.cats[mt].p, col = colorOf(mt);
      g.fillStyle = col;
      g.strokeStyle = 'rgba(0,0,0,.55)';
      g.lineWidth = Math.max(0.6, rad * 0.26);
      // 批量成一条路径再 fill/stroke。逐点 beginPath+arc+fill+stroke 是每点
      // 4 次 canvas 调用，实测 7118 点每帧中位 9.2ms、P95 18.3ms，超过一帧
      // 预算的一半并把 rAF 拖到 4.4fps。同色点共用一条路径后调用数降到 2 次。
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

  // 渲染循环：跟踪 + 重绘。用 rAF 保证与画面同步且不抢游戏 CPU。
  //
  // 追踪节流的取舍：间隔越大越省算力，但拖动时叠加层会滞后（实测 48ms 间隔
  // 下快速拖动有约 15px 滞后）。所以按"是否正在动"自适应：检测到明显位移就
  // 提到每帧追踪（跟手），静止时退回低频（省算力给游戏）。
  var lastTrack = 0, hotUntil = 0;
  // 上一次绘制用的变换与开关签名。叠加层静止时画面逐帧完全相同，
  // 重绘纯属浪费 —— 实测 13 个分类(7118 点)每帧中位 9.2ms、P95 18.3ms，
  // 已经吃掉一帧预算(16.7ms)的一半以上，并把 rAF 拖到 4.4fps，
  // 与视频渲染抢同一个主线程（用户任务管理器里 WebView2 渲染进程 26.2%）。
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
    // 还没定位成功时不该每帧忙转：trackStep/drawSig/hasFreshFrame 都要读画面
    // 或算签名，而此时根本没有可画的东西。用户在骁龙 7s Gen4 上报"游戏开启后
    // 设置页开始卡顿"，就是这个空转循环在跟 WebView 抢主线程。
    // 同理，页面不可见（切到设置页/后台）时直接停，靠 visibilitychange 恢复。
    if (document.hidden || !st.fit) {
      // 用独立字段存 timeout id：st.raf 只能放 rAF id，混用会让
      // cancelAnimationFrame 取消不掉，循环变成僵尸继续吃 CPU。
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
      // 这一段是内存高峰：底图 6144x4096 = 2500 万像素。
      // getImageData 一次就要 100MB 的 RGBA，再加灰度副本和 WASM 侧的 Mat。
      // 手机 WebView 的堆远小于桌面，之前用户在这里拿到
      // "table index is out of bounds"（WASM 陷阱），而同样代码在 Node
      // （4GB 堆）里 6144x6144 都能跑通 —— 差别就是内存。
      // 所以分块读取，并且每步都记日志，好让失败点在日志里一目了然。
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
          throw new Error('读取底图失败（y=' + y0 + '，已完成 ' +
                          (done / 1e6).toFixed(1) + 'M px）: ' +
                          (e && e.message || e));
        }
        var px = d.data, base = y0 * REF_W, m = hh * REF_W;
        for (var i = 0, j = 0; i < m; i++, j += 4) {
          grey[base + i] =
              (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
        }
        done += m;
      }
      log('INFO', '灰度提取完成 ' + (done / 1e6).toFixed(1) + 'M px');
      st.refMat = CV.matFromArray(REF_H, REF_W, CV.CV_8UC1, grey);
      log('INFO', 'refMat 建立 ' + st.refMat.rows + 'x' + st.refMat.cols);
      st.refKp = new CV.KeyPointVector();
      st.refDesc = new CV.Mat();
      var orb = new CV.ORB(12000, 1.2, 8, 31, 0, 2, CV.ORB_HARRIS_SCORE, 31, 8);
      orb.detectAndCompute(st.refMat, new CV.Mat(), st.refKp, st.refDesc);
      orb.delete();
      // 参照特征与描述子必须行数一致，否则匹配返回的 trainIdx 会越界，
      // KeyPointVector.get() 在 WASM 里抛 "table index is out of bounds"。
      // 这里在建库时就把不一致挡住，而不是等到匹配时才炸。
      log('INFO', '底图特征: kp=' + st.refKp.size() + ' desc=' + st.refDesc.rows);
      // 参照特征必须非空，否则后续 knnMatch 会在 WASM 里抛出一个**裸数字**
      // （emscripten 异常指针，实测 7030256 / 真机 7084592），既没有堆栈也
      // 不是可读文本 —— 这正是先前那些莫名错误（含 "table index is out of
      // bounds"）的来源。底图取不到时要在这里明确失败，而不是带着空描述子
      // 继续走下去。
      if (st.refKp.size() === 0 || st.refDesc.rows === 0 || st.refDesc.empty()) {
        throw new Error('底图无特征（kp=0）——底图可能未加载成功');
      }
      if (st.refDesc.rows !== st.refKp.size()) {
        throw new Error('参照特征不一致 (kp=' + st.refKp.size() +
                        ' desc=' + st.refDesc.rows + ')');
      }
      st.refDirty = false;
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
