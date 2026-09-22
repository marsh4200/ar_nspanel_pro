"""Per-panel MQTT bridge (PLAN.md §3.2, §3.4, §3.6).

One :class:`PanelBridge` per config entry / deviceId. It:

* subscribes to exactly this device's topics (never cross-panel — §3.5),
* turns panel ``event`` messages into (a) a binding service call and (b) the
  ``ar_nspanel_pro_event`` HA bus event + per-button ``event`` entity,
* mirrors every bound HA entity's state onto ``state/{key}`` (retained, compact),
* caches ``sys/*`` state and fans it out to the awake / sensor / camera entities
  via per-device dispatcher signals,
* keeps the HA device registry entry's sw/hw version fresh from ``sys/info``,
* owns the command publishers used by the device-targeted services.

Only service calls that come from a VALIDATED binding are ever executed.
"""

from __future__ import annotations

import base64
import json
import logging
import time
import uuid
from datetime import timedelta
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import (
    EventStateChangedData,
    async_call_later,
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.network import NoURLAvailableError, get_url

from . import panel_config, licensing
from .const import (
    LICENSE_RETRY_GIVE_UP,
    LICENSE_RETRY_SCHEDULE,
    CONF_DEVICE_ID,
    DOMAIN,
    EVENT_BUS,
    EVENT_NOTIFICATION,
    EVENT_PONG,
    INTEGRATION_NAME,
    MANUFACTURER,
    PTZ_DIRECTIONS,
    PTZ_SERVICE_BY_DOMAIN,
    base_topic,
    device_id_from_topic,
    ptz_button_id,
    signal_avail,
    signal_awake,
    signal_info,
    signal_light,
    signal_media,
    signal_motion,
    signal_notification,
    signal_screenshot,
    signal_event,
    slugify_entity_id,
    signal_license,
    topic_avail,
    topic_cmd,
    topic_config_device,
    topic_config_license,
    topic_config_panels,
    topic_event,
    topic_state,
    topic_sys,
)

_LOGGER = logging.getLogger(__name__)

#: Entity domains that carry no meaningful on/off or value state to mirror onto
#: a panel tile — pushing scenes/scripts is stateless, so we never publish for
#: them (the tile that triggers them is `behavior: push`).
_STATELESS_DOMAINS = {"scene", "script", "button", "input_button"}
#: Domains mirrored as ``{"value": <state>}`` (state buttons → input_select).
_VALUE_DOMAINS = {"input_select", "select"}
#: State key a weather page reads when it names no entity (first weather.*).
WEATHER_DEFAULT_KEY = "weather"
#: How often daily forecasts are re-fetched for weather pages.
_FORECAST_REFRESH = timedelta(minutes=30)
#: Weather attributes copied onto the mirror payload.
_WEATHER_ATTRS = (
    "temperature",
    "temperature_unit",
    "humidity",
    "pressure",
    "pressure_unit",
    "wind_speed",
    "wind_speed_unit",
    "wind_bearing",
    "visibility",
    "visibility_unit",
)


class PanelBridge:
    """MQTT bridge for a single panel (deviceId)."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.device_id: str = entry.data[CONF_DEVICE_ID]
        self.base = base_topic(self.device_id)

        # parsed config
        self.panels: dict[str, Any] = {}
        self.device_cfg: dict[str, Any] = {}
        self._tiles_by_id: dict[str, dict[str, Any]] = {}
        # split-segment index: "<tileId>.<segId>" -> (tile, segment) (PLAN.md §3.6).
        # Keyed by the EXACT event button id so routing is an unambiguous lookup
        # (no dot-splitting guesswork; split tile/segment ids are dot-free by
        # validation).
        self._split_segments: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
        # entity_id -> set of state keys to publish for it
        self._entity_keys: dict[str, set[str]] = {}
        # entities referenced by a DYNAMIC statusDot binding (PLAN.md §3.6):
        # their mirror payload always carries a generic `value` (raw HA state)
        # so the app can compare any domain (locks, sensors, ...).
        self._value_entities: set[str] = set()
        # camera entities shown on a camera page -> {"baseUrl": str | None}.
        # Their mirror payload carries the live MJPEG URL instead of the plain
        # on/off shape (see _camera_payload).
        self._camera_entities: dict[str, dict[str, Any]] = {}
        # weather entities shown on a weather page. Their payload carries the
        # current conditions + a short daily forecast (see _weather_payload).
        self._weather_entities: set[str] = set()
        #: a weather page without `weather.entity` uses the first weather.*
        #: entity, published on the fixed key WEATHER_DEFAULT_KEY.
        self._weather_auto = False
        self._forecasts: dict[str, list[dict[str, Any]]] = {}
        self._weather_timer: Callable[[], None] | None = None
        self._started_unsub: Callable[[], None] | None = None

        # cached sys state (read by entities on add)
        self.available: bool = False
        self.sys_info: dict[str, Any] = {}
        self.awake: dict[str, Any] | None = None
        self.light_raw: int | None = None
        self.motion: bool | None = None
        self.alarm: dict[str, Any] = {}
        self.media: dict[str, Any] = {}
        self.notification: dict[str, Any] = {}
        #: The first ``sys/notification`` we see is the RETAINED snapshot — state,
        #: not news. Firing a bus event for it would re-run the automation that
        #: answered it, every time HA restarts.
        self._notification_seeded = False
        self._notification_key: tuple[Any, ...] | None = None
        #: notification id → {action id: binding(s)} for `on_press`. In memory
        #: only: a notification is a question asked of whoever is in the room
        #: right now, so an HA restart forgetting it is correct, not a bug.
        self._notify_on_press: dict[str, dict[str, Any]] = {}
        self.screenshot_png: bytes | None = None
        self.screenshot_ts: float | None = None
        #: Pending licence request (set while the licence server has it queued).
        self._license_retry: Callable[[], None] | None = None
        #: When the queued request was first sent — drives the escalating poll.
        self._license_retry_since: float | None = None
        self._license_req: dict[str, Any] = {}
        #: Last `sys/license` payload — what the panel's own verifier concluded.
        #: Advisory: shown in the GUI and a diagnostic sensor, never enforced on.
        self.license: dict[str, Any] = {}

        self._unsubs: list[Callable[[], None]] = []
        self._state_unsub: Callable[[], None] | None = None
        self._pending_pings: dict[str, float] = {}
        self._reg_device_id: str | None = None

    # --- lifecycle -----------------------------------------------------------

    async def async_setup(self) -> None:
        """Load config, register the device, subscribe, seed the state mirror."""
        self.panels = await panel_config.async_load_or_seed(self.hass, self.device_id)
        self.device_cfg = await panel_config.async_load_or_seed_device(
            self.hass, self.device_id
        )
        self._index_config()
        self._resolve_auto_weather()
        self._register_device()

        base = self.base
        subs = [
            (topic_avail(self.device_id), self._on_avail),
            (topic_event(self.device_id), self._on_event),
            (topic_sys(self.device_id, "awake"), self._on_awake),
            (topic_sys(self.device_id, "info"), self._on_info),
            (topic_sys(self.device_id, "light"), self._on_light),
            (topic_sys(self.device_id, "motion"), self._on_motion),
            (topic_sys(self.device_id, "alarm"), self._on_alarm),
            (topic_sys(self.device_id, "media"), self._on_media),
            (topic_sys(self.device_id, "notification"), self._on_notification),
            (topic_sys(self.device_id, "pong"), self._on_pong),
            (topic_sys(self.device_id, "screenshot"), self._on_screenshot),
            (topic_sys(self.device_id, "license"), self._on_license),
            (topic_sys(self.device_id, "license_request"), self._on_license_request),
        ]
        for topic, cb in subs:
            self._unsubs.append(await mqtt.async_subscribe(self.hass, topic, cb))
        _LOGGER.debug("Bridge %s subscribed under %s", self.device_id, base)

        # Track every bound entity and publish its current state now so a fresh
        # panel gets an accurate mirror immediately.
        self._start_state_tracking()
        await self._publish_all_states()
        self._start_weather()

    async def async_unload(self) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        if self._state_unsub:
            self._state_unsub()
            self._state_unsub = None
        if self._weather_timer:
            self._weather_timer()
            self._weather_timer = None
        self._stop_license_retry()
        if self._started_unsub:
            self._started_unsub()
            self._started_unsub = None

    # --- config indexing -----------------------------------------------------

    def _index_config(self) -> None:
        """Build the button→tile map and the entity→stateKeys mirror map.

        Walks tiles (grid pages) AND camera pages — a camera page carries no
        tiles, so its entities and PTZ arrows are indexed separately.
        """
        self._tiles_by_id = {}
        self._split_segments = {}
        self._entity_keys = {}
        self._value_entities = set()
        self._camera_entities = {}
        self._weather_entities = set()
        self._weather_auto = False
        for page in self.panels.get("pages", []):
            if page.get("type") == "camera":
                self._index_camera_page(page)
            if page.get("type") == "weather":
                wcfg = page.get("weather") if isinstance(page.get("weather"), dict) else {}
                went = wcfg.get("entity")
                if isinstance(went, str) and went.startswith("weather."):
                    self._weather_entities.add(went)
                    self._entity_keys.setdefault(went, set()).add(slugify_entity_id(went))
                else:
                    self._weather_auto = True
            for tile in page.get("tiles", []) or []:
                tid = tile.get("id")
                if isinstance(tid, str):
                    self._tiles_by_id[tid] = tile

                # dynamic statusDot → mirror its entity too, with generic value
                dot = tile.get("statusDot")
                if isinstance(dot, dict):
                    dot_entity = dot.get("entity")
                    if isinstance(dot_entity, str) and dot_entity:
                        # no _STATELESS_DOMAINS skip here: ANY domain is
                        # comparable for a dot (spec: locks, sensors, ...)
                        self._mirror_value_entity(dot_entity)

                # split tiles: index every segment by "<tileId>.<segId>" and
                # mirror the entities its state rules reference (PLAN.md §3.6).
                if tile.get("type") == "split" and isinstance(tid, str):
                    self._index_split_tile(tid, tile)

                # rocker tiles: a vertical stack of 1-2 on/off switches, each its
                # own entity. Index like split segments — one synthetic toggle
                # tile per switch, keyed "<tileId>.<index>", and mirror each
                # entity so the panel reflects on/off.
                if tile.get("type") == "rocker" and isinstance(tid, str):
                    self._index_rocker_tile(tid, tile)

                entity = tile.get("entity")
                if not isinstance(entity, str) or not entity:
                    continue
                domain = entity.split(".", 1)[0]
                if domain in _STATELESS_DOMAINS:
                    continue  # push scenes/scripts have no state to mirror
                key = tile.get("stateKey") or slugify_entity_id(entity)
                self._entity_keys.setdefault(entity, set()).add(key)

    def _index_rocker_tile(self, tile_id: str, tile: dict[str, Any]) -> None:
        """Register a rocker stack's switches (1-2). Each is on/off BY DEFINITION,
        so each gets a SYNTHETIC toggle tile keyed "<tileId>.<index>" (carrying its
        own entity) that the existing binding executor toggles — no configurable
        actions — and its entity joins the state mirror so the panel shows on/off.
        """
        # Backward compat: a legacy single-entity rocker becomes a stack of one.
        rockers = tile.get("rockers")
        if not rockers and tile.get("entity"):
            rockers = [{"entity": tile["entity"], "icon": tile.get("icon"), "label": tile.get("label")}]
        for i, rk in enumerate(rockers or []):
            if not isinstance(rk, dict):
                continue
            entity = rk.get("entity")
            if not isinstance(entity, str) or not entity:
                continue
            bid = f"{tile_id}.{i}"
            # Synthetic tile: a bare `toggle` on this switch's entity. Reuses the
            # ordinary executor + _implicit_binding (bare toggle → toggle entity).
            self._tiles_by_id[bid] = {"id": bid, "entity": entity}
            domain = entity.split(".", 1)[0]
            if domain not in _STATELESS_DOMAINS:
                self._entity_keys.setdefault(entity, set()).add(
                    slugify_entity_id(entity)
                )

    def _index_split_tile(self, tile_id: str, tile: dict[str, Any]) -> None:
        """Register each split segment and mirror its state-rule entities.

        The segment default source (``state.entity``) and any per-rule
        overrides (``state.on.entity`` / ``state.inset.entity``) join the
        mirrored set with a generic ``value`` — same treatment as a dynamic
        statusDot entity — so the app can evaluate the operator rules on-device
        for any domain (PLAN.md §3.6).
        """
        for seg in tile.get("buttons") or []:
            if not isinstance(seg, dict):
                continue
            seg_id = seg.get("id")
            if not isinstance(seg_id, str) or not seg_id:
                continue
            self._split_segments[f"{tile_id}.{seg_id}"] = (tile, seg)

            state = seg.get("state")
            if not isinstance(state, dict):
                continue
            default_entity = state.get("entity")
            if isinstance(default_entity, str) and default_entity:
                self._mirror_value_entity(default_entity)
            for rule_key in ("on", "inset"):
                rule = state.get(rule_key)
                if isinstance(rule, dict):
                    rule_entity = rule.get("entity")
                    if isinstance(rule_entity, str) and rule_entity:
                        self._mirror_value_entity(rule_entity)

    def _mirror_value_entity(self, entity_id: str) -> None:
        """Mirror ``entity_id`` on ``state/{slug}`` with a generic ``value``
        (raw HA state) so app-side operator comparisons work for any domain."""
        self._value_entities.add(entity_id)
        self._entity_keys.setdefault(entity_id, set()).add(
            slugify_entity_id(entity_id)
        )

    def _index_camera_page(self, page: dict[str, Any]) -> None:
        """Index a camera page: it has no tiles, so nothing else would see it.

        Two things happen here:

        1. Each camera entity joins the state mirror. Its payload is special
           (:meth:`_camera_payload`) — it carries the live MJPEG URL including
           HA's rotating access token, so the panel needs no HA credentials.
        2. Each configured PTZ direction is registered as a SYNTHETIC tile keyed
           by its event button id. ``_execute_binding`` looks any incoming button
           up in ``_tiles_by_id`` and runs its ``bindings`` — it neither knows nor
           cares that no such tile exists in the document. So PTZ reuses the whole
           validated binding executor (multi-action, error isolation, bus event)
           without a single line of new execution code.
        """
        cfg = page.get("camera")
        if not isinstance(cfg, dict):
            return
        page_id = page.get("id")
        if not isinstance(page_id, str) or not page_id:
            return
        base_url = cfg.get("baseUrl") if isinstance(cfg.get("baseUrl"), str) else None
        for cam in cfg.get("cameras") or []:
            if not isinstance(cam, dict):
                continue
            entity = cam.get("entity")
            if not isinstance(entity, str) or not entity:
                continue
            self._camera_entities[entity] = {"baseUrl": base_url}
            self._entity_keys.setdefault(entity, set()).add(
                slugify_entity_id(entity)
            )

            ptz = cam.get("ptz")
            if not isinstance(ptz, dict):
                continue
            for direction in PTZ_DIRECTIONS:
                binding = _normalise_ptz_target(ptz.get(direction))
                if binding is None:
                    continue
                bid = ptz_button_id(page_id, entity, direction)
                self._tiles_by_id[bid] = {"id": bid, "bindings": {"press": binding}}

    # --- weather pages -------------------------------------------------------

    @callback
    def _resolve_auto_weather(self) -> bool:
        """Bind WEATHER_DEFAULT_KEY to the first weather entity, if needed.

        Returns True when an entity was (newly) bound. Weather integrations may
        load after this one, so an unresolved default is retried once Home
        Assistant has started.
        """
        if not self._weather_auto:
            return False
        for entity_id, keys in self._entity_keys.items():
            if WEATHER_DEFAULT_KEY in keys:
                return False  # already bound
        candidates = sorted(self.hass.states.async_entity_ids("weather"))
        if not candidates:
            if not self.hass.is_running and self._started_unsub is None:
                self._started_unsub = self.hass.bus.async_listen_once(
                    EVENT_HOMEASSISTANT_STARTED, self._on_ha_started
                )
            return False
        entity_id = candidates[0]
        self._weather_entities.add(entity_id)
        self._entity_keys.setdefault(entity_id, set()).add(WEATHER_DEFAULT_KEY)
        return True

    @callback
    def _on_ha_started(self, _event: Event) -> None:
        self._started_unsub = None  # fired: a once-listener removes itself
        if self._resolve_auto_weather():
            if self._state_unsub:
                self._state_unsub()
                self._state_unsub = None
            self._start_state_tracking()
            self.hass.async_create_task(self._publish_all_states())
            self._start_weather()

    @callback
    def _start_weather(self) -> None:
        """Fetch forecasts now and every _FORECAST_REFRESH."""
        if not self._weather_entities:
            return
        if self._weather_timer is None:
            self._weather_timer = async_track_time_interval(
                self.hass, self._refresh_forecasts_cb, _FORECAST_REFRESH
            )
        self.hass.async_create_task(self._async_refresh_forecasts())

    @callback
    def _refresh_forecasts_cb(self, _now: Any) -> None:
        self.hass.async_create_task(self._async_refresh_forecasts())

    async def _async_refresh_forecasts(self) -> None:
        for entity_id in list(self._weather_entities):
            forecast: list[dict[str, Any]] = []
            for kind in ("daily", "twice_daily", "hourly"):
                try:
                    resp = await self.hass.services.async_call(
                        "weather",
                        "get_forecasts",
                        {"entity_id": entity_id, "type": kind},
                        blocking=True,
                        return_response=True,
                    )
                except Exception:  # noqa: BLE001 - unsupported type / not loaded
                    continue
                items = ((resp or {}).get(entity_id) or {}).get("forecast") or []
                if items:
                    forecast = [
                        {
                            k: f.get(k)
                            for k in ("datetime", "condition", "temperature", "templow", "precipitation_probability")
                            if f.get(k) is not None
                        }
                        for f in items
                        if isinstance(f, dict)
                    ][: 10 if kind != "daily" else 5]
                    break
            self._forecasts[entity_id] = forecast
            self._publish_entity(entity_id, self.hass.states.get(entity_id))

    def _weather_payload(self, entity_id: str, state: Any) -> dict[str, Any]:
        """Mirror payload for a weather page: conditions + short forecast."""
        if state is None or state.state in ("unavailable", "unknown"):
            return {"value": None}
        payload: dict[str, Any] = {
            "value": state.state,
            "name": state.attributes.get("friendly_name") or entity_id,
        }
        for attr in _WEATHER_ATTRS:
            val = state.attributes.get(attr)
            if val is not None:
                payload[attr] = val
        forecast = self._forecasts.get(entity_id)
        if forecast:
            payload["forecast"] = forecast
        return payload

    def _register_device(self) -> None:
        reg = dr.async_get(self.hass)
        info = self.sys_info
        device = reg.async_get_or_create(
            config_entry_id=self.entry.entry_id,
            identifiers={(DOMAIN, self.device_id)},
            manufacturer=MANUFACTURER,
            name=self.entry.title or self.device_id,
            model=info.get("model") or INTEGRATION_NAME,
            sw_version=info.get("version"),
            hw_version=info.get("fwVersion"),
            serial_number=info.get("serial"),
            configuration_url=None,
        )
        self._reg_device_id = device.id

    @property
    def ha_device_id(self) -> str | None:
        """This panel's DEVICE REGISTRY id — what a service call targets.

        Not the same thing as ``device_id`` (the panel's own MQTT identity), and
        the config UI needs it to show a copyable service-call example.
        """
        return self._reg_device_id

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self.device_id)},
            manufacturer=MANUFACTURER,
            name=self.entry.title or self.device_id,
        )

    # --- MQTT inbound handlers ----------------------------------------------

    @callback
    def _on_avail(self, msg: mqtt.ReceiveMessage) -> None:
        was_available = self.available
        self.available = msg.payload == "online"
        async_dispatcher_send(self.hass, signal_avail(self.device_id), self.available)
        # A panel that just came up has no Music Assistant credentials: they
        # travel on a NON-retained topic, so anything sent while it was offline
        # is gone. Re-push on every online transition.
        if self.available and not was_available:
            self.hass.async_create_task(self._async_push_ma_auth())

    async def _async_push_ma_auth(self) -> None:
        """Send the MA credentials to a panel that just came online."""
        try:
            device_cfg = await panel_config.async_read_device(self.hass, self.device_id)
        except Exception:  # noqa: BLE001 - a missing/broken file must not break avail
            return
        _, ma_secrets = _split_ma_secrets(device_cfg)
        if ma_secrets:
            await self.async_cmd("ma_auth", ma_secrets)

    @callback
    def _on_awake(self, msg: mqtt.ReceiveMessage) -> None:
        data = _parse(msg.payload)
        self.awake = data
        async_dispatcher_send(self.hass, signal_awake(self.device_id), data)

    @callback
    def _on_info(self, msg: mqtt.ReceiveMessage) -> None:
        data = _parse(msg.payload)
        if not data:
            return
        self.sys_info = data
        # keep the device registry entry current
        if self._reg_device_id:
            updates: dict[str, Any] = {
                "model": data.get("model") or INTEGRATION_NAME,
                "sw_version": data.get("version"),
                "hw_version": data.get("fwVersion"),
            }
            # Only when the panel actually reported one: an older app build
            # doesn't send `serial` at all, and passing None would clear a
            # serial the registry already holds.
            if data.get("serial"):
                updates["serial_number"] = data["serial"]
            dr.async_get(self.hass).async_update_device(self._reg_device_id, **updates)
        async_dispatcher_send(self.hass, signal_info(self.device_id), data)

    @callback
    def _on_license(self, msg: mqtt.ReceiveMessage) -> None:
        """Licence verdict reported by the panel's native verifier.

        Display only. The panel does not ask permission to be licensed and HA
        cannot grant it: this is the panel telling us what its own verifier
        concluded, so a tampered app could report anything here and still be
        watermarked on the glass. Never gate anything on it.
        """
        data = _parse(msg.payload)
        self.license = data
        if data.get("valid"):
            self._stop_license_retry()  # nothing left to wait for
        async_dispatcher_send(self.hass, signal_license(self.device_id), data)

    @callback
    def _on_license_request(self, msg: mqtt.ReceiveMessage) -> None:
        """The panel asked for a licence (its watermark was tapped).

        The panel never talks to the licence server itself: it has no
        credentials, may have no internet, and is asleep half the time. It asks
        here, Home Assistant does the round trip and pushes the key back.
        """
        data = _parse(msg.payload)
        if data.get("action") == "cancel":
            self._stop_license_retry()
            self.hass.async_create_task(
                self.async_cmd("license_status", {"status": "idle", "message": ""})
            )
            return
        self._license_req = {
            "client": data.get("client") or "",
            "email": data.get("email") or "",
        }
        self.hass.async_create_task(self.async_request_license(**self._license_req))

    async def async_request_license(
        self, client: str | None = None, email: str | None = None
    ) -> dict[str, Any]:
        """Ask the licence server for this panel's key; retry while pending."""
        server_id = self.license.get("serial") or self.sys_info.get("serial")
        await self.async_cmd(
            "license_status", {"status": "sending", "message": "Contacting the licence server…"}
        )
        result = await licensing.async_activate(
            self.hass,
            str(server_id or ""),
            client=client or self._license_req.get("client"),
            email=email or self._license_req.get("email"),
            version=self.sys_info.get("version"),
        )
        if result["status"] == "issued":
            self._stop_license_retry()
            await self.async_store_license(result["key"])
            await self.async_cmd(
                "license_status", {"status": "issued", "message": "Licence installed."}
            )
        else:
            if result["status"] == "pending":
                self._start_license_retry()
            await self.async_cmd(
                "license_status",
                {"status": result["status"], "message": result.get("message") or ""},
            )
        return result

    @callback
    def _start_license_retry(self) -> None:
        """Begin (or continue) polling a queued request.

        The poll escalates: hard for the first ten minutes, because approval
        normally happens while the request is in front of you and the panel
        should light up within seconds of it, then slower so a request left
        overnight is a heartbeat rather than a hammer.
        """
        if self._license_retry_since is None:
            self._license_retry_since = time.monotonic()
        self._schedule_license_retry()

    @callback
    def _schedule_license_retry(self) -> None:
        if self._license_retry is not None:  # one timer in flight at a time
            return
        elapsed = time.monotonic() - (self._license_retry_since or time.monotonic())
        if elapsed >= LICENSE_RETRY_GIVE_UP:
            _LOGGER.info(
                "Licence request for %s is still unapproved after %.0f h — giving up "
                "(press Request licence again to retry)",
                self.device_id,
                elapsed / 3600,
            )
            self._stop_license_retry()
            return
        delay = LICENSE_RETRY_SCHEDULE[-1][1]
        for within, every in LICENSE_RETRY_SCHEDULE:
            if elapsed < within:
                delay = every
                break
        self._license_retry = async_call_later(
            self.hass, delay, self._license_retry_cb
        )

    @callback
    def _stop_license_retry(self) -> None:
        if self._license_retry:
            self._license_retry()
            self._license_retry = None
        self._license_retry_since = None

    @callback
    def _license_retry_cb(self, _now: Any) -> None:
        # async_call_later is one-shot: it has already fired, so drop the handle
        # before re-arming or the next schedule would be skipped as "in flight".
        self._license_retry = None
        if self.license.get("valid"):
            self._stop_license_retry()
            return
        self.hass.async_create_task(self.async_request_license())

    async def async_store_license(self, jwt: str) -> None:
        """Keep the key with the panel's device config and publish it."""
        try:
            device_cfg = await panel_config.async_read_device(self.hass, self.device_id)
            if jwt:
                device_cfg["license"] = jwt
            else:
                device_cfg.pop("license", None)
            await panel_config.async_write_device(self.hass, self.device_id, device_cfg)
        except Exception:  # noqa: BLE001 - publishing still matters if the file fails
            _LOGGER.exception("could not store the licence for %s", self.device_id)
        await self.async_publish_license(jwt)

    @callback
    def _on_light(self, msg: mqtt.ReceiveMessage) -> None:
        data = _parse(msg.payload)
        raw = data.get("raw")
        if isinstance(raw, (int, float)):
            self.light_raw = int(raw)
            async_dispatcher_send(
                self.hass, signal_light(self.device_id), self.light_raw
            )

    @callback
    def _on_motion(self, msg: mqtt.ReceiveMessage) -> None:
        data = _parse(msg.payload)
        self.motion = bool(data.get("motion"))
        async_dispatcher_send(self.hass, signal_motion(self.device_id), self.motion)

    @callback
    def _on_alarm(self, msg: mqtt.ReceiveMessage) -> None:
        self.alarm = _parse(msg.payload)
        # surfaced via the info signal consumers if needed; alarm has no
        # dedicated entity in v1 (settable via the set_alarm service).

    @callback
    def _on_media(self, msg: mqtt.ReceiveMessage) -> None:
        """Retained playback state from the panel → the ``media_player`` entity."""
        self.media = _parse(msg.payload)
        async_dispatcher_send(self.hass, signal_media(self.device_id), self.media)

    @callback
    def _on_notification(self, msg: mqtt.ReceiveMessage) -> None:
        """What the panel is showing, and how each notification ended.

        The topic carries both: a RETAINED payload for the current notification
        (``status: shown``, or ``{}`` for none) and a transient one for the
        outcome (``dismissed`` / ``expired`` / ``action`` + which button). Only
        the retained shape is kept as state; both fire the bus event that
        automations listen to.
        """
        data = _parse(msg.payload)
        status = data.get("status")

        # `{}` and `shown` are the two state shapes; an outcome is news about a
        # notification that is already gone, so it must not become the state.
        if not status or status == "shown":
            self.notification = data
            async_dispatcher_send(
                self.hass, signal_notification(self.device_id), self.notification
            )

        if not status:
            self._notification_seeded = True
            return

        key = (data.get("id"), status, data.get("actionId"), data.get("ts"))
        fresh = self._notification_seeded and key != self._notification_key
        if fresh:
            self._run_notification_on_press(data, status)
        if not self._notification_seeded:
            # Retained snapshot on (re)start: adopt it silently.
            self._notification_seeded = True
            self._notification_key = key
            return
        if key == self._notification_key:
            return  # duplicate delivery / re-subscribe
        self._notification_key = key

        self.hass.bus.async_fire(
            EVENT_NOTIFICATION,
            {
                # `device_id` is the PANEL's id (the integration's convention for
                # every bus event); `ha_device_id` is the device-registry one, so
                # an automation reacting to a button can target the same panel
                # back without a lookup.
                "device_id": self.device_id,
                "ha_device_id": self.ha_device_id,
                "id": data.get("id"),
                "action": status,
                "action_id": data.get("actionId"),
            },
        )

    @callback
    def arm_notification_on_press(
        self, notification_id: str, on_press: dict[str, Any]
    ) -> None:
        """Remember what each button of this notification should DO.

        Called by the notify service / WS command just before publishing. Only
        ids with an `on_press` are kept; re-sending a notification with the same
        id replaces its bindings, exactly as it replaces the notification.
        """
        if not on_press:
            self._notify_on_press.pop(notification_id, None)
            return
        self._notify_on_press[notification_id] = on_press
        # A notification is short-lived and the panel shows one at a time; this
        # map exists to bridge a few seconds, not to accumulate.
        while len(self._notify_on_press) > 8:
            self._notify_on_press.pop(next(iter(self._notify_on_press)))

    @callback
    def _run_notification_on_press(self, data: dict[str, Any], status: Any) -> None:
        """Execute the pressed button's `on_press`, and forget the notification.

        The panel never sees these bindings, let alone runs them: it reports
        which button was pressed and HA does the rest (CLAUDE.md — the app owns
        visuals, the integration owns behaviour).
        """
        notification_id = data.get("id")
        if not isinstance(notification_id, str):
            return
        if status != "action":
            # dismissed / expired: nothing to run, and nothing left to remember.
            if status in ("dismissed", "expired"):
                self._notify_on_press.pop(notification_id, None)
            return
        bindings = self._notify_on_press.pop(notification_id, None)
        if not bindings:
            return
        binding = bindings.get(data.get("actionId"))
        if not binding:
            return
        self.hass.async_create_task(
            self._run_binding(
                binding, None, None, f"notify:{notification_id}.{data.get('actionId')}"
            )
        )

    @callback
    def _on_pong(self, msg: mqtt.ReceiveMessage) -> None:
        data = _parse(msg.payload)
        ping_id = str(data.get("id"))
        sent = self._pending_pings.pop(ping_id, None)
        rtt_ms = round((time.monotonic() - sent) * 1000) if sent is not None else None
        _LOGGER.debug("pong %s rtt=%sms (%s)", ping_id, rtt_ms, self.device_id)
        self.hass.bus.async_fire(
            EVENT_PONG,
            {"device_id": self.device_id, "id": data.get("id"), "rtt_ms": rtt_ms},
        )

    @callback
    def _on_screenshot(self, msg: mqtt.ReceiveMessage) -> None:
        data = _parse(msg.payload)
        b64 = data.get("data")
        if not isinstance(b64, str):
            return
        try:
            self.screenshot_png = base64.b64decode(b64)
        except (ValueError, TypeError):
            _LOGGER.warning("screenshot %s: bad base64", self.device_id)
            return
        self.screenshot_ts = time.time()
        async_dispatcher_send(self.hass, signal_screenshot(self.device_id))
        _LOGGER.debug(
            "screenshot %s: %d bytes", self.device_id, len(self.screenshot_png)
        )

    @callback
    def _on_event(self, msg: mqtt.ReceiveMessage) -> None:
        data = _parse(msg.payload)
        button = data.get("button")
        action = data.get("action")
        value = data.get("value")
        page = data.get("page")
        # Split-segment presses ride the visual state at press time (PLAN.md
        # §3.6): {button:"<tileId>.<segId>", action:"press", state:"off|on|inset"}.
        state = data.get("state")
        if not isinstance(button, str) or not isinstance(action, str):
            _LOGGER.debug("event %s: malformed payload %s", self.device_id, msg.payload)
            return

        # ALWAYS fire on the bus + dispatch to the event entity, regardless of
        # whether a binding handles it (PLAN.md §3.3). The state (when present)
        # rides along so automations can key off it too.
        _LOGGER.debug(
            "event %s button=%s action=%s value=%r state=%r page=%s",
            self.device_id, button, action, value, state, page,
        )
        payload: dict[str, Any] = {
            "device_id": self.device_id,
            "button": button,
            "action": action,
            "value": value,
            "page": page,
        }
        if state is not None:
            payload["state"] = state
        self.hass.bus.async_fire(EVENT_BUS, payload)
        async_dispatcher_send(
            self.hass, signal_event(self.device_id), button, action, value, page, state
        )

        # alarm_fired (button=="alarm") has no tile/binding — event only.
        if button == "alarm":
            return
        self._execute_binding(button, action, value, state)

    # --- binding execution ---------------------------------------------------

    def _execute_binding(
        self, button: str, action: str, value: Any, state: Any = None
    ) -> None:
        # Split segment? The event button id is "<tileId>.<segId>"; route the
        # TRANSITION binding keyed by the visual state at press time —
        # press:<state> (PLAN.md §3.6). The bindings live on the segment, not
        # the tile.
        seg_ctx = self._split_segments.get(button)
        if seg_ctx is not None:
            _tile, seg = seg_ctx
            bindings = seg.get("bindings") if isinstance(seg.get("bindings"), dict) else {}
            key = f"{action}:{state}" if state is not None else action
            binding_value = bindings.get(key)
            if binding_value is None:
                return
            self.hass.async_create_task(
                self._run_binding(
                    binding_value, self._segment_default_entity(seg), value, button
                )
            )
            return

        tile = self._tiles_by_id.get(button)
        if tile is None:
            return
        bindings = tile.get("bindings") if isinstance(tile.get("bindings"), dict) else {}
        binding_value = self._resolve_binding(tile, bindings, action, value)
        if binding_value is None:
            binding_value = self._implicit_binding(tile, action)
        if binding_value is not None:
            self.hass.async_create_task(
                self._run_binding(
                    binding_value, tile.get("entity"), value, tile.get("id")
                )
            )

    @staticmethod
    def _segment_default_entity(seg: dict[str, Any]) -> Any:
        """The entity a split segment's implicit binding acts on: its
        ``state.entity`` default source (segment transition bindings are usually
        explicit ``call``/``scene``, but this keeps ``toggle``/``turn_on`` etc.
        working on a segment too)."""
        state = seg.get("state")
        if isinstance(state, dict):
            entity = state.get("entity")
            if isinstance(entity, str) and entity:
                return entity
        return None

    def _resolve_binding(
        self, tile: dict[str, Any], bindings: dict[str, Any], action: str, value: Any
    ) -> Any:
        """Pick the binding for an event action.

        State buttons AND switcher tiles key per value (``state:<value>``) —
        both publish ``{action:"state", value}`` (state buttons cycle, switchers
        direct-select; the routing is identical). For other buttons the binding
        is keyed by the event action — but the app emits ``toggle`` for a
        toggle-behaviour button's primary tap while authors commonly key that
        binding as ``press`` (see the reference config), so the two are aliased
        both ways.
        """
        if action == "state" and (
            tile.get("behavior") == "state" or tile.get("type") == "switcher"
        ):
            return bindings.get(f"state:{value}")
        if action in bindings:
            return bindings[action]
        if action == "toggle" and "press" in bindings:
            return bindings["press"]
        if action == "press" and "toggle" in bindings:
            return bindings["toggle"]
        return None

    def _implicit_binding(
        self, tile: dict[str, Any], action: str
    ) -> dict[str, Any] | None:
        """Self-describing fallback so a minimal tile (entity, no bindings) still
        works: a bare ``toggle`` toggles the entity, a bare ``dim`` sets its
        brightness."""
        if not tile.get("entity"):
            return None
        if action == "toggle":
            return {"action": "toggle"}
        if action == "dim":
            return {"action": "brightness"}
        return None

    async def _run_binding(
        self, binding_value: Any, entity: Any, value: Any, log_id: Any
    ) -> None:
        """Execute a binding value: a single action dict OR a LIST of action
        dicts run STRICTLY IN ORDER (multi-action GLOBAL upgrade — PLAN.md §3.6).

        Error policy — continue-on-error PER ACTION: every action is awaited
        (``blocking=True``) so ordering is deterministic and a failure surfaces
        here; the failing action is logged as a warning and execution continues
        with the remaining action(s), so one bad service never silently drops
        the rest. The whole thing runs in a detached task, so blocking never
        stalls MQTT/event handling.
        """
        actions = binding_value if isinstance(binding_value, list) else [binding_value]
        total = len(actions)
        for i, act in enumerate(actions, 1):
            if not isinstance(act, dict):
                _LOGGER.warning(
                    "binding %s: action %d/%d is not an object (%r) — skipped",
                    log_id, i, total, act,
                )
                continue
            _LOGGER.debug(
                "binding %s: action %d/%d -> %s", log_id, i, total, act.get("action")
            )
            try:
                await self._call_single_action(act, entity, value)
            except Exception:  # noqa: BLE001 - isolate one action's failure
                _LOGGER.warning(
                    "binding %s: action %d/%d (%s) failed — continuing with the "
                    "remaining action(s)",
                    log_id, i, total, act.get("action"), exc_info=True,
                )

    async def _call_single_action(
        self, binding: dict[str, Any], entity: Any, value: Any
    ) -> None:
        """Execute ONE binding action. Exceptions propagate to ``_run_binding``,
        which logs a warning and continues with the next action."""
        act = binding.get("action")
        extra = binding.get("data") if isinstance(binding.get("data"), dict) else {}

        if act == "none":
            return
        if act == "toggle":
            await self._svc("homeassistant", "toggle", entity, extra)
        elif act == "turn_on":
            await self._svc("homeassistant", "turn_on", entity, extra)
        elif act == "turn_off":
            await self._svc("homeassistant", "turn_off", entity, extra)
        elif act == "brightness":
            pct = None
            if isinstance(value, (int, float)):
                pct = max(0, min(100, round(float(value) * 100)))
            data = {"brightness_pct": pct} if pct is not None else {}
            data.update(extra)
            await self._svc("light", "turn_on", entity, data)
        elif act == "scene":
            await self._svc("scene", "turn_on", binding.get("entity_id"), extra)
        elif act == "script":
            target = binding.get("entity_id")
            if target:
                await self._svc("script", "turn_on", target, extra)
            elif binding.get("service"):
                await self._call_service_str(binding["service"], None, extra)
        elif act == "call":
            service = binding.get("service")
            if not isinstance(service, str) or "." not in service:
                _LOGGER.warning("binding call missing valid service: %s", binding)
                return
            data = dict(extra)
            target = binding.get("target") if isinstance(binding.get("target"), dict) else None
            await self._call_service_str(
                service, binding.get("entity_id"), data, target
            )
        else:
            _LOGGER.warning("unknown binding action %r", act)

    async def _svc(
        self, domain: str, service: str, entity_id: Any, data: dict[str, Any]
    ) -> None:
        payload = dict(data)
        if entity_id:
            payload["entity_id"] = entity_id
        elif domain != "homeassistant":
            # scene/light without a target — nothing to act on
            if "entity_id" not in payload:
                _LOGGER.warning("binding %s.%s has no entity_id", domain, service)
                return
        # blocking=True: sequential multi-action ordering + failures raise so the
        # per-action handler in _run_binding can log and continue.
        await self.hass.services.async_call(domain, service, payload, blocking=True)

    async def _call_service_str(
        self, service: str, entity_id: Any, data: dict[str, Any],
        target: dict[str, Any] | None = None,
    ) -> None:
        """Call ``domain.service``. ``target`` is passed through as HA's own
        target (entity_id / device_id / area_id / label_id), which is what a
        notification's `on_press` written in Home Assistant's YAML carries."""
        domain, _, name = service.partition(".")
        payload = dict(data)
        if entity_id and "entity_id" not in payload:
            payload["entity_id"] = entity_id
        await self.hass.services.async_call(
            domain, name, payload, blocking=True, target=target or None
        )

    # --- state mirror --------------------------------------------------------

    def _start_state_tracking(self) -> None:
        entities = list(self._entity_keys)
        if not entities:
            return
        self._state_unsub = async_track_state_change_event(
            self.hass, entities, self._on_state_change
        )

    @callback
    def _on_state_change(self, event: Event[EventStateChangedData]) -> None:
        entity_id = event.data["entity_id"]
        new_state = event.data["new_state"]
        self._publish_entity(entity_id, new_state)

    async def _publish_all_states(self) -> None:
        for entity_id in self._entity_keys:
            state = self.hass.states.get(entity_id)
            self._publish_entity(entity_id, state)

    @callback
    def _publish_entity(self, entity_id: str, state: Any) -> None:
        keys = self._entity_keys.get(entity_id)
        if not keys:
            return
        if entity_id in self._camera_entities:
            payload = self._camera_payload(entity_id, state)
        elif entity_id in self._weather_entities:
            payload = self._weather_payload(entity_id, state)
        else:
            payload = _state_payload(
                entity_id, state, include_value=entity_id in self._value_entities
            )
        if payload is None:
            return
        body = json.dumps(payload)
        for key in keys:
            self.hass.async_create_task(
                mqtt.async_publish(
                    self.hass, topic_state(self.device_id, key), body, retain=True
                )
            )

    def _camera_payload(self, entity_id: str, state: Any) -> dict[str, Any]:
        """Mirror payload for a camera on a camera page.

        Carries the ABSOLUTE MJPEG URL, token included, so the panel never holds
        an HA credential and never has to assemble a URL:

            {"on": true, "value": "idle",
             "stream": "http://ha:8123/api/camera_proxy_stream/camera.x?token=..",
             "ts": 1752480000}

        The token is HA's per-camera access token, lifted from ``entity_picture``.
        HA rotates it (~5 min) and writes the entity state, which re-fires
        ``async_track_state_change_event`` → this republishes retained. So the
        panel always has a fresh token with no extra timer and no extra publish
        path. (Rotation does NOT kill a running stream: HA checks the token once,
        at request time. The app pins the URL it connected with — see
        ``streamState.ts`` — so a rotation never re-buffers live video.)

        ``on`` keeps the shape every other mirror consumer expects, and ``value``
        (the raw HA state) means a statusDot on a grid page can bind to a camera
        for free. ``stream`` is OMITTED rather than faked when we can't build a
        URL — the app then shows an explicit offline card instead of a dead
        <img>. ``ts`` is only ever used to pick the offline copy; the <img>'s own
        error event is the sole authority on whether the stream works, so panel
        clock skew can never blank a working camera.
        """
        if state is None:
            return {"on": False, "value": None, "ts": int(time.time())}
        st = state.state
        payload: dict[str, Any] = {
            "on": st not in ("unavailable", "unknown"),
            "value": st,
            "ts": int(time.time()),
        }
        token = _token_from_entity_picture(state.attributes.get("entity_picture"))
        base = self._camera_entities.get(entity_id, {}).get("baseUrl") or (
            self._ha_base_url()
        )
        if token and base:
            payload["stream"] = (
                f"{base.rstrip('/')}/api/camera_proxy_stream/{entity_id}?token={token}"
            )
        else:
            _LOGGER.warning(
                "camera %s: no stream URL (token=%s, base_url=%s) — the panel will "
                "show an offline card. If the base URL is missing, set an Internal "
                "URL in HA (Settings > System > Network) or `camera.baseUrl` on the "
                "page.",
                entity_id,
                "yes" if token else "MISSING",
                base or "MISSING",
            )
        return payload

    def _ha_base_url(self) -> str | None:
        """The URL the PANEL should reach HA on. Never hardcoded.

        Prefer the internal (LAN) URL: the panel is on the same network, and an
        external/cloud URL would send 1.4 Mbit/s of MJPEG out and back. Falls
        back to any known URL, then to None (→ offline card + the warning above).
        """
        try:
            return get_url(self.hass, allow_external=False, prefer_external=False)
        except NoURLAvailableError:
            pass
        try:
            return get_url(self.hass)
        except NoURLAvailableError:
            return None

    # --- command publishers (used by services) ------------------------------

    async def async_cmd(self, name: str, payload: dict[str, Any] | None = None) -> None:
        await mqtt.async_publish(
            self.hass,
            topic_cmd(self.device_id, name),
            json.dumps(payload or {}),
            retain=False,
        )

    async def async_ping(self) -> str:
        ping_id = uuid.uuid4().hex[:8]
        self._pending_pings[ping_id] = time.monotonic()
        await self.async_cmd("ping", {"id": ping_id})
        return ping_id

    async def async_screenshot(self) -> None:
        await self.async_cmd("screenshot", {"id": uuid.uuid4().hex[:8]})

    async def async_publish_license(self, jwt: str) -> None:
        """Publish the licence retained, as a bare JWT string.

        Retained so a rebooting panel is re-licensed by the broker even if its
        own copy was lost (a factory reset, a reinstall). An empty payload is
        meaningful: it both clears the retained message and tells a running panel
        to drop its stored licence, which is how a licence is revoked.
        """
        await mqtt.async_publish(
            self.hass,
            topic_config_license(self.device_id),
            jwt or "",
            retain=True,
        )

    async def async_push_config(self) -> list[str]:
        """Re-read the on-disk config, validate, and publish it retained.

        Returns a list of validation errors ([] on success). On success the
        entry is scheduled for reload so event entities / bindings / state
        tracking rebuild from the (possibly edited) file.
        """
        panels = await panel_config.async_read_panels(self.hass, self.device_id)
        errors = panel_config.validate_panels(panels)
        if errors:
            _LOGGER.error("push_config %s rejected: %s", self.device_id, errors)
            return errors
        device_cfg = await panel_config.async_read_device(self.hass, self.device_id)
        public_cfg, ma_secrets = _split_ma_secrets(device_cfg)
        public_cfg, license_jwt = _split_license(public_cfg)
        await mqtt.async_publish(
            self.hass,
            topic_config_panels(self.device_id),
            json.dumps(panels),
            retain=True,
        )
        await mqtt.async_publish(
            self.hass,
            topic_config_device(self.device_id),
            json.dumps(public_cfg),
            retain=True,
        )
        await self.async_publish_license(license_jwt)
        if ma_secrets:
            await self.async_cmd("ma_auth", ma_secrets)
        _LOGGER.info("push_config %s published (%d pages)", self.device_id,
                     len(panels.get("pages", [])))
        # rebuild everything cleanly from the new document
        self.hass.config_entries.async_schedule_reload(self.entry.entry_id)
        return []


# --- module helpers ----------------------------------------------------------


def _split_license(device_cfg: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """Pull the licence out of the publishable device config.

    Stored alongside the rest of the device settings so it is backed up and
    restored with them, but published on its OWN retained topic: the panel hands
    it to the native verifier as an opaque blob, and it must not travel through
    the config validation path where a schema change could reject or reshape it.

    Returns ``(config_without_licence, jwt_or_empty)``.
    """
    jwt = device_cfg.get("license")
    if not isinstance(jwt, str) or not jwt.strip():
        return {k: v for k, v in device_cfg.items() if k != "license"}, ""
    return {k: v for k, v in device_cfg.items() if k != "license"}, jwt.strip()


def _split_ma_secrets(device_cfg: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Separate the Music Assistant credentials from the publishable config.

    ``config/device`` is published RETAINED, so anything left in it sits in the
    broker forever — a password included. The switch and the server URL are
    ordinary config and stay; ``username``/``password`` are pulled out and sent
    instead on the non-retained ``cmd/ma_auth`` (see ``async_push_config`` and
    ``_on_avail``), which the panel keeps in memory only.

    Returns ``(config_without_credentials, ma_auth_payload_or_empty)``.
    """
    ma = device_cfg.get("musicAssistant")
    if not isinstance(ma, dict):
        return device_cfg, {}
    username = ma.get("username")
    password = ma.get("password")
    public = dict(device_cfg)
    public["musicAssistant"] = {
        k: v for k, v in ma.items() if k not in ("username", "password")
    }
    if not username:
        return public, {}
    return public, {
        "url": ma.get("url", ""),
        "username": username,
        "password": password or "",
    }


def _normalise_ptz_target(target: Any) -> Any | None:
    """Turn one PTZ direction's config into a binding the executor can run.

    A shorthand ``"button.cam_move_up"`` becomes a ``call`` binding whose service
    is derived from the entity's domain. An object (or list of objects) is a full
    binding already and passes through VERBATIM — that is the escape hatch for
    cameras whose PTZ is a service call rather than an entity press (ONVIF, and
    anything else that doesn't fit the entity model).

    Returns None for an unset direction or an undiscoverable domain, which simply
    means that arrow is not bound (the app renders it disabled).
    """
    if isinstance(target, str) and target:
        domain = target.split(".", 1)[0]
        service = PTZ_SERVICE_BY_DOMAIN.get(domain)
        if service is None:
            return None  # rejected at validate time; belt and braces
        return {"action": "call", "service": service, "entity_id": target}
    if isinstance(target, (dict, list)):
        return target
    return None


def _token_from_entity_picture(pic: Any) -> str | None:
    """Lift HA's rotating camera access token out of ``entity_picture``
    (``/api/camera_proxy/camera.x?token=<tok>``)."""
    if not isinstance(pic, str) or "token=" not in pic:
        return None
    query = urlparse(pic).query
    values = parse_qs(query).get("token") or []
    return values[0] if values else None


def _parse(payload: str) -> dict[str, Any]:
    if not payload:
        return {}
    try:
        v = json.loads(payload)
    except (ValueError, TypeError):
        return {}
    return v if isinstance(v, dict) else {}


def _state_payload(
    entity_id: str, state: Any, *, include_value: bool = False
) -> dict[str, Any] | None:
    """Map an HA state to the compact ``state/{key}`` payload for the panel.

    Domain mapping (implemented table — see report):
      * light                       → {"on": bool, "brightness": 0..1?}
      * input_select / select       → {"value": <state>}
      * scene/script/button         → (never tracked; skipped upstream)
      * everything else (switch,    → {"on": bool}
        input_boolean, fan, ...)

    ``include_value=True`` (entities referenced by a dynamic statusDot) adds a
    generic ``value`` — the raw HA state string — regardless of domain, so the
    app-side dot comparison works for locks, sensors, anything (PLAN.md §3.6).
    A missing entity yields ``value: null`` → the dot fails safe (off).
    """
    domain = entity_id.split(".", 1)[0]
    if state is None:
        payload: dict[str, Any] = {"on": False}
        if include_value:
            payload["value"] = None
        return payload
    st = state.state
    if domain in _VALUE_DOMAINS:
        return {"value": st}
    on = st == "on"
    payload = {"on": on}
    if domain == "light":
        bri = state.attributes.get("brightness")
        if on and isinstance(bri, (int, float)):
            payload["brightness"] = round(bri / 255, 3)
    if include_value:
        payload["value"] = st
    return payload
