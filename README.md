# AR NSPanel Pro

A Home Assistant integration for driving a custom control-panel UI on a
Sonoff NSPanel Pro (or any device running a compatible companion app) over
MQTT — pages of buttons, dimmers, covers, a clock, weather, camera, music and
an alarm keypad, laid out from a visual editor in the Home Assistant sidebar.

This is an independent fork of the MIT-licensed **DomoDreams Panel**
integration (https://github.com/domodreams/home-assistant-nspanel-pro),
rebranded as **AR NSPanel Pro**. See [LICENSE](LICENSE) for what carried over
and what didn't — short version: the integration code is MIT and fully
included here; the original project's proprietary Android app and brand
assets are **not** part of this fork.

## What's included

- `custom_components/ar_nspanel_pro/` — the Home Assistant integration
  (config flow, MQTT bridge, entities, services, websocket API for the sidebar
  editor, and the built sidebar-panel JS bundle).
- A JSON Schema (`panels.schema.json`) describing the panel-layout config
  document, validated on load and from the config-flow.

## What's NOT included (and why)

The upstream project pairs its integration with a closed-source Android
kiosk app ("DomoDreams NSPanel Pro"), plus screenshots/branding — all
explicitly proprietary under the upstream LICENSE, with redistribution and
derivative works disallowed. This fork only rebrands and redistributes the
MIT-licensed integration.

To actually put a UI on your panel's screen, you have two options:

1. **Build your own companion app.** The integration talks a documented MQTT
   protocol (see below) and validates configs against
   `panels.schema.json` — any app that speaks that protocol works. This
   repo doesn't include app source (there wasn't any MIT-licensed app source
   to fork), but the protocol is fully specified here if you want to write
   one (React Native, a web kiosk, ESPHome+LVGL, whatever you like).
2. **Use the original DomoDreams app** under its own license/terms if you'd
   rather not build one, and just want your own branded/customized
   integration behind it.

## Install (HACS)

1. **HACS → ⋮ → Custom repositories** → add your fork's GitHub URL,
   category **Integration**.
2. Install **AR NSPanel Pro**, then restart Home Assistant.
3. **Settings → Devices & Services → Add Integration → AR NSPanel Pro**, and
   add one entry per panel.
4. Open **AR NSPanel Pro** in the HA sidebar to lay out your pages.

> Requires the MQTT integration configured in Home Assistant. Each panel
> connects to the same broker over WebSocket.

## Configure

Everything is edited from the **AR NSPanel Pro** sidebar panel (admin-only) —
pick entities, arrange tiles, choose page types, set the theme, all with a
live preview. Per-panel device settings can also be tweaked on the device
itself, if your companion app exposes that screen.

The layout schema ships with the integration at
[`custom_components/ar_nspanel_pro/panels.schema.json`](custom_components/ar_nspanel_pro/panels.schema.json)
and is validated on both sides, so a panel and its config can never silently
disagree.

## How it works

```
Panel app          ──MQTT──►  ar-nspanel-pro/panel/{device}/event      (button pressed)
                   ◄─MQTT───   ar-nspanel-pro/panel/{device}/config     (layout + bindings, retained)
                   ◄─MQTT───   ar-nspanel-pro/panel/{device}/state/*    (entity state mirror, retained)
                   ◄─MQTT───   ar-nspanel-pro/panel/{device}/cmd/*      (wake, page, reload, …)
```

- The integration owns the HA side end to end: it creates **event
  entities**, executes **service-call bindings**, and mirrors entity
  **state** back to the panel.
- The panel is expected to boot from retained topics + a local cache, so if
  the broker or HA is down it still shows the last-known UI.
- Reconnects should use exponential backoff with jitter; state is always
  reconciled from `state/*`.

## Before you publish this fork

A few placeholders need your own values — grep for them:

- `custom_components/ar_nspanel_pro/manifest.json` — `codeowners`,
  `documentation`, `issue_tracker` (currently `YOUR-GITHUB-USERNAME`).
- `custom_components/ar_nspanel_pro/const.py` — `GITHUB_OWNER`, `GITHUB_REPO`
  (used by the config panel's ADB Setup/Update tool to fetch app releases —
  point these at wherever *you* publish an app, if you build one) and
  `APP_PACKAGE` (the Android `applicationId` of whatever app you install on
  the panel).

## License

MIT for the integration in this repo — see [LICENSE](LICENSE) (it preserves
the required upstream copyright notice, as the MIT license requires).

---

<p align="center"><sub>Forked from DomoDreams Panel · for the Sonoff NSPanel
Pro · not affiliated with Sonoff/ITEAD, Home Assistant, or DomoDreams.</sub></p>
