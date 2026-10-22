// Hardware knob / keys (HDL Source 10 rotary knob and similar).
//
// The Android app forwards physical key events ("key": {code, name, action,
// repeat}) and rotary/scroll motion ("scroll": {value}). They become panel
// events for Home Assistant on the "knob" button:
//
//   rotate_cw / rotate_ccw  one per detent (value = the Android key name)
//   press / long_press      the knob's push (long = held 600 ms)
//   key                     any other physical key (value = its key name),
//                           so an unknown key can still drive an automation
//
// Which key names count as a turn or a push is guessed from the common
// encodings below (F1 = right turn, F2 = left turn on the HDL Source 10;
// F3 = right, F4 = left and F2 = push on the HDL Source 7);
// anything else still arrives as "key".

import * as native from "./native.js";

const set = (list) => list.reduce((o, k) => ((o["KEYCODE_" + k] = true), o), {});

const CW = set(["F1", "F3", "VOLUME_UP", "DPAD_RIGHT", "DPAD_DOWN", "MEDIA_NEXT", "PAGE_DOWN", "TAB", "NAVIGATE_NEXT", "SYSTEM_NAVIGATION_DOWN", "SYSTEM_NAVIGATION_RIGHT", "MOVE_END"]);
const CCW = set(["F2", "F4", "VOLUME_DOWN", "DPAD_LEFT", "DPAD_UP", "MEDIA_PREVIOUS", "PAGE_UP", "NAVIGATE_PREVIOUS", "SYSTEM_NAVIGATION_UP", "SYSTEM_NAVIGATION_LEFT", "MOVE_HOME"]);
const PUSH = set(["ENTER", "DPAD_CENTER", "NUMPAD_ENTER", "SPACE", "MEDIA_PLAY_PAUSE", "HEADSETHOOK", "BUTTON_A", "BUTTON_SELECT"]);

const LONG_MS = 600;

/** send(action, extra) publishes one knob event. */
// The HDL Source 7 pushes the knob with F2, which is a LEFT TURN on the Source
// 10. A Source 7 is recognised by its 1280x720 screen, or the first time it
// sends F3/F4 (only it does) -- and remembered.
const S7_KEY = "ar-knob-source7";
let source7 = false;
try {
  source7 = window.localStorage.getItem(S7_KEY) === "1";
} catch (e) {
  /* no storage */
}
if (!source7 && window.screen && Math.max(screen.width, screen.height) === 1280 && Math.min(screen.width, screen.height) === 720) source7 = true;
function markSource7() {
  if (source7) return;
  source7 = true;
  try {
    window.localStorage.setItem(S7_KEY, "1");
  } catch (e) {
    /* no storage */
  }
}

export function initKnob(send) {
  let longTimer = null;
  let longSent = false;
  let pushKey = null;

  // Encoder bounce: on a fast spin the knob now and then reports one click in
  // the wrong direction. A reversal within BOUNCE_MS of the last click is
  // dropped; a real change of direction (a pause, or two reverse clicks in a
  // row) goes through.
  const BOUNCE_MS = 140;
  let lastDir = 0;
  let lastAt = 0;
  let pendingRev = 0;
  function turn(dir, value) {
    const now = Date.now();
    if (lastDir && dir !== lastDir && now - lastAt < BOUNCE_MS && pendingRev !== dir) {
      pendingRev = dir; // ignore this one; a second reverse click confirms it
      lastAt = now;
      return;
    }
    pendingRev = 0;
    lastDir = dir;
    lastAt = now;
    send(dir > 0 ? "rotate_cw" : "rotate_ccw", { value: value });
  }

  native.on("key", (d) => {
    if (!d || typeof d !== "object") return;
    const name = String(d.name || "KEYCODE_" + d.code);
    if (name === "KEYCODE_F3" || name === "KEYCODE_F4") markSource7();
    const s7push = source7 && name === "KEYCODE_F2";
    if (d.action === "down") {
      if (CW[name]) return turn(1, name);
      if (CCW[name] && !s7push) return turn(-1, name);
      if (PUSH[name] || s7push) {
        if (d.repeat > 0 || pushKey === name) return; // held: the timer decides
        pushKey = name;
        longSent = false;
        clearTimeout(longTimer);
        longTimer = setTimeout(() => {
          longSent = true;
          send("long_press", { value: name });
        }, LONG_MS);
        return;
      }
      if (!d.repeat) send("key", { value: name });
    } else if (d.action === "up" && (PUSH[name] || s7push) && pushKey === name) {
      clearTimeout(longTimer);
      pushKey = null;
      if (!longSent) send("press", { value: name });
    }
  });

  native.on("scroll", (d) => {
    const v = Number(d && typeof d === "object" ? d.value : d) || 0;
    if (!v) return;
    // Scrolling "down" (negative) is a clockwise turn on most encoders.
    const steps = Math.min(10, Math.max(1, Math.round(Math.abs(v))));
    for (let i = 0; i < steps; i++) turn(v < 0 ? 1 : -1, "scroll");
  });
}
