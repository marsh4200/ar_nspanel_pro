// Spotify for the Elegant music page, talking to Spotify's Web API directly.
//
// No login on the panel: Home Assistant's own Spotify integration holds the
// account, and the integration hands the panel a short-lived access token on
// request (event button "sp" action "token" -> NON-retained cmd/sp_token). The
// token lives in memory only and is asked for again when it runs out.

const API = "https://api.spotify.com/v1";

export class Spotify {
  constructor(askToken, onChange) {
    this.askToken = askToken; // () => void : publish the token request
    this.onChange = onChange || function () {};
    this.token = null;
    this.exp = 0;
    this.error = null;
    this.waiting = [];
    this.asking = false;
    this.player = null; // GET /me/player
    this.devices = [];
    this.poll = null;
  }

  /** cmd/sp_token from Home Assistant */
  setToken(p) {
    this.asking = false;
    if (p && p.token) {
      this.token = p.token;
      // expires_at is in seconds; refresh a minute early
      this.exp = p.expires_at ? p.expires_at * 1000 - 60000 : Date.now() + 50 * 60000;
      this.error = null;
      this.waiting.splice(0).forEach((w) => w.ok(this.token));
    } else {
      this.error = (p && p.error) || "Spotify isn't available";
      this.waiting.splice(0).forEach((w) => w.fail(new Error(this.error)));
    }
    this.onChange();
  }

  _token(force) {
    if (!force && this.token && Date.now() < this.exp) return Promise.resolve(this.token);
    return new Promise((ok, fail) => {
      this.waiting.push({ ok, fail });
      if (!this.asking) {
        this.asking = true;
        this.askToken();
        setTimeout(() => {
          if (!this.asking) return;
          this.asking = false;
          this.waiting.splice(0).forEach((w) => w.fail(new Error("Home Assistant didn't answer")));
        }, 12000);
      }
    });
  }

  /** api("GET", "/me/player") -> parsed JSON (null for 204) */
  api(method, path, body, retried) {
    return this._token(false).then((tok) =>
      fetch(path.indexOf("http") === 0 ? path : API + path, {
        method: method,
        headers: Object.assign({ Authorization: "Bearer " + tok }, body ? { "Content-Type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined,
      }).then((r) => {
        if (r.status === 401 && !retried) {
          this.token = null;
          return this.api(method, path, body, true);
        }
        if (r.status === 204 || r.status === 202) return null;
        return r.text().then((t) => {
          let j = null;
          try {
            j = t ? JSON.parse(t) : null;
          } catch (e) {
            j = null;
          }
          if (!r.ok) {
            const msg = (j && j.error && (j.error.message || j.error.reason)) || "HTTP " + r.status;
            const err = new Error(msg);
            err.status = r.status;
            err.reason = j && j.error && j.error.reason;
            throw err;
          }
          return j;
        });
      }),
    );
  }

  refresh() {
    return Promise.all([
      this.api("GET", "/me/player").catch(() => null),
      this.api("GET", "/me/player/devices").catch(() => null),
    ]).then((r) => {
      this.player = r[0];
      this.devices = (r[1] && r[1].devices) || this.devices;
      this.onChange();
    });
  }

  /** poll the player while the Spotify screen is open */
  start() {
    if (this.poll) return;
    this.refresh().catch(() => {});
    this.poll = setInterval(() => this.refresh().catch(() => {}), 4000);
  }
  stop() {
    clearInterval(this.poll);
    this.poll = null;
  }

  activeDevice() {
    return this.devices.filter((d) => d.is_active)[0] || (this.player && this.player.device) || null;
  }

  /** play on the active (or given) device: {context_uri, offset} or {uris} */
  play(body, deviceId) {
    const id = deviceId || (this.activeDevice() || {}).id;
    return this.api("PUT", "/me/player/play" + (id ? "?device_id=" + encodeURIComponent(id) : ""), body || undefined).then(() =>
      setTimeout(() => this.refresh().catch(() => {}), 700),
    );
  }
  cmd(method, path) {
    return this.api(method, path).then(() => setTimeout(() => this.refresh().catch(() => {}), 500));
  }
  transfer(deviceId) {
    return this.api("PUT", "/me/player", { device_ids: [deviceId], play: true }).then(() =>
      setTimeout(() => this.refresh().catch(() => {}), 900),
    );
  }
  volume(pct) {
    const d = this.activeDevice();
    if (d) d.volume_percent = pct;
    return this.api("PUT", "/me/player/volume?volume_percent=" + Math.round(pct));
  }
}
