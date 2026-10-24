// Intercom: live voice calls between panels.
//
// This file is the screens: the "Call a panel" picker, the ringing screens
// (outgoing / incoming) and the in-call screen. The calling itself (MQTT
// signalling + WebRTC audio, panel to panel on the LAN) plugs in through the
// `api` passed to mountIntercom:
//   api.panels()            -> [{ id, name, online }] other panels
//   api.dial(id)            start a call
//   api.answer() / api.decline() / api.hangup()
//   api.mute(on)
// and drives the screens back through the returned object:
//   ic.incoming(from) / ic.connected() / ic.ended(reason) / ic.level(0..1)

const IC_ICON = {
  phone:
    '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/>',
  micoff: '<path d="M2 2l20 20"/><path d="M9 9v1a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.7"/><path d="M19 10a7 7 0 0 1-1.1 3.8M5 10a7 7 0 0 0 11 5.7M12 17v4M8 21h8"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  panel: '<rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="12" cy="11" r="3"/><path d="M8 21h8"/>',
};
const icSvg = (n) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + IC_ICON[n] + "</svg>";

function div(cls, html) {
  const d = document.createElement("div");
  d.className = cls;
  if (html) d.innerHTML = html;
  return d;
}
const initials = (n) =>
  String(n || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
const mmss = (s) => {
  s = Math.max(0, Math.floor(s));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
};

export function mountIntercom(root, api) {
  // --- picker -------------------------------------------------------------------
  const pick = div("ic-pickwrap");
  const pickDim = div("ic-dim");
  const pickPn = div("ic-pick");
  pick.appendChild(pickDim);
  pick.appendChild(pickPn);
  root.appendChild(pick);
  pickDim.addEventListener("click", closePicker);

  function open() {
    pickPn.innerHTML = "";
    const head = div("ic-pickh", "<b>Call a panel</b>");
    const x = div("ic-x", icSvg("x"));
    x.addEventListener("click", closePicker);
    head.appendChild(x);
    pickPn.appendChild(head);
    const list = api.panels() || [];
    if (!list.length) pickPn.appendChild(div("ic-empty", "No other panels yet. Add them in Home Assistant under AR NSPanel Pro."));
    const g = div("ic-grid");
    list.forEach((p) => {
      const b = div("ic-p" + (p.online ? "" : " off"), '<span class="ic-av"></span><span class="ic-pn"></span><span class="ic-ps"></span>');
      b.querySelector(".ic-av").textContent = initials(p.name);
      b.querySelector(".ic-pn").textContent = p.name;
      b.querySelector(".ic-ps").textContent = p.online ? "Available" : "Offline";
      if (p.online)
        b.addEventListener("click", () => {
          closePicker();
          outgoing(p);
          api.dial(p.id);
        });
      g.appendChild(b);
    });
    pickPn.appendChild(g);
    pick.classList.add("open");
  }
  function closePicker() {
    pick.classList.remove("open");
  }

  // --- call screen --------------------------------------------------------------
  const scr = div("ic-call");
  root.appendChild(scr);
  let state = "idle"; // idle | out | in | live
  let peer = null;
  let t0 = 0;
  let timer = null;
  let muted = false;

  function draw(sub) {
    scr.innerHTML = "";
    scr.className = "ic-call show " + state;
    const mid = div("ic-mid");
    const av = div("ic-big", '<i class="ic-ring r1"></i><i class="ic-ring r2"></i><i class="ic-ring r3"></i><span></span>');
    av.querySelector("span").textContent = initials(peer && peer.name);
    mid.appendChild(av);
    const nm = div("ic-nm");
    nm.textContent = (peer && peer.name) || "Panel";
    mid.appendChild(nm);
    const st = div("ic-st");
    st.textContent = sub;
    mid.appendChild(st);
    if (state === "live") mid.appendChild(div("ic-lvl", "<i></i><i></i><i></i><i></i><i></i><i></i><i></i>"));
    scr.appendChild(mid);
    const row = div("ic-btns");
    const btn = (cls, icon, label, fn) => {
      const b = div("ic-b " + cls, '<span class="ic-bc">' + icSvg(icon) + "</span><span class=\"ic-bl\"></span>");
      b.querySelector(".ic-bl").textContent = label;
      b.addEventListener("click", fn);
      row.appendChild(b);
      return b;
    };
    if (state === "in") {
      btn("red", "phone", "Decline", () => api.decline());
      btn("green", "phone", "Answer", () => {
        connecting();
        api.answer();
      });
    } else if (state === "out") {
      btn("red", "phone", "Cancel", () => api.hangup());
    } else if (state === "live") {
      btn("glass" + (muted ? " on" : ""), muted ? "micoff" : "mic", muted ? "Unmute" : "Mute", () => {
        muted = !muted;
        api.mute(muted);
        draw(stLive());
      });
      btn("red", "phone", "Hang up", () => api.hangup());
    }
    scr.appendChild(row);
  }
  const stLive = () => (muted ? "Muted · " : "") + mmss((Date.now() - t0) / 1000);

  function outgoing(p) {
    peer = p;
    state = "out";
    muted = false;
    draw("Calling…");
  }
  function incoming(p) {
    if (state !== "idle") return false; // busy
    closePicker();
    peer = p;
    state = "in";
    muted = false;
    draw("is calling you");
    return true;
  }
  function connected() {
    state = "live";
    t0 = Date.now();
    draw(stLive());
    clearInterval(timer);
    timer = setInterval(() => {
      const st = scr.querySelector(".ic-st");
      if (st) st.textContent = stLive();
    }, 1000);
  }
  function ended(reason) {
    clearInterval(timer);
    if (state === "idle") return;
    state = "end";
    draw(reason || "Call ended");
    scr.className = "ic-call show end";
    setTimeout(() => {
      if (state !== "end") return;
      state = "idle";
      peer = null;
      scr.className = "ic-call";
      scr.innerHTML = "";
    }, 1500);
  }
  // microphone level 0..1 -> the bars under the name
  function level(v) {
    const bars = scr.querySelectorAll(".ic-lvl i");
    const shape = [0.35, 0.6, 0.85, 1, 0.85, 0.6, 0.35];
    for (let i = 0; i < bars.length; i++) {
      const h = muted ? 0.08 : Math.max(0.08, Math.min(1, v * shape[i] * (0.75 + Math.random() * 0.5)));
      bars[i].style.transform = "scaleY(" + h.toFixed(2) + ")";
    }
  }

  function connecting() {
    if (state !== "in") return;
    state = "out";
    draw("Connecting…");
    scr.className = "ic-call show out";
  }
  function restore(role, p, t) {
    peer = p;
    if (t) {
      connected();
      t0 = t;
    } else if (role === "out") outgoing(p);
    else {
      state = "in";
      draw("is calling you");
    }
  }

  return { open, incoming, connected, connecting, ended, level, restore, busy: () => state !== "idle" };
}

export const intercomIcon = () => icSvg("phone");

// --- the calling: MQTT signalling + WebRTC audio --------------------------------
//
// Topics (all under ar-nspanel-pro/intercom):
//   peer/<id>   retained, written by Home Assistant: {name, on}
//   to/<id>     a panel's inbox: {t, call, from, name?, sdp?, c?}
//               t = ring | accept | decline | busy | cancel | hangup | offer | answer | ice
// Online / offline comes from each panel's own ar-nspanel-pro/panel/<id>/avail.
// Audio goes panel to panel over the LAN (no STUN/TURN: host candidates only).

export const IC_TOPIC = "ar-nspanel-pro/intercom";
const RING_MS = 30000;

export function intercomEngine(o) {
  // o: { myId, send(topic, obj), wake(), enabled(), autoAnswer(), sound, log }
  const peers = {}; // id -> {name, on}
  const avail = {}; // id -> "online" | "offline"
  let ui = null;
  let call = null; // {id, peer:{id,name}, role:"out"|"in", state, pc, mic, audio, ice:[], t0, timer, tone}
  const log = (...a) => o.log && o.log("intercom:", ...a);

  const myName = () => (peers[o.myId] && peers[o.myId].name) || o.myId;
  const to = (id, msg) => o.send(IC_TOPIC + "/to/" + id, Object.assign({ from: o.myId, call: call && call.id }, msg));

  function tone(name) {
    if (call && call.tone) call.tone.stop();
    if (call) call.tone = name ? o.sound.loop(name) : null;
  }

  function cleanup() {
    if (!call) return;
    clearTimeout(call.timer);
    clearInterval(call.meter);
    if (call.tone) call.tone.stop();
    try {
      if (call.pc) call.pc.close();
    } catch (e) {
      /* ignore */
    }
    if (call.mic) call.mic.getTracks().forEach((t) => t.stop());
    if (call.audio) {
      call.audio.pause();
      call.audio.srcObject = null;
    }
    call = null;
  }
  function end(reason, notify) {
    if (!call) return;
    if (notify) to(call.peer.id, { t: notify });
    cleanup();
    if (ui) ui.ended(reason);
  }

  const micWhy = (e) => (e && e.message === "insecure" ? "Calls need the built-in screen (Setup: Load UI from = blank)" : "No microphone access");
  async function getMic() {
    // the microphone only works on a "secure" page: the panel's built-in screen
    // (file://), not one loaded over plain http from Home Assistant
    if (window.isSecureContext === false) throw new Error("insecure");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("no microphone support");
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  }

  function makePc() {
    const pc = new RTCPeerConnection({ iceServers: [] });
    call.pc = pc;
    call.mic.getTracks().forEach((t) => pc.addTrack(t, call.mic));
    pc.onicecandidate = (e) => {
      if (e.candidate) to(call.peer.id, { t: "ice", c: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } });
    };
    pc.ontrack = (e) => {
      if (!call) return;
      const s = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      if (!call.audio) call.audio = new Audio();
      call.audio.autoplay = true;
      call.audio.srcObject = s;
      const p = call.audio.play();
      if (p && p.catch) p.catch((err) => log("play failed", err && err.message));
      meter();
    };
    pc.onconnectionstatechange = () => {
      if (!call || call.pc !== pc) return;
      const st = pc.connectionState;
      log("connection", st);
      if (st === "connected" && call.state !== "live") live();
      if (st === "failed") end("Couldn't connect", "hangup");
      if (st === "disconnected") {
        clearTimeout(call.timer);
        call.timer = setTimeout(() => call && call.pc === pc && pc.connectionState !== "connected" && end("Connection lost", "hangup"), 6000);
      }
    };
    return pc;
  }
  function addIce() {
    const pc = call && call.pc;
    if (!pc || !pc.remoteDescription) return;
    call.ice.splice(0).forEach((c) => pc.addIceCandidate(c).catch((e) => log("ice", e && e.message)));
  }
  // voice level of the other side -> the bars on the call screen (from the
  // call's own stats: works without routing the audio through WebAudio)
  function meter() {
    clearInterval(call.meter);
    const pc = call.pc;
    call.meter = setInterval(() => {
      if (!call || call.pc !== pc || !ui) return;
      pc.getStats()
        .then((st) => {
          let lv = null;
          st.forEach((r) => {
            if (r.kind === "audio" && typeof r.audioLevel === "number" && (r.type === "inbound-rtp" || (r.type === "track" && r.remoteSource))) lv = r.audioLevel;
          });
          if (lv != null && ui) ui.level(Math.min(1, Math.sqrt(lv) * 1.6));
        })
        .catch(() => {});
    }, 150);
  }
  function live() {
    clearTimeout(call.timer);
    tone(null);
    call.state = "live";
    call.t0 = Date.now();
    if (ui) ui.connected();
  }

  // --- outgoing ---
  function dial(id) {
    if (call) return;
    const p = peers[id] || { name: id };
    call = { id: Math.random().toString(36).slice(2, 10), peer: { id, name: p.name }, role: "out", state: "ringing", ice: [] };
    to(id, { t: "ring", name: myName() });
    tone("ringback");
    call.timer = setTimeout(() => end("No answer", "cancel"), RING_MS);
    log("ring", id);
  }
  async function onAccept() {
    tone(null);
    try {
      call.mic = await getMic();
    } catch (e) {
      return end(micWhy(e), "hangup");
    }
    if (!call) return;
    const pc = makePc();
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    to(call.peer.id, { t: "offer", sdp: pc.localDescription.sdp });
    call.timer = setTimeout(() => call && call.state !== "live" && end("Couldn't connect", "hangup"), 15000);
  }

  // --- incoming ---
  async function answer() {
    if (!call || call.role !== "in" || call.state !== "ringing") return;
    tone(null);
    clearTimeout(call.timer);
    call.state = "answering";
    try {
      call.mic = await getMic();
    } catch (e) {
      return end(micWhy(e), "decline");
    }
    if (!call) return;
    to(call.peer.id, { t: "accept" });
    call.timer = setTimeout(() => call && call.state !== "live" && end("Couldn't connect", "hangup"), 15000);
  }
  async function onOffer(sdp) {
    if (!call.mic) return;
    const pc = makePc();
    await pc.setRemoteDescription({ type: "offer", sdp });
    addIce();
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    to(call.peer.id, { t: "answer", sdp: pc.localDescription.sdp });
  }

  // --- inbox ---
  function onSignal(raw) {
    let m;
    try {
      m = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      return;
    }
    if (!m || !m.from || m.from === o.myId) return;
    if (m.t === "ring") {
      if (call || !o.enabled() || !ui) {
        o.send(IC_TOPIC + "/to/" + m.from, { t: call ? "busy" : "decline", call: m.call, from: o.myId });
        return;
      }
      call = { id: m.call, peer: { id: m.from, name: m.name || (peers[m.from] && peers[m.from].name) || m.from }, role: "in", state: "ringing", ice: [] };
      o.wake();
      ui.incoming(call.peer);
      call.timer = setTimeout(() => end("Missed call"), RING_MS + 2000);
      if (o.autoAnswer()) setTimeout(() => call && call.state === "ringing" && (ui.connecting && ui.connecting(), answer()), 1200);
      else tone("ring");
      return;
    }
    if (!call || m.call !== call.id || m.from !== call.peer.id) return;
    const run = (p) => p.catch((e) => {
      log(m.t, e && e.message);
      end("Couldn't connect", "hangup");
    });
    if (m.t === "accept" && call.role === "out") {
      clearTimeout(call.timer);
      run(onAccept());
    } else if (m.t === "offer" && call.role === "in") run(onOffer(m.sdp));
    else if (m.t === "answer" && call.role === "out" && call.pc) run(call.pc.setRemoteDescription({ type: "answer", sdp: m.sdp }).then(addIce));
    else if (m.t === "ice" && m.c) {
      call.ice.push(m.c);
      addIce();
    } else if (m.t === "decline") end("Declined");
    else if (m.t === "busy") end("Busy");
    else if (m.t === "cancel") end("Missed call");
    else if (m.t === "hangup") end("Call ended");
  }

  function onPeer(id, raw) {
    if (!raw) delete peers[id];
    else
      try {
        peers[id] = JSON.parse(raw);
      } catch (e) {
        /* ignore */
      }
  }
  function onAvail(id, raw) {
    avail[id] = String(raw);
    // the other panel dropped off mid-call
    if (call && call.peer.id === id && avail[id] !== "online") end("Connection lost");
  }

  const api = {
    panels: () =>
      Object.keys(peers)
        .filter((id) => id !== o.myId && peers[id] && peers[id].on !== false)
        .map((id) => ({ id, name: peers[id].name || id, online: avail[id] === "online" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    dial,
    answer,
    decline: () => end("Declined", "decline"),
    hangup: () => end("Call ended", call && call.role === "out" && call.state === "ringing" ? "cancel" : "hangup"),
    mute: (on) => call && call.mic && call.mic.getAudioTracks().forEach((t) => (t.enabled = !on)),
  };
  return {
    api,
    onSignal,
    onPeer,
    onAvail,
    busy: () => !!call,
    attach(u) {
      ui = u;
      // a redraw of the dashboard mid-call: show the call again
      if (u && call) u.restore(call.role, call.peer, call.state === "live" ? call.t0 : 0);
    },
    get ui() {
      return ui;
    },
  };
}
