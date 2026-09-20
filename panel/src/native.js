// Bridge to the Android wrapper (window.ARNative, injected by the APK's
// WebView). Every call has a browser fallback so the same UI runs in a desktop
// browser or a third-party kiosk browser for development — minus the hardware
// bits (sensors, backlight, screenshots, licence verification).

const N = typeof window !== "undefined" ? window.ARNative : undefined;
const listeners = {};

export const isNative = !!N;

function call(name, ...args) {
  if (!N || typeof N[name] !== "function") return undefined;
  try {
    return N[name].apply(N, args);
  } catch (e) {
    console.warn("native", name, "failed", e);
    return undefined;
  }
}

function parse(s, fallback) {
  if (typeof s !== "string" || !s) return fallback;
  try {
    return JSON.parse(s);
  } catch (e) {
    return fallback;
  }
}

// Native → JS events arrive through window.__arNative.emit(type, json).
window.__arNative = {
  emit(type, json) {
    const data = parse(json, json);
    (listeners[type] || []).forEach((fn) => {
      try {
        fn(data);
      } catch (e) {
        console.warn("native listener", type, e);
      }
    });
  },
};

export function on(type, fn) {
  (listeners[type] = listeners[type] || []).push(fn);
}

const LS_KEY = "ar-nspanel-pro.settings";

function lsGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function lsSet(key, value) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch (e) {
    /* storage unavailable: settings live for this session only */
  }
}

const memory = {};

export function loadSettings() {
  const s = N ? call("getSettings") : lsGet(LS_KEY);
  return parse(s, {}) || {};
}

export function saveSettings(obj) {
  const json = JSON.stringify(obj);
  if (N) call("saveSettings", json);
  else lsSet(LS_KEY, json);
}

/** Small key/value cache for the offline boot (last config + mirror). */
export function cacheGet(key) {
  const s = N ? call("cacheGet", key) : lsGet("ar-nspanel-pro.cache." + key);
  if (s == null && memory[key] != null) return memory[key];
  return parse(s, null);
}

export function cacheSet(key, value) {
  const json = value == null ? null : JSON.stringify(value);
  memory[key] = value;
  if (N) call("cachePut", key, json == null ? "" : json);
  else lsSet("ar-nspanel-pro.cache." + key, json);
}

export function deviceInfo() {
  const info = parse(call("getInfo"), null);
  if (info) return info;
  const ua = navigator.userAgent || "";
  return {
    model: "Browser",
    version: "web",
    fwVersion: null,
    serial: null,
    serverId: null,
    ip: null,
    rssi: null,
    uptimeS: Math.round(performance.now() / 1000),
    freeMemMB: null,
    webview: (ua.match(/Chrome\/([\d.]+)/) || [])[1] || ua.slice(0, 60),
  };
}

// --- backlight ---------------------------------------------------------------
// In a browser there is no backlight, so dimming is simulated with an overlay.
let overlay = null;
function overlayEl() {
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "dim-overlay";
    document.body.appendChild(overlay);
  }
  return overlay;
}

/** 0..1 panel brightness; 0 = backlight off. */
export function setBrightness(level) {
  const v = Math.max(0, Math.min(1, level));
  if (N) {
    call("setBrightness", v);
  } else {
    overlayEl().style.opacity = String(Math.min(0.92, 1 - v));
    if (v <= 0) overlayEl().style.opacity = "1";
  }
}

export function setVolume(level) {
  return call("setVolume", Math.max(0, Math.min(1, level))) !== undefined;
}

export function getVolume() {
  const v = call("getVolume");
  return typeof v === "number" ? v : null;
}

export function sensorsAvailable() {
  return parse(call("getSensors"), { light: false, proximity: false });
}

export function verifyLicense(token) {
  if (!N) return { valid: false, reason: "unavailable" };
  return parse(call("verifyLicense", token || ""), { valid: false, reason: "unavailable" });
}

export function requestScreenshot(id) {
  if (!N) return false;
  call("screenshot", id);
  return true;
}

export function setUiUrl(url) {
  call("setUiUrl", url || "");
}

export function reloadApp() {
  if (N) call("reload");
  else window.location.reload();
}

export function keepScreenOn(on) {
  call("keepScreenOn", !!on);
}
