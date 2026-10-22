// Wi-Fi on the setup screen (recovery section of a locked panel, the HDL
// Source 7). A locked panel can't reach Android's Settings, so moving it to a
// new site's Wi-Fi happens here instead of a factory reset: Find networks,
// tap one, type the password, Connect. Everything else on the panel is kept.

import { h } from "./util.js";

function bars(rssi) {
  const n = rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -78 ? 2 : 1;
  const b = h("span.wf-bars");
  for (let i = 1; i <= 4; i++) b.appendChild(h("i" + (i <= n ? ".on" : ""), { style: { height: 3 + i * 3 + "px" } }));
  return b;
}

/** Appends the Wi-Fi section to `parent`. `native` is native.js. */
export function wifiSection(parent, native) {
  const info = h("div.kv.adb", null, "");
  const findBtn = h("button", null, "Find Wi-Fi networks");
  const otherBtn = h("button", null, "Other network");
  const list = h("div.wf-list");
  const form = h("div.wf-form");
  let poll = null;

  const showInfo = () => {
    const w = native.wifiInfo() || {};
    if (w.enabled === false) info.textContent = "Wi-Fi: off";
    else if (w.ssid && w.ip) info.textContent = "Wi-Fi: " + w.ssid + " · " + w.ip;
    else if (w.ssid) info.textContent = "Wi-Fi: joining " + w.ssid + "…";
    else info.textContent = "Wi-Fi: not connected";
  };

  const closeForm = () => {
    form.innerHTML = "";
  };

  const connect = (ssid, pass) => {
    clearInterval(poll);
    closeForm();
    list.innerHTML = "";
    info.textContent = "Wi-Fi: connecting to " + ssid + "…";
    if (!native.wifiConnect(ssid, pass)) {
      info.textContent = "Wi-Fi: Android didn't accept " + ssid + ". Check the name and try again.";
      return;
    }
    const t0 = Date.now();
    poll = setInterval(() => {
      const w = native.wifiInfo() || {};
      if (w.ssid === ssid && w.ip) {
        clearInterval(poll);
        native.wifiKeepOnly(ssid);
        info.textContent = "Wi-Fi: connected to " + ssid + " · " + w.ip + ". The old network is forgotten.";
      } else if (Date.now() - t0 > 30000) {
        clearInterval(poll);
        info.textContent = "Wi-Fi: couldn't join " + ssid + ". Check the password and try again.";
      }
    }, 1500);
  };

  const askPassword = (ssid, secure, askName) => {
    closeForm();
    const name = h("input", { type: "text", placeholder: "Network name", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
    const pass = h("input", { type: "password", placeholder: secure ? "Password" : "Password (leave empty if open)", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
    const show = h("button", null, "Show");
    const cancel = h("button", null, "Cancel");
    const go = h("button.primary", null, "Connect");
    const err = h("div.err");
    show.addEventListener("click", () => {
      const hidden = pass.type === "password";
      pass.type = hidden ? "text" : "password";
      show.textContent = hidden ? "Hide" : "Show";
    });
    cancel.addEventListener("click", closeForm);
    go.addEventListener("click", () => {
      const n = askName ? name.value.trim() : ssid;
      if (!n) return void (err.textContent = "Type the network name.");
      if (pass.value && pass.value.length < 8) return void (err.textContent = "Wi-Fi passwords are at least 8 characters.");
      if (secure && !pass.value) return void (err.textContent = "This network needs its password.");
      connect(n, pass.value);
    });
    form.appendChild(h("label", null, askName ? "Other network" : ssid));
    if (askName) form.appendChild(name);
    if (secure || askName) {
      form.appendChild(h("div.wf-pw", null, pass, show));
    } else {
      form.appendChild(h("div.hint", null, "Open network, no password."));
    }
    form.appendChild(err);
    form.appendChild(h("div.row", null, cancel, go));
    (askName ? name : secure ? pass : go).focus();
  };

  const render = (nets) => {
    list.innerHTML = "";
    if (!nets.length) {
      list.appendChild(h("div.hint", null, "No networks found. Try again, or use Other network for a hidden one."));
      return;
    }
    const now = (native.wifiInfo() || {}).ssid;
    nets.slice(0, 12).forEach((n) => {
      const row = h(
        "div.wf-net" + (n.ssid === now ? ".cur" : ""),
        null,
        h("span.wf-name", null, n.ssid),
        h("span.wf-tag", null, n.ssid === now ? "Connected" : n.enterprise ? "Not supported" : n.secure ? "Password" : "Open"),
        bars(n.rssi),
      );
      if (!n.enterprise) row.addEventListener("click", () => askPassword(n.ssid, n.secure, false));
      list.appendChild(row);
    });
  };

  findBtn.addEventListener("click", () => {
    closeForm();
    list.innerHTML = "";
    list.appendChild(h("div.hint", null, "Looking for networks…"));
    native.wifiScan();
    setTimeout(() => render(native.wifiList() || []), 4000);
  });
  otherBtn.addEventListener("click", () => askPassword("", true, true));

  parent.appendChild(h("label", null, "Wi-Fi"));
  parent.appendChild(info);
  parent.appendChild(h("div.row", null, findBtn, otherBtn));
  parent.appendChild(list);
  parent.appendChild(form);
  parent.appendChild(
    h("div.hint", null, "Moves the panel to another Wi-Fi without a factory reset. The app, licence and Home Assistant setup stay. For a new Home Assistant as well, use Reset for a new site above."),
  );
  showInfo();
}
