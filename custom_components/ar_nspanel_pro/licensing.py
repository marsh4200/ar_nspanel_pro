"""Licence activation against the AR Smart Home licence server.

The panel asks (by tapping its watermark), Home Assistant does the talking:
HA posts the panel's Server ID to the licence server, and keeps checking until
the request is approved — so a panel with no internet still gets licensed, and
nobody has to copy a key by hand.

The server auto-issues to Server IDs that are already approved and queues the
rest as pending, so "pending" is the normal first answer: HA retries on a timer
and pushes the key to the panel the moment it is issued.

Endpoint shapes are matched loosely on purpose (the server has used more than
one path, and field names differ between products) — anything that comes back
carrying a ``WIQL1.`` token is accepted as the key.
"""

from __future__ import annotations

import logging
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    LICENSE_ACTIVATION_PATHS,
    LICENSE_PORTAL_URL,
    LICENSE_PRODUCT,
    LICENSE_SERVER_URL,
)

_LOGGER = logging.getLogger(__name__)

#: Response fields that may carry the signed key.
_KEY_FIELDS = ("license_key", "licence_key", "license", "licence", "key", "token", "wiql1")
#: Response fields that may carry a human-readable status.
_STATUS_FIELDS = ("status", "state", "result", "message", "detail")

_TIMEOUT = aiohttp.ClientTimeout(total=20)


def _find_key(data: Any, depth: int = 0) -> str | None:
    """Pull a WIQL1 token out of whatever shape the server answered with."""
    if depth > 4:
        return None
    if isinstance(data, str):
        return data.strip() if data.strip().startswith("WIQL1.") else None
    if isinstance(data, dict):
        for field in _KEY_FIELDS:
            found = _find_key(data.get(field), depth + 1)
            if found:
                return found
        for value in data.values():
            found = _find_key(value, depth + 1)
            if found:
                return found
    if isinstance(data, list):
        for item in data:
            found = _find_key(item, depth + 1)
            if found:
                return found
    return None


def _status_text(data: Any) -> str:
    if isinstance(data, dict):
        for field in _STATUS_FIELDS:
            value = data.get(field)
            if isinstance(value, str) and value:
                return value
    if isinstance(data, str):
        return data
    return ""


async def async_activate(
    hass: HomeAssistant,
    server_id: str,
    *,
    client: str | None = None,
    email: str | None = None,
    version: str | None = None,
) -> dict[str, Any]:
    """Ask the licence server for this panel's key.

    Returns ``{status: issued|pending|error, key?, message}``. ``pending`` means
    the request reached the server and is waiting for approval — the caller
    should try again later rather than treat it as a failure.
    """
    if not server_id:
        return {
            "status": "error",
            "message": "This panel has not reported a Server ID yet (is the app running?).",
        }

    session = async_get_clientsession(hass)
    payload: dict[str, Any] = {
        "server_id": server_id,
        "serverId": server_id,
        "product": LICENSE_PRODUCT,
    }
    if client:
        payload["client"] = client
        payload["client_name"] = client
    if email:
        payload["email"] = email
    if version:
        payload["version"] = version

    last_message = "Could not reach the licence server."
    for path in LICENSE_ACTIVATION_PATHS:
        url = LICENSE_SERVER_URL.rstrip("/") + path
        try:
            async with session.post(url, json=payload, timeout=_TIMEOUT) as resp:
                text = await resp.text()
                try:
                    data = await resp.json(content_type=None)
                except Exception:  # noqa: BLE001 - not JSON; fall back to the text
                    data = text
                if resp.status == 404:
                    last_message = f"{url} → 404"
                    continue  # try the next known path
                key = _find_key(data)
                if key:
                    _LOGGER.info("Licence issued for %s", server_id)
                    return {"status": "issued", "key": key, "message": "Licence issued."}
                status_text = _status_text(data).lower()
                if resp.status in (200, 201, 202) or "pend" in status_text or "await" in status_text:
                    return {
                        "status": "pending",
                        "message": (
                            "Request received — waiting for approval. "
                            f"Approve {server_id} on {LICENSE_PORTAL_URL} and it will arrive here."
                        ),
                    }
                if resp.status in (401, 403):
                    return {
                        "status": "error",
                        "message": _status_text(data) or "The licence server refused this Server ID.",
                    }
                last_message = _status_text(data) or f"HTTP {resp.status} from the licence server."
        except aiohttp.ClientError as err:
            last_message = f"Could not reach the licence server: {err}"
        except Exception as err:  # noqa: BLE001
            last_message = f"Licence request failed: {err}"

    return {"status": "error", "message": last_message}
