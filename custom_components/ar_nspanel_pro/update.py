"""Panel app update entity: update the Android app over MQTT, no ADB.

For panels that only have USB debugging (the HDL S10 touch): the app goes on
once over USB (tools/usb-setup), and from then on Home Assistant updates it
from here (Settings → Updates, or ``update.install``). HA tells the panel
which release APK to fetch (``cmd/update``); the panel downloads and installs
it itself and reports progress on ``sys/update``.

Works on every panel with app 4.0.1 or newer, whatever way it was installed.
How quiet the install is comes from the panel (``sys/info.updater``):
``silent`` (device owner / Android 12+ self-installer) or ``prompt`` (someone
taps *Update* on the panel once).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import timedelta
from typing import Any

from homeassistant.components import mqtt
from homeassistant.components.update import UpdateEntity, UpdateEntityFeature
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_time_interval

from . import PanelConfigEntry
from .adb import AdbError, get_adb
from .bridge import PanelBridge
from .const import GITHUB_OWNER, GITHUB_REPO, signal_info, topic_sys
from .entity import ARPanelEntity

_LOGGER = logging.getLogger(__name__)

#: How often the latest GitHub release is looked up (shared by all panels).
_CHECK_EVERY = timedelta(hours=6)
_CACHE_KEY = "ar_nspanel_pro_latest_release"
#: A download + install normally takes well under a minute; "prompt" panels
#: wait for someone to tap Update, so allow a few minutes.
_INSTALL_TIMEOUT = 360.0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: PanelConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([ARAppUpdateEntity(entry.runtime_data)])


async def _latest(hass: HomeAssistant, force: bool = False, legacy: bool = False) -> dict[str, Any] | None:
    """Latest release {url, tag, version, asset} of the standard or the legacy
    (Android 5) APK; cached for every panel."""
    caches = hass.data.setdefault(_CACHE_KEY, {})
    cache = caches.setdefault(
        "legacy" if legacy else "standard", {"ts": 0.0, "data": None, "lock": asyncio.Lock()}
    )
    async with cache["lock"]:
        if not force and cache["data"] and time.monotonic() - cache["ts"] < _CHECK_EVERY.total_seconds() - 60:
            return cache["data"]
        try:
            url, tag, name = await get_adb(hass).async_latest_release(legacy=legacy)
        except AdbError as err:
            _LOGGER.debug("Latest app release lookup failed: %s", err)
            return cache["data"]
        cache["data"] = {
            "url": url,
            "tag": tag,
            "version": tag[1:] if tag.startswith("v") else tag,
            "asset": name,
        }
        cache["ts"] = time.monotonic()
        return cache["data"]


def _norm(v: Any) -> str | None:
    if not v or not isinstance(v, str) or v == "web":
        return None
    return v[1:] if v.startswith("v") else v


class ARAppUpdateEntity(ARPanelEntity, UpdateEntity):
    """The panel's Android app version, installable from Home Assistant."""

    _attr_name = "App"
    _attr_icon = "mdi:cellphone-arrow-down"
    _attr_supported_features = UpdateEntityFeature.INSTALL | UpdateEntityFeature.PROGRESS

    def __init__(self, bridge: PanelBridge) -> None:
        super().__init__(bridge)
        self._attr_unique_id = f"{bridge.device_id}_app_update"
        self._release: dict[str, Any] | None = None
        self._status: dict[str, Any] = {}
        self._installing = False
        self._wait: asyncio.Future[dict[str, Any]] | None = None
        self._target: str | None = None
        #: which APK self._release is for (None = not looked up yet)
        self._release_legacy: bool | None = None

    @property
    def _legacy(self) -> bool:
        """The panel runs the legacy APK (Android 5, bundled Gecko): update it with that one."""
        return self.bridge.sys_info.get("build") == "legacy"

    # --- state ----------------------------------------------------------------

    @property
    def installed_version(self) -> str | None:
        return _norm(self.bridge.sys_info.get("version"))

    @property
    def latest_version(self) -> str | None:
        if self._release:
            return self._release["version"]
        return self.installed_version  # unknown yet: don't claim an update

    @property
    def release_url(self) -> str | None:
        if not self._release:
            return None
        return f"https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}/releases/tag/{self._release['tag']}"

    @property
    def in_progress(self) -> bool:
        return self._installing

    @property
    def update_percentage(self) -> int | None:
        if not self._installing:
            return None
        pct = self._status.get("pct")
        return int(pct) if isinstance(pct, (int, float)) and 0 <= pct <= 100 else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        mode = self.bridge.sys_info.get("updater")
        return {
            # silent | prompt (tap Update on the panel) | none | None = app too old
            "install_mode": mode,
            # standard (system WebView) | legacy (Android 5, bundled engine)
            "app_build": self.bridge.sys_info.get("build") or "standard",
            "last_status": self._status.get("state"),
            "last_message": self._status.get("message"),
        }

    # --- lifecycle -----------------------------------------------------------------

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(self.hass, signal_info(self.bridge.device_id), self._on_info)
        )
        self.async_on_remove(
            await mqtt.async_subscribe(
                self.hass, topic_sys(self.bridge.device_id, "update"), self._on_update_msg
            )
        )
        self.async_on_remove(
            async_track_time_interval(self.hass, self._refresh_cb, _CHECK_EVERY)
        )
        self.hass.async_create_task(self._async_refresh())

    @callback
    def _refresh_cb(self, _now: Any) -> None:
        self.hass.async_create_task(self._async_refresh())

    async def _async_refresh(self, force: bool = False) -> None:
        legacy = self._legacy
        rel = await _latest(self.hass, force, legacy)
        if rel:
            self._release = rel
            self._release_legacy = legacy
            self.async_write_ha_state()

    @callback
    def _on_info(self, data: dict[str, Any]) -> None:
        # the app restarts as the new version after an update: that's success
        if self._wait and not self._wait.done() and self._target and _norm(data.get("version")) == self._target:
            self._wait.set_result({"state": "done"})
        # first sys/info (or a panel moved to the other build): look up its APK
        if self._release_legacy is not None and self._release_legacy != self._legacy:
            self._release_legacy = None
            self.hass.async_create_task(self._async_refresh())
        self.async_write_ha_state()

    @callback
    def _on_update_msg(self, msg: mqtt.ReceiveMessage) -> None:
        try:
            data = json.loads(msg.payload)
        except (ValueError, TypeError):
            return
        if not isinstance(data, dict):
            return
        self._status = data
        if self._wait and not self._wait.done():
            state = data.get("state")
            if state == "error":
                self._wait.set_result(data)
            elif state == "done" and str(data.get("message") or "").startswith("Already up to date"):
                self._wait.set_result(data)
        self.async_write_ha_state()

    # --- install -------------------------------------------------------------------

    async def async_install(self, version: str | None, backup: bool, **kwargs: Any) -> None:
        info = self.bridge.sys_info
        if not self.bridge.available:
            raise HomeAssistantError("The panel is offline.")
        mode = info.get("updater")
        if mode is None:
            raise HomeAssistantError(
                "This panel's app is too old to update itself. Install v4.0.1 or newer "
                "once (USB setup, or Setup/Update in the sidebar); after that it updates from here."
            )
        if mode == "none":
            # Installed from a USB stick: the app may not install apps yet. The
            # panel opens Android's "Install unknown apps" switch for it.
            await self.bridge.async_cmd("update", {"url": "", "permission": True})
            raise HomeAssistantError(
                "The panel isn't allowed to install updates yet. Its 'Install unknown apps' "
                "setting is now open on the panel screen: switch on 'Allow from this source', "
                "then press Install again."
            )
        rel = await _latest(self.hass, force=True, legacy=self._legacy)
        if not rel:
            raise HomeAssistantError("Couldn't find the latest app release on GitHub.")
        if version and _norm(version) != rel["version"]:
            raise HomeAssistantError(f"Only the latest release ({rel['version']}) can be installed.")
        self._release = rel
        self._release_legacy = self._legacy
        self._target = rel["version"]
        self._installing = True
        self._status = {"state": "starting", "pct": 0}
        self.async_write_ha_state()
        loop = asyncio.get_running_loop()
        self._wait = loop.create_future()
        try:
            await self.bridge.async_cmd("update", {"url": rel["url"], "version": rel["version"]})
            try:
                result = await asyncio.wait_for(asyncio.shield(self._wait), _INSTALL_TIMEOUT)
            except asyncio.TimeoutError as err:
                hint = " Was Update tapped on the panel?" if mode == "prompt" else ""
                raise HomeAssistantError(
                    "The panel didn't finish the update in time." + hint
                ) from err
            if result.get("state") == "error":
                raise HomeAssistantError(f"Panel update failed: {result.get('message') or 'unknown error'}")
        finally:
            self._installing = False
            self._wait = None
            self.async_write_ha_state()
