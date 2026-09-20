// Synthesised sounds (siren tones, notification chimes, alarm clock). No audio
// files are shipped: every bundled sound name the integration uses
// (siren, alarmo, alarm_beep, alarm) is generated with WebAudio.

let ctx = null;
function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === "suspended" && ctx.resume) ctx.resume();
  return ctx;
}

function tone(c, dest, freq, start, dur, type, gain) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type || "sine";
  o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain || 0.4, start + 0.015);
  g.gain.setValueAtTime(gain || 0.4, start + Math.max(0.02, dur - 0.04));
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g);
  g.connect(dest);
  o.start(start);
  o.stop(start + dur + 0.02);
  return o;
}

/** One cycle of a pattern, scheduled at t. Returns its length in seconds. */
const PATTERNS = {
  siren(c, t, d) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(620, t);
    o.frequency.linearRampToValueAtTime(1350, t + 0.9);
    o.frequency.linearRampToValueAtTime(620, t + 1.8);
    g.gain.setValueAtTime(0.28, t);
    o.connect(g);
    g.connect(d);
    o.start(t);
    o.stop(t + 1.8);
    return 1.8;
  },
  alarmo(c, t, d) {
    tone(c, d, 960, t, 0.42, "square", 0.22);
    tone(c, d, 720, t + 0.45, 0.42, "square", 0.22);
    return 0.9;
  },
  alarm_beep(c, t, d) {
    tone(c, d, 2000, t, 0.12, "square", 0.2);
    tone(c, d, 2000, t + 0.22, 0.12, "square", 0.2);
    return 1.0;
  },
  alarm(c, t, d) {
    for (let i = 0; i < 4; i++) tone(c, d, 1400, t + i * 0.16, 0.09, "square", 0.22);
    return 1.2;
  },
  chime(c, t, d) {
    tone(c, d, 880, t, 0.5, "sine", 0.35);
    tone(c, d, 1318.5, t + 0.16, 0.8, "sine", 0.3);
    return 1.2;
  },
  ding(c, t, d) {
    tone(c, d, 1046.5, t, 0.7, "triangle", 0.35);
    return 0.8;
  },
};

export function knownSound(name) {
  return !!PATTERNS[name];
}

/** Play a named sound once. */
export function playOnce(name) {
  const c = ac();
  const p = PATTERNS[name] || PATTERNS.chime;
  if (!c) return;
  p(c, c.currentTime + 0.02, c.destination);
}

/** Loop a named sound until the returned stop() is called. */
export function loop(name) {
  const c = ac();
  const p = PATTERNS[name] || PATTERNS.siren;
  if (!c) return { stop() {} };
  let stopped = false;
  let next = c.currentTime + 0.02;
  // everything goes through one gain node, so stop() silences scheduled notes too
  const bus = c.createGain();
  bus.gain.value = 1;
  bus.connect(c.destination);
  let timer = null;
  function schedule() {
    if (stopped) return;
    while (next < c.currentTime + 1.5) next += p(c, next, bus) + 0.05;
    timer = setTimeout(schedule, 400);
  }
  schedule();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      try {
        bus.gain.setValueAtTime(0, c.currentTime);
        bus.disconnect();
      } catch (e) {
        /* ignore */
      }
    },
  };
}
