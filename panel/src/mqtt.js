// Minimal MQTT 3.1.1 client over WebSocket.
//
// Deliberately dependency-free: the NSPanel Pro runs Android 8.1 and its
// system WebView can be old, so this sticks to APIs that have been in Chrome
// for years (WebSocket, ArrayBuffer, TextEncoder/Decoder). QoS 0 and 1 in, QoS 0
// out — the panel protocol never needs more.
//
// Reconnects with exponential backoff + jitter; on every (re)connect the
// retained topics replay, which is how the panel reconciles its state.
//
// Dead links (Wi-Fi blip, access-point roam, broker restart) are found fast:
// a ping every 10 s and the link counts as dead after 15 s of silence, well
// before the broker's own 45 s timeout marks the panel offline. A dead socket
// is dropped on the spot (a polite close would wait about a minute for an
// answer that never comes), and a connection attempt that gets no answer in
// 10 s is given up and retried.

const PING_MS = 10000; // send a ping this often
const DEAD_MS = 15000; // nothing heard for this long: the link is dead
const CONNECT_MS = 10000; // no CONNACK within this: try again
const CHECK_MS = 5000;

// a timer that the wall clock can't move (a clock fix after boot must not look
// like a dead link)
const now = typeof performance !== "undefined" && performance.now ? () => performance.now() : () => Date.now();

const enc = new TextEncoder();
const dec = new TextDecoder();

function utf8(str) {
  return enc.encode(str == null ? "" : String(str));
}

function encLen(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

function withLen(bytes) {
  const out = new Uint8Array(bytes.length + 2);
  out[0] = (bytes.length >> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function packet(type, flags, body) {
  const head = [(type << 4) | (flags & 0x0f)].concat(encLen(body.length));
  return concat([new Uint8Array(head), body]);
}

/** MQTT topic filter match (+ and # wildcards). */
export function topicMatch(filter, topic) {
  if (filter === topic) return true;
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export class MqttClient {
  /**
   * @param {object} opts {url, clientId, username, password, keepalive,
   *   will:{topic,payload,retain}, onConnect, onClose, onMessage, log}
   */
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.connected = false;
    this.subs = []; // filters to (re)subscribe on connect
    this.nextId = 1;
    this.buf = new Uint8Array(0);
    this.backoff = 1000;
    this.timer = null;
    this.pingTimer = null;
    this.connTimer = null;
    this.lastRx = 0;
    this.lastPing = 0;
    this.stopped = false;
  }

  log(...a) {
    if (this.opts.log) this.opts.log(...a);
  }

  start() {
    this.stopped = false;
    this._open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.connTimer);
    clearInterval(this.pingTimer);
    if (this.ws) {
      this._detach(this.ws);
      try {
        if (this.connected) this.ws.send(new Uint8Array([0xe0, 0x00]));
        this.ws.close();
      } catch (e) {
        /* ignore */
      }
    }
    this.ws = null;
    this.connected = false;
  }

  /** The panel moved to another network (LAN cable in / out): drop the old
   *  connection, which still runs over the previous network, and reconnect now. */
  reconnectNow() {
    if (this.stopped) return;
    this.backoff = 1000;
    if (this.ws) this._drop();
    else this.kick();
  }

  /** The network came back (Android says so): don't sit out the backoff. */
  kick() {
    if (this.stopped || this.connected || this.ws) return;
    clearTimeout(this.timer);
    this.backoff = 1000;
    this._open();
  }

  subscribe(filter) {
    if (this.subs.indexOf(filter) < 0) this.subs.push(filter);
    if (this.connected) this._sendSubscribe([filter]);
  }

  publish(topic, payload, retain) {
    if (!this.connected || !this.ws) return false;
    const body = concat([withLen(utf8(topic)), payload instanceof Uint8Array ? payload : utf8(payload)]);
    try {
      this.ws.send(packet(3, retain ? 1 : 0, body));
      return true;
    } catch (e) {
      return false;
    }
  }

  // --- internals -------------------------------------------------------------

  _open() {
    if (this.stopped) return;
    const o = this.opts;
    let ws;
    try {
      ws = new WebSocket(o.url, ["mqtt"]);
    } catch (e) {
      this.log("mqtt: bad url", o.url, e && e.message);
      this._scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.buf = new Uint8Array(0);
    ws.onopen = () => this._sendConnect();
    ws.onmessage = (ev) => this._onData(new Uint8Array(ev.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return; // an old socket we already dropped
      this._lost();
    };
    // no answer at all (broker restarting, half-open network): try again
    clearTimeout(this.connTimer);
    this.connTimer = setTimeout(() => {
      if (this.ws === ws && !this.connected) {
        this.log("mqtt: no answer from the broker in", CONNECT_MS / 1000, "s");
        this._drop();
      }
    }, CONNECT_MS);
  }

  _detach(ws) {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
  }

  /** Forget the current socket at once and reconnect (no polite close). */
  _drop() {
    const ws = this.ws;
    if (ws) {
      this._detach(ws);
      try {
        ws.close();
      } catch (e) {
        /* ignore */
      }
    }
    this._lost();
  }

  _lost() {
    const was = this.connected;
    this.connected = false;
    this.ws = null;
    clearInterval(this.pingTimer);
    clearTimeout(this.connTimer);
    if (was && this.opts.onClose) this.opts.onClose();
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const jitter = Math.random() * 0.4 + 0.8;
    const delay = Math.min(this.backoff, 30000) * jitter;
    this.backoff = Math.min(this.backoff * 2, 30000);
    this.log("mqtt: reconnect in", Math.round(delay), "ms");
    this.timer = setTimeout(() => this._open(), delay);
  }

  _sendConnect() {
    const o = this.opts;
    const keepalive = o.keepalive || 30;
    let flags = 0x02; // clean session
    const payload = [withLen(utf8(o.clientId))];
    if (o.will) {
      flags |= 0x04;
      if (o.will.retain) flags |= 0x20;
      payload.push(withLen(utf8(o.will.topic)));
      payload.push(withLen(utf8(o.will.payload)));
    }
    if (o.username) {
      flags |= 0x80;
      payload.push(withLen(utf8(o.username)));
      if (o.password != null && o.password !== "") {
        flags |= 0x40;
        payload.push(withLen(utf8(o.password)));
      }
    }
    const vh = concat([
      withLen(utf8("MQTT")),
      new Uint8Array([4, flags, (keepalive >> 8) & 0xff, keepalive & 0xff]),
    ]);
    this.ws.send(packet(1, 0, concat([vh].concat(payload))));
  }

  _sendSubscribe(filters) {
    const id = this.nextId;
    this.nextId = (this.nextId % 65535) + 1;
    const parts = [new Uint8Array([(id >> 8) & 0xff, id & 0xff])];
    for (const f of filters) {
      parts.push(withLen(utf8(f)));
      parts.push(new Uint8Array([0])); // QoS 0
    }
    this.ws.send(packet(8, 2, concat(parts)));
  }

  _onData(chunk) {
    this.lastRx = now();
    this.buf = this.buf.length ? concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      let mult = 1;
      let len = 0;
      let i = 1;
      let byte;
      do {
        if (i >= this.buf.length) return; // length not complete yet
        byte = this.buf[i++];
        len += (byte & 0x7f) * mult;
        mult *= 128;
      } while (byte & 0x80);
      if (this.buf.length < i + len) return;
      const head = this.buf[0];
      const body = this.buf.subarray(i, i + len);
      this.buf = this.buf.slice(i + len);
      this._onPacket(head >> 4, head & 0x0f, body);
    }
  }

  _onPacket(type, flags, body) {
    const o = this.opts;
    if (type === 2) {
      // CONNACK
      const rc = body[1];
      if (rc !== 0) {
        this.log("mqtt: connect refused, code", rc);
        if (o.onRefused) o.onRefused(rc);
        this._drop();
        return;
      }
      clearTimeout(this.connTimer);
      this.connected = true;
      this.backoff = 1000;
      this.lastPing = now();
      if (this.subs.length) this._sendSubscribe(this.subs);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (!this.connected || !this.ws) return;
        const t = now();
        if (t - this.lastRx > DEAD_MS) {
          this.log("mqtt: nothing heard for", Math.round((t - this.lastRx) / 1000), "s — link is dead, reconnecting");
          this._drop();
          return;
        }
        if (t - this.lastPing >= PING_MS - 100) {
          this.lastPing = t;
          try {
            this.ws.send(new Uint8Array([0xc0, 0x00]));
          } catch (e) {
            /* ignore */
          }
        }
      }, CHECK_MS);
      if (o.onConnect) o.onConnect();
    } else if (type === 3) {
      // PUBLISH
      const qos = (flags >> 1) & 3;
      const retain = !!(flags & 1);
      const tlen = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tlen));
      let off = 2 + tlen;
      if (qos > 0) {
        const pid = [body[off], body[off + 1]];
        off += 2;
        try {
          this.ws.send(new Uint8Array([qos === 1 ? 0x40 : 0x50, 0x02, pid[0], pid[1]]));
        } catch (e) {
          /* ignore */
        }
      }
      const payload = dec.decode(body.subarray(off));
      if (o.onMessage) {
        try {
          o.onMessage(topic, payload, retain);
        } catch (e) {
          this.log("mqtt: handler error on", topic, e && (e.stack || e.message));
        }
      }
    } else if (type === 6) {
      // PUBREL (QoS 2 inbound) -> PUBCOMP
      try {
        this.ws.send(new Uint8Array([0x70, 0x02, body[0], body[1]]));
      } catch (e) {
        /* ignore */
      }
    }
    // SUBACK (9), PINGRESP (13), PUBACK (4): nothing to do.
  }
}
