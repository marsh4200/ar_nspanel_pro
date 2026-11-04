// Residence Lights: each lamp drawn the way it really lights a room. The fixture
// hangs at the top (downlight, pendant, Edison bulb or cove LEDs, the Elegant
// drawings made bigger) and its light pours down onto a pool on the floor. The
// beam, the pool, the glow and the colour all follow the dimmer: warm amber when
// low, warm white near 100 % (like a dim-to-warm lamp). Only Residence uses this.
let uid = 0; // every scene has its own gradient ids
const r1 = (n) => Math.round(n * 10) / 10;
// one part whose opacity follows the level: lo at 1%, hi at 100%, off when switched off
const O = (lo, hi, off) => ' class="ls-o" data-o="' + lo + "," + hi + "," + (off || 0) + '"';
export function scene(k, W, H, flat) {
  const id = "ls" + (++uid), s = Math.max(0.32, Math.min(1.1, W / 170)), cx = W / 2, fy = H - 12 * s;
  const C = (o, off) => '<stop class="ls-c" offset="' + off + '" stop-opacity="' + o + '"/>';
  let d = '<defs>' +
    '<linearGradient id="' + id + 'b" x1="0" y1="0" x2="0" y2="1">' + C(0.95, 0) + C(0.42, 0.5) + C(0.05, 1) + "</linearGradient>" +
    '<linearGradient id="' + id + 'k" x1="0" y1="0" x2="0" y2="1">' + C(1, 0) + C(0.25, 0.7) + C(0, 1) + "</linearGradient>" +
    '<radialGradient id="' + id + 'p">' + C(0.9, 0) + C(0.32, 0.45) + C(0, 1) + "</radialGradient>" +
    '<radialGradient id="' + id + 'h">' + C(1, 0) + C(0.38, 0.4) + C(0, 1) + "</radialGradient>" +
    '<filter id="' + id + 'f" x="-40%" y="-20%" width="180%" height="140%"><feGaussianBlur stdDeviation="' + r1(7 * s) + '"/></filter>' +
    '<filter id="' + id + 'q" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="' + r1(2.5 * s) + '"/></filter>' +
    '<linearGradient id="' + id + 'm" x1="0" x2="1"><stop offset="0" stop-color="#8f9399"/><stop offset=".4" stop-color="#f3f3f0"/><stop offset="1" stop-color="#9da1a6"/></linearGradient>' +
    '<linearGradient id="' + id + 'br" x1="0" x2="1"><stop offset="0" stop-color="#b8892e"/><stop offset=".45" stop-color="#f4d27c"/><stop offset="1" stop-color="#a87a24"/></linearGradient>' +
    '<linearGradient id="' + id + 'sh" x1="0" x2="1"><stop offset="0" stop-color="#9da1a6"/><stop offset=".35" stop-color="#f6f6f3"/><stop offset=".6" stop-color="#dfe1e3"/><stop offset="1" stop-color="#8f9399"/></linearGradient>' +
    '<linearGradient id="' + id + 'cp" x1="0" x2="1"><stop offset="0" stop-color="#8a6a2a"/><stop offset=".45" stop-color="#e9c977"/><stop offset="1" stop-color="#7d5f22"/></linearGradient>' +
    "</defs>";
  const u = (x) => "url(#" + id + x + ")";
  const beam = (y0, w0, w1, wc) =>
    '<path' + O(0.1, 1) + ' d="M' + r1(cx - w0) + " " + r1(y0) + "H" + r1(cx + w0) + "L" + r1(cx + w1) + " " + r1(fy) + "H" + r1(cx - w1) + 'Z" fill="' + u("b") + '" filter="' + u("f") + '"/>' +
    '<path' + O(0.05, 0.8) + ' d="M' + r1(cx - w0 * 0.45) + " " + r1(y0) + "H" + r1(cx + w0 * 0.45) + "L" + r1(cx + wc) + " " + r1(fy) + "H" + r1(cx - wc) + 'Z" fill="' + u("k") + '" filter="' + u("f") + '"/>';
  const pool = (rx) =>
    '<ellipse' + O(0.1, 1) + ' cx="' + cx + '" cy="' + r1(fy) + '" rx="' + r1(rx) + '" ry="' + r1(16 * s) + '" fill="' + u("p") + '"/>' +
    '<ellipse' + O(0.05, 0.9) + ' cx="' + cx + '" cy="' + r1(fy) + '" rx="' + r1(rx * 0.42) + '" ry="' + r1(6 * s) + '" fill="' + u("p") + '"/>';
  const spread = (y0, k) => Math.min(W * 0.5, (fy - y0) * k);
  let g = "";
  k = k === "lamp" ? "pendant" : k === "edison" ? "floor_lamp" : k === "bulb" ? "cove" : k;
  if (k === "downlight") {
    const y0 = 8 * s, w1 = spread(y0, 0.34);
    g = beam(y0 + 4 * s, 16 * s, w1, w1 * 0.4) + pool(w1 * 1.12) +
      '<ellipse' + O(0.25, 1) + ' cx="' + cx + '" cy="' + r1(y0 + 6 * s) + '" rx="' + r1(44 * s) + '" ry="' + r1(16 * s) + '" fill="' + u("h") + '" filter="' + u("q") + '"/>' +
      '<ellipse cx="' + cx + '" cy="' + r1(y0) + '" rx="' + r1(34 * s) + '" ry="' + r1(9 * s) + '" fill="' + u("m") + '"/>' +
      '<ellipse cx="' + cx + '" cy="' + r1(y0 + 1 * s) + '" rx="' + r1(24 * s) + '" ry="' + r1(6 * s) + '" fill="#2f3237"/>' +
      '<ellipse' + O(0.55, 1, 0.15) + ' cx="' + cx + '" cy="' + r1(y0 + 2 * s) + '" rx="' + r1(17 * s) + '" ry="' + r1(4.5 * s) + '" fill="#fff8e6"/>';
  } else if (k === "pendant") {
    const z = 1.7 * s, rim = 49 * z, w1 = spread(rim, 0.44);
    g = beam(rim, 14 * z, w1, w1 * 0.42) + pool(w1 * 1.08) +
      '<ellipse' + O(0.2, 1) + ' cx="' + cx + '" cy="' + r1(rim) + '" rx="' + r1(26 * z) + '" ry="' + r1(9 * z) + '" fill="' + u("h") + '" filter="' + u("q") + '"/>' +
      '<g transform="translate(' + r1(cx - 23 * z) + ' 0) scale(' + r1(z * 100) / 100 + ')">' +
      '<line x1="23" y1="0" x2="23" y2="21" stroke="#e7e4dd" stroke-width="1.4"/><path d="M19 20h8l2 10H17z" fill="' + u("br") + '"/><rect x="19.5" y="30" width="7" height="3" rx="1" fill="#d6d8db"/>' +
      '<path d="M10 45c0-7 5-12 13-12s13 5 13 12l2 4H8z" fill="' + u("sh") + '"/>' +
      '<ellipse' + O(0.45, 1, 0.25) + ' cx="23" cy="49" rx="15" ry="2.6" fill="#fff6dc"/></g>';
  } else if (k === "floor_lamp") {
    const z = 1.75 * s, by = 50 * z, w1 = spread(by, 0.5);
    g = '<circle' + O(0.25, 1) + ' cx="' + cx + '" cy="' + r1(by) + '" r="' + r1(Math.min(W * 0.7, 105 * s)) + '" fill="' + u("h") + '" filter="' + u("f") + '"/>' +
      '<path' + O(0.04, 0.45) + ' d="M' + r1(cx - 14 * z) + " " + r1(by) + "H" + r1(cx + 14 * z) + "L" + r1(cx + w1) + " " + r1(fy) + "H" + r1(cx - w1) + 'Z" fill="' + u("b") + '" filter="' + u("f") + '"/>' +
      pool(w1 * 1.15) +
      '<g transform="translate(' + r1(cx - 23 * z) + ' 0) scale(' + r1(z * 100) / 100 + ')">' +
      '<line x1="23" y1="0" x2="23" y2="15" stroke="#26231f" stroke-width="1.8"/><rect x="17" y="14" width="12" height="4" rx="1.2" fill="#2e2b27"/><path d="M18 18h10v9H18z" fill="' + u("cp") + '"/><path d="M18 20.5h10M18 23h10M18 25.5h10" stroke="#6b5220" stroke-width=".7"/>' +
      '<path class="ls-glass" d="M18.5 27C18.5 33 10 37.5 10 50c0 9.5 6 17 13 17s13-7.5 13-17c0-12.5-8.5-17-8.5-23z" fill="rgba(255,255,255,.07)" stroke="rgba(255,255,255,.38)" stroke-width=".8"/>' +
      '<path d="M21.5 28.5l-2.5 15M24.5 28.5l2.5 15" stroke="#9a948a" stroke-width=".6"/>' +
      '<path class="ls-fil" d="M19 44q1 9 2 0q1 9 2 0q1 9 2 0q1 9 2 0" fill="none" stroke="#5a4636" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path' + O(0.7, 1, 0) + ' d="M19 44q1 9 2 0q1 9 2 0q1 9 2 0q1 9 2 0" fill="none" stroke="#fff2cf" stroke-width="2.6" stroke-linecap="round" filter="url(#' + id + 'q)" opacity="0"/>' +
      '<path d="M14 45c0-5 2.5-9 5-11" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="1.2" stroke-linecap="round"/></g>';
  } else {  // cove LEDs: a lit slot washing the wall below
    const y0 = 22 * s;
    d = d.replace("</defs>", '<linearGradient id="' + id + 'x" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".16" stop-color="#fff"/><stop offset=".84" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
      '<mask id="' + id + 'w" maskUnits="userSpaceOnUse" x="0" y="0" width="' + W + '" height="' + H + '"><rect width="' + W + '" height="' + H + '" fill="' + u("x") + '"/></mask></defs>');
    g = '<g mask="' + u("w") + '">' +
      '<rect' + O(0.06, 0.55) + ' x="' + r1(-10 * s) + '" y="' + r1(y0) + '" width="' + r1(W + 20 * s) + '" height="' + r1(fy - y0) + '" fill="' + u("b") + '" filter="' + u("f") + '"/>' +
      '<rect' + O(0.1, 1) + ' x="' + r1(-W * 0.1) + '" y="' + r1(y0 - 8 * s) + '" width="' + r1(W * 1.2) + '" height="' + r1(24 * s) + '" fill="' + u("k") + '" filter="' + u("f") + '"/>' +
      '<rect x="0" y="' + r1(y0 - 12 * s) + '" width="' + W + '" height="' + r1(10 * s) + '" fill="#26282c"/>' +
      '<rect x="0" y="' + r1(y0 - 12 * s) + '" width="' + W + '" height="' + r1(1.5 * s) + '" fill="rgba(255,255,255,.25)"/>' +
      '<rect' + O(0.6, 1, 0.2) + ' x="' + r1(6 * s) + '" y="' + r1(y0 - 2 * s) + '" width="' + r1(W - 12 * s) + '" height="' + r1(3 * s) + '" rx="' + r1(1.5 * s) + '" fill="#fff4dc"/></g>' +
      pool(W * 0.5);
  }
  const out = '<svg class="lsc" data-ls width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" aria-hidden="true">' + d + g + "</svg>";
  // weak panels: no blur (the gradients alone still read as light)
  return flat ? out.replace(/ filter="url\(#[^)]*\)"/g, "") : out;
}
// light colour from the level: amber when dim, warm white when bright (dim to warm)
export function lightColour(f) {
  const A = [255, 160, 70], B = [255, 206, 140], Cc = [255, 245, 226];
  const m = (p, q, t) => p.map((v, i) => Math.round(v + (q[i] - v) * t));
  const c = f < 0.5 ? m(A, B, f / 0.5) : m(B, Cc, (f - 0.5) / 0.5);
  return "rgb(" + c.join(",") + ")";
}
export function paintScene(root, on, v) {
  const f = on ? Math.max(0.01, Math.min(1, v)) : 0;
  const col = lightColour(f);
  const each = (sel, fn) => Array.prototype.forEach.call(root.querySelectorAll(sel), fn);
  each(".ls-o", (e) => {
    const o = (e.getAttribute("data-o") || "0,1,0").split(",").map(Number);
    e.style.opacity = String(on ? o[0] + (o[1] - o[0]) * f : o[2]);
  });
  each("stop.ls-c", (e) => e.setAttribute("stop-color", col));
  each(".ls-fil", (e) => e.setAttribute("stroke", on ? lightColour(Math.min(1, f + 0.2)) : "#5a4636"));
  each(".ls-glass", (e) => e.setAttribute("fill", on ? "rgba(255,226,170," + (0.1 + 0.3 * f).toFixed(2) + ")" : "rgba(255,255,255,.07)"));
}
