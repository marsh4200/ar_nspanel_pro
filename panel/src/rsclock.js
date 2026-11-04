// Residence clock screens: what a Residence panel shows while it sleeps, when a
// design other than "classic" is picked (Settings > Look > Designs, or Device
// Setup). Built by app.js in place of the plain clock; app.js calls update()
// every second. Everything moves with CSS animations on transform / opacity;
// the only work per second is the time text, and once a minute the digits.
//
//   glow   big thin clock, a warm light breathing behind it, weather by the date
//   sun    the sun (or the moon at night) on an arc from sunrise to sunset
//   halo   a ring with a light running round it once a minute
//   moon   tonight's real moon (worked out here), twinkling stars
//   edit   huge outlined day number, the time, weather / next event / alarm
//   photo  the Residence background slowly drifting, time bottom-left
//   flip   split-flap cards
//   sky    real-looking clouds drifting, the sky colour follows the day
//
// The whole clock drifts a few pixels every 20 s so nothing burns in. The stage
// is 1000 wide and as tall as the screen's shape (600 on 5:3, 1000 square), scaled.

const p2 = (n) => (n < 10 ? "0" : "") + n;

function fmt(d, lang, o) {
  try {
    return d.toLocaleDateString(lang, o);
  } catch (e) {
    return d.toDateString();
  }
}

// --- sun and moon ------------------------------------------------------------
// sunrise / sunset in minutes after local midnight (NOAA's simple formula)
function sunTimes(d, lat, lon) {
  const rad = Math.PI / 180;
  const start = new Date(d.getFullYear(), 0, 0);
  const doy = Math.floor((d - start) / 864e5);
  const g = ((2 * Math.PI) / 365) * (doy - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(dec)) - Math.tan(lat * rad) * Math.tan(dec);
  if (cosH > 1 || cosH < -1) return null;
  const ha = Math.acos(cosH) / rad;
  const tz = -d.getTimezoneOffset();
  return [720 - 4 * (lon + ha) - eq + tz, 720 - 4 * (lon - ha) - eq + tz];
}
function moonPhase(d) {
  const syn = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  let p = ((d.getTime() - ref) / 864e5 / syn) % 1;
  return p < 0 ? p + 1 : p;
}
const PHASES = ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous", "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"];
function moonSvg(p, south) {
  const r = 110;
  const k = Math.cos(p * 2 * Math.PI);
  const waxing = p < 0.5;
  const rx = Math.max(0.5, Math.abs(k) * r);
  // the outer edge along the lit side, back along the terminator
  const side = waxing ? 1 : 0;
  const term = waxing ? (k > 0 ? 0 : 1) : k > 0 ? 1 : 0;
  const d = "M150 40 A110 110 0 0 " + side + " 150 260 A" + rx.toFixed(1) + " 110 0 0 " + term + " 150 40Z";
  return (
    '<svg class="rsk-msvg" viewBox="0 0 300 300"><defs><radialGradient id="rskmg"><stop offset=".55" stop-color="#cfd8ff" stop-opacity=".35"/><stop offset="1" stop-color="#cfd8ff" stop-opacity="0"/></radialGradient>' +
    '<radialGradient id="rskms" cx="40%" cy="38%"><stop offset="0" stop-color="#fbfaf4"/><stop offset=".7" stop-color="#dcdbd2"/><stop offset="1" stop-color="#b9b8b0"/></radialGradient></defs>' +
    '<circle class="rsk-mglow" cx="150" cy="150" r="150" fill="url(#rskmg)"/><circle cx="150" cy="150" r="110" fill="#1a2030"/>' +
    '<path d="' + d + '" fill="url(#rskms)"' + (south ? ' transform="matrix(-1 0 0 1 300 0)"' : "") + "/>" +
    '<g fill="#000" opacity=".08"><circle cx="118" cy="112" r="16"/><circle cx="170" cy="96" r="9"/><circle cx="182" cy="168" r="20"/><circle cx="128" cy="186" r="11"/><circle cx="150" cy="140" r="6"/></g></svg>'
  );
}

// --- weather glyph -------------------------------------------------------------
function wxIcon(night, cond) {
  const cloudy = /cloud|fog|rain|pour|snow|light/.test(cond || "");
  if (night) return '<svg viewBox="0 0 34 34"><path d="M21 5a11 11 0 1 0 9 15A9 9 0 0 1 21 5z" fill="#e9ecf5" opacity=".9"/><g class="rsk-cloud"><path d="M9 27h15a5 5 0 0 0 0-10 7 7 0 0 0-13 2 4 4 0 0 0-2 8z" fill="#9ba3b5" opacity=".75"/></g></svg>';
  let r = "";
  for (let i = 0; i < 8; i++) r += '<line x1="17" y1="2" x2="17" y2="6.5" transform="rotate(' + i * 45 + ' 17 17)"/>';
  return '<svg viewBox="0 0 34 34"><g class="rsk-rays" stroke="#ffce78" stroke-width="2.2" stroke-linecap="round">' + r + '</g><circle cx="17" cy="17" r="7" fill="#ffd27a"/>' + (cloudy ? '<g class="rsk-cloud"><path d="M10 29h15a5 5 0 0 0 0-10 7 7 0 0 0-13 2 4 4 0 0 0-2 8z" fill="#dfe4ee"/></g>' : "") + "</svg>";
}

// --- clouds (made once, then only slid sideways) ---------------------------------
function cloudSvg(fx, fy, seed, oct, cut, gain) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600"><defs><filter id="c" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">' +
    '<feTurbulence type="fractalNoise" baseFrequency="' + fx + " " + fy + '" numOctaves="' + oct + '" seed="' + seed + '" stitchTiles="stitch" result="n"/>' +
    '<feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  ' + gain + " 0 0 0 " + -cut * gain + '" result="a0"/>' +
    '<feGaussianBlur in="a0" stdDeviation="2" result="a"/><feFlood flood-color="#ffffff" result="w"/><feComposite in="w" in2="a" operator="in" result="white"/>' +
    '<feOffset in="a" dy="-18" result="up"/><feComposite in="a" in2="up" operator="arithmetic" k2="1" k3="-0.85" result="belly"/><feGaussianBlur in="belly" stdDeviation="9" result="bb"/>' +
    '<feFlood flood-color="#7f8fa8" flood-opacity=".75"/><feComposite in2="bb" operator="in" result="gs"/><feComposite in="gs" in2="a" operator="in" result="gsi"/>' +
    '<feMerge><feMergeNode in="white"/><feMergeNode in="gsi"/></feMerge></filter>' +
    '<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".7" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><mask id="m"><rect width="100%" height="100%" fill="url(#f)"/></mask></defs>' +
    '<rect width="100%" height="100%" filter="url(#c)" mask="url(#m)"/></svg>'
  );
}
let CLOUDS = null;
const cloudUrls = () =>
  CLOUDS ||
  (CLOUDS = [cloudSvg(0.0025, 0.0065, 7, 5, 0.55, 3), cloudSvg(0.0017, 0.0048, 3, 6, 0.56, 3.4)].map((s) => 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s) + '")'));
// the sky through the day: [hour, top, horizon, cloud filter, sun glare, stars]
const SKY = [
  [0, "#04070f", "#0d1630", "brightness(.22) saturate(.6)", 0, 1],
  [4.6, "#0a0f26", "#2a2446", "brightness(.3) saturate(.7)", 0, 0.8],
  [5.4, "#1f2a5c", "#e39a7c", "brightness(.85) sepia(.45) saturate(1.8) hue-rotate(-18deg)", 0.35, 0.15],
  [6.6, "#3c74c2", "#f6d3ac", "brightness(1) sepia(.2) saturate(1.3)", 0.6, 0],
  [9, "#2c6fd2", "#a6cdf1", "none", 0.8, 0],
  [13, "#2467d3", "#aed3f4", "none", 0.9, 0],
  [16.4, "#3a6cc0", "#f2cf98", "sepia(.25) saturate(1.3)", 0.75, 0],
  [18.2, "#3a3a7c", "#f39470", "brightness(.92) sepia(.55) saturate(2) hue-rotate(-24deg)", 0.5, 0],
  [19.2, "#1d1f4c", "#7b507e", "brightness(.6) sepia(.35) saturate(1.4) hue-rotate(-40deg)", 0.15, 0.3],
  [20.6, "#070b1d", "#18203f", "brightness(.28) saturate(.6)", 0, 1],
  [24, "#04070f", "#0d1630", "brightness(.22) saturate(.6)", 0, 1],
];
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixC = (a, b, f) => {
  const x = hex(a);
  const y = hex(b);
  return "rgb(" + x.map((v, i) => Math.round(v + (y[i] - v) * f)).join(",") + ")";
};

function stars(n, W, H) {
  let s = "";
  for (let i = 0; i < n; i++) {
    const big = Math.random() < 0.2;
    s += '<i class="rsk-star" style="left:' + Math.round(Math.random() * W) + "px;top:" + Math.round(Math.random() * H) + "px;-webkit-animation-delay:-" + (Math.random() * 4).toFixed(1) + "s;animation-delay:-" + (Math.random() * 4).toFixed(1) + "s;-webkit-animation-duration:" + (3 + Math.random() * 4).toFixed(1) + "s;animation-duration:" + (3 + Math.random() * 4).toFixed(1) + "s" + (big ? ";width:3px;height:3px" : "") + '"></i>';
  }
  return s;
}

/**
 * @param dev device config (clockFormat24h, clockLanguage)
 * @param design one of the designs above
 * @param info () => {t, cond, hi, lo, geo:[lat,lon], photo, event:[title,"19:30"]}
 * @param opts {alarm: () => {enabled, hour, minute}, lite: bool}
 */
export function rsClockView(dev, design, info, opts) {
  const h24 = dev.clockFormat24h !== false;
  const lang = dev.clockLanguage || "en-GB";
  const W = 1000;
  let H = 600;
  let tall = false;
  const root = document.createElement("div");
  root.className = "rsk rsk-" + design + (opts && opts.lite ? " lite" : "");
  const stage = document.createElement("div");
  stage.className = "rsk-stage";
  root.appendChild(stage);
  const drift = document.createElement("div");
  drift.className = "rsk-drift";
  stage.appendChild(drift);
  // the stage is 1000 wide and as tall as the screen's shape; it is measured
  // once the clock is on screen (the panel UI itself is scaled to the screen)
  let sized = "";
  function fit() {
    const sw = root.clientWidth;
    const sh = root.clientHeight;
    if (!sw || !sh) return false;
    const k = sw + "x" + sh;
    if (k === sized) return true;
    sized = k;
    H = Math.round((W * sh) / sw);
    tall = H > 760;
    root.classList.toggle("tall", tall);
    stage.style.width = W + "px";
    stage.style.height = H + "px";
    stage.style.webkitTransform = stage.style.transform = "scale(" + sw / W + ")";
    build();
    return true;
  }
  const I = () => {
    try {
      return (info && info()) || {};
    } catch (e) {
      return {};
    }
  };
  const timeStr = (d) => {
    let h = d.getHours();
    if (!h24) h = h % 12 || 12;
    return (h24 ? p2(h) : String(h)) + ":" + p2(d.getMinutes());
  };
  const ampm = (d) => (h24 ? "" : '<span class="rsk-ap">' + (d.getHours() < 12 ? "AM" : "PM") + "</span>");
  const sun = (d, g) => {
    const geo = g || [-26.2, 28.05];
    return sunTimes(d, geo[0], geo[1]) || [360, 1110];
  };
  const isNight = (d, g) => {
    const m = d.getHours() * 60 + d.getMinutes();
    const s = sun(d, g);
    return m < s[0] || m >= s[1];
  };
  const digits = (s) =>
    s
      .split("")
      .map((c) => (c === ":" ? '<span class="rsk-colon">:</span>' : '<span class="rsk-dig" data-c="' + c + '"><i>' + c + "</i></span>"))
      .join("");
  const tmp = (x) => (typeof x.t === "number" ? x.t + "°" : "");
  const alarm = () => {
    const al = opts && opts.alarm ? opts.alarm() : null;
    return al && al.enabled ? p2(al.hour) + ":" + p2(al.minute) : "";
  };
  const hm = (m) => p2(Math.floor((((m % 1440) + 1440) % 1440) / 60)) + ":" + p2(Math.floor((((m % 1440) + 1440) % 1440) % 60));

  let tEl = null;
  let last = "";
  let lastDay = "";
  let lastSky = 0;
  let dr = 0;
  let lastDrift = Date.now();

  function build() {
    const d = new Date();
    const x = I();
    const t = timeStr(d);
    const night = isNight(d, x.geo);
    const dateL = fmt(d, lang, { weekday: "long", day: "numeric", month: "long" });
    const wx = '<span class="rsk-wx">' + wxIcon(night, x.cond) + tmp(x) + "</span>";
    let h = "";
    if (design === "glow") {
      const al = alarm();
      h = '<div class="rsk-c"><div class="rsk-t">' + digits(t) + ampm(d) + '</div><div class="rsk-row">' + (tmp(x) ? wx + '<span class="rsk-sep"></span>' : "") + '<span class="rsk-acc"></span></div><div class="rsk-hair"></div>' + (al ? '<div class="rsk-al">Alarm ' + al + "</div>" : "") + "</div>";
    } else if (design === "sun") {
      const s = sun(d, x.geo);
      const m = d.getHours() * 60 + d.getMinutes();
      let f;
      if (!night) f = (m - s[0]) / (s[1] - s[0]);
      else f = ((m - s[1] + 1440) % 1440) / (1440 - s[1] + s[0]);
      const col = night ? "214,222,255" : "255,206,120";
      const cy = Math.round(H * 0.42);
      const cx = 500;
      const rx = 410;
      const ry = Math.min(190, cy - 50);
      const a = Math.PI * (1 - f);
      const px = cx + rx * Math.cos(a);
      const py = cy - ry * Math.sin(a);
      const arc = "M" + (cx - rx) + " " + cy + " A" + rx + " " + ry + " 0 0 1 " + (cx + rx) + " " + cy;
      h =
        '<svg class="rsk-arc" width="1000" height="' + H + '" viewBox="0 0 1000 ' + H + '"><defs><radialGradient id="rsksg"><stop offset="0" stop-color="rgb(' + col + ')" stop-opacity=".9"/><stop offset=".35" stop-color="rgb(' + col + ')" stop-opacity=".3"/><stop offset="1" stop-color="rgb(' + col + ')" stop-opacity="0"/></radialGradient><clipPath id="rskcp"><rect x="0" y="0" width="' + px.toFixed(0) + '" height="' + H + '"/></clipPath></defs>' +
        '<line x1="60" y1="' + cy + '" x2="940" y2="' + cy + '" stroke="rgba(255,255,255,.12)"/>' +
        '<path d="' + arc + '" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="1.5" stroke-dasharray="2 7" stroke-linecap="round"/>' +
        '<path d="' + arc + '" fill="none" stroke="rgba(' + col + ',.75)" stroke-width="2" clip-path="url(#rskcp)"/>' +
        '<circle class="rsk-pulse" cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="70" fill="url(#rsksg)"/>' +
        '<circle cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="' + (night ? 12 : 14) + '" fill="' + (night ? "#e9edf8" : "#ffe0a0") + '"/></svg>' +
        '<div class="rsk-sunt" style="top:' + cy + 'px"><div class="rsk-t">' + digits(t) + ampm(d) + '</div><div class="rsk-d rsk-acc"></div><div class="rsk-ends"><span>↑ ' + hm(s[0]) + "</span><span>" + (tmp(x) ? wx : "") + "</span><span>↓ " + hm(s[1]) + "</span></div></div>";
    } else if (design === "halo") {
      const D = Math.min(500, H - 80);
      let ticks = "";
      for (let i = 0; i < 12; i++) ticks += '<line x1="250" y1="14" x2="250" y2="' + (i % 3 ? 22 : 30) + '" transform="rotate(' + i * 30 + ' 250 250)" stroke="rgba(255,255,255,' + (i % 3 ? ".25" : ".55") + ')" stroke-width="2" stroke-linecap="round"/>';
      const delay = -(d.getSeconds() + d.getMilliseconds() / 1000);
      h =
        '<div class="rsk-c"><svg class="rsk-ring" style="width:' + D + "px;height:" + D + "px;margin-left:-" + D / 2 + "px;margin-top:-" + D / 2 + 'px" viewBox="0 0 500 500">' +
        '<circle cx="250" cy="250" r="232" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="2"/>' + ticks +
        '<g class="rsk-comet" style="-webkit-animation-delay:' + delay + "s;animation-delay:" + delay + 's"><path d="M250 18 A232 232 0 0 1 430 104" fill="none" stroke="rgba(255,226,180,.55)" stroke-width="5" stroke-linecap="round" transform="rotate(-38 250 250)"/><circle cx="250" cy="18" r="7" fill="rgba(255,240,210,.5)"/><circle cx="250" cy="18" r="3.5" fill="#fff"/></g></svg>' +
        '<div class="rsk-t">' + digits(t) + ampm(d) + '</div><div class="rsk-d rsk-acc"></div>' + (tmp(x) ? '<div class="rsk-w">' + wx + "</div>" : "") + "</div>";
    } else if (design === "moon") {
      const p = moonPhase(d);
      const lit = Math.round(((1 - Math.cos(p * 2 * Math.PI)) / 2) * 100);
      const south = !!(x.geo && x.geo[0] < 0) || !x.geo;
      h =
        '<div class="rsk-sky0">' + stars(70, W, H) + '<i class="rsk-shoot"></i></div><div class="rsk-mrow">' + moonSvg(p, south) +
        '<div class="rsk-mtx"><div class="rsk-t">' + digits(t) + ampm(d) + '</div><div class="rsk-d rsk-acc"></div><div class="rsk-ph">' + PHASES[Math.round(p * 8) % 8] + " · " + lit + "% lit" + (tmp(x) ? " · " + tmp(x) : "") + "</div></div></div>";
    } else if (design === "edit") {
      const list = [];
      if (tmp(x)) list.push("<div><span>" + wx + "</span><small>" + (x.hi != null ? x.hi + "° / " + (x.lo != null ? x.lo + "°" : "") : "") + "</small></div>");
      if (x.event) list.push('<div><span class="rsk-ev"></span><span class="rsk-acc">' + x.event[1] + "</span></div>");
      const al = alarm();
      if (al) list.push('<div><span style="opacity:.7">Alarm</span><span>' + al + "</span></div>");
      h =
        '<div class="rsk-ed"><div class="rsk-edl"><div class="rsk-big">' + p2(d.getDate()) + '</div><div class="rsk-wk">' + fmt(d, lang, { weekday: "long" }) + '</div><div class="rsk-mo">' + fmt(d, lang, { month: "long", year: "numeric" }) + "</div></div>" +
        '<div class="rsk-edr"><div class="rsk-t">' + digits(t) + ampm(d) + '</div><div class="rsk-rule"></div><div class="rsk-list">' + list.join("") + "</div></div></div>";
    } else if (design === "photo") {
      h =
        '<div class="rsk-ph0"></div><div class="rsk-shade"></div><div class="rsk-pbox"><div class="rsk-t">' + digits(t) + ampm(d) + '</div><div class="rsk-d rsk-acc"></div></div>' +
        (tmp(x) ? '<div class="rsk-pw">' + wx + "<small>" + (x.hi != null ? x.hi + "° / " + (x.lo != null ? x.lo + "°" : "") : "") + "</small></div>" : "");
    } else if (design === "flip") {
      const c = t.replace(":", "").split("");
      while (c.length < 4) c.unshift(" ");
      const card = (ch) => '<div class="rsk-fl" data-c="' + ch + '"><div class="rsk-hf rsk-up"><span>' + ch + '</span></div><div class="rsk-hf rsk-dn"><span>' + ch + "</span></div></div>";
      h = '<div class="rsk-c"><div class="rsk-flips">' + card(c[0]) + card(c[1]) + '<div class="rsk-cn"><i></i><i></i></div>' + card(c[2]) + card(c[3]) + '</div><div class="rsk-d rsk-acc"></div></div>';
    } else {
      // sky
      h =
        '<div class="rsk-skyg"></div><div class="rsk-stars">' + stars(60, W, H) + '</div><div class="rsk-glare"></div><div class="rsk-cl far"></div><div class="rsk-cl near"></div>' +
        '<div class="rsk-c rsk-skyc"><div class="rsk-t">' + digits(t) + ampm(d) + '</div><div class="rsk-wd"></div><div class="rsk-d">' + fmt(d, lang, { day: "numeric", month: "long" }) + (tmp(x) ? " &nbsp;·&nbsp; " + wx : "") + "</div></div>";
    }
    drift.innerHTML = h;
    // text from Home Assistant goes in as text
    Array.prototype.forEach.call(drift.querySelectorAll(".rsk-acc:empty,.rsk-d:empty"), (e) => (e.textContent = dateL));
    const wd = drift.querySelector(".rsk-wd");
    if (wd) wd.textContent = fmt(d, lang, { weekday: "long" });
    const ev = drift.querySelector(".rsk-ev");
    if (ev && x.event) ev.textContent = x.event[0];
    if (design === "photo") {
      const ph = drift.querySelector(".rsk-ph0");
      if (x.photo) ph.style.backgroundImage = 'url("' + String(x.photo).replace(/"/g, "%22") + '")';
    }
    if (design === "sky") {
      const u = cloudUrls();
      drift.querySelector(".rsk-cl.far").style.backgroundImage = u[0];
      drift.querySelector(".rsk-cl.near").style.backgroundImage = u[1];
      paintSky(d);
    }
    tEl = drift.querySelector(".rsk-t");
    last = t;
    lastDay = dateL;
  }
  function paintSky(d) {
    const hr = d.getHours() + d.getMinutes() / 60;
    let i = 0;
    while (i < SKY.length - 2 && SKY[i + 1][0] <= hr) i++;
    const A = SKY[i];
    const B = SKY[i + 1];
    const f = Math.min(1, Math.max(0, (hr - A[0]) / (B[0] - A[0])));
    const g = drift.querySelector(".rsk-skyg");
    if (!g) return;
    g.style.background = "linear-gradient(180deg," + mixC(A[1], B[1], f) + "," + mixC(A[2], B[2], f) + ")";
    const cf = f < 0.5 ? A[3] : B[3];
    Array.prototype.forEach.call(drift.querySelectorAll(".rsk-cl"), (c) => (c.style.webkitFilter = c.style.filter = cf));
    drift.querySelector(".rsk-glare").style.opacity = (A[4] + (B[4] - A[4]) * f).toFixed(2);
    drift.querySelector(".rsk-stars").style.opacity = (A[5] + (B[5] - A[5]) * f).toFixed(2);
  }
  // the minute changed: digits roll up (flip cards flip); the arc / day move by rebuilding
  function rollTo(s) {
    const ds = tEl.querySelectorAll(".rsk-dig");
    const cs = s.replace(":", "").split("");
    if (ds.length !== cs.length) return build();
    Array.prototype.forEach.call(ds, (dg, i) => {
      if (dg.getAttribute("data-c") === cs[i]) return;
      const old = dg.getAttribute("data-c");
      dg.setAttribute("data-c", cs[i]);
      dg.innerHTML = "<i>" + old + "</i><i>" + cs[i] + "</i>";
      setTimeout(() => dg.classList.add("roll"), 30);
      setTimeout(() => {
        dg.classList.remove("roll");
        dg.innerHTML = "<i>" + cs[i] + "</i>";
      }, 800);
    });
    const ap = tEl.querySelector(".rsk-ap");
    if (ap) ap.textContent = new Date().getHours() < 12 ? "AM" : "PM";
  }
  function flipTo(s) {
    const cs = s.replace(":", "").split("");
    while (cs.length < 4) cs.unshift(" ");
    Array.prototype.forEach.call(drift.querySelectorAll(".rsk-fl"), (f, i) => {
      const old = f.getAttribute("data-c");
      const nw = cs[i];
      if (old === nw) return;
      f.setAttribute("data-c", nw);
      f.querySelector(".rsk-up span").textContent = nw;
      const flap = document.createElement("div");
      flap.className = "rsk-flap";
      flap.innerHTML = "<span></span>";
      flap.firstChild.textContent = old;
      f.appendChild(flap);
      setTimeout(() => flap.classList.add("go"), 30);
      setTimeout(() => {
        f.querySelector(".rsk-dn span").textContent = nw;
        if (flap.parentNode) flap.parentNode.removeChild(flap);
      }, 680);
    });
  }
  function update() {
    if (!fit()) return;
    const d = new Date();
    const t = timeStr(d);
    const day = fmt(d, lang, { weekday: "long", day: "numeric", month: "long" });
    if (day !== lastDay || (design === "sun" && t !== last)) {
      build();
    } else if (t !== last) {
      last = t;
      if (design === "flip") flipTo(t);
      else if (tEl) rollTo(t);
    }
    if (design === "sky" && Date.now() - lastSky > 30000) {
      lastSky = Date.now();
      paintSky(d);
    }
    // screen care: move the whole clock a few pixels every 20 s
    if (Date.now() - lastDrift > 20000) {
      lastDrift = Date.now();
      dr++;
      const tx = Math.round(Math.sin(dr * 1.7) * 10);
      const ty = Math.round(Math.cos(dr * 1.3) * 8);
      drift.style.webkitTransform = drift.style.transform = "translate(" + tx + "px," + ty + "px)";
    }
  }
  build();
  (window.requestAnimationFrame || ((f) => setTimeout(f, 16)))(() => fit());
  return { el: root, update };
}
