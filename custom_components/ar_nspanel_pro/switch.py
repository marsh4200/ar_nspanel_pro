"""Shelly Wall Display: the built-in relay as a Home Assistant switch.

Only when it is switched on in the panel's Device settings > Built-in relay
(device.shellyRelay.enabled). The panel's app does the switching
(ShellyRelay.kt) and reports back on ``sys/relay``; this entity sends
``cmd/relay`` and shows what the panel reports. With "First light in Lights"
the bridge also puts it first in a room's Lights (bridge.relay_in_lights).
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import PanelConfigEntry
from .bridge import PanelBridge, relay_default_entity_id
from .const import signal_relay
from .entity import ARPanelEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: PanelConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    bridge = entry.runtime_data
    if bridge.relay_enabled:
        async_add_entities([ARRelaySwitch(bridge)])


class ARRelaySwitch(ARPanelEntity, SwitchEntity):
    """The relay on the back of a Shelly Wall Display."""

    _attr_icon = "mdi:lightbulb"

    def __init__(self, bridge: PanelBridge) -> None:
        super().__init__(bridge)
        self._attr_unique_id = f"{bridge.device_id}_relay"
        # fixed id, so the bridge can put it in Lights before it is registered
        self.entity_id = relay_default_entity_id(bridge.device_id)
        sr = bridge.device_cfg.get("shellyRelay") if isinstance(bridge.device_cfg, dict) else {}
        name = sr.get("name") if isinstance(sr, dict) else None
        self._attr_name = name.strip()[:40] if isinstance(name, str) and name.strip() else "Relay"

    @property
    def available(self) -> bool:
        # the panel is online and has reported on the relay; when it can't reach
        # it, the state is unknown and the "error" attribute says why
        return self.bridge.available and bool(self.bridge.relay)

    @property
    def is_on(self) -> bool | None:
        r = self.bridge.relay
        return None if not r or r.get("on") is None else bool(r.get("on"))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        r = self.bridge.relay or {}
        return {
            k: r.get(k)
            for k in ("method", "error", "wall", "watching", "lastInput")
            if r.get(k) is not None
        }

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.bridge.async_cmd("relay", {"on": True})

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.bridge.async_cmd("relay", {"on": False})

    async def async_toggle(self, **kwargs: Any) -> None:
        await self.bridge.async_cmd("relay", {"toggle": True})

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                signal_relay(self.bridge.device_id),
                self._relay_updated,
            )
        )

    @callback
    def _relay_updated(self, _data: dict[str, Any]) -> None:
        self.async_write_ha_state()
