import KIT_ICONS from "./generated/icons.json";

// A few UI glyphs the tile set does not carry (transport, chevrons). Same
// 24x24 stroke style as the kit icons.
const EXTRA = {
  "chevron-up": ["M6 15l6-6 6 6"],
  "chevron-down": ["M6 9l6 6 6-6"],
  "chevron-left": ["M15 6l-6 6 6 6"],
  "chevron-right": ["M9 6l6 6-6 6"],
  play: ["M8 5.5v13l10.5-6.5z"],
  pause: ["M8 5.5v13M16 5.5v13"],
  "skip-next": ["M6 6l8.5 6L6 18zM18 6v12"],
  "skip-previous": ["M18 6l-8.5 6L18 18zM6 6v12"],
  "volume-low": ["M4 10h3.5L12 6v12l-4.5-4H4zM15.5 10a3 3 0 0 1 0 4"],
  "volume-high": ["M4 10h3.5L12 6v12l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"],
  close: ["M6 6l12 12M18 6L6 18"],
};
const ICONS = Object.assign({}, EXTRA, KIT_ICONS);

const SVG_NS = "http://www.w3.org/2000/svg";

/** Tiny hyperscript: h("div.a.b", {attrs}, children...) */
export function h(tag, attrs, ...children) {
  const parts = tag.split(".");
  const el = document.createElement(parts[0] || "div");
  if (parts.length > 1) el.className = parts.slice(1).join(" ");
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "style" && typeof v === "object") {
        for (const s in v) {
          if (s.indexOf("--") === 0) el.style.setProperty(s, v[s]);
          else el.style[s] = v[s];
        }
      } else if (k === "class") {
        el.className = (el.className ? el.className + " " : "") + v;
      } else if (k.indexOf("on") === 0 && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === "text") {
        el.textContent = v;
      } else if (k === "html") {
        el.innerHTML = v;
      } else {
        el.setAttribute(k, v === true ? "" : v);
      }
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (typeof c === "string" || typeof c === "number") el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c);
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// --- icons -------------------------------------------------------------------

/** Build the shared <svg><symbol id="i-name"> sprite once. */
export function iconSprite() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  const defs = document.createElementNS(SVG_NS, "defs");
  for (const name in ICONS) {
    const sym = document.createElementNS(SVG_NS, "symbol");
    sym.setAttribute("id", "i-" + name);
    sym.setAttribute("viewBox", "0 0 24 24");
    for (const e of ICONS[name]) {
      let el;
      if (typeof e === "string") {
        el = document.createElementNS(SVG_NS, "path");
        el.setAttribute("d", e);
      } else {
        el = document.createElementNS(SVG_NS, "circle");
        el.setAttribute("cx", e[0]);
        el.setAttribute("cy", e[1]);
        el.setAttribute("r", e[2]);
      }
      sym.appendChild(el);
    }
    defs.appendChild(sym);
  }
  svg.appendChild(defs);
  return svg;
}

export function hasIcon(name) {
  return !!(name && ICONS[name]);
}

/** <svg class="pv-glyph"><use href="#i-name"></svg> — same markup as the editor. */
export function glyph(name, cls) {
  if (!name) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "pv-glyph" + (cls ? " " + cls : ""));
  svg.setAttribute("viewBox", "0 0 24 24");
  const use = document.createElementNS(SVG_NS, "use");
  const ref = "#i-" + (ICONS[name] ? name : "button-round");
  use.setAttribute("href", ref);
  use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", ref);
  svg.appendChild(use);
  return svg;
}

export function setLit(el, lit) {
  if (!el) return;
  if (el.classList) el.classList.toggle("lit", !!lit);
  else {
    // SVG in very old WebViews: className is an SVGAnimatedString
    const c = (el.getAttribute("class") || "").replace(/\s*\blit\b/g, "");
    el.setAttribute("class", lit ? c + " lit" : c);
  }
}

/** entity id -> default state key (mirror of const.slugify_entity_id). */
export function slugify(entityId) {
  let out = "";
  let prevUs = false;
  const s = String(entityId || "").toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/[a-z0-9]/.test(ch)) {
      out += ch;
      prevUs = false;
    } else if (!prevUs) {
      out += "_";
      prevUs = true;
    }
  }
  return out.replace(/^_+|_+$/g, "");
}

export function parseJson(s) {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch (e) {
    return {};
  }
}

/** Operator comparison shared by status dots and split-segment rules. */
export function compare(value, operator, compareTo) {
  const op = operator || "equals";
  const target = compareTo === undefined ? "on" : compareTo;
  if (value === null || value === undefined) return false; // fail safe: off
  if (op === "equals" || op === "notEqual") {
    const eq = String(value) === String(target);
    return op === "equals" ? eq : !eq;
  }
  const a = parseFloat(value);
  const b = parseFloat(target);
  if (isNaN(a) || isNaN(b)) return false;
  if (op === "less") return a < b;
  if (op === "more") return a > b;
  if (op === "notLess") return a >= b;
  if (op === "notMore") return a <= b;
  return false;
}

export function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

export function uid() {
  return Math.random().toString(16).slice(2, 10);
}
