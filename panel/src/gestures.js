// Touch handling for tiles: tap / double / long / release / hold-repeat, with
// swipe cancellation so a page swipe that starts on a tile never fires it.

const MOVE_CANCEL = 14; // px (in 480-space) before a press becomes a swipe
const LONG_MS = 550;
const DOUBLE_MS = 260;

let activePointer = null;

/**
 * @param {HTMLElement} el
 * @param {object} o {onTap, onDouble, onLong, onRelease, onHold (repeat), holdMs,
 *   onDown, onUp, wantDouble:()=>bool, wantLong:()=>bool}
 */
export function press(el, o) {
  let down = null;
  let longTimer = null;
  let repeatTimer = null;
  let longFired = false;
  let lastTap = 0;
  let tapTimer = null;

  function clearTimers() {
    clearTimeout(longTimer);
    clearInterval(repeatTimer);
    clearTimeout(repeatTimer);
    longTimer = repeatTimer = null;
  }

  function cancel() {
    if (!down) return;
    clearTimers();
    el.classList.remove("pressing");
    down = null;
  }

  el.addEventListener("pointerdown", (ev) => {
    if (ev.button > 0) return;
    if (window.__arWakeSwallow && window.__arWakeSwallow()) return; // first touch only wakes
    activePointer = ev.pointerId;
    try {
      el.setPointerCapture(ev.pointerId);
    } catch (e) {
      /* ignore */
    }
    down = { x: ev.clientX, y: ev.clientY, t: Date.now(), scale: window.__arScale || 1 };
    longFired = false;
    el.classList.add("pressing");
    if (o.onDown) o.onDown(ev);
    const wantLong = o.wantLong ? o.wantLong() : false;
    if (o.onHold) {
      // hold-repeat (dimmer caps, PTZ arrows): fire now, then repeat
      o.onHold();
      const ms = o.holdMs == null ? 400 : o.holdMs;
      if (ms > 0) {
        repeatTimer = setTimeout(function rep() {
          if (!down) return;
          o.onHold();
          repeatTimer = setTimeout(rep, ms);
        }, Math.max(ms, 350));
      }
    } else if (wantLong) {
      longTimer = setTimeout(() => {
        if (!down) return;
        longFired = true;
        if (o.onLong) o.onLong();
      }, LONG_MS);
    }
  });

  el.addEventListener("pointermove", (ev) => {
    if (!down) return;
    const s = down.scale;
    const dx = (ev.clientX - down.x) / s;
    const dy = (ev.clientY - down.y) / s;
    if (Math.abs(dx) > MOVE_CANCEL || Math.abs(dy) > MOVE_CANCEL) {
      if (longFired && o.onRelease) o.onRelease();
      cancel();
    }
  });

  function up() {
    if (!down) return;
    const wasHold = !!o.onHold;
    clearTimers();
    el.classList.remove("pressing");
    down = null;
    if (o.onUp) o.onUp();
    if (wasHold) return;
    if (longFired) {
      if (o.onRelease) o.onRelease();
      return;
    }
    const wantDouble = o.wantDouble ? o.wantDouble() : false;
    if (!wantDouble) {
      if (o.onTap) o.onTap();
      return;
    }
    const now = Date.now();
    if (tapTimer && now - lastTap < DOUBLE_MS) {
      clearTimeout(tapTimer);
      tapTimer = null;
      if (o.onDouble) o.onDouble();
      return;
    }
    lastTap = now;
    tapTimer = setTimeout(() => {
      tapTimer = null;
      if (o.onTap) o.onTap();
    }, DOUBLE_MS);
  }

  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("pointerleave", (ev) => {
    if (ev.pointerType === "mouse") cancel();
  });
}

/**
 * Drag handler (dimmer track). Calls onDrag(fraction 0..1) while the finger
 * moves along the axis, and claims the gesture so the page does not swipe.
 */
export function drag(el, axis, onDrag, onEnd) {
  let active = false;
  function frac(ev) {
    const r = el.getBoundingClientRect();
    if (axis === "v") return 1 - (ev.clientY - r.top) / r.height;
    return (ev.clientX - r.left) / r.width;
  }
  el.addEventListener("pointerdown", (ev) => {
    if (window.__arWakeSwallow && window.__arWakeSwallow()) return;
    active = true;
    window.__arClaimGesture = true;
    try {
      el.setPointerCapture(ev.pointerId);
    } catch (e) {
      /* ignore */
    }
    onDrag(Math.max(0, Math.min(1, frac(ev))), false);
    ev.stopPropagation();
  });
  el.addEventListener("pointermove", (ev) => {
    if (!active) return;
    onDrag(Math.max(0, Math.min(1, frac(ev))), false);
    ev.stopPropagation();
  });
  function end(ev) {
    if (!active) return;
    active = false;
    window.__arClaimGesture = false;
    if (onEnd) onEnd(Math.max(0, Math.min(1, frac(ev))));
  }
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

/** Page-level horizontal swipe detection. */
export function swipe(el, onSwipe) {
  let start = null;
  el.addEventListener(
    "pointerdown",
    (ev) => {
      start = { x: ev.clientX, y: ev.clientY, t: Date.now(), scale: window.__arScale || 1 };
    },
    true,
  );
  el.addEventListener(
    "pointerup",
    (ev) => {
      if (!start) return;
      const s = start.scale;
      const dx = (ev.clientX - start.x) / s;
      const dy = (ev.clientY - start.y) / s;
      const dt = Date.now() - start.t;
      start = null;
      if (window.__arClaimGesture) return;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4 && dt < 900) {
        onSwipe(dx < 0 ? 1 : -1);
      }
    },
    true,
  );
  el.addEventListener("pointercancel", () => (start = null), true);
}
