"""Residence dashboard style: backgrounds and button icons uploaded in the editor.

The editor prepares each image in the browser (resized, JPEG for photos, PNG
with the background cut away for icons) and sends it here. It is stored in
``<config>/ar_nspanel_pro_media/`` — outside the integration folder, so HACS
updates never remove it — under a name made from its content, and served
without login at ``/ar_nspanel_pro_media/<file>`` (the panel has no Home
Assistant credentials, exactly like ``/ar_nspanel_pro_static``).

Nothing here is used by the other dashboard styles.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant, callback

_LOGGER = logging.getLogger(__name__)

MEDIA_URL = "/ar_nspanel_pro_media"
MEDIA_DIR = "ar_nspanel_pro_media"
#: a 1000 px photo is ~150 KB; this leaves plenty of room without letting the
#: editor fill the disk by accident
MAX_BYTES = 3 * 1024 * 1024
_EXT = {"jpg": b"\xff\xd8\xff", "png": b"\x89PNG\r\n\x1a\n"}
_REGISTERED_KEY = "ar_nspanel_pro_media_registered"


async def async_setup(hass: HomeAssistant) -> None:
    """Create the media folder and serve it (once per Home Assistant run)."""
    if hass.data.get(_REGISTERED_KEY):
        return
    folder = Path(hass.config.path(MEDIA_DIR))
    await hass.async_add_executor_job(lambda: folder.mkdir(parents=True, exist_ok=True))
    await hass.http.async_register_static_paths(
        [StaticPathConfig(MEDIA_URL, str(folder), cache_headers=True)]
    )
    websocket_api.async_register_command(hass, ws_residence_upload)
    hass.data[_REGISTERED_KEY] = True


def _write(folder: Path, name: str, data: bytes) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / name
    if not target.exists():
        target.write_bytes(data)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ar_nspanel_pro/residence_upload",
        vol.Required("ext"): vol.In(list(_EXT)),
        vol.Required("data"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_residence_upload(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Store one image; answer with the URL to save in the Residence settings."""
    try:
        data = base64.b64decode(msg["data"], validate=True)
    except (binascii.Error, ValueError):
        connection.send_error(msg["id"], "invalid_format", "The image could not be read")
        return
    ext = msg["ext"]
    if not data or len(data) > MAX_BYTES:
        connection.send_error(msg["id"], "invalid_format", "The image is empty or larger than 3 MB")
        return
    if not data.startswith(_EXT[ext]):
        connection.send_error(msg["id"], "invalid_format", "Only JPEG and PNG images can be used")
        return
    name = hashlib.sha256(data).hexdigest()[:20] + "." + ext
    folder = Path(hass.config.path(MEDIA_DIR))
    await hass.async_add_executor_job(_write, folder, name, data)
    _LOGGER.debug("residence: stored %s (%d bytes)", name, len(data))
    connection.send_result(msg["id"], {"url": f"{MEDIA_URL}/{name}"})


@callback
def residence_public(cfg: dict[str, Any], base_url: str | None) -> dict[str, Any]:
    """The device config as published to the panel: Residence images are
    addressed from Home Assistant's own URL (the panel may run its bundled
    copy of the UI, which has no Home Assistant origin of its own)."""
    if cfg.get("dashboardStyle") != "residence" or not base_url:
        return cfg
    rs = cfg.get("residence") if isinstance(cfg.get("residence"), dict) else {}
    return {**cfg, "residence": {**rs, "base": base_url.rstrip("/")}}


#: an uploaded button icon this small travels inside the panel's setup itself
INLINE_ICON_MAX = 200 * 1024


async def async_inline_icons(hass: HomeAssistant, cfg: dict[str, Any]) -> dict[str, Any]:
    """Put uploaded Residence button icons into the setup sent to the panel, as
    ``data:`` pictures. The panel then shows them without fetching anything from
    Home Assistant, which a panel running its bundled UI (the HDL S57) can fail
    to do when it can't reach or resolve Home Assistant's address. Photos
    (backgrounds) stay links: they are too big to send this way."""
    if cfg.get("dashboardStyle") != "residence":
        return cfg
    rs = cfg.get("residence") if isinstance(cfg.get("residence"), dict) else {}
    icons = rs.get("icons") if isinstance(rs.get("icons"), dict) else None
    if not icons:
        return cfg
    folder = Path(hass.config.path(MEDIA_DIR))

    def _read(name: str) -> bytes | None:
        p = (folder / name).resolve()
        if p.parent != folder.resolve() or not p.is_file() or p.stat().st_size > INLINE_ICON_MAX:
            return None
        return p.read_bytes()

    out: dict[str, Any] = {}
    for key, ic in icons.items():
        src = ic.get("src") if isinstance(ic, dict) else None
        if isinstance(src, str) and src.startswith(MEDIA_URL + "/"):
            name = src[len(MEDIA_URL) + 1 :]
            data = await hass.async_add_executor_job(_read, name) if name and "/" not in name else None
            if data:
                mime = "image/png" if data.startswith(_EXT["png"]) else "image/jpeg"
                ic = {**ic, "src": f"data:{mime};base64," + base64.b64encode(data).decode()}
        out[key] = ic
    return {**cfg, "residence": {**rs, "icons": out}}
