"""Nightly panel clock check (Device Setup / Update > Panel time).

Panels at a site without internet can't fetch the time and their clocks drift.
For each panel the installer ticked "Check it every night", Home Assistant sets
the panel's clock (and time zone) over ADB at 03:00.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store

from .adb import AdbError, get_adb
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)
_KEY = f"{DOMAIN}_timesync"


class TimeSync:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.store: Store = Store(hass, 1, f"{DOMAIN}.time_sync")
        self.panels: dict[str, dict[str, Any]] = {}

    async def async_start(self) -> None:
        data = await self.store.async_load() or {}
        self.panels = dict(data.get("panels") or {})
        async_track_time_change(self.hass, self._nightly, hour=3, minute=0, second=0)

    def is_on(self, host: str) -> bool:
        return host in self.panels

    async def async_set(self, host: str, port: int, tz: str | None, on: bool) -> None:
        if on:
            self.panels[host] = {"port": port, "tz": tz}
        else:
            self.panels.pop(host, None)
        await self.store.async_save({"panels": self.panels})

    @callback
    def _nightly(self, _now: Any) -> None:
        self.hass.async_create_task(self._async_run())

    async def _async_run(self) -> None:
        adb = get_adb(self.hass)
        for host, p in list(self.panels.items()):
            try:
                await adb.async_set_time(host, int(p.get("port") or 5555), p.get("tz"), None, None)
                _LOGGER.info("Panel %s: clock set from Home Assistant (nightly)", host)
            except AdbError as err:
                _LOGGER.warning("Panel %s: nightly clock set failed: %s", host, err)
            except Exception:  # noqa: BLE001 - one panel must not stop the rest
                _LOGGER.warning("Panel %s: nightly clock set failed", host, exc_info=True)


def get_timesync(hass: HomeAssistant) -> TimeSync:
    ts = hass.data.get(_KEY)
    if ts is None:
        ts = hass.data[_KEY] = TimeSync(hass)
    return ts


async def async_setup_timesync(hass: HomeAssistant) -> None:
    await get_timesync(hass).async_start()
