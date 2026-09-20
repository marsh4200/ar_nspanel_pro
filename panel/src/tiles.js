// Grid tiles. The DOM mirrors the config panel's WYSIWYG preview exactly
// (.tile > .surf.raised|inset > .pv-center > .pv-glyph + .pv-lbl, same class
// names), so the extracted theme kit paints them the same way on the glass as
// in the editor. The integration owns behaviour: every tile only PUBLISHES an
// event; bindings run in Home Assistant.

import { h, glyph, setLit, slugify, compare } from "./util.js";
import { press, drag } from "./gestures.js";

function content(icon, label, lit, above) {
  const g = glyph(icon, lit ? "lit" : "");
  const l = label ? h("div.pv-lbl" + (lit ? ".lit" : ""), null, label) : null;
  const el = h("div.pv-center", null, above ? l : null, g, above ? null : l);
  return {
    el,
    set(lit2) {
      setLit(g, lit2);
      setLit(l, lit2);
    },
  };
}

function isOn(m) {
  return !!(m && m.on === true);
}

function dotColor(dot) {
  return (dot && typeof dot === "object" && dot.color) || "#3fb950";
}

/** Build one tile. Returns {el, keys:string[], update()} */
export function buildTile(tile, ctx) {
  const cs = tile.colSpan || 1;
  const rs = tile.rowSpan || 1;
  const cls =
    "tile.tile-" +
    (tile.type || "button") +
    (tile.shape === "circle" ? ".circle" : "") +
    (tile.labelPosition === "above" ? ".labove" : "");
  const el = h("div." + cls, {
    "data-id": tile.id,
    style: {
      gridColumn: tile.col + " / " + (tile.col + cs),
      gridRow: tile.row + " / " + (tile.row + rs),
      msGridColumn: tile.col,
    },
  });

  let built;
  switch (tile.type) {
    case "dimmer":
      built = dimmer(tile, ctx, el);
      break;
    case "switcher":
      built = switcher(tile, ctx, el);
      break;
    case "split":
      built = split(tile, ctx, el);
      break;
    case "rocker":
      built = rocker(tile, ctx, el);
      break;
    default:
      built = button(tile, ctx, el);
  }

  // status dot (static or entity-bound)
  const dot = tile.statusDot;
  let dotEl = null;
  let dotKey = null;
  if (dot === true || (dot && typeof dot === "object")) {
    dotEl = h("span.sdot", { style: { background: dotColor(dot) } });
    el.appendChild(dotEl);
    if (typeof dot === "object" && dot.entity) dotKey = slugify(dot.entity);
  }
  const keys = built.keys.slice();
  if (dotKey) keys.push(dotKey);

  function update() {
    built.update();
    if (dotEl && dotKey) {
      const m = ctx.get(dotKey);
      const show = compare(m ? m.value : undefined, dot.operator, dot.compareTo);
      dotEl.style.display = show ? "" : "none";
    }
  }
  update();
  return { el, keys, update };
}

// --- button ------------------------------------------------------------------

function button(tile, ctx, el) {
  const key = tile.stateKey || (tile.entity ? slugify(tile.entity) : null);
  const behavior = tile.behavior || "toggle";
  const events = Array.isArray(tile.events) ? tile.events : [];
  const states = Array.isArray(tile.states) ? tile.states : [];
  const optimistic = tile.optimistic !== false;
  const inset = tile.activeMode === "inset";

  const surf = h("div.surf.raised" + (tile.shape === "circle" ? ".s-circle" : ""));
  el.appendChild(surf);
  let c = null;
  let cur = null; // current state option (state behaviour)

  function currentOption() {
    if (behavior !== "state" || !states.length) return null;
    const m = key ? ctx.get(key) : null;
    const v = m ? m.value : undefined;
    for (const s of states) if (s.value === v) return s;
    return states[0];
  }

  function render() {
    cur = currentOption();
    const icon = (cur && cur.icon) || tile.icon;
    const label = (cur && cur.label) || tile.label;
    const sig = icon + "|" + label + "|" + (tile.labelPosition === "above");
    if (!c || c.sig !== sig) {
      while (surf.firstChild) surf.removeChild(surf.firstChild);
      c = content(icon, label, false, tile.labelPosition === "above");
      c.sig = sig;
      surf.appendChild(c.el);
    }
  }

  function update() {
    render();
    const m = key ? ctx.get(key) : null;
    // A state button is "on" while the current option is flagged `active`
    // (e.g. the "Away" option of an input_select); anything else follows `on`.
    const on = behavior === "state" && cur ? cur.active === true : isOn(m);
    const useInset = inset && on;
    surf.classList.toggle("inset", useInset);
    surf.classList.toggle("raised", !useInset);
    surf.classList.toggle("on", on && !useInset);
    el.classList.toggle("lit", !inset && on);
    c.set(on);
  }

  const has = (e) => events.indexOf(e) >= 0;
  press(el, {
    wantDouble: () => has("double"),
    wantLong: () => has("long") || has("release"),
    onTap() {
      if (behavior === "state" && states.length) {
        const idx = Math.max(0, states.indexOf(cur || states[0]));
        const next = states[(idx + 1) % states.length];
        if (optimistic && key) ctx.optimistic(key, { value: next.value });
        ctx.event(tile.id, "state", { value: next.value });
      } else if (behavior === "push") {
        ctx.event(tile.id, "press");
      } else {
        if (optimistic && key) {
          const m = ctx.get(key);
          ctx.optimistic(key, { on: !isOn(m) });
        }
        ctx.event(tile.id, "toggle");
      }
      update();
    },
    onDouble() {
      ctx.event(tile.id, "double");
    },
    onLong() {
      if (has("long")) ctx.event(tile.id, "long");
    },
    onRelease() {
      if (has("release")) ctx.event(tile.id, "release");
    },
  });

  return { keys: key ? [key] : [], update };
}

// --- dimmer ------------------------------------------------------------------

function dimmer(tile, ctx, el) {
  const key = tile.stateKey || (tile.entity ? slugify(tile.entity) : null);
  const n = Math.max(1, Math.min(12, tile.segments || 7));
  const vertical = (tile.orientation || "vertical") === "vertical";
  const raised = tile.dimmerSurface === "raised";
  const step = Math.max(1, tile.step || 1);
  const hiIcon = tile.icon || (vertical ? "brightness" : "plus");
  const loIcon = tile.iconLow || (vertical ? "night" : "minus");

  const surf = h(
    "div.surf." + (raised ? "raised" : "inset") + "." + (vertical ? "dim-v" : "dim-h") + (tile.shape === "circle" ? ".s-circle" : ""),
  );
  const capA = h("div.pv-cap", null, glyph(vertical ? hiIcon : loIcon));
  const capB = h("div.pv-cap", null, glyph(vertical ? loIcon : hiIcon));
  const cells = h("div.pv-cells." + (vertical ? "pv-cells-v" : "pv-cells-h"));
  const cellEls = [];
  for (let i = 0; i < n; i++) {
    const c = h("div.pv-cell.off");
    cellEls.push(c);
    cells.appendChild(c);
  }
  surf.appendChild(capA);
  surf.appendChild(cells);
  surf.appendChild(capB);
  el.appendChild(surf);

  let dragLevel = null;

  function level() {
    if (dragLevel != null) return dragLevel;
    const m = key ? ctx.get(key) : null;
    if (!isOn(m)) return 0;
    if (typeof m.brightness === "number") return Math.max(1, Math.round(m.brightness * n));
    return n;
  }

  function update() {
    const lv = level();
    for (let i = 0; i < n; i++) {
      const on = i < lv;
      cellEls[i].className = "pv-cell " + (on ? "on" : "off");
    }
  }

  function send(lv) {
    const v = Math.round((lv / n) * 1000) / 1000;
    if (key && tile.optimistic !== false) ctx.optimistic(key, { on: lv > 0, brightness: v });
    ctx.event(tile.id, "dim", { value: v });
    update();
  }

  const up = vertical ? capA : capB;
  const down = vertical ? capB : capA;
  press(up, { holdMs: tile.holdRepeatMs == null ? 400 : tile.holdRepeatMs, onHold: () => send(Math.min(n, level() + step)) });
  press(down, { holdMs: tile.holdRepeatMs == null ? 400 : tile.holdRepeatMs, onHold: () => send(Math.max(0, level() - step)) });
  drag(
    cells,
    vertical ? "v" : "h",
    (f) => {
      dragLevel = Math.max(0, Math.min(n, Math.ceil(f * n - 0.15)));
      update();
    },
    () => {
      const lv = dragLevel;
      dragLevel = null;
      if (lv != null) send(lv);
    },
  );

  return { keys: key ? [key] : [], update };
}

// --- switcher ----------------------------------------------------------------

function switcher(tile, ctx, el) {
  const key = tile.stateKey || (tile.entity ? slugify(tile.entity) : null);
  const items = Array.isArray(tile.items) ? tile.items : [];
  const surf = h("div.surf.raised.pv-split.pv-sw" + (tile.shape === "circle" ? ".s-circle" : ""));
  const segs = items.map((it) => {
    const c = content(it.icon, it.label, false, tile.labelPosition === "above");
    const seg = h("div.pv-seg", null, c.el);
    press(seg, {
      onTap() {
        if (key && tile.optimistic !== false) ctx.optimistic(key, { value: it.value });
        ctx.event(tile.id, "state", { value: it.value });
        update();
      },
    });
    surf.appendChild(seg);
    return { seg, c, it };
  });
  el.appendChild(surf);

  function update() {
    const m = key ? ctx.get(key) : null;
    const v = m ? m.value : undefined;
    for (const s of segs) {
      const on = v != null && s.it.value === v;
      s.seg.classList.toggle("on", on);
      s.c.set(on);
    }
  }
  return { keys: key ? [key] : [], update };
}

// --- split -------------------------------------------------------------------

function split(tile, ctx, el) {
  const cs = tile.colSpan || 1;
  const rs = tile.rowSpan || 1;
  const vertical = tile.orientation === "vertical" || (tile.orientation == null && rs >= cs);
  const surf = h("div.surf.raised.pv-split" + (vertical ? ".v" : ""));
  const keys = [];
  const segs = [];
  (tile.buttons || []).forEach((seg, i) => {
    if (i > 0) surf.appendChild(h("span.pv-div"));
    const c = content(seg.icon, seg.label, false, seg.labelPosition === "above");
    const segEl = h("div.pv-seg", null, c.el);
    surf.appendChild(segEl);
    const st = seg.state || {};
    [st.entity, st.on && st.on.entity, st.inset && st.inset.entity].forEach((e) => {
      if (e) keys.push(slugify(e));
    });
    const s = { seg, segEl, c, override: null, overrideUntil: 0 };
    segs.push(s);
    press(segEl, {
      onTap() {
        const state = visual(s);
        ctx.event(tile.id + "." + seg.id, "press", { state });
        if (tile.optimistic !== false) {
          s.override = state === "off" ? "on" : "off";
          s.overrideUntil = Date.now() + 4000;
          setTimeout(update, 4050);
        }
        update();
      },
    });
  });
  el.appendChild(surf);

  function rule(st, r) {
    const ent = r.entity || st.entity;
    if (!ent) return false;
    const m = ctx.get(slugify(ent));
    return compare(m ? m.value : undefined, r.operator, r.compareTo);
  }

  function computed(seg) {
    const st = seg.state || {};
    if (st.inset && rule(st, st.inset)) return "inset";
    const onRule = st.on || (st.entity ? {} : null);
    if (onRule && rule(st, onRule)) return "on";
    return "off";
  }

  function visual(s) {
    if (s.override && Date.now() < s.overrideUntil) return s.override;
    s.override = null;
    return computed(s.seg);
  }

  let last = {};
  function update() {
    for (const s of segs) {
      const real = computed(s.seg);
      // a real mirror change ends the optimistic guess
      if (s.override && last[s.seg.id] !== undefined && last[s.seg.id] !== real) s.override = null;
      last[s.seg.id] = real;
      const v = visual(s);
      s.segEl.classList.toggle("on", v !== "off");
      s.segEl.classList.toggle("seg-inset", v === "inset");
      s.c.set(v === "on");
    }
  }
  return { keys, update };
}

// --- rocker ------------------------------------------------------------------

function rocker(tile, ctx, el) {
  let list = Array.isArray(tile.rockers) && tile.rockers.length ? tile.rockers : null;
  if (!list) list = [{ entity: tile.entity || "", icon: tile.icon, label: tile.label }];
  list = list.slice(0, 2);
  const stack = h("div.pv-rkstack");
  const rows = list.map((rk, i) => {
    const key = rk.entity ? slugify(rk.entity) : null;
    const g = glyph(rk.icon);
    const lbl = rk.label ? h("span.pv-rk-lbl", null, rk.label) : null;
    const body = h(
      "div.surf.raised.pv-rocker",
      null,
      h("span.pv-rk-seam"),
      h("span.pv-rk-recess"),
      h("span.pv-rk-led"),
      h("div.pv-rk-content", null, g, lbl),
    );
    stack.appendChild(body);
    press(body, {
      onTap() {
        if (key && tile.optimistic !== false) ctx.optimistic(key, { on: !isOn(ctx.get(key)) });
        ctx.event(tile.id + "." + i, "toggle");
        update();
      },
    });
    return { key, body, g, lbl };
  });
  el.appendChild(stack);

  function update() {
    for (const r of rows) {
      const on = r.key ? isOn(ctx.get(r.key)) : false;
      r.body.classList.toggle("on", on);
      setLit(r.g, on);
      setLit(r.lbl, on);
    }
  }
  return { keys: rows.map((r) => r.key).filter(Boolean), update };
}
