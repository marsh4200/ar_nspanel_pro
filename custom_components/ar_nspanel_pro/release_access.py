"""Private release access: pull the app APK and the integration itself from a
private GitHub repo.

The GitHub token lives ONLY in Home Assistant (``.storage``, admin-only
websocket commands). Panels never see it:

* **App APK** – Home Assistant downloads the release asset with the token,
  keeps it in memory for a short while and serves it on the LAN under a random
  one-time path (``/api/ar_nspanel_pro/apk/<key>/<name>``), the same way
  :mod:`padded_audio` serves clips. The panel downloads from Home Assistant and
  checks the sha256 it is given. ``Updater.kt`` already accepts files from the
  panel's own Home Assistant host, so the app needs no change.
* **Integration** – Home Assistant downloads the release source archive with
  the token and swaps ``custom_components/ar_nspanel_pro`` for the new one
  (the old copy is kept as ``<config>/.ar_nspanel_pro_backup``). A restart
  loads it.

Without a token everything behaves exactly as before (public releases).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import secrets
import shutil
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

import aiohttp
from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.network import NoURLAvailableError, get_url
from homeassistant.helpers.storage import Store

from .const import DOMAIN, GITHUB_OWNER, GITHUB_REPO

_LOGGER = logging.getLogger(__name__)

_STORE_KEY = f"{DOMAIN}.release_access"
_STORE_VERSION = 1
_DATA = f"{DOMAIN}_release_access"

API = "https://api.github.com"
UA = "ar-nspanel-pro-integration"

#: Served APKs: kept in RAM for an hour (panels download within minutes), at
#: most two at once (standard + legacy build).
_APK_TTL = 3600
_MAX_APKS = 2
_MAX_APK_BYTES = 120 * 1024 * 1024
#: The integration archive is source only; anything bigger is not ours.
_MAX_ZIP_BYTES = 80 * 1024 * 1024

APK_URL_BASE = "/api/ar_nspanel_pro/apk"
#: update.py's cache of the latest app release (cleared when the token changes).
_LATEST_CACHE = "ar_nspanel_pro_latest_release"


class ReleaseError(Exception):
    """A private-release step failed. ``code`` is stable for the config UI."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class StagedApk:
    url: str  # absolute LAN URL the panel downloads from
    sha256: str
    size: int
    data: bytes


# --- token storage -------------------------------------------------------------


def _state(hass: HomeAssistant) -> dict[str, Any]:
    return hass.data.setdefault(_DATA, {"token": None, "apks": {}, "store": None})


async def async_setup(hass: HomeAssistant) -> None:
    """Load the saved token and register the APK view (idempotent)."""
    st = _state(hass)
    if st["store"] is None:
        st["store"] = Store(hass, _STORE_VERSION, _STORE_KEY, private=True)
        data = await st["store"].async_load() or {}
        tok = data.get("token")
        st["token"] = tok if isinstance(tok, str) and tok else None
        hass.http.register_view(PanelApkView)
        hass.http.register_view(ApkUploadView)


def get_token(hass: HomeAssistant) -> str | None:
    return _state(hass).get("token")


def has_token(hass: HomeAssistant) -> bool:
    return bool(get_token(hass))


def mask(token: str | None) -> str | None:
    if not token:
        return None
    head = token[:11] if token.startswith("github_pat_") else token[:4]
    return f"{head}••••••••{token[-4:]}"


def status(hass: HomeAssistant) -> dict[str, Any]:
    tok = get_token(hass)
    return {"has_token": bool(tok), "mask": mask(tok), "repo": f"{GITHUB_OWNER}/{GITHUB_REPO}"}


async def async_set_token(hass: HomeAssistant, token: str) -> dict[str, Any]:
    """Test the token against the repo, then save it."""
    token = token.strip()
    if len(token) < 20 or any(c.isspace() for c in token):
        raise ReleaseError("bad_token", "That doesn't look like a GitHub token. Paste the whole token.")
    await _async_check_repo(hass, token)
    st = _state(hass)
    st["token"] = token
    st["apks"].clear()
    hass.data.pop(_LATEST_CACHE, None)  # update entity: look up again with the token
    await st["store"].async_save({"token": token})
    return status(hass)


async def async_clear_token(hass: HomeAssistant) -> dict[str, Any]:
    st = _state(hass)
    st["token"] = None
    st["apks"].clear()
    hass.data.pop(_LATEST_CACHE, None)
    await st["store"].async_save({})
    return status(hass)


def auth_headers(hass: HomeAssistant, accept: str = "application/vnd.github+json") -> dict[str, str]:
    h = {"Accept": accept, "User-Agent": UA, "X-GitHub-Api-Version": "2022-11-28"}
    tok = get_token(hass)
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


async def _async_check_repo(hass: HomeAssistant, token: str) -> None:
    session = async_get_clientsession(hass)
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": UA,
        "Authorization": f"Bearer {token}",
    }
    try:
        async with session.get(
            f"{API}/repos/{GITHUB_OWNER}/{GITHUB_REPO}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=20),
        ) as resp:
            status_code = resp.status
    except (aiohttp.ClientError, asyncio.TimeoutError) as err:
        raise ReleaseError("github", f"Couldn't reach GitHub to test the token: {err}") from err
    if status_code == 200:
        return
    if status_code == 401:
        raise ReleaseError("bad_token", "GitHub rejected the token. It may be wrong or expired.")
    if status_code in (403, 404):
        raise ReleaseError(
            "no_access",
            f"The token works but can't read {GITHUB_OWNER}/{GITHUB_REPO}. "
            "Give it read access to Contents on that repo.",
        )
    raise ReleaseError("github", f"GitHub answered HTTP {status_code} while testing the token.")


# --- latest release ------------------------------------------------------------


async def async_latest_release_json(hass: HomeAssistant) -> dict[str, Any]:
    """``/releases/latest`` with the token (private repo)."""
    session = async_get_clientsession(hass)
    try:
        async with session.get(
            f"{API}/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest",
            headers=auth_headers(hass),
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            if resp.status == 401:
                raise ReleaseError("bad_token", "GitHub rejected the saved token. It may have expired.")
            if resp.status == 404:
                raise ReleaseError("no_release", "No release found, or the token can't read the repo.")
            if resp.status != 200:
                raise ReleaseError("github", f"GitHub API returned HTTP {resp.status}.")
            return await resp.json()
    except asyncio.TimeoutError as err:
        raise ReleaseError("github", "Timed out contacting GitHub for the latest release.") from err
    except aiohttp.ClientError as err:
        raise ReleaseError("github", f"Couldn't reach GitHub: {err}") from err


def is_private_asset_url(url: str | None) -> bool:
    """Asset URLs from the authenticated API need the token; the panel can't use them."""
    return bool(url) and url.startswith(f"{API}/repos/") and "/releases/assets/" in url


# --- APK: download in HA, serve to the panel ------------------------------------


def _panel_base_url(hass: HomeAssistant) -> str:
    """Home Assistant's LAN address as the panel reaches it.

    Prefer the plain LAN IP: the panel's MQTT broker is normally on this host,
    and the app only accepts update files from its own broker / UI host.
    """
    api = hass.config.api
    if api is not None and not api.use_ssl and api.local_ip and api.port:
        return f"http://{api.local_ip}:{api.port}"
    for kwargs in (
        {"allow_external": False, "prefer_external": False, "allow_cloud": False},
        {},
    ):
        try:
            return get_url(hass, **kwargs).rstrip("/")
        except NoURLAvailableError:
            continue
    raise ReleaseError("no_url", "Home Assistant has no LAN address the panel can download from.")


async def async_stage_apk(
    hass: HomeAssistant,
    asset_url: str,
    name: str,
    tick: Callable[[int, int], None] | None = None,
) -> StagedApk:
    """Download a private release APK into HA and return where the panel gets it."""
    st = _state(hass)
    apks: dict[str, dict[str, Any]] = st["apks"]
    now = time.monotonic()
    for k in [k for k, v in apks.items() if v["exp"] <= now]:
        apks.pop(k, None)

    # Already staged (another panel, or a retry): reuse it.
    for key, v in apks.items():
        if v["src"] == asset_url:
            v["exp"] = now + _APK_TTL
            return StagedApk(_served_url(hass, key, v["name"]), v["sha256"], len(v["data"]), v["data"])

    data = await _async_download(hass, asset_url, tick)
    if not data.startswith(b"PK"):
        raise ReleaseError("download", "The downloaded file isn't an APK.")
    sha = await hass.async_add_executor_job(lambda: hashlib.sha256(data).hexdigest())
    while len(apks) >= _MAX_APKS:
        apks.pop(min(apks, key=lambda k: apks[k]["exp"]), None)
    key = secrets.token_urlsafe(24)
    safe_name = "".join(c for c in name if c.isalnum() or c in "-_.") or "app.apk"
    apks[key] = {"src": asset_url, "name": safe_name, "data": data, "sha256": sha, "exp": now + _APK_TTL}
    return StagedApk(_served_url(hass, key, safe_name), sha, len(data), data)


def _served_url(hass: HomeAssistant, key: str, name: str) -> str:
    return f"{_panel_base_url(hass)}{APK_URL_BASE}/{key}/{quote(name)}"


async def _async_download(
    hass: HomeAssistant,
    url: str,
    tick: Callable[[int, int], None] | None = None,
    limit: int = _MAX_APK_BYTES,
) -> bytes:
    """Download a private asset / archive with the token.

    GitHub answers with a redirect to a signed storage URL; aiohttp drops the
    Authorization header on the cross-host hop, which is what that URL wants.
    """
    accept = "application/octet-stream" if "/releases/assets/" in url else "application/vnd.github+json"
    try:
        async with aiohttp.ClientSession(max_line_size=65536, max_field_size=65536) as session, session.get(
            url,
            headers=auth_headers(hass, accept),
            timeout=aiohttp.ClientTimeout(total=300),
        ) as resp:
            if resp.status == 401:
                raise ReleaseError("bad_token", "GitHub rejected the saved token. It may have expired.")
            if resp.status != 200:
                raise ReleaseError("download", f"GitHub returned HTTP {resp.status} for the download.")
            total = int(resp.headers.get("Content-Length") or 0)
            buf = bytearray()
            last = -1
            async for chunk in resp.content.iter_chunked(65536):
                buf.extend(chunk)
                if len(buf) > limit:
                    raise ReleaseError("download", "The download is unexpectedly large.")
                step = int(len(buf) * 20 / total) if total else len(buf) // 524288
                if tick and step != last:
                    last = step
                    tick(len(buf), total)
            return bytes(buf)
    except asyncio.TimeoutError as err:
        raise ReleaseError("download", "Timed out downloading from GitHub.") from err
    except aiohttp.ClientError as err:
        raise ReleaseError("download", f"Couldn't download from GitHub: {err}") from err


class PanelApkView(HomeAssistantView):
    """Serve one staged APK. Unauthenticated behind a random key (the panel has
    no Home Assistant credentials); the panel checks the sha256 it was given."""

    url = APK_URL_BASE + "/{key}/{name}"
    name = "api:ar_nspanel_pro:apk"
    requires_auth = False

    async def get(self, request: web.Request, key: str, name: str) -> web.StreamResponse:
        hass: HomeAssistant = request.app["hass"]
        entry = _state(hass)["apks"].get(key)
        if entry is None or entry["exp"] <= time.monotonic():
            return web.Response(status=404)
        return web.Response(
            body=entry["data"],
            content_type="application/vnd.android.package-archive",
            headers={"Content-Disposition": f'attachment; filename="{entry["name"]}"'},
        )


# --- manual APK upload (Device Setup: drop an .apk) ------------------------------

APK_UPLOAD_URL = "/api/ar_nspanel_pro/apk_upload"


async def async_stage_upload(hass: HomeAssistant, data: bytes, name: str) -> dict[str, Any]:
    """Keep an APK uploaded in Device Setup, for the panel to download from HA.
    Returns its key (for ``get_staged``), name and size."""
    if not data.startswith(b"PK"):
        raise ReleaseError("not_apk", "That file isn't an APK.")
    st = _state(hass)
    apks: dict[str, dict[str, Any]] = st["apks"]
    now = time.monotonic()
    for k in [k for k, v in apks.items() if v["exp"] <= now]:
        apks.pop(k, None)
    sha = await hass.async_add_executor_job(lambda: hashlib.sha256(data).hexdigest())
    safe_name = "".join(c for c in name if c.isalnum() or c in "-_.") or "app.apk"
    if not safe_name.lower().endswith(".apk"):
        safe_name += ".apk"
    for key, v in apks.items():
        if v["src"] == "upload:" + sha:
            v["exp"] = now + _APK_TTL
            return {"key": key, "name": v["name"], "size": len(v["data"])}
    while len(apks) >= _MAX_APKS:
        apks.pop(min(apks, key=lambda k: apks[k]["exp"]), None)
    key = secrets.token_urlsafe(24)
    apks[key] = {"src": "upload:" + sha, "name": safe_name, "data": data, "sha256": sha, "exp": now + _APK_TTL}
    return {"key": key, "name": safe_name, "size": len(data)}


def get_staged(hass: HomeAssistant, key: str) -> tuple[StagedApk, str] | None:
    """(staged APK, file name) for an uploaded APK's key, or None once it expired."""
    v = _state(hass)["apks"].get(key)
    if v is None or v["exp"] <= time.monotonic():
        return None
    v["exp"] = time.monotonic() + _APK_TTL
    return StagedApk(_served_url(hass, key, v["name"]), v["sha256"], len(v["data"]), v["data"]), v["name"]


class ApkUploadView(HomeAssistantView):
    """Device Setup sends a dropped .apk here (admins only). Read as a stream,
    so the APK's size isn't held to Home Assistant's 16 MB request limit."""

    url = APK_UPLOAD_URL
    name = "api:ar_nspanel_pro:apk_upload"
    requires_auth = True

    async def post(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        user = request.get("hass_user")
        if user is None or not user.is_admin:
            return self.json_message("Only an administrator can install apps.", 401)
        name = request.query.get("name") or "app.apk"
        buf = bytearray()
        async for chunk in request.content.iter_chunked(65536):
            buf.extend(chunk)
            if len(buf) > _MAX_APK_BYTES:
                return self.json_message("The file is too large for an APK.", 413)
        try:
            res = await async_stage_upload(hass, bytes(buf), name)
        except ReleaseError as err:
            return self.json_message(str(err), 400)
        return self.json(res)


# --- integration self-update -------------------------------------------------


def _component_dir() -> Path:
    return Path(__file__).parent


async def async_installed_version(hass: HomeAssistant) -> str | None:
    def read() -> str | None:
        try:
            return json.loads((_component_dir() / "manifest.json").read_text("utf-8")).get("version")
        except (OSError, ValueError):
            return None

    return await hass.async_add_executor_job(read)


def _ver(tag: str | None) -> str | None:
    if not tag:
        return None
    return tag[1:] if tag.startswith("v") else tag


def _ver_tuple(v: str | None) -> tuple[int, ...]:
    out: list[int] = []
    for part in (v or "").split("-")[0].split("."):
        out.append(int(part) if part.isdigit() else 0)
    return tuple(out)


async def async_integration_latest(hass: HomeAssistant) -> dict[str, Any]:
    installed = await async_installed_version(hass)
    if not has_token(hass):
        return {"installed": installed, "latest": None, "tag": None, "update": False}
    rel = await async_latest_release_json(hass)
    tag = rel.get("tag_name")
    latest = _ver(tag)
    return {
        "installed": installed,
        "latest": latest,
        "tag": tag,
        "update": bool(latest) and _ver_tuple(latest) > _ver_tuple(installed),
    }


async def async_update_integration(hass: HomeAssistant) -> dict[str, Any]:
    """Replace this integration with the latest private release. Needs a restart."""
    if not has_token(hass):
        raise ReleaseError("no_token", "Couldn't reach the integration release.")
    info = await async_integration_latest(hass)
    tag = info["tag"]
    if not tag:
        raise ReleaseError("no_release", "No release found.")
    if not info["update"]:
        return {**info, "updated": False}
    data = await _async_download(
        hass,
        f"{API}/repos/{GITHUB_OWNER}/{GITHUB_REPO}/zipball/{quote(tag)}",
        limit=_MAX_ZIP_BYTES,
    )
    config_dir = Path(hass.config.path())
    await hass.async_add_executor_job(_install_from_zip, data, config_dir)
    _LOGGER.warning("AR NSPanel Pro integration updated %s -> %s; restart Home Assistant", info["installed"], info["latest"])
    return {**info, "updated": True, "restart": True}


def _install_from_zip(data: bytes, config_dir: Path) -> None:
    """Extract ``custom_components/ar_nspanel_pro`` from the archive and swap it in."""
    target = _component_dir()
    stage = config_dir / ".ar_nspanel_pro_update"
    backup = config_dir / ".ar_nspanel_pro_backup"
    marker = f"/custom_components/{DOMAIN}/"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    found = False
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for info in zf.infolist():
                name = info.filename
                if marker not in name or info.is_dir():
                    continue
                rel = name.split(marker, 1)[1]
                if not rel or rel.startswith("/") or ".." in Path(rel).parts:
                    continue
                dest = stage / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
                found = True
        if not found or not (stage / "manifest.json").is_file() or not (stage / "__init__.py").is_file():
            raise ReleaseError("bad_archive", "The release doesn't contain the integration.")
        json.loads((stage / "manifest.json").read_text("utf-8"))  # sanity
        shutil.rmtree(backup, ignore_errors=True)
        target.rename(backup)
        try:
            stage.rename(target)
        except OSError:
            backup.rename(target)  # put the old one back
            raise
    except zipfile.BadZipFile as err:
        raise ReleaseError("bad_archive", "The downloaded release isn't a valid archive.") from err
    finally:
        shutil.rmtree(stage, ignore_errors=True)

