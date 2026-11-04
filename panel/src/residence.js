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
//   iconShape: "ring" | "square" | "bare",         accent: "warm" | "brass" | "ice"
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

export const RS_TITLES = { lights: "Lights", climate: "Comfort", music: "Listen", watch: "Watch", shades: "Shades", cameras: "Cameras", utilities: "Utilities", security: "Security", scenes: "Scenes" };
const ORDER = ["lights", "climate", "music", "watch", "shades", "cameras", "utilities", "security", "scenes"];
const PRESETS = { villa: "villa.jpg", cape: "cape.jpg", lounge: "lounge.jpg", walnut: "walnut.jpg" };
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
  root.classList.add("rs-shape-" + (["square", "bare"].indexOf(rc.iconShape) >= 0 ? rc.iconShape : "ring"));
  root.style.setProperty("--rs-acc", ACCENTS[rc.accent] || ACCENTS.warm);

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

  function background() {
    const r = raw[a.roomIdx()] || {};
    const src = (!a.whole() && r.rsImage) || rc.houseImage || "preset:villa";
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
  function cats() {
    return ORDER.filter(has).map((k) => ({ key: k, title: RS_TITLES[k] }));
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
      const pl = ma.list().filter((x) => (x.playback_state || x.state) === "playing" && !x.synced_to && (!onlyRoom || matches(x.display_name || x.name, r)))[0];
      if (pl) {
        const m = pl.current_media || {};
        return {
          title: m.title || "Playing",
          sub: [m.artist, pl.display_name || pl.name].filter(Boolean).join(" · "),
          art: m.image_url ? ma.imageUrl(m.image_url) : "",
          pause: () => ma.cmd("players/cmd/pause", { player_id: pl.player_id }).catch(() => {}),
        };
      }
    }
    const list = onlyRoom ? r.music || [] : a.union.music || [];
    const e = list.filter((x) => a.get(x).value === "playing")[0];
    if (e) {
      const s = a.get(e);
      return {
        title: s.title || a.nameOf(e),
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
    if ((r.music || []).some((e) => a.get(e).value === "playing")) return true;
    const sp = a.sp;
    if (a.spOn && sp && sp.player && sp.player.is_playing && matches((sp.player.device || {}).name, r)) return true;
    const ma = a.ma;
    return !!(a.maOn && ma && ma.status === "ready" && ma.list().some((x) => (x.playback_state || x.state) === "playing" && matches(x.display_name || x.name, r)));
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
  function iconHtml(k) {
    const ic = rc.icons && rc.icons[k];
    const src = ic && typeof ic.src === "string" ? (ic.src.indexOf("lib:") === 0 ? libUrl(ic.src.slice(4)) : url(ic.src)) : "";
    if (src) return { html: '<img alt="" src="' + src.replace(/"/g, "%22") + '">', fill: !!ic.fill };
    return { html: line(k), fill: false };
  }
  function renderHome(p) {
    p.innerHTML = "";
    const cs = cats();
    const tall = root.classList.contains("tall");
    const n = cs.length;
    const cols = tall ? (n <= 4 ? 2 : 3) : n <= 4 ? n : n <= 10 ? Math.ceil(n / 2) : 5;
    const grid = el("div", "rs-grid");
    grid.style.width = cols * 210 + "px";
    const r = curRoom();
    cs.forEach((c) => {
      const ic = iconHtml(c.key);
      const b = el("div", "rs-btn rs-k-" + c.key, '<div class="rs-ring' + (ic.fill ? " img-fill" : "") + '">' + ic.html + '<span class="rs-badge"></span></div><div class="rs-lbl"></div>');
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
      const b = el("div", "rs-btn", '<div class="rs-ring">' + line(scIcon(s.n)) + '</div><div class="rs-lbl"></div>');
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

  return { cats, title, intercept, renderHome, onRoom: background, chrome, lightType, decorateCover, paintCover };
}
