// Setup-screen password (Device Setup > Licence > ⋮ > Panel setup password).
//
// When the installer has set one, holding the corner asks for it before the
// setup screen opens. Home Assistant only ever sends a salted SHA-256 of it
// (device.setupPin = {salt, hash}), never the password itself. No password set:
// the setup screen opens straight away, as before.

import { h } from "./util.js";

// small SHA-256 (the panel's WebView has no crypto.subtle on a plain-http page)
export function sha256(str) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = unescape(encodeURIComponent(str));
  const l = bytes.length;
  const words = [];
  for (let i = 0; i < l; i++) words[i >> 2] |= (bytes.charCodeAt(i) & 255) << (24 - (i % 4) * 8);
  words[l >> 2] |= 0x80 << (24 - (l % 4) * 8);
  const n = (((l + 8) >> 6) + 1) * 16;
  for (let i = (l >> 2) + 1; i < n; i++) words[i] = words[i] | 0;
  words[n - 1] = l * 8;
  let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const W = new Array(64);
  const r = (x, s) => (x >>> s) | (x << (32 - s));
  for (let j = 0; j < n; j += 16) {
    let [a, b, c, d, e, f, g, hh] = H;
    for (let i = 0; i < 64; i++) {
      if (i < 16) W[i] = words[j + i] | 0;
      else {
        const s0 = r(W[i - 15], 7) ^ r(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = r(W[i - 2], 17) ^ r(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      const t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H = [(H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0, (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + hh) | 0];
  }
  return H.map((x) => ("00000000" + (x >>> 0).toString(16)).slice(-8)).join("");
}

export function pinSet(cfg) {
  return !!(cfg && typeof cfg.hash === "string" && cfg.hash.length === 64);
}

export function pinMatches(cfg, pin) {
  return pinSet(cfg) && sha256(String(cfg.salt || "") + ":" + pin) === cfg.hash;
}

let fails = 0;
let lockedUntil = 0;

/**
 * Ask for the setup password over the whole screen. `parent` is the panel's
 * root element; onOk() runs when the right password is entered.
 */
export function askPin(parent, cfg, onOk) {
  const old = parent.querySelector(".pinpad");
  if (old) old.parentNode.removeChild(old);
  let pin = "";
  let idle = null;
  const dots = h("div.pp-dots");
  const msg = h("div.pp-msg", null, "Enter the setup password");
  const box = h("div.pinpad");
  const close = () => {
    clearTimeout(idle);
    if (box.parentNode) box.parentNode.removeChild(box);
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(close, 30000); // walked away: back to the dashboard
  };
  const paint = () => {
    dots.innerHTML = "";
    for (let i = 0; i < Math.max(4, pin.length); i++) dots.appendChild(h("i" + (i < pin.length ? ".on" : "")));
  };
  const check = () => {
    if (Date.now() < lockedUntil) return;
    if (pinMatches(cfg, pin)) {
      fails = 0;
      close();
      onOk();
      return;
    }
    fails++;
    pin = "";
    paint();
    box.classList.remove("shake");
    void box.offsetWidth;
    box.classList.add("shake");
    if (fails >= 5) {
      lockedUntil = Date.now() + 30000;
      fails = 0;
      msg.textContent = "Too many tries. Wait 30 seconds.";
      msg.className = "pp-msg bad";
      setTimeout(() => {
        msg.textContent = "Enter the setup password";
        msg.className = "pp-msg";
      }, 30000);
    } else {
      msg.textContent = "Wrong password";
      msg.className = "pp-msg bad";
    }
  };
  const key = (label, fn, cls) => {
    const b = h("button.pp-key" + (cls ? "." + cls : ""), null, label);
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      touch();
      fn();
    });
    return b;
  };
  const digit = (d) => () => {
    if (Date.now() < lockedUntil || pin.length >= 8) return;
    pin += d;
    if (msg.className.indexOf("bad") >= 0 && Date.now() >= lockedUntil) {
      msg.textContent = "Enter the setup password";
      msg.className = "pp-msg";
    }
    paint();
  };
  const pad = h("div.pp-pad");
  ["1", "2", "3", "4", "5", "6", "7", "8", "9"].forEach((d) => pad.appendChild(key(d, digit(d))));
  pad.appendChild(
    key(
      "⌫",
      () => {
        pin = pin.slice(0, -1);
        paint();
      },
      "fn",
    ),
  );
  pad.appendChild(key("0", digit("0")));
  pad.appendChild(key("OK", () => pin && check(), "ok"));
  const cancel = key("Cancel", close, "cancel");
  box.appendChild(h("div.pp-side", null, h("div.pp-title", null, "Panel setup"), msg, dots, cancel));
  box.appendChild(pad);
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
  paint();
  touch();
  parent.appendChild(box);
}
