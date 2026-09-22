// AR NSPanel Pro — panel app.
//
// Speaks the integration's MQTT protocol (see PROTOCOL.md at the repo root):
//   subscribes  {base}/config/{panels,device,license}, {base}/state/#, {base}/cmd/#,
//               {prefix}/discover, plus each alarm page's Alarmo topics
//   publishes   {base}/avail (LWT), {base}/event, {base}/sys/*
// The app owns visuals; the integration owns behaviour.

import { MqttClient } from "./mqtt.js";
import * as native from "./native.js";
import { h, glyph, iconSprite, parseJson, uid, pad2 } from "./util.js";
import { swipe, press } from "./gestures.js";
import { buildPage, alarmTopics } from "./pages.js";
import { clockView } from "./clock.js";
import { MusicAssistant } from "./ma.js";
import * as sound from "./sound.js";

const VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
const PREFIX = "ar-nspanel-pro/panel";
const LEGACY_THEMES = { cream: "warm-minimal", creamLed: "warm-minimal", white: "gallery-white", tech: "tech-loft", techLed: "tech-loft" };
const LEVEL_COLOR = { info: "#12b0f0", success: "#3fb950", warning: "#e3a008", error: "#f2543d" };
const LEVEL_ICON = { info: "notification", success: "shield-check", warning: "shield-alert", error: "shield-x" };

const log = (...a) => {
  if (window.console) console.log("[panel]", ...a);
};

// --- state -------------------------------------------------------------------

let settings = native.loadSettings();
let deviceId = settings.deviceId || "";
let base = "";
let mqtt = null;
let connected = false;
let disconnectedSince = Date.now();

let panels = native.cacheGet("panels");
let device = native.cacheGet("device") || {};
let mirror = native.cacheGet("mirror") || {};
const overlays = {}; // optimistic: key -> {patch, until}
const alarmStates = {}; // Alarmo state topic -> state string
let alarmClock = native.cacheGet("alarmClock") || { enabled: false, hour: 7, minute: 0 };
let licence = { valid: false, reason: "missing" };
let licenceToken = null;

let views = []; // [{page, view}]
let pageIdx = 0;
let awake = true;
let screenOff = false;
let lastActivity = Date.now();
let sleptAt = 0;
let returnedHome = false;
let manualBrightness = null; // from cmd/screen dim
let lux = null;
let proxNear = false;
let motion = false;
let motionClearTimer = null;
let bootAt = Date.now();

const ma = new MusicAssistant(() => {}, log);

// --- DOM scaffold ------------------------------------------------------------

const root = h("div");
root.id = "viewport";
const stage = h("div.screen.themed.kitscreen");
stage.id = "stage";
const pagesEl = h("div");
pagesEl.id = "pages";
const dotsEl = h("div");
dotsEl.id = "dots";
const saverEl = h("div");
saverEl.id = "screensaver";
const notifyEl = h("div");
notifyEl.id = "notify";
const ringEl = h("div");
ringEl.id = "ring";
const watermarkEl = h("div", null, h("div", null, "AR NSPanel Pro · unlicensed"));
watermarkEl.id = "watermark";
const statusEl = h("div");
statusEl.id = "status";
const waitingEl = h("div");
waitingEl.id = "waiting";
const settingsEl = h("div");
settingsEl.id = "settings";
const cornerEl = h("div");
cornerEl.id = "corner";
const licEl = h("div");
licEl.id = "licence";

[pagesEl, dotsEl, waitingEl, watermarkEl, saverEl, notifyEl, ringEl, statusEl, cornerEl, settingsEl, licEl].forEach((e) =>
  stage.appendChild(e),
);
root.appendChild(stage);
document.body.appendChild(iconSprite());
document.body.appendChild(root);

// The layout is authored 480 wide (the panel's native width). The screen area a
// device actually gives the WebView is not always square — status/navigation
// bars, or a taller panel — so scale to the WIDTH and let the stage be as tall
// as the screen allows: grid rows, the camera strip and the music list stretch
// into it instead of leaving black bands top and bottom.
function fit() {
  const w = window.innerWidth || 480;
  const hgt = window.innerHeight || 480;
  const s = w / 480;
  const stageH = Math.max(320, Math.round(hgt / s));
  window.__arScale = s;
  window.__arFit = { w: w, h: hgt, scale: Math.round(s * 1000) / 1000, stageH: stageH, dpr: window.devicePixelRatio || 1 };
  stage.style.setProperty("--stage-h", stageH + "px");
  stage.style.height = stageH + "px";
  stage.style.transform = "scale(" + s + ")";
  stage.style.webkitTransform = stage.style.transform;
  pagesEl.style.height = stageH + "px";
}
window.addEventListener("resize", fit);
fit();

// --- helpers -----------------------------------------------------------------

function theme() {
  const t = device.theme || (panels && panels.theme) || "tech-loft";
  return LEGACY_THEMES[t] || t;
}

function publish(sub, payload, retain) {
  if (!mqtt || !base) return false;
  return mqtt.publish(base + "/" + sub, typeof payload === "string" ? payload : JSON.stringify(payload), !!retain);
}

function publishRaw(topic, payload, retain) {
  if (!mqtt) return false;
  return mqtt.publish(topic, payload, !!retain);
}

function currentPage() {
  return views[pageIdx] ? views[pageIdx].page : null;
}

let mirrorSaveTimer = null;
function saveMirrorSoon() {
  clearTimeout(mirrorSaveTimer);
  mirrorSaveTimer = setTimeout(() => native.cacheSet("mirror", mirror), 3000);
}

// ctx handed to tiles/pages
const ctx = {
  get(key) {
    const m = mirror[key];
    const o = overlays[key];
    if (o && Date.now() < o.until) return Object.assign({}, m || {}, o.patch);
    return m;
  },
  optimistic(key, patch) {
    overlays[key] = { patch, until: Date.now() + 4000 };
    setTimeout(() => {
      const o = overlays[key];
      if (o && Date.now() >= o.until) {
        delete overlays[key];
        updateKey(key);
      }
    }, 4100);
  },
  event(button, action, extra) {
    activity();
    const page = currentPage();
    const payload = { button, action, page: page ? page.id : null };
    if (extra) for (const k in extra) payload[k] = extra[k];
    if (!publish("event", payload, false)) log("event not sent (offline)", button, action);
  },
  publishRaw,
  device: () => device,
  theme,
  alarmClock: () => alarmClock,
  alarmState: (topic) => alarmStates[topic],
  awake: () => awake,
  ma: () => ma,
  log,
};

// --- rendering ---------------------------------------------------------------

function applyTheme() {
  stage.setAttribute("data-theme", theme());
  stage.style.setProperty("--kit-icon", (device.iconSize || 32) + "px");
  stage.style.setProperty("--kit-label", (device.labelFontSize || 19) + "px");
  stage.style.setProperty("--kit-label-dy", (device.labelOffsetY || 0) + "px");
}

function render() {
  applyTheme();
  views.forEach((v) => v.view.onHide && v.view.onHide());
  while (pagesEl.firstChild) pagesEl.removeChild(pagesEl.firstChild);
  views = [];
  const pages = panels && Array.isArray(panels.pages) ? panels.pages : [];
  pages.forEach((page) => {
    let view;
    try {
      view = buildPage(page, ctx);
    } catch (e) {
      log("page " + page.id + " failed", e);
      view = { el: h("div.page", null, h("div.empty-msg", null, "Page failed: " + (e && e.message))), keys: [], update() {} };
    }
    views.push({ page, view });
    pagesEl.appendChild(view.el);
  });
  pagesEl.style.width = Math.max(1, views.length) * 480 + "px";
  if (pageIdx >= views.length) pageIdx = 0;
  showPage(pageIdx, false);
  subscribeAlarmTopics();
  updateWaiting();
}

function updateKey(key) {
  views.forEach((v) => {
    if (v.view.keys && v.view.keys.indexOf(key) >= 0) v.view.update(key);
  });
}

function showPage(idx, animate) {
  if (!views.length) return;
  idx = ((idx % views.length) + views.length) % views.length;
  const prev = views[pageIdx];
  if (prev && prev !== views[idx] && prev.view.onHide) prev.view.onHide();
  pageIdx = idx;
  pagesEl.classList.toggle("no-anim", animate === false);
  const tx = "translateX(" + -idx * 480 + "px)";
  pagesEl.style.transform = tx;
  pagesEl.style.webkitTransform = tx;
  const cur = views[idx];
  if (cur.view.onShow) cur.view.onShow();
  showDots();
}

let dotsTimer = null;
function showDots() {
  while (dotsEl.firstChild) dotsEl.removeChild(dotsEl.firstChild);
  if (views.length < 2) return;
  views.forEach((v, i) => dotsEl.appendChild(h("span" + (i === pageIdx ? ".on" : ""))));
  dotsEl.classList.add("show");
  clearTimeout(dotsTimer);
  dotsTimer = setTimeout(() => dotsEl.classList.remove("show"), 1500);
}

function goPage(spec) {
  if (!views.length) return;
  if (spec.id != null) {
    for (let i = 0; i < views.length; i++) if (views[i].page.id === spec.id) return showPage(i);
  } else if (spec.index != null) {
    showPage(Number(spec.index));
  } else if (spec.delta != null) {
    showPage(pageIdx + Number(spec.delta));
  }
}

function defaultPageIndex() {
  const d = device.defaultPage != null ? device.defaultPage : panels && panels.defaultPage;
  return typeof d === "number" && d >= 0 && d < views.length ? d : 0;
}

swipe(stage, (dir) => {
  if (!awake || settingsEl.classList.contains("show")) return;
  activity();
  showPage(pageIdx + dir);
});

// --- waiting / status --------------------------------------------------------

function updateWaiting() {
  const noPages = !panels || !Array.isArray(panels.pages) || !panels.pages.length;
  waitingEl.classList.toggle("show", noPages);
  if (!noPages) return;
  while (waitingEl.firstChild) waitingEl.removeChild(waitingEl.firstChild);
  waitingEl.appendChild(h("b", null, connected ? "Connected — waiting for a layout" : "Connecting to MQTT…"));
  waitingEl.appendChild(
    h("div", null, "In Home Assistant, add this panel under ", h("b", { style: { display: "inline", fontSize: "17px" } }, "AR NSPanel Pro"), " using the ID ", h("code", null, deviceId || "—"), ", then lay out its pages in the sidebar."),
  );
  waitingEl.appendChild(h("div.muted", null, "Broker " + (settings.brokerUrl || "not set") + " · long-press the top-left corner for setup"));
}

function updateStatus() {
  const off = !connected && Date.now() - disconnectedSince > 6000;
  statusEl.textContent = "Offline";
  statusEl.classList.toggle("show", off && !!panels);
}

// --- activity, screensaver, backlight ------------------------------------------

let swallow = false;
window.__arWakeSwallow = () => swallow;
document.addEventListener(
  "pointerdown",
  () => {
    if (!awake) {
      swallow = true;
      wake("touch");
    } else {
      activity();
    }
  },
  true,
);
document.addEventListener("pointerup", () => setTimeout(() => (swallow = false), 0), true);
document.addEventListener("pointercancel", () => (swallow = false), true);

function activity() {
  lastActivity = Date.now();
  returnedHome = false;
}

function isNight() {
  const ab = device.autoBrightness || {};
  if (!ab.enabled || lux == null) return false;
  return lux < (ab.nightThresholdLux != null ? ab.nightThresholdLux : 130);
}

function awakeBrightness() {
  if (manualBrightness != null) return manualBrightness;
  const ab = device.autoBrightness || {};
  if (ab.enabled && lux != null) return (isNight() ? ab.nightBrightness || 30 : ab.dayBrightness || 100) / 100;
  return 1;
}

function sleepBrightness() {
  const ss = device.screensaver || {};
  const ab = device.autoBrightness || {};
  if (ss.nightOffAfter && isNight() && sleptAt && Date.now() - sleptAt > ss.nightOffAfter * 1000) return 0;
  if (ab.enabled && lux != null) {
    const drop = ab.screensaverDropPoints != null ? ab.screensaverDropPoints : 10;
    return Math.max(0.01, awakeBrightness() - drop / 100);
  }
  const dim = ss.dimLevel != null ? ss.dimLevel : 0.2;
  return dim;
}

let lastBrightness = -1;
function applyBrightness() {
  let b = screenOff ? 0 : awake ? awakeBrightness() : sleepBrightness();
  b = Math.round(b * 100) / 100;
  if (b !== lastBrightness) {
    lastBrightness = b;
    native.setBrightness(b);
  }
}

function publishAwake(cause) {
  publish("sys/awake", { awake, cause: cause || null, ts: Date.now() }, true);
}

function screensaverAlarmPage() {
  for (let i = 0; i < views.length; i++) {
    const p = views[i].page;
    if (p.type !== "alarm") continue;
    if ((p.alarm || {}).screensaverWhenArmed === false) continue;
    const st = alarmStates[alarmTopics(p).state];
    if (st && st !== "disarmed" && st !== "unavailable") return i;
  }
  return -1;
}

function sleep(cause) {
  if (!awake) return;
  awake = false;
  sleptAt = Date.now();
  const ss = device.screensaver || {};
  const armedIdx = screensaverAlarmPage();
  while (saverEl.firstChild) saverEl.removeChild(saverEl.firstChild);
  saverEl.className = "";
  if (armedIdx >= 0) {
    showPage(armedIdx, false); // armed: the keypad IS the screensaver
  } else if (ss.type === "dim") {
    /* just dim the current page */
  } else if (ss.type === "black" || ss.type === "off") {
    saverEl.className = "show black";
  } else {
    const v = clockView(device, { themeKey: "clockScreensaverTheme", panelTheme: theme(), alarm: () => alarmClock });
    saverEl.appendChild(v.el);
    saverEl.__clock = v;
    saverEl.className = "show";
  }
  const cur = views[pageIdx];
  if (cur && cur.page.type === "camera" && cur.view.onHide) cur.view.onHide(); // stop the stream
  applyBrightness();
  publishAwake(cause || "timeout");
}

function wake(cause) {
  lastActivity = Date.now();
  screenOff = false;
  if (awake) {
    applyBrightness();
    return;
  }
  awake = true;
  manualBrightness = null;
  saverEl.className = "";
  saverEl.__clock = null;
  while (saverEl.firstChild) saverEl.removeChild(saverEl.firstChild);
  const armedIdx = screensaverAlarmPage();
  if (armedIdx >= 0) showPage(armedIdx, false);
  else if (cause !== "notification") showPage(defaultPageIndex(), false);
  applyBrightness();
  publishAwake(cause);
}

function tick() {
  const now = Date.now();
  const cur = views[pageIdx];
  const blockSleep =
    (cur && cur.view.keepAwake && cur.page.type === "camera") ||
    ringEl.classList.contains("show") ||
    settingsEl.classList.contains("show") ||
    (notification && notification.full);
  if (awake) {
    const inact = (device.inactivityTimeout != null ? device.inactivityTimeout : 60) * 1000;
    if (!returnedHome && now - lastActivity > inact && views.length && pageIdx !== defaultPageIndex() && !(cur && cur.view.keepOnPage)) {
      returnedHome = true;
      if (!settingsEl.classList.contains("show")) showPage(defaultPageIndex());
    }
    const ss = device.screensaver || {};
    const after = (ss.after != null ? ss.after : 120) * 1000;
    if (!blockSleep && ss.enabled !== false && now - lastActivity > after && panels) sleep("timeout");
  } else if (saverEl.__clock) {
    saverEl.__clock.update();
  }
  applyBrightness();
  updateStatus();
  checkAlarmClock();
}
setInterval(tick, 1000);

// --- sensors -----------------------------------------------------------------

let lastLuxSent = null;
let lastLuxAt = 0;
native.on("light", (d) => {
  lux = typeof d === "object" ? d.lux : Number(d);
  const now = Date.now();
  const changed = lastLuxSent == null || Math.abs(lux - lastLuxSent) > Math.max(3, lastLuxSent * 0.15);
  if (changed || now - lastLuxAt > 60000) {
    lastLuxSent = lux;
    lastLuxAt = now;
    publish("sys/light", { raw: Math.round(lux) }, true);
  }
});

native.on("proximity", (d) => {
  const value = Number(d.value);
  const max = Number(d.max) || 0;
  const ss = device.screensaver || {};
  const prox = ss.proximity || {};
  let near;
  if (max > 0 && max <= 10) {
    near = value < max; // standard distance sensor: "near" below max range
  } else {
    // NSPanel raw counts: hysteresis between on/off thresholds
    const on = prox.on != null ? prox.on : 40;
    const off = prox.off != null ? prox.off : 10;
    near = proxNear ? value > off : value >= on;
  }
  if (near !== proxNear) {
    proxNear = near;
    if (near && !awake && ss.wakeOnProximity !== false) wake("proximity");
  }
  // motion (presence) — separate threshold + clear delay
  const m = device.motion || {};
  if (m.enabled === false) return;
  const mOn = m.on != null ? m.on : 40;
  const hit = max > 0 && max <= 10 ? value < max : value >= mOn;
  if (hit) {
    clearTimeout(motionClearTimer);
    motionClearTimer = null;
    if (!motion) {
      motion = true;
      publish("sys/motion", { motion: true }, true);
    }
  } else if (motion && !motionClearTimer) {
    motionClearTimer = setTimeout(() => {
      motionClearTimer = null;
      motion = false;
      publish("sys/motion", { motion: false }, true);
    }, (m.clearS != null ? m.clearS : 15) * 1000);
  }
});

// --- info / discovery ----------------------------------------------------------

function info() {
  const i = native.deviceInfo();
  return {
    deviceId,
    model: i.model,
    version: i.version && i.version !== "web" ? i.version : VERSION,
    uiVersion: VERSION,
    fwVersion: i.fwVersion,
    serial: i.serial,
    serverId: i.serverId,
    ip: i.ip,
    rssi: i.rssi,
    uptimeS: i.uptimeS,
    freeMemMB: i.freeMemMB,
    webview: i.webview,
    screen: fitInfo().w + "x" + fitInfo().h,
    uiSize: "480x" + fitInfo().stageH,
    scale: fitInfo().scale,
    dpr: fitInfo().dpr,
  };
}

function fitInfo() {
  return window.__arFit || { w: 0, h: 0, stageH: 0, scale: 1, dpr: 1 };
}

function publishInfo() {
  publish("sys/info", info(), true);
}

let infoTimer = null;
function scheduleInfo() {
  clearInterval(infoTimer);
  const s = Math.max(15, device.sysInfoIntervalS || 60);
  infoTimer = setInterval(publishInfo, s * 1000);
}

// --- licence -------------------------------------------------------------------

function applyLicence(token) {
  licenceToken = token;
  const r = native.verifyLicense(token || "");
  licence = r || { valid: false, reason: "unavailable" };
  watermarkEl.classList.toggle("show", !licence.valid);
  publish("sys/license", licence, true);
  native.cacheSet("license", token || null);
}

// --- notifications -------------------------------------------------------------

let notification = null; // {id, full, timer}
let notifyAudio = null;

function notifyState(p) {
  publish("sys/notification", p, true);
}

function closeNotification(status, actionId) {
  if (!notification) return;
  const n = notification;
  notification = null;
  clearTimeout(n.timer);
  while (notifyEl.firstChild) notifyEl.removeChild(notifyEl.firstChild);
  const out = { id: n.id, status, ts: Date.now() };
  if (actionId) out.actionId = actionId;
  publish("sys/notification", out, false); // the outcome (news)…
  notifyState({}); // …then the retained state goes back to "nothing shown"
}

function playSound(ref) {
  if (!ref) return;
  if (/^(https?:|data:|\/)/.test(ref)) {
    try {
      if (notifyAudio) notifyAudio.pause();
      notifyAudio = new Audio(ref);
      notifyAudio.play().catch((e) => log("sound", e && e.message));
    } catch (e) {
      log("sound failed", e);
    }
  } else {
    sound.playOnce(ref);
  }
}

function showNotification(p) {
  if (notification) {
    clearTimeout(notification.timer);
    while (notifyEl.firstChild) notifyEl.removeChild(notifyEl.firstChild);
  }
  const id = p.id || "n-" + uid();
  const level = LEVEL_COLOR[p.level] ? p.level : "info";
  const color = LEVEL_COLOR[level];
  const actions = Array.isArray(p.actions) ? p.actions.slice(0, 3) : [];
  const full = p.priority === "high" || actions.length > 0;
  const badge = (cls) => h(cls, { style: { background: color } }, glyph(p.icon || LEVEL_ICON[level]));
  let el;
  if (full) {
    const close = h("div.nf-close", null, glyph("close"));
    press(close, { onTap: () => closeNotification("dismissed") });
    const acts = actions.length
      ? h(
          "div.nf-acts",
          null,
          actions.map((a) => {
            const b = h("div.nf-act", null, a.icon ? glyph(a.icon) : null, h("span", null, a.label || a.id));
            press(b, { onTap: () => closeNotification("action", a.id) });
            return b;
          }),
        )
      : null;
    el = h(
      "div.nf",
      { style: { borderColor: color } },
      close,
      p.image ? h("img.nf-img", { src: p.image }) : badge("div.nf-badge"),
      p.title ? h("div.nf-title", null, p.title) : null,
      p.message ? h("div.nf-msg", null, p.message) : null,
      acts,
    );
  } else {
    el = h(
      "div.nb",
      null,
      h("div.nb-bar", { style: { background: color } }),
      p.image ? h("img.nb-img", { src: p.image }) : badge("div.nb-badge"),
      h("div.nb-text", null, h("b", null, p.title || p.message || ""), p.title && p.message ? h("span", null, p.message) : null),
    );
    press(el, { onTap: () => closeNotification("dismissed") });
  }
  notifyEl.appendChild(el);
  const timeout = p.timeoutS != null ? Number(p.timeoutS) : 60;
  notification = { id, full };
  if (timeout > 0) notification.timer = setTimeout(() => closeNotification("expired"), timeout * 1000);
  wake("notification");
  activity();
  playSound(p.sound);
  notifyState({ id, status: "shown", title: p.title || null, message: p.message || null, level, priority: p.priority || "normal", ts: Date.now() });
}

// --- media player (the HA media_player entity) -----------------------------------

const player = new Audio();
player.preload = "auto";
let media = { state: "idle", volume: native.getVolume() != null ? native.getVolume() : 1, muted: false };

function publishMedia() {
  const d = player.duration;
  media.durationS = isFinite(d) ? Math.round(d) : null;
  media.positionS = isFinite(player.currentTime) ? Math.round(player.currentTime) : null;
  media.positionTs = Date.now();
  publish("sys/media", media, true);
}
["playing", "pause", "ended", "error", "loadedmetadata", "seeked"].forEach((evt) =>
  player.addEventListener(evt, () => {
    if (evt === "playing") media.state = "playing";
    else if (evt === "pause" && media.state === "playing") media.state = player.ended ? "idle" : "paused";
    else if (evt === "ended" || evt === "error") media.state = "idle";
    publishMedia();
  }),
);

function setVolume(v) {
  media.volume = Math.max(0, Math.min(1, v));
  if (!native.setVolume(media.volume)) player.volume = media.volume;
  publishMedia();
}

function mediaCmd(p) {
  const a = p.action;
  if (a === "play" && p.url) {
    media.url = p.url;
    media.title = p.title || null;
    media.asset = null;
    player.src = p.url;
    player.play().catch((e) => {
      log("play failed", e && e.message);
      media.state = "idle";
      publishMedia();
    });
    wake("media");
  } else if (a === "resume") {
    player.play().catch(() => {});
  } else if (a === "pause") {
    player.pause();
    media.state = "paused";
    publishMedia();
  } else if (a === "stop") {
    player.pause();
    player.removeAttribute("src");
    media.state = "idle";
    media.url = null;
    publishMedia();
  } else if (a === "volume" && typeof p.volume === "number") {
    setVolume(p.volume);
  } else if (a === "mute") {
    media.muted = !!p.muted;
    player.muted = media.muted;
    publishMedia();
  }
}

// --- siren (HA siren entity + Alarmo "triggered") --------------------------------

const sirenSources = {};
let sirenLoop = null;
let sirenTone = null;
function setSiren(source, on, tone) {
  if (on) sirenSources[source] = tone || "siren";
  else delete sirenSources[source];
  const want = sirenSources.ha || sirenSources.alarmo || null;
  if (want && (!sirenLoop || sirenTone !== want)) {
    if (sirenLoop) sirenLoop.stop();
    sirenTone = want;
    sirenLoop = sound.loop(want);
    wake("siren");
  } else if (!want && sirenLoop) {
    sirenLoop.stop();
    sirenLoop = null;
    sirenTone = null;
  }
}

// --- alarm clock -----------------------------------------------------------------

let ringLoop = null;
let lastRingKey = "";
let snoozeUntil = 0;
function publishAlarmClock() {
  publish("sys/alarm", alarmClock, true);
}
function checkAlarmClock() {
  const d = new Date();
  const key = d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate() + " " + d.getHours() + ":" + d.getMinutes();
  const due = alarmClock.enabled && d.getHours() === alarmClock.hour && d.getMinutes() === alarmClock.minute;
  const snoozeDue = snoozeUntil && Date.now() >= snoozeUntil;
  if ((due && key !== lastRingKey) || snoozeDue) {
    lastRingKey = key;
    snoozeUntil = 0;
    ring();
  }
}
function ring() {
  if (ringLoop) return;
  wake("alarm");
  ringLoop = sound.loop("alarm");
  while (ringEl.firstChild) ringEl.removeChild(ringEl.firstChild);
  const now = new Date();
  const stop = h("div.r-btn.primary", null, "Stop");
  const snooze = h("div.r-btn", null, "Snooze");
  press(stop, { onTap: () => stopRing() });
  press(snooze, {
    onTap() {
      stopRing();
      snoozeUntil = Date.now() + 9 * 60000;
    },
  });
  ringEl.appendChild(h("div.r-time", null, pad2(now.getHours()) + ":" + pad2(now.getMinutes())));
  ringEl.appendChild(h("div.r-sub", null, "Alarm"));
  ringEl.appendChild(h("div.r-btns", null, snooze, stop));
  ringEl.classList.add("show");
  publish("event", { button: "alarm", action: "alarm_fired", page: currentPage() ? currentPage().id : null }, false);
  setTimeout(stopRing, 5 * 60000);
}
function stopRing() {
  if (ringLoop) ringLoop.stop();
  ringLoop = null;
  ringEl.classList.remove("show");
  activity();
}

// --- screenshot / remote touch -----------------------------------------------------

native.on("screenshot", (d) => {
  if (d && d.data) publish("sys/screenshot", { id: d.id, data: d.data, ts: Date.now() }, false);
});

function remoteTouch(p) {
  const s = window.__arScale || 1;
  const r = stage.getBoundingClientRect();
  const x = r.left + Number(p.x) * s;
  const y = r.top + Number(p.y) * s;
  const target = document.elementFromPoint(x, y);
  if (!target) return;
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 77, pointerType: "touch", isPrimary: true, button: 0 };
  const P = window.PointerEvent;
  if (!P) return;
  target.dispatchEvent(new P("pointerdown", init));
  setTimeout(() => {
    target.dispatchEvent(new P("pointerup", init));
  }, Math.max(20, Math.min(2000, p.ms || 80)));
}

// --- commands ------------------------------------------------------------------------

function handleCmd(name, p) {
  switch (name) {
    case "wake":
      wake("command");
      break;
    case "screen":
      if (p.action === "off") {
        screenOff = true;
        if (awake) sleep("command");
        applyBrightness();
      } else if (p.action === "dim") {
        manualBrightness = typeof p.brightness === "number" ? p.brightness : 0.2;
        screenOff = false;
        applyBrightness();
      } else {
        manualBrightness = typeof p.brightness === "number" ? p.brightness : null;
        wake("command");
        applyBrightness();
      }
      break;
    case "page":
      wake("command");
      activity();
      goPage(p);
      break;
    case "ping":
      publish("sys/pong", { id: p.id, ts: Date.now() }, false);
      break;
    case "info":
      publishInfo();
      break;
    case "screenshot":
      if (!native.requestScreenshot(p.id || uid())) log("screenshot: needs the Android app");
      break;
    case "set_alarm":
      alarmClock = { enabled: !!p.enabled, hour: Number(p.hour) || 0, minute: Number(p.minute) || 0 };
      native.cacheSet("alarmClock", alarmClock);
      publishAlarmClock();
      break;
    case "play_media":
      if (typeof p.volume === "number") setVolume(p.volume);
      if (p.url) mediaCmd({ action: "play", url: p.url });
      else if (p.asset) {
        media.asset = p.asset;
        sound.playOnce(p.asset);
      }
      break;
    case "stop_media":
      mediaCmd({ action: "stop" });
      break;
    case "media":
      mediaCmd(p);
      break;
    case "siren":
      setSiren("ha", !!p.on, p.tone);
      break;
    case "notify":
      showNotification(p);
      break;
    case "notify_clear":
      if (notification && (!p.id || p.id === notification.id)) closeNotification("dismissed");
      break;
    case "touch":
      remoteTouch(p);
      break;
    case "license_status":
      licenceStatus = { status: p.status || "", message: p.message || "", ts: Date.now() };
      if (licEl.classList.contains("show")) openLicence();
      break;
    case "ma_auth":
      ma.configure({ url: p.url || (device.musicAssistant || {}).url, username: p.username, password: p.password });
      break;
    default:
      log("unknown cmd", name);
  }
}

// --- MQTT ----------------------------------------------------------------------------

const alarmSubs = {};
function subscribeAlarmTopics() {
  if (!mqtt) return;
  views.forEach((v) => {
    if (v.page.type !== "alarm") return;
    const t = alarmTopics(v.page);
    if (!alarmSubs[t.state]) {
      alarmSubs[t.state] = "state";
      mqtt.subscribe(t.state);
    }
    if (!alarmSubs[t.event]) {
      alarmSubs[t.event] = "event";
      mqtt.subscribe(t.event);
    }
  });
}

function onAlarmState(topic, payload) {
  const st = String(payload || "").trim();
  const prev = alarmStates[topic];
  alarmStates[topic] = st;
  views.forEach((v) => {
    if (v.page.type === "alarm" && alarmTopics(v.page).state === topic) v.view.update();
  });
  const triggered = Object.keys(alarmStates).some((k) => alarmStates[k] === "triggered");
  if (triggered !== !!sirenSources.alarmo) setSiren("alarmo", triggered, "siren");
  if (st === "triggered" && prev !== "triggered") {
    for (let i = 0; i < views.length; i++) {
      if (views[i].page.type === "alarm" && alarmTopics(views[i].page).state === topic) {
        wake("alarm");
        showPage(i);
        break;
      }
    }
  }
}

function onMessage(topic, payload) {
  if (alarmSubs[topic] === "state") return onAlarmState(topic, payload);
  if (alarmSubs[topic] === "event") {
    const ev = parseJson(payload);
    views.forEach((v) => {
      if (v.page.type === "alarm" && alarmTopics(v.page).event === topic && v.view.onAlarmEvent) v.view.onAlarmEvent(ev);
    });
    return;
  }
  if (topic === PREFIX + "/discover") {
    const i = info();
    publish("sys/discovery", { deviceId, model: i.model, ip: i.ip, version: i.version }, false);
    return;
  }
  if (topic.indexOf(base + "/") !== 0) return;
  const sub = topic.slice(base.length + 1);
  if (sub === "config/panels") {
    const doc = parseJson(payload);
    if (!Array.isArray(doc.pages)) {
      if (!payload) {
        panels = null;
        native.cacheSet("panels", null);
        render();
      }
      return;
    }
    panels = doc;
    native.cacheSet("panels", panels);
    render();
  } else if (sub === "config/device") {
    device = parseJson(payload);
    native.cacheSet("device", device);
    const maCfg = device.musicAssistant || {};
    if (maCfg.enabled === false) ma.configure(null);
    else if (maCfg.url && (!ma.cfg || ma.cfg.url !== maCfg.url)) ma.configure({ url: maCfg.url, username: ma.cfg && ma.cfg.username, password: ma.cfg && ma.cfg.password });
    scheduleInfo();
    render();
  } else if (sub === "config/license") {
    applyLicence(payload);
  } else if (sub.indexOf("state/") === 0) {
    const key = sub.slice(6);
    if (!payload) delete mirror[key];
    else mirror[key] = parseJson(payload);
    delete overlays[key];
    updateKey(key);
    saveMirrorSoon();
  } else if (sub.indexOf("cmd/") === 0) {
    handleCmd(sub.slice(4), parseJson(payload));
  }
}

function connect() {
  if (mqtt) mqtt.stop();
  mqtt = null;
  connected = false;
  if (!settings.brokerUrl || !deviceId) {
    openSettings();
    return;
  }
  base = PREFIX + "/" + deviceId;
  mqtt = new MqttClient({
    url: settings.brokerUrl,
    clientId: "ar-nspanel-" + deviceId + "-" + uid().slice(0, 4),
    username: settings.username || "",
    password: settings.password || "",
    keepalive: 30,
    will: { topic: base + "/avail", payload: "offline", retain: true },
    log,
    onConnect() {
      connected = true;
      connectError = null;
      publish("avail", "online", true);
      publishInfo();
      publishAwake("connect");
      publishAlarmClock();
      publishMedia();
      if (licence && licence.reason) publish("sys/license", licence, true);
      notifyState({});
      updateWaiting();
      scheduleInfo();
    },
    onClose() {
      connected = false;
      disconnectedSince = Date.now();
      updateWaiting();
    },
    onRefused(rc) {
      connectError = rc === 4 || rc === 5 ? "Broker refused the username/password" : "Broker refused the connection (code " + rc + ")";
    },
    onMessage,
  });
  [
    base + "/config/panels",
    base + "/config/device",
    base + "/config/license",
    base + "/state/#",
    base + "/cmd/#",
    PREFIX + "/discover",
  ].forEach((t) => mqtt.subscribe(t));
  Object.keys(alarmSubs).forEach((t) => mqtt.subscribe(t));
  mqtt.start();
  subscribeAlarmTopics();
}

// --- settings / setup screen ------------------------------------------------------

let connectError = null;
function openSettings() {
  while (settingsEl.firstChild) settingsEl.removeChild(settingsEl.firstChild);
  const i = info();
  const field = (label, key, type, placeholder) => {
    const input = h("input", { type: type || "text", value: settings[key] || "", placeholder: placeholder || "", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    return { label: h("label", null, label), input, key };
  };
  const fields = [
    field("MQTT broker (WebSocket URL)", "brokerUrl", "text", "ws://192.168.1.10:1884"),
    field("Username", "username"),
    field("Password", "password", "password"),
    field("Panel ID (the id you add in Home Assistant)", "deviceId", "text", "panel-kitchen"),
  ];
  if (native.isNative) fields.push(field("Load UI from (optional URL, blank = built-in)", "uiUrl", "text", "http://homeassistant.local:8123/ar_nspanel_pro_static/app/index.html"));
  if (!settings.deviceId) fields[3].input.value = deviceId || "panel-" + uid().slice(0, 6);
  const err = h("div.err", null, connectError || "");
  const save = h("button.primary", null, "Save & connect");
  const cancel = h("button", null, "Close");
  save.addEventListener("click", () => {
    const next = Object.assign({}, settings);
    fields.forEach((f) => (next[f.key] = f.input.value.trim()));
    if (!/^wss?:\/\//i.test(next.brokerUrl)) {
      err.textContent = "The broker URL must start with ws:// or wss:// (e.g. ws://192.168.1.10:1884 for the Mosquitto add-on).";
      return;
    }
    if (!next.deviceId || next.deviceId.toLowerCase() === "discover" || /[\s/#+]/.test(next.deviceId)) {
      err.textContent = "Pick a panel ID without spaces, / # or +.";
      return;
    }
    const uiChanged = (next.uiUrl || "") !== (settings.uiUrl || "");
    settings = next;
    native.saveSettings(settings);
    deviceId = settings.deviceId;
    settingsEl.classList.remove("show");
    if (uiChanged && native.isNative) {
      native.setUiUrl(settings.uiUrl || "");
      return;
    }
    connect();
    updateWaiting();
  });
  cancel.addEventListener("click", () => {
    settingsEl.classList.remove("show");
    activity();
  });
  settingsEl.appendChild(h("h2", null, "Panel setup"));
  settingsEl.appendChild(h("div.sub", null, "AR NSPanel Pro " + VERSION + (connected ? " · connected" : " · not connected")));
  fields.forEach((f) => {
    settingsEl.appendChild(f.label);
    settingsEl.appendChild(f.input);
  });
  settingsEl.appendChild(err);
  settingsEl.appendChild(h("div.row", null, cancel, save));
  settingsEl.appendChild(
    h(
      "div.kv",
      null,
      "IP " + (i.ip || "—"),
      h("br"),
      "Licence Server ID " + (i.serverId || "—") + " · " + (licence.valid ? "licensed" : licence.reason || "unlicensed"),
      h("br"),
      "Model " + (i.model || "—") + " · WebView " + (i.webview || "—"),
      h("br"),
      "Screen " + fitInfo().w + "x" + fitInfo().h + " · UI 480x" + fitInfo().stageH + " · scale " + fitInfo().scale + " · dpr " + fitInfo().dpr,
    ),
  );
  settingsEl.classList.add("show");
}

// --- licence request (tap the watermark) ------------------------------------------
//
// The panel never talks to the licence server itself — it asks Home Assistant,
// which posts the Server ID and keeps checking until the key is issued.

let licenceStatus = { status: "", message: "" };
const licFields = { client: "", email: "" };

function licenceLabel() {
  if (licence.valid) return ["Licensed", "This panel is licensed. No watermark."];
  switch (licence.reason) {
    case "missing":
      return ["Not licensed", "Request a licence for this panel — the watermark goes away once it is issued."];
    case "expired":
      return ["Licence expired", "Request a renewal for this panel."];
    case "serial_mismatch":
      return ["Wrong panel", "This key was issued for a different Server ID."];
    case "wrong_product":
      return ["Wrong product", "This key was issued for a different AR product."];
    case "bad_signature":
      return ["Invalid key", "This key was not signed by AR Smart Home."];
    case "unavailable":
      return ["Cannot verify", "Licences are only verified by the AR NSPanel Pro app."];
    default:
      return ["Not licensed", licence.reason || ""];
  }
}

function openLicence() {
  const i = info();
  const serverId = licence.serial || i.serverId || "—";
  while (licEl.firstChild) licEl.removeChild(licEl.firstChild);
  const label = licenceLabel();
  const field = (text, key, placeholder) => {
    const input = h("input", { type: "text", value: licFields[key], placeholder: placeholder, autocapitalize: "off", spellcheck: "false" });
    input.addEventListener("input", () => (licFields[key] = input.value));
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    return [h("label", null, text), input];
  };
  const client = field("Site / client (optional)", "client", "Kruger Lodge");
  const email = field("Email (optional)", "email", "you@example.com");
  const req = h("button.primary", null, licence.valid ? "Renew licence" : "Request licence");
  const close = h("button", null, "Close");
  req.addEventListener("click", () => {
    licenceStatus = { status: "sending", message: "Sending…" };
    publish("sys/license_request", { action: "request", client: licFields.client, email: licFields.email, ts: Date.now() }, false);
    openLicence();
  });
  close.addEventListener("click", () => {
    licEl.classList.remove("show");
    activity();
  });
  const statusClass =
    licenceStatus.status === "issued" ? ".ok" : licenceStatus.status === "error" ? ".bad" : licenceStatus.status ? ".wait" : "";
  licEl.appendChild(h("h2", null, label[0]));
  licEl.appendChild(h("div.sub", null, label[1]));
  licEl.appendChild(h("label", null, "Server ID"));
  licEl.appendChild(h("div.serial", null, serverId));
  licEl.appendChild(client[0]);
  licEl.appendChild(client[1]);
  licEl.appendChild(email[0]);
  licEl.appendChild(email[1]);
  if (licenceStatus.message) licEl.appendChild(h("div.licmsg" + statusClass, null, licenceStatus.message));
  licEl.appendChild(h("div.row", null, close, req));
  if (!connected) licEl.appendChild(h("div.licmsg.bad", null, "Not connected to Home Assistant — the request cannot be sent yet."));
  licEl.classList.add("show");
  activity();
}

watermarkEl.addEventListener("click", () => {
  if (!awake) return;
  openLicence();
});

// long-press the top-left corner (3 s) opens setup
let cornerTimer = null;
cornerEl.addEventListener("pointerdown", () => {
  clearTimeout(cornerTimer);
  cornerTimer = setTimeout(openSettings, 3000);
});
["pointerup", "pointercancel", "pointerleave"].forEach((e) => cornerEl.addEventListener(e, () => clearTimeout(cornerTimer)));

// --- boot ------------------------------------------------------------------------------

applyLicence(native.cacheGet("license"));
render();
applyBrightness();
connect();
log("AR NSPanel Pro UI " + VERSION + " started" + (native.isNative ? " (native)" : " (browser)"));
window.__arPanel = { ctx, mirror: () => mirror, views: () => views, handleCmd, onMessage, settings: () => settings, sleep, wake };
void bootAt;
