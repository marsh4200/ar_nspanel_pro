"""Residence dashboard style: the Calendar page.

* Reminders made on a panel ("Take the bins out", Thursday 18:00, Mom's phone)
  are kept here, house-wide and across restarts, and at that time Home
  Assistant sends them to the chosen phones through the Companion app
  (``notify.mobile_app_*``). An ``ar_nspanel_pro_reminder`` event fires too, for
  automations. Optionally each reminder is also written to a calendar.
* Events from the Home Assistant calendars picked in the editor are shown on
  the page (read only), refreshed every 15 minutes.

Everything reaches the panel on its retained ``state/rs_cal`` topic. Only
panels on the Residence style are attached; nothing here runs for the others.

Panel → HA, on button ``rs``:
    rem_add  {title, when: "YYYY-MM-DDTHH:MM" (local), targets: [notify service]}
    rem_del  {id}
    cal_refresh
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from homeassistant.components import mqtt
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_point_in_time, async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util
from homeassistant.util import slugify

from .const import DOMAIN, topic_state

_LOGGER = logging.getLogger(__name__)

CAL_KEY = "rs_cal"
EVENT_REMINDER = f"{DOMAIN}_reminder"
_DATA = f"{DOMAIN}_rs_calendar"
_STORE_KEY = f"{DOMAIN}.residence_reminders"
MAX_REMINDERS = 200
MAX_TITLE = 80
#: a reminder missed while Home Assistant was down is still sent if it is at
#: most this late; older ones are dropped
LATE_GRACE = timedelta(hours=1)
REFRESH = timedelta(minutes=15)
DAYS_AHEAD = 42


def _rs(bridge: Any) -> dict[str, Any]:
    cfg = bridge.device_cfg if isinstance(bridge.device_cfg, dict) else {}
    rs = cfg.get("residence")
    return rs if isinstance(rs, dict) else {}


def is_residence(bridge: Any) -> bool:
    return isinstance(bridge.device_cfg, dict) and bridge.device_cfg.get("dashboardStyle") == "residence"


class _Calendar:
    """One per Home Assistant: the reminders, their timers and the cached events."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.store: Store = Store(hass, 1, _STORE_KEY)
        self.reminders: list[dict[str, Any]] = []
        self.timers: dict[str, Any] = {}
        self.bridges: set[Any] = set()
        self.events: dict[str, list[dict[str, Any]]] = {}
        self.refresh_unsub: Any = None
        self.loaded = False

    # --- storage + timers ---------------------------------------------------
    async def async_load(self) -> None:
        if self.loaded:
            return
        self.loaded = True
        data = await self.store.async_load() or {}
        now = dt_util.utcnow()
        keep: list[dict[str, Any]] = []
        for r in data.get("reminders") or []:
            when = dt_util.parse_datetime(str(r.get("when") or ""))
            if not isinstance(r, dict) or when is None:
                continue
            if when < now - LATE_GRACE:
                _LOGGER.info("residence: dropping reminder %r, missed while Home Assistant was off", r.get("title"))
                continue
            keep.append(r)
        self.reminders = keep
        for r in self.reminders:
            self._schedule(r)

    async def async_save(self) -> None:
        await self.store.async_save({"reminders": self.reminders})

    def _schedule(self, r: dict[str, Any]) -> None:
        when = dt_util.parse_datetime(r["when"])
        if when is None:
            return
        if when <= dt_util.utcnow():
            self.hass.async_create_task(self._async_fire(r["id"]))
            return

        @callback
        def _due(_now: datetime, rid: str = r["id"]) -> None:
            self.timers.pop(rid, None)
            self.hass.async_create_task(self._async_fire(rid))

        self.timers[r["id"]] = async_track_point_in_time(self.hass, _due, when)

    async def _async_fire(self, rid: str) -> None:
        r = next((x for x in self.reminders if x.get("id") == rid), None)
        if r is None:
            return
        for target in r.get("targets") or []:
            try:
                await self.hass.services.async_call(
                    "notify",
                    target,
                    {"title": "Reminder", "message": r["title"], "data": {"tag": "ar-reminder-" + rid}},
                    blocking=False,
                )
            except Exception:  # noqa: BLE001 - one phone failing must not stop the rest
                _LOGGER.warning("residence: reminder %r could not be sent to %s", r["title"], target, exc_info=True)
        self.hass.bus.async_fire(EVENT_REMINDER, {"title": r["title"], "targets": r.get("targets") or [], "panel": r.get("by")})
        self.reminders = [x for x in self.reminders if x.get("id") != rid]
        await self.async_save()
        await self.async_publish_all()

    # --- phones + calendars ---------------------------------------------------
    def phones(self) -> list[dict[str, str]]:
        """The phones Home Assistant can notify: one notify.mobile_app_* each."""
        names: dict[str, str] = {}
        for entry in self.hass.config_entries.async_entries("mobile_app"):
            dn = (entry.data or {}).get("device_name")
            if isinstance(dn, str) and dn:
                names["mobile_app_" + slugify(dn)] = dn
        out = []
        for svc in sorted((self.hass.services.async_services().get("notify") or {}).keys()):
            if svc.startswith("mobile_app_"):
                out.append({"id": svc, "name": names.get(svc) or svc[11:].replace("_", " ").title()})
        return out

    def calendars_wanted(self) -> list[str]:
        want: list[str] = []
        for b in self.bridges:
            for c in _rs(b).get("calendars") or []:
                if isinstance(c, str) and c.startswith("calendar.") and c not in want:
                    want.append(c)
        return want

    async def async_refresh_events(self) -> None:
        start = dt_util.start_of_local_day()
        end = start + timedelta(days=DAYS_AHEAD)
        for cal in self.calendars_wanted():
            try:
                resp = await self.hass.services.async_call(
                    "calendar",
                    "get_events",
                    {"entity_id": cal, "start_date_time": start.isoformat(), "end_date_time": end.isoformat()},
                    blocking=True,
                    return_response=True,
                )
            except Exception:  # noqa: BLE001 - calendar missing / not loaded yet
                _LOGGER.debug("residence: no events from %s", cal, exc_info=True)
                continue
            items = ((resp or {}).get(cal) or {}).get("events") or []
            self.events[cal] = [
                {"t": str(e.get("summary") or "")[:80], "s": str(e.get("start") or ""), "e": str(e.get("end") or ""), "loc": str(e.get("location") or "")[:60]}
                for e in items
                if isinstance(e, dict)
            ][:200]
        await self.async_publish_all()

    # --- publishing -------------------------------------------------------------
    def payload(self, bridge: Any) -> dict[str, Any]:
        rs = _rs(bridge)
        allowed = [p for p in rs.get("phones") or [] if isinstance(p, str)]
        phones = [p for p in self.phones() if not allowed or p["id"] in allowed]
        pname = {p["id"]: p["name"] for p in self.phones()}
        events = []
        for cal in rs.get("calendars") or []:
            st = self.hass.states.get(cal) if isinstance(cal, str) else None
            cname = (st.attributes.get("friendly_name") if st else None) or str(cal).split(".")[-1].replace("_", " ")
            for e in self.events.get(cal, []):
                events.append({**e, "cal": cname})
        reminders = [
            {"id": r["id"], "t": r["title"], "at": r["local"], "to": [pname.get(x, x) for x in r.get("targets") or []]}
            for r in sorted(self.reminders, key=lambda x: x["when"])
        ]
        return {"phones": phones, "reminders": reminders, "events": events, "write": bool(rs.get("calendarWrite"))}

    async def async_publish(self, bridge: Any) -> None:
        await mqtt.async_publish(self.hass, topic_state(bridge.device_id, CAL_KEY), json.dumps(self.payload(bridge)), retain=True)

    async def async_publish_all(self) -> None:
        for b in list(self.bridges):
            try:
                await self.async_publish(b)
            except Exception:  # noqa: BLE001
                _LOGGER.debug("residence: publish to %s failed", getattr(b, "device_id", "?"), exc_info=True)

    # --- from the panel -------------------------------------------------------------
    async def async_add(self, bridge: Any, value: dict[str, Any]) -> None:
        title = " ".join(str(value.get("title") or "").split())[:MAX_TITLE]
        when_l = dt_util.parse_datetime(str(value.get("when") or ""))
        if not title or when_l is None:
            _LOGGER.debug("residence: reminder rejected (title / time missing): %r", value)
            return
        if when_l.tzinfo is None:
            when_l = when_l.replace(tzinfo=dt_util.get_default_time_zone())
        when = dt_util.as_utc(when_l)
        if when < dt_util.utcnow() - timedelta(minutes=1):
            _LOGGER.debug("residence: reminder in the past rejected: %r", value)
            return
        ok = {p["id"] for p in self.payload(bridge)["phones"]}
        targets = [t for t in value.get("targets") or [] if isinstance(t, str) and t in ok]
        if len(self.reminders) >= MAX_REMINDERS:
            _LOGGER.warning("residence: %d reminders already waiting, not adding more", MAX_REMINDERS)
            return
        r = {
            "id": uuid.uuid4().hex[:12],
            "title": title,
            "when": when.isoformat(),
            "local": dt_util.as_local(when).strftime("%Y-%m-%dT%H:%M"),
            "targets": targets,
            "by": bridge.device_id,
        }
        self.reminders.append(r)
        self._schedule(r)
        await self.async_save()
        write = _rs(bridge).get("calendarWrite")
        if isinstance(write, str) and write.startswith("calendar."):
            try:
                await self.hass.services.async_call(
                    "calendar",
                    "create_event",
                    {"entity_id": write, "summary": title, "start_date_time": when_l.isoformat(), "end_date_time": (when_l + timedelta(minutes=15)).isoformat()},
                    blocking=True,
                )
                self.hass.async_create_task(self.async_refresh_events())
            except Exception:  # noqa: BLE001 - the reminder itself still stands
                _LOGGER.warning("residence: could not add %r to %s", title, write, exc_info=True)
        await self.async_publish_all()

    async def async_delete(self, rid: Any) -> None:
        if not isinstance(rid, str):
            return
        unsub = self.timers.pop(rid, None)
        if unsub:
            unsub()
        self.reminders = [x for x in self.reminders if x.get("id") != rid]
        await self.async_save()
        await self.async_publish_all()


def _cal(hass: HomeAssistant) -> _Calendar:
    c = hass.data.get(_DATA)
    if c is None:
        c = hass.data[_DATA] = _Calendar(hass)
    return c


async def async_attach(bridge: Any) -> None:
    """A Residence panel came up: keep it in sync with the calendar."""
    if not is_residence(bridge):
        return
    c = _cal(bridge.hass)
    await c.async_load()
    c.bridges.add(bridge)
    if c.refresh_unsub is None:

        @callback
        def _tick(_now: datetime) -> None:
            bridge.hass.async_create_task(c.async_refresh_events())

        c.refresh_unsub = async_track_time_interval(bridge.hass, _tick, REFRESH)
    await c.async_publish(bridge)
    if any(cal not in c.events for cal in _rs(bridge).get("calendars") or []):
        bridge.hass.async_create_task(c.async_refresh_events())


@callback
def async_detach(bridge: Any) -> None:
    c = bridge.hass.data.get(_DATA)
    if c is None:
        return
    c.bridges.discard(bridge)
    if not c.bridges and c.refresh_unsub:
        c.refresh_unsub()
        c.refresh_unsub = None


async def async_panel_event(bridge: Any, action: str, value: Any) -> None:
    """button "rs" from a Residence panel."""
    if not is_residence(bridge):
        return
    c = _cal(bridge.hass)
    await c.async_load()
    v = value if isinstance(value, dict) else {}
    if action == "rem_add":
        await c.async_add(bridge, v)
    elif action == "rem_del":
        await c.async_delete(v.get("id"))
    elif action == "cal_refresh":
        await c.async_refresh_events()
    else:
        _LOGGER.debug("residence: unknown calendar action %s", action)
