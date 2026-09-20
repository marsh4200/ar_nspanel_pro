// Page builders. Each returns {el, keys, update, onShow, onHide, ...}.
import { h, glyph, slugify, pad2 } from "./util.js";
import { buildTile } from "./tiles.js";
import { press } from "./gestures.js";
import { clockView } from "./clock.js";

export function buildPage(page, ctx) {
  switch (page.type) {
    case "grid":
      return gridPage(page, ctx);
    case "clock":
      return clockPage(page, ctx);
    case "weather":
      return weatherPage(page, ctx);
    case "alarm":
      return alarmPage(page, ctx);
    case "camera":
      return cameraPage(page, ctx);
    case "music":
      return musicPage(page, ctx);
    default:
      return {
        el: h("div.page.page-empty", null, h("div.empty-msg", null, "Unknown page type: " + page.type)),
        keys: [],
        update() {},
      };
  }
}

// --- grid --------------------------------------------------------------------

function gridPage(page, ctx) {
  const g = page.grid || { columns: 4, rows: 4 };
  const board = h("div.board", {
    style: {
      gridTemplateColumns: "repeat(" + g.columns + ", 1fr)",
      gridTemplateRows: "repeat(" + g.rows + ", 1fr)",
    },
  });
  const tiles = [];
  const byKey = {};
  (page.tiles || []).forEach((t) => {
    let built;
    try {
      built = buildTile(t, ctx);
    } catch (e) {
      ctx.log("tile " + t.id + " failed: " + (e && e.message));
      return;
    }
    tiles.push(built);
    board.appendChild(built.el);
    built.keys.forEach((k) => (byKey[k] = (byKey[k] || []).concat([built])));
  });
  const el = h("div.page.page-grid", null, board);
  return {
    el,
    keys: Object.keys(byKey),
    update(key) {
      if (key && byKey[key]) byKey[key].forEach((t) => t.update());
      else if (!key) tiles.forEach((t) => t.update());
    },
  };
}

// --- clock -------------------------------------------------------------------

function clockPage(page, ctx) {
  const el = h("div.page.page-clock");
  let view = null;
  let timer = null;
  function render() {
    while (el.firstChild) el.removeChild(el.firstChild);
    view = clockView(ctx.device(), {
      themeKey: "clockPageTheme",
      panelTheme: ctx.theme(),
      alarm: ctx.alarmClock,
    });
    el.appendChild(view.el);
  }
  render();
  return {
    el,
    keys: [],
    update() {},
    rebuild: render,
    onShow() {
      clearInterval(timer);
      view.update();
      timer = setInterval(() => view.update(), 1000);
    },
    onHide() {
      clearInterval(timer);
    },
  };
}

// --- weather -----------------------------------------------------------------

const COND = {
  "clear-night": ["moon", "Clear"],
  cloudy: ["cloud", "Cloudy"],
  exceptional: ["shield-alert", "Exceptional"],
  fog: ["cloud", "Fog"],
  hail: ["snowflake-2", "Hail"],
  lightning: ["thunder", "Lightning"],
  "lightning-rainy": ["thunder", "Thunderstorms"],
  partlycloudy: ["weather", "Partly cloudy"],
  pouring: ["rain", "Pouring"],
  rainy: ["rain", "Rain"],
  snowy: ["snowflake-2", "Snow"],
  "snowy-rainy": ["snowflake-2", "Sleet"],
  sunny: ["sun", "Sunny"],
  windy: ["breeze", "Windy"],
  "windy-variant": ["breeze", "Windy"],
};

function condIcon(c) {
  const e = COND[c];
  const name = e ? e[0] : "cloud";
  return name;
}

function condLabel(c) {
  const e = COND[c];
  return e ? e[1] : c ? String(c).replace(/[-_]/g, " ") : "—";
}

function weatherPage(page, ctx) {
  const key = page.weather && page.weather.entity ? slugify(page.weather.entity) : "weather";
  const el = h("div.page.page-weather");
  function fmtT(v, unit) {
    if (typeof v !== "number") return "—";
    return Math.round(v) + "°";
  }
  function update() {
    while (el.firstChild) el.removeChild(el.firstChild);
    const w = ctx.get(key);
    if (!w || w.value == null) {
      el.appendChild(
        h(
          "div.ng-wrap",
          null,
          glyph("cloud", "wx-big"),
          h("div.wx-temp", null, "—"),
          h("div.wx-sub", null, "No weather entity yet"),
          h("div.wx-hint", null, "Add a weather entity in Home Assistant, or set weather.entity on this page."),
        ),
      );
      return;
    }
    const unit = w.temperature_unit || "°C";
    const days = Array.isArray(w.forecast) ? w.forecast.slice(0, 5) : [];
    let lang = ctx.device().clockLanguage || "en-GB";
    el.appendChild(
      h(
        "div.wx",
        null,
        h(
          "div.wx-now",
          null,
          glyph(condIcon(w.value), "wx-big lit"),
          h(
            "div.wx-now-txt",
            null,
            h("div.wx-temp", null, fmtT(w.temperature, unit)),
            h("div.wx-sub", null, condLabel(w.value)),
            h("div.wx-name", null, w.name || ""),
          ),
        ),
        h(
          "div.wx-stats",
          null,
          w.humidity != null ? h("div.wx-stat", null, glyph("droplet"), h("span", null, Math.round(w.humidity) + "%")) : null,
          w.wind_speed != null
            ? h("div.wx-stat", null, glyph("breeze"), h("span", null, Math.round(w.wind_speed) + " " + (w.wind_speed_unit || "")))
            : null,
          w.pressure != null ? h("div.wx-stat", null, glyph("gauge"), h("span", null, Math.round(w.pressure) + " " + (w.pressure_unit || ""))) : null,
        ),
        days.length
          ? h(
              "div.wx-days",
              null,
              days.map((d) => {
                let day = "";
                try {
                  day = new Intl.DateTimeFormat(lang, { weekday: "short" }).format(new Date(d.datetime));
                } catch (e) {
                  day = String(d.datetime || "").slice(5, 10);
                }
                return h(
                  "div.wx-day.surf.raised",
                  null,
                  h("div.wx-dname", null, day),
                  glyph(condIcon(d.condition)),
                  h("div.wx-dt", null, fmtT(d.temperature, unit)),
                  h("div.wx-dl", null, d.templow != null ? fmtT(d.templow, unit) : ""),
                );
              }),
            )
          : null,
      ),
    );
  }
  update();
  return { el, keys: [key], update };
}

// --- alarm (Alarmo, direct MQTT) ---------------------------------------------

const ALARM_LABEL = {
  disarmed: "Disarmed",
  armed_home: "Armed home",
  armed_away: "Armed away",
  armed_night: "Armed night",
  armed_vacation: "Armed vacation",
  armed_custom_bypass: "Armed custom",
  arming: "Arming…",
  pending: "Pending…",
  triggered: "TRIGGERED",
  unavailable: "Unavailable",
};
const EVENT_MSG = {
  INVALID_CODE_PROVIDED: "Wrong PIN",
  NO_CODE_PROVIDED: "Enter your PIN",
  FAILED_TO_ARM: "Could not arm — check open sensors",
  COMMAND_NOT_ALLOWED: "Not allowed right now",
  TRIGGER: "Alarm triggered",
};

export function alarmTopics(page) {
  const a = page.alarm || {};
  return {
    state: a.stateTopic || (a.area ? "alarmo/" + a.area + "/state" : "alarmo/state"),
    command: a.commandTopic || "alarmo/command",
    event: a.eventTopic || (a.area ? "alarmo/" + a.area + "/event" : "alarmo/event"),
  };
}

function alarmPage(page, ctx) {
  const a = page.alarm || {};
  const topics = alarmTopics(page);
  const actions = Array.isArray(a.actions) && a.actions.length ? a.actions : ["disarm", "arm_home", "arm_away"];
  const armNeedsCode = a.codeArmRequired !== false;
  let pin = "";
  let msgTimer = null;

  const stateEl = h("div.al-state");
  const icon = h("div.al-icon");
  const dots = h("div.al-dots");
  const msg = h("div.al-msg");
  const pad = h("div.al-pad");
  const acts = h("div.al-acts");

  function renderDots() {
    while (dots.firstChild) dots.removeChild(dots.firstChild);
    const n = Math.max(4, pin.length);
    for (let i = 0; i < n; i++) dots.appendChild(h("span.al-dot" + (i < pin.length ? ".on" : "")));
  }
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"].forEach((k) => {
    const b = h("div.al-key.surf.raised", null, k);
    press(b, {
      onTap() {
        if (k === "C") pin = "";
        else if (k === "⌫") pin = pin.slice(0, -1);
        else if (pin.length < 10) pin += k;
        renderDots();
        update();
      },
    });
    pad.appendChild(b);
  });
  const LABEL = { disarm: "Disarm", arm_home: "Arm home", arm_away: "Arm away" };
  const actEls = {};
  actions.forEach((act) => {
    const b = h("div.al-act.surf.raised", null, glyph(act === "disarm" ? "shield-disarmed" : act === "arm_home" ? "at-home" : "away"), h("span", null, LABEL[act] || act));
    actEls[act] = b;
    press(b, {
      onTap() {
        if (b.classList.contains("disabled")) return;
        const needs = act === "disarm" || armNeedsCode;
        if (needs && !pin) {
          flash(EVENT_MSG.NO_CODE_PROVIDED);
          return;
        }
        const payload = { command: act };
        if (pin) payload.code = pin;
        if (a.area) payload.area = a.area;
        ctx.publishRaw(topics.command, JSON.stringify(payload), false);
        pin = "";
        renderDots();
        flash("Sent…");
      },
    });
    acts.appendChild(b);
  });

  function flash(text) {
    msg.textContent = text;
    msg.classList.add("show");
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => msg.classList.remove("show"), 3500);
  }

  function update() {
    const st = ctx.alarmState(topics.state) || "unavailable";
    stateEl.textContent = ALARM_LABEL[st] || st;
    el.setAttribute("data-state", st);
    while (icon.firstChild) icon.removeChild(icon.firstChild);
    icon.appendChild(glyph(st === "disarmed" ? "shield-disarmed" : "shield-check", st !== "disarmed" ? "lit" : ""));
    const disarmed = st === "disarmed";
    for (const k in actEls) {
      const enabled = k === "disarm" ? !disarmed && st !== "unavailable" : disarmed;
      actEls[k].classList.toggle("disabled", !enabled);
    }
  }

  const el = h(
    "div.page.page-alarm",
    null,
    h("div.al-head", null, icon, stateEl),
    dots,
    msg,
    pad,
    acts,
  );
  renderDots();
  update();
  return {
    el,
    keys: [],
    update,
    alarmStateTopic: topics.state,
    onAlarmEvent(ev) {
      const code = ev && (ev.event || ev.reason);
      if (code && EVENT_MSG[code]) flash(EVENT_MSG[code]);
    },
    onHide() {
      pin = "";
      renderDots();
    },
  };
}

// --- camera ------------------------------------------------------------------

function camName(c) {
  return (c.name && c.name.trim()) || String(c.entity || "").replace(/^camera\./, "").replace(/_/g, " ");
}

function cameraPage(page, ctx) {
  const cfg = page.camera || { cameras: [] };
  const cams = cfg.cameras || [];
  let sel = 0;
  let visible = false;
  const img = h("img.cam-img", { alt: "" });
  const off = h("div.cam-off", null, glyph("camera-off"), h("div", null, "Camera offline"));
  const video = h("div.cam-video", null, img, off);
  let currentSrc = null;
  img.addEventListener("error", () => {
    video.classList.add("offline");
  });
  img.addEventListener("load", () => video.classList.remove("offline"));

  const padEl = h("div.cam-pad");
  const dirs = { up: "chevron-up", left: "chevron-left", right: "chevron-right", down: "chevron-down" };
  const dirEls = {};
  ["up", "left", "right", "down"].forEach((d) => {
    const b = h("div.cam-key.surf.raised.k-" + d, null, glyph(dirs[d]));
    dirEls[d] = b;
    press(b, {
      holdMs: cfg.holdRepeatMs == null ? 400 : cfg.holdRepeatMs,
      onHold() {
        const cam = cams[sel];
        if (!cam || !cam.ptz || !cam.ptz[d]) return;
        ctx.event(page.id + ".ptz." + slugify(cam.entity) + "." + d, "press");
      },
    });
    padEl.appendChild(b);
  });
  const list = h("div.cam-list");
  const itemEls = cams.map((c, i) => {
    const b = h("div.cam-item.surf.raised", null, camName(c));
    press(b, {
      onTap() {
        sel = i;
        update();
      },
    });
    list.appendChild(b);
    return b;
  });

  const el = h("div.page.page-camera", null, video, h("div.cam-strip", null, padEl, list));

  function update() {
    const cam = cams[sel];
    itemEls.forEach((b, i) => b.classList.toggle("on", i === sel));
    ["up", "down", "left", "right"].forEach((d) => dirEls[d].classList.toggle("disabled", !(cam && cam.ptz && cam.ptz[d])));
    const m = cam ? ctx.get(slugify(cam.entity)) : null;
    const url = visible && ctx.awake() && m && m.stream ? m.stream : null;
    if (!m || !m.stream) video.classList.add("offline");
    // The token in the URL rotates every few minutes; HA only checks it when
    // the stream starts, so keep the running stream rather than reconnecting.
    if (url && currentSrc && sameCamera(url, currentSrc)) return;
    if (url !== currentSrc) {
      currentSrc = url;
      img.src = url || "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    }
  }
  function sameCamera(a, b) {
    return a.split("?")[0] === b.split("?")[0];
  }
  update();
  return {
    el,
    keys: cams.map((c) => slugify(c.entity)),
    update,
    keepOnPage: cfg.keepOnPage !== false,
    keepAwake: cfg.keepAwake === true,
    onShow() {
      visible = true;
      update();
    },
    onHide() {
      visible = false;
      update();
    },
  };
}

// --- music (Music Assistant) -------------------------------------------------

function musicPage(page, ctx) {
  const ma = ctx.ma();
  let playerId = null;
  let libOpen = false;
  let lib = null;
  let visible = false;
  const el = h("div.page.page-music");

  function fmtTime(s) {
    if (typeof s !== "number" || !isFinite(s)) return "";
    s = Math.max(0, Math.round(s));
    return Math.floor(s / 60) + ":" + pad2(s % 60);
  }

  function btn(icon, fn, extra) {
    const b = h("div.mu-btn.surf.raised" + (extra || ""), null, glyph(icon));
    press(b, { onTap: fn });
    return b;
  }

  function render() {
    while (el.firstChild) el.removeChild(el.firstChild);
    if (ma.status !== "ready") {
      el.appendChild(
        h(
          "div.ng-wrap",
          null,
          glyph("music", "wx-big"),
          h("div.wx-sub", null, ma.status === "connecting" ? "Connecting to Music Assistant…" : "Music Assistant"),
          ma.error ? h("div.wx-hint", null, ma.error) : null,
        ),
      );
      return;
    }
    const players = ma.list();
    if (!playerId || !ma.players[playerId]) {
      const playing = players.filter((p) => (p.playback_state || p.state) === "playing")[0];
      playerId = (playing || players[0] || {}).player_id || null;
    }
    const p = playerId ? ma.players[playerId] : null;
    if (!p) {
      el.appendChild(h("div.ng-wrap", null, glyph("speaker", "wx-big"), h("div.wx-sub", null, "No players found")));
      return;
    }
    const media = p.current_media || {};
    const state = p.playback_state || p.state;
    const art = ma.imageUrl(media.image_url);
    const sel = h("div.mu-player.surf.raised", null, glyph("speaker"), h("span", null, p.display_name || p.name || p.player_id), glyph("chevron-down"));
    press(sel, {
      onTap() {
        const idx = players.indexOf(p);
        playerId = players[(idx + 1) % players.length].player_id;
        render();
      },
    });
    const libBtn = btn("favorite", () => {
      libOpen = !libOpen;
      if (libOpen && !lib) {
        ma.library()
          .then((items) => {
            lib = items;
            render();
          })
          .catch(() => {
            lib = [];
            render();
          });
      }
      render();
    }, ".mu-lib-btn");
    el.appendChild(h("div.mu-top", null, sel, libBtn));

    if (libOpen) {
      const listEl = h("div.mu-libl");
      if (!lib) listEl.appendChild(h("div.wx-hint", null, "Loading favourites…"));
      else if (!lib.length) listEl.appendChild(h("div.wx-hint", null, "No favourite radios or playlists in Music Assistant."));
      else
        lib.forEach((it) => {
          const img = it.image ? ma.imageUrl(it.image.path || it.image) : null;
          const row = h(
            "div.mu-libi.surf.raised",
            null,
            img ? h("img", { src: img }) : glyph(it.media_type === "radio" ? "antenna" : "music"),
            h("span", null, it.name),
          );
          press(row, {
            onTap() {
              ma.cmd("player_queues/play_media", { queue_id: p.active_source || p.player_id, media: it.uri }).catch((e) => ctx.log("MA play: " + e.message));
              libOpen = false;
              render();
            },
          });
          listEl.appendChild(row);
        });
      el.appendChild(listEl);
      return;
    }

    el.appendChild(
      h(
        "div.mu-now",
        null,
        h("div.mu-art.surf.inset", null, art ? h("img", { src: art }) : glyph("music")),
        h(
          "div.mu-meta",
          null,
          h("div.mu-title", null, media.title || (state === "playing" ? "Playing" : "Nothing playing")),
          h("div.mu-artist", null, [media.artist, media.album].filter(Boolean).join(" · ")),
          h("div.mu-time", null, media.duration ? fmtTime(media.elapsed_time || p.elapsed_time) + " / " + fmtTime(media.duration) : ""),
        ),
      ),
    );
    const pid = p.player_id;
    el.appendChild(
      h(
        "div.mu-ctl",
        null,
        btn("skip-previous", () => ma.cmd("players/cmd/previous", { player_id: pid })),
        btn(state === "playing" ? "pause" : "play", () =>
          ma.cmd(state === "playing" ? "players/cmd/pause" : "players/cmd/play", { player_id: pid }),
          ".mu-play",
        ),
        btn("skip-next", () => ma.cmd("players/cmd/next", { player_id: pid })),
      ),
    );
    const vol = typeof p.volume_level === "number" ? p.volume_level : null;
    if (vol != null) {
      const volCells = h("div.mu-vol.surf.inset");
      const segs = 12;
      for (let i = 0; i < segs; i++) volCells.appendChild(h("div.pv-cell." + (i < Math.round((vol / 100) * segs) ? "on" : "off")));
      volCells.addEventListener("pointerup", (ev) => {
        const r = volCells.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        ma.cmd("players/cmd/volume_set", { player_id: pid, volume_level: Math.round(f * 100) });
      });
      el.appendChild(h("div.mu-volrow", null, glyph("volume-low"), volCells, glyph("volume-high")));
    }
  }

  ma.onChange = () => {
    if (visible) render();
  };
  render();
  return {
    el,
    keys: [],
    update() {},
    onShow() {
      visible = true;
      ma.start();
      render();
    },
    onHide() {
      visible = false;
      libOpen = false;
    },
  };
}
