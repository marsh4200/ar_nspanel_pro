"""Residence dashboard style: Watch sources (Control4-style "What would you like to watch?").

Each room can have Watch sources (``device.elegant.rooms[i].rsWatch``)::

    {"id": "netflix", "name": "Netflix", "logo": {"src": "/ar_nspanel_pro_media/…png"},
     "steps": [{"t": "on", "e": "media_player.lounge_tv"},
               {"t": "input", "e": "media_player.lounge_tv", "v": "HDMI 1"},
               {"t": "app", "e": "media_player.apple_tv", "v": "Netflix"},
               {"t": "scene", "e": "scene.movie_night"},
               {"t": "wait", "s": 3},
               {"t": "cmd", "e": "remote.dstv", "v": "power"},
               {"t": "on", "e": "remote.lounge_ir", "v": "power", "offV": "power"},   # IR TV
               {"t": "input", "e": "button.tv_hdmi_1"},                           # a button
               {"t": "on", "e": "button.tv_power_on", "offE": "button.tv_power_off"},
               {"t": "press", "e": "button.soundbar_movie"},
               {"t": "action", "v": "light.turn_on", "e": "light.x", "d": {"brightness_pct": 20}}],
     "remote": {"e": "remote.apple_tv", "kind": "appletv"},
     "player": "media_player.apple_tv", "volume": "media_player.denon"}

Tapping a source on the panel runs its steps here, one after the other, for real
(each Home Assistant call is waited for), and reports every step on the retained
``state/rs_watch`` topic, so the panel ticks them off as they finish. A step that
is already done (the TV is on, the input is already HDMI 1) is skipped, so
changing source only changes what is different. Room Off (or "TV off") switches
off everything the running source switched on.

Only the steps, remote and devices in the saved config are ever acted on: the
panel sends a room number and a source id, never entities or services.

Panel -> HA, on button ``rs``:
    watch_start {room, src}
    watch_key   {room, k: up|down|left|right|ok|back|home|menu|rew|ff|play}
    watch_vol   {room, d: 1|-1}  /  watch_mute {room}
    watch_off   {room}
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from homeassistant.components import mqtt

from .const import DOMAIN, topic_state

_LOGGER = logging.getLogger(__name__)

WATCH_KEY = "rs_watch"
_DATA = f"{DOMAIN}_rs_watch"
STEP_TIMEOUT = 20.0
#: after switching a TV / box on, wait up to this long for it to report "on"
#: before the next step (inputs can't be changed on a TV that is still booting)
BOOT_WAIT = 10.0
MAX_WAIT_STEP = 30.0
OFF_STATES = ("off", "standby", "unavailable", "unknown")

#: remote keys per remote type (remote.send_command)
KEYS: dict[str, dict[str, str]] = {
    "appletv": {"up": "up", "down": "down", "left": "left", "right": "right", "ok": "select", "back": "menu", "home": "home", "menu": "top_menu", "rew": "skip_backward", "ff": "skip_forward", "play": "play_pause"},
    "androidtv": {"up": "DPAD_UP", "down": "DPAD_DOWN", "left": "DPAD_LEFT", "right": "DPAD_RIGHT", "ok": "DPAD_CENTER", "back": "BACK", "home": "HOME", "menu": "MENU", "rew": "MEDIA_REWIND", "ff": "MEDIA_FAST_FORWARD", "play": "MEDIA_PLAY_PAUSE"},
    "roku": {"up": "up", "down": "down", "left": "left", "right": "right", "ok": "select", "back": "back", "home": "home", "menu": "info", "rew": "reverse", "ff": "forward", "play": "play"},
    "ir": {"up": "up", "down": "down", "left": "left", "right": "right", "ok": "ok", "back": "back", "home": "home", "menu": "menu", "rew": "rewind", "ff": "fast_forward", "play": "play_pause"},
}

#: the remote's own integration decides its key names (a remote picked with the
#: type left on the Apple TV default must still get Android keys, etc.)
REMOTE_PLATFORM_KIND: dict[str, str] = {"androidtv_remote": "androidtv", "apple_tv": "appletv", "roku": "roku"}

#: ADB (the Android Debug Bridge integration, media_player.* of platform
#: androidtv) has no remote entity: keys go through androidtv.adb_command as
#: plain Android key codes, which every Android box understands
ADB_KEYS: dict[str, int] = {"up": 19, "down": 20, "left": 21, "right": 22, "ok": 23, "back": 4, "home": 3, "menu": 82, "rew": 89, "ff": 90, "play": 85}


def _platform(hass: Any, e: str) -> str:
    try:
        from homeassistant.helpers import entity_registry as er

        ent = er.async_get(hass).async_get(e)
        return ent.platform if ent else ""
    except Exception:  # noqa: BLE001
        return ""


def is_residence(bridge: Any) -> bool:
    return isinstance(bridge.device_cfg, dict) and bridge.device_cfg.get("dashboardStyle") == "residence"


def _rooms(bridge: Any) -> list[dict[str, Any]]:
    el = bridge.device_cfg.get("elegant") if isinstance(bridge.device_cfg, dict) else None
    rooms = el.get("rooms") if isinstance(el, dict) else None
    return [r for r in rooms if isinstance(r, dict)] if isinstance(rooms, list) else []


def _sources(bridge: Any, room: Any) -> list[dict[str, Any]]:
    rooms = _rooms(bridge)
    if not isinstance(room, int) or not 0 <= room < len(rooms):
        return []
    lst = rooms[room].get("rsWatch")
    return [s for s in lst if isinstance(s, dict) and isinstance(s.get("id"), str)] if isinstance(lst, list) else []


def _source(bridge: Any, room: Any, sid: Any) -> dict[str, Any] | None:
    return next((s for s in _sources(bridge, room) if s.get("id") == sid), None)


def _ent(x: Any) -> str | None:
    return x if isinstance(x, str) and "." in x else None


def _dom(e: str | None) -> str:
    return e.split(".", 1)[0] if e else ""


async def _press(hass: Any, e: str) -> None:
    """button.* and input_button.* are pressed, never turned on / off."""
    await _call(hass, "input_button" if _dom(e) == "input_button" else "button", "press", {"entity_id": e})


class _Watch:
    """What runs / last ran per panel, and which source is on in each room."""

    def __init__(self) -> None:
        self.active: dict[str, dict[str, Any]] = {}  # device_id -> {room: src}
        self.run: dict[str, dict[str, Any]] = {}  # device_id -> current / last run
        self.tasks: dict[str, asyncio.Task] = {}
        #: device_id -> {room: [entities]} everything the room's sources switched on
        #: since the last Room Off (changing source keeps adding to it)
        self.used: dict[str, dict[str, list[str]]] = {}


def _w(hass: Any) -> _Watch:
    w = hass.data.get(_DATA)
    if w is None:
        w = hass.data[_DATA] = _Watch()
    return w


def _name(hass: Any, e: str | None) -> str:
    if not e:
        return ""
    st = hass.states.get(e)
    return (st.attributes.get("friendly_name") if st else None) or e.split(".", 1)[-1].replace("_", " ").title()


def step_label(hass: Any, st: dict[str, Any]) -> list[str]:
    """[what, on what] for the panel's checklist."""
    t, e, v = st.get("t"), _ent(st.get("e")), st.get("v")
    n = _name(hass, e)
    if t == "on":
        return ["Turning on " + n, ""] if _dom(e) not in ("button", "input_button") else ["Pressing " + n, ""]
    if t == "press":
        return ["Pressing " + n, ""]
    if t == "input":
        return ["Switching to " + str(v or n or "?"), n if v else ""]
    if t == "source":
        return ["Source " + str(v or n or "?"), n if v else ""]
    if t == "app":
        return ["Opening " + str(v or n or "?"), n if v else ""]
    if t == "scene":
        return ["Running " + n, ""]
    if t == "wait":
        return ["Waiting " + str(st.get("s") or 0) + " s", ""]
    if t == "cmd":
        return ["Sending " + str(v or "?"), n]
    return [str(st.get("label") or v or "Action"), n]


async def async_publish(bridge: Any) -> None:
    w = _w(bridge.hass)
    payload = {"active": w.active.get(bridge.device_id, {}), "run": w.run.get(bridge.device_id)}
    await mqtt.async_publish(bridge.hass, topic_state(bridge.device_id, WATCH_KEY), json.dumps(payload), retain=True)


async def _call(hass: Any, domain: str, service: str, data: dict[str, Any]) -> None:
    await asyncio.wait_for(hass.services.async_call(domain, service, data, blocking=True), STEP_TIMEOUT)


async def _wait_on(hass: Any, e: str, limit: float = BOOT_WAIT) -> None:
    end = time.monotonic() + limit
    while time.monotonic() < end:
        st = hass.states.get(e)
        if st is not None and st.state not in OFF_STATES:
            return
        await asyncio.sleep(0.5)


async def run_step(hass: Any, st: dict[str, Any]) -> str:
    """Do one step. Returns "done" or "skip" (already so); raises on failure."""
    t, e, v = st.get("t"), _ent(st.get("e")), st.get("v")
    cur = hass.states.get(e) if e else None
    d = _dom(e)
    if t == "press" or (t in ("on", "input", "source", "app") and d in ("button", "input_button")):
        if not e:
            raise ValueError("no button picked")
        await _press(hass, e)
        return "done"
    if t == "on" and d == "remote":
        if isinstance(v, str) and v:
            # an IR / RF remote: send its power command (we can't know whether the TV is on)
            await _call(hass, "remote", "send_command", {"entity_id": e, "command": v})
            return "done"
        if cur is not None and cur.state not in OFF_STATES:
            return "skip"
        await _call(hass, "remote", "turn_on", {"entity_id": e})
        return "done"
    if t in ("input", "source", "app") and d == "remote":
        if not isinstance(v, str) or not v:
            raise ValueError("no command picked")
        await _call(hass, "remote", "send_command", {"entity_id": e, "command": v})
        return "done"
    if t == "on":
        if not e:
            raise ValueError("no device picked")
        if cur is not None and cur.state not in OFF_STATES:
            return "skip"
        await _call(hass, "homeassistant", "turn_on", {"entity_id": e})
        if e.startswith("media_player."):
            await _wait_on(hass, e)
        return "done"
    if t in ("input", "source", "app"):
        if not e or not isinstance(v, str) or not v:
            raise ValueError("no device / input picked")
        if cur is not None and cur.attributes.get("source") == v:
            return "skip"
        if cur is not None and cur.state in OFF_STATES:
            await _call(hass, "homeassistant", "turn_on", {"entity_id": e})
            await _wait_on(hass, e)
        await _call(hass, "media_player", "select_source", {"entity_id": e, "source": v})
        return "done"
    if t == "scene":
        if not e:
            raise ValueError("no scene picked")
        await _call(hass, e.split(".", 1)[0], "turn_on", {"entity_id": e})
        return "done"
    if t == "wait":
        await asyncio.sleep(max(0.0, min(MAX_WAIT_STEP, float(st.get("s") or 0))))
        return "done"
    if t == "cmd":
        if not e or not v:
            raise ValueError("no remote / command picked")
        await _call(hass, "remote", "send_command", {"entity_id": e, "command": v})
        return "done"
    if t == "action":
        if not isinstance(v, str) or "." not in v:
            raise ValueError("no action picked")
        domain, service = v.split(".", 1)
        data = dict(st.get("d")) if isinstance(st.get("d"), dict) else {}
        if e:
            data["entity_id"] = e
        await _call(hass, domain, service, data)
        return "done"
    raise ValueError(f"unknown step {t!r}")


async def _run(bridge: Any, room: int, src: dict[str, Any]) -> None:
    hass = bridge.hass
    w = _w(hass)
    steps = [s for s in src.get("steps") or [] if isinstance(s, dict)]
    run = {
        "id": int(time.time() * 1000),
        "room": room,
        "src": src.get("id"),
        "steps": [step_label(hass, s) for s in steps],
        "state": ["wait"] * len(steps),
        "i": 0,
        "done": False,
        "fails": 0,
    }
    w.run[bridge.device_id] = run
    used = w.used.setdefault(bridge.device_id, {}).setdefault(str(room), [])
    for e in _turned_on(src):
        if e not in used:
            used.append(e)
    await async_publish(bridge)
    for i, st in enumerate(steps):
        run["i"] = i
        run["state"][i] = "go"
        await async_publish(bridge)
        try:
            run["state"][i] = await run_step(hass, st)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001 - one failed step must not stop the rest
            run["state"][i] = "fail"
            run["fails"] += 1
            _LOGGER.warning("watch %s / %s: step %d (%s) failed: %s", bridge.device_id, src.get("id"), i + 1, st.get("t"), err)
    run["done"] = True
    w.active.setdefault(bridge.device_id, {})[str(room)] = src.get("id")
    await async_publish(bridge)


def _turned_on(src: dict[str, Any]) -> list[list[Any]]:
    """What Room Off does, as [how, entity, command] items:
    a media player / switch a step turned on (or changed) is turned off; a remote
    is turned off, or sent its "off" command; a button can't be turned off, so its
    "Room Off presses" button is pressed instead (if one was picked)."""
    out: list[list[Any]] = []

    def add(item: list[Any]) -> None:
        if item not in out:
            out.append(item)

    for st in src.get("steps") or []:
        if not isinstance(st, dict) or st.get("t") not in ("on", "input", "source", "app") or st.get("off", True) is False:
            continue
        e = _ent(st.get("e"))
        d = _dom(e)
        if not e or d in ("scene", "script"):
            continue
        if d in ("button", "input_button"):
            if _ent(st.get("offE")):
                add(["press", st["offE"], None])
        elif d == "remote":
            if st.get("t") != "on":
                continue  # an input sent through a remote: the remote itself stays
            add(["cmd", e, st["offV"]] if isinstance(st.get("offV"), str) and st["offV"] else ["off", e, None])
        else:
            add(["off", e, None])
    for e in (src.get("player"), src.get("volume")):
        if _ent(e) and src.get("offAll"):
            add(["off", e, None])
    return out


async def async_panel_event(bridge: Any, action: str, value: Any) -> bool:
    """button "rs" watch_* actions. True when it was one of ours."""
    if not action.startswith("watch_"):
        return False
    if not is_residence(bridge):
        return True
    hass = bridge.hass
    w = _w(hass)
    v = value if isinstance(value, dict) else {}
    room = v.get("room")
    if action == "watch_start":
        src = _source(bridge, room, v.get("src"))
        if src is None:
            _LOGGER.debug("watch: unknown source %r in room %r", v.get("src"), room)
            return True
        old = w.tasks.pop(bridge.device_id, None)
        if old and not old.done():
            old.cancel()
        w.tasks[bridge.device_id] = hass.async_create_task(_run(bridge, room, src))
        return True
    active = w.active.get(bridge.device_id, {})
    src = _source(bridge, room, active.get(str(room)) or v.get("src"))
    if action == "watch_off":
        task = w.tasks.pop(bridge.device_id, None)
        if task and not task.done():
            task.cancel()
        offs = list(w.used.get(bridge.device_id, {}).pop(str(room), []))
        if src is not None:
            offs += [x for x in _turned_on(src) if x not in offs]
        for how, e, cmd in offs:
            try:
                if how == "press":
                    await _press(hass, e)
                elif how == "cmd":
                    await _call(hass, "remote", "send_command", {"entity_id": e, "command": cmd})
                else:
                    await _call(hass, "homeassistant", "turn_off", {"entity_id": e})
            except Exception:  # noqa: BLE001
                _LOGGER.warning("watch: couldn't switch %s off", e, exc_info=True)
        active.pop(str(room), None)
        run = w.run.get(bridge.device_id)
        if run and run.get("room") == room:
            w.run[bridge.device_id] = None
        await async_publish(bridge)
        return True
    if src is None:
        return True
    try:
        if action == "watch_key":
            k = v.get("k")
            rem = src.get("remote") if isinstance(src.get("remote"), dict) else {}
            re_ = _ent(rem.get("e"))
            kind = REMOTE_PLATFORM_KIND.get(_platform(hass, re_), "") if re_ else ""
            kind = kind or str(rem.get("kind") or "appletv")
            cmd = KEYS.get(kind, KEYS["appletv"]).get(k) if isinstance(k, str) else None
            custom = rem.get("keys") if isinstance(rem.get("keys"), dict) else {}
            cmd = custom.get(k) or cmd
            player = _ent(src.get("player"))
            if re_ and _dom(re_) == "media_player":
                # ADB box: Android key codes over adb (a custom key may be any adb shell command)
                code = custom.get(k) or (("input keyevent %d" % ADB_KEYS[k]) if k in ADB_KEYS else None)
                if code:
                    await _call(hass, "androidtv", "adb_command", {"entity_id": re_, "command": code})
            elif k == "play" and player and not re_:
                await _call(hass, "media_player", "media_play_pause", {"entity_id": player})
            elif re_ and cmd:
                await _call(hass, "remote", "send_command", {"entity_id": re_, "command": cmd})
            elif player and k in ("rew", "ff"):
                await _call(hass, "media_player", "media_previous_track" if k == "rew" else "media_next_track", {"entity_id": player})
        elif action == "watch_vol":
            e = _ent(src.get("volume")) or _ent(src.get("player"))
            if e:
                await _call(hass, "media_player", "volume_up" if v.get("d", 1) > 0 else "volume_down", {"entity_id": e})
        elif action == "watch_mute":
            e = _ent(src.get("volume")) or _ent(src.get("player"))
            st = hass.states.get(e) if e else None
            if e:
                await _call(hass, "media_player", "volume_mute", {"entity_id": e, "is_volume_muted": not bool(st and st.attributes.get("is_volume_muted"))})
    except Exception:  # noqa: BLE001
        _LOGGER.warning("watch %s failed", action, exc_info=True)
    return True


async def async_attach(bridge: Any) -> None:
    if is_residence(bridge):
        await async_publish(bridge)


def async_detach(bridge: Any) -> None:
    w = bridge.hass.data.get(_DATA)
    if w is None:
        return
    t = w.tasks.pop(bridge.device_id, None)
    if t and not t.done():
        t.cancel()
