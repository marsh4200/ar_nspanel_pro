// Music Assistant client for the music page.
//
// Talks to MA directly (never through HA): REST POST /auth/login for a token
// when a username is configured, then the WebSocket API at /ws — first command
// `auth {token}`, then players/all + player events. Credentials arrive on the
// NON-retained cmd/ma_auth and are held in memory only.

import { httpPostJson } from "./http.js";

export class MusicAssistant {
  constructor(onChange, log) {
    this.onChange = onChange;
    this.log = log || function () {};
    this.cfg = null; // {url, username, password}
    this.ws = null;
    this.players = {};
    this.pending = {};
    this.nextId = 1;
    this.status = "idle"; // idle|connecting|ready|error
    this.error = null;
    this.baseUrl = "";
    this.retry = null;
    this.wanted = false;
  }

  configure(cfg) {
    const changed = JSON.stringify(cfg || null) !== JSON.stringify(this.cfg);
    this.cfg = cfg && cfg.url ? cfg : null;
    if (changed && this.wanted) {
      this.stop();
      this.start();
    }
  }

  start() {
    this.wanted = true;
    if (this.ws || !this.cfg) {
      if (!this.cfg) this._set("error", "Music Assistant is not configured (Device tab → Music Assistant).");
      return;
    }
    this._connect();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retry);
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        /* ignore */
      }
    }
    this.ws = null;
    this.status = "idle";
  }

  _set(status, error) {
    this.status = status;
    this.error = error || null;
    this.onChange();
  }

  async _connect() {
    const base = String(this.cfg.url).replace(/\/+$/, "");
    this.baseUrl = base;
    this._set("connecting");
    let token = null;
    if (this.cfg.username) {
      try {
        const res = await httpPostJson(base + "/auth/login", {
          username: this.cfg.username,
          password: this.cfg.password || "",
        });
        if (res.status === 401) throw new Error("Music Assistant rejected the username/password");
        if (res.status !== 200 || !res.json) throw new Error("Music Assistant login failed (HTTP " + res.status + ")");
        token = res.json.access_token || res.json.token;
      } catch (e) {
        this._set("error", e.message || String(e));
        this._retry();
        return;
      }
    }
    const wsUrl = base.replace(/^http/i, "ws") + "/ws";
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      this._set("error", "Bad Music Assistant URL");
      return;
    }
    this.ws = ws;
    let gotInfo = false;
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (!gotInfo && msg.server_id !== undefined) {
        gotInfo = true;
        if (msg.base_url) this.baseUrl = String(msg.base_url).replace(/\/+$/, "");
        this._afterInfo(token);
        return;
      }
      if (msg.message_id && this.pending[msg.message_id]) {
        const p = this.pending[msg.message_id];
        if (msg.partial) {
          p.parts = (p.parts || []).concat(msg.result || []);
          return;
        }
        delete this.pending[msg.message_id];
        if (msg.error_code) p.reject(new Error(msg.details || "MA error " + msg.error_code));
        else p.resolve(p.parts ? p.parts.concat(msg.result || []) : msg.result);
        return;
      }
      if (msg.event) this._onEvent(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const k in this.pending) this.pending[k].reject(new Error("closed"));
      this.pending = {};
      if (this.wanted) {
        this._set("error", this.error || "Disconnected from Music Assistant");
        this._retry();
      }
    };
    ws.onerror = () => {};
  }

  _retry() {
    clearTimeout(this.retry);
    if (!this.wanted) return;
    this.retry = setTimeout(() => {
      if (this.wanted && !this.ws) this._connect();
    }, 8000);
  }

  async _afterInfo(token) {
    try {
      if (token) await this.cmd("auth", { token });
      const players = await this.cmd("players/all");
      this.players = {};
      (players || []).forEach((p) => (this.players[p.player_id] = p));
      this._set("ready");
    } catch (e) {
      this._set("error", e.message || String(e));
      try {
        this.ws.close();
      } catch (e2) {
        /* ignore */
      }
    }
  }

  _onEvent(msg) {
    if (msg.event === "player_added" || msg.event === "player_updated") {
      if (msg.data && msg.data.player_id) this.players[msg.data.player_id] = msg.data;
      this.onChange();
    } else if (msg.event === "player_removed") {
      delete this.players[msg.object_id];
      this.onChange();
    }
  }

  cmd(command, args) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error("not connected"));
        return;
      }
      const id = "p" + this.nextId++;
      this.pending[id] = { resolve, reject };
      this.ws.send(JSON.stringify({ message_id: id, command, args: args || {} }));
      setTimeout(() => {
        if (this.pending[id]) {
          delete this.pending[id];
          reject(new Error("timeout"));
        }
      }, 15000);
    });
  }

  list() {
    const out = [];
    for (const k in this.players) {
      const p = this.players[k];
      if (p.available === false || p.enabled === false || p.hidden) continue;
      out.push(p);
    }
    out.sort((a, b) => String(a.display_name || a.name).localeCompare(String(b.display_name || b.name)));
    return out;
  }

  imageUrl(url) {
    if (!url) return null;
    if (/^https?:/i.test(url) || url.indexOf("data:") === 0) return url;
    return this.baseUrl + (url[0] === "/" ? "" : "/") + url;
  }

  async library() {
    const radios = await this.cmd("music/radios/library_items", { favorite: true, limit: 40 }).catch(() => []);
    const playlists = await this.cmd("music/playlists/library_items", { favorite: true, limit: 40 }).catch(() => []);
    return (radios || []).concat(playlists || []);
  }
}
