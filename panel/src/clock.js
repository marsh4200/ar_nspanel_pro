// Clock view — used by the clock page AND the clock screensaver.
import { h, pad2, glyph } from "./util.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function locale(dev) {
  return dev.clockLanguage || "en-GB";
}

function fmtDate(d, dev) {
  try {
    return new Intl.DateTimeFormat(locale(dev), { weekday: "long", day: "numeric", month: "long" }).format(d);
  } catch (e) {
    return d.toDateString();
  }
}

/**
 * Theme resolution for a clock surface: "custom" = clockAppearance + clockAccent,
 * "match-app" = the panel theme, anything else = that kit theme by name.
 * @returns {{theme:string|null, custom:boolean}}
 */
export function clockTheme(dev, which, panelTheme) {
  const t = dev[which] || "custom";
  if (t === "custom") return { theme: null, custom: true };
  if (t === "match-app") return { theme: panelTheme, custom: false };
  return { theme: t, custom: false };
}

/**
 * @param dev device config
 * @param opts {themeKey:'clockPageTheme'|'clockScreensaverTheme', panelTheme, alarm:()=>obj}
 */
export function clockView(dev, opts) {
  const analog = dev.clockFace === "analog";
  const h24 = dev.clockFormat24h !== false;
  const th = clockTheme(dev, opts.themeKey, opts.panelTheme);
  const light = dev.clockAppearance === "light";
  const accent = dev.clockAccent || "#e6a23c";
  const root = h("div.clock" + (th.custom ? (light ? ".clock-light" : ".clock-dark") : ".themed.kitscreen"), {
    "data-theme": th.theme || null,
    style: th.custom ? { "--clock-accent": accent } : { "--clock-accent": "var(--accent)" },
  });
  const dateEl = h("div.clock-date", { style: { fontSize: (dev.clockDateFontSize || 13) * 1.6 + "px" } });
  const alarmEl = h("div.clock-alarm");
  let tick;

  if (analog) {
    const svg = svgEl("svg", { viewBox: "0 0 200 200", class: "clock-face" });
    svg.appendChild(svgEl("circle", { cx: 100, cy: 100, r: 94, class: "cf-ring" }));
    for (let i = 0; i < 60; i++) {
      const major = i % 5 === 0;
      const a = (i / 60) * Math.PI * 2;
      const r1 = major ? 80 : 86;
      svg.appendChild(
        svgEl("line", {
          x1: 100 + Math.sin(a) * r1,
          y1: 100 - Math.cos(a) * r1,
          x2: 100 + Math.sin(a) * 90,
          y2: 100 - Math.cos(a) * 90,
          class: major ? "cf-major" : "cf-minor",
        }),
      );
    }
    const hh = svgEl("line", { x1: 100, y1: 100, x2: 100, y2: 52, class: "cf-hour" });
    const mm = svgEl("line", { x1: 100, y1: 100, x2: 100, y2: 30, class: "cf-min" });
    const ss = svgEl("line", { x1: 100, y1: 114, x2: 100, y2: 24, class: "cf-sec" });
    svg.appendChild(hh);
    svg.appendChild(mm);
    svg.appendChild(ss);
    svg.appendChild(svgEl("circle", { cx: 100, cy: 100, r: 4.5, class: "cf-hub" }));
    root.appendChild(h("div.clock-analog", null, svg));
    root.appendChild(dateEl);
    tick = (d) => {
      const s = d.getSeconds();
      const m = d.getMinutes() + s / 60;
      const hr = (d.getHours() % 12) + m / 60;
      hh.setAttribute("transform", "rotate(" + hr * 30 + " 100 100)");
      mm.setAttribute("transform", "rotate(" + m * 6 + " 100 100)");
      ss.setAttribute("transform", "rotate(" + s * 6 + " 100 100)");
    };
  } else {
    const timeEl = h("div.clock-time");
    const ampm = h("span.clock-ampm");
    root.appendChild(h("div.clock-digital", null, timeEl, h24 ? null : ampm));
    root.appendChild(dateEl);
    tick = (d) => {
      let hr = d.getHours();
      if (!h24) {
        ampm.textContent = hr < 12 ? "AM" : "PM";
        hr = hr % 12 || 12;
      }
      timeEl.textContent = (h24 ? pad2(hr) : String(hr)) + ":" + pad2(d.getMinutes());
    };
  }
  root.appendChild(alarmEl);

  let last = "";
  function update() {
    const d = new Date();
    tick(d);
    const ds = fmtDate(d, dev);
    if (ds !== last) {
      dateEl.textContent = ds;
      last = ds;
    }
    const al = opts.alarm ? opts.alarm() : null;
    if (al && al.enabled) {
      if (!alarmEl.firstChild) alarmEl.appendChild(glyph("alarm"));
      alarmEl.setAttribute("data-t", pad2(al.hour) + ":" + pad2(al.minute));
      alarmEl.style.display = "";
    } else {
      alarmEl.style.display = "none";
    }
  }
  update();
  return { el: root, update };
}
