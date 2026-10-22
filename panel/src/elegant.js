// Elegant dashboard: a keypad-style home screen with category buttons,
// separate pages and a Home dock — no swiping. Chosen per panel with
// device.dashboardStyle = "elegant"; the Classic pages are untouched.
//
// Config (device.elegant): { title, weather?, lights[], climate[], music[],
// cameras[], security (alarm entity), shades[], scenes[] } — entity ids.
// Home Assistant mirrors each entity on state/<slug> (richer "elegant"
// payload) and runs the panel's controls, sent as events on button "el":
//   {action, value: {entity, v?, mode?, cmd?, code?}}
//
// Laid out on a 1000-wide canvas scaled to the panel's 480-wide stage, so it
// looks the same on a Source 10 (5:3) and adapts on taller screens.

import { slugify } from "./util.js";
import { playHls } from "./livevideo.js";
import * as native from "./native.js";

const W = 1000;
const ICON = {
  home: '<path d="m3 11 9-8 9 8M5 10v10h5v-6h4v6h5V10"/>',
  lights: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  climate: '<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  cameras: '<path d="m16 13 5.2 3.1a.5.5 0 0 0 .8-.4V8.3a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  security: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  shades: '<path d="M3 3h18M5 3v15h14V3M5 8h14M5 13h14M12 18v3"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  backsp: '<path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z"/><path d="m12 9 6 6M18 9l-6 6"/>',
  sun: '<path d="M12 2v2M4.9 4.9l1.4 1.4M2 12h2M19.1 4.9l-1.4 1.4"/><path d="M17.5 19H9a5 5 0 1 1 4.6-7"/><path d="M17.5 19a3.5 3.5 0 0 0 0-7h-1.3"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  cool: '<path d="M12 2v20M4 6l16 12M20 6 4 18"/>',
  heat: '<path d="M12 2c2 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-5 3-7 1 2 3 3 3 3s0-4 0-7z"/>',
  auto: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  dry: '<path d="M12 2.7 6.3 9a7 7 0 1 0 11.4 0z"/>',
  fan: '<path d="M12 12c-3-4-1-9 2-9s3 4-2 9zM12 12c4-3 9-1 9 2s-4 3-9-2zM12 12c3 4 1 9-2 9s-3-4 2-9zM12 12c-4 3-9 1-9-2s4-3 9 2z"/>',
  off: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  vol: '<path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  speaker: '<rect x="6" y="2" width="12" height="20" rx="2"/><circle cx="12" cy="14" r="3"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  moon: '<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  house: '<path d="m3 11 9-8 9 8M5 10v10h14V10"/>',
  sofa: '<path d="M4 11V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3"/><path d="M2 13a2 2 0 0 1 4 0v2h12v-2a2 2 0 0 1 4 0v5H2z"/>',
  pot: '<path d="M3 10h18M5 10v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8M9 6c0-1 1-2 1-3M13 6c0-1 1-2 1-3"/>',
  bed: '<path d="M2 18V6M2 14h20v4M22 18v-4a3 3 0 0 0-3-3H10v3"/><circle cx="6" cy="11" r="2"/>',
  star: '<path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>',
  bath: '<path d="M4 12h16v3a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM6 12V5a2 2 0 0 1 4 0"/>',
  desk: '<path d="M3 7h18M5 7v12M19 7v12M5 12h6"/>',
  tree: '<path d="M12 22v-6M8 16h8l-4-6 3 0-3-5-3 5 3 0z"/>',
  car: '<path d="M5 17h14M6 17v2M18 17v2M4 13l2-6h12l2 6v4H4z"/>',
};
const FILLED = {
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>',
  prev: '<path d="M6 6h2v12H6zM20 6v12l-9-6z"/>',
  next: '<path d="M16 6h2v12h-2zM4 6l9 6-9 6z"/>',
};
function svg(name, cls) {
  if (FILLED[name]) return '<svg class="' + (cls || "") + '" viewBox="0 0 24 24" fill="currentColor">' + FILLED[name] + "</svg>";
  return '<svg class="' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICON[name] || "") + "</svg>";
}
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function txt(tag, cls, text) {
  const e = el(tag, cls);
  e.textContent = text == null ? "" : String(text);
  return e;
}
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).filter((x) => typeof x === "string" && x.indexOf(".") > 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const WX = { "clear-night": "Clear", cloudy: "Cloudy", exceptional: "Severe weather", fog: "Fog", hail: "Hail", lightning: "Thunderstorms",
  "lightning-rainy": "Thunderstorms", partlycloudy: "Partly cloudy", pouring: "Heavy rain", rainy: "Rain", snowy: "Snow",
  "snowy-rainy": "Sleet", sunny: "Sunny", windy: "Windy", "windy-variant": "Windy" };
const CATS = [
  { key: "lights", title: "Lights" },
  { key: "climate", title: "Climate" },
  { key: "music", title: "Music" },
  { key: "cameras", title: "Cameras" },
  { key: "security", title: "Security" },
  { key: "shades", title: "Shades" },
];
const MODE_ICON = { cool: "cool", heat: "heat", heat_cool: "auto", auto: "auto", dry: "dry", fan_only: "fan", off: "off" };
const MODE_NAME = { cool: "Cool", heat: "Heat", heat_cool: "Heat/Cool", auto: "Auto", dry: "Dry", fan_only: "Fan", off: "Off" };

export function buildElegant(cfg, ctx) {
  cfg = cfg || {};
  // Music Assistant (Device tab): when set up, the Music page uses its
  // speakers, playlists and radio instead of (or as well as) HA media players.
  const maCfg = (ctx.device && ctx.device().musicAssistant) || {};
  const ma = ctx.ma ? ctx.ma() : null;
  const maOn = !!(ma && maCfg.url && maCfg.enabled !== false);
  // Spotify (Device Setup > Music): through Home Assistant's Spotify integration
  const sp = ctx.spotify ? ctx.spotify() : null;
  const spCfg = (ctx.device && ctx.device().spotify) || {};
  const spOn = !!(sp && spCfg.enabled);
  let musicSrc = maOn && spCfg.start !== "spotify" ? "ma" : "sp";
  const useSP = () => spOn && (musicSrc === "sp" || !maOn);
  // Rooms: cfg.rooms = [{name, icon, lights, climate, music, shades, scenes}],
  // cfg.start (index), cfg.wholeHouse. Cameras + security are house-wide. An
  // older single-room config (categories at the top level) becomes one room.
  const ROOM_KEYS = ["lights", "climate", "music", "shades", "scenes"];
  let ROOMS = (Array.isArray(cfg.rooms) ? cfg.rooms : []).filter((r) => r && typeof r === "object");
  if (!ROOMS.length) {
    const r0 = { name: cfg.title || "", icon: "sofa" };
    ROOM_KEYS.forEach((k) => (r0[k] = cfg[k]));
    ROOMS = [r0];
  }
  ROOMS = ROOMS.map((r) => {
    const o = { name: r.name || "", icon: r.icon || "sofa" };
    ROOM_KEYS.forEach((k) => (o[k] = list(r[k])));
    return o;
  });
  // RTSP cameras (cfg.rtsp = [{name, url}]): played by the Android app straight
  // from the camera, next to (or instead of) HA camera entities; 4 in total
  const RTSP = (Array.isArray(cfg.rtsp) ? cfg.rtsp : []).filter((c) => c && typeof c.url === "string" && c.url);
  const isRtsp = (e) => typeof e === "string" && e.indexOf("rtsp:") === 0;
  const rtspCam = (e) => RTSP[Number(e.slice(5))] || {};
  const house = { cameras: list(cfg.cameras).concat(RTSP.map((c, i) => "rtsp:" + i)).slice(0, 4), security: list(cfg.security) };
  const wholeOn = cfg.wholeHouse !== false && ROOMS.length > 1;
  const uniq = (a) => a.filter((x, i) => a.indexOf(x) === i);
  const union = {};
  ROOM_KEYS.forEach((k) => (union[k] = uniq([].concat.apply([], ROOMS.map((r) => r[k])))));
  // pages exist for anything any room uses; the dock shows what this room has
  const ents = {};
  CATS.forEach((c) => (ents[c.key] = c.key === "cameras" || c.key === "security" ? house[c.key] : union[c.key]));
  let scenes = [];
  let roomIdx = clamp(typeof cfg.start === "number" ? cfg.start : 0, 0, ROOMS.length - 1);
  let whole = false;
  const lightRoom = {};
  ROOMS.forEach((r) => r.lights.forEach((e) => (lightRoom[e] = r.name)));
  const keys = ["weather"];
  Object.keys(ents).forEach((k) => ents[k].forEach((e) => keys.push(slugify(e))));
  union.scenes.forEach((e) => keys.push(slugify(e)));
  function curCats() {
    return CATS.filter((c) => (ents[c.key] && ents[c.key].length) || (c.key === "music" && (maOn || spOn)));
  }

  const page = el("div", "page page-elegant");
  // Light mode for weak panels: an old web engine (Chrome < 76, e.g. the HDL
  // Source 7's Chrome 61 on a Rockchip PX30) means a slow chip. Fades, glows and
  // blur are switched off there and redraws are batched a little longer.
  // HDL Source 7 only: old web engine AND its 1280x720 screen. Every other
  // panel (the Source 10, the NSPanel Pro) keeps the full look and behaviour.
  const cv = /Chrome\/(\d+)/.exec(navigator.userAgent || "");
  const scr = window.screen || {};
  const LITE = !!(cv && Number(cv[1]) < 76) && Math.max(scr.width || 0, scr.height || 0) === 1280 && Math.min(scr.width || 0, scr.height || 0) === 720;
  const root = el("div", "el-root" + (LITE ? " lite" : ""));
  page.appendChild(root);
  const room = el("div", "el-room");
  root.appendChild(room);

  const get = (e) => ctx.get(slugify(e)) || {};
  const nameOf = (e) => (isRtsp(e) ? rtspCam(e).name || "Camera" : get(e).name || e.split(".")[1].replace(/_/g, " "));
  const send = (action, value) => ctx.event("el", action, { value: value });
  function patch(e, p) {
    ctx.optimistic(slugify(e), p);
  }

  // --- top bar + toast + dock ---------------------------------------------------
  const top = el("div", "el-top");
  const title = txt("div", "el-title", "Home");
  const sub = el("div", "el-roomname");
  const status = el("div", "el-status");
  const wxChip = el("span", "el-chip");
  const secChip = el("span", "el-chip");
  const clock = txt("span", "el-clock", "");
  status.appendChild(wxChip);
  status.appendChild(secChip);
  status.appendChild(clock);
  top.appendChild(title);
  top.appendChild(sub);
  sub.addEventListener("click", () => {
    if (ROOMS.length > 1 || wholeOn) openRooms();
  });
  top.appendChild(el("div", "el-sp"));
  top.appendChild(status);
  root.appendChild(top);
  const toastEl = el("div", "el-toast");
  root.appendChild(toastEl);
  let toastT = null;
  function toast(m) {
    toastEl.textContent = m;
    toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove("show"), 1600);
  }

  const pages = {};
  const dock = el("div", "el-dock");
  function buildDock() {
    dock.innerHTML = "";
    [{ key: "home", title: "Home" }].concat(curCats()).forEach((c) => {
      const b = el("div", "el-dockbtn", svg(c.key === "home" ? "home" : c.key) + "<span></span>");
      b.lastChild.textContent = c.title;
      b.setAttribute("data-go", c.key);
      b.addEventListener("click", () => go(c.key));
      dock.appendChild(b);
    });
  }

  // --- pages ---------------------------------------------------------------------
  function mkPage(key) {
    const p = el("div", "el-page");
    pages[key] = { el: p, render: () => {} };
    root.appendChild(p);
    return pages[key];
  }

  // home
  const home = mkPage("home");
  home.render = function () {
    const p = home.el;
    p.innerHTML = "";
    const grid = el("div", "el-home");
    const hero = el("div", "el-glass el-hero");
    const d = new Date();
    hero.appendChild(txt("div", "el-big", pad(d.getHours()) + ":" + pad(d.getMinutes())));
    let ds = "";
    try {
      ds = d.toLocaleDateString(ctx.device().clockLanguage || "en-GB", { weekday: "long", day: "numeric", month: "long" });
    } catch (e) {
      ds = d.toDateString();
    }
    hero.appendChild(txt("div", "el-date", ds));
    const w = ctx.get("weather");
    if (w && w.value) {
      const wx = el("div", "el-wx", svg("sun", "el-wxic") + '<div><div class="el-wxt"></div><div class="el-wxd"></div></div>');
      wx.querySelector(".el-wxt").textContent = typeof w.temperature === "number" ? Math.round(w.temperature) + "°" : "—";
      const f = Array.isArray(w.forecast) && w.forecast[0];
      wx.querySelector(".el-wxd").textContent = (WX[w.value] || cap(w.value)) + (f && typeof f.temperature === "number" ? " · High " + Math.round(f.temperature) + "°" + (typeof f.templow === "number" ? " · Low " + Math.round(f.templow) + "°" : "") : "");
      hero.appendChild(wx);
    }
    if (scenes.length) {
      const row = el("div", "el-scenes");
      scenes.forEach((s) => {
        const b = txt("div", "el-scene", nameOf(s));
        b.addEventListener("click", () => {
          send("toggle", { entity: s });
          toast(nameOf(s));
        });
        row.appendChild(b);
      });
      hero.appendChild(row);
    }
    grid.appendChild(hero);
    const cc = curCats();
    const tiles = el("div", "el-tiles n" + Math.min(6, cc.length));
    cc.forEach((c) => {
      const t = el("div", "el-glass el-tile", '<span class="el-glow"></span>' + svg("chev", "el-arrow") + '<span class="el-ic">' + svg(c.key) + '</span><div class="el-name"></div><div class="el-sub"></div>');
      t.querySelector(".el-name").textContent = c.title;
      const s = summary(c.key);
      t.querySelector(".el-sub").textContent = s.text;
      if (s.lit) t.classList.add("lit");
      t.addEventListener("click", () => go(c.key));
      tiles.appendChild(t);
    });
    grid.appendChild(tiles);
    p.appendChild(grid);
  };

  function summary(key) {
    const es = ents[key] || [];
    if (key === "lights") {
      const n = es.filter((e) => get(e).on).length;
      return { text: n ? n + " on" : "All off", lit: n > 0 };
    }
    if (key === "climate") {
      const c = get(es[0]);
      if (!c.value || c.value === "off") return { text: "Off" };
      return { text: (MODE_NAME[c.value] || cap(c.value)) + (typeof c.temp === "number" ? " · " + fmtT(c.temp) + "°" : ""), lit: false };
    }
    if (key === "music" && useSP() && sp.player) {
      const it = sp.player.item;
      return sp.player.is_playing && it ? { text: "Spotify · " + it.name, lit: true } : { text: "Spotify" };
    }
    if (key === "music" && maOn && ma.status === "ready") {
      const pl = ma.list().filter((x) => (x.playback_state || x.state) === "playing")[0];
      return pl ? { text: "Playing" + (pl.current_media && pl.current_media.title ? " · " + pl.current_media.title : " · " + (pl.display_name || pl.name)), lit: true } : { text: "Not playing" };
    }
    if (key === "music") {
      const m = es.map(get).filter((x) => x.value === "playing")[0];
      return m ? { text: "Playing" + (m.title ? " · " + m.title : ""), lit: true } : { text: "Not playing" };
    }
    if (key === "cameras") return { text: es.length + (es.length === 1 ? " camera" : " cameras") };
    if (key === "security") return { text: alarmName(get(es[0]).value) };
    if (key === "shades") {
      const n = es.filter((e) => get(e).on).length;
      return { text: n ? n + " open" : "All closed" };
    }
    return { text: "" };
  }

  // lights
  let selLight = 0;
  let dragging = false;
  if (ents.lights) {
    const lp = mkPage("lights");
    lp.render = function () {
      if (dragging) return;
      const p = lp.el;
      p.innerHTML = "";
      const bar = el("div", "el-subbar");
      bar.appendChild(el("div", "el-sp"));
      const off = txt("div", "el-act", "All off");
      off.addEventListener("click", () => {
        ents.lights.forEach((e) => {
          if (get(e).on) {
            patch(e, { on: false });
            send("dim", { entity: e, v: 0 });
          }
        });
        lp.render();
        toast("All lights off");
      });
      const on = txt("div", "el-act on", "All on");
      on.addEventListener("click", () => {
        // every light full on (100 %), including ones already on lower
        ents.lights.forEach((e) => {
          patch(e, { on: true, brightness: 1 });
          send("dim", { entity: e, v: 1 });
        });
        lp.render();
        toast("All lights on");
      });
      bar.appendChild(on);
      bar.appendChild(off);
      p.appendChild(bar);
      const g = el("div", "el-cards");
      ents.lights.forEach((e, i) => g.appendChild(levelCard(e, i, "light")));
      p.appendChild(g);
    };
  }

  // shades
  let selShade = 0;
  if (ents.shades) {
    const sp = mkPage("shades");
    sp.render = function () {
      if (dragging) return;
      const p = sp.el;
      p.innerHTML = "";
      const g = el("div", "el-cards top");
      ents.shades.forEach((e, i) => g.appendChild(levelCard(e, i, "cover")));
      p.appendChild(g);
    };
  }

  function levelOf(e, kind) {
    const s = get(e);
    if (kind === "cover") return e.split(".")[0] === "cover" && typeof s.pos === "number" ? s.pos / 100 : s.on ? 1 : 0;
    if (!s.on) return 0;
    return typeof s.brightness === "number" ? s.brightness : 1;
  }

  const CONE_SVG = '<svg class="el-lcone" viewBox="0 0 220 170" aria-hidden="true"><defs><linearGradient id="elCone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6de" stop-opacity=".95"/><stop offset=".45" stop-color="#ffe6b8" stop-opacity=".45"/><stop offset="1" stop-color="#ffdca8" stop-opacity="0"/></linearGradient><filter id="elConeBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter></defs><path d="M94 2H126L214 170H6Z" fill="url(#elCone)" filter="url(#elConeBlur)"/><ellipse cx="110" cy="6" rx="26" ry="7" fill="#fff8e6" opacity=".85" filter="url(#elConeBlur)"/></svg>';
  const LAMP_SVG = '<svg class="el-lamp" viewBox="0 0 46 60" aria-hidden="true"><defs><linearGradient id="elBrass" x1="0" x2="1"><stop offset="0" stop-color="#b8892e"/><stop offset=".45" stop-color="#f4d27c"/><stop offset="1" stop-color="#a87a24"/></linearGradient><linearGradient id="elShade" x1="0" x2="1"><stop offset="0" stop-color="#9da1a6"/><stop offset=".35" stop-color="#f6f6f3"/><stop offset=".6" stop-color="#dfe1e3"/><stop offset="1" stop-color="#8f9399"/></linearGradient></defs><line x1="23" y1="0" x2="23" y2="21" stroke="#e7e4dd" stroke-width="2"/><path d="M19 20h8l2 10H17z" fill="url(#elBrass)"/><rect x="19.5" y="30" width="7" height="3" rx="1" fill="#d6d8db"/><path d="M10 45c0-7 5-12 13-12s13 5 13 12l2 4H8z" fill="url(#elShade)"/><ellipse class="el-lrim" cx="23" cy="49" rx="15" ry="2.6" fill="#fff6dc"/></svg>';
  function levelCard(e, i, kind) {
    const s = get(e);
    const dom = e.split(".")[0];
    // shades: every cover slides (position, or open/close for covers that
    // report none); a switch in the shades list is plain on/off
    const dimmable = kind === "cover" ? dom === "cover" : dom === "light" && s.dim !== false;
    const sel = kind === "cover" ? selShade === i : selLight === i;
    const c = el("div", "el-glass el-card" + (levelOf(e, kind) > 0 ? " on" : "") + (sel ? " sel" : "") + (kind === "cover" ? " cover" : ""));
    // lights: a pendant lamp hanging from the card's top edge; its light cone
    // and shade rim glow with the brightness (HDL-panel style). Shades keep their icon.
    c.innerHTML = '<div class="el-row"><span class="el-bulb">' + (kind === "cover" ? svg("shades") : CONE_SVG + LAMP_SVG) + '</span><div class="el-meta"><div class="el-nm"></div><div class="el-pc"></div></div></div>' + (dimmable ? '<div class="el-slider"><div class="el-fill"></div><div class="el-line"></div></div>' : "");
    c.querySelector(".el-nm").textContent = whole && kind !== "cover" && lightRoom[e] ? nameOf(e) + " · " + lightRoom[e] : nameOf(e);
    paintCard(c, e, kind);
    c.addEventListener("pointerdown", () => {
      if (kind === "cover") selShade = i;
      else selLight = i;
      Array.prototype.forEach.call(c.parentNode.children, (x, n) => x.classList.toggle("sel", n === i));
    });
    c.querySelector(".el-bulb").addEventListener("click", () => {
      const now = levelOf(e, kind) > 0;
      if (kind === "cover") patch(e, { on: !now, pos: now ? 0 : 100 });
      else patch(e, { on: !now });
      send("toggle", { entity: e });
      paintCard(c, e, kind);
    });
    const sl = c.querySelector(".el-slider");
    if (sl) {
      let startV = 0;
      const set = (ev, commit) => {
        const r = sl.getBoundingClientRect();
        const v = clamp((ev.clientX - r.left) / r.width, 0, 1);
        if (kind === "cover") patch(e, { pos: Math.round(v * 100), on: v > 0 });
        else patch(e, { on: v > 0.02, brightness: Math.max(0.01, v) });
        paintCard(c, e, kind);
        if (commit) {
          if (kind === "cover") send("position", { entity: e, v: v, dir: v > startV ? 1 : v < startV ? -1 : 0 });
          else send("dim", { entity: e, v: v > 0.02 ? v : 0 });
        }
      };
      sl.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        dragging = true;
        try {
          sl.setPointerCapture(ev.pointerId);
        } catch (x) {
          /* ignore */
        }
        window.__arClaimGesture = true;
        startV = levelOf(e, kind);
        set(ev, false);
        sl.onpointermove = (m) => set(m, false);
      });
      const end = (ev) => {
        if (!dragging) return;
        dragging = false;
        window.__arClaimGesture = false;
        sl.onpointermove = null;
        set(ev, true);
      };
      sl.addEventListener("pointerup", end);
      sl.addEventListener("pointercancel", end);
    }
    return c;
  }

  function paintCard(c, e, kind) {
    const v = levelOf(e, kind);
    c.classList.toggle("on", v > 0);
    const pc = c.querySelector(".el-pc");
    if (kind === "cover" && e.split(".")[0] === "cover") pc.textContent = v > 0 ? Math.round(v * 100) + "% open" : "Closed";
    else pc.textContent = v > 0 ? (c.querySelector(".el-slider") ? Math.round(v * 100) + "%" : "On") : "Off";
    if (kind !== "cover") {
      // the lamp's light follows the dimmer: a faint glow at 5 %, a full cone at 100 %
      const lv = Math.max(0, Math.min(1, v));
      const cone = c.querySelector(".el-lcone");
      if (cone) cone.style.opacity = v > 0 ? (0.12 + 0.88 * lv).toFixed(2) : "0";
      const rim = c.querySelector(".el-lrim");
      if (rim) rim.style.opacity = v > 0 ? (0.45 + 0.55 * lv).toFixed(2) : "0.12";
      const lamp = c.querySelector(".el-lamp");
      if (lamp) lamp.style.filter = v > 0 && !LITE ? "drop-shadow(0 4px " + Math.round(4 + 10 * lv) + "px rgba(255,236,190," + (0.25 + 0.6 * lv).toFixed(2) + "))" : "";
    }
    const f = c.querySelector(".el-fill");
    if (f) {
      f.style.width = v * 100 + "%";
      c.querySelector(".el-line").style.left = Math.max(4, v * 100) + "%";
    }
  }

  // climate
  let climIdx = 0;
  if (ents.climate) {
    const cp = mkPage("climate");
    cp.render = function () {
      const e = ents.climate[climIdx] || ents.climate[0];
      const s = get(e);
      const p = cp.el;
      p.innerHTML = "";
      if (ents.climate.length > 1) {
        const bar = el("div", "el-subbar");
        ents.climate.forEach((x, i) => {
          const t = txt("div", "el-tab" + (i === climIdx ? " on" : ""), nameOf(x));
          t.addEventListener("click", () => {
            climIdx = i;
            cp.render();
          });
          bar.appendChild(t);
        });
        p.appendChild(bar);
      }
      const wrap = el("div", "el-climate" + (ents.climate.length > 1 ? " tabs" : ""));
      const box = el("div", "el-glass el-dialbox");
      const down = el("div", "el-round", svg("minus"));
      const up = el("div", "el-round", svg("plus"));
      const dial = el("div", "el-dial", '<canvas width="560" height="560"></canvas><div class="el-read"><div class="el-set"></div><div class="el-now"></div></div>');
      box.appendChild(down);
      box.appendChild(dial);
      box.appendChild(up);
      wrap.appendChild(box);
      const modes = el("div", "el-glass el-modes");
      modes.appendChild(txt("div", "el-lbl", "Mode"));
      (s.modes && s.modes.length ? s.modes : ["off"]).forEach((m) => {
        const b = el("div", "el-mode" + (s.value === m ? " on" : ""), svg(MODE_ICON[m] || "auto") + "<span></span>");
        b.lastChild.textContent = MODE_NAME[m] || cap(m);
        b.addEventListener("click", () => {
          patch(e, { value: m, on: m !== "off" });
          send("hvac", { entity: e, mode: m });
          cp.render();
        });
        modes.appendChild(b);
      });
      wrap.appendChild(modes);
      p.appendChild(wrap);
      drawDial(dial, s);
      const step = typeof s.step === "number" ? s.step : 0.5;
      down.addEventListener("click", () => climBy(e, -step));
      up.addEventListener("click", () => climBy(e, step));
    };
  }
  function climBy(e, d) {
    const s = get(e);
    if (typeof s.temp !== "number") return;
    const t = clamp(Math.round((s.temp + d) * 10) / 10, typeof s.min === "number" ? s.min : 7, typeof s.max === "number" ? s.max : 35);
    patch(e, { temp: t });
    send("temp", { entity: e, v: t });
    pages.climate.render();
  }
  function drawDial(dial, s) {
    const cv = dial.querySelector("canvas");
    const x = cv.getContext("2d");
    const C = 280, R = 236, a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    const mn = typeof s.min === "number" ? s.min : 16;
    const mx = typeof s.max === "number" ? s.max : 30;
    const t = typeof s.temp === "number" ? s.temp : null;
    x.clearRect(0, 0, 560, 560);
    x.lineCap = "round";
    x.lineWidth = 24;
    x.strokeStyle = "rgba(255,255,255,.10)";
    x.beginPath();
    x.arc(C, C, R, a0, a1);
    x.stroke();
    if (t != null) {
      const a = a0 + (a1 - a0) * clamp((t - mn) / (mx - mn || 1), 0, 1);
      x.strokeStyle = s.value === "heat" ? "#f0a050" : s.value === "off" ? "rgba(255,255,255,.28)" : "#7cc4e8";
      x.beginPath();
      x.arc(C, C, R, a0, a);
      x.stroke();
      x.fillStyle = "#fff";
      x.beginPath();
      x.arc(C + Math.cos(a) * R, C + Math.sin(a) * R, 17, 0, Math.PI * 2);
      x.fill();
    }
    for (let i = 0; i <= 28; i++) {
      const q = a0 + ((a1 - a0) * i) / 28, big = i % 4 === 0;
      x.lineWidth = big ? 4 : 2;
      x.strokeStyle = "rgba(255,255,255," + (big ? 0.35 : 0.18) + ")";
      x.beginPath();
      x.moveTo(C + Math.cos(q) * (R - 32), C + Math.sin(q) * (R - 32));
      x.lineTo(C + Math.cos(q) * (R - (big ? 50 : 42)), C + Math.sin(q) * (R - (big ? 50 : 42)));
      x.stroke();
    }
    dial.querySelector(".el-set").innerHTML = t == null ? "—" : fmtT(t) + "<sup>°</sup>";
    dial.querySelector(".el-now").textContent = (typeof s.cur === "number" ? "Room " + fmtT(s.cur) + "°" : "") + (s.action ? " · " + cap(s.action) : "");
  }

  // music: Music Assistant (speakers, playlists, radio, grouping) ---------------
  let maTarget = null;
  let libTab = "fav";
  let libOpen = null; // {item, tracks, err}: an open playlist / album
  function playItem(pl, it, tr) {
    const q = maQueue(pl);
    const args = { queue_id: q, media: it.uri };
    if (tr) args.start_item = tr.uri;
    ma.cmd("player_queues/play_media", args)
      .catch(() => (tr ? ma.cmd("player_queues/play_media", { queue_id: q, media: tr.uri }) : Promise.reject(new Error("failed"))))
      .then(
        () => toast("Playing " + (tr ? tr.name : it.name) + " on " + maName(pl)),
        (e) => toast("Music Assistant: " + (e && e.message ? e.message : "couldn't play that")),
      );
  }
  function loadTracks(o) {
    const it = o.item;
    const args = { item_id: String(it.item_id), provider_instance_id_or_domain: it.provider || "library" };
    let q;
    if (it.media_type === "artist")
      // an artist's best-known songs; older Music Assistant only has artist_tracks
      q = ma
        .cmd("music/artists/top_tracks", Object.assign({ limit: 50 }, args))
        .catch(() => ma.cmd("music/artists/artist_tracks", args))
        .then((r) => (Array.isArray(r) ? r : (r && r.items) || []).slice(0, 100));
    else q = ma.cmd(it.media_type === "album" ? "music/albums/album_tracks" : "music/playlists/playlist_tracks", it.media_type === "album" ? args : Object.assign({ limit: 300 }, args));
    q.then(
      (r) => {
        o.tracks = Array.isArray(r) ? r : (r && r.items) || [];
        if (libOpen === o && current === "music") pages.music.render();
      },
      (e) => {
        o.err = (e && e.message) || "couldn't load the songs";
        if (libOpen === o && current === "music") pages.music.render();
      },
    );
  }
  // play a list of songs from song i (artist songs, search results)
  function playTracks(pl, list, i) {
    const uris = list.slice(i, i + 50).map((t) => t.uri).filter(Boolean);
    if (!uris.length) return;
    ma.cmd("player_queues/play_media", { queue_id: maQueue(pl), media: uris }).then(
      () => toast("Playing " + (list[i].name || "song") + " on " + maName(pl)),
      (e) => toast("Music Assistant: " + (e && e.message ? e.message : "couldn't play that")),
    );
  }
  function openItem(it) {
    libOpen = { item: it, tracks: null, err: null };
    loadTracks(libOpen);
    pages.music.render();
  }

  // --- search (Spotify through Music Assistant), with the panel's own keyboard
  const srch = { q: "", res: null, busy: false, err: null, kb: true, num: false, n: 0 };
  function doSearch() {
    const q = srch.q.trim();
    if (!q) return;
    srch.kb = false;
    srch.busy = true;
    srch.err = null;
    srch.res = null;
    const n = ++srch.n;
    const base = { search_query: q, media_types: ["track", "artist", "album", "playlist"], limit: 12 };
    const empty = (r) => !r || !["tracks", "artists", "albums", "playlists"].some((k) => r[k] && r[k].length);
    // Spotify first; if this Music Assistant has no "providers" option or no
    // Spotify, search everything it has instead
    ma.cmd("music/search", Object.assign({ providers: ["spotify"] }, base))
      .then((r) => (empty(r) ? ma.cmd("music/search", base) : r), () => ma.cmd("music/search", base))
      .then(
        (r) => {
          if (n !== srch.n) return;
          srch.busy = false;
          srch.res = r || {};
          if (current === "music") pages.music.render();
        },
        (e) => {
          if (n !== srch.n) return;
          srch.busy = false;
          srch.err = (e && e.message) || "search failed";
          if (current === "music") pages.music.render();
        },
      );
    pages.music.render();
  }
  function keyboard(st, goFn) {
    st = st || srch;
    goFn = goFn || doSearch;
    const kb = el("div", "el-kb");
    const rows = st.num
      ? ["1234567890", "-/:;()&@\"'", ".,?!#%+="]
      : ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
    const press = (fn) => (ev) => {
      // pointerdown, not click: Music Assistant updates re-draw the page often
      ev.preventDefault();
      fn();
      pages.music.render();
    };
    rows.forEach((r, ri) => {
      const row = el("div", "el-kbr");
      if (ri === 2) {
        const sh = txt("div", "el-key wide", st.num ? "ABC" : "123");
        sh.addEventListener("pointerdown", press(() => (st.num = !st.num)));
        row.appendChild(sh);
      }
      r.split("").forEach((ch) => {
        const k = txt("div", "el-key", ch);
        k.addEventListener("pointerdown", press(() => (st.q += ch)));
        row.appendChild(k);
      });
      if (ri === 2) {
        const bs = el("div", "el-key wide", svg("backsp"));
        bs.addEventListener("pointerdown", press(() => (st.q = st.q.slice(0, -1))));
        row.appendChild(bs);
      }
      kb.appendChild(row);
    });
    const last = el("div", "el-kbr");
    const spc = txt("div", "el-key space", "space");
    spc.addEventListener("pointerdown", press(() => (st.q += " ")));
    last.appendChild(spc);
    const go = el("div", "el-key go", svg("search") + "<span>Search</span>");
    go.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      goFn();
    });
    last.appendChild(go);
    kb.appendChild(last);
    return kb;
  }
  function searchPanel(pl, media) {
    const box = el("div", "el-glass el-srch");
    const bar = el("div", "el-sbar" + (srch.kb ? " on" : ""), svg("search") + '<div class="el-sq"></div>');
    const sq = bar.querySelector(".el-sq");
    if (srch.q) sq.textContent = srch.q;
    else sq.appendChild(txt("span", "el-sph", "Search Spotify: songs, artists, albums"));
    if (srch.kb) sq.appendChild(el("i", "el-caret"));
    bar.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest && ev.target.closest(".el-sx")) return;
      srch.kb = true;
      pages.music.render();
    });
    if (srch.q) {
      const x = txt("div", "el-sx", "×");
      x.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        srch.q = "";
        srch.res = null;
        srch.kb = true;
        pages.music.render();
      });
      bar.appendChild(x);
    }
    box.appendChild(bar);
    if (srch.kb) {
      box.appendChild(keyboard());
      return box;
    }
    const out = el("div", "el-sres");
    const msg = (t) => out.appendChild(txt("div", "el-libmsg", t));
    if (srch.busy) msg("Searching…");
    else if (srch.err) msg("Music Assistant: " + srch.err);
    else if (srch.res) {
      const r = srch.res;
      const head = (t) => out.appendChild(txt("div", "el-sh", t));
      const tracks = r.tracks || [];
      if (tracks.length) {
        head("Songs");
        tracks.forEach((tr, i) => {
          const playing = media && media.uri && media.uri === tr.uri;
          const row = el("div", "el-trkr" + (playing ? " on" : ""));
          const a = el("div", "el-sart");
          const iu = imgOf(tr) || (tr.album && imgOf(tr.album));
          if (iu) a.appendChild(artImg(iu));
          row.appendChild(a);
          const tt = el("div", "el-trkm");
          tt.appendChild(txt("b", "", tr.name || "Song"));
          tt.appendChild(txt("small", "", (tr.artists || []).map((x) => x && x.name).filter(Boolean).join(", ") + (tr.album && tr.album.name ? " · " + tr.album.name : "")));
          row.appendChild(tt);
          row.appendChild(txt("span", "el-trkd", mmss(tr.duration)));
          row.addEventListener("click", () => playTracks(pl, tracks, i));
          out.appendChild(row);
        });
      }
      const tiles = (label, list, kind) => {
        if (!list || !list.length) return;
        head(label);
        const g = el("div", "el-sgrid");
        list.forEach((it) => {
          const b = el("div", "el-li" + (kind === "Artist" ? " artist" : ""));
          const a = el("div", "el-lia");
          const iu = imgOf(it);
          if (iu) a.appendChild(artImg(iu));
          b.appendChild(a);
          const t = el("div", "el-lit");
          t.appendChild(txt("div", "el-lin", it.name));
          const by = (it.artists || []).map((x) => x && x.name).filter(Boolean)[0];
          t.appendChild(txt("div", "el-lis", kind + (by && kind !== "Artist" ? " · " + by : "")));
          b.appendChild(t);
          b.addEventListener("click", () => openItem(it));
          g.appendChild(b);
        });
        out.appendChild(g);
      };
      tiles("Artists", r.artists, "Artist");
      tiles("Albums", r.albums, "Album");
      tiles("Playlists", r.playlists, "Playlist");
      if (!out.children.length) msg("Nothing found for “" + srch.q.trim() + "”.");
    }
    box.appendChild(out);
    return box;
  }

  const mmss = (s) => (s > 0 ? Math.floor(s / 60) + ":" + ("0" + Math.floor(s % 60)).slice(-2) : "");
  function trackList(pl, media) {
    const o = libOpen;
    const box = el("div", "el-glass el-trk");
    const head = el("div", "el-trkh");
    const back = el("div", "el-trkb", svg("chev"));
    back.addEventListener("click", () => {
      libOpen = null;
      pages.music.render();
    });
    head.appendChild(back);
    const ti = el("div", "el-trkt");
    ti.appendChild(txt("b", "", o.item.name));
    const kind = o.item.media_type === "album" ? "Album" : o.item.media_type === "artist" ? "Artist" : "Playlist";
    ti.appendChild(txt("small", "", o.tracks ? kind + " · " + o.tracks.length + (o.tracks.length === 1 ? " song" : " songs") : kind));
    head.appendChild(ti);
    const all = el("div", "el-gbtn el-playall", svg("play") + "<span>Play all</span>");
    all.addEventListener("click", () => playItem(pl, o.item, null));
    head.appendChild(all);
    box.appendChild(head);
    if (o.err) box.appendChild(txt("div", "el-libmsg", "Music Assistant: " + o.err));
    else if (!o.tracks) box.appendChild(txt("div", "el-libmsg", "Loading songs…"));
    else if (!o.tracks.length) box.appendChild(txt("div", "el-libmsg", "No songs in this " + (o.item.media_type === "album" ? "album" : "playlist") + "."));
    else
      o.tracks.forEach((tr, i) => {
        const playing = media && ((media.uri && media.uri === tr.uri) || (media.title && media.title === tr.name));
        const r = el("div", "el-trkr" + (playing ? " on" : ""));
        r.appendChild(txt("span", "el-trkn", playing ? "▶" : String(i + 1)));
        const tt = el("div", "el-trkm");
        tt.appendChild(txt("b", "", tr.name || "Track"));
        const ar = (tr.artists || []).map((a) => a && a.name).filter(Boolean).join(", ");
        tt.appendChild(txt("small", "", ar));
        r.appendChild(tt);
        r.appendChild(txt("span", "el-trkd", mmss(tr.duration)));
        r.addEventListener("click", () => {
          if (o.item.media_type === "artist") playTracks(pl, o.tracks, i);
          else playItem(pl, o.item, tr);
        });
        box.appendChild(r);
      });
    return box;
  }
  const libCache = {};
  let libBusy = false;
  const maName = (pl) => (pl && (pl.display_name || pl.name)) || "Speaker";
  const maState = (pl) => (pl && (pl.playback_state || pl.state)) || "idle";
  function maTargetPlayer() {
    const all = ma.list();
    if (!all.length) return null;
    if (!maTarget || !ma.players[maTarget]) {
      const playing = all.filter((x) => maState(x) === "playing" && !x.synced_to)[0];
      maTarget = (playing || all[0]).player_id;
    }
    return ma.players[maTarget];
  }
  function maCmd(cmd, args, okMsg) {
    return ma.cmd(cmd, args).then(
      () => okMsg && toast(okMsg),
      (e) => toast("Music Assistant: " + (e && e.message ? e.message : "failed")),
    );
  }
  // Grouping. Music Assistant only syncs speakers that can play together (same
  // kind, e.g. AirPlay with AirPlay); any other speaker in a group request is
  // skipped with nothing but a line in MA's log. So the panel only offers
  // speakers MA lists in the leader's can_group_with, and checks afterwards
  // that the change really happened.
  const inGroupOf = (pl, x) => (pl.group_members || []).indexOf(x.player_id) >= 0 || x.synced_to === pl.player_id;
  function canLead(pl) {
    const f = pl.supported_features;
    return !Array.isArray(f) || f.indexOf("set_members") >= 0 || f.indexOf("sync") >= 0;
  }
  function canJoin(pl, x) {
    if (!canLead(pl)) return false;
    const c = pl.can_group_with;
    return !Array.isArray(c) || c.indexOf(x.player_id) >= 0 || inGroupOf(pl, x);
  }
  function verifyJoin(leaderId, pids, join) {
    setTimeout(() => {
      const L = ma.players[leaderId];
      if (!L) return;
      const bad = pids.filter((id) => ma.players[id] && inGroupOf(L, ma.players[id]) !== join);
      if (bad.length)
        toast("Music Assistant didn't " + (join ? "add " : "remove ") + bad.map((id) => maName(ma.players[id])).join(", ") + " — see the Music Assistant log");
    }, 5000);
  }
  function maJoinMany(target, pids, join) {
    if (!pids.length) return;
    const args = join ? { target_player: target, player_ids_to_add: pids } : { target_player: target, player_ids_to_remove: pids };
    ma.cmd("players/cmd/set_members", args)
      .catch(() =>
        // older Music Assistant
        join
          ? ma.cmd("players/cmd/group_many", { target_player: target, child_player_ids: pids })
          : Promise.all(pids.map((pid) => ma.cmd("players/cmd/ungroup", { player_id: pid }))),
      )
      .then(
        () => {
          verifyJoin(target, pids, join);
          // a speaker joining the zone starts at the zone's volume
          const L = ma.players[target];
          if (join && L && typeof L.volume_level === "number") matchVolume(pids, L.volume_level);
        },
        (e) => toast("Couldn't change the group: " + (e && e.message ? e.message : "not supported")),
      );
  }
  // Zone volume: every speaker in the zone at the same level (not MA's
  // relative group_volume, which keeps their differences)
  function matchVolume(ids, v) {
    ids.forEach((id) => ma.cmd("players/cmd/volume_set", { player_id: id, volume_level: v }).catch(() => {}));
  }
  function zoneIds(pl) {
    return [pl.player_id].concat(ma.list().filter((x) => x.player_id !== pl.player_id && inGroupOf(pl, x)).map((x) => x.player_id));
  }
  function maJoin(target, pid, join) {
    maJoinMany(target, [pid], join);
  }
  // the queue a speaker plays from: its own, or its leader's when it is grouped
  const maQueue = (pl) => pl.synced_to || pl.player_id;
  function groupSize(pl) {
    return 1 + ma.list().filter((x) => x.player_id !== pl.player_id && inGroupOf(pl, x)).length;
  }

  // Group tab: put other speakers in this speaker's zone, each keeps its own volume
  function groupPanel(pl) {
    const box = el("div", "el-glass el-grp");
    const others = ma.list().filter((x) => x.player_id !== pl.player_id);
    const inG = others.filter((x) => inGroupOf(pl, x));
    const head = el("div", "el-grph");
    const t = el("div", "el-grpt");
    t.innerHTML = "<span>Zone</span><b></b><small></small>";
    t.querySelector("b").textContent = maName(pl);
    t.querySelector("small").textContent = inG.length ? " + " + inG.length + (inG.length === 1 ? " speaker" : " speakers") : " · on its own";
    head.appendChild(t);
    const all = txt("div", "el-gbtn" + (canLead(pl) ? "" : " off"), "Group all");
    all.addEventListener("click", () => {
      if (!canLead(pl)) return toast(maName(pl) + " can't lead a group in Music Assistant");
      const add = others.filter((x) => !inGroupOf(pl, x) && canJoin(pl, x)).map((x) => x.player_id);
      if (!add.length) return toast(others.some((x) => !canJoin(pl, x)) ? "No other speaker can sync with " + maName(pl) : "Every speaker is already in this zone");
      maJoinMany(pl.player_id, add, true);
      toast("All speakers join " + maName(pl));
    });
    const none = txt("div", "el-gbtn" + (inG.length ? "" : " off"), "Ungroup");
    none.addEventListener("click", () => {
      if (!inG.length) return;
      maJoinMany(pl.player_id, inG.map((x) => x.player_id), false);
      toast(maName(pl) + " plays on its own");
    });
    head.appendChild(all);
    head.appendChild(none);
    box.appendChild(head);
    if (!others.length) box.appendChild(txt("div", "el-libmsg", "Only one speaker in Music Assistant."));
    others.forEach((x) => {
      const on = inGroupOf(pl, x);
      const ok = canJoin(pl, x);
      const r = el("div", "el-grpr" + (on ? " in" : "") + (ok ? "" : " na"), svg("speaker") + '<div class="el-grpn"><span></span><small></small></div>');
      r.querySelector("span").textContent = maName(x);
      const lead = x.synced_to && ma.players[x.synced_to];
      const xm = x.current_media || {};
      r.querySelector("small").textContent = on
        ? "In this zone"
        : !ok
          ? "Can't sync with " + maName(pl)
          : lead
          ? "In " + maName(lead) + "'s zone"
          : maState(x) === "playing"
            ? "Playing" + (xm.title ? " · " + xm.title : "")
            : "Not playing";
      if (on) {
        // its own volume inside the zone
        const gv = el("div", "el-gvol", '<div class="el-fill"></div>');
        const pc = txt("div", "el-gvp", "");
        const hk = "M" + x.player_id;
        const hx = holds[hk];
        const lv = (hx && Date.now() < hx.until ? hx.v : typeof x.volume_level === "number" ? x.volume_level : 0) / 100;
        gv.firstChild.style.width = lv * 100 + "%";
        pc.textContent = Math.round(lv * 100) + "%";
        const setG = (ev, commit) => {
          const b = gv.getBoundingClientRect();
          const v = clamp((ev.clientX - b.left) / b.width, 0, 1);
          gv.firstChild.style.width = v * 100 + "%";
          pc.textContent = Math.round(v * 100) + "%";
          if (commit) {
            hold(hk, Math.round(v * 100));
            maCmd("players/cmd/volume_set", { player_id: x.player_id, volume_level: Math.round(v * 100) });
          }
        };
        gv.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          dragging = true;
          window.__arClaimGesture = true;
          try {
            gv.setPointerCapture(ev.pointerId);
          } catch (e) {
            /* ignore */
          }
          setG(ev, false);
          gv.onpointermove = (m) => setG(m, false);
        });
        const endG = (ev) => {
          if (!dragging) return;
          dragging = false;
          window.__arClaimGesture = false;
          gv.onpointermove = null;
          setG(ev, true);
        };
        gv.addEventListener("pointerup", endG);
        gv.addEventListener("pointercancel", endG);
        gv.addEventListener("click", (ev) => ev.stopPropagation());
        r.appendChild(gv);
        r.appendChild(pc);
      } else r.appendChild(el("div", "el-gsp"));
      const sw = el("div", "el-sw" + (on ? " on" : ""));
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", on ? "true" : "false");
      r.appendChild(sw);
      // tap the row (anywhere but the volume) to add or remove the speaker
      r.addEventListener("click", () => {
        if (!ok) return toast(maName(x) + " can't play in sync with " + maName(pl) + " (a different kind of speaker)");
        maJoin(pl.player_id, x.player_id, !on);
        toast(on ? maName(x) + " leaves the zone" : maName(x) + " joins " + maName(pl));
      });
      box.appendChild(r);
    });
    return box;
  }

  function libLoad(tab) {
    if (libCache[tab] || libBusy) return;
    libBusy = true;
    const q =
      tab === "fav"
        ? Promise.all([
            ma.cmd("music/playlists/library_items", { favorite: true, limit: 60 }).catch(() => []),
            ma.cmd("music/radios/library_items", { favorite: true, limit: 60 }).catch(() => []),
            ma.cmd("music/albums/library_items", { favorite: true, limit: 60 }).catch(() => []),
          ]).then((r) => (r[0] || []).concat(r[1] || [], r[2] || []))
        : tab === "artists"
          ? ma
              .cmd("music/artists/library_items", { limit: 400 })
              .catch(() => [])
              .then((r) => (Array.isArray(r) ? r : (r && r.items) || []).slice().sort((x, y) => String(x.name).localeCompare(String(y.name))))
          : ma.cmd(tab === "radio" ? "music/radios/library_items" : "music/playlists/library_items", { limit: 120 }).catch(() => []);
    q.then((items) => {
      libCache[tab] = items || [];
      libBusy = false;
      if (current === "music") pages.music.render();
    });
  }
  // Artwork is kept between redraws: a redraw re-uses the picture instead of
  // loading and decoding it again (the Source 10 struggled with that).
  const artCache = {};
  const artOrder = [];
  let artGen = 0; // bumped once per music redraw
  function artImg(url, slot) {
    const k = (slot || "") + "|" + url;
    let im = artCache[k];
    if (im && im._gen !== artGen) {
      im._gen = artGen;
      return im; // the same picture, moved into the new page
    }
    // new, or the same URL a second time in this redraw: a fresh element
    const fresh = el("img");
    fresh.decoding = "async";
    fresh._gen = artGen;
    fresh.onerror = () => {
      fresh.remove();
      if (artCache[k] === fresh) delete artCache[k];
    };
    fresh.src = url;
    if (!im) {
      artCache[k] = fresh;
      artOrder.push(k);
      if (artOrder.length > 120) delete artCache[artOrder.shift()];
    }
    return fresh;
  }
  function imgOf(it) {
    let u = null;
    if (it.image) u = it.image.path || it.image;
    else if (it.metadata && it.metadata.images && it.metadata.images[0]) u = it.metadata.images[0].path;
    return typeof u === "string" ? ma.imageUrl(u) : null;
  }
  function renderMA(p) {
    artGen++;
    p.innerHTML = "";
    if (ma.status !== "ready") {
      p.appendChild(txt("div", "el-empty", ma.status === "error" ? "Music Assistant: " + (ma.error || "can't connect") : "Connecting to Music Assistant…"));
      return;
    }
    const pl = maTargetPlayer();
    if (!pl) {
      p.appendChild(txt("div", "el-empty", "No speakers found in Music Assistant."));
      return;
    }
    const media = pl.current_media || {};
    const st = maState(pl);
    const wrap = el("div", "el-mam");
    // now playing
    const np = el("div", "el-glass el-np");
    const sw0 = spSwitch();
    if (sw0) np.appendChild(sw0);
    const art = el("div", "el-art");
    const au = ma.imageUrl(media.image_url);
    if (au) art.appendChild(artImg(au, "np"));
    np.appendChild(art);
    np.appendChild(txt("div", "el-tt", media.title || (st === "idle" ? "Pick something to play" : maName(pl))));
    np.appendChild(txt("div", "el-ar", [media.artist, media.album].filter(Boolean).join(" · ") || "on " + maName(pl)));
    const ctl = el("div", "el-ctl");
    const prev = el("div", "el-round", svg("prev"));
    const play = el("div", "el-round el-play", svg(st === "playing" ? "pause" : "play"));
    const next = el("div", "el-round", svg("next"));
    prev.addEventListener("click", () => maCmd("players/cmd/previous", { player_id: pl.player_id }));
    next.addEventListener("click", () => maCmd("players/cmd/next", { player_id: pl.player_id }));
    play.addEventListener("click", () => maCmd(st === "playing" ? "players/cmd/pause" : "players/cmd/play", { player_id: pl.player_id }));
    ctl.appendChild(prev);
    ctl.appendChild(play);
    ctl.appendChild(next);
    np.appendChild(ctl);
    wrap.appendChild(np);
    // right: volume, speakers, library
    const right = el("div", "el-mright");
    const gsz = groupSize(pl);
    const vol = el("div", "el-glass el-vol" + (gsz > 1 ? " grp" : ""), svg("vol") + (gsz > 1 ? '<span class="el-voll">Zone · ' + gsz + "</span>" : "") + '<div class="el-slider"><div class="el-fill"></div></div><span class="el-volpc"></span>');
    const hv = holds["M" + pl.player_id];
    const vlev = (hv && Date.now() < hv.until ? hv.v : typeof pl.volume_level === "number" ? pl.volume_level : 0) / 100;
    vol.querySelector(".el-fill").style.width = vlev * 100 + "%";
    vol.querySelector(".el-volpc").textContent = Math.round(vlev * 100) + "%";
    const sl = vol.querySelector(".el-slider");
    const setV = (ev, commit) => {
      const r = sl.getBoundingClientRect();
      const v = clamp((ev.clientX - r.left) / r.width, 0, 1);
      vol.querySelector(".el-fill").style.width = v * 100 + "%";
      vol.querySelector(".el-volpc").textContent = Math.round(v * 100) + "%";
      if (commit) {
        if (gsz > 1) matchVolume(zoneIds(pl), Math.round(v * 100));
        else maCmd("players/cmd/volume_set", { player_id: pl.player_id, volume_level: Math.round(v * 100) });
      }
    };
    sl.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      dragging = true;
      window.__arClaimGesture = true;
      try {
        sl.setPointerCapture(ev.pointerId);
      } catch (x) {
        /* ignore */
      }
      setV(ev, false);
      sl.onpointermove = (m) => setV(m, false);
    });
    const endV = (ev) => {
      if (!dragging) return;
      dragging = false;
      window.__arClaimGesture = false;
      sl.onpointermove = null;
      setV(ev, true);
    };
    sl.addEventListener("pointerup", endV);
    sl.addEventListener("pointercancel", endV);
    right.appendChild(vol);
    // speakers: tap = play here, + = add to this group
    const members = pl.group_members || [];
    const row = el("div", "el-spkrow");
    ma.list()
      .filter((x) => !x.synced_to || x.synced_to === pl.player_id || x.player_id === pl.player_id)
      .forEach((x) => {
        const isT = x.player_id === pl.player_id;
        const inG = !isT && (members.indexOf(x.player_id) >= 0 || x.synced_to === pl.player_id);
        const c = el("div", "el-spkc" + (isT ? " on" : inG ? " grp" : ""), svg("speaker") + '<div class="el-spkt"><span></span><small></small></div>');
        c.querySelector("span").textContent = maName(x);
        c.querySelector("small").textContent = isT ? "Playing on" : inG ? "Joined" : maState(x) === "playing" ? "Playing" : "Tap to switch";
        c.addEventListener("click", () => {
          if (isT) return;
          maTarget = x.player_id;
          pages.music.render();
        });
        if (!isT && (inG || canJoin(pl, x))) {
          const j = txt("div", "el-join" + (inG ? " in" : ""), inG ? "✓" : "+");
          j.addEventListener("click", (ev) => {
            ev.stopPropagation();
            maJoin(pl.player_id, x.player_id, !inG);
            toast(inG ? maName(x) + " removed" : maName(x) + " joins " + maName(pl));
          });
          c.appendChild(j);
        }
        row.appendChild(c);
      });
    // the Group tab has its own speaker list, so the chips make room for it
    if (libTab !== "group" && libTab !== "search") right.appendChild(row);
    // library
    const tabs = el("div", "el-libtabs");
    [
      ["fav", "Favourites"],
      ["playlists", "Playlists"],
      ["artists", "Artists"],
      ["radio", "Radio"],
      ["search", "Search"],
      ["group", "Group"],
    ].forEach((t) => {
      const b = txt("div", "el-tab" + (libTab === t[0] ? " on" : ""), t[1]);
      b.addEventListener("click", () => {
        libTab = t[0];
        libOpen = null;
        pages.music.render();
      });
      tabs.appendChild(b);
    });
    right.appendChild(tabs);
    if (libTab === "group") {
      right.appendChild(groupPanel(pl));
      wrap.appendChild(right);
      p.appendChild(wrap);
      return;
    }
    if (libOpen) {
      right.appendChild(trackList(pl, media));
      wrap.appendChild(right);
      p.appendChild(wrap);
      return;
    }
    if (libTab === "search") {
      right.appendChild(searchPanel(pl, media));
      wrap.appendChild(right);
      p.appendChild(wrap);
      return;
    }
    const lib = el("div", "el-glass el-lib");
    const items = libCache[libTab];
    if (!items) {
      lib.appendChild(txt("div", "el-libmsg", "Loading…"));
      libLoad(libTab);
    } else if (!items.length) lib.appendChild(txt("div", "el-libmsg", libTab === "fav" ? "No favourites yet — star playlists or stations in Music Assistant." : "Nothing here in Music Assistant yet."));
    else
      items.forEach((it) => {
        const b = el("div", "el-li");
        const a = el("div", "el-lia");
        const iu = imgOf(it);
        if (iu) a.appendChild(artImg(iu));
        b.appendChild(a);
        const t = el("div", "el-lit");
        t.appendChild(txt("div", "el-lin", it.name));
        t.appendChild(txt("div", "el-lis", it.media_type === "radio" ? "Radio" : it.media_type === "album" ? "Album" : it.media_type === "artist" ? "Artist" : "Playlist"));
        if (it.media_type === "artist") b.classList.add("artist");
        b.appendChild(t);
        b.addEventListener("click", () => {
          // playlists, albums and artists open to their songs; radio just plays
          if (it.media_type === "playlist" || it.media_type === "album" || it.media_type === "artist") openItem(it);
          else playItem(pl, it, null);
        });
        lib.appendChild(b);
      });
    right.appendChild(lib);
    wrap.appendChild(right);
    p.appendChild(wrap);
  }

  // --- Spotify (through Home Assistant's Spotify integration) ---------------------
  // A second music source next to Music Assistant: Spotify's own speakers
  // (Spotify Connect), playlists, liked songs and search, straight from Spotify.
  function spSwitch() {
    // Music Assistant / Spotify, shown when both are set up
    if (!(maOn && spOn)) return null;
    const sw = el("div", "el-src");
    [
      ["ma", "Music Assistant"],
      ["sp", "Spotify"],
    ].forEach((o) => {
      const b = txt("div", "el-srcb" + (musicSrc === o[0] ? " on" : ""), o[1]);
      b.addEventListener("click", () => {
        if (musicSrc === o[0]) return;
        musicSrc = o[0];
        if (musicSrc === "sp") sp.start();
        else sp.stop();
        pages.music.render();
      });
      sw.appendChild(b);
    });
    return sw;
  }
  const SPOTIFY_APP = "com.spotify.music";
  function openSpotifyApp() {
    if (!native.launchApp(SPOTIFY_APP)) toast(native.appInstalled(SPOTIFY_APP) ? "Couldn't open the Spotify app" : "The Spotify app isn't installed on this panel yet");
  }
  const spImg = (it) => {
    const im = (it && (it.images || (it.album && it.album.images))) || [];
    const pick = im.filter((x) => x && x.url).sort((a, b) => (a.width || 0) - (b.width || 0));
    return (pick.filter((x) => (x.width || 0) >= 160)[0] || pick[pick.length - 1] || {}).url || null;
  };
  const spArtists = (t) => ((t && t.artists) || []).map((a) => a && a.name).filter(Boolean).join(", ");
  function spErr(e, what) {
    const r = e && e.reason;
    if (r === "NO_ACTIVE_DEVICE" || (e && e.status === 404)) return toast("Pick a speaker first (tap one above)");
    if (r === "PREMIUM_REQUIRED") return toast("Spotify needs Premium to play from here");
    toast("Spotify: " + ((e && e.message) || what || "failed"));
  }
  let spTab = "playlists";
  let spOpen = null; // {kind, item, tracks, albums, err}
  const spLib = {};
  const spSrch = { q: "", res: null, busy: false, err: null, kb: true, num: false, n: 0 };
  function spLoad(tab) {
    if (spLib[tab] || spLib[tab + "_busy"]) return;
    spLib[tab + "_busy"] = true;
    const q = tab === "liked" ? sp.api("GET", "/me/tracks?limit=50").then((r) => ((r && r.items) || []).map((x) => x.track).filter(Boolean)) : sp.api("GET", "/me/playlists?limit=50").then((r) => ((r && r.items) || []).filter(Boolean));
    q.then(
      (items) => {
        spLib[tab] = items;
        spLib[tab + "_busy"] = false;
        if (current === "music") pages.music.render();
      },
      (e) => {
        spLib[tab] = [];
        spLib[tab + "_err"] = (e && e.message) || "couldn't load";
        spLib[tab + "_busy"] = false;
        if (current === "music") pages.music.render();
      },
    );
  }
  function spOpenItem(kind, item) {
    const o = (spOpen = { kind: kind, item: item, tracks: null, albums: null, err: null });
    const done = () => {
      if (spOpen === o && current === "music") pages.music.render();
    };
    let q;
    if (kind === "playlist")
      q = sp.api("GET", "/playlists/" + item.id + "/items?limit=100").then((r) => (o.tracks = ((r && r.items) || []).map((x) => x && (x.item || x.track)).filter((t) => t && t.uri)));
    else if (kind === "album")
      q = sp.api("GET", "/albums/" + item.id + "/tracks?limit=50").then((r) => (o.tracks = ((r && r.items) || []).map((t) => Object.assign({ album: { images: item.images } }, t))));
    else q = sp.api("GET", "/artists/" + item.id + "/albums?include_groups=album,single&limit=20").then((r) => (o.albums = (r && r.items) || []));
    q.then(done, (e) => {
      o.err =
        kind === "playlist" && e && e.status === 403
          ? "Spotify only lists the songs of playlists you own. Play all still plays it."
          : "Spotify: " + ((e && e.message) || "couldn't load");
      done();
    });
    pages.music.render();
  }
  function spPlay(body) {
    sp.play(body).catch((e) => spErr(e, "couldn't play that"));
  }
  function spTrackRows(box, list, onTap, playingUri) {
    list.forEach((tr, i) => {
      const row = el("div", "el-trkr" + (playingUri && playingUri === tr.uri ? " on" : ""));
      const a = el("div", "el-sart");
      const iu = spImg(tr);
      if (iu) a.appendChild(artImg(iu));
      row.appendChild(a);
      const tt = el("div", "el-trkm");
      tt.appendChild(txt("b", "", tr.name || "Song"));
      tt.appendChild(txt("small", "", spArtists(tr) + (tr.album && tr.album.name ? " · " + tr.album.name : "")));
      row.appendChild(tt);
      row.appendChild(txt("span", "el-trkd", mmss((tr.duration_ms || 0) / 1000)));
      row.addEventListener("click", () => onTap(tr, i));
      box.appendChild(row);
    });
  }
  function spTiles(parent, list, kind) {
    const g = el("div", "el-sgrid");
    list.forEach((it) => {
      if (!it) return;
      const b = el("div", "el-li" + (kind === "artist" ? " artist" : ""));
      const a = el("div", "el-lia");
      const iu = spImg(it);
      if (iu) a.appendChild(artImg(iu));
      b.appendChild(a);
      const t = el("div", "el-lit");
      t.appendChild(txt("div", "el-lin", it.name));
      const by = kind === "playlist" ? (it.owner && it.owner.display_name) || "" : kind === "album" ? spArtists(it) : "";
      t.appendChild(txt("div", "el-lis", (kind === "artist" ? "Artist" : kind === "album" ? "Album" : "Playlist") + (by ? " · " + by : "")));
      b.appendChild(t);
      b.addEventListener("click", () => spOpenItem(kind, it));
      g.appendChild(b);
    });
    parent.appendChild(g);
  }
  function spOpenView(playingUri) {
    const o = spOpen;
    const box = el("div", "el-glass el-trk");
    const head = el("div", "el-trkh");
    const back = el("div", "el-trkb", svg("chev"));
    back.addEventListener("click", () => {
      spOpen = null;
      pages.music.render();
    });
    head.appendChild(back);
    const ti = el("div", "el-trkt");
    ti.appendChild(txt("b", "", o.item.name));
    const kind = o.kind === "album" ? "Album" : o.kind === "artist" ? "Artist" : "Playlist";
    ti.appendChild(txt("small", "", o.tracks ? kind + " · " + o.tracks.length + (o.tracks.length === 1 ? " song" : " songs") : kind));
    head.appendChild(ti);
    const all = el("div", "el-gbtn el-playall", svg("play") + "<span>Play all</span>");
    all.addEventListener("click", () => spPlay({ context_uri: o.item.uri }));
    head.appendChild(all);
    box.appendChild(head);
    if (o.err) box.appendChild(txt("div", "el-libmsg", o.err));
    else if (o.kind === "artist") {
      if (!o.albums) box.appendChild(txt("div", "el-libmsg", "Loading…"));
      else if (!o.albums.length) box.appendChild(txt("div", "el-libmsg", "No albums found."));
      else {
        box.appendChild(txt("div", "el-sh", "Albums & singles"));
        spTiles(box, o.albums, "album");
      }
    } else if (!o.tracks) box.appendChild(txt("div", "el-libmsg", "Loading songs…"));
    else if (!o.tracks.length) box.appendChild(txt("div", "el-libmsg", "No songs."));
    else spTrackRows(box, o.tracks, (tr) => spPlay({ context_uri: o.item.uri, offset: { uri: tr.uri } }), playingUri);
    return box;
  }
  function spDoSearch() {
    const q = spSrch.q.trim();
    if (!q) return;
    spSrch.kb = false;
    spSrch.busy = true;
    spSrch.err = null;
    spSrch.res = null;
    const n = ++spSrch.n;
    // Spotify allows at most 10 results per kind for apps like this one
    sp.api("GET", "/search?type=track,artist,album,playlist&limit=10&q=" + encodeURIComponent(q)).then(
      (r) => {
        if (n !== spSrch.n) return;
        spSrch.busy = false;
        spSrch.res = r || {};
        if (current === "music") pages.music.render();
      },
      (e) => {
        if (n !== spSrch.n) return;
        spSrch.busy = false;
        spSrch.err = (e && e.message) || "search failed";
        if (current === "music") pages.music.render();
      },
    );
    pages.music.render();
  }
  function spSearchPanel(playingUri) {
    const st = spSrch;
    const box = el("div", "el-glass el-srch");
    const bar = el("div", "el-sbar" + (st.kb ? " on" : ""), svg("search") + '<div class="el-sq"></div>');
    const sq = bar.querySelector(".el-sq");
    if (st.q) sq.textContent = st.q;
    else sq.appendChild(txt("span", "el-sph", "Search Spotify: songs, artists, albums"));
    if (st.kb) sq.appendChild(el("i", "el-caret"));
    bar.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest && ev.target.closest(".el-sx")) return;
      st.kb = true;
      pages.music.render();
    });
    if (st.q) {
      const x = txt("div", "el-sx", "×");
      x.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        st.q = "";
        st.res = null;
        st.kb = true;
        pages.music.render();
      });
      bar.appendChild(x);
    }
    box.appendChild(bar);
    if (st.kb) {
      box.appendChild(keyboard(st, spDoSearch));
      return box;
    }
    const out = el("div", "el-sres");
    const msg = (t) => out.appendChild(txt("div", "el-libmsg", t));
    if (st.busy) msg("Searching Spotify…");
    else if (st.err) msg("Spotify: " + st.err);
    else if (st.res) {
      const r = st.res;
      const items = (k) => ((r[k] && r[k].items) || []).filter(Boolean);
      const tracks = items("tracks");
      if (tracks.length) {
        out.appendChild(txt("div", "el-sh", "Songs"));
        spTrackRows(out, tracks, (tr, i) => spPlay({ uris: tracks.slice(i).map((t) => t.uri) }), playingUri);
      }
      [
        ["artists", "Artists", "artist"],
        ["albums", "Albums", "album"],
        ["playlists", "Playlists", "playlist"],
      ].forEach((k) => {
        const l = items(k[0]);
        if (!l.length) return;
        out.appendChild(txt("div", "el-sh", k[1]));
        spTiles(out, l, k[2]);
      });
      if (!out.children.length) msg("Nothing found for “" + st.q.trim() + "”.");
    }
    box.appendChild(out);
    return box;
  }
  function renderSP(p) {
    artGen++;
    p.innerHTML = "";
    sp.start();
    const pl = sp.player || {};
    const item = pl.item || null;
    const dev = sp.activeDevice();
    const playingUri = item && item.uri;
    const wrap = el("div", "el-mam");
    // now playing
    const np = el("div", "el-glass el-np");
    const sw = spSwitch();
    if (sw) np.appendChild(sw);
    const art = el("div", "el-art");
    const au = spImg(item);
    if (au) art.appendChild(artImg(au, "np"));
    np.appendChild(art);
    np.appendChild(txt("div", "el-tt", item ? item.name : sp.error ? "Spotify isn't connected" : "Pick something to play"));
    np.appendChild(txt("div", "el-ar", item ? spArtists(item) : sp.error ? sp.error : dev ? "on " + dev.name : "Spotify"));
    const ctl = el("div", "el-ctl");
    const prev = el("div", "el-round", svg("prev"));
    const play = el("div", "el-round el-play", svg(pl.is_playing ? "pause" : "play"));
    const next = el("div", "el-round", svg("next"));
    prev.addEventListener("click", () => sp.cmd("POST", "/me/player/previous").catch((e) => spErr(e)));
    next.addEventListener("click", () => sp.cmd("POST", "/me/player/next").catch((e) => spErr(e)));
    play.addEventListener("click", () => {
      pl.is_playing = !pl.is_playing;
      pages.music.render();
      sp.cmd("PUT", pl.is_playing ? "/me/player/play" : "/me/player/pause").catch((e) => spErr(e));
    });
    ctl.appendChild(prev);
    ctl.appendChild(play);
    ctl.appendChild(next);
    np.appendChild(ctl);
    wrap.appendChild(np);
    const right = el("div", "el-mright");
    // volume of the speaker Spotify is playing on
    const hv = holds["SPV"];
    const vl = (hv && Date.now() < hv.until ? hv.v : dev && typeof dev.volume_percent === "number" ? dev.volume_percent : 0) / 100;
    const vol = el("div", "el-glass el-vol", svg("vol") + '<div class="el-slider"><div class="el-fill"></div></div><span class="el-volpc"></span>');
    vol.querySelector(".el-fill").style.width = vl * 100 + "%";
    vol.querySelector(".el-volpc").textContent = Math.round(vl * 100) + "%";
    const sl = vol.querySelector(".el-slider");
    const setV = (ev, commit) => {
      const r = sl.getBoundingClientRect();
      const v = clamp((ev.clientX - r.left) / r.width, 0, 1);
      vol.querySelector(".el-fill").style.width = v * 100 + "%";
      vol.querySelector(".el-volpc").textContent = Math.round(v * 100) + "%";
      if (commit) {
        hold("SPV", Math.round(v * 100));
        sp.volume(Math.round(v * 100)).catch((e) => spErr(e));
      }
    };
    sl.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      dragging = true;
      window.__arClaimGesture = true;
      try {
        sl.setPointerCapture(ev.pointerId);
      } catch (x) {
        /* ignore */
      }
      setV(ev, false);
      sl.onpointermove = (m) => setV(m, false);
    });
    const endV = (ev) => {
      if (!dragging) return;
      dragging = false;
      window.__arClaimGesture = false;
      sl.onpointermove = null;
      setV(ev, true);
    };
    sl.addEventListener("pointerup", endV);
    sl.addEventListener("pointercancel", endV);
    right.appendChild(vol);
    // Spotify Connect speakers: tap to play there
    if (spTab !== "search") {
      const row = el("div", "el-spkrow");
      if (!sp.devices.length)
        row.appendChild(txt("div", "el-spkc", sp.error ? "Spotify: " + sp.error : "No Spotify speakers awake: open Spotify on one, or use the Spotify app"));
      sp.devices.forEach((d) => {
        const c = el("div", "el-spkc" + (d.is_active ? " on" : ""), svg("speaker") + '<div class="el-spkt"><span></span><small></small></div>');
        c.querySelector("span").textContent = d.name;
        c.querySelector("small").textContent = d.is_active ? (pl.is_playing ? "Playing on" : "Selected") : "Tap to play here";
        c.addEventListener("click", () => {
          if (d.is_active) return;
          sp.devices.forEach((x) => (x.is_active = x.id === d.id));
          pages.music.render();
          sp.transfer(d.id).then(() => toast("Spotify now plays on " + d.name), (e) => spErr(e));
        });
        row.appendChild(c);
      });
      right.appendChild(row);
    }
    const tabs = el("div", "el-libtabs");
    [
      ["playlists", "Playlists"],
      ["liked", "Liked songs"],
      ["search", "Search"],
    ].forEach((t) => {
      const b = txt("div", "el-tab" + (spTab === t[0] ? " on" : ""), t[1]);
      b.addEventListener("click", () => {
        spTab = t[0];
        spOpen = null;
        pages.music.render();
      });
      tabs.appendChild(b);
    });
    const appb = el("div", "el-tab el-appb", svg("play") + "<span>Spotify app</span>");
    appb.addEventListener("click", openSpotifyApp);
    tabs.appendChild(appb);
    right.appendChild(tabs);
    if (spOpen) right.appendChild(spOpenView(playingUri));
    else if (spTab === "search") right.appendChild(spSearchPanel(playingUri));
    else {
      const items = spLib[spTab];
      if (spTab === "liked") {
        const box = el("div", "el-glass el-trk");
        if (!items) {
          box.appendChild(txt("div", "el-libmsg", "Loading…"));
          spLoad(spTab);
        } else if (!items.length) box.appendChild(txt("div", "el-libmsg", spLib.liked_err ? "Spotify: " + spLib.liked_err : "No liked songs yet."));
        else spTrackRows(box, items, (tr, i) => spPlay({ uris: items.slice(i, i + 50).map((t) => t.uri) }), playingUri);
        right.appendChild(box);
      } else {
        const lib = el("div", "el-glass el-lib");
        if (!items) {
          lib.appendChild(txt("div", "el-libmsg", "Loading…"));
          spLoad(spTab);
        } else if (!items.length) lib.appendChild(txt("div", "el-libmsg", spLib.playlists_err ? "Spotify: " + spLib.playlists_err : "No playlists in this Spotify account."));
        else
          items.forEach((it) => {
            const b = el("div", "el-li");
            const a = el("div", "el-lia");
            const iu = spImg(it);
            if (iu) a.appendChild(artImg(iu));
            b.appendChild(a);
            const t = el("div", "el-lit");
            t.appendChild(txt("div", "el-lin", it.name));
            t.appendChild(txt("div", "el-lis", "Playlist" + (it.owner && it.owner.display_name ? " · " + it.owner.display_name : "")));
            b.appendChild(t);
            b.addEventListener("click", () => spOpenItem("playlist", it));
            lib.appendChild(b);
          });
        right.appendChild(lib);
      }
    }
    wrap.appendChild(right);
    p.appendChild(wrap);
  }

  if (spOn) {
    // Spotify polls every 4 s while its screen is open: redraw only on a change
    let spSig = "";
    sp.onChange = () => {
      if (current !== "music" || !useSP() || dragging || turning()) return;
      if (spTab === "search" && spSrch.kb && !spOpen) return; // typing
      const pl = sp.player || {};
      const it = pl.item || {};
      const sig = [sp.error, pl.is_playing, it.uri, (pl.device || {}).id, (pl.device || {}).volume_percent, sp.devices.map((d) => d.id + d.is_active + d.volume_percent).join(",")].join("|");
      if (sig === spSig) return;
      spSig = sig;
      pages.music.render();
    };
  }
  if (maOn) {
    // Music Assistant sends a burst of player updates when speakers group (every
    // member, every sync step, play-position ticks). Redrawing on each one froze
    // the Source 10 until the app restarted, so updates are batched (one redraw
    // per 400 ms at most) and only redraw when something on screen changed.
    let maTimer = null;
    let maSig = "";
    const maSignature = () =>
      ma.status +
      "|" +
      ma
        .list()
        .map((x) => {
          const m = x.current_media || {};
          return [x.player_id, maName(x), maState(x), x.volume_level, x.synced_to || "", (x.group_members || []).join(","), (x.can_group_with || []).length, m.title || "", m.artist || "", m.uri || "", m.image_url || ""].join("~");
        })
        .join("^");
    const flush = () => {
      maTimer = null;
      if (dragging || turning() || (current === "music" && libTab === "search" && srch.kb && !libOpen)) {
        maTimer = setTimeout(flush, 400); // busy: try again shortly
        return;
      }
      const sig = maSignature();
      if (sig === maSig) return;
      maSig = sig;
      if (current === "music" && !useSP()) pages.music.render();
      else if (current === "home") pages.home.render();
    };
    ma.onChange = () => {
      if (!maTimer) maTimer = setTimeout(flush, 400);
    };
  }

  // music: HA media players (when Music Assistant isn't set up) -----------------
  let mIdx = 0;
  if (ents.music) {
    const mp = mkPage("music");
    mp.render = function () {
      if (dragging) return;
      if (useSP()) return renderSP(mp.el);
      if (maOn) return renderMA(mp.el);
      const e = ents.music[mIdx] || ents.music[0];
      const s = get(e);
      const p = mp.el;
      p.innerHTML = "";
      const wrap = el("div", "el-music");
      const np = el("div", "el-glass el-np");
      const art = el("div", "el-art");
      if (s.pic) {
        const img = el("img");
        img.src = s.pic;
        img.onerror = () => img.remove();
        art.appendChild(img);
      }
      np.appendChild(art);
      np.appendChild(txt("div", "el-tt", s.title || (s.on ? "Nothing playing" : "Off")));
      np.appendChild(txt("div", "el-ar", [s.artist, s.app || s.source].filter(Boolean).join(" · ") || nameOf(e)));
      const ctl = el("div", "el-ctl");
      const prev = el("div", "el-round", svg("prev"));
      const play = el("div", "el-round el-play", svg(s.value === "playing" ? "pause" : "play"));
      const next = el("div", "el-round", svg("next"));
      prev.addEventListener("click", () => send("media", { entity: e, cmd: "previous" }));
      next.addEventListener("click", () => send("media", { entity: e, cmd: "next" }));
      play.addEventListener("click", () => {
        patch(e, { value: s.value === "playing" ? "paused" : "playing" });
        send("media", { entity: e, cmd: "play_pause" });
        mp.render();
      });
      ctl.appendChild(prev);
      ctl.appendChild(play);
      ctl.appendChild(next);
      np.appendChild(ctl);
      wrap.appendChild(np);
      const side = el("div", "el-side");
      const vol = el("div", "el-glass el-vol", svg("vol") + '<div class="el-slider"><div class="el-fill"></div></div><span class="el-volpc"></span>');
      paintVol(vol, s);
      const sl = vol.querySelector(".el-slider");
      const set = (ev, commit) => {
        const r = sl.getBoundingClientRect();
        const v = clamp((ev.clientX - r.left) / r.width, 0, 1);
        patch(e, { vol: v });
        paintVol(vol, get(e));
        if (commit) send("volume", { entity: e, v: v });
      };
      sl.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        dragging = true;
        window.__arClaimGesture = true;
        try {
          sl.setPointerCapture(ev.pointerId);
        } catch (x) {
          /* ignore */
        }
        set(ev, false);
        sl.onpointermove = (m) => set(m, false);
      });
      const end = (ev) => {
        if (!dragging) return;
        dragging = false;
        window.__arClaimGesture = false;
        sl.onpointermove = null;
        set(ev, true);
      };
      sl.addEventListener("pointerup", end);
      sl.addEventListener("pointercancel", end);
      side.appendChild(vol);
      const spk = el("div", "el-glass el-spk");
      ents.music.forEach((x, i) => {
        const ss = get(x);
        const b = el("div", "el-spkb" + (i === mIdx ? " on" : ""), svg("speaker") + "<div><span></span><small></small></div>");
        b.querySelector("span").textContent = nameOf(x);
        b.querySelector("small").textContent = ss.value === "playing" ? "Playing" + (ss.title ? " · " + ss.title : "") : cap(ss.value || "");
        b.addEventListener("click", () => {
          mIdx = i;
          mp.render();
        });
        spk.appendChild(b);
      });
      side.appendChild(spk);
      wrap.appendChild(side);
      p.appendChild(wrap);
    };
  }
  function paintVol(vol, s) {
    const v = typeof s.vol === "number" ? s.vol : 0;
    vol.querySelector(".el-fill").style.width = v * 100 + "%";
    vol.querySelector(".el-volpc").textContent = Math.round(v * 100) + "%";
  }

  // cameras: live HLS video from HA when it can, MJPEG snapshots otherwise ----
  const camStops = [];
  const camPlaying = {}; // entity -> url being played
  const camAsked = {};
  const camFailed = {};
  let camBig = null; // the camera tapped up to full size
  if (ents.cameras) {
    const cmp = mkPage("cameras");
    cmp.render = function () {
      stopCams(true); // keep RTSP players running: placeRtsp moves / trims them
      const p = cmp.el;
      const all = ents.cameras.slice(0, 4);
      if (camBig && all.indexOf(camBig) < 0) camBig = null;
      const shown = camBig ? [camBig] : all;
      const n = shown.length;
      const g = el("div", "el-cams c" + (n === 1 ? 1 : n === 2 ? 2 : 4));
      shown.forEach((e) => {
        const c = el("div", "el-cam");
        // tap a camera for full size, tap again for all of them
        c.addEventListener("click", () => {
          if (all.length < 2) return;
          camBig = camBig ? null : e;
          cmp.render();
        });
        if (isRtsp(e)) {
          // the Android app lays the live video over this tile (placeRtsp)
          c.setAttribute("data-rtsp", e);
          c.appendChild(txt("div", "el-camoff", native.isNative ? "Connecting…" : "RTSP camera: plays on the panel"));
          c.appendChild(txt("span", "el-live", "RTSP"));
          c.appendChild(txt("span", "el-cl", nameOf(e)));
          g.appendChild(c);
          return;
        }
        const s = get(e);
        let img = null;
        const mjpeg = () => {
          if (img) return;
          if (!s.stream) {
            c.appendChild(txt("div", "el-camoff", "No stream"));
            return;
          }
          img = el("img");
          img.src = s.stream;
          img.onerror = () => {
            if (!img) return;
            img.remove();
            img = null;
            if (!c.querySelector("video.playing")) c.appendChild(txt("div", "el-camoff", "Camera offline"));
          };
          c.insertBefore(img, c.firstChild);
        };
        // the snapshot stream shows straight away; live video fades in over it
        // only once it really has a picture, and stays hidden if it never does
        mjpeg();
        const live = txt("span", "el-live snap", "SNAPSHOT");
        if (s.hls && !camFailed[s.hls]) {
          const v = el("video");
          c.appendChild(v);
          camPlaying[e] = s.hls;
          v.addEventListener("playing", () => {
            v.classList.add("playing");
            live.textContent = "LIVE";
            live.classList.remove("snap");
            if (img) {
              img.onerror = null;
              img.src = ""; // stop the MJPEG stream behind the video
              img.remove();
              img = null;
            }
            const off = c.querySelector(".el-camoff");
            if (off) off.remove();
          });
          camStops.push(
            playHls(v, s.hls, () => {
              camFailed[s.hls] = true;
              v.remove();
              live.textContent = "SNAPSHOT";
              live.classList.add("snap");
              mjpeg();
            }),
          );
        } else {
          camPlaying[e] = null;
          // ask HA for the live stream; it arrives as an update with "hls"
          if (!camAsked[e]) {
            camAsked[e] = true;
            send("camera_stream", { entity: e });
          }
        }
        c.appendChild(live);
        c.appendChild(txt("span", "el-cl", nameOf(e)));
        g.appendChild(c);
      });
      p.appendChild(g);
      placeRtsp();
    };
  }
  // Lay the RTSP players over their tiles (screen pixels), once the page has its layout.
  function placeRtsp() {
    if (!native.isNative || !pages.cameras) return;
    (window.requestAnimationFrame || ((f) => setTimeout(f, 16)))(() => {
      // a dashboard rebuilt after a settings push must not touch the new one's videos
      if (current !== "cameras" || covered || !root.isConnected) return;
      const dpr = window.devicePixelRatio || 1;
      const ids = [];
      Array.prototype.forEach.call(pages.cameras.el.querySelectorAll("[data-rtsp]"), (t) => {
        const e = t.getAttribute("data-rtsp");
        const r = t.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        ids.push(e);
        native.rtspShow(e, rtspCam(e).url, nameOf(e), Math.round(r.left * dpr), Math.round(r.top * dpr), Math.round(r.width * dpr), Math.round(r.height * dpr));
      });
      native.rtspRetain(ids);
    });
  }
  // something covers the cameras page (screensaver, settings, room picker):
  // native video sits on top of the page, so take it down until it's back
  let covered = false;
  function cover(on) {
    if (!root.isConnected) return;
    covered = !!on;
    if (covered) native.rtspHideAll();
    else if (current === "cameras" && pages.cameras) pages.cameras.render();
  }
  window.__arCover = (on) => {
    if (root.isConnected) cover(on);
  };
  native.on("rtsp", (d) => {
    if (!root.isConnected || !d || d.event !== "tap" || current !== "cameras") return;
    if ((ents.cameras || []).length < 2) return;
    camBig = camBig ? null : d.id;
    pages.cameras.render();
  });
  native.on("resume", () => {
    if (root.isConnected && current === "cameras" && !covered && pages.cameras) pages.cameras.render();
  });
  function stopCams(keepRtsp) {
    while (camStops.length) camStops.pop()();
    if (!keepRtsp) native.rtspHideAll();
    if (!pages.cameras) return;
    Array.prototype.forEach.call(pages.cameras.el.querySelectorAll("img"), (i) => (i.src = ""));
    pages.cameras.el.innerHTML = "";
  }
  function camsChanged() {
    return (ents.cameras || []).slice(0, 4).some((e) => {
      if (isRtsp(e)) return false;
      const h = get(e).hls;
      return (h && !camFailed[h] ? h : null) !== (camPlaying[e] || null);
    });
  }

  // security
  let pin = null;
  if (ents.security) {
    const ap = mkPage("security");
    ap.render = function () {
      const e = ents.security[0];
      const s = get(e);
      const p = ap.el;
      p.innerHTML = "";
      const wrap = el("div", "el-sec");
      const armed = s.on;
      const st = el("div", "el-glass el-armstate" + (armed ? " armed" : ""), '<div class="el-shield">' + svg(armed ? "lock" : "security") + '</div><h3></h3><p></p>');
      st.querySelector("h3").textContent = alarmName(s.value);
      st.querySelector("p").textContent = nameOf(e);
      wrap.appendChild(st);
      const btns = el("div", "el-armbtns");
      [
        ["away", "Away", "Everyone's out", "lock"],
        ["home", "Home", "Perimeter only", "house"],
        ["night", "Night", "Sleeping", "moon"],
        ["disarm", "Disarm", "Switch off", "unlock"],
      ].forEach((m) => {
        const on = (m[0] === "disarm" && s.value === "disarmed") || s.value === "armed_" + m[0];
        const b = el("div", "el-glass el-armb" + (on ? " on" : ""), svg(m[3]) + "<b></b><span></span>");
        b.querySelector("b").textContent = m[1];
        b.querySelector("span").textContent = m[2];
        b.addEventListener("click", () => {
          if (s.code) openPin(e, m[0], m[1]);
          else send("arm", { entity: e, mode: m[0] });
        });
        btns.appendChild(b);
      });
      wrap.appendChild(btns);
      p.appendChild(wrap);
      if (pin) p.appendChild(pin);
    };
  }
  function openPin(e, mode, label) {
    let code = "";
    pin = el("div", "el-pin");
    const box = el("div", "el-glass el-pinbox");
    const t = txt("div", "el-pint", label + ": enter code");
    const dots = el("div", "el-pindots");
    box.appendChild(t);
    box.appendChild(dots);
    const pad = el("div", "el-pad");
    "1 2 3 4 5 6 7 8 9 ✕ 0 ✓".split(" ").forEach((k) => {
      const b = txt("div", "el-key" + (k === "✓" ? " ok" : ""), k);
      b.addEventListener("click", () => {
        if (k === "✕") {
          pin = null;
          pages.security.render();
          return;
        }
        if (k === "✓") {
          send("arm", { entity: e, mode: mode, code: code });
          pin = null;
          pages.security.render();
          return;
        }
        if (code.length < 10) code += k;
        dots.textContent = "•".repeat(code.length);
      });
      pad.appendChild(b);
    });
    box.appendChild(pad);
    pin.appendChild(box);
    pages.security.render();
  }

  root.appendChild(dock);

  // --- navigation + chrome --------------------------------------------------------
  let current = "home";
  function go(k) {
    if (!pages[k] || (k !== "home" && !curCats().some((c) => c.key === k))) k = "home";
    if (current === "cameras" && k !== "cameras") {
      stopCams();
      for (const k2 in camAsked) delete camAsked[k2];
    }
    current = k;
    pin = null;
    if (k === "music" && maOn) ma.start();
    if (sp) {
      if (k === "music" && useSP()) sp.start();
      else sp.stop();
    }
    Object.keys(pages).forEach((n) => pages[n].el.classList.toggle("show", n === k));
    Array.prototype.forEach.call(dock.children, (b) => b.classList.toggle("on", b.getAttribute("data-go") === k));
    title.textContent = k === "home" ? "Home" : (CATS.filter((c) => c.key === k)[0] || {}).title;
    pages[k].render();
  }

  function chrome() {
    const d = new Date();
    clock.textContent = pad(d.getHours()) + ":" + pad(d.getMinutes());
    const w = ctx.get("weather");
    wxChip.innerHTML = w && typeof w.temperature === "number" ? svg("sun") + "<span>" + Math.round(w.temperature) + "°</span>" : "";
    if (ents.security) {
      secChip.innerHTML = svg("security") + "<span></span>";
      secChip.lastChild.textContent = alarmName(get(ents.security[0]).value);
    }
    const anyOn = (ents.lights || []).some((e) => get(e).on);
    room.classList.toggle("dim", !!ents.lights && !anyOn);
  }

  function fit() {
    const f = window.__arFit || {};
    const stageH = f.stageH || 288;
    const H = Math.round((stageH * W) / 480);
    root.style.height = H + "px";
    root.classList.toggle("tall", H > 760);
  }

  // --- rooms -------------------------------------------------------------------------
  function applyRoom(i, wh) {
    whole = !!wh;
    if (!whole) roomIdx = clamp(i, 0, ROOMS.length - 1);
    const r = ROOMS[roomIdx];
    ROOM_KEYS.forEach((k) => {
      if (k !== "scenes") ents[k] = whole ? union[k] : r[k];
    });
    scenes = (whole ? union.scenes : r.scenes).slice(0, 4);
    selLight = 0;
    selShade = 0;
    climIdx = 0;
    mIdx = 0;
    const name = whole ? "Whole House" : r.name;
    const many = ROOMS.length > 1 || wholeOn;
    sub.textContent = (name || "Home") + (many ? " ▾" : "");
    sub.style.display = name || many ? "" : "none";
    sub.classList.toggle("pick", many);
    buildDock();
  }
  const sheet = el("div", "el-sheet");
  root.appendChild(sheet);
  function roomLine(r) {
    const n = r.lights.filter((e) => get(e).on).length;
    const bits = [n ? n + (n === 1 ? " light on" : " lights on") : r.lights.length ? "Lights off" : ""];
    const c = r.climate[0] && get(r.climate[0]);
    if (c && c.value && c.value !== "off" && typeof c.temp === "number") bits.push(fmtT(c.temp) + "°");
    const m = r.music.map(get).filter((x) => x.value === "playing")[0];
    if (m) bits.push("♪ " + (m.title || "Playing"));
    return bits.filter(Boolean).join(" · ") || "—";
  }
  function openRooms() {
    sheet.innerHTML = "";
    const dim = el("div", "el-sheetdim");
    dim.addEventListener("click", closeRooms);
    sheet.appendChild(dim);
    const pn = el("div", "el-sheetpanel");
    pn.appendChild(txt("div", "el-lbl", "Rooms"));
    const g = el("div", "el-roomgrid");
    ROOMS.forEach((r, i) => {
      const lit = r.lights.some((e) => get(e).on);
      const c = el("div", "el-rc" + (lit ? " lit" : "") + (!whole && i === roomIdx ? " cur" : ""), '<span class="el-ri">' + svg(r.icon) + "</span><div><b></b><small></small></div>");
      c.querySelector("b").textContent = r.name || "Room " + (i + 1);
      c.querySelector("small").textContent = roomLine(r);
      c.addEventListener("click", () => pickRoom(i, false));
      g.appendChild(c);
    });
    if (wholeOn) {
      const all = union.lights.filter((e) => get(e).on).length;
      const c = el("div", "el-rc house" + (all ? " lit" : "") + (whole ? " cur" : ""), '<span class="el-ri">' + svg("house") + "</span><div><b>Whole House</b><small></small></div>");
      c.querySelector("small").textContent = all ? all + " lights on across " + ROOMS.filter((r) => r.lights.some((e) => get(e).on)).length + " rooms" : "Everything is off";
      c.addEventListener("click", () => pickRoom(0, true));
      g.appendChild(c);
    }
    pn.appendChild(g);
    sheet.appendChild(pn);
    sheet.classList.add("open");
    cover(true);
  }
  function closeRooms() {
    sheet.classList.remove("open");
    cover(false);
  }
  function pickRoom(i, wh) {
    applyRoom(i, wh);
    closeRooms();
    go(current);
    toast(whole ? "Whole House" : ROOMS[roomIdx].name || "Room " + (roomIdx + 1));
  }

  // --- knob session: local value wins while turning ----------------------------
  const holds = {};
  const KNOB_HOLD_MS = 1500;
  let kLastDir = 0;
  let kLastAt = 0;
  function hold(k, v) {
    if (v === undefined) return holds[k] ? holds[k].v : undefined;
    holds[k] = { v: v, until: Date.now() + KNOB_HOLD_MS };
    return v;
  }
  function held(k, fallback) {
    const h = holds[k];
    return h && Date.now() < h.until ? h.v : fallback();
  }
  function turning() {
    for (const k in holds) if (Date.now() < holds[k].until) return true;
    return false;
  }
  const sendQ = {};
  function throttle(k, fn) {
    const q = sendQ[k] || (sendQ[k] = { busy: false, next: null });
    if (q.busy) {
      q.next = fn;
      return;
    }
    q.busy = true;
    fn();
    setTimeout(function flush() {
      if (q.next) {
        const f = q.next;
        q.next = null;
        f();
        setTimeout(flush, 250);
      } else q.busy = false;
    }, 250);
  }
  // redraw from the panel's own value, at most once per frame
  let rafPending = false;
  function repaint(k) {
    if (rafPending) return;
    rafPending = true;
    (window.requestAnimationFrame || ((f) => setTimeout(f, 16)))(() => {
      rafPending = false;
      if (current === k) pages[k].render();
    });
  }

  // Re-rendering a page rebuilds it, which would throw a scrolled list (lots
  // of lights in Whole House, rooms, speakers) back to the top on every HA
  // update: keep each list's scroll position across renders.
  const SCROLLERS = ".el-cards,.el-modes,.el-spk,.el-sheetpanel,.el-grp,.el-lib,.el-trk,.el-sres";
  Object.keys(pages).forEach((k) => {
    const pg = pages[k];
    const render = pg.render;
    pg.render = function () {
      const before = Array.prototype.map.call(pg.el.querySelectorAll(SCROLLERS), (x) => x.scrollTop);
      const r = render.apply(this, arguments);
      if (before.some((t) => t > 0)) {
        Array.prototype.forEach.call(pg.el.querySelectorAll(SCROLLERS), (x, i) => {
          if (before[i]) x.scrollTop = before[i];
        });
      }
      return r;
    };
  });

  let tick = null;
  let updTimer = null;
  fit();
  applyRoom(roomIdx, false);
  go("home");
  chrome();

  return {
    el: page,
    keys: keys,
    update(key) {
      chrome();
      if (turning()) return;
      if (!LITE) return redrawNow(); // Source 10 / NSPanel: exactly as before
      // Source 7 (slow chip): a busy house sends bursts of updates, so redraw once per batch
      if (updTimer) return;
      updTimer = setTimeout(() => {
        updTimer = null;
        if (turning() || dragging) return;
        if (current === "cameras") {
          // never restart running video for an unrelated update
          if (camsChanged()) pages.cameras.render();
        } else if (current === "music" && (maOn || spOn)) {
          // the Music Assistant page reads Music Assistant, not HA states:
          // a light or sensor changing elsewhere must not redraw it
        } else pages[current].render();
      }, 300);
      function redrawNow() {
        if (current === "cameras") {
          if (camsChanged()) pages.cameras.render();
        } else if (current === "music" && (maOn || spOn)) {
          /* the music page reads Music Assistant / Spotify, not HA states */
        } else pages[current].render();
      }
    },
    onShow() {
      fit();
      if (maOn) ma.start();
      clearInterval(tick);
      tick = setInterval(() => {
        chrome();
        if (current === "home") pages.home.render();
      }, 20000);
      go(current);
    },
    onHide() {
      clearInterval(tick);
      if (sp) sp.stop();
      stopCams();
    },
    // hardware knob: while it's turning, the panel's own value is the truth
    // (updates coming back from HA / Music Assistant mid-spin are ignored so
    // the level can't jump back), commands go out at most every 250 ms, and a
    // brisk spin takes bigger steps.
    knob(dir) {
      const now = Date.now();
      const fast = dir === kLastDir && now - kLastAt < 90 ? 3 : dir === kLastDir && now - kLastAt < 180 ? 2 : 1;
      kLastDir = dir;
      kLastAt = now;
      if (current === "lights" && ents.lights) {
        const e = ents.lights[selLight];
        if (!e) return false;
        if (!(e.split(".")[0] === "light" && get(e).dim !== false)) {
          // switch / on-off light: right = on, left = off, first click either way
          const on = dir > 0;
          if (!!get(e).on !== on) {
            patch(e, { on: on });
            throttle("L" + e, () => send("dim", { entity: e, v: on ? 1 : 0 }));
          }
          repaint("lights");
          return true;
        }
        const cur = held("L" + e, () => levelOf(e, "light"));
        const v = clamp(Math.round((cur + dir * 0.05 * fast) * 100) / 100, 0, 1);
        hold("L" + e, v);
        patch(e, { on: v > 0, brightness: Math.max(0.01, v) });
        throttle("L" + e, () => send("dim", { entity: e, v: hold("L" + e) }));
        repaint("lights");
        return true;
      }
      if (current === "shades" && ents.shades) {
        const e = ents.shades[selShade];
        if (!e) return false;
        if (e.split(".")[0] !== "cover") {
          // a switch in the shades list: right = on, left = off
          const open = dir > 0;
          if (!!get(e).on !== open) {
            patch(e, { on: open });
            throttle("S" + e, () => send("toggle", { entity: e }));
          }
          repaint("shades");
          return true;
        }
        const cur = held("S" + e, () => levelOf(e, "cover"));
        const v = clamp(Math.round((cur + dir * 0.05 * fast) * 100) / 100, 0, 1);
        hold("S" + e, v);
        patch(e, { pos: Math.round(v * 100), on: v > 0 });
        throttle("S" + e, () => send("position", { entity: e, v: hold("S" + e), dir: dir }));
        repaint("shades");
        return true;
      }
      if (current === "music" && useSP()) {
        const d = sp.activeDevice();
        if (!d) return false;
        const cur = held("SPV", () => (typeof d.volume_percent === "number" ? d.volume_percent : 0));
        const v = clamp(Math.round(cur + dir * 2 * fast), 0, 100);
        hold("SPV", v);
        throttle("SPV", () => sp.volume(hold("SPV")).catch(() => {}));
        repaint("music");
        return true;
      }
      if (current === "music" && maOn && ma.status === "ready") {
        const pl = maTargetPlayer();
        if (!pl) return false;
        const id = pl.player_id;
        const cur = held("M" + id, () => (typeof pl.volume_level === "number" ? pl.volume_level : 0));
        const v = clamp(Math.round(cur + dir * 2 * fast), 0, 100);
        hold("M" + id, v);
        // grouped: the whole zone follows, every speaker at the same level
        throttle("M" + id, () => {
          const lv = hold("M" + id);
          if (groupSize(pl) > 1) matchVolume(zoneIds(pl), lv);
          else ma.cmd("players/cmd/volume_set", { player_id: id, volume_level: lv }).catch(() => {});
        });
        repaint("music");
        return true;
      }
      if (current === "music" && ents.music && ents.music.length) {
        const e = ents.music[mIdx];
        const cur = held("V" + e, () => (typeof get(e).vol === "number" ? get(e).vol : 0));
        const v = clamp(Math.round((cur + dir * 0.02 * fast) * 100) / 100, 0, 1);
        hold("V" + e, v);
        patch(e, { vol: v });
        throttle("V" + e, () => send("volume", { entity: e, v: hold("V" + e) }));
        repaint("music");
        return true;
      }
      if (current === "climate" && ents.climate) {
        const e = ents.climate[climIdx];
        const s0 = get(e);
        if (typeof s0.temp !== "number") return true;
        const step = typeof s0.step === "number" ? s0.step : 0.5;
        const cur = held("C" + e, () => s0.temp);
        const t = clamp(Math.round((cur + dir * step) * 10) / 10, typeof s0.min === "number" ? s0.min : 7, typeof s0.max === "number" ? s0.max : 35);
        hold("C" + e, t);
        patch(e, { temp: t });
        throttle("C" + e, () => send("temp", { entity: e, v: hold("C" + e) }));
        repaint("climate");
        return true;
      }
      return false;
    },
    knobPress() {
      if (current === "lights" && ents.lights && ents.lights[selLight]) {
        const e = ents.lights[selLight];
        patch(e, { on: !get(e).on });
        send("toggle", { entity: e });
        pages.lights.render();
        return true;
      }
      if (current === "music" && useSP()) {
        const pl = sp.player || {};
        sp.cmd("PUT", pl.is_playing ? "/me/player/pause" : "/me/player/play").catch(() => {});
        return true;
      }
      if (current === "music" && maOn && ma.status === "ready") {
        const pl = maTargetPlayer();
        if (pl) ma.cmd(maState(pl) === "playing" ? "players/cmd/pause" : "players/cmd/play", { player_id: pl.player_id }).catch(() => {});
        return true;
      }
      if (current === "music" && ents.music && ents.music.length) {
        send("media", { entity: ents.music[mIdx], cmd: "play_pause" });
        return true;
      }
      if (current !== "home") {
        go("home");
        return true;
      }
      return false;
    },
  };
}

function pad(n) {
  return (n < 10 ? "0" : "") + n;
}
function cap(s) {
  s = String(s || "").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function fmtT(t) {
  return Math.round(t * 10) % 10 ? (Math.round(t * 10) / 10).toFixed(1) : String(Math.round(t));
}
function alarmName(v) {
  const m = { disarmed: "Disarmed", armed_away: "Armed Away", armed_home: "Armed Home", armed_night: "Armed Night", armed_vacation: "Armed Vacation", arming: "Arming…", pending: "Entry delay", triggered: "ALARM", unavailable: "Unavailable" };
  return m[v] || cap(v || "Unknown");
}
