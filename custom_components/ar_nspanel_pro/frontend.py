"""Sidebar config panel registration.

Serves the built SPA (``www/``) under a static path and registers an admin-only
custom sidebar panel ("NSPanel Pro") that loads it. Done once for the whole
integration (component-level, in ``async_setup``) — independent of how many
panels/config entries exist. Mirrors the old project's pattern, adapted to the
current HA static-path / built-in-panel APIs.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import (
    async_register_built_in_panel,
    async_remove_panel,
)
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

#: URL the SPA bundle + assets are served from.
STATIC_URL = "/ar_nspanel_pro_static"
#: Sidebar panel URL path (visited at ``/ar_nspanel_pro``).
PANEL_URL_PATH = "ar_nspanel_pro"
#: Custom element tag defined by the built bundle (see web/src/main.tsx).
PANEL_ELEMENT = "ar-nspanel-pro-config"
#: Bumped to bust the frontend cache when the bundle changes materially.
PANEL_VERSION = "53"

_WWW_DIR = Path(__file__).parent / "www"
_BUNDLE = "ar-nspanel-pro-config.js"

_REGISTERED_KEY = f"{DOMAIN}_frontend_registered"


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Register the static path + sidebar panel (idempotent)."""
    if hass.data.get(_REGISTERED_KEY):
        return

    if not (_WWW_DIR / _BUNDLE).exists():
        _LOGGER.warning(
            "Config panel bundle missing (%s) — sidebar panel not registered. "
            "Build it with `npm --prefix ha/web run build`.",
            _WWW_DIR / _BUNDLE,
        )
        return

    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL, str(_WWW_DIR), cache_headers=False)]
    )

    async_register_built_in_panel(
        hass,
        component_name="custom",
        sidebar_title="AR NSPanel Pro",
        sidebar_icon="mdi:tablet-dashboard",
        frontend_url_path=PANEL_URL_PATH,
        require_admin=True,
        config={
            "_panel_custom": {
                "name": PANEL_ELEMENT,
                "module_url": f"{STATIC_URL}/{_BUNDLE}?v={PANEL_VERSION}",
                "embed_iframe": False,
                "trust_external": False,
            }
        },
    )
    hass.data[_REGISTERED_KEY] = True
    _LOGGER.info("Registered AR NSPanel Pro config panel at /%s", PANEL_URL_PATH)


def async_unregister_frontend(hass: HomeAssistant) -> None:
    """Remove the sidebar panel (static path stays for the HA lifetime)."""
    if hass.data.pop(_REGISTERED_KEY, None):
        async_remove_panel(hass, PANEL_URL_PATH)
        _LOGGER.debug("Removed AR NSPanel Pro config panel")
