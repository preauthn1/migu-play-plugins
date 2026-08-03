// 原神地图叠加 — ORB 重定位核心 + worker 入口（哈希锁定资产，随插件发布）。
//
// 为什么是"双上下文"单文件：匹配管线曾在 main.js 同步回退路径与本 worker 各存
// 一份，改阈值要两处同步，迟早分叉。现在核心只有这一份：worker 里跑是常规路径
// （主线程零阻塞）；worker 起不来时 main.js 用 new Function 在页面装载同一份
// 代码走同步回退（声明 wasm 权限的插件允许 new Function，opencv.js 胶水自身
// 就依赖它，宿主必然放行）。
//
// 【检索结构 —— 2026-08-03 实测依据（probe/bench_stages.py，Chromium WASM）】
// 旧管线有先验时也要 knnMatch 1500x2000（306ms），先验落空退全图 1500x12000
// （1472ms）；真机 ROI 264~781ms、退化 1.3~2.0s、金字塔 2.9~10.2s，全被
// BFMatcher 吃掉。三层替换：
//   1) 投影引导匹配（常态）：上次定位的 帧→底图 仿射把每个帧特征投到底图上，
//      只与 64px 网格里半径 rad 内的库特征比（均值 ~60 个候选），JS popcount
//      汉明 1500 查询仅 ~13ms —— 匹配阶段 306ms → ~15ms。radius 内的次优
//      距离照常做 0.8 比值检验，另加绝对阈值 64 兜住候选过少的格子。
//   2) 粗筛库（退化路径的硬上限）：建库时每 48px 网格取响应最高的 1 个特征
//      （上限 2500，Mat 只建一次），先验失效时 knnMatch 1500x~2500 ≈ 360ms
//      定个粗位姿，再用它当先验跑一遍投影匹配拿全精度 —— 退化路径从
//      1500x12000 的 1.5s 封顶到 detect+360+15ms，且不再随库规模长大。
//   3) 金字塔（首次/跟丢）：每档只对粗筛库匹配、选出最优档后做一次投影精化；
//      worker 里逐档让出事件循环，新请求到达即丢弃旧扫描（可丢弃/可合并）。
// 尺度对齐不变（2026-08-02，probe/match_at_ref_scale.py）：画面必须缩到底图
// 尺度再匹配，帧比底图粗是安全方向，帧比底图细才致命。
'use strict';
(function (root) {

  function del(o) { try { o.delete(); } catch (_) {} }
  function now() {
    return (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
  }
  // emscripten 的 C++ 异常在 JS 侧是裸指针数值，必须解码否则无从定位
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
  // 必须把结果投影回相似变换（Procrustes 解析解），否则噪声引入剪切。
  function similarityFrom(a11, a12, a21, a22, b1, b2) {
    var c = (a11 + a22) / 2;
    var s = (a21 - a12) / 2;
    var scale = Math.sqrt(c * c + s * s);
    if (!isFinite(scale) || scale <= 1e-9) return null;
    return { a: c, b: -s, c: s, d: c, tx: b1, ty: b2 };
  }

  // 256 位描述子的汉明距离：8 个 u32 逐字 popcount（无查表，JS 引擎可内联）
  function ham(A, ai, B, bi) {
    var d = 0;
    for (var w = 0; w < 8; w++) {
      var v = A[ai + w] ^ B[bi + w];
      v = v - ((v >> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
      d += (((v + (v >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
    }
    return d;
  }

  var GRID = 64;    // 投影匹配的空间网格边长（底图像素）
  var COARSE = 48;  // 粗筛库网格：每格保响应最高的 1 个特征

  // 底图特征库。坐标/响应/描述子字节各留一份 JS 副本（投影匹配全程不碰 WASM），
  // 外加 64px 网格 CSR 索引与一次性构建的粗筛 Mat。
  function buildRef(cv, grey, w, h) {
    var g = (grey && grey.buffer) ? grey : new Uint8Array(grey);
    var ref = cv.matFromArray(h, w, cv.CV_8UC1, g);
    var kp = new cv.KeyPointVector(), desc = new cv.Mat(), mask = new cv.Mat();
    var orb = new cv.ORB(12000, 1.2, 8, 31, 0, 2, cv.ORB_HARRIS_SCORE, 31, 8);
    orb.detectAndCompute(ref, mask, kp, desc);
    del(orb); del(ref); del(mask);
    var n = kp.size();
    // 特征与描述子必须同长且非空：不一致时 trainIdx 越界会在 WASM 堆上炸出
    // "table index is out of bounds"；空描述子进 knnMatch 抛裸指针数值。
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
    var bytes = new Uint8Array(desc.data);   // 拷贝出 WASM 堆
    var b32 = new Uint32Array(bytes.buffer);

    // 网格 CSR：cell -> [特征下标]，两遍计数法，零碎片
    var gw = Math.ceil(w / GRID), gh = Math.ceil(h / GRID);
    var cnt = new Int32Array(gw * gh + 1);
    var ci = new Int32Array(n);
    for (i = 0; i < n; i++) {
      var cx = (pts[i * 2] / GRID) | 0, cy = (pts[i * 2 + 1] / GRID) | 0;
      ci[i] = cy * gw + cx; cnt[ci[i] + 1]++;
    }
    for (i = 1; i <= gw * gh; i++) cnt[i] += cnt[i - 1];
    var gIdx = new Int32Array(n), cur = cnt.slice(0, gw * gh);
    for (i = 0; i < n; i++) gIdx[cur[ci[i]]++] = i;

    // 粗筛库（退化路径的匹配上限）：ORB 强响应特征高度扎堆——实测 12000 个
    // 特征只落在 402 个 48px 格里，"每格 top-1"会把库饿死到 402 个、粗筛
    // 匹配直接失效。改为按响应降序全局扫描、每格最多 8 个、总量 2500：
    // 既保空间覆盖又保强度。
    var cw2 = Math.ceil(w / COARSE), ch2 = Math.ceil(h / COARSE);
    var cellCnt = new Uint8Array(cw2 * ch2);
    var ord = new Array(n);
    for (i = 0; i < n; i++) ord[i] = i;
    ord.sort(function (a, b) { return resp[b] - resp[a]; });
    var cIdx = [];
    for (i = 0; i < n && cIdx.length < 2500; i++) {
      var oi = ord[i];
      var c2 = ((pts[oi * 2 + 1] / COARSE) | 0) * cw2 +
               ((pts[oi * 2] / COARSE) | 0);
      if (cellCnt[c2] < 8) { cellCnt[c2]++; cIdx.push(oi); }
    }
    var cbuf = new Uint8Array(cIdx.length * 32);
    for (i = 0; i < cIdx.length; i++)
      cbuf.set(bytes.subarray(cIdx[i] * 32, cIdx[i] * 32 + 32), i * 32);
    var cMat = cv.matFromArray(cIdx.length, 32, cv.CV_8UC1, cbuf);
    del(desc);   // 全图 12000 的 WASM Mat 不再需要：投影匹配走 JS 副本
    return { n: n, bytes: bytes, b32: b32, pts: pts, resp: resp,
             w: w, h: h, gw: gw, gh: gh, gOff: cnt, gIdx: gIdx,
             cIdx: new Int32Array(cIdx), cMat: cMat, nc: cIdx.length };
  }

  // ORB/BFMatcher 实例复用。帧特征档位（A/B：bench_match.py）：900/2 层最快
  // （92ms/内点46）但吃不住 1.3 倍以上尺度失配；1500/4 最稳（内点91）。
  // main.js 按连败数选档，这里的 1200/3 只是未指定时的折中默认。
  function ensureCtx(cv, ctx, nf, lv) {
    nf = nf || 1200; lv = lv || 3;
    if (!ctx.orb || ctx.nf !== nf || ctx.lv !== lv) {
      if (ctx.orb) del(ctx.orb);
      ctx.orb = new cv.ORB(nf, 1.2, lv, 31, 0, 2, cv.ORB_HARRIS_SCORE, 31, 8);
      ctx.nf = nf; ctx.lv = lv;
      if (!ctx.bf) ctx.bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
    }
  }

  // 一帧只检测一次，坐标与描述子拷进 JS，proj/coarse/refine 三条路共用
  function detectQ(cv, ctx, q) {
    var k1 = new cv.KeyPointVector(), d1 = new cv.Mat(), mask = new cv.Mat();
    ctx.orb.detectAndCompute(q, mask, k1, d1);
    del(mask);
    var n = k1.size();
    if (!n || d1.rows === 0 || d1.empty() || d1.rows !== n) {
      del(k1); del(d1); return null;
    }
    var xy = new Float32Array(n * 2);
    for (var i = 0; i < n; i++) {
      var p = k1.get(i);
      xy[i * 2] = p.pt.x; xy[i * 2 + 1] = p.pt.y;
    }
    del(k1);
    var bytes = new Uint8Array(d1.data);
    return { n: n, xy: xy, b32: new Uint32Array(bytes.buffer), d1: d1 };
  }

  // 匹配对 → RANSAC → 质量闸门 → 相似变换 → world→屏幕 fit 的公共尾部。
  // 内点数**和**内点率都要够：真机出现过 73 匹配 / 13 内点（率 15%）的假解。
  function solveTail(cv, out, src, dst, kx, ky, ox, oy) {
    out.matches = src.length / 2;
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
    var ratio = out.matches ? nin / out.matches : 0;
    out.pct = Math.round(ratio * 100);
    if (nin < 12 || ratio < 0.28) { out.why = 'lowq'; return out; }
    var det = sim.a * sim.d - sim.b * sim.c;
    if (!det) { out.why = 'degenerate'; return out; }
    out.pri = sim;   // 帧→底图 相似变换：refine/下一轮投影匹配直接当先验
    // 反解（底图 -> 帧），再用画面几何换算成 world -> 屏幕 CSS。
    // kx/ky 分开：video object-fit:fill 拉伸时两轴比例不同。
    var i11 = sim.d / det, i12 = -sim.b / det;
    var i21 = -sim.c / det, i22 = sim.a / det;
    var itx = -(i11 * sim.tx + i12 * sim.ty);
    var ity = -(i21 * sim.tx + i22 * sim.ty);
    out.fit = { a: i11 * kx, b: i12 * kx, c: i21 * ky, d: i22 * ky,
                tx: itx * kx + ox, ty: ity * ky + oy };
    out.ok = true;
    return out;
  }

  // 投影引导匹配：帧特征经先验投到底图，只比网格半径 rad 内的库特征。
  function projPairs(store, det, pri, rad) {
    var src = [], dst = [], pts = store.pts, gw = store.gw, gh = store.gh;
    var gOff = store.gOff, gIdx = store.gIdx, rb = store.b32, qb = det.b32;
    for (var i = 0; i < det.n; i++) {
      var x = det.xy[i * 2], y = det.xy[i * 2 + 1];
      var px = pri.a * x + pri.b * y + pri.tx;
      var py = pri.c * x + pri.d * y + pri.ty;
      if (px < -rad || py < -rad || px > store.w + rad || py > store.h + rad)
        continue;
      var cx0 = Math.max(0, ((px - rad) / GRID) | 0);
      var cx1 = Math.min(gw - 1, ((px + rad) / GRID) | 0);
      var cy0 = Math.max(0, ((py - rad) / GRID) | 0);
      var cy1 = Math.min(gh - 1, ((py + rad) / GRID) | 0);
      var b1 = 999, b2 = 999, bj = -1, qi = i * 8;
      for (var cy = cy0; cy <= cy1; cy++) {
        for (var cx = cx0; cx <= cx1; cx++) {
          var c = cy * gw + cx;
          for (var k = gOff[c]; k < gOff[c + 1]; k++) {
            var j = gIdx[k];
            var dx = pts[j * 2] - px, dy = pts[j * 2 + 1] - py;
            if (dx * dx + dy * dy > rad * rad) continue;
            var d = ham(qb, qi, rb, j * 8);
            if (d < b1) { b2 = b1; b1 = d; bj = j; }
            else if (d < b2) b2 = d;
          }
        }
      }
      // 0.8 比值检验 + 绝对阈值：候选很少时 b2 缺失/不可靠，64 兜底
      if (bj >= 0 && b1 <= 64 && b1 < 0.8 * b2) {
        src.push(x, y); dst.push(pts[bj * 2], pts[bj * 2 + 1]);
      }
    }
    return { src: src, dst: dst };
  }

  // 粗筛匹配：knnMatch 帧 x 粗筛库（≤2500，Mat 建库时已就绪）——退化路径的
  // 代价上限，不随库规模变化。
  function coarsePairs(cv, store, ctx, det) {
    var mm = new cv.DMatchVectorVector();
    ctx.bf.knnMatch(det.d1, store.cMat, mm, 2);
    var src = [], dst = [], pts = store.pts, nc = store.nc, nq = det.n;
    for (var i = 0; i < mm.size(); i++) {
      var pair = mm.get(i);
      if (pair.size() < 2) continue;
      var a = pair.get(0), b = pair.get(1);
      if (a.distance < 0.8 * b.distance) {
        // trainIdx/queryIdx 来自 WASM 侧，越界读会炸堆，逐个查界
        if (a.queryIdx < 0 || a.queryIdx >= nq ||
            a.trainIdx < 0 || a.trainIdx >= nc) continue;
        var t = store.cIdx[a.trainIdx];
        src.push(det.xy[a.queryIdx * 2], det.xy[a.queryIdx * 2 + 1]);
        dst.push(pts[t * 2], pts[t * 2 + 1]);
      }
    }
    del(mm);
    return { src: src, dst: dst };
  }

  // 有先验的一次定位：投影匹配 → 失败退粗筛 → 粗筛成功再投影精化。
  // detect 只跑一次（旧代码退化路径要重复付一次 detect）。
  function fitWithPrior(cv, store, ctx, q, m) {
    var out = { ok: false, nR: store.n };
    var det = detectQ(cv, ctx, q);
    if (!det) { out.why = 'nofeat'; out.nQ = 0; return out; }
    out.nQ = det.n;
    try {
      if (m.pri) {
        var pp = projPairs(store, det, m.pri, m.rad || 90);
        solveTail(cv, out, pp.src, pp.dst, m.kx, m.ky, m.ox, m.oy);
        if (out.ok) { out.path = 'proj'; return out; }
      }
      // 退化：粗筛全图定粗位姿（硬上限 ~2500），成功则投影精化拿全精度
      var out2 = { ok: false, nR: store.nc };
      var cp = coarsePairs(cv, store, ctx, det);
      solveTail(cv, out2, cp.src, cp.dst, m.kx, m.ky, m.ox, m.oy);
      out2.nQ = det.n;
      if (out2.ok) {
        var out3 = { ok: false, nQ: det.n, nR: store.n };
        var rp = projPairs(store, det, out2.pri, 60);
        solveTail(cv, out3, rp.src, rp.dst, m.kx, m.ky, m.ox, m.oy);
        if (out3.ok && out3.nin >= out2.nin) { out3.path = 'coarse+r'; return out3; }
        out2.path = 'coarse'; return out2;
      }
      out2.path = 'coarse';
      // 都失败：报"更接近成功"的那个，方便日志判因
      return (out2.matches || 0) > (out.matches || 0) ? out2 : out;
    } finally {
      del(det.d1);
    }
  }

  // 金字塔一档：缩放 → detect → 粗筛。返回结果与该档的 det（精化要用）。
  function pyrStep(cv, store, ctx, q, m, wc) {
    var qm = q, made = false;
    if (wc !== m.w && typeof cv.resize === 'function') {
      qm = new cv.Mat(); made = true;
      cv.resize(q, qm, new cv.Size(wc, Math.max(1, Math.round(m.h * wc / m.w))),
                0, 0, cv.INTER_AREA);
    }
    var det = detectQ(cv, ctx, qm);
    var out = { ok: false, nR: store.nc, nQ: det ? det.n : 0, path: 'pyr' + wc };
    var s = m.w / wc;   // 每档的 CSS/帧 比例跟着帧宽换算，否则 fit 整体偏大
    if (det) {
      var cp = coarsePairs(cv, store, ctx, det);
      solveTail(cv, out, cp.src, cp.dst, m.kx * s, m.ky * s, m.ox, m.oy);
      del(det.d1);
    }
    if (made) del(qm);
    return { out: out, det: det, s: s };
  }

  // 金字塔选出最优档后的投影精化（用全量 12000 特征网格，精度回到常态水平）
  function pyrRefine(cv, store, ctx, m, best) {
    if (!best || !best.out.ok || !best.det) return best ? best.out : null;
    var out = { ok: false, nQ: best.det.n, nR: store.n, path: best.out.path + '+r' };
    var rp = projPairs(store, best.det, best.out.pri, 60);
    solveTail(cv, out, rp.src, rp.dst, m.kx * best.s, m.ky * best.s, m.ox, m.oy);
    return (out.ok && out.nin >= best.out.nin) ? out : best.out;
  }

  function pyrWidths(cv, m) {
    // 中间档优先（典型游戏缩放落在 380~540），resize 缺席时退化为原始帧
    var ws = (typeof cv.resize === 'function')
        ? [540, 380, 760, 270, m.w, 190] : [m.w];
    var out = [], seen = {};
    for (var i = 0; i < ws.length; i++) {
      if (ws[i] > m.w || seen[ws[i]]) continue;
      seen[ws[i]] = 1; out.push(ws[i]);
    }
    return out;
  }

  // 同步入口（主线程回退路径用；worker 用下面的分步版以便丢弃过期请求）。
  // m: {grey,w,h, kx,ky,ox,oy, mode:'prior'|'pyr', pri:帧→底图仿射, rad}
  function runFit(cv, store, ctx, m) {
    ensureCtx(cv, ctx, m.nf, m.lv);
    if (m.kx == null) { m.kx = m.k; m.ky = m.k; }   // 兼容旧字段
    var q = cv.matFromArray(m.h, m.w, cv.CV_8UC1, new Uint8Array(m.grey));
    try {
      if (m.mode === 'prior') return fitWithPrior(cv, store, ctx, q, m);
      var widths = pyrWidths(cv, m), best = null;
      for (var i = 0; i < widths.length; i++) {
        var r = pyrStep(cv, store, ctx, q, m, widths[i]);
        if (!best || (r.out.nin || 0) > (best.out.nin || 0)) best = r;
        if (r.out.ok && r.out.nin >= 30) break;
      }
      return pyrRefine(cv, store, ctx, m, best) ||
             { ok: false, why: 'nofeat', path: 'pyr' };
    } finally {
      del(q);
    }
  }

  root.__miguFitCore = { buildRef: buildRef, runFit: runFit, trapMsg: trapMsg,
                         pyrWidths: pyrWidths, pyrStep: pyrStep,
                         pyrRefine: pyrRefine, fitWithPrior: fitWithPrior,
                         ensureCtx: ensureCtx };

  // ---- 以下仅 worker 上下文：消息层 ---------------------------------------
  if (typeof importScripts !== 'function') return;

  var CV = null, store = null, ctx = {};

  // 请求"只跑最新"：pending 永远只存一条；金字塔逐档让出事件循环，
  // 新请求落地即丢弃旧扫描 —— 自动重定位在 worker 里永远排不成队。
  var pending = null, busy = false;

  root.onmessage = function (ev) {
    var m = ev.data || {};
    try {
      if (m.type === 'init') { init(m); return; }
      if (m.type !== 'fit') return;
      if (!CV || !store) {
        postMessage({ type: 'fit', id: m.id, ok: false, error: 'worker 未初始化' });
        return;
      }
      pending = m;          // 顶替未开跑的旧请求（旧 id 的应答主线程会丢弃）
      if (!busy) drain();
    } catch (e) {
      var msg = trapMsg(CV, e);
      if (m.type === 'init') postMessage({ type: 'fail', message: msg });
      else postMessage({ type: 'fit', id: m.id, ok: false, error: msg });
    }
  };

  function drain() {
    var m = pending; pending = null;
    if (!m) { busy = false; return; }
    busy = true;
    var t0 = now();
    var finish = function (out) {
      out = out || { ok: false, why: 'nofeat' };
      out.type = 'fit'; out.id = m.id; out.ms = Math.round(now() - t0);
      postMessage(out);
      setTimeout(drain, 0);   // 让新消息先落地再取下一条
    };
    try {
      ensureCtx(CV, ctx, m.nf, m.lv);
      if (m.kx == null) { m.kx = m.k; m.ky = m.k; }
      var q = CV.matFromArray(m.h, m.w, CV.CV_8UC1, new Uint8Array(m.grey));
      if (m.mode === 'prior') {
        var r = fitWithPrior(CV, store, ctx, q, m);
        del(q); finish(r); return;
      }
      // 金字塔：逐档 setTimeout(0)，档间检查 pending —— 长扫描可被新请求打断
      var widths = pyrWidths(CV, m), i = 0, best = null;
      var step = function () {
        try {
          if (pending) {   // 有更新的请求：丢弃本次扫描
            del(q); finish({ ok: false, why: 'superseded' }); return;
          }
          if (i >= widths.length) {
            var out = pyrRefine(CV, store, ctx, m, best);
            del(q); finish(out); return;
          }
          var r = pyrStep(CV, store, ctx, q, m, widths[i++]);
          if (!best || (r.out.nin || 0) > (best.out.nin || 0)) best = r;
          if (r.out.ok && r.out.nin >= 30) i = widths.length;   // 提前收工
          setTimeout(step, 0);
        } catch (e) {
          del(q); finish({ ok: false, error: trapMsg(CV, e) });
        }
      };
      step();
    } catch (e) {
      finish({ ok: false, error: trapMsg(CV, e) });
    }
  }

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
