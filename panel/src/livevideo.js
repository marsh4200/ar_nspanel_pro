// Live camera video from Home Assistant's HLS stream (the same stream HA's own
// dashboard plays). hls.js (served next to index.html as hls.light.min.js) is
// loaded on first use; WebViews that play HLS natively use the <video> tag
// directly. Calls onFail() if neither works, so the caller can fall back to the
// MJPEG snapshot stream.

let hlsLoading = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoading) {
    hlsLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "hls.light.min.js";
      s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error("hls.js did not load")));
      s.onerror = () => {
        hlsLoading = null;
        reject(new Error("hls.js missing"));
      };
      document.head.appendChild(s);
    });
  }
  return hlsLoading;
}

/** Play `url` in `video`. Returns stop(). */
export function playHls(video, url, onFail) {
  let hls = null;
  let stopped = false;
  let failed = false;
  const fail = (why) => {
    if (failed || stopped) return;
    failed = true;
    if (window.console) console.log("[panel] live video failed:", why);
    stop();
    if (onFail) onFail(why);
  };
  // Android WebView draws a grey "broken play" icon on a <video> with no
  // picture yet; a transparent poster hides it (the snapshot shows through).
  video.poster = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  video.muted = true;
  video.autoplay = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  const start = () => {
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
  };
  loadHls()
    .then((Hls) => {
      if (stopped) return;
      if (Hls.isSupported()) {
        hls = new Hls({ lowLatencyMode: true, backBufferLength: 8, liveDurationInfinity: true, maxLiveSyncPlaybackRate: 1.5 });
        let recovers = 0;
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d || !d.fatal) return;
          // a codec the WebView can't decode (e.g. H.265) fails again and
          // again: retry twice, then give up so the snapshot takes over
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR && recovers++ < 2) hls.recoverMediaError();
          else fail(d.details || d.type);
        });
        video.onerror = () => fail("video error");
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, start);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        video.onerror = () => fail("native HLS error");
        start();
      } else fail("no HLS support");
    })
    .catch(() => {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        video.onerror = () => fail("native HLS error");
        start();
      } else fail("no HLS support");
    });
  // a live stream that never produces a frame is as good as broken
  const watchdog = setTimeout(() => {
    if (!stopped && video.readyState < 2) fail("no picture after 15 s");
  }, 15000);
  function stop() {
    stopped = true;
    clearTimeout(watchdog);
    try {
      if (hls) hls.destroy();
    } catch (e) {
      /* ignore */
    }
    hls = null;
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch (e) {
      /* ignore */
    }
  }
  return stop;
}
