// Residence dashboard style (device.dashboardStyle = "residence").
//
// Runs on the Elegant engine (elegant.js): the same rooms, entities, pages,
// Music Assistant / Spotify, cameras, alarm, intercom and knob. This module adds
// only what is Residence's own: the icon home screen over a photo, the room
// drop-down, the bottom bar (Room Off + what's playing), Scenes and Watch pages,
// the shade windows, per-light lamp drawings and button icons. elegant.js only
// calls in here when the style is "residence", so the other styles never run it.
//
// Settings: device.residence = {
//   houseImage: "preset:villa" | "/local/…jpg",   background for every room
//   look: "s-flat"|"s-square"|"s-dome"|"s-metal"|"s-key"|"s-tile"|"s-porc"|"i-flat"|"i-shadow"|"i-reflect"|"i-glow"|"i-emboss"|"i-plinth"
//   iconShape: "ring" | "square" | "bare" (older; used when look is not set),   accent: "warm" | "brass" | "ice"
//   icons: { lights: {src: "lib:bulb_on" | "/local/…png", fill: bool}, … }
//   lightLook: "match" | "lamp" | "edison" | "downlight" | "bulb"
//   lightTypes: { "light.x": "lamp" | "edison" | "downlight" | "bulb" }
//   shadeTypes: { "cover.x": "roller" | "sheer" | "block" | "curtain" }
//   musicBar: "anywhere" | "room",   roomOffLights: bool (default true)
//   base: "http://ha:8123"   (added by Home Assistant when it publishes)
// }
// Per room (on device.elegant.rooms[i], ignored by the other styles):
//   watch: ["media_player.tv"], rsImage: "/local/…jpg"

import LIB from "./generated/residence-icons.json";

const LINE = {
  lights: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
  climate: '<path d="M10 4a2 2 0 0 1 4 0v9.3a4 4 0 1 1-4 0z"/><path d="M12 9v6.5"/><path d="M17.5 6h2.5M17.5 9.5h2.5"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  watch: '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 21h8M12 17v4"/>',
  shades: '<path d="M4 3h16"/><path d="M5 3v11h14V3"/><path d="M5 6.5h14M5 10h14"/><path d="M12 14v3"/><circle cx="12" cy="18.5" r="1.5"/>',
  security: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  cameras: '<path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.5"/>',
  scenes: '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  utilities: '<path d="M12 2.7 6.3 9a7 7 0 1 0 11.4 0z"/><path d="m12.5 10-2.5 4h4l-2.5 4"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  chevl: '<path d="M15 5l-7 7 7 7"/>',
  chevr: '<path d="M9 5l7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M9 5H20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z"/><path d="M12 9l6 6M18 9l-6 6"/>',
  home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  stop: '<rect x="8" y="8" width="8" height="8" rx="1.5"/>',
  open2: '<path d="M9 6l-6 6 6 6M3 12h8M15 6l6 6-6 6M21 12h-8"/>',
  close2: '<path d="M3 6l6 6-6 6M9 12H3M21 6l-6 6 6 6M15 12h6"/>',
  prev: '<path d="M19 6l-8 6 8 6zM7 6v12"/>',
  next: '<path d="M5 6l8 6-8 6zM17 6v12"/>',
  vol: '<path d="M4 10h3l5-4v12l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
  sparkle: '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  movie: '<rect x="3" y="6" width="18" height="13" rx="1.5"/><path d="M3 10h18M7 6l2 4M12 6l2 4M17 6l2 4"/>',
  dinner: '<path d="M7 3v8M5 3v4a2 2 0 0 0 4 0V3M7 11v10"/><path d="M17 3c-2 1-3 3.5-3 6v3h3v9"/>',
  relax: '<path d="M4 13h16v3a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/><path d="M6 13V9a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4M7 19v2M17 19v2"/>',
  party: '<path d="M4 20l5-14 9 9z"/><path d="M14 4l1 2M19 9l2-1M17 3l-1 3"/>',
  away: '<path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4M6 12h9"/>',
  read: '<path d="M4 5c3-1 6-.5 8 1.5 2-2 5-2.5 8-1.5v14c-3-1-6-.5-8 1.5-2-2-5-2.5-8-1.5z"/><path d="M12 6.5v14"/>',
};
const PLAY = '<path d="M7 4.5v15l12-7.5z"/>';
const PAUSE = '<path d="M8 5h3v14H8zM13 5h3v14h-3z"/>';
const line = (k, cls) => '<svg class="' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + (LINE[k] || LINE.sparkle) + "</svg>";
const filled = (p) => '<svg viewBox="0 0 24 24" fill="currentColor">' + p + "</svg>";

export const RS_TITLES = { lights: "Lights", climate: "Comfort", music: "Listen", watch: "Watch", shades: "Shades", cameras: "Cameras", utilities: "Utilities", security: "Security", scenes: "Scenes", calendar: "Calendar" };
const ORDER = ["lights", "climate", "music", "watch", "shades", "cameras", "utilities", "security", "scenes"];
const PRESETS = {"villa": "villa.jpg", "cape": "cape.jpg", "sunset-sea": "sunset-sea.jpg", "mountains": "mountains.jpg", "forest-mist": "forest-mist.jpg", "dunes": "dunes.jpg", "stars": "stars.jpg", "aurora": "aurora.jpg", "city-night": "city-night.jpg", "lounge": "lounge.jpg", "marble-white": "marble-white.jpg", "marble-black": "marble-black.jpg", "slate": "slate.jpg", "concrete": "concrete.jpg", "steel": "steel.jpg", "walnut": "walnut.jpg", "oak": "oak.jpg", "leather": "leather.jpg", "linen": "linen.jpg", "colour-midnight": "colour-midnight.jpg", "colour-emerald": "colour-emerald.jpg", "colour-bordeaux": "colour-bordeaux.jpg", "colour-champagne": "colour-champagne.jpg", "colour-graphite": "colour-graphite.jpg", "colour-twilight": "colour-twilight.jpg", "colour-lagoon": "colour-lagoon.jpg", "colour-amber": "colour-amber.jpg", "sky-blue": "sky-blue.jpg", "sky-high": "sky-high.jpg", "sky-golden": "sky-golden.jpg", "sky-dawn": "sky-dawn.jpg", "sky-moon": "sky-moon.jpg"};
const ACCENTS = { warm: "243,217,164", brass: "214,170,92", ice: "150,205,240" };
const LOOKS = ["lamp", "edison", "downlight", "bulb"];

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
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// a light's drawing from its name when the installer hasn't picked one
export function guessLightType(text) {
  const s = String(text || "").toLowerCase();
  if (/pendant|chandelier|hanging/.test(s)) return "lamp";
  if (/strip|led|cove|tape|under.?cab|plinth/.test(s)) return "bulb";
  if (/lamp|bedside|desk|reading|floor|table|edison|filament/.test(s)) return "edison";
  if (/down|spot|ceiling|recess|can\b|track/.test(s)) return "downlight";
  return "lamp";
}
export function guessShadeType(text) {
  const s = String(text || "").toLowerCase();
  if (/sheer|voile/.test(s)) return "sheer";
  if (/curtain|drape/.test(s)) return "curtain";
  if (/block|black.?out/.test(s)) return "block";
  return "roller";
}

export function mountResidence(a) {
  const rc = a.rcfg && typeof a.rcfg === "object" ? a.rcfg : {};
  const raw = (Array.isArray(a.cfg.rooms) ? a.cfg.rooms : []).filter((r) => r && typeof r === "object");
  const root = a.root;
  // the customer's own choices from the gear button, kept on this panel
  const prefsApi = a.ctx && a.ctx.prefs;
  let PREF = {};
  try {
    PREF = (prefsApi && prefsApi.get("residence")) || {};
  } catch (e) {
    PREF = {};
  }
  if (!PREF || typeof PREF !== "object") PREF = {};
  const savePref = () => prefsApi && prefsApi.set("residence", PREF);
  // button look: 7 button styles + 6 icons-only styles. Older configs only had iconShape (ring/square/bare)
  const LOOKS = [["s-flat", "Circle"], ["s-square", "Square"], ["s-dome", "Dome"], ["s-metal", "Metal"], ["s-key", "Keypad"], ["s-tile", "Glass tile"], ["s-porc", "Porcelain"],
    ["i-flat", "Plain"], ["i-shadow", "Standing shadow"], ["i-reflect", "Glass floor"], ["i-glow", "Backlit"], ["i-emboss", "Raised edge"], ["i-plinth", "Stand"]];
  const isLook = (v) => LOOKS.some((o) => o[0] === v);
  const SHAPE_LOOK = { ring: "s-flat", square: "s-square", bare: "i-flat" };
  const lookNow = () => (isLook(PREF.look) ? PREF.look : SHAPE_LOOK[PREF.shape] || (isLook(rc.look) ? rc.look : SHAPE_LOOK[rc.iconShape] || "s-flat"));
  const shapeNow = () => {
    const l = lookNow();
    return l === "s-square" || l === "s-key" || l === "s-tile" ? "square" : l.charAt(0) === "i" ? "bare" : "ring";
  };
  const accentNow = () => (ACCENTS[PREF.accent] ? PREF.accent : ACCENTS[rc.accent] ? rc.accent : "warm");
  function applyLook() {
    ["ring", "square", "bare"].forEach((s) => root.classList.toggle("rs-shape-" + s, s === shapeNow()));
    LOOKS.forEach((o) => root.classList.toggle("rs-look-" + o[0], o[0] === lookNow()));
    root.style.setProperty("--rs-acc", ACCENTS[accentNow()]);
  }
  applyLook();

  // --- images: presets ship with the integration, uploads live in /local ------
  function base() {
    if (typeof rc.base === "string" && /^https?:/i.test(rc.base)) return rc.base.replace(/\/+$/, "");
    return /^https?:/i.test(location.protocol) ? location.origin : "";
  }
  function url(src) {
    if (typeof src !== "string" || !src) return "";
    if (src.indexOf("preset:") === 0) {
      const f = PRESETS[src.slice(7)];
      return f ? base() + "/ar_nspanel_pro_static/residence/" + f : "";
    }
    if (/^(https?:|data:)/i.test(src)) return src;
    if (src.charAt(0) === "/") return base() + src;
    return src;
  }
  const libUrl = (k) => (LIB[k] ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(LIB[k].svg) : "");

  function onRoom() {
    background();
    const lb = offBtn.querySelector("span");
    if (lb) lb.textContent = a.whole() ? "All Off" : "Room Off";
    paintCalBtn();
  }
  function background() {
    const r = raw[a.roomIdx()] || {};
    const src = (PREF.bg && PRESETS[String(PREF.bg).slice(7)] ? PREF.bg : "") || (!a.whole() && r.rsImage) || rc.houseImage || "preset:villa";
    const u = url(src);
    a.roomEl.style.backgroundImage = u ? 'url("' + u.replace(/"/g, "%22") + '")' : "";
  }

  // --- what the home screen shows --------------------------------------------
  function has(k) {
    const e = a.ents();
    if (k === "security" || k === "scenes") return true; // always there
    if (k === "music") return (e.music && e.music.length) || a.maOn || a.spOn;
    if (k === "utilities") return (e.utilities && e.utilities.length) || a.hasSolar;
    return !!(e[k] && e[k].length);
  }
  const CAL_ON = rc.calendarOn !== false;
  function cats() {
    // the calendar opens from its button next to the clock, not from the grid
    return ORDER.filter(has)
      .map((k) => ({ key: k, title: RS_TITLES[k] }))
      .concat(CAL_ON ? [{ key: "calendar", title: RS_TITLES.calendar, hidden: true }] : []);
  }
  function title(k) {
    return RS_TITLES[k] || "";
  }
  function intercept(k) {
    if (k === "security" && !(a.ents().security || []).length) {
      a.toast("No alarm set up yet: add one in Device Setup");
      return true;
    }
    return false;
  }

  // --- lamp drawings and shade types -----------------------------------------
  function lightType(e) {
    const look = LOOKS.indexOf(rc.lightLook) >= 0 ? rc.lightLook : "match";
    if (look !== "match") return look;
    const t = rc.lightTypes && rc.lightTypes[e];
    return LOOKS.indexOf(t) >= 0 ? t : guessLightType(a.nameOf(e) + " " + e);
  }
  function shadeType(e) {
    const t = rc.shadeTypes && rc.shadeTypes[e];
    return ["roller", "sheer", "block", "curtain"].indexOf(t) >= 0 ? t : guessShadeType(a.nameOf(e) + " " + e);
  }

  // --- room helpers ------------------------------------------------------------
  function curRoom() {
    const R = a.rooms();
    if (a.whole()) {
      const all = { name: "Whole House", lights: [], climate: [], music: [], watch: [] };
      R.forEach((r) => ["lights", "climate", "music", "watch"].forEach((k) => (all[k] = all[k].concat(r[k] || []))));
      return all;
    }
    return R[a.roomIdx()] || { name: "", lights: [], climate: [], music: [], watch: [] };
  }
  function namesOf(r) {
    return [r.name].concat((r.music || []).map(a.nameOf)).map(norm).filter((x) => x.length > 2);
  }
  const matches = (name, r) => {
    const n = norm(name);
    return !!n && namesOf(r).some((x) => n.indexOf(x) >= 0 || x.indexOf(n) >= 0);
  };

  // --- what's playing (bottom bar) -----------------------------------------------
  // An amp on its optical / HDMI / TV input says "playing" with no song: that's
  // not music, so neither the bar nor the Listen button count it.
  const INPUT_RE = /optical|toslink|s\/?pdif|coax|hdmi|\barc\b|earc|\btv\b|television|line.?in|\baux|analog|digital.?in|game|blu.?ray|dvd/i;
  function haMusic(s) {
    if (!s || s.value !== "playing") return false;
    if (!s.title && !s.artist) return false; // nothing to show: an input, not a song
    return !INPUT_RE.test(String(s.source || "")) && !INPUT_RE.test(String(s.app || ""));
  }
  function maMusic(x) {
    if ((x.playback_state || x.state) !== "playing") return false;
    const m = x.current_media || {};
    if (!m.title && !m.artist) return false;
    // Music Assistant shows an amp's own input (optical, HDMI…) as its "media"
    return !INPUT_RE.test(String(x.active_source || "") + " " + (m.title || "") + " " + (m.media_type === "unknown" ? "line in" : ""));
  }
  function nowPlaying() {
    const onlyRoom = rc.musicBar === "room";
    const r = curRoom();
    const sp = a.sp;
    if (a.spOn && sp && sp.player && sp.player.is_playing && sp.player.item) {
      const dev = sp.player.device || {};
      if (!onlyRoom || matches(dev.name, r)) {
        const it = sp.player.item;
        const im = ((it.album && it.album.images) || [])[0];
        return {
          title: it.name,
          sub: "Spotify · " + (dev.name || ""),
          art: im && im.url,
          pause: () => sp.cmd("PUT", "/me/player/pause").catch(() => {}),
        };
      }
    }
    const ma = a.ma;
    if (a.maOn && ma && ma.status === "ready") {
      const pl = ma.list().filter((x) => maMusic(x) && !x.synced_to && (!onlyRoom || matches(x.display_name || x.name, r)))[0];
      if (pl) {
        const m = pl.current_media || {};
        return {
          title: m.title || m.artist,
          sub: [m.artist, pl.display_name || pl.name].filter(Boolean).join(" · "),
          art: m.image_url ? ma.imageUrl(m.image_url) : "",
          pause: () => ma.cmd("players/cmd/pause", { player_id: pl.player_id }).catch(() => {}),
        };
      }
    }
    const list = onlyRoom ? r.music || [] : a.union.music || [];
    const e = list.filter((x) => haMusic(a.get(x)))[0];
    if (e) {
      const s = a.get(e);
      return {
        title: s.title || s.artist,
        sub: [s.artist, a.nameOf(e)].filter(Boolean).join(" · "),
        art: s.pic || "",
        pause: () => {
          a.patch(e, { value: "paused" });
          a.send("media", { entity: e, cmd: "play_pause" });
        },
      };
    }
    return null;
  }
  function roomPlaying(r) {
    if ((r.music || []).some((e) => haMusic(a.get(e)))) return true;
    const sp = a.sp;
    if (a.spOn && sp && sp.player && sp.player.is_playing && matches((sp.player.device || {}).name, r)) return true;
    const ma = a.ma;
    return !!(a.maOn && ma && ma.status === "ready" && ma.list().some((x) => maMusic(x) && matches(x.display_name || x.name, r)));
  }

  // --- Room Off: lights (optional), AC, music and TV in this room ---------------
  function roomOff() {
    const r = curRoom();
    const done = [];
    if (rc.roomOffLights !== false) {
      let n = 0;
      (r.lights || []).forEach((e) => {
        if (!a.get(e).on) return;
        n++;
        a.patch(e, { on: false });
        a.send("dim", { entity: e, v: 0 });
      });
      if (n) done.push("lights");
    }
    let ac = 0;
    (r.climate || []).forEach((e) => {
      const s = a.get(e);
      if (s.value === "off") return;
      ac++;
      a.patch(e, { value: "off", on: false });
      a.send("hvac", { entity: e, mode: "off" });
    });
    if (ac) done.push("aircon");
    let mu = 0;
    (r.music || []).concat(r.watch || []).forEach((e) => {
      const s = a.get(e);
      if (!s.on && s.value !== "playing") return;
      mu++;
      a.patch(e, { on: false, value: "off" });
      a.send("dim", { entity: e, v: 0 }); // switches the player / TV off in Home Assistant
    });
    const sp = a.sp;
    if (a.spOn && sp && sp.player && sp.player.is_playing && matches((sp.player.device || {}).name, r)) {
      mu++;
      sp.cmd("PUT", "/me/player/pause").catch(() => {});
    }
    const ma = a.ma;
    if (a.maOn && ma && ma.status === "ready") {
      ma.list()
        .filter((x) => (x.playback_state || x.state) === "playing" && matches(x.display_name || x.name, r))
        .forEach((x) => {
          mu++;
          ma.cmd("players/cmd/pause", { player_id: x.synced_to || x.player_id }).catch(() => {});
        });
    }
    if (mu) done.push("music and TV");
    a.toast((r.name || "Room") + " off" + (done.length ? ": " + done.join(", ") : ""));
    setTimeout(chrome, 50);
    if (a.current() === "home") a.pages.home.render();
  }

  // --- bottom bar -------------------------------------------------------------------
  const bar = el("div", "rs-bar");
  const offBtn = el("div", "rs-pill rs-off", line("power") + "<span>Room Off</span>");
  const np = el("div", "rs-pill rs-np gone", '<i class="rs-art"></i><div class="rs-npt"><b></b><small></small></div><span class="rs-npb">' + filled(PAUSE) + "</span>");
  const homeBtn = el("div", "rs-pill rs-round rs-home", line("home"));
  bar.appendChild(offBtn);
  bar.appendChild(np);
  bar.appendChild(homeBtn);
  root.appendChild(bar);
  offBtn.addEventListener("click", roomOff);
  // the back arrow sits under the panel's setup corner: the page title is Back too
  const titleEl = root.querySelector(".el-title");
  if (titleEl)
    titleEl.addEventListener("click", () => {
      if (a.current() !== "home") a.go("home");
    });
  homeBtn.addEventListener("click", () => a.go("home"));
  let npNow = null;
  np.addEventListener("click", (ev) => {
    if (ev.target.closest && ev.target.closest(".rs-npb")) {
      if (npNow) {
        npNow.pause();
        np.classList.add("gone");
        a.toast("Paused");
      }
      return;
    }
    a.go("music");
  });
  // Spotify only polls while its own page is open: away from it, look now and
  // then (chrome() runs on every Home Assistant change and every 20 s) so the
  // bar knows when something starts or stops
  let spLook = 0;
  function chrome() {
    if (a.spOn && a.sp && a.current() !== "music" && Date.now() - spLook > 15000 && !(window.__arHidden && window.__arHidden())) {
      spLook = Date.now();
      a.sp
        .refresh()
        .then(paintBar)
        .catch(() => {});
    }
    paintBar();
  }
  function paintBar() {
    npNow = nowPlaying();
    np.classList.toggle("gone", !npNow);
    if (npNow) {
      np.querySelector("b").textContent = npNow.title || "";
      np.querySelector("small").textContent = npNow.sub || "";
      const art = np.querySelector(".rs-art");
      art.style.backgroundImage = npNow.art ? 'url("' + npNow.art + '")' : "";
      art.classList.toggle("none", !npNow.art);
    }
  }
  // --- home: icon buttons over the photo -----------------------------------------
  // --- utilities: realistic tiles instead of switches ----------------------------
  // each switch gets a realistic picture from its name (installer can pick one per
  // switch in the editor: residence.utilIcons {entity: libKey}); off = dimmed
  const UTIL_GUESS = [
    [/light|lamp|led\b/, "bulb_on"],
    [/irrigat|sprinkl|garden|lawn|zone|drip/, "sprinkler"],
    [/pool|pond|fountain|jacuzzi|spa\b/, "pool"],
    [/borehole|pump|well\b/, "pump"],
    [/geyser|boiler|hot ?water|water ?heat/, "geyser"],
    [/fence/, "fence"],
    [/garage/, "garage"],
    [/gate/, "gate"],
    [/door/, "front_door"],
    [/tank|water|valve|tap\b/, "water_tank"],
    [/solar|inverter|pv\b/, "solar"],
    [/batter|ups\b|backup/, "battery"],
    [/\bev\b|charger|car\b|tesla/, "ev"],
    [/heat|towel|underfloor|heater/, "heater"],
    [/aircon|\bac\b|air con/, "aircon"],
    [/fan\b|extractor/, "fan"],
    [/wi-?fi|router|internet|network/, "wifi"],
    [/alarm|siren/, "siren"],
    [/lock/, "lock"],
  ];
  function utilKey(e) {
    const pick = rc.utilIcons && rc.utilIcons[e];
    if (pick && LIB[pick]) return pick;
    const n = (a.nameOf(e) + " " + e).toLowerCase().replace(/_/g, " ");
    const hit = UTIL_GUESS.filter((g) => g[0].test(n))[0];
    return hit ? hit[1] : "plug";
  }
  function runFor(since) {
    if (!since) return "";
    const m = Math.max(0, Math.round((Date.now() / 1000 - since) / 60));
    return m < 1 ? " · just now" : m < 60 ? " · " + m + " min" : " · " + Math.floor(m / 60) + " h " + (m % 60) + " min";
  }
  function utilCards(list, tap) {
    const g = el("div", "rs-utils" + (list.length > 8 ? " many" : ""));
    list.forEach((e) => {
      const s = a.get(e) || {};
      const off = s.value === "unavailable";
      let key = utilKey(e);
      if (key === "bulb_on" && !s.on) key = "bulb_off";
      const c = el("div", "rs-util" + (s.on ? " on" : "") + (off ? " na" : ""), '<div class="rs-uimg"><img alt=""></div><b></b><small></small><span class="rs-usw"><i></i></span>');
      c.querySelector("img").src = libUrl(key);
      c.querySelector("b").textContent = a.nameOf(e);
      c.querySelector("small").textContent = off ? "Offline" : s.on ? "Running" + runFor(s.since) : "Off";
      if (!off) c.addEventListener("click", () => tap(e));
      g.appendChild(c);
    });
    return g;
  }
  function iconHtml(k) {
    const ic = rc.icons && rc.icons[k];
    const src = ic && typeof ic.src === "string" ? (ic.src.indexOf("lib:") === 0 ? libUrl(ic.src.slice(4)) : url(ic.src)) : "";
    if (src) return { html: '<img alt="" src="' + src.replace(/"/g, "%22") + '">', fill: !!ic.fill };
    return { html: line(k), fill: false };
  }
  function renderHome(p) {
    p.innerHTML = "";
    const cs = cats().filter((c) => !c.hidden);
    const tall = root.classList.contains("tall");
    const n = cs.length;
    const cols = tall ? (n <= 4 ? 2 : 3) : n <= 4 ? n : n <= 10 ? Math.ceil(n / 2) : 5;
    const grid = el("div", "rs-grid");
    grid.style.width = cols * 210 + "px";
    const r = curRoom();
    cs.forEach((c) => {
      const ic = iconHtml(c.key);
      const b = el("div", "rs-btn rs-k-" + c.key, '<div class="rs-ring' + (ic.fill ? " img-fill" : "") + '">' + ic.html + '<div class="rs-refl"><div class="rs-refl-in">' + ic.html + '</div></div><span class="rs-badge"></span></div><div class="rs-lbl"></div>');
      b.querySelector(".rs-lbl").textContent = c.title;
      let lit = false;
      let badge = "";
      if (c.key === "lights") {
        const on = (r.lights || []).filter((e) => a.get(e).on).length;
        lit = on > 0;
        badge = on ? String(on) : "";
      } else if (c.key === "climate") lit = (r.climate || []).some((e) => (a.get(e).value || "off") !== "off");
      else if (c.key === "music") lit = roomPlaying(r);
      else if (c.key === "watch") lit = (r.watch || []).some((e) => a.get(e).on);
      else if (c.key === "security") lit = (a.ents().security || []).some((e) => a.get(e).on);
      b.classList.toggle("lit", lit);
      b.querySelector(".rs-badge").textContent = badge;
      b.addEventListener("click", () => a.go(c.key));
      grid.appendChild(b);
    });
    p.appendChild(grid);
    chrome();
  }

  // --- Scenes page ----------------------------------------------------------------
  const SC_ICONS = [
    [/movie|cinema|\btv\b|film/, "movie"],
    [/morning|wake|sunrise|day/, "sun"],
    [/night|sleep|bed|goodnight/, "moon"],
    [/dinner|dining|eat|meal/, "dinner"],
    [/relax|chill|lounge|evening/, "relax"],
    [/party|entertain|guests/, "party"],
    [/away|leave|leaving|out/, "away"],
    [/read|study|focus/, "read"],
  ];
  const scIcon = (n) => (SC_ICONS.filter((x) => x[0].test(String(n).toLowerCase()))[0] || [0, "sparkle"])[1];
  const scp = a.mkPage("scenes");
  scp.el.classList.add("rs-pg-scenes");
  scp.render = function () {
    const p = scp.el;
    p.innerHTML = "";
    const list = a
      .clientScenes()
      .map((s) => ({ e: s.entity, n: s.name || a.nameOf(s.entity) }))
      .concat(a.scenes().map((s) => ({ e: s, n: a.nameOf(s) })));
    if (!list.length) {
      p.appendChild(txt("div", "rs-empty", "No scenes for this room yet. Add them to the room in Device Setup."));
      return;
    }
    const grid = el("div", "rs-grid rs-scenes");
    const cols = list.length <= 4 ? list.length : Math.ceil(list.length / 2);
    grid.style.width = Math.min(5, cols) * 210 + "px";
    list.slice(0, 10).forEach((s) => {
      const b = el("div", "rs-btn", '<div class="rs-ring">' + line(scIcon(s.n)) + '<div class="rs-refl"><div class="rs-refl-in">' + line(scIcon(s.n)) + '</div></div></div><div class="rs-lbl"></div>');
      b.querySelector(".rs-lbl").textContent = s.n;
      b.addEventListener("click", () => {
        Array.prototype.forEach.call(grid.children, (x) => x.classList.toggle("lit", x === b));
        a.runScene(b, s.e, s.n);
      });
      grid.appendChild(b);
    });
    p.appendChild(grid);
  };

  // --- Watch page: the room's TVs / media players -------------------------------------
  const wp = a.mkPage("watch");
  wp.el.classList.add("rs-pg-watch");
  wp.render = function () {
    const p = wp.el;
    p.innerHTML = "";
    const list = a.ents().watch || [];
    if (!list.length) {
      p.appendChild(txt("div", "rs-empty", "No TV in this room yet. Add one under Watch in Device Setup."));
      return;
    }
    const g = el("div", "rs-watch");
    list.forEach((e) => {
      const s = a.get(e);
      const c = el("div", "el-glass rs-tv" + (s.on ? " on" : ""), '<div class="rs-tvh"><span class="rs-tvi">' + line("watch") + '</span><div class="rs-tvm"><b></b><small></small></div><span class="rs-pw">' + line("power") + '</span></div><div class="rs-tvt"><span data-c="previous">' + line("prev") + '</span><span data-c="play_pause" class="pp">' + filled(s.value === "playing" ? PAUSE : PLAY) + '</span><span data-c="next">' + line("next") + '</span></div><div class="rs-tvv">' + line("vol") + '<div class="el-slider rs-vs"><div class="el-fill"></div></div></div>');
      c.querySelector("b").textContent = a.nameOf(e);
      c.querySelector("small").textContent = s.on ? [s.app || s.source, s.title].filter(Boolean).join(" · ") || (s.value === "playing" ? "Playing" : "On") : "Off";
      c.querySelector(".rs-pw").addEventListener("click", () => {
        const on = !a.get(e).on;
        a.patch(e, { on: on, value: on ? "on" : "off" });
        a.send("dim", { entity: e, v: on ? 1 : 0 });
        wp.render();
      });
      Array.prototype.forEach.call(c.querySelectorAll(".rs-tvt span"), (b) =>
        b.addEventListener("click", () => {
          a.send("media", { entity: e, cmd: b.getAttribute("data-c") });
          a.toast(b.getAttribute("data-c") === "play_pause" ? "Play / pause" : b.getAttribute("data-c") === "next" ? "Next" : "Previous");
        }),
      );
      const vs = c.querySelector(".rs-vs");
      const fill = vs.firstChild;
      fill.style.width = (typeof s.vol === "number" ? s.vol * 100 : 0) + "%";
      const setV = (ev, commit) => {
        const rr = vs.getBoundingClientRect();
        const v = clamp((ev.clientX - rr.left) / rr.width, 0, 1);
        fill.style.width = v * 100 + "%";
        if (commit) {
          a.patch(e, { vol: v });
          a.send("volume", { entity: e, v: Math.round(v * 100) / 100 });
        }
      };
      vs.addEventListener("pointerdown", (ev) => {
        a.setDragging(true);
        try {
          vs.setPointerCapture(ev.pointerId);
        } catch (x) {
          /* ignore */
        }
        window.__arClaimGesture = true;
        setV(ev, false);
        vs.onpointermove = (m) => setV(m, false);
      });
      const end = (ev) => {
        vs.onpointermove = null;
        window.__arClaimGesture = false;
        a.setDragging(false);
        setV(ev, true);
      };
      vs.addEventListener("pointerup", end);
      vs.addEventListener("pointercancel", end);
      g.appendChild(c);
    });
    p.appendChild(g);
  };

  // --- shades: each blind / curtain drawn as a window --------------------------------
  if (a.pages.shades) a.pages.shades.el.classList.add("rs-pg-shades");
  function decorateCover(c, e) {
    if (e.split(".")[0] !== "cover") return;
    const t = shadeType(e);
    const cur = t === "curtain" || (t === "sheer" && /curtain/i.test(a.nameOf(e)));
    const fab = t === "sheer" ? " sheer" : t === "block" ? " block" : "";
    const win = el("div", "rs-win" + (cur ? " curt" : ""), '<i class="rs-mull"></i>' + (cur ? '<i class="rs-rod"></i><i class="rs-cl' + fab + '"></i><i class="rs-cr' + fab + '"></i>' : '<i class="rs-head"></i><i class="rs-fab' + fab + '"><i class="rs-rail"></i></i>'));
    const row = c.querySelector(".el-row");
    row.parentNode.insertBefore(win, row);
    c.classList.add("rs-shade");
    if (!a.coverSlides(e)) {
      win.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const open = !(a.levelOf(e, "cover") > 0);
        a.patch(e, { on: open, pos: open ? 100 : 0 });
        a.send("position", { entity: e, v: open ? 1 : 0, dir: open ? 1 : -1 });
        a.paintCard(c, e, "cover");
      });
      return;
    }
    let start = 0;
    const set = (ev, commit) => {
      const r = win.getBoundingClientRect();
      const v = cur ? clamp(Math.abs(ev.clientX - (r.left + r.width / 2)) / (r.width / 2), 0, 1) : clamp(1 - (ev.clientY - r.top) / r.height, 0, 1);
      const vv = Math.round(v * 100) / 100;
      a.patch(e, { pos: Math.round(vv * 100), on: vv > 0 });
      a.paintCard(c, e, "cover");
      if (commit) a.send("position", { entity: e, v: vv, dir: vv > start ? 1 : vv < start ? -1 : 0 });
    };
    win.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      a.setDragging(true);
      try {
        win.setPointerCapture(ev.pointerId);
      } catch (x) {
        /* ignore */
      }
      window.__arClaimGesture = true;
      win.classList.add("drag");
      start = a.levelOf(e, "cover");
      set(ev, false);
      win.onpointermove = (m) => set(m, false);
    });
    const end = (ev) => {
      if (!win.classList.contains("drag")) return;
      win.classList.remove("drag");
      win.onpointermove = null;
      window.__arClaimGesture = false;
      a.setDragging(false);
      set(ev, true);
    };
    win.addEventListener("pointerup", end);
    win.addEventListener("pointercancel", end);
    win.addEventListener("click", (ev) => ev.stopPropagation());
  }
  function paintCover(c, e, v) {
    const win = c.querySelector(".rs-win");
    if (!win) return;
    const closed = 1 - clamp(v, 0, 1);
    if (win.classList.contains("curt")) {
      const w = closed * 46 + 4 + "%";
      win.querySelector(".rs-cl").style.width = w;
      win.querySelector(".rs-cr").style.width = w;
    } else win.querySelector(".rs-fab").style.height = closed * 94 + 6 + "%";
  }

  // ===== Settings (gear next to the clock): what the customer may change on this panel =====
  const SET_ON = rc.settingsOn !== false;
  const BG_NAMES = { villa: "Villa at dusk", cape: "Cape dusk", "sunset-sea": "Sunset sea", mountains: "Misty mountains", "forest-mist": "Forest mist", dunes: "Desert dunes", stars: "Night sky", aurora: "Aurora", "city-night": "City lights", lounge: "Evening lounge", "marble-white": "White marble", "marble-black": "Black marble", slate: "Slate", concrete: "Concrete", steel: "Brushed steel", walnut: "Walnut", oak: "Oak", leather: "Leather", linen: "Linen", "colour-midnight": "Midnight blue", "colour-emerald": "Emerald", "colour-bordeaux": "Bordeaux", "colour-champagne": "Champagne silk", "colour-graphite": "Graphite silk", "colour-twilight": "Twilight", "colour-lagoon": "Lagoon", "colour-amber": "Amber glow", "sky-blue": "Blue sky", "sky-high": "High clouds", "sky-golden": "Golden hour", "sky-dawn": "Pastel dawn", "sky-moon": "Moonlit clouds" };
  const LANGS = [["en-GB", "English (UK)"], ["en-US", "English (US)"], ["af-ZA", "Afrikaans"], ["nl-NL", "Nederlands"], ["de-DE", "Deutsch"], ["fr-FR", "Français"], ["pt-PT", "Português"], ["es-ES", "Español"], ["it-IT", "Italiano"]];
  const TIMEOUTS = [[30, "30 s"], [60, "1 min"], [120, "2 min"], [300, "5 min"], [600, "10 min"], [0, "Never"]];
  // installer PIN (editor): asked before the panel's setup opens (hold the
  // top-left corner 3 s, or Settings > Panel > Installer setup). The customer
  // Settings sheet itself is open.
  const PIN = typeof rc.pin === "string" && /^\d{4,8}$/.test(rc.pin) ? rc.pin : "";
  let unlocked = false;
  const LD = () => (a.ctx && a.ctx.localDevice ? a.ctx.localDevice.get() : {});
  function setLD(m) {
    if (!a.ctx || !a.ctx.localDevice) return;
    const o = Object.assign({}, LD(), m);
    Object.keys(o).forEach((k) => o[k] === undefined && delete o[k]);
    a.ctx.localDevice.set(o);
  }
  let setEl = null;
  let setTab = "display";
  let cleanT = null;
  function closeSettings() {
    if (setEl && setEl.parentNode) setEl.parentNode.removeChild(setEl);
    setEl = null;
    unlocked = false;
  }
  function openSettings() {
    closeSettings();
    setEl = el("div", "rs-set");
    const dim = el("div", "rs-setdim");
    dim.addEventListener("click", closeSettings);
    setEl.appendChild(dim);
    const box = el("div", "el-glass rs-setbox");
    setEl.appendChild(box);
    root.appendChild(setEl);
    paintSettings(box);
  }
  // the installer PIN, then the panel's setup screen
  function setupWithPin(open) {
    closeSettings();
    setEl = el("div", "rs-set");
    const dim = el("div", "rs-setdim");
    dim.addEventListener("click", closeSettings);
    setEl.appendChild(dim);
    const box = el("div", "el-glass rs-setbox rs-pinbox");
    setEl.appendChild(box);
    root.appendChild(setEl);
    pinPad(box, () => {
      closeSettings();
      open();
    });
  }
  if (a.ctx) a.ctx.setupGate = (open) => {
    if (!PIN || !document.body.contains(root)) return false;
    setupWithPin(open);
    return true;
  };
  function pinPad(box, ok) {
    box.innerHTML = "";
    let code = "";
    const w = el("div", "rs-pin", '<b>Installer PIN</b><span class="rs-pind"></span><div class="rs-pinp"></div><span class="rs-pinx">Cancel</span>');
    const dots = w.querySelector(".rs-pind");
    const paint = (bad) => {
      dots.textContent = code ? "•".repeat(code.length) : bad ? "Wrong PIN" : "Enter the PIN";
      dots.classList.toggle("bad", !!bad);
    };
    paint();
    "1 2 3 4 5 6 7 8 9 ⌫ 0 ✓".split(" ").forEach((k) => {
      const b = txt("span", "rs-pk" + (k === "✓" ? " ok" : ""), k);
      b.addEventListener("click", () => {
        if (k === "⌫") code = code.slice(0, -1);
        else if (k === "✓") {
          if (code === PIN) {
            unlocked = true;
            return ok();
          }
          code = "";
          return paint(true);
        } else if (code.length < 8) code += k;
        if (code.length === PIN.length) {
          if (code === PIN) {
            unlocked = true;
            return ok();
          }
          code = "";
          return paint(true);
        }
        paint();
      });
      w.querySelector(".rs-pinp").appendChild(b);
    });
    w.querySelector(".rs-pinx").addEventListener("click", () => (unlocked ? paintSettings(box) : closeSettings()));
    box.appendChild(w);
  }
  const chipRow = (opts, cur, pick) => {
    const r = el("span", "rs-opts");
    opts.forEach((o) => {
      const c = txt("span", "rs-chip" + (cur === o[0] ? " on" : ""), o[1]);
      c.addEventListener("click", () => pick(o[0]));
      r.appendChild(c);
    });
    return r;
  };
  const row = (label, cls) => {
    const r = el("div", "rs-setrow" + (cls ? " " + cls : ""));
    r.appendChild(txt("span", "rs-setl", label));
    return r;
  };
  function paintSettings(box) {
    box.innerHTML = "";
    const hd = el("div", "rs-seth", '<b>Settings</b><span class="rs-setx">' + line("x") + "</span>");
    hd.querySelector(".rs-setx").addEventListener("click", closeSettings);
    box.appendChild(hd);
    const wrap = el("div", "rs-setwrap");
    const tabs = el("div", "rs-settabs");
    [["display", "Display", "sun"], ["look", "Look", "sparkle"], ["clock", "Clock & room", "home"], ["panel", "Panel", "phone"]].forEach((tb) => {
      const t = el("span", "rs-settab" + (setTab === tb[0] ? " on" : ""), line(tb[2]) + "<span></span>");
      t.lastChild.textContent = tb[1];
      t.addEventListener("click", () => {
        setTab = tb[0];
        paintSettings(box);
      });
      tabs.appendChild(t);
    });
    wrap.appendChild(tabs);
    const body = el("div", "rs-setbody");
    wrap.appendChild(body);
    box.appendChild(wrap);
    const again = () => {
      const keep = setTab;
      const y = body.scrollTop;
      paintSettings(box);
      const nb = box.querySelector(".rs-setbody");
      if (nb && setTab === keep) nb.scrollTop = y;
    };
    const ld = LD();
    if (setTab === "display") {
      const br = a.ctx && a.ctx.brightness;
      if (br) {
        const cur = br.get();
        const r = row("Brightness");
        const bri = el("span", "rs-bri", line("sun") + '<div class="el-slider rs-brs"><div class="el-fill"></div></div><em></em>');
        r.appendChild(bri);
        const sl = bri.querySelector(".rs-brs");
        const fill = sl.firstChild;
        const pc = bri.querySelector("em");
        fill.style.width = Math.round((cur == null ? 1 : cur) * 100) + "%";
        pc.textContent = cur == null ? (br.auto() ? "Auto" : "100%") : Math.round(cur * 100) + "%";
        const set = (ev, commit) => {
          const rr = sl.getBoundingClientRect();
          const v = clamp((ev.clientX - rr.left) / rr.width, 0.05, 1);
          fill.style.width = Math.round(v * 100) + "%";
          pc.textContent = Math.round(v * 100) + "%";
          br.set(v);
          if (commit) again();
        };
        sl.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          try {
            sl.setPointerCapture(ev.pointerId);
          } catch (x) {
            /* ignore */
          }
          window.__arClaimGesture = true;
          set(ev, false);
          sl.onpointermove = (m) => set(m, false);
        });
        const end = (ev) => {
          sl.onpointermove = null;
          window.__arClaimGesture = false;
          set(ev, true);
        };
        sl.addEventListener("pointerup", end);
        sl.addEventListener("pointercancel", end);
        if (cur != null) {
          const au = txt("span", "rs-chip", br.auto() ? "Auto" : "Reset");
          au.addEventListener("click", () => {
            br.set(null);
            again();
          });
          bri.appendChild(au);
        }
        body.appendChild(r);
      }
      const ss = (a.ctx.device && a.ctx.device().screensaver) || {};
      const curT = typeof ld.screensaverAfter === "number" ? ld.screensaverAfter : ss.enabled === false ? 0 : ss.after != null ? ss.after : 120;
      const tr = row("Screensaver after");
      tr.appendChild(chipRow(TIMEOUTS, TIMEOUTS.some((o) => o[0] === curT) ? curT : -1, (v) => (setLD({ screensaverAfter: v }), again())));
      body.appendChild(tr);
      const n = ld.night || {};
      const nr = row("Night mode");
      nr.appendChild(chipRow([[false, "Off"], [true, "On"]], !!n.on, (v) => (setLD({ night: Object.assign({ from: "22:00", to: "06:00", mode: "dim", level: 0.25 }, n, { on: v }) }), again())));
      body.appendChild(nr);
      if (n.on) {
        const step = (k, d) => {
          const m = /^(\d{1,2}):(\d{2})$/.exec(n[k] || (k === "from" ? "22:00" : "06:00"));
          let mins = (m ? Number(m[1]) * 60 + Number(m[2]) : 0) + d;
          mins = (mins + 1440) % 1440;
          const v = Object.assign({}, n);
          v[k] = pad2(Math.floor(mins / 60)) + ":" + pad2(mins % 60);
          setLD({ night: v });
          again();
        };
        const wr = row("From – to", "sub");
        ["from", "to"].forEach((k, i) => {
          const s = el("div", "rs-step rs-time", '<span class="rs-sb">' + line("minus") + "</span><b></b><span class=\"rs-sb\">" + line("plus") + "</span>");
          s.querySelector("b").textContent = n[k] || (k === "from" ? "22:00" : "06:00");
          s.children[0].addEventListener("click", () => step(k, -30));
          s.children[2].addEventListener("click", () => step(k, 30));
          wr.appendChild(s);
          if (!i) wr.appendChild(txt("span", "rs-to", "to"));
        });
        body.appendChild(wr);
        const mr = row("At night", "sub");
        mr.appendChild(chipRow([["dim", "Dim the screen"], ["off", "Screen off when idle"]], n.mode === "off" ? "off" : "dim", (v) => (setLD({ night: Object.assign({}, n, { mode: v }) }), again())));
        body.appendChild(mr);
        if (n.mode !== "off") {
          const lr = row("Night brightness", "sub");
          lr.appendChild(chipRow([[0.1, "10 %"], [0.25, "25 %"], [0.4, "40 %"]], typeof n.level === "number" ? n.level : 0.25, (v) => (setLD({ night: Object.assign({}, n, { level: v }) }), again())));
          body.appendChild(lr);
        }
      }
    } else if (setTab === "look") {
      if (false) {
        const lk = el("div", "rs-locked", line("security") + "<b>Locked by your installer</b><span>Backgrounds, glow and buttons need the installer PIN.</span>");
        const ub = txt("span", "rs-chip big", "Enter PIN");
        ub.addEventListener("click", () => pinPad(box, () => ((setTab = "look"), again())));
        lk.appendChild(ub);
        body.appendChild(lk);
      } else {
        const bgRow = row("Background", "top");
        const grid = el("div", "rs-bgs");
        const mine = el("span", "rs-bg mine" + (!PREF.bg ? " on" : ""), "<i></i><small>As set up</small>");
        const inst = url((raw[a.roomIdx()] || {}).rsImage || rc.houseImage || "preset:villa");
        if (inst) mine.querySelector("i").style.backgroundImage = 'url("' + inst + '")';
        mine.addEventListener("click", () => {
          delete PREF.bg;
          savePref();
          background();
          again();
        });
        grid.appendChild(mine);
        const grpOf = (k) => (k.indexOf("sky-") === 0 ? "Skies" : k.indexOf("colour-") === 0 ? "Colours" : /^(marble|slate|concrete|steel|walnut|oak|leather|linen)/.test(k) ? "Stone & textures" : "Scenes");
        const order = ["Scenes", "Skies", "Colours", "Stone & textures"];
        const keys = [].concat.apply([], order.map((g) => Object.keys(PRESETS).filter((k) => grpOf(k) === g)));
        let lastGrp = "Scenes";
        keys.forEach((k) => {
          const v = "preset:" + k;
          if (grpOf(k) !== lastGrp) {
            lastGrp = grpOf(k);
            grid.appendChild(txt("div", "rs-bggrp", lastGrp));
          }
          const t = el("span", "rs-bg" + (PREF.bg === v ? " on" : ""), "<i></i><small></small>");
          t.querySelector("i").style.backgroundImage = 'url("' + url(v) + '")';
          t.querySelector("small").textContent = BG_NAMES[k] || k;
          t.addEventListener("click", () => {
            PREF.bg = v;
            savePref();
            background();
            again();
          });
          grid.appendChild(t);
        });
        bgRow.appendChild(grid);
        body.appendChild(bgRow);
        const g = row("Glow");
        g.appendChild(chipRow([["warm", "Warm white"], ["brass", "Brass"], ["ice", "Ice blue"]], accentNow(), (v) => ((PREF.accent = v), savePref(), applyLook(), again())));
        body.appendChild(g);
        const pickLook = (v) => ((PREF.look = v), delete PREF.shape, savePref(), applyLook(), again());
        const bt = row("Buttons", "top");
        bt.appendChild(chipRow(LOOKS.slice(0, 7), lookNow(), pickLook));
        body.appendChild(bt);
        const bi = row("Icons only", "top");
        bi.appendChild(chipRow(LOOKS.slice(7), lookNow(), pickLook));
        body.appendChild(bi);
      }
    } else if (setTab === "clock") {
      const dev = (a.ctx.device && a.ctx.device()) || {};
      const c = row("Clock");
      c.appendChild(chipRow([[true, "24 hour"], [false, "12 hour"]], dev.clockFormat24h !== false, (v) => (setLD({ clock24: v }), chromeAll(), again())));
      body.appendChild(c);
      const lg = row("Date language", "top");
      lg.appendChild(chipRow(LANGS, dev.clockLanguage || "en-GB", (v) => (setLD({ lang: v }), again())));
      body.appendChild(lg);
      const R = a.rooms();
      if (R.length > 1) {
        const opts = [[-1, "As set up"]].concat(R.map((r, i) => [i, r.name || "Room " + (i + 1)]));
        if (a.wholeOn) opts.push([-2, "Whole Home"]);
        const cur = typeof PREF.room === "number" ? PREF.room : -1;
        const rr = row("Home room", "top");
        rr.appendChild(chipRow(opts, cur, (v) => ((PREF.room = v === -1 ? undefined : v), savePref(), again())));
        body.appendChild(rr);
        body.appendChild(txt("div", "rs-sethint", "When nobody has touched the panel for a while, or when the screensaver comes on, it goes back to this room."));
      }
      const sd = row("Tap sounds");
      sd.appendChild(chipRow([[false, "Off"], [true, "On"]], !!PREF.sound, (v) => ((PREF.sound = v || undefined), savePref(), v && tapSound(), again())));
      body.appendChild(sd);
    } else {
      const inf = (a.ctx.panelInfo && a.ctx.panelInfo()) || {};
      const lines = [
        ["Panel ID", inf.deviceId],
        ["IP address", inf.ip],
        ["App version", inf.version],
        ["Screen software", inf.uiVersion],
        ["Model", inf.model],
        ["Wi-Fi", inf.net ? inf.net + (typeof inf.rssi === "number" ? " · " + inf.rssi + " dBm" : "") : ""],
        ["Home Assistant", inf.connected ? "Connected" : "Not connected"],
      ];
      const tb = el("div", "rs-info");
      lines.forEach((l) => {
        if (!l[1]) return;
        const r = el("div", "rs-infor", "<span></span><b></b>");
        r.firstChild.textContent = l[0];
        r.lastChild.textContent = String(l[1]);
        tb.appendChild(r);
      });
      body.appendChild(tb);
      const ft = row("", "foot");
      const clean = el("span", "rs-chip big", line("sparkle") + "<span>Clean screen</span>");
      clean.addEventListener("click", () => {
        closeSettings();
        cleanScreen();
      });
      ft.appendChild(clean);
      if (a.ctx.openSetup) {
        const inst = el("span", "rs-chip big", line("security") + "<span>Installer setup</span>");
        inst.addEventListener("click", () => {
          closeSettings();
          a.ctx.openSetup();
        });
        ft.appendChild(inst);
      }
      const changed = PREF.bg || PREF.accent || PREF.shape || PREF.look || PREF.sound || typeof PREF.room === "number" || (a.ctx.brightness && a.ctx.brightness.get() != null) || Object.keys(LD()).length;
      if (changed) {
        const rs = txt("span", "rs-chip big", "Back to how it was set up");
        rs.addEventListener("click", () => {
          PREF = {};
          savePref();
          if (a.ctx.brightness) a.ctx.brightness.set(null);
          if (a.ctx.localDevice) a.ctx.localDevice.set(null);
          applyLook();
          background();
          chromeAll();
          again();
          a.toast("Settings reset");
        });
        ft.appendChild(rs);
      }
      body.appendChild(ft);
    }
  }
  // 30 s with touch locked, to wipe the glass
  function cleanScreen() {
    const cs = el("div", "rs-clean", "<div><b>Clean the screen</b><span>Touch is off for <em>30</em> seconds</span></div>");
    const stop = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    ["pointerdown", "pointerup", "click", "touchstart", "touchend"].forEach((n) => cs.addEventListener(n, stop, true));
    root.appendChild(cs);
    window.__arClaimGesture = true;
    let n = 30;
    clearInterval(cleanT);
    cleanT = setInterval(() => {
      n--;
      const em = cs.querySelector("em");
      if (em) em.textContent = String(n);
      if (n <= 0) {
        clearInterval(cleanT);
        window.__arClaimGesture = false;
        if (cs.parentNode) cs.parentNode.removeChild(cs);
      }
    }, 1000);
  }
  if (SET_ON) {
    const gear = el("span", "rs-gear", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>');
    gear.addEventListener("click", openSettings);
    const status = root.querySelector(".el-status");
    if (status) status.appendChild(gear);
  }

  // --- tap sounds (Settings > Clock & room): a soft tick on buttons ------------------
  let actx = null;
  function tapSound() {
    try {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      actx = actx || new C();
      if (actx.state === "suspended" && actx.resume) actx.resume();
      const t = actx.currentTime;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(1500, t);
      o.frequency.exponentialRampToValueAtTime(900, t + 0.04);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      o.connect(g);
      g.connect(actx.destination);
      o.start(t);
      o.stop(t + 0.07);
    } catch (e) {
      /* no audio: fine */
    }
  }
  const TAPPABLE = ".rs-btn,.rs-pill,.rs-chip,.rs-pill2,.rs-sb,.rs-pk,.rs-d,.rs-calbtn,.rs-gear,.el-card,.el-tab,.el-act,.el-mode,.el-key,.el-rc,.el-round,.el-play,.el-armb,.rs-pw,.rs-tvt span,.rs-addb,.rs-settab";
  let lastTouch = Date.now();
  root.addEventListener(
    "pointerdown",
    (ev) => {
      lastTouch = Date.now();
      if (PREF.sound && ev.target.closest && ev.target.closest(TAPPABLE)) tapSound();
    },
    true,
  );

  // --- back to the home room when idle / asleep (Settings > Clock & room) ------------------
  function homeRoom() {
    if (typeof PREF.room !== "number") return null;
    if (PREF.room === -2) return a.wholeOn ? { i: 0, wh: true } : null;
    return PREF.room >= 0 && PREF.room < a.rooms().length ? { i: PREF.room, wh: false } : null;
  }
  let wentHome = false;
  const idleT = setInterval(() => {
    if (!root.isConnected) return clearInterval(idleT);
    const hr = homeRoom();
    if (!hr) return;
    const asleep = a.ctx.awake && !a.ctx.awake();
    const dev = (a.ctx.device && a.ctx.device()) || {};
    const idle = Date.now() - lastTouch > (dev.inactivityTimeout != null ? dev.inactivityTimeout : 60) * 1000;
    const there = a.current() === "home" && !!a.whole() === hr.wh && (hr.wh || a.roomIdx() === hr.i);
    if ((asleep || idle) && !there && !setEl && !add) {
      if (wentHome) return;
      wentHome = true;
      a.setRoom(hr.i, hr.wh);
    } else if (!asleep && !idle) wentHome = false;
  }, 5000);

  // ===== Calendar: events from Home Assistant calendars + reminders to phones =====
  const pad2 = (n) => (n < 10 ? "0" : "") + n;
  const dayKey = (d) => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  const LANG = (a.ctx && a.ctx.device && a.ctx.device().clockLanguage) || "en-GB";
  const fmt = (d, o) => {
    try {
      return d.toLocaleDateString(LANG, o);
    } catch (e) {
      return d.toDateString();
    }
  };
  const calData = () => {
    const c = a.get("rs_cal");
    return {
      phones: (c && Array.isArray(c.phones) ? c.phones : []).filter((p) => p && p.id),
      reminders: (c && Array.isArray(c.reminders) ? c.reminders : []).filter((r) => r && r.at),
      events: (c && Array.isArray(c.events) ? c.events : []).filter((e) => e && e.s),
      ok: !!c,
    };
  };
  // events: an all-day one is "YYYY-MM-DD", a timed one a full date-time
  function evDays(e) {
    const out = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(e.s)) {
      const s = new Date(e.s + "T00:00:00");
      let en = /^\d{4}-\d{2}-\d{2}$/.test(e.e) ? new Date(e.e + "T00:00:00") : new Date(s.getTime() + 864e5);
      for (let d = new Date(s); d < en && out.length < 31; d.setDate(d.getDate() + 1)) out.push(dayKey(d));
      return { days: out, time: "All day", sort: "00:00" };
    }
    const s = new Date(e.s);
    if (isNaN(s)) return { days: [], time: "", sort: "" };
    const t = pad2(s.getHours()) + ":" + pad2(s.getMinutes());
    return { days: [dayKey(s)], time: t, sort: t };
  }
  function itemsOn(key) {
    const c = calData();
    const list = [];
    c.events.forEach((e) => {
      const d = evDays(e);
      if (d.days.indexOf(key) >= 0) list.push({ kind: "event", time: d.time, sort: d.sort, title: e.t || "Event", sub: [e.cal, e.loc].filter(Boolean).join(" · ") });
    });
    c.reminders.forEach((r) => {
      if (r.at.slice(0, 10) === key) list.push({ kind: "rem", id: r.id, time: r.at.slice(11, 16), sort: r.at.slice(11, 16), title: r.t, sub: r.to && r.to.length ? "Reminds " + r.to.join(", ") : "On this calendar only" });
    });
    return list.sort((x, y) => (x.sort < y.sort ? -1 : x.sort > y.sort ? 1 : 0));
  }

  // the button next to the clock: today's date with how many things are on today
  let calBtn = null;
  if (CAL_ON) {
    calBtn = el("span", "rs-calbtn", line("calendar") + '<b class="rs-calday"></b><i class="rs-caln"></i>');
    calBtn.addEventListener("click", () => a.go("calendar"));
    const status = root.querySelector(".el-status");
    const clockEl = status && status.querySelector(".el-clock");
    if (status) status.insertBefore(calBtn, clockEl || null);
  }
  function paintCalBtn() {
    if (!calBtn) return;
    const now = new Date();
    calBtn.querySelector(".rs-calday").textContent = String(now.getDate());
    const n = itemsOn(dayKey(now)).length;
    const ni = calBtn.querySelector(".rs-caln");
    ni.textContent = n ? String(n) : "";
    ni.style.display = n ? "" : "none";
  }

  let viewM = null; // first day of the month on screen
  let selDay = dayKey(new Date());
  let add = null; // the reminder being made
  let delAsk = null;
  let lastRefresh = 0;
  const QUICK = ["Take out the bins", "Pick up the kids", "Call", "Water the garden", "Take medication", "Appointment"];
  const calPage = CAL_ON ? a.mkPage("calendar") : null;
  if (calPage) calPage.el.classList.add("rs-pg-cal");
  function newReminder() {
    const now = new Date();
    const d = new Date(selDay + "T00:00:00");
    // today: the next round half hour; another day: 09:00
    let h = 9,
      m = 0;
    if (selDay === dayKey(now)) {
      const t = new Date(now.getTime() + 30 * 60000);
      h = t.getHours();
      m = t.getMinutes() < 30 ? 30 : 0;
      if (m === 0) h = (h + 1) % 24;
    }
    add = { title: "", day: dayKey(d), h: h, m: m, to: {}, kb: false };
  }
  function addWhen() {
    return add.day + "T" + pad2(add.h) + ":" + pad2(add.m);
  }
  function shiftDay(n) {
    const d = new Date(add.day + "T00:00:00");
    d.setDate(d.getDate() + n);
    if (dayKey(d) < dayKey(new Date())) return;
    add.day = dayKey(d);
  }
  function renderCal() {
    const p = calPage.el;
    p.innerHTML = "";
    const c = calData();
    if (Date.now() - lastRefresh > 60000) {
      lastRefresh = Date.now();
      a.rsEvent("cal_refresh", {});
    }
    const today = dayKey(new Date());
    const sel = new Date(selDay + "T00:00:00");
    if (!viewM) viewM = new Date(sel.getFullYear(), sel.getMonth(), 1);
    const wrap = el("div", "rs-cal");
    // month
    const mo = el("div", "el-glass rs-month");
    const hd = el("div", "rs-mh", '<span class="rs-mnav" data-d="-1">' + line("chevl") + '</span><b></b><span class="rs-mnav" data-d="1">' + line("chevr") + "</span>");
    hd.querySelector("b").textContent = fmt(viewM, { month: "long", year: "numeric" });
    Array.prototype.forEach.call(hd.querySelectorAll(".rs-mnav"), (b) =>
      b.addEventListener("click", () => {
        viewM = new Date(viewM.getFullYear(), viewM.getMonth() + Number(b.getAttribute("data-d")), 1);
        renderCal();
      }),
    );
    mo.appendChild(hd);
    const wk = el("div", "rs-wk");
    const mon = new Date(2024, 0, 1); // a Monday
    for (let i = 0; i < 7; i++) wk.appendChild(txt("span", "", fmt(new Date(mon.getTime() + i * 864e5), { weekday: "short" }).slice(0, 2)));
    mo.appendChild(wk);
    const g = el("div", "rs-days");
    const first = new Date(viewM);
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const k = dayKey(d);
      const n = itemsOn(k);
      const cell = el("span", "rs-d" + (d.getMonth() !== viewM.getMonth() ? " out" : "") + (k === today ? " today" : "") + (k === selDay ? " sel" : ""), "<b></b><i></i>");
      cell.querySelector("b").textContent = String(d.getDate());
      const dots = cell.querySelector("i");
      n.slice(0, 3).forEach((x) => dots.appendChild(el("u", x.kind === "rem" ? "rem" : "")));
      cell.addEventListener("click", () => {
        selDay = k;
        if (d.getMonth() !== viewM.getMonth()) viewM = new Date(d.getFullYear(), d.getMonth(), 1);
        renderCal();
      });
      g.appendChild(cell);
    }
    mo.appendChild(g);
    wrap.appendChild(mo);
    // the day
    const dy = el("div", "el-glass rs-dayp");
    const dh = el("div", "rs-dh", "<div><b></b><small></small></div>");
    dh.querySelector("b").textContent = fmt(sel, { weekday: "long", day: "numeric", month: "long" });
    const items = itemsOn(selDay);
    dh.querySelector("small").textContent = items.length ? items.length + (items.length === 1 ? " item" : " items") : "Nothing planned";
    if (selDay >= today) {
      const ab = el("span", "rs-addb", line("bell") + "<span>Add reminder</span>");
      ab.addEventListener("click", () => {
        newReminder();
        renderCal();
      });
      dh.appendChild(ab);
    }
    dy.appendChild(dh);
    const ls = el("div", "rs-list");
    if (!items.length) ls.appendChild(txt("div", "rs-none", c.ok ? "No events or reminders on this day." : "Waiting for Home Assistant…"));
    items.forEach((x) => {
      const r = el("div", "rs-it " + x.kind, '<span class="rs-itt"></span><span class="rs-iti">' + line(x.kind === "rem" ? "bell" : "calendar") + '</span><div class="rs-itm"><b></b><small></small></div>');
      r.querySelector(".rs-itt").textContent = x.time;
      r.querySelector("b").textContent = x.title;
      r.querySelector("small").textContent = x.sub;
      if (x.kind === "rem") {
        const del = el("span", "rs-del" + (delAsk === x.id ? " ask" : ""), delAsk === x.id ? "<span>Delete?</span>" : line("x"));
        del.addEventListener("click", () => {
          if (delAsk !== x.id) {
            delAsk = x.id;
            renderCal();
            setTimeout(() => {
              if (delAsk === x.id) {
                delAsk = null;
                if (a.current() === "calendar") renderCal();
              }
            }, 3000);
            return;
          }
          delAsk = null;
          a.rsEvent("rem_del", { id: x.id });
          a.toast("Reminder deleted");
        });
        r.appendChild(del);
      }
      ls.appendChild(r);
    });
    dy.appendChild(ls);
    wrap.appendChild(dy);
    p.appendChild(wrap);
    if (add) p.appendChild(addSheet(c));
  }
  function addSheet(c) {
    const sh = el("div", "rs-sheet");
    const box = el("div", "el-glass rs-addbox" + (add.kb ? " typing" : ""));
    sh.appendChild(box);
    const field = el("div", "rs-field" + (add.kb ? " on" : ""), '<span class="rs-fl">Remind me to</span><span class="rs-fv"></span>');
    const fv = field.querySelector(".rs-fv");
    if (add.title) fv.textContent = add.title;
    else fv.appendChild(txt("i", "", "Tap to type…"));
    if (add.kb) fv.appendChild(el("i", "rs-caret"));
    field.addEventListener("click", () => {
      add.kb = true;
      renderCal();
    });
    box.appendChild(field);
    if (add.kb) {
      box.appendChild(keyboard());
      return sh;
    }
    const q = el("div", "rs-quick");
    QUICK.forEach((s) => {
      const b = txt("span", "rs-chip" + (add.title === s ? " on" : ""), s);
      b.addEventListener("click", () => {
        add.title = s;
        renderCal();
      });
      q.appendChild(b);
    });
    box.appendChild(q);
    // day + time
    const row = el("div", "rs-when");
    const dayBox = el("div", "rs-step", '<span class="rs-sb" data-a="d-">' + line("chevl") + '</span><b></b><span class="rs-sb" data-a="d+">' + line("chevr") + "</span>");
    const dd = new Date(add.day + "T00:00:00");
    dayBox.querySelector("b").textContent = add.day === dayKey(new Date()) ? "Today" : fmt(dd, { weekday: "short", day: "numeric", month: "short" });
    const tBox = el("div", "rs-step rs-time", '<span class="rs-sb" data-a="h-">' + line("minus") + '</span><b class="rs-hh"></b><span class="rs-sb" data-a="h+">' + line("plus") + '</span><em>:</em><span class="rs-sb" data-a="m-">' + line("minus") + '</span><b class="rs-mm"></b><span class="rs-sb" data-a="m+">' + line("plus") + "</span>");
    tBox.querySelector(".rs-hh").textContent = pad2(add.h);
    tBox.querySelector(".rs-mm").textContent = pad2(add.m);
    row.appendChild(dayBox);
    row.appendChild(tBox);
    Array.prototype.forEach.call(row.querySelectorAll(".rs-sb"), (b) =>
      b.addEventListener("click", () => {
        const k = b.getAttribute("data-a");
        if (k === "d-") shiftDay(-1);
        else if (k === "d+") shiftDay(1);
        else if (k === "h-") add.h = (add.h + 23) % 24;
        else if (k === "h+") add.h = (add.h + 1) % 24;
        else if (k === "m-") add.m = (add.m + 55) % 60;
        else if (k === "m+") add.m = (add.m + 5) % 60;
        renderCal();
      }),
    );
    box.appendChild(row);
    // whose phone
    const ph = el("div", "rs-phones");
    ph.appendChild(txt("span", "rs-fl", "Remind"));
    if (!c.phones.length) ph.appendChild(txt("span", "rs-nophone", "No phones yet: install the Home Assistant app on a phone and log in."));
    c.phones.forEach((p0) => {
      const b = el("span", "rs-chip rs-pchip" + (add.to[p0.id] ? " on" : ""), line("phone") + "<span></span>");
      b.lastChild.textContent = p0.name;
      b.addEventListener("click", () => {
        add.to[p0.id] = !add.to[p0.id];
        renderCal();
      });
      ph.appendChild(b);
    });
    box.appendChild(ph);
    // buttons
    const bt = el("div", "rs-btns");
    const cancel = txt("span", "rs-pill2", "Cancel");
    cancel.addEventListener("click", () => {
      add = null;
      renderCal();
    });
    const past = addWhen() < dayKey(new Date()) + "T" + pad2(new Date().getHours()) + ":" + pad2(new Date().getMinutes());
    const ok = !!add.title.trim() && !past;
    const save = txt("span", "rs-pill2 go" + (ok ? "" : " off"), past ? "That time has passed" : "Save reminder");
    save.addEventListener("click", () => {
      if (!ok) return;
      const to = Object.keys(add.to).filter((k) => add.to[k]);
      a.rsEvent("rem_add", { title: add.title.trim(), when: addWhen(), targets: to });
      a.toast("Reminder saved" + (to.length ? ": " + to.length + (to.length === 1 ? " phone" : " phones") : ""));
      selDay = add.day;
      add = null;
      renderCal();
    });
    bt.appendChild(cancel);
    bt.appendChild(save);
    box.appendChild(bt);
    return sh;
  }
  // the panel's own keyboard (the screen has no other)
  let caps = true;
  let nums = false;
  function keyboard() {
    const kb = el("div", "el-kb rs-kb");
    const rows = nums ? ["1234567890", "-/:;()&@'\"", ".,?!#%+="] : ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
    const press = (fn) => (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      fn();
      renderCal();
    };
    rows.forEach((r, ri) => {
      const row = el("div", "el-kbr");
      if (ri === 2) {
        const sh = txt("div", "el-key wide", nums ? "ABC" : caps ? "⇧" : "⇧");
        if (!nums && caps) sh.classList.add("on");
        sh.addEventListener("pointerdown", press(() => (nums ? (nums = false) : (caps = !caps))));
        row.appendChild(sh);
      }
      r.split("").forEach((ch) => {
        const show = !nums && caps ? ch.toUpperCase() : ch;
        const k = txt("div", "el-key", show);
        k.addEventListener(
          "pointerdown",
          press(() => {
            if (add.title.length < 80) add.title += show;
            if (caps && !nums) caps = false;
          }),
        );
        row.appendChild(k);
      });
      if (ri === 2) {
        const bs = el("div", "el-key wide", line("back"));
        bs.addEventListener("pointerdown", press(() => ((add.title = add.title.slice(0, -1)), add.title ? 0 : (caps = true))));
        row.appendChild(bs);
      }
      kb.appendChild(row);
    });
    const last = el("div", "el-kbr");
    const nb = txt("div", "el-key wide", nums ? "ABC" : "123");
    nb.addEventListener("pointerdown", press(() => (nums = !nums)));
    last.appendChild(nb);
    const spc = txt("div", "el-key space", "space");
    spc.addEventListener("pointerdown", press(() => add.title.length < 80 && (add.title += " ")));
    last.appendChild(spc);
    const done = txt("div", "el-key go rs-done", "Done");
    done.addEventListener("pointerdown", press(() => (add.kb = false)));
    last.appendChild(done);
    kb.appendChild(last);
    return kb;
  }
  if (calPage) calPage.render = renderCal;
  // keep the clock button's count right as Home Assistant updates arrive
  const chrome0 = chrome;
  function chromeAll() {
    chrome0();
    paintCalBtn();
    // the top-bar clock follows Settings > Clock (12 / 24 hour)
    const dev = (a.ctx && a.ctx.device && a.ctx.device()) || {};
    const ck = root.querySelector(".el-clock");
    if (ck && dev.clockFormat24h === false) {
      const d = new Date();
      ck.textContent = (d.getHours() % 12 || 12) + ":" + pad2(d.getMinutes()) + (d.getHours() < 12 ? " am" : " pm");
    }
  }

  return { cats, title, intercept, renderHome, onRoom, chrome: chromeAll, lightType, decorateCover, paintCover, startRoom: homeRoom, utilCards };
}
