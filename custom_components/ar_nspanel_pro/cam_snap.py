"""Snapshots of the panel's RTSP cameras, made by Home Assistant.

The Cameras page shows every RTSP camera as a still picture that refreshes every
few seconds, and only plays live video for the one camera that is opened. The
panel can't fetch those pictures itself (Hikvision and Dahua want a digest login
an <img> can't send), so Home Assistant does it:

* Hikvision (``…/Streaming/Channels/102``): ``/ISAPI/Streaming/channels/102/picture``
* Dahua (``…/cam/realmonitor?channel=1``): ``/cgi-bin/snapshot.cgi?channel=1``
* a snapshot address typed in the editor (any brand): fetched as given
* anything else: one frame is grabbed from the RTSP stream with ffmpeg

…using the user name and password from the camera's RTSP address (digest, then
basic login). A picture is reused for a few seconds, so several panels looking
at once cost one fetch, and nothing is fetched while nobody is looking.

Served at ``/api/ar_nspanel_pro/snap/<panel id>/<camera number>?k=<key>``: no
Home Assistant login (the panel has none), but a per-panel key that only Home
Assistant and that panel know (it is derived from the config entry id).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

URL_BASE = f"/api/{DOMAIN}/snap"
_DATA = f"{DOMAIN}_snap"
#: a picture younger than this is served again instead of fetching a new one
FRESH = 3.5
#: when a fetch fails, the last picture is still shown for this long
STALE_OK = 60.0
FETCH_TIMEOUT = 8.0
#: at most this many ffmpeg frame grabs at once (they are the heavy kind)
FFMPEG_AT_ONCE = 2


def panel_key(entry_id: str) -> str:
    return hashlib.sha256(f"{entry_id}:{DOMAIN}:snap".encode()).hexdigest()[:24]


def snap_source(cam: dict[str, Any]) -> tuple[str | None, str | None, str | None, str]:
    """(snapshot http url or None for an ffmpeg grab, user, password, rtsp url)."""
    rtsp = str(cam.get("url") or "")
    u = urlsplit(rtsp)
    user = unquote(u.username) if u.username else None
    pw = unquote(u.password) if u.password is not None else None
    explicit = cam.get("snap")
    if isinstance(explicit, str) and re.match(r"^https?://", explicit, re.I):
        e = urlsplit(explicit)
        if e.username:  # credentials written into the snapshot address win
            user, pw = unquote(e.username), unquote(e.password or "")
            netloc = e.hostname + (f":{e.port}" if e.port else "")
            explicit = e._replace(netloc=netloc).geturl()
        return explicit, user, pw, rtsp
    host = u.hostname
    if not host:
        return None, user, pw, rtsp
    m = re.search(r"/streaming/channels/(\d+)", u.path or "", re.I)
    if m:  # Hikvision camera or NVR channel
        return f"http://{host}/ISAPI/Streaming/channels/{m.group(1)}/picture", user, pw, rtsp
    if re.search(r"/cam/realmonitor", u.path or "", re.I):  # Dahua
        ch = (parse_qs(u.query).get("channel") or ["1"])[0]
        return f"http://{host}/cgi-bin/snapshot.cgi?channel={ch}", user, pw, rtsp
    return None, user, pw, rtsp


class _Snaps:
    def __init__(self) -> None:
        self.cache: dict[tuple[str, int], tuple[float, bytes]] = {}
        self.locks: dict[tuple[str, int], asyncio.Lock] = {}
        self.ffmpeg = asyncio.Semaphore(FFMPEG_AT_ONCE)
        self.ffmpeg_ready = False


def _snaps(hass: HomeAssistant) -> _Snaps:
    s = hass.data.get(_DATA)
    if s is None:
        s = hass.data[_DATA] = _Snaps()
    return s


async def fetch_http(hass: HomeAssistant, url: str, user: str | None, pw: str | None) -> bytes:
    import httpx  # Home Assistant ships it
    from homeassistant.helpers.httpx_client import get_async_client

    client = get_async_client(hass, verify_ssl=False)
    auths: list[Any] = [None]
    if user is not None:
        auths = [httpx.DigestAuth(user, pw or ""), httpx.BasicAuth(user, pw or "")]
    last = "no answer"
    for auth in auths:
        r = await client.get(url, auth=auth, timeout=FETCH_TIMEOUT)
        if r.status_code == 200 and r.content[:2] == b"\xff\xd8":
            return r.content
        last = f"HTTP {r.status_code}"
        if r.status_code != 401:
            break
    raise RuntimeError(f"snapshot {last}")


async def fetch_ffmpeg(hass: HomeAssistant, rtsp: str) -> bytes:
    s = _snaps(hass)
    if not s.ffmpeg_ready:
        from homeassistant.setup import async_setup_component

        await async_setup_component(hass, "ffmpeg", {})
        s.ffmpeg_ready = True
    from homeassistant.components.ffmpeg import async_get_image

    async with s.ffmpeg:
        img = await asyncio.wait_for(async_get_image(hass, rtsp, width=640), FETCH_TIMEOUT + 4)
    if not img:
        raise RuntimeError("no frame from the RTSP stream")
    return img


async def async_snapshot(hass: HomeAssistant, key: tuple[str, int], cam: dict[str, Any]) -> bytes | None:
    s = _snaps(hass)
    hit = s.cache.get(key)
    if hit and time.monotonic() - hit[0] < FRESH:
        return hit[1]
    lock = s.locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit = s.cache.get(key)
        if hit and time.monotonic() - hit[0] < FRESH:
            return hit[1]
        url, user, pw, rtsp = snap_source(cam)
        try:
            try:
                img = await fetch_http(hass, url, user, pw) if url else await fetch_ffmpeg(hass, rtsp)
            except Exception as err:  # noqa: BLE001 - the camera's own snapshot failed: grab a frame
                if not url:
                    raise
                _LOGGER.debug("camera snapshot %s failed (%s), grabbing a frame instead", key, err)
                img = await fetch_ffmpeg(hass, rtsp)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("camera snapshot %s failed: %s", key, err)
            if hit and time.monotonic() - hit[0] < STALE_OK:
                return hit[1]
            return None
        s.cache[key] = (time.monotonic(), img)
        return img


def _bridge_for(hass: HomeAssistant, device_id: str) -> Any:
    for entry in hass.config_entries.async_entries(DOMAIN):
        b = getattr(entry, "runtime_data", None)
        if b is not None and getattr(b, "device_id", None) == device_id:
            return b
    return None


def rtsp_list(bridge: Any) -> list[dict[str, Any]]:
    cfg = bridge.device_cfg if isinstance(bridge.device_cfg, dict) else {}
    el = cfg.get("elegant") if isinstance(cfg.get("elegant"), dict) else {}
    lst = el.get("rtsp") if isinstance(el.get("rtsp"), list) else []
    return [c for c in lst if isinstance(c, dict) and isinstance(c.get("url"), str) and c.get("url")]


class SnapView(HomeAssistantView):
    url = URL_BASE + "/{device_id}/{idx}"
    name = f"api:{DOMAIN}:snap"
    requires_auth = False

    async def get(self, request: web.Request, device_id: str, idx: str) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        b = _bridge_for(hass, device_id)
        if b is None or request.query.get("k") != panel_key(b.entry.entry_id) or not idx.isdigit():
            return web.Response(status=404)
        cams = rtsp_list(b)
        i = int(idx)
        if i >= len(cams):
            return web.Response(status=404)
        img = await async_snapshot(hass, (device_id, i), cams[i])
        if img is None:
            return web.Response(status=502, text="camera not answering")
        return web.Response(body=img, content_type="image/jpeg", headers={"Cache-Control": "no-store"})


@callback
def async_setup(hass: HomeAssistant) -> None:
    if hass.data.get(f"{_DATA}_view"):
        return
    hass.http.register_view(SnapView)
    hass.data[f"{_DATA}_view"] = True


def snap_public(cfg: dict[str, Any], base_url: str | None, device_id: str, entry_id: str) -> dict[str, Any]:
    """Tell the panel where its RTSP cameras' snapshots are."""
    el = cfg.get("elegant") if isinstance(cfg.get("elegant"), dict) else None
    if not el or not base_url or not isinstance(el.get("rtsp"), list) or not el["rtsp"]:
        return cfg
    snap = {"url": f"{base_url.rstrip('/')}{URL_BASE}/{device_id}/", "k": panel_key(entry_id)}
    return {**cfg, "elegant": {**el, "snap": snap}}
