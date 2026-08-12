// 帧泵 worker：从 MediaStreamTrackProcessor 直读 VideoFrame，在 worker 里缩放
// 取灰度，把结果零拷贝转移给主线程。
//
// 为什么存在这个文件：跟踪的硬成本不是算法而是取帧。主线程每帧都要
// drawImage(video→canvas) 把 GPU 纹理回读到 CPU，真机实测中位 13.9ms
// （见 main.js 中 trackStep 前的注释），20Hz 跟踪 = 278ms/s 全压在主线程。
//
// 为什么不是 createImageBitmap + transfer：它付的是同一笔 GPU 回读钱。
// 靶场 A/B（migu-play 仓库 probe/offscreen_grab_feasible.py 实测）：
//   现状 drawImage+getImageData+灰度   主线程 11.8ms/帧
//   createImageBitmap(原尺寸)          主线程  8.3ms/帧
//   createImageBitmap(resize 384)      主线程  9.3ms/帧
//   → 只省 22%，没解决问题。
// MediaStreamTrackProcessor 让 worker 直接持有 VideoFrame，主线程完全不参与：
// 同一靶场实测主线程 10ms 定时器空闲率 99.7%，取帧占用归零。
//
// 协议：
//   主线程 → worker  {type:'start', stream: ReadableStream(transfer), tw}
//                    {type:'want'}                       请求下一帧（背压）
//   worker → 主线程  {type:'ready'}
//                    {type:'frame', grey:ArrayBuffer(transfer), w,h,vw,vh,std}
//                    {type:'fail', message}
//                    {type:'end'}                        轨道结束
//
// 几何（内容矩形 ≠ 元素盒）只能在主线程算，worker 没有 DOM —— 所以这里只回
// 灰度与原始帧尺寸(vw/vh)，contentBox 换算留给 main.js 的 trackGrab。

var oc = null, og = null, tw = 384, want = 0, reader = null;

function process(frame) {
  var vw = frame.displayWidth, vh = frame.displayHeight;
  if (!vw || !vh) return;
  var w = Math.min(tw, vw), h = Math.max(1, Math.round(w * vh / vw));
  if (!oc || oc.width !== w || oc.height !== h) {
    oc = new OffscreenCanvas(w, h);
    og = oc.getContext('2d', { willReadFrequently: true });
  }
  og.drawImage(frame, 0, 0, w, h);
  var d = og.getImageData(0, 0, w, h), px = d.data, n = w * h;
  var grey = new Uint8Array(n), sum = 0, sq = 0;
  for (var i = 0, j = 0; i < n; i++, j += 4) {
    var v = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
    grey[i] = v; sum += v; sq += v * v;
  }
  var mean = sum / n, std = Math.sqrt(Math.max(0, sq / n - mean * mean));
  // grey.buffer 转移出去（零拷贝）；vw/vh 带上，主线程算内容矩形要用
  self.postMessage({ type: 'frame', grey: grey.buffer, w: w, h: h,
                     vw: vw, vh: vh, std: std }, [grey.buffer]);
}

function loop() {
  reader.read().then(function (r) {
    if (r.done) { self.postMessage({ type: 'end' }); return; }
    var frame = r.value;
    // 背压：只有主线程说"要"才付回读的钱。否则按流帧率一直算，等于把浪费从
    // 主线程搬到 worker，CPU 照样在烧。
    try { if (want) { want = 0; process(frame); } }
    catch (e) { self.postMessage({ type: 'fail', message: '' + (e && e.message || e) }); }
    finally { frame.close(); }
    loop();
  }).catch(function (e) {
    self.postMessage({ type: 'fail', message: '' + (e && e.message || e) });
  });
}

self.onmessage = function (e) {
  var m = e.data;
  if (m.type === 'start') {
    tw = m.tw || 384;
    // 必须 getReader()：ReadableStream 上没有 read()。直接调 read() 的异常发生
    // 在 worker 里，主线程只会永远等不到帧，表现为"跟踪不动"而不是报错。
    try {
      reader = m.stream.getReader();
      want = 1;
      loop();
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'fail', message: '' + (err && err.message || err) });
    }
  } else if (m.type === 'want') {
    want = 1;
  }
};
