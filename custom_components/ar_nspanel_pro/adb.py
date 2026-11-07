"""ADB-over-TCP provisioning backend for the config panel's Setup/Update tool.

Speaks the ADB wire protocol straight from Home Assistant via the pure-python
``adb-shell`` library — NO adb *binary* is needed in the HA container (the same
approach the core Android TV integration takes). It exists to bootstrap a
brand-new Sonoff NSPanel Pro *before it is even talking MQTT*: install/update the
app APK and poke the device (wake, back, home, type text, show notifications,
dump memory).

Design notes
------------
* Blocking ``adb-shell`` calls run in the executor; each request opens a fresh
  TCP connection and closes it. Provisioning is occasional — a kept-alive socket
  buys nothing and risks going stale between a phone-in and the next action.
* ``adb-shell`` is imported LAZILY inside the executor helpers, so a missing /
  not-yet-installed dependency degrades to a clear per-action error instead of
  breaking integration load.
* The first connect with our generated key blocks until the user accepts the
  one-time "Allow USB debugging?" prompt ON THE PANEL — surfaced as ``auth``.
* Admin-gated at the WebSocket layer (the sidebar panel is admin-only anyway):
  this can install software on, and type passwords into, a device on the LAN.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import time
from typing import Any, Callable
from urllib.parse import unquote

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import release_access
from .const import ADB_KEY_FILE, APP_ACTIVITY, APP_PACKAGE, GITHUB_OWNER, GITHUB_REPO

_LOGGER = logging.getLogger(__name__)

_DATA_KEY = "ar_nspanel_pro_adb"

#: On-device staging path for the APK before ``pm install``.
_REMOTE_APK = "/data/local/tmp/ar_nspanel_pro_update.apk"
#: Socket timeout for the install connection. Must exceed the read timeouts
#: below, so a silent curl download doesn't trip the transport layer first.
_XFER_TIMEOUT = 320.0
#: The panel downloads the APK itself with curl (adb-shell's pure-python push
#: hangs on this device's adbd). curl is silent, so adb-shell sees no shell
#: output until it finishes — the read timeout must cover the whole download.
_DL_CURL_TIMEOUT = 240
_DL_READ_TIMEOUT = 300.0
#: HDL Source 10: HDL's own app + launcher. Taking the panel over disables
#: both (so the knob and Home belong to our app); "Back to HDL" re-enables them.
#: com.hdl.factory is left alone — it is HDL's factory/ADB tooling.
HDL_APP = "com.hdl.source.ten"
HDL_LAUNCHER = "com.hdl.source.ten.launcher"
HDL_HOME = f"{HDL_LAUNCHER}/.ui.MainActivity"
#: Akubela (Akuvox) 10" touch panel, 2560x1600, RK3566: its own launcher app
AKUBELA_APP = "com.akubela.panel"
#: Akuvox software switched off with "Use AR app": the panel app (Home, 11
#: background services as a system app), its voice assistant (holds the
#: microphone), the updater, the log service, and the factory test and
#: stress-test apps that keep running in the background on these panels.
#: "Back to Akubela screen" switches them all on again.
AKUBELA_PKGS = (
    AKUBELA_APP,
    "com.akuvox.voiceassist",
    "com.akuvox.upgradeui",
    "com.akuvox.logservice",
    "com.akuvox.factorytest",
    "com.cghs.stresstest",
)


#: Samsung Galaxy Tab A7 Lite — SM-T220 (Wi-Fi) / SM-T225 (LTE). A stock
#: consumer tablet used as a panel: no vendor launcher to take over, ADB on
#: 5555, and set-home + device-owner exactly like a plain NSPanel. Matched on
#: the model prefix so a regional suffix (SM-T220N …) still counts.
_GALAXY_TAB_A7_LITE = re.compile(r"^SM-T22[05]")


def _is_galaxy_tab(model: str) -> bool:
    """A recognised Samsung tablet panel (Galaxy Tab A7 Lite)."""
    return bool(_GALAXY_TAB_A7_LITE.match((model or "").strip()))


#: TDX panel: Rockchip RK3566, Android 11 userdebug (ADB runs as root),
#: 1920x1080 LVDS, ILITEK touch, IR remote + ADC buttons, no camera. Model
#: "TDX_0XXE", build id "TDX_024Ev3_LVDS_...". Stock Launcher3 is Home; the
#: maker (Youngfeel) leaves its factory / RAM / device / stress test apps and
#: Rockchip's OTA updater on, and Fully Kiosk ships as a device admin. "Use AR
#: app" switches those off; "Back to stock" switches them on again.
TDX_HOME = "com.android.launcher3/.uioverrides.QuickstepLauncher"
TDX_PKGS = (
    "com.youngfeel.factorytest",
    "com.youngfeel.yfddrtest",
    "com.DeviceTest",
    "com.cghs.stresstest",
    "android.rockchip.update.service",
    "de.ozerov.fully",
)


def _is_tdx(device: Any) -> bool:
    """A TDX panel: model TDX_… or a TDX_… build (the model can be generic)."""
    model = (device.shell("getprop ro.product.model") or "").strip()
    build = (device.shell("getprop ro.build.display.id") or "").strip()
    return model.upper().startswith("TDX_") or build.upper().startswith("TDX_")


KIOSK_ADMIN = f"{APP_PACKAGE}/.KioskAdmin"
_KIOSK_CTRL = f"{APP_PACKAGE}/.KioskControl"


def _kiosk_owner(device: Any) -> str | None:
    """Package of the panel's device owner (None if there is none)."""
    out = device.shell("dumpsys device_policy") or ""
    m = re.search(r"Device Owner:.*?admin=ComponentInfo\{([^/}]+)/", out, re.S)
    return m.group(1) if m else None


def _is_source7(device: Any) -> bool:
    """HDL Source 7 = HDL's launcher is com.hdl.launcher (the Source 10's is
    com.hdl.source.ten.launcher)."""
    found = _hdl(device)
    return bool(found) and found[1] != HDL_LAUNCHER


def _kiosk_lock(device: Any) -> tuple[bool, str]:
    """HDL SOURCE 7 and TDX ONLY: make the app device owner and lock the panel
    in (kiosk), and push the navigation bar off screen (Android 10 and older).
    (locked, message) -- the bar is hidden even when Android refuses the lock.
    Every other panel (the HDL Source 10, the NSPanel Pro) is left exactly as
    it was."""
    if not (_is_source7(device) or _is_tdx(device)):
        return False, ""
    bar = _navbar_hide(device)
    tail = (" " + bar) if bar else ""
    owner = _kiosk_owner(device)
    if owner and owner != APP_PACKAGE:
        return False, f"Panel not locked: {owner} is already this panel's device owner." + tail
    if owner != APP_PACKAGE:
        out = (device.shell(f"dpm set-device-owner {KIOSK_ADMIN}") or "").strip()
        if "Success" not in out:
            low = out.lower()
            if "account" in low:
                return False, (
                    "Panel not locked: an account is signed in on it (Android → Settings → "
                    "Accounts). Remove it, then install again to lock the panel." + tail
                )
            if "unknown admin" in low or "not found" in low:
                return False, "Panel not locked: this app version has no kiosk lock yet — update the app." + tail
            return False, f"Panel not locked: {out or 'Android refused'}" + tail
    device.shell(f"am broadcast -a za.co.arsmarthome.nspanel.KIOSK_LOCK -n {_KIOSK_CTRL}")
    return True, "Panel locked: swiping up no longer shows Home / Recents / Clear all." + tail


def _kiosk_unlock(device: Any) -> str | None:
    """Release the kiosk lock (before uninstall / reset / HDL screen). Message or None."""
    if _is_source7(device):
        _navbar_show(device)
    if _kiosk_owner(device) != APP_PACKAGE:
        return None
    device.shell(f"am broadcast -a za.co.arsmarthome.nspanel.KIOSK_UNLOCK -n {_KIOSK_CTRL}")
    import time as _t

    for _ in range(10):
        _t.sleep(0.3)
        if _kiosk_owner(device) != APP_PACKAGE:
            return "Panel unlocked."
    return "Couldn't unlock the panel (the app didn't answer)."


def _navbar_hide(device: Any) -> str | None:
    """Push Android's navigation bar off the screen for good (wm overscan), so a
    swipe up can't bring Back / Home / Recents in. Android 10 and older only
    (overscan is gone in 11), and only when the panel has a navigation bar at
    all -- a panel without one would just lose part of its screen."""
    sdk = (device.shell("getprop ro.build.version.sdk") or "").strip()
    if not sdk.isdigit() or int(sdk) > 29:
        return None
    win = device.shell("dumpsys window windows") or ""
    i = win.find("NavigationBar")
    if i < 0:
        return None
    # its height from the window frame: mFrame=[0,672][1280,720]
    m = re.search(r"mFrame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]", win[i : i + 4000])
    h = int(m.group(4)) - int(m.group(2)) if m else 0
    if not 16 <= h <= 200:
        dens = (device.shell("wm density") or "").strip().split(":")[-1].strip()
        h = round(48 * (int(dens) if dens.isdigit() else 160) / 160)
    device.shell(f"wm overscan 0,0,0,-{h}")
    return f"Navigation bar hidden ({h} px pushed off the bottom edge)."


def _navbar_show(device: Any) -> None:
    sdk = (device.shell("getprop ro.build.version.sdk") or "").strip()
    if sdk.isdigit() and int(sdk) <= 29:
        device.shell("wm overscan reset")


def _hdl(device: Any) -> tuple[str | None, str, str] | None:
    """HDL's own app + launcher on this panel: (app, launcher, home component).

    Known for the Source 10; any other HDL panel (Source 7, ...) is found by
    its com.hdl.*.launcher package. com.hdl.factory is never touched."""
    out = device.shell("pm list packages com.hdl") or ""
    pkgs = [ln.split(":", 1)[1].strip() for ln in out.splitlines() if ln.startswith("package:")]
    if HDL_LAUNCHER in pkgs:
        return (HDL_APP if HDL_APP in pkgs else None), HDL_LAUNCHER, HDL_HOME
    launcher = next((p for p in pkgs if p.endswith(".launcher") and "factory" not in p), None)
    if not launcher:
        return None
    app = launcher[: -len(".launcher")]
    if app not in pkgs:
        # Source 7: com.hdl.launcher + com.hdl.source (the app isn't named after
        # the launcher) -> HDL's other package, never the factory tool
        app = next((p for p in pkgs if p != launcher and "factory" not in p and p.startswith("com.hdl.")), app)
    resolved = (
        device.shell(
            "cmd package resolve-activity --brief -a android.intent.action.MAIN "
            f"-c android.intent.category.HOME {launcher}"
        )
        or ""
    ).strip().splitlines()
    home = resolved[-1].strip() if resolved and "/" in resolved[-1] else f"{launcher}/.ui.MainActivity"
    return (app if app in pkgs else None), launcher, home
#: No-curl fallback: raw bytes per base64 shell chunk (multiple of 3, so only
#: the last chunk is padded; 3 KB of base64 fits even a 4 KB ADB packet).
_PUSH_CHUNK = 2304
_PUSH_MAX_BYTES = 50 * 1024 * 1024
#: Read timeout for ``pm install`` (verifies + optimizes the APK on-device).
_INSTALL_READ_TIMEOUT = 180.0
#: Short socket timeout for tiny shell round-trips.
_OP_TIMEOUT = 20.0
#: How long ``connect`` waits for the user to tap "Allow USB debugging?".
_AUTH_TIMEOUT = 18.0


class AdbError(Exception):
    """An ADB operation failed. ``code`` is a stable slug for the WS client."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def get_adb(hass: HomeAssistant) -> "PanelAdb":
    """Component-wide :class:`PanelAdb` singleton (created on first use)."""
    adb = hass.data.get(_DATA_KEY)
    if adb is None:
        adb = PanelAdb(hass)
        hass.data[_DATA_KEY] = adb
    return adb


def _parse_version_name(dumpsys_out: str | None) -> str | None:
    """Pull ``versionName=…`` out of ``dumpsys package <pkg>`` output."""
    if not dumpsys_out:
        return None
    for raw in dumpsys_out.splitlines():
        line = raw.strip()
        if line.startswith("versionName="):
            return line.split("=", 1)[1].strip() or None
    return None


def _input_text_arg(text: str) -> str:
    """Quote free text for Android's ``input text`` (one shell arg).

    Single-quote for the shell (only ``'`` is special inside single quotes, so
    ``$``, backticks, ``"`` etc. in a password pass through literally), and map
    spaces to ``%s`` — Android's ``input`` treats a literal space as an arg
    separator, so ``%s`` is the documented way to type one. A literal ``%`` is
    left as-is; passwords rarely contain ``%s``.
    """
    safe = text.replace("'", "'\\''").replace(" ", "%s")
    return f"'{safe}'"


def _vendor(device: Any) -> tuple[str, list[str], str] | None:
    """The panel maker's own software: (name, packages to switch off, its Home
    component). HDL (Source 10 / 7) or Akubela; None on a plain NSPanel."""
    found = _hdl(device)
    if found:
        app, launcher, home = found
        return "HDL", [p for p in (launcher, app) if p and _installed(device, p)], home
    if _installed(device, AKUBELA_APP):
        resolved = (
            device.shell(
                "cmd package resolve-activity --brief -a android.intent.action.MAIN "
                f"-c android.intent.category.HOME {AKUBELA_APP}"
            )
            or ""
        ).strip().splitlines()
        home = resolved[-1].strip() if resolved and "/" in resolved[-1] else f"{AKUBELA_APP}/.MainActivity"
        return "Akubela", [p for p in AKUBELA_PKGS if _installed(device, p)], home
    if _is_tdx(device):
        return "TDX", [p for p in TDX_PKGS if _installed(device, p)], TDX_HOME
    return None


def _run_panel_script(device: Any, name: str) -> str:
    """Copy one of scripts/<name> onto the panel and run it as root.
    The Akubela background services (their Home Assistant, KNX, SIP, SSH,
    cloud clients…) are started by Android's init, not as apps, so they are
    switched off by aku-clean.sh (the AR app re-stops them on every start)
    and back on by aku-restore.sh."""
    path = os.path.join(os.path.dirname(__file__), "scripts", name)
    with open(path, "rb") as fh:
        data = base64.b64encode(fh.read()).decode()
    remote = f"/data/local/tmp/{name}"
    device.shell(f"rm -f {remote}.b64")
    for i in range(0, len(data), 3000):
        device.shell(f"echo -n {data[i:i + 3000]} >> {remote}.b64")
    device.shell(f"/system/bin/toybox base64 -d {remote}.b64 > {remote}; rm -f {remote}.b64; chmod 755 {remote}")
    # as root where the panel has su; scripts that can run without it skip the root parts
    run = f"if [ -x /system/xbin/su ]; then su 0 sh {remote}; else sh {remote}; fi"
    return (device.shell(run, read_timeout_s=90) or "").strip()


def _home_now(device: Any) -> str:
    """The component Android opens for Home right now ('' if none)."""
    res = (
        device.shell(
            "cmd package resolve-activity --brief -a android.intent.action.MAIN "
            "-c android.intent.category.HOME"
        )
        or ""
    ).strip().splitlines()
    return res[-1].strip() if res and "/" in res[-1] else ""


def _installed(device: Any, pkg: str) -> bool:
    out = device.shell(f"pm list packages {pkg}") or ""
    return any(line.strip() == f"package:{pkg}" for line in out.splitlines())


def _set_home(device: Any, component: str, pkg: str, *, strict: bool = True) -> str:
    """Make ``component`` the Home app. ``cmd package set-home-activity`` fails
    on some Android 11 builds (the HDL Source 10: "Failed to set default
    home"), so fall back to the Home *role*, then check who holds it."""
    out = (device.shell(f"cmd package set-home-activity {component}") or "").strip()
    if "success" in out.lower():
        return f"Home set to {pkg}."
    device.shell(f"cmd role add-role-holder android.app.role.HOME {pkg}")
    holders = device.shell("cmd role get-role-holders android.app.role.HOME") or ""
    if pkg in holders:
        return f"Home set to {pkg} (via the Home role)."
    if not strict:
        return f"Couldn't make {pkg} the Home app ({out or 'no output'}); press Home and choose it."
    raise AdbError(
        "set_home_failed",
        f"Couldn't make {pkg} the Home app ({out or 'no output'}). Press Home on the "
        "panel and choose it, with “Always”.",
    )


def _github_session() -> aiohttp.ClientSession:
    """github.com (release pages, and the download redirect) sends headers
    (Content-Security-Policy) longer than aiohttp's default 8190-byte limit:
    requests to it get their own session with room for them."""
    return aiohttp.ClientSession(max_line_size=65536, max_field_size=65536)


#: Android versions below this get the legacy APK (bundled Gecko engine):
#: the standard one needs Android 7 (SDK 24) and a modern system WebView.
LEGACY_BELOW_SDK = 24


def _is_legacy_apk(name: str) -> bool:
    """ar-nspanel-pro-legacy-X.Y.Z.apk = the Android 5 build."""
    return "legacy" in name.lower()


class PanelAdb:
    """Runs ADB-over-TCP actions against a panel from Home Assistant."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._signer: Any = None
        self._signer_lock = asyncio.Lock()

    # --- key / signer -------------------------------------------------------
    async def _get_signer(self) -> Any:
        if self._signer is not None:
            return self._signer
        async with self._signer_lock:
            if self._signer is None:
                self._signer = await self._hass.async_add_executor_job(
                    self._load_or_make_signer
                )
        return self._signer

    def _load_or_make_signer(self) -> Any:
        """Load (or first-time generate) our persisted ADB key → a signer."""
        try:
            from adb_shell.auth.keygen import keygen
            from adb_shell.auth.sign_pythonrsa import PythonRSASigner
        except ImportError as err:  # dependency not installed yet
            raise AdbError(
                "unavailable",
                "The adb-shell library isn't installed yet. Restart Home "
                "Assistant once after updating the integration, then try again.",
            ) from err

        key_path = self._hass.config.path(".storage", ADB_KEY_FILE)
        if not os.path.isfile(key_path):
            os.makedirs(os.path.dirname(key_path), exist_ok=True)
            keygen(key_path)  # writes key_path and key_path + ".pub"
        with open(key_path, encoding="utf-8") as fh:
            priv = fh.read()
        with open(key_path + ".pub", encoding="utf-8") as fh:
            pub = fh.read()
        return PythonRSASigner(pub, priv)

    # --- low-level connect/run ---------------------------------------------
    def _run(
        self,
        host: str,
        port: int,
        signer: Any,
        fn: Callable[[Any], Any],
        *,
        xfer: bool = False,
    ) -> Any:
        """Blocking: connect → ``fn(device)`` → close. Runs in the executor.

        Exceptions are classified by type NAME (not by importing adb-shell's
        exception classes), so this keeps working across adb-shell versions that
        rename them.
        """
        try:
            from adb_shell.adb_device import AdbDeviceTcp
        except ImportError as err:
            raise AdbError(
                "unavailable",
                "The adb-shell library isn't installed yet. Restart Home "
                "Assistant once after updating the integration, then try again.",
            ) from err

        timeout = _XFER_TIMEOUT if xfer else _OP_TIMEOUT
        device = AdbDeviceTcp(host, int(port), default_transport_timeout_s=timeout)
        try:
            device.connect(
                rsa_keys=[signer],
                auth_timeout_s=_AUTH_TIMEOUT,
                transport_timeout_s=timeout,
            )
        except Exception as err:  # noqa: BLE001 — classify below, re-raise as AdbError
            name = type(err).__name__
            if "Auth" in name:
                raise AdbError(
                    "auth",
                    "The panel hasn't authorised this Home Assistant yet. Look at "
                    "the panel screen for an “Allow USB debugging?” prompt, "
                    "tap “Always allow”, then try again.",
                ) from err
            raise AdbError(
                "connect",
                f"Couldn't reach ADB at {host}:{port} — is the panel powered "
                f"on, on the network, and is ADB (port {port}) enabled? ({err})",
            ) from err

        try:
            return fn(device)
        finally:
            try:
                device.close()
            except Exception:  # noqa: BLE001 — closing a dead socket is fine
                pass

    # --- public actions -----------------------------------------------------
    async def async_probe(self, host: str, port: int) -> dict[str, Any]:
        """Connect and report model / Android version / installed app version."""
        signer = await self._get_signer()
        return await self._hass.async_add_executor_job(
            self._probe_blk, host, port, signer
        )

    def _probe_blk(self, host: str, port: int, signer: Any) -> dict[str, Any]:
        def fn(device: Any) -> dict[str, Any]:
            model = (device.shell("getprop ro.product.model") or "").strip()
            android = (device.shell("getprop ro.build.version.release") or "").strip()
            serial = (device.shell("getprop ro.serialno") or "").strip()
            app_version = _parse_version_name(
                device.shell(f"dumpsys package {APP_PACKAGE} | grep versionName")
            )
            disabled = device.shell("pm list packages -d") or ""
            found = _hdl(device)
            hdl = found is not None
            size = (device.shell("wm size") or "").strip().split(":")[-1].strip()
            return {
                "model": model or None,
                "android": android or None,
                "serialno": serial or None,
                "app_version": app_version,
                "app_installed": app_version is not None,
                "screen": size or None,
                # an HDL launcher present → the SPA picks that panel type
                "hdl": hdl,
                "hdl_launcher": found[1] if found else None,
                # device owner AND actually locked: the USB setup makes the app
                # device owner on the S10 only for silent updates, unlocked
                "kiosk": _kiosk_owner(device) == APP_PACKAGE
                and "mLockTaskModeState=NONE" not in (device.shell("dumpsys activity activities | grep mLockTaskModeState") or "mLockTaskModeState=NONE"),
                "hdl_disabled": bool(found) and f"package:{found[1]}" in disabled,
                "panel_type": ("source10" if found[1] == HDL_LAUNCHER else "source7") if found
                else "akubela" if _installed(device, AKUBELA_APP)
                else "tdx" if _is_tdx(device)
                else "samsung" if _is_galaxy_tab(model)
                else "nspanel",
            }

        return self._run(host, port, signer, fn)

    async def async_keyevent(self, host: str, port: int, code: int) -> dict[str, Any]:
        """Inject a key event (26=power, 4=back, 3=home, …)."""
        signer = await self._get_signer()
        await self._hass.async_add_executor_job(
            self._shell_blk, host, port, signer, f"input keyevent {int(code)}"
        )
        return {"code": int(code)}

    async def async_text(self, host: str, port: int, text: str) -> dict[str, Any]:
        """Type ``text`` on the device as if from the on-screen keyboard."""
        if not text:
            raise AdbError("bad_request", "No text to send.")
        signer = await self._get_signer()
        cmd = f"input text {_input_text_arg(text)}"
        await self._hass.async_add_executor_job(
            self._shell_blk, host, port, signer, cmd
        )
        return {"chars": len(text)}

    async def async_expand_notifications(self, host: str, port: int) -> dict[str, Any]:
        """Pull down the notification shade."""
        signer = await self._get_signer()
        await self._hass.async_add_executor_job(
            self._shell_blk, host, port, signer, "cmd statusbar expand-notifications"
        )
        return {}

    async def async_meminfo(self, host: str, port: int) -> dict[str, Any]:
        """Return ``dumpsys meminfo`` (memory usage + running apps)."""
        signer = await self._get_signer()
        out = await self._hass.async_add_executor_job(
            self._meminfo_blk, host, port, signer
        )
        return {"output": out}

    async def async_set_home(self, host: str, port: int) -> dict[str, Any]:
        """Make the app the device's default Home (launcher) activity."""
        signer = await self._get_signer()
        out = await self._hass.async_add_executor_job(
            self._run, host, port, signer,
            lambda d: _set_home(d, f"{APP_PACKAGE}/{APP_ACTIVITY}", APP_PACKAGE),
        )
        return {"output": out}

    async def async_unset_home(self, host: str, port: int) -> dict[str, Any]:
        """Remove the app as default Home — point Home at Android's blank
        ``FallbackHome`` so pressing Home does nothing (an empty screen)."""
        signer = await self._get_signer()
        out = await self._hass.async_add_executor_job(
            self._shell_blk,
            host,
            port,
            signer,
            "cmd package set-home-activity com.android.settings/.FallbackHome",
        )
        low = (out or "").lower()
        if "success" not in low and any(
            k in low for k in ("error", "exception", "failure", "not found")
        ):
            raise AdbError(
                "unset_home_failed",
                f"Couldn't unset the Home app: {out.strip() or 'no output'}",
            )
        return {"output": (out or "").strip()}

    async def async_home_ar(self, host: str, port: int) -> dict[str, Any]:
        """Make our app the Home screen and open it. Nothing of the maker's
        software is switched off (that's "Use AR app (HDL off)")."""
        signer = await self._get_signer()

        def fn(d: Any) -> dict[str, Any]:
            if not _installed(d, APP_PACKAGE):
                raise AdbError("not_installed", "Install the app first, then make it the Home screen.")
            log = [_set_home(d, f"{APP_PACKAGE}/{APP_ACTIVITY}", APP_PACKAGE)]
            d.shell(f"am start -n {APP_PACKAGE}/{APP_ACTIVITY}")
            log.append("HDL is left on.")
            # does HDL take Home back by itself? look again a few seconds later
            time.sleep(5)
            home = _home_now(d)
            log.append(f"Home 5 s later: {home or 'none'}")
            if APP_PACKAGE not in home:
                log.append(
                    "HDL took the Home screen back by itself: with HDL on, HDL keeps Home. "
                    "Run “Boot check” and send me the log."
                )
            return {"output": "\n".join(log)}

        return await self._hass.async_add_executor_job(self._run, host, port, signer, fn)

    async def async_boot_check(self, host: str, port: int) -> dict[str, Any]:
        """Why is the app gone / the panel stuck on the boot logo after a
        reboot? Reads only: is the app still there, who is Home, which of the
        maker's apps run and may remove apps, and this boot's log about it.
        Run it right after a reboot (the log only covers the current boot)."""
        signer = await self._get_signer()

        def fn(d: Any) -> dict[str, Any]:
            out: list[str] = []

            def sh(title: str, cmd: str, limit: int = 40) -> None:
                try:
                    res = (d.shell(cmd) or "").strip()
                except Exception as err:  # noqa: BLE001 - keep going, report it
                    res = f"({type(err).__name__})"
                lines = [ln.rstrip() for ln in res.splitlines() if ln.strip()]
                out.append(f"== {title}")
                out.extend(lines[-limit:] or ["(nothing)"])

            sh("panel", "getprop ro.product.model; getprop ro.build.display.id; getprop ro.build.version.release; "
               "echo boot_completed=$(getprop sys.boot_completed); echo uptime=$(cut -d' ' -f1 /proc/uptime)s")
            sh("AR app installed?", f"pm list packages {APP_PACKAGE}; echo '-- incl. removed but kept:'; "
               f"pm list packages -u {APP_PACKAGE}")
            sh("AR app details", f"dumpsys package {APP_PACKAGE} | grep -E "
               "'versionName|codePath|installerPackageName|firstInstallTime|lastUpdateTime|installed=|enabled=' | head -12")
            sh("Home now", "cmd package resolve-activity --brief -a android.intent.action.MAIN "
               "-c android.intent.category.HOME | tail -1; cmd role get-role-holders android.app.role.HOME")
            sh("disabled apps", "pm list packages -d")
            sh("HDL apps", "pm list packages com.hdl; ps -A -o NAME 2>/dev/null | grep -i hdl || ps | grep -i hdl")
            sh("HDL apps allowed to remove/install apps",
               "for p in $(pm list packages com.hdl | cut -d: -f2); do "
               "g=$(dumpsys package $p | grep -oE 'android.permission.(DELETE_PACKAGES|INSTALL_PACKAGES|CLEAR_APP_USER_DATA)[^,]*granted=true' | sort -u | tr '\\n' ' '); "
               "f=$(dumpsys package $p | grep -m1 -oE 'pkgFlags=\\[[^]]*\\]'); echo \"$p: $f $g\"; done")
            sh("scripts on the panel that remove apps",
               "su 0 sh -c \"grep -rlsE 'pm (uninstall|disable|hide)|whitelist|white_list|allowlist' "
               "/system/bin /system/xbin /system/etc /vendor/bin /vendor/etc /oem /odm 2>/dev/null | head -20\"")
            sh("this boot's log about the AR app / HDL / Home",
               "logcat -d -b main,system,events 2>/dev/null | grep -iE "
               f"'{APP_PACKAGE.replace('.', '[.]')}|PackageManager.*(remov|delet|uninstall|disabl)|"
               "pm_package|package_removed|PACKAGE_REMOVED|deletePackage|uninstall|FallbackHome|"
               "boot_progress_enable_screen|BootAnimation|com[.]hdl' | tail -120", limit=120)
            return {"output": "\n".join(out)}

        return await self._hass.async_add_executor_job(self._run, host, port, signer, fn)

    async def async_home_vendor(self, host: str, port: int) -> dict[str, Any]:
        """Make the maker's launcher (HDL) the Home screen again and press Home.
        Nothing is switched on or off; our app stays installed."""
        signer = await self._get_signer()

        def fn(d: Any) -> dict[str, Any]:
            found = _vendor(d)
            if not found:
                raise AdbError("no_hdl", "This panel has no HDL screen to go back to.")
            name, _pkgs, home = found
            pkg = home.split("/", 1)[0]
            disabled = d.shell(f"pm list packages -d {pkg}") or ""
            if f"package:{pkg}" in disabled:
                raise AdbError(
                    "vendor_off",
                    f"The {name} screen is switched off on this panel (“Use AR app” did that): "
                    f"use “Back to {name} screen” instead, which switches it on again.",
                )
            log = [m for m in [_kiosk_unlock(d)] if m]  # its screen can't show while ours is locked in
            log.append(_set_home(d, home, pkg))
            d.shell("input keyevent 3")
            return {"output": "\n".join(log)}

        return await self._hass.async_add_executor_job(self._run, host, port, signer, fn)

    async def async_hdl_takeover(self, host: str, port: int) -> dict[str, Any]:
        """HDL Source 10: hand the panel to our app. Disables HDL's app and
        launcher (they grab the knob and the Home button), makes our app Home
        and opens it — so every reboot lands straight in the panel UI."""
        signer = await self._get_signer()

        def fn(d: Any) -> dict[str, Any]:
            if not _installed(d, APP_PACKAGE):
                raise AdbError("not_installed", "Install the app first, then take the panel over.")
            log = []
            # HDL's own software is what switches network ADB on (port 8555,
            # service.adb.tcp.port) at boot. Before switching HDL off, make
            # adbd listen on the same port by itself — otherwise the next
            # reboot leaves the panel with no network ADB at all.
            adb_port = (d.shell("getprop service.adb.tcp.port") or "").strip() or str(port)
            d.shell(f"su 0 setprop persist.adb.tcp.port {adb_port}")
            got = (d.shell("getprop persist.adb.tcp.port") or "").strip()
            if got != adb_port:
                raise AdbError(
                    "adb_keep_failed",
                    f"Couldn't make network ADB (port {adb_port}) permanent on this panel "
                    "(no root), so HDL was left on — switching it off would lock ADB out "
                    "after the next reboot.",
                )
            found = _vendor(d)
            name, pkgs = (found[0], found[1]) if found else ("the panel's own software", [])
            log.append(f"Network ADB stays on port {adb_port} without {name}.")
            d.shell("settings put global adb_enabled 1")
            # our app first: Home, kiosk lock, open
            log.append(_set_home(d, f"{APP_PACKAGE}/{APP_ACTIVITY}", APP_PACKAGE))
            msg = _kiosk_lock(d)[1]
            if msg:
                log.append(msg)
            d.shell(f"am start -n {APP_PACKAGE}/{APP_ACTIVITY}")
            # Then the maker's software off, LAST, one package at a time, the
            # launcher/main app at the very end. Switching it off can drop this
            # ADB connection (the HDL Source 10 did): what is done stays done,
            # and network ADB was already made permanent above.
            if pkgs:
                order = [p for p in pkgs if p not in (AKUBELA_APP, HDL_LAUNCHER)] + [p for p in pkgs if p in (AKUBELA_APP, HDL_LAUNCHER)]
                try:
                    for pkg in order:
                        log.append(f"{pkg}: " + (d.shell(f"pm disable-user --user 0 {pkg}") or "").strip())
                    d.shell(f"setprop service.adb.tcp.port {adb_port}")
                    # Switching a Home app off clears the Home choice, and then
                    # Android's setup wizard (com.android.provision, left on in
                    # the Akubela software) takes Home after a reboot: mark the
                    # panel set up, switch the wizard off, and make ours Home again.
                    d.shell("settings put global device_provisioned 1; settings put secure user_setup_complete 1")
                    if name in ("Akubela", "TDX") and _installed(d, "com.android.provision"):
                        log.append("com.android.provision: " + (d.shell("pm disable-user --user 0 com.android.provision") or "").strip())
                    log.append(_set_home(d, f"{APP_PACKAGE}/{APP_ACTIVITY}", APP_PACKAGE, strict=False))
                    if name == "Akubela":
                        # their background services too (Home Assistant, KNX, SIP, SSH, cloud…)
                        log.append(_run_panel_script(d, "aku-clean.sh"))
                    d.shell(f"am start -n {APP_PACKAGE}/{APP_ACTIVITY}")
                except Exception as err:  # noqa: BLE001 - the connection went with the maker's software
                    log.append(f"The ADB connection dropped while switching {name} off ({type(err).__name__}): reconnect in a few seconds and check.")
            return {"output": "\n".join(log)}

        return await self._hass.async_add_executor_job(self._run, host, port, signer, fn)

    async def async_hdl_restore(self, host: str, port: int) -> dict[str, Any]:
        """HDL Source 10: back to the stock HDL screen. Re-enables HDL's app and
        launcher, makes HDL's launcher Home again and presses Home."""
        signer = await self._get_signer()

        def fn(d: Any) -> dict[str, Any]:
            found = _vendor(d)
            if not found:
                raise AdbError("no_hdl", "This panel has no HDL or Akubela software to go back to.")
            name, pkgs, home = found
            log = [m for m in [_kiosk_unlock(d)] if m]  # the maker's screen can't show while locked
            if name == "Akubela":
                # "Optimise panel" removes these for the panel's user: put them back first
                for pkg in AKUBELA_PKGS:
                    d.shell(f"pm install-existing --user 0 {pkg} >/dev/null 2>&1")
                pkgs = [p for p in AKUBELA_PKGS if _installed(d, p)]
                log.append(_run_panel_script(d, "aku-restore.sh"))
                if _installed(d, "com.android.provision"):
                    d.shell("pm enable com.android.provision")
            elif name == "TDX" and _installed(d, "com.android.provision"):
                d.shell("pm enable com.android.provision")
            log += [f"{pkg}: " + (d.shell(f"pm enable {pkg}") or "").strip() for pkg in pkgs]
            log.append(_set_home(d, home, home.split("/", 1)[0]))
            d.shell("input keyevent 3")
            return {"output": "\n".join(log)}

        return await self._hass.async_add_executor_job(self._run, host, port, signer, fn)

    async def async_camera_check(self, host: str, port: int, url: str) -> dict[str, Any]:
        """Why won't an RTSP camera play on this panel? Checked from two places at
        once, so nobody needs to be on site:
        * the panel (ADB): app version, can IT reach the camera (an RTSP OPTIONS
          sent from the panel's own network), and the player's errors in its log;
        * Home Assistant: a full player-style session with the camera (login,
          stream description, video over TCP, a few seconds of video)."""
        from .rtsp_probe import parse_url, probe

        try:
            cam = parse_url(url)
        except ValueError as err:
            raise AdbError("bad_request", str(err)) from err
        if not re.match(r"^[A-Za-z0-9.\-]+$", cam["host"]):
            raise AdbError("bad_request", "That camera address doesn't look like an IP or host name.")
        signer = await self._get_signer()

        def panel(d: Any) -> list[str]:
            out = ["== From the panel =="]
            ver = d.shell(f"dumpsys package {APP_PACKAGE} | grep -m1 versionName") or ""
            out.append("App: " + (ver.strip().replace("versionName=", "v") or "not installed"))
            ips = re.findall(r"^\d+:\s+(\S+)\s+inet\s+(\S+)", d.shell("ip -4 -o addr show 2>/dev/null") or "", re.M)
            out.append("Panel: " + (d.shell("getprop ro.product.model") or "").strip()
                       + " · " + (", ".join(f"{i} {a}" for i, a in ips if i != "lo") or "IP ?"))
            # an RTSP OPTIONS from the panel's own network position: proves it can reach the camera
            h, p = cam["host"], cam["port"]
            req = f"OPTIONS rtsp://{h}:{p}/ RTSP/1.0\\r\\nCSeq: 1\\r\\n\\r\\n"
            ans = d.shell(f"printf '{req}' | toybox timeout 5 toybox nc {h} {p} 2>&1", read_timeout_s=15) or ""
            first = ans.strip().splitlines()[0] if ans.strip() else ""
            if first.startswith("RTSP/"):
                out.append(f"✓ The panel reaches the camera {h}:{p} (it answers \"{first}\")")
            else:
                out.append(f"✗ The panel can NOT reach the camera {h}:{p}" + (f" ({first[:80]})" if first else " (no answer)"))
            log = d.shell("logcat -d -v time ARRtsp:V ExoPlayerImplInternal:V RtspClient:V RtspMediaPeriod:V RtpH265Reader:V RtpH264Reader:V MediaCodecRenderer:W MediaCodecVideoRenderer:W *:S", read_timeout_s=20) or ""
            lines = [ln for ln in log.splitlines() if ln.strip() and not ln.startswith("-----")]
            # keep the start of each error and its causes, not whole Java stack traces
            keep = [ln for ln in lines if "\tat " not in ln and " at androidx." not in ln and " at java." not in ln and " at android." not in ln]
            # the H.264 / H.265 readers warn once per dropped packet: count those, keep a sample
            drops = [ln for ln in keep if "Dropping packet" in ln or "unexpected sequence" in ln]
            keep = [ln for ln in keep if ln not in drops] + drops[-3:]
            keep = [re.sub(r"(rtsps?://[^:@/\s]*:)[^@\s]*@", r"\1****@", ln) for ln in keep][-25:]
            if drops:
                out.append(f"✗ The player dropped {len(drops)} video packet(s) it couldn't fit together — broken pictures (green / old frames) come from this")
            out.append("Player log (latest):" if keep else "Player log: nothing logged (has the camera page been opened since the panel started?)")
            out += ["  " + ln[:220] for ln in keep]
            return out

        async def from_panel() -> list[str]:
            try:
                return await self._hass.async_add_executor_job(self._run, host, port, signer, panel)
            except AdbError as err:
                return ["== From the panel ==", f"✗ ADB: {err}"]
            except Exception as err:  # noqa: BLE001
                return ["== From the panel ==", f"✗ ADB: {type(err).__name__}: {err}"]

        async def from_ha() -> list[str]:
            return ["== From Home Assistant =="] + await probe(url)

        a, b = await asyncio.gather(from_panel(), from_ha())
        return {"output": "\n".join(a + [""] + b)}

    async def async_optimise(self, host: str, port: int, undo: bool = False) -> dict[str, Any]:
        """Any panel: switch off what a wall panel never uses (browser, gallery,
        printing, SMS …), remove the Akubela apps its firmware keeps running
        although they are off, stop Rockchip's AI-chip server, animations off.
        Nothing is deleted; ``undo`` puts it all back (scripts/ar-*optimise.sh)."""
        signer = await self._get_signer()

        def fn(d: Any) -> dict[str, Any]:
            out = _run_panel_script(d, "ar-unoptimise.sh" if undo else "ar-optimise.sh")
            return {"output": out}

        return await self._hass.async_add_executor_job(self._run, host, port, signer, fn)

    async def async_uninstall(self, host: str, port: int) -> dict[str, Any]:
        """Remove the app from the panel. On an HDL Source 10 the HDL screen is
        restored first, so the panel is back to stock afterwards."""
        signer = await self._get_signer()

        def fn(d: Any) -> dict[str, Any]:
            # a device-owner app can't be uninstalled: release the lock first
            log = [m for m in [_kiosk_unlock(d)] if m]
            found = _vendor(d)
            if found:
                name, pkgs, home = found
                for pkg in pkgs:
                    log.append(f"{pkg}: " + (d.shell(f"pm enable {pkg}") or "").strip())
                log.append(_set_home(d, home, home.split("/", 1)[0], strict=False))
            if not _installed(d, APP_PACKAGE):
                log.append("The app isn't installed.")
            else:
                out = (d.shell(f"pm uninstall {APP_PACKAGE}") or "").strip()
                if "Success" not in out:
                    raise AdbError("uninstall_failed", f"Couldn't uninstall the app: {out or 'no output'}")
                log.append("Uninstalled the app.")
            d.shell("input keyevent 3")
            return {"output": "\n".join(log)}

        return await self._hass.async_add_executor_job(self._run, host, port, signer, fn)

    async def async_kiosk(self, host: str, port: int, lock: bool) -> dict[str, Any]:
        """Lock the panel in (kiosk) or release it, from Device Setup."""
        signer = await self._get_signer()

        def fn(d: Any) -> dict[str, Any]:
            if not _installed(d, APP_PACKAGE):
                raise AdbError("not_installed", "Install the app first.")
            if lock:
                if not (_is_source7(d) or _is_tdx(d)):
                    raise AdbError("kiosk_failed", "The kiosk lock is for the HDL Source 7 and the TDX panel only.")
                ok, msg = _kiosk_lock(d)
                if not ok:
                    raise AdbError("kiosk_failed", msg)
                return {"output": msg}
            return {"output": _kiosk_unlock(d) or "The panel wasn't locked."}

        return await self._hass.async_add_executor_job(self._run, host, port, signer, fn)

    # --- panel time (Device Setup / Update > Panel time) -----------------------
    async def async_time_status(self, host: str, port: int) -> dict[str, Any]:
        """The panel's own clock, time zone and automatic-time setting."""
        signer = await self._get_signer()

        def fn(d: Any) -> dict[str, Any]:
            return _time_status(d)

        return await self._hass.async_add_executor_job(self._run, host, port, signer, fn)

    async def async_set_time(
        self, host: str, port: int, tz: str | None, epoch: float | None, auto: bool | None
    ) -> dict[str, Any]:
        """Set the panel's Android clock and time zone. ``epoch`` None = Home
        Assistant's clock at the moment it is set. Needs root (``su``), the same
        as the HDL takeover."""
        signer = await self._get_signer()

        def fn(d: Any) -> dict[str, Any]:
            return _set_time(d, tz, epoch, auto)

        return await self._hass.async_add_executor_job(self._run, host, port, signer, fn)

    async def async_reset_app(self, host: str, port: int) -> dict[str, Any]:
        """Wipe the app's data (broker, login, panel ID, cached pages, licence
        key) and reopen it on its setup screen — for a panel moving to another
        site / Home Assistant. Home stays pointed at the app."""
        signer = await self._get_signer()

        def fn(d: Any) -> dict[str, Any]:
            if not _installed(d, APP_PACKAGE):
                raise AdbError("not_installed", "The app isn't installed on this panel.")
            was_locked = _kiosk_unlock(d) is not None  # a locked app's data can't be cleared
            out = (d.shell(f"pm clear {APP_PACKAGE}") or "").strip()
            if "Success" not in out:
                raise AdbError("reset_failed", f"Couldn't reset the app: {out or 'no output'}")
            d.shell(f"am start -n {APP_PACKAGE}/{APP_ACTIVITY}")
            if was_locked:
                out += "\n" + _kiosk_lock(d)[1]
            elif _is_source7(d):
                _navbar_hide(d)  # the Source 7's bar stays gone after a reset
            return {"output": out}

        return await self._hass.async_add_executor_job(self._run, host, port, signer, fn)

    async def async_reboot(self, host: str, port: int) -> dict[str, Any]:
        """Reboot the device. The ADB socket drops as it goes down — that IS the
        success signal, so a read error after the command is sent is expected."""
        signer = await self._get_signer()
        await self._hass.async_add_executor_job(self._reboot_blk, host, port, signer)
        return {}

    def _reboot_blk(self, host: str, port: int, signer: Any) -> None:
        def fn(device: Any) -> None:
            try:
                device.shell(
                    "setprop persist.adb.tcp.port 5555; svc power reboot; reboot",
                    read_timeout_s=4,
                )
            except Exception:  # noqa: BLE001 — socket drops as the device reboots
                pass

        self._run(host, port, signer, fn)

    def _shell_blk(self, host: str, port: int, signer: Any, cmd: str) -> str:
        return self._run(host, port, signer, lambda d: d.shell(cmd) or "")

    def _meminfo_blk(self, host: str, port: int, signer: Any) -> str:
        text = self._run(
            host,
            port,
            signer,
            lambda d: d.shell("dumpsys meminfo", read_timeout_s=20) or "",
        )
        # Cap the payload so a huge dump can't bloat the WS frame.
        return text[:60000]

    # --- install / update ---------------------------------------------------
    async def async_install_latest(
        self, host: str, port: int, progress: Callable[..., None] | None = None
    ) -> dict[str, Any]:
        """Install/update the app by having the PANEL download the release APK.

        adb-shell's pure-python file *push* hangs on this device's adbd, but plain
        shell commands are reliable and the panel has ``curl`` + working TLS to
        GitHub â so the panel fetches the APK itself and ``pm install``s it.
        ``progress(message, level)`` (optional) is called on the event loop with
        short human-readable steps so the GUI can show a live log.
        """
        say = progress or (lambda *a, **k: None)
        loop = self._hass.loop

        def bar(pct: float, stage: str, detail: str | None = None) -> None:
            """Progress tick for the Setup tool's bar (no log line)."""
            say(None, "info", pct=round(max(0.0, min(100.0, pct)), 1), stage=stage, detail=detail)

        def mb(n: int) -> str:
            return f"{n / 1048576:.1f} MB"

        bar(1, "Finding the latest release")
        signer = await self._get_signer()
        # Which APK: Android 5/6 panels get the legacy build (own browser engine)
        sdk_raw = await self._hass.async_add_executor_job(
            self._shell_blk, host, port, signer, "getprop ro.build.version.sdk"
        )
        sdk = int(sdk_raw.strip()) if sdk_raw.strip().isdigit() else 99
        legacy = sdk < LEGACY_BELOW_SDK
        if legacy:
            say(f"Android SDK {sdk}: this panel gets the legacy build (bundled browser engine).")
        say("Finding the latest release on GitHub…")
        url, tag, name = await self._fetch_latest_apk_url(legacy=legacy)
        staged: release_access.StagedApk | None = None
        if release_access.is_private_asset_url(url):
            # Private release: Home Assistant fetches it with the saved token
            # and the panel downloads it from Home Assistant (never the token).
            say(f"Latest release {tag} — {name}. Home Assistant is downloading it…")

            def stage_tick(got: int, tot: int) -> None:
                bar(1 + 4 * (got / tot if tot else 0.5), "Home Assistant is downloading the app",
                    f"{mb(got)} / {mb(tot)}" if tot else mb(got))

            try:
                staged = await release_access.async_stage_apk(self._hass, url, name, stage_tick)
            except release_access.ReleaseError as err:
                raise AdbError(err.code, str(err)) from err
            url = staged.url
            total = staged.size
            say(f"Downloaded {name} ({mb(total)}) in Home Assistant.", "ok")
        else:
            total = await self._asset_size(url)
            say(f"Latest release {tag} — {name}" + (f" ({mb(total)})." if total else "."), "ok")
        bar(5, "Connecting to the panel")

        say(f"Panel is downloading {name} from " + ("Home Assistant…" if staged else "GitHub…"))
        bar(6, "Panel is downloading the app", f"0 / {mb(total)}" if total else None)
        try:
            dl = asyncio.ensure_future(
                self._hass.async_add_executor_job(self._download_blk, host, port, signer, url)
            )
            # curl is silent: watch the file grow on the panel over a second
            # ADB connection while it downloads.
            while not dl.done():
                await asyncio.wait({dl}, timeout=1.0)
                if dl.done():
                    break
                got = await self._hass.async_add_executor_job(self._remote_size_blk, host, port, signer)
                if got and total:
                    bar(6 + 64 * min(1.0, got / total), "Panel is downloading the app", f"{mb(got)} / {mb(total)}")
                elif got:
                    bar(30, "Panel is downloading the app", mb(got))
            size = dl.result()
            bar(70, "Downloaded to the panel", mb(size))
            say(f"Downloaded {size:,} bytes to the panel.", "ok")
        except AdbError as err:
            if err.code != "no_curl":
                raise
            # Panels without curl (e.g. HDL Source 10): Home Assistant downloads
            # the APK and sends it over the ADB shell in small base64 chunks.
            say("This panel has no curl — Home Assistant downloads the APK and sends it over ADB…")

            def dl_tick(got: int, tot: int) -> None:
                bar(6 + 24 * (got / tot if tot else 0.5), "Home Assistant is downloading the app", f"{mb(got)} / {mb(tot)}" if tot else mb(got))

            data = staged.data if staged else await self._download_in_ha(url, dl_tick)
            say(f"Downloaded {len(data):,} bytes in Home Assistant. Sending to the panel…", "ok")

            def push_tick(sent: int, tot: int) -> None:
                loop.call_soon_threadsafe(
                    lambda: bar(30 + 40 * sent / tot, "Sending the app to the panel", f"{mb(sent)} / {mb(tot)}")
                )

            size = await self._hass.async_add_executor_job(
                self._push_b64_blk, host, port, signer, data, push_tick
            )
            bar(70, "Sent to the panel", mb(size))
            say(f"Sent {size:,} bytes to the panel.", "ok")

        say("Installing on the panel (pm install)…")
        bar(75, "Installing on the panel")
        inst = asyncio.ensure_future(
            self._hass.async_add_executor_job(self._pm_install_blk, host, port, signer)
        )
        # pm install gives no progress: creep towards 95 % while it runs
        pct = 75.0
        while not inst.done():
            await asyncio.wait({inst}, timeout=1.0)
            if not inst.done():
                pct = min(95.0, pct + (95.0 - pct) * 0.12)
                bar(pct, "Installing on the panel")
        version = inst.result()
        # kiosk: make the app device owner and lock the panel in (no Home /
        # Recents / Clear all on swipe up). Never fails the install.
        bar(97, "Locking the panel")
        try:
            ok, kmsg = await self._hass.async_add_executor_job(self._run, host, port, signer, _kiosk_lock)
            if kmsg:  # empty on anything but a Source 7: nothing was touched
                say(kmsg, "ok" if ok else "info")
        except Exception as err:  # noqa: BLE001
            say(f"Panel not locked: {err}", "info")
        bar(100, "Done", f"v{version}" if version else None)
        say(
            f"Installed{(' v' + version) if version else ''} and launched — done.",
            "ok",
        )
        return {"tag": tag, "asset": name, "version": version, "package": APP_PACKAGE}

    async def async_latest_release(self, legacy: bool = False) -> tuple[str, str, str]:
        """(apk download URL, tag, asset name) of the latest GitHub release,
        the standard or the legacy (Android 5) APK. Used by the update entity,
        which installs over MQTT (no ADB)."""
        return await self._fetch_latest_apk_url(legacy=legacy)

    async def async_latest_version(self) -> dict[str, Any]:
        """Latest available app version from the GitHub release (no ADB needed)."""
        _url, tag, name = await self._fetch_latest_apk_url()
        version = tag[1:] if tag.startswith("v") else tag
        return {"tag": tag, "version": version or None, "asset": name}

    async def _fetch_latest_apk_url(self, legacy: bool = False) -> tuple[str, str, str]:
        """Return (download_url, tag, asset_name) for the latest release APK.

        Tries GitHub's REST API first, then falls back to the public release
        pages. The API allows only 60 anonymous requests an hour per public IP,
        which a shared/CGNAT connection can exhaust on its own (it then answers
        403); the web pages have no such limit.
        """
        session = async_get_clientsession(self._hass)
        if release_access.has_token(self._hass):
            # Private repo: only the authenticated API can see it (no web
            # fallback). The returned URL is the API asset URL, which needs the
            # token — callers stage it in HA (release_access.async_stage_apk).
            return await self._latest_from_api(session, legacy, private=True)
        try:
            return await self._latest_from_api(session, legacy)
        except AdbError as err:
            if err.code == "no_asset":
                raise
            api_err = err
            _LOGGER.debug("GitHub API lookup failed (%s); trying the release page", err)
        # github.com's pages send headers (Content-Security-Policy) longer than
        # aiohttp's default 8190-byte limit, so this lookup gets its own session
        # with room for them.
        try:
            async with _github_session() as big:
                return await self._latest_from_web(big, legacy)
        except AdbError as err:
            if err.code in ("no_asset", "no_release"):
                raise
            raise AdbError("github", f"{err} (GitHub API: {api_err})") from err

    async def _latest_from_api(
        self, session: aiohttp.ClientSession, legacy: bool = False, private: bool = False
    ) -> tuple[str, str, str]:
        api = (
            f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}"
            "/releases/latest"
        )
        headers = (
            release_access.auth_headers(self._hass)
            if private
            else {
                "Accept": "application/vnd.github+json",
                "User-Agent": "ar-nspanel-pro-integration",
            }
        )
        try:
            async with session.get(
                api, headers=headers, timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status != 200:
                    if private:
                        # The token itself never shows; the status code says what to fix.
                        why = {
                            401: "GitHub refused the access token (expired or revoked). Enter a new one under Private release access.",
                            403: "GitHub refused the access token for this repo (missing Contents: read permission, or rate-limited). Check the token under Private release access.",
                            404: "GitHub has no published release to install (only a draft or pre-release?), or the token can't see the repo.",
                        }.get(resp.status, f"Couldn't reach the app release (GitHub HTTP {resp.status}). Try again later.")
                        raise AdbError("github", why)
                    raise AdbError(
                        "github", f"GitHub API returned HTTP {resp.status}."
                    )
                data = await resp.json()
        except asyncio.TimeoutError as err:
            raise AdbError(
                "github", "Timed out contacting GitHub for the latest release."
            ) from err
        except aiohttp.ClientError as err:
            raise AdbError("github", f"Couldn't reach GitHub: {err}") from err

        tag = data.get("tag_name") or "latest"
        asset = next(
            (
                a
                for a in (data.get("assets") or [])
                if str(a.get("name", "")).lower().endswith(".apk")
                and _is_legacy_apk(str(a.get("name", ""))) == legacy
            ),
            None,
        )
        if not asset:
            kind = "legacy (Android 5) " if legacy else ""
            raise AdbError(
                "no_asset", f"The latest release ({tag}) has no {kind}.apk asset attached."
            )
        return (
            str(asset.get("url") if private else asset.get("browser_download_url")),
            tag,
            str(asset.get("name") or "app-release.apk"),
        )

    async def _latest_from_web(self, session: aiohttp.ClientSession, legacy: bool = False) -> tuple[str, str, str]:
        """No-API lookup: /releases/latest redirects to /releases/tag/<tag>, and
        the release's asset list is served at /releases/expanded_assets/<tag>."""
        base = f"https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}"
        headers = {"User-Agent": "ar-nspanel-pro-integration"}
        timeout = aiohttp.ClientTimeout(total=30)
        try:
            async with session.get(
                f"{base}/releases/latest", headers=headers, timeout=timeout
            ) as resp:
                final = str(resp.url)
                status = resp.status
            if status != 200 or "/releases/tag/" not in final:
                raise AdbError(
                    "no_release",
                    "No public GitHub release found for the app yet. Publish a "
                    f"release with an .apk asset on {GITHUB_OWNER}/{GITHUB_REPO} "
                    "(and make the repo public) first.",
                )
            tag = unquote(final.rsplit("/releases/tag/", 1)[1].split("?")[0].strip("/"))
            async with session.get(
                f"{base}/releases/expanded_assets/{tag}", headers=headers, timeout=timeout
            ) as resp:
                html = await resp.text() if resp.status == 200 else ""
        except asyncio.TimeoutError as err:
            raise AdbError(
                "github", "Timed out contacting GitHub for the latest release."
            ) from err
        except aiohttp.ClientError as err:
            raise AdbError("github", f"Couldn't reach GitHub: {err}") from err

        paths = [
            p
            for p in re.findall(r'href="(/[^"]+/releases/download/[^"]+?\.apk)"', html, re.IGNORECASE)
            if _is_legacy_apk(p.rsplit("/", 1)[-1]) == legacy
        ]
        if not paths:
            kind = "legacy (Android 5) " if legacy else ""
            raise AdbError(
                "no_asset", f"The latest release ({tag}) has no {kind}.apk asset attached."
            )
        path = paths[0]
        return (
            "https://github.com" + path,
            tag,
            unquote(path.rsplit("/", 1)[-1]),
        )

    def _download_blk(self, host: str, port: int, signer: Any, url: str) -> int:
        """On the panel: curl the APK to a temp path. Returns the byte size."""
        remote = _REMOTE_APK
        # -L follows the release -> CDN redirect; --fail => nonzero on HTTP error.
        # curl is silent (-sS): nothing is read until it finishes, so the read
        # timeout must cover the whole download (see _DL_READ_TIMEOUT).
        cmd = (
            f"rm -f {remote}; "
            f"curl -L -sS --fail -m {_DL_CURL_TIMEOUT} -o {remote} '{url}' "
            f"&& echo __DL_OK__ $(wc -c < {remote}) "
            f"|| echo __DL_FAIL__ rc=$?"
        )
        out = self._run(
            host,
            port,
            signer,
            lambda d: d.shell(cmd, read_timeout_s=_DL_READ_TIMEOUT) or "",
            xfer=True,
        )
        if "__DL_OK__" not in out:
            low = out.lower()
            if "rc=127" in low or "curl: not found" in low or "curl: inaccessible" in low:
                raise AdbError("no_curl", "The panel has no curl.")
            raise AdbError(
                "download",
                "The panel couldn't download the APK from GitHub — check its "
                f"internet access. (curl: {out.strip()[:200] or 'no output'})",
            )
        sizes = [int(tok) for tok in out.split() if tok.isdigit()]
        return sizes[-1] if sizes else 0

    async def _asset_size(self, url: str) -> int:
        """Size of the release APK in bytes (0 if unknown), for the progress bar."""
        try:
            async with _github_session() as session, session.head(
                url,
                allow_redirects=True,
                headers={"User-Agent": "ar-nspanel-pro-integration"},
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                return int(resp.headers.get("Content-Length") or 0) if resp.status == 200 else 0
        except Exception:  # noqa: BLE001 - only for the bar
            return 0

    def _remote_size_blk(self, host: str, port: int, signer: Any) -> int:
        """Bytes downloaded so far on the panel (0 if not started)."""
        try:
            out = self._run(host, port, signer, lambda d: d.shell(f"wc -c < {_REMOTE_APK} 2>/dev/null") or "")
            nums = [int(t) for t in out.split() if t.isdigit()]
            return nums[-1] if nums else 0
        except Exception:  # noqa: BLE001 - only for the bar
            return 0

    async def _download_in_ha(self, url: str, tick: Callable[[int, int], None] | None = None) -> bytes:
        """Fallback: download the release APK in Home Assistant itself."""
        try:
            async with _github_session() as session, session.get(
                url,
                headers={"User-Agent": "ar-nspanel-pro-integration"},
                timeout=aiohttp.ClientTimeout(total=180),
            ) as resp:
                if resp.status != 200:
                    raise AdbError(
                        "download", f"GitHub returned HTTP {resp.status} for the APK."
                    )
                total = int(resp.headers.get("Content-Length") or 0)
                buf = bytearray()
                last = -1
                async for chunk in resp.content.iter_chunked(65536):
                    buf.extend(chunk)
                    if len(buf) > _PUSH_MAX_BYTES:
                        break
                    step = int(len(buf) * 20 / total) if total else len(buf) // 524288
                    if tick and step != last:
                        last = step
                        tick(len(buf), total)
                data = bytes(buf)
        except asyncio.TimeoutError as err:
            raise AdbError("download", "Timed out downloading the APK.") from err
        except aiohttp.ClientError as err:
            raise AdbError("download", f"Couldn't download the APK: {err}") from err
        if len(data) > _PUSH_MAX_BYTES:
            raise AdbError("download", f"The APK is unexpectedly large ({len(data):,} bytes).")
        if not data.startswith(b"PK"):
            raise AdbError("download", "The downloaded file isn't an APK.")
        return data

    def _push_b64_blk(
        self, host: str, port: int, signer: Any, data: bytes,
        tick: Callable[[int, int], None] | None = None,
    ) -> int:
        """Write ``data`` to the panel through plain shell commands.

        adb-shell's file push hangs on some panels' adbd, so the APK goes over
        as base64 text in small ``echo … | base64 -d >> file`` chunks — only
        needs the toybox ``base64`` every modern Android ships.
        """
        remote = _REMOTE_APK

        def fn(device: Any) -> int:
            probe = device.shell(
                f"rm -f {remote}; command -v base64 >/dev/null && echo __B64_OK__"
            ) or ""
            if "__B64_OK__" not in probe:
                raise AdbError(
                    "no_base64",
                    "The panel has neither curl nor base64, so it can't receive the "
                    "APK this way. Install it from a PC instead: "
                    "adb install -r ar-nspanel-pro-X.Y.Z.apk",
                )
            every = max(1, len(data) // _PUSH_CHUNK // 40)  # ~40 ticks
            for n, i in enumerate(range(0, len(data), _PUSH_CHUNK)):
                if tick and n % every == 0:
                    tick(i, len(data))
                chunk = base64.b64encode(data[i : i + _PUSH_CHUNK]).decode("ascii")
                out = device.shell(
                    f"echo '{chunk}' | base64 -d >> {remote} || echo __PUSH_FAIL__"
                ) or ""
                if "__PUSH_FAIL__" in out:
                    raise AdbError(
                        "push", f"Writing the APK on the panel failed at byte {i:,}."
                    )
            out = device.shell(f"wc -c < {remote}") or ""
            sizes = [int(tok) for tok in out.split() if tok.isdigit()]
            got = sizes[-1] if sizes else -1
            if got != len(data):
                raise AdbError(
                    "push",
                    f"The APK arrived incomplete on the panel ({got:,} of {len(data):,} bytes).",
                )
            return got

        return self._run(host, port, signer, fn, xfer=True)

    def _pm_install_blk(self, host: str, port: int, signer: Any) -> str | None:
        """On the panel: ``pm install`` the downloaded APK, then read its version."""
        remote = _REMOTE_APK

        def fn(device: Any) -> str | None:
            out = (
                device.shell(
                    f"pm install -r -d {remote}", read_timeout_s=_INSTALL_READ_TIMEOUT
                )
                or ""
            )
            try:  # best-effort on-device cleanup
                device.shell(f"rm -f {remote}")
            except Exception:  # noqa: BLE001
                pass
            if "Success" not in out:
                low = out.lower()
                if (
                    "signatures do not match" in low
                    or "update_incompatible" in low
                    or "inconsistent_certificates" in low
                ):
                    raise AdbError(
                        "signature",
                        "A build with a different signature is already installed. "
                        f"Uninstall it first (adb uninstall {APP_PACKAGE}) — that "
                        "wipes its local data — then install again.",
                    )
                raise AdbError(
                    "install_failed",
                    f"pm install failed: {out.strip() or 'unknown error'}",
                )
            version = _parse_version_name(
                device.shell(f"dumpsys package {APP_PACKAGE} | grep versionName")
            )
            # Keep ADB reachable once our app is in front: some panels (the HDL
            # Source 10) switch network ADB off when another app takes over.
            #  * WRITE_SECURE_SETTINGS lets the app put debugging back on and
            #    show its current ADB port on the setup screen.
            #  * With root, pin the current port so adbd opens it by itself.
            try:
                device.shell(f"pm grant {APP_PACKAGE} android.permission.WRITE_SECURE_SETTINGS")
                # Intercom: the microphone, so a call never stops to ask
                device.shell(f"pm grant {APP_PACKAGE} android.permission.RECORD_AUDIO")
                # Wi-Fi on the setup screen: finding networks needs location
                # access (Android 6+), so it never stops to ask on the panel
                device.shell(f"pm grant {APP_PACKAGE} android.permission.ACCESS_FINE_LOCATION")
                device.shell(f"pm grant {APP_PACKAGE} android.permission.ACCESS_COARSE_LOCATION")
                # Start on boot even when another launcher is Home (Android 10+
                # blocks a boot receiver from opening a screen without this).
                device.shell(f"appops set {APP_PACKAGE} SYSTEM_ALERT_WINDOW allow")
                # Over-the-air updates from HA's update entity (no ADB next time):
                # may install packages, and is its own installer of record
                # (Android 12+ then updates without asking).
                device.shell(f"appops set {APP_PACKAGE} REQUEST_INSTALL_PACKAGES allow")
                device.shell(f"pm set-installer {APP_PACKAGE} {APP_PACKAGE}")
                cur = (device.shell("getprop service.adb.tcp.port") or "").strip()
                if cur.isdigit() and int(cur) > 0:
                    device.shell(f"su 0 setprop persist.adb.tcp.port {cur}")
            except Exception:  # noqa: BLE001 — best effort
                pass
            try:  # best-effort: launch the app so the panel comes up ready
                device.shell(
                    f"monkey -p {APP_PACKAGE} -c android.intent.category.LAUNCHER 1"
                )
            except Exception:  # noqa: BLE001
                pass
            return version

        return self._run(host, port, signer, fn, xfer=True)


# --- panel time ---------------------------------------------------------------
_TZ_RE = re.compile(r"^[A-Za-z0-9_+\-]+(/[A-Za-z0-9_+\-]+){0,2}$")


def _time_status(d: Any) -> dict[str, Any]:
    raw = (d.shell("date +%s") or "").strip()
    try:
        epoch = int(raw)
    except ValueError:
        epoch = None
    tz = (d.shell("getprop persist.sys.timezone") or "").strip()
    auto = (d.shell("settings get global auto_time") or "").strip() == "1"
    return {"epoch": epoch, "tz": tz, "auto": auto, "ha_epoch": int(time.time())}


def _set_time(d: Any, tz: str | None, epoch: float | None, auto: bool | None) -> dict[str, Any]:
    """Set the panel's time zone and clock. Tries every way Android offers, as
    root, in order (they differ per Android version and panel), and checks the
    result; the error says what the panel answered when none of them work."""
    log: list[str] = []
    tried: list[str] = []
    if auto is not None:
        d.shell(f"settings put global auto_time {1 if auto else 0}")
        log.append("Internet time: " + ("on" if auto else "off"))
    if tz:
        if not _TZ_RE.match(tz):
            raise AdbError("bad_request", f"Not a time zone: {tz}")
        d.shell("settings put global auto_time_zone 0")
        for cmd in (
            f"su 0 cmd alarm set-timezone {tz}",  # Android 11+
            f"su 0 service call alarm 3 s16 {tz}",  # AlarmManager.setTimeZone (older)
            f"su 0 setprop persist.sys.timezone {tz}",
        ):
            out = (d.shell(cmd) or "").strip()
            if (d.shell("getprop persist.sys.timezone") or "").strip() == tz:
                break
            tried.append(f"{cmd} -> {out[:80] or 'no output'}")
        got = (d.shell("getprop persist.sys.timezone") or "").strip()
        if got != tz:
            raise AdbError(
                "time_failed",
                f"The panel didn't take the time zone (it still says '{got or 'nothing'}'); "
                "setting it needs root on the panel (su). Tried: " + " | ".join(tried),
            )
        log.append(f"Time zone → {tz}")

    def want() -> float:
        return epoch if epoch is not None else time.time()

    if epoch is not None or tz is not None:
        now = _panel_epoch(d)
        if now is None or abs(now - want()) > 3:
            for cmd_fn in (
                lambda: f"su 0 cmd alarm set-time {int(want() * 1000)}",  # Android 11+
                lambda: f"su 0 service call alarm 2 i64 {int(want() * 1000)}",  # AlarmManager.setTime (older)
                lambda: f"su 0 /system/bin/toybox date -u @{int(want())}",
                lambda: "su 0 /system/bin/toybox date -u " + time.strftime("%m%d%H%M%Y.%S", time.gmtime(want())),
                lambda: "su 0 date -u " + time.strftime("%m%d%H%M%Y.%S", time.gmtime(want())),
            ):
                cmd = cmd_fn()
                out = (d.shell(cmd) or "").strip()
                now = _panel_epoch(d)
                if now is not None and abs(now - want()) <= 10:
                    break
                tried.append(f"{cmd.split(' @')[0].split(' 1')[0]} -> {out[:80] or 'no output'}")
        if now is None or abs(now - want()) > 10:
            raise AdbError(
                "time_failed",
                "The panel's clock didn't change; setting it needs root on the panel (su). Tried: "
                + " | ".join(tried),
            )
        log.append("Clock → " + time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(now)))
    st = _time_status(d)
    return {"output": "\n".join(log), **st}


def _panel_epoch(d: Any) -> int | None:
    try:
        return int((d.shell("date +%s") or "").strip())
    except ValueError:
        return None

