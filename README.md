# AR NSPanel Pro

A Home Assistant integration **and panel app** for the Sonoff NSPanel Pro, by
[AR Smart Home](https://arsmarthome.co.za). You lay out pages of buttons, dimmers, switchers,
split buttons, rockers, a clock, weather, cameras, music and an alarm keypad in the Home
Assistant sidebar. The panel shows them and talks to Home Assistant over MQTT.

## What's in the repo

| Path | What |
|---|---|
| `custom_components/ar_nspanel_pro/` | The Home Assistant integration: config flow, MQTT bridge, entities, services, the sidebar editor, and the built panel UI in `www/app/` |
| `panel/` | Source of the panel UI: plain JavaScript, no framework, one ~80 KB bundle. It renders with the same theme kit and icons as the editor's preview, so the glass matches what you designed |
| `android/` | The panel app: a Kotlin WebView kiosk around the panel UI. It adds the backlight, light and proximity sensors, screenshots, volume, boot-on-start and licence verification. No third-party libraries |
| `.github/workflows/panel-app.yml` | Builds the UI and the APK. A `v*` tag attaches the APK to the GitHub Release, where the sidebar's ADB Setup/Update tool picks it up |

## Install

1. **MQTT with WebSockets.** The panel connects to your broker over WebSockets. The Mosquitto
   add-on already listens for WebSockets on port **1884**. Home Assistant's MQTT integration must
   be set up.
2. **Integration (HACS).** HACS → ⋮ → Custom repositories → `https://github.com/marsh4200/ar_nspanel_pro`,
   category **Integration** → install **AR NSPanel Pro** → restart Home Assistant.
3. **Panel app.** Open **AR NSPanel Pro** in the sidebar → **Setup/Update**, enter the panel's IP
   (ADB over network must be enabled on the panel), tap *Allow USB debugging* on the panel, then
   **Install latest**. Optionally **Set as Home** so it replaces the stock launcher.
   (Or sideload: `adb install ar-nspanel-pro-X.Y.Z.apk`.)
4. **Panel setup screen** (opens on first start; later, press and hold the top-left corner for 3 s):
   - Broker: `ws://<home-assistant-ip>:1884`, plus MQTT username and password
   - Panel ID: e.g. `panel-kitchen`
   - Optional *Load UI from*: `http://<ha>:8123/ar_nspanel_pro_static/app/index.html`. The panel
     then takes UI updates straight from the integration, with no new APK needed. It falls back
     to the built-in copy when Home Assistant is down.
5. **Add the panel in Home Assistant.** Settings → Devices & Services → Add Integration →
   AR NSPanel Pro. A panel that is online is discovered automatically; otherwise enter the same
   Panel ID.
6. **Design** the pages in the sidebar editor and save. The panel redraws immediately.

The same UI also runs in any browser (for example
`http://<ha>:8123/ar_nspanel_pro_static/app/index.html`), which is handy for designing and
testing. In a browser, the backlight, sensors, screenshots and licence check aren't available.

## Page types

- **Grid**: button (toggle, push, or multi-state), dimmer, switcher, split, rocker, status dots, optimistic UI
- **Clock**: digital or analog, 12/24 h, localised date, alarm-clock indicator. Also used as the screensaver
- **Weather**: uses the first `weather.*` entity, or set `"weather": {"entity": "weather.home"}` on the page. Shows the current conditions and a 5-day forecast
- **Alarm**: Alarmo keypad over Alarmo's own MQTT topics. When the alarm is armed, the keypad becomes the screensaver; when it triggers, the siren sounds
- **Camera**: live MJPEG from Home Assistant with a PTZ D-pad and camera picker
- **Music**: Music Assistant players, now playing, transport, volume, and favourite radios/playlists

Also: notifications with action buttons (`ar_nspanel_pro.notify`, where `on_press` runs in
Home Assistant), a speaker entity for TTS and `media_player.play_media`, a siren entity, an
alarm clock, a screensaver with day/night auto-brightness, proximity wake, a motion sensor,
remote screenshots, and remote taps.

## Licensing (AR Smart Home licence server)

Each panel has a **Server ID** (16 hex characters), shown in the sidebar under
**Device → Licence** and on the panel's setup screen.

**Requesting from the panel:** tap the watermark. The panel shows its Server ID with optional
site and email fields and a **Request licence** button. Home Assistant posts the request to
`license.arsmarthome.co.za` (the panel never talks to it directly), and while the request sits in
the queue HA re-checks every 30 minutes and installs the key the moment you approve it — the
watermark then disappears on its own. The `ar_nspanel_pro.request_license` service does the same
thing from an automation.

**By hand:** issue a WIQL1 key for product `ar_nspanel_pro` bound to that Server ID and paste it
into the Licence card. The panel verifies the key offline against the AR Smart Home public key (baked into
the app in `Licence.kt`). An unlicensed panel works fully but shows a watermark. The Licence
sensor's `days_remaining` attribute is there to automate renewals.

## Releasing a new panel app

Push a version tag:

```bash
git tag v1.2.5 && git push origin v1.2.5
```

GitHub Actions builds `ar-nspanel-pro-1.2.5.apk`, signs it with the key in
`android/signing/release.jks` (nothing to set up), and attaches it to the release. Every
panel's **Setup/Update → Install latest** then installs it. Keep that key file: updates only
install over the app when they're signed with the same key.

## Development

```bash
npm install --prefix panel
node panel/build.mjs                # → custom_components/ar_nspanel_pro/www/app/
node panel/scripts/extract-kit.mjs  # re-extract the theme kit + icons from the editor bundle
```

The Ed25519/licence code is plain JVM and has an off-device test:
`android/test/gen_vectors.py` + `LicenceTest.kt` (instructions at the top of that file).

## How it works

```
Panel app   ──►  ar-nspanel-pro/panel/{id}/event          (tile pressed → HA runs the binding)
            ──►  ar-nspanel-pro/panel/{id}/sys/*          (awake, light, motion, media, info, licence…)
            ◄──  ar-nspanel-pro/panel/{id}/config/*       (layout, device settings, licence — retained)
            ◄──  ar-nspanel-pro/panel/{id}/state/*        (entity mirror — retained)
            ◄──  ar-nspanel-pro/panel/{id}/cmd/*          (wake, page, notify, media, siren, …)
```

The panel boots from its cache and the retained topics, so it shows the last known UI even
while Home Assistant or the broker is down, and reconnects with exponential backoff. The full
contract is in [PROTOCOL.md](PROTOCOL.md).

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center"><sub>AR Smart Home · for the Sonoff NSPanel Pro · not affiliated with Sonoff/ITEAD
or Home Assistant.</sub></p>
