# AR NSPanel Pro — MQTT protocol

This is the contract between the Home Assistant integration (`custom_components/ar_nspanel_pro`)
and the panel app (`panel/` + `android/`). It is written from the integration's code
(`bridge.py`, `services.py`, `media_player.py`, `siren.py`, `notify_payload.py`,
`discovery.py`) and the panel app implements all of it.

**Rule of thumb:** the app owns visuals, the integration owns behaviour. The panel never
calls a Home Assistant service. It reports what was touched and HA runs the bindings.

All topics live under `ar-nspanel-pro/panel/{deviceId}` (below: `~`). `deviceId` is the
panel's id (set on the panel's setup screen, and when you add the panel in HA). `discover`
is reserved. All payloads are JSON unless noted. QoS 0 throughout.

## Panel → Home Assistant

| Topic | Retained | Payload |
|---|---|---|
| `~/avail` | yes | `online` / `offline` (plain text; `offline` is the MQTT last will). HA auto-discovers panels from this topic. |
| `~/event` | no | `{button, action, page, value?, state?}` — see below |
| `~/sys/info` | yes | `{deviceId, model, version, uiVersion, fwVersion, serial, serverId, ip, rssi, uptimeS, freeMemMB, webview}` on connect, every `sysInfoIntervalS` (default 60 s) and on `cmd/info` |
| `~/sys/awake` | yes | `{awake: bool, cause: "touch"\|"proximity"\|"timeout"\|"command"\|"notification"\|"alarm"\|"media"\|"siren"\|"connect", ts}` |
| `~/sys/light` | yes | `{raw: <lux>}` (throttled: on >15 % change or every 60 s) |
| `~/sys/motion` | yes | `{motion: bool}` (proximity presence, cleared after `motion.clearS`) |
| `~/sys/media` | yes | `{state: "idle"\|"playing"\|"paused", url, title, asset, volume 0..1, muted, durationS, positionS, positionTs(ms)}` |
| `~/sys/alarm` | yes | `{enabled, hour, minute}` (the alarm clock) |
| `~/sys/notification` | both | retained state: `{id, status:"shown", title, message, level, priority, ts}` or `{}`; non-retained outcome: `{id, status:"dismissed"\|"expired"\|"action", actionId?, ts}` then retained `{}` |
| `~/sys/license` | yes | `{valid, reason, serial, features, exp, client?, license_id?, product}` (see Licensing) |
| `~/sys/pong` | no | `{id, ts}` reply to `cmd/ping` |
| `~/sys/screenshot` | no | `{id, data: <base64 PNG>, ts}` reply to `cmd/screenshot` |
| `~/sys/discovery` | no | `{deviceId, model, ip, version}` reply to the shared `ar-nspanel-pro/panel/discover` broadcast |

### `event` actions

| Tile | Gesture | Payload |
|---|---|---|
| button, `behavior: toggle` (default) | tap | `{button: tileId, action: "toggle"}` (the bridge aliases `toggle` ↔ `press`; a tile with only `entity` toggles it) |
| button, `behavior: push` | tap | `{action: "press"}` |
| button, `behavior: state` | tap | `{action: "state", value: <next option value>}` → binding `state:<value>` |
| button with `events` | double / long / release | `{action: "double"\|"long"\|"release"}` (only sent when listed in `events`) |
| dimmer | caps, drag | `{action: "dim", value: 0..1}` (0 turns the light off) |
| switcher | tap segment | `{action: "state", value}` |
| split | tap segment | `{button: "<tileId>.<segId>", action: "press", state: "off"\|"on"\|"inset"}` → binding `press:<state>` |
| rocker | tap switch *i* | `{button: "<tileId>.<i>", action: "toggle"}` |
| camera page PTZ | press / hold | `{button: "<pageId>.ptz.<slug(camera)>.<up\|down\|left\|right>", action: "press"}`, repeated every `holdRepeatMs` |
| alarm clock | fires | `{button: "alarm", action: "alarm_fired"}` |

`page` is the id of the page shown when the event happened.

## Home Assistant → Panel

| Topic | Retained | Payload |
|---|---|---|
| `~/config/panels` | yes | the layout document (`panels.schema.json`) |
| `~/config/device` | yes | device settings (below); Music Assistant credentials are stripped |
| `~/config/license` | yes | the licence token as a bare string; empty = revoke |
| `~/state/{key}` | yes | entity mirror; `key` = tile `stateKey` or `slug(entity_id)` (`light.kitchen` → `light_kitchen`) |
| `~/cmd/{name}` | no | commands (below) |
| `ar-nspanel-pro/panel/discover` | no | `{v:1, id}`: every panel replies on its own `sys/discovery` |

### `state/{key}` shapes

- default: `{on: bool}`; lights add `brightness: 0..1` while on
- `input_select` / `select`: `{value: <state>}`
- entities used by status dots or split rules additionally carry `value: <raw state>`
- camera (camera pages): `{on, value, ts, stream: "http://<ha>/api/camera_proxy_stream/<entity>?token=…"}`; the token rotates and the panel keeps a running stream
- weather (weather pages): `{value: <condition>, name, temperature, temperature_unit, humidity, pressure(_unit), wind_speed(_unit), forecast: [{datetime, condition, temperature, templow, precipitation_probability}]}` on `state/weather` (first `weather.*` entity) or on `state/<slug>` when the page sets `weather.entity`

### Commands

| `cmd/…` | Payload | Panel behaviour |
|---|---|---|
| `wake` | `{}` | leave the screensaver, go to the home page |
| `screen` | `{action: "on"\|"off"\|"dim", brightness?: 0..1}` | backlight control |
| `page` | `{index}` \| `{id}` \| `{delta}` | show a page |
| `ping` | `{id}` | reply `sys/pong` |
| `info` | `{}` | republish `sys/info` |
| `screenshot` | `{id}` | reply `sys/screenshot` (Android app only) |
| `touch` | `{x, y, ms?}` | inject a tap at (x, y) in 480×480 space |
| `set_alarm` | `{enabled, hour, minute}` | alarm clock; echoed on `sys/alarm` |
| `play_media` | `{url?, asset?, volume?}` | play a URL, or a built-in sound by name |
| `stop_media` | `{}` | stop |
| `media` | `{action: "play", url, title?}` \| `{action: "resume"\|"pause"\|"stop"}` \| `{action: "volume", volume}` \| `{action: "mute", muted}` | the HA `media_player` entity |
| `siren` | `{on: bool, tone?: "siren"\|"alarmo"\|"alarm_beep"\|"alarm"}` | looping siren |
| `notify` | `{id, title, message, icon, image, level, priority, sound, actions:[{id,label,icon}], timeoutS}` | banner (normal) or full screen (high priority, or any actions); `timeoutS` 0 = until answered, default 60 |
| `notify_clear` | `{id?}` | close it (reported as `dismissed`) |
| `ma_auth` | `{url, username, password}` | Music Assistant credentials (memory only, never retained) |

Built-in sound names (synthesised on the panel): `siren`, `alarmo`, `alarm_beep`, `alarm`, `chime`, `ding`.

## Direct connections (not via the integration)

- **Alarm pages → Alarmo**: subscribe to `stateTopic` (default `alarmo/state`, plain string)
  and `eventTopic` (default `alarmo/event`, JSON `{event: "INVALID_CODE_PROVIDED"…}`); publish
  `{command: "disarm"|"arm_home"|"arm_away", code, area?}` to `commandTopic` (default
  `alarmo/command`). `triggered` sounds the siren and jumps to the alarm page.
- **Music pages → Music Assistant**: `POST {url}/auth/login` → `access_token`, then WebSocket
  `{url}/ws`: first command `auth {token}`, then `players/all`, `players/cmd/*`,
  `player_queues/play_media`; events `player_updated`.

## Device settings used by the app (`config/device`)

`theme`, `defaultPage`, `inactivityTimeout`, `iconSize` (32), `labelFontSize` (19), `labelOffsetY`,
`screensaver {enabled, after, type: clock|dim|black, dimLevel, nightOffAfter, wakeOnProximity, proximity {on, off}}`,
`motion {enabled, on, clearS}`, `autoBrightness {enabled, nightThresholdLux, dayBrightness, nightBrightness, screensaverDropPoints}`,
`clockFace`, `clockFormat24h`, `clockAccent`, `clockAppearance`, `clockLanguage`, `clockDateFontSize`,
`clockPageTheme`, `clockScreensaverTheme` (`custom` | `match-app` | a theme name),
`sysInfoIntervalS`, `musicAssistant {enabled, url}`.

## Licensing

`config/license` carries a WIQL1 key from the AR Smart Home licence server:
`WIQL1.<base64url(payload)>.<base64url(ed25519 signature)>`. The Android app verifies it
offline against the AR public key and checks `product == "ar_nspanel_pro"`,
`server_id == the panel's Server ID` (Android `ANDROID_ID`, 16 hex chars, shown in HA's licence
card and on the panel's setup screen) and `expires_at` (ISO date/time, unix s/ms, or none
for perpetual). `reason` is one of `valid`, `missing`, `malformed`, `bad_signature`,
`serial_mismatch`, `wrong_product`, `expired`, `no_serial`, or `unavailable` (a browser has
no verifier). An unlicensed panel works fully but shows a watermark.
