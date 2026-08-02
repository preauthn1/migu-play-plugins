// 原神地图叠加 — ORB 重定位核心 + worker 入口（哈希锁定资产，随插件发布）。
//
// 为什么是"双上下文"单文件：匹配管线（ORB → knnMatch → RANSAC → 质量闸门 →
// 相似变换投影 → 坐标换算）曾在 main.js 同步回退路径与本 worker 各存一份，
// 改阈值/参数要两处同步，迟早分叉。现在核心只有这一份：worker 里跑是常规
// 路径（主线程零阻塞）；worker 起不来时 main.js 用 new Function 在页面装载
// 同一份代码走同步回退（声明 wasm 权限的插件允许 new Function，opencv.js
// 胶水自身就依赖它，宿主必然放行）。
//
// 【尺度对齐 + 局部搜索 —— 2026-08-02 实测依据】
// 旧管线把画面**放大**到 960 宽去匹配 3072x2048 底图。方向反了：用户屏幕上
// 的地图只对应底图 ~379px 宽的一小块（底图局部被放大 ~3.6 倍显示），画面再
// 放大 9 倍去匹配，尺度严重失配 —— knnMatch 8000x12000 = 9600 万次比较、
// 单次 8.7~10.6s，内点率仅 0.39。正确方向是把画面**缩小**到底图尺度：
// probe/match_at_ref_scale.py + roi_scale_combo.py（真实用户截图）实测：
//   缩到底图尺度 x1.1 过采样 + 全图 12000 特征: 匹配 88 内点 67 率 0.76
//   再加 ROI(上次位置 ±1.2 帧宽, 特征上限 2000): 内点 35 率 0.66，knnMatch
//   从 ~1200ms 降到 ~70ms —— 重定位时上一次的位置/尺度都是已知先验。
// 帧特征 1500 数量足够；金字塔 4 层即可（尺度已对齐，不需要 8 层跨尺度搜，
// 1.2^4≈2 倍余量覆盖先验尺度 ±20% 的漂移）。首次定位无先验：扫
// 960/760/540/380/270/190 宽六档取内点最多的一档（一次性成本，在 worker 里）。
'use strict';
(function (root) {

  function del(o) { try { o.delete(); } catch (_) {} }
  function now() {
    return (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
  }
  // emscripten 的 C++ 异常在 JS 侧是裸指针数值，必须解码否则无从定位
  // （实测 7030256 / 真机 7084592）
  function trapMsg(cv, e) {
    if (typeof e !== 'number') return (e && e.message) || String(e);
    var s = 'WASM 异常 #' + e;
    try {
      if (cv && typeof cv.getExceptionMessage === 'function') {
        var d = cv.getExceptionMessage(e);
        if (d) s += ': ' + d;
      }
    } catch (_) {}
    return s;
  }

  // opencv.js 只有 estimateAffine2D（6 自由度）。地图只会平移+等比缩放，
  // 必须把结果投影回相似变换（Procrustes 解析解），否则噪声引入剪切、
  // 叠加层被拉歪。
  function similarityFrom(a11, a12, a21, a22, b1, b2) {
    var c = (a11 + a22) / 2;
    var s = (a21 - a12) / 2;
    var scale = Math.sqrt(c * c + s * s);
    if (!isFinite(scale) || scale <= 1e-9) return null;
    return { a: c, b: -s, c: s, d: c, tx: b1, ty: b2 };
  }

  // 底图特征库。坐标/响应/描述子字节各留一份 JS 副本：ROI 子集在 JS 侧筛行
  // 再一次 matFromArray 上载，避免逐行的 WASM 拷贝调用。
  function buildRef(cv, grey, w, h) {
    var g = (grey && grey.buffer) ? grey : new Uint8Array(grey);
    var ref = cv.matFromArray(h, w, cv.CV_8UC1, g);
    var kp = new cv.KeyPointVector(), desc = new cv.Mat(), mask = new cv.Mat();
    var orb = new cv.ORB(12000, 1.2, 8, 31, 0, 2, cv.ORB_HARRIS_SCORE, 31, 8);
    orb.detectAndCompute(ref, mask, kp, desc);
    del(orb); del(ref); del(mask);
    var n = kp.size();
    // 特征与描述子必须同长且非空：不一致时 trainIdx 越界，WASM 抛
    // "table index is out of bounds"（该文本不在任何 JS 源码里，真机上
    // 极难定位）；空描述子进 knnMatch 抛裸指针数值。建库时就挡住。
    if (!n || desc.rows === 0 || desc.empty()) {
      del(kp); throw new Error('底图无特征（kp=0）');
    }
    if (desc.rows !== n) {
      del(kp);
      throw new Error('参照特征不一致 (kp=' + n + ' desc=' + desc.rows + ')');
    }
    var pts = new Float32Array(n * 2), resp = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var p = kp.get(i);
      pts[i * 2] = p.pt.x; pts[i * 2 + 1] = p.pt.y; resp[i] = p.response;
    }
    del(kp);
    return { n: n, mat: desc, bytes: new Uint8Array(desc.data),
             pts: pts, resp: resp };
  }

  // ORB/BFMatcher 实例可复用，省去每次重定位的构造开销（ctx 由调用方持有）
  function ensureCtx(cv, ctx) {
    if (!ctx.orb) {
      ctx.orb = new cv.ORB(1500, 1.2, 4, 31, 0, 2, cv.ORB_HARRIS_SCORE, 31, 8);
      ctx.bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
    }
  }

  // ROI 子集：取上次位置 ±pad 内的库特征。城内等密集区子区可到 8000+，
  // 按响应值截强的 2000 个，锁住 knnMatch 上限。子区特征太少（贴图边缘/
  // 预测飘出图外）返回 null，调用方退全图。
  function gatherRoi(cv, store, cx, cy, pad) {
    var idx = [], pts = store.pts, n = store.n;
    for (var i = 0; i < n; i++) {
      var x = pts[i * 2], y = pts[i * 2 + 1];
      if (x >= cx - pad && x <= cx + pad && y >= cy - pad && y <= cy + pad)
        idx.push(i);
    }
    if (idx.length < 60) return null;
    if (idx.length > 2000) {
      idx.sort(function (a, b) { return store.resp[b] - store.resp[a]; });
      idx = idx.slice(0, 2000);
    }
    var buf = new Uint8Array(idx.length * 32);
    for (var j = 0; j < idx.length; j++)
      buf.set(store.bytes.subarray(idx[j] * 32, (idx[j] + 1) * 32), j * 32);
    return { idx: idx, mat: cv.matFromArray(idx.length, 32, cv.CV_8UC1, buf) };
  }

  // 单次匹配：帧灰度 Mat vs 底图（全图或 ROI 子集）。
  // k/ox/oy 是请求时的画面几何（CSS/帧 比例与画面偏移），成功时直接算出
  // world -> 屏幕 CSS 的 fit。
  function matchOne(cv, store, ctx, q, k, ox, oy, roi) {
    var t0 = now();
    var out = { ok: false, nR: store.n };
    var sel = null;
    if (roi) {
      sel = gatherRoi(cv, store, roi.cx, roi.cy, roi.pad);
      if (!sel) return null;
      out.nR = sel.idx.length;
    }
    var k1 = new cv.KeyPointVector(), d1 = new cv.Mat(), mask = new cv.Mat();
    var mm = null;
    try {
      ctx.orb.detectAndCompute(q, mask, k1, d1);
      out.nQ = k1.size();
      if (!d1 || d1.rows === 0 || d1.empty()) { out.why = 'nofeat'; return out; }
      mm = new cv.DMatchVectorVector();
      ctx.bf.knnMatch(d1, sel ? sel.mat : store.mat, mm, 2);
      var src = [], dst = [], nQ = out.nQ, nR = out.nR, skipped = 0;
      var pts = store.pts;
      for (var i = 0; i < mm.size(); i++) {
        var pair = mm.get(i);
        if (pair.size() < 2) continue;
        var a = pair.get(0), b = pair.get(1);
        if (a.distance < 0.8 * b.distance) {
          // 逐个查界：queryIdx/trainIdx 来自 WASM 侧，一旦与向量长度不符，
          // get() 会在 WASM 堆上越界（"table index is out of bounds"）
          if (a.queryIdx < 0 || a.queryIdx >= nQ ||
              a.trainIdx < 0 || a.trainIdx >= nR) { skipped++; continue; }
          var p = k1.get(a.queryIdx).pt;
          var ti = sel ? sel.idx[a.trainIdx] : a.trainIdx;
          src.push(p.x, p.y); dst.push(pts[ti * 2], pts[ti * 2 + 1]);
        }
      }
      out.matches = src.length / 2; out.skipped = skipped;
      if (src.length < 24) { out.why = 'few'; return out; }
      var sm = cv.matFromArray(src.length / 2, 1, cv.CV_32FC2, src);
      var dm = cv.matFromArray(dst.length / 2, 1, cv.CV_32FC2, dst);
      var inl = new cv.Mat();
      // 帧 -> 底图
      var M = cv.estimateAffine2D(sm, dm, inl, cv.RANSAC, 4, 2000, 0.99, 10);
      var nin = cv.countNonZero(inl);
      var sim = M.empty() ? null
          : similarityFrom(M.doubleAt(0, 0), M.doubleAt(0, 1),
                           M.doubleAt(1, 0), M.doubleAt(1, 1),
                           M.doubleAt(0, 2), M.doubleAt(1, 2));
      del(sm); del(dm); del(inl); del(M);
      out.nin = nin;
      if (!sim) { out.why = 'degenerate'; return out; }
      // 内点数**和**内点率都要够。真机日志出现过匹配 73~104、内点 13（率
      // ~15%）却被"13>12"放行的假解：4px 阈值下随机匹配集也能凑出让十来个
      // 点吻合的仿射。0.28 的依据：靶场真解实测 0.6+，噪声解 0.12~0.18。
      var ratio = out.matches ? nin / out.matches : 0;
      out.pct = Math.round(ratio * 100);
      if (nin < 12 || ratio < 0.28) { out.why = 'lowq'; return out; }
      var det = sim.a * sim.d - sim.b * sim.c;
      if (!det) { out.why = 'degenerate'; return out; }
      // 反解（底图 -> 帧），再用画面几何换算成 world -> 屏幕 CSS
      var i11 = sim.d / det, i12 = -sim.b / det;
      var i21 = -sim.c / det, i22 = sim.a / det;
      var itx = -(i11 * sim.tx + i12 * sim.ty);
      var ity = -(i21 * sim.tx + i22 * sim.ty);
      out.fit = { a: i11 * k, b: i12 * k, c: i21 * k, d: i22 * k,
                  tx: itx * k + ox, ty: ity * k + oy };
      out.ok = true;
      return out;
    } finally {
      del(k1); del(d1); del(mask);
      if (mm) del(mm);
      if (sel) del(sel.mat);
      out.ms = Math.round(now() - t0);
    }
  }

  // 一次 fit 请求的编排。m: {grey,w,h, k,ox,oy, mode:'prior'|'pyr', cx,cy,pad}
  //   prior: 先 ROI，落空/失败退全图（同一帧、同一尺度）
  //   pyr  : 无先验（首次/连败 3 次），金字塔扫描取内点最多的一档
  function runFit(cv, store, ctx, m) {
    ensureCtx(cv, ctx);
    var q = cv.matFromArray(m.h, m.w, cv.CV_8UC1, new Uint8Array(m.grey));
    try {
      var res = null;
      if (m.mode === 'prior' && m.pad) {
        res = matchOne(cv, store, ctx, q, m.k, m.ox, m.oy,
                       { cx: m.cx, cy: m.cy, pad: m.pad });
        if (res) res.path = 'roi';
        if (!res || !res.ok) {
          var full = matchOne(cv, store, ctx, q, m.k, m.ox, m.oy, null);
          full.path = 'full';
          if (!res || full.ok || (full.nin || 0) > (res.nin || 0)) res = full;
        }
        return res;
      }
      // 金字塔：中间档优先（典型游戏缩放落在 380~540 对应的区间），某档过
      // 闸门且内点 >=30 就提前收工——首档定位后续都走 prior 路径自我修正，
      // 不必为了"最优档"扫完全部（每档全图 knnMatch 是大头）。
      // resize 缺席（裁剪版构建）时退化为只匹配原始帧。
      var widths = (typeof cv.resize === 'function')
          ? [540, 380, 760, 270, m.w, 190] : [m.w];
      var best = null, seen = {};
      for (var i = 0; i < widths.length; i++) {
        var wc = widths[i];
        if (wc > m.w || seen[wc]) continue;
        seen[wc] = 1;
        var qm = q;
        if (wc !== m.w) {
          qm = new cv.Mat();
          cv.resize(q, qm, new cv.Size(wc, Math.max(1, Math.round(m.h * wc / m.w))),
                    0, 0, cv.INTER_AREA);
        }
        // 每档的 CSS/帧 比例要跟着帧宽换算，否则选中小档时 fit 会整体偏大
        var r = matchOne(cv, store, ctx, qm, m.k * m.w / wc, m.ox, m.oy, null);
        if (qm !== q) del(qm);
        if (r) {
          r.path = 'pyr' + wc;
          if (!best || (r.nin || 0) > (best.nin || 0)) best = r;
          if (r.ok && r.nin >= 30) break;
        }
      }
      return best || { ok: false, why: 'nofeat', path: 'pyr' };
    } finally {
      del(q);
    }
  }

  root.__miguFitCore = { buildRef: buildRef, runFit: runFit, trapMsg: trapMsg };

  // ---- 以下仅 worker 上下文：消息层 ---------------------------------------
  if (typeof importScripts !== 'function') return;

  var CV = null, store = null, ctx = {};

  root.onmessage = function (ev) {
    var m = ev.data || {};
    try {
      if (m.type === 'init') { init(m); return; }
      if (m.type !== 'fit') return;
      if (!CV || !store) {
        postMessage({ type: 'fit', id: m.id, ok: false, error: 'worker 未初始化' });
        return;
      }
      var out = runFit(CV, store, ctx, m) || { ok: false, why: 'nofeat' };
      out.type = 'fit'; out.id = m.id;
      postMessage(out);
    } catch (e) {
      var msg = trapMsg(CV, e);
      if (m.type === 'init') postMessage({ type: 'fail', message: msg });
      else postMessage({ type: 'fit', id: m.id, ok: false, error: msg });
    }
  };

  function init(m) {
    // importScripts 同步执行 opencv 胶水；worker 里没有 window，
    // emscripten 挂在 self.cv 上。
    importScripts(m.cvUrl);
    // 【尸检：为什么这里全程不许出现 Promise】emscripten 注入的 self.cv 是
    // thenable 但不是合规 Promise，有两个连环坑（都以"45s 初始化超时"收场）：
    //   缺陷一：cv.then(...) 不返回 Promise（.catch is not a function），
    //     组链在第一环就断 —— 回调其实被调了，但后续 .then 永远等不到；
    //   缺陷二（上一轮修复失败的原因）：把 cv 交给 Promise 解析流程
    //     （Promise.resolve(cv) 或 executor 里 resolve(cv)）时，规范要求
    //     adoption：引擎去调 cv.then(resolve)，而 emscripten 的 then 回调
    //     回传的又是 cv 自身，仍是 thenable，于是无限重新 adoption，
    //     promise 永远 pending。
    // 所以用纯回调 + 轮询，两条路谁先到算谁，绝不把 cv 塞进任何 Promise。
    // （probe/worker_cv_conflict.py 的最小 worker 即此写法，真实规模下
    // 10~12s 就绪，同时否证了"与页面已有 cv 实例冲突"的猜想。）
    var done = false;
    var ok = function () {
      if (done || !(self.cv && self.cv.ORB)) return;
      done = true; clearInterval(iv);
      try {
        CV = self.cv;
        store = buildRef(CV, m.grey, m.w, m.h);
        postMessage({ type: 'ready', kp: store.n });
      } catch (e) {
        postMessage({ type: 'fail', message: trapMsg(CV, e) });
      }
    };
    try {
      if (self.cv && typeof self.cv.then === 'function') self.cv.then(ok);
    } catch (_) {}
    try { if (self.cv) self.cv.onRuntimeInitialized = ok; } catch (_) {}
    var t = 0;
    var iv = setInterval(function () {
      t += 150;
      if (self.cv && self.cv.ORB) ok();
      else if (t > 60000) {
        clearInterval(iv);
        if (!done) { done = true; postMessage({ type: 'fail', message: 'cv 初始化超时' }); }
      }
    }, 150);
    ok();   // 已经就绪的情况
  }
})(typeof self !== 'undefined' ? self : this);
