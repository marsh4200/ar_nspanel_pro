"""Talk to an RTSP camera the way a player does, and say what it answers.

Used by the config panel's "Check cameras" tool (ADB tool): Home Assistant sits
on the same LAN as the panel, so it can test a camera at a site nobody is at.
OPTIONS -> DESCRIBE (login: Basic or Digest) -> SETUP over TCP -> PLAY ->
count the video bytes for a moment -> TEARDOWN. Plain asyncio, no libraries.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import re
from urllib.parse import unquote

_UA = "AR-NSPanel-Pro camera check"


def _unescape(s: str) -> str:
    """Percent-decode only real %XX escapes (a typed "50%off" keeps its %)."""
    return unquote(s) if re.search(r"%[0-9A-Fa-f]{2}", s) else s


def parse_url(raw: str) -> dict:
    """Split an RTSP URL the way the panel app does: the address comes after the
    LAST "@", so a password may contain @ : / # ? $ freely."""
    s = raw.strip().strip("\"' ")
    m = re.match(r"^(rtsps?)://(.*)$", s, re.I)
    if not m:
        raise ValueError("not an rtsp:// URL")
    rest = m.group(2)
    at = rest.rfind("@")
    info, hostpath = (rest[:at], rest[at + 1:]) if at >= 0 else ("", rest)
    user, _, pw = info.partition(":")
    slash = hostpath.find("/")
    hostport, path = (hostpath, "/") if slash < 0 else (hostpath[:slash], hostpath[slash:])
    host, _, port = hostport.partition(":")
    return {
        "user": _unescape(user),
        "password": _unescape(pw),
        "host": host,
        "port": int(port) if port.isdigit() else 554,
        "path": path,
        "url": f"rtsp://{host}:{int(port) if port.isdigit() else 554}{path}",
    }


def _masked(raw: str) -> str:
    return re.sub(r"^(rtsps?://[^:@/]*:).*@", r"\1****@", raw.strip())


class _Rtsp:
    def __init__(self, reader, writer, user, password):
        self.r, self.w = reader, writer
        self.user, self.password = user, password
        self.cseq = 0
        self.auth = None  # ("basic",) or ("digest", realm, nonce, opaque, qop)
        self.nc = 0
        self.session = None

    def _auth_header(self, method: str, uri: str) -> str | None:
        if not self.auth:
            return None
        if self.auth[0] == "basic":
            tok = base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
            return f"Basic {tok}"
        _, realm, nonce, opaque, qop = self.auth
        md5 = lambda x: hashlib.md5(x.encode()).hexdigest()  # noqa: E731
        ha1 = md5(f"{self.user}:{realm}:{self.password}")
        ha2 = md5(f"{method}:{uri}")
        h = f'Digest username="{self.user}", realm="{realm}", nonce="{nonce}", uri="{uri}"'
        if qop and "auth" in qop.split(","):
            self.nc += 1
            nc = f"{self.nc:08x}"
            cnonce = os.urandom(8).hex()
            resp = md5(f"{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}")
            h += f', qop=auth, nc={nc}, cnonce="{cnonce}"'
        else:
            resp = md5(f"{ha1}:{nonce}:{ha2}")
        h += f', response="{resp}"'
        if opaque:
            h += f', opaque="{opaque}"'
        return h

    async def request(self, method: str, uri: str, extra: dict | None = None) -> tuple[int, str, dict, bytes]:
        for attempt in (1, 2):
            self.cseq += 1
            lines = [f"{method} {uri} RTSP/1.0", f"CSeq: {self.cseq}", f"User-Agent: {_UA}"]
            a = self._auth_header(method, uri)
            if a:
                lines.append(f"Authorization: {a}")
            if self.session:
                lines.append(f"Session: {self.session}")
            for k, v in (extra or {}).items():
                lines.append(f"{k}: {v}")
            self.w.write(("\r\n".join(lines) + "\r\n\r\n").encode())
            await self.w.drain()
            code, reason, headers, body = await self._response()
            if code == 401 and attempt == 1 and self.user:
                www = headers.get("www-authenticate-all", [])
                dig = next((x for x in www if x.lower().startswith("digest")), None)
                if dig:
                    g = lambda k: (re.search(k + r'="?([^",]*)"?', dig, re.I) or [None, ""])[1]  # noqa: E731
                    self.auth = ("digest", g("realm"), g("nonce"), g("opaque"), g("qop"))
                else:
                    self.auth = ("basic",)
                continue
            return code, reason, headers, body
        return code, reason, headers, body

    async def _response(self) -> tuple[int, str, dict, bytes]:
        # skip interleaved RTP frames ($ ch len payload) that may arrive between replies
        while True:
            first = await self.r.readexactly(1)
            if first == b"$":
                hdr = await self.r.readexactly(3)
                await self.r.readexactly(int.from_bytes(hdr[1:3], "big"))
                continue
            break
        head = first + await self.r.readuntil(b"\r\n\r\n")
        text = head.decode("latin-1").split("\r\n")
        m = re.match(r"RTSP/\d\.\d\s+(\d+)\s*(.*)", text[0])
        if not m:
            raise ValueError(f"not an RTSP reply: {text[0][:60]!r}")
        headers: dict = {}
        for ln in text[1:]:
            if ":" in ln:
                k, v = ln.split(":", 1)
                k = k.strip().lower()
                headers[k] = v.strip()
                if k == "www-authenticate":
                    headers.setdefault("www-authenticate-all", []).append(v.strip())
        n = int(headers.get("content-length", "0") or 0)
        body = await self.r.readexactly(n) if n else b""
        return int(m.group(1)), m.group(2).strip(), headers, body


def _sdp_summary(sdp: str) -> tuple[list[str], str | None]:
    """Readable lines about each track, and the video track's control."""
    out, video_ctrl, cur = [], None, None
    for ln in sdp.splitlines():
        ln = ln.strip()
        if ln.startswith("m="):
            cur = ln[2:].split()[0]
            out.append(f"  track: {ln[2:]}")
        elif ln.startswith("a=rtpmap:"):
            out.append(f"    codec: {ln[9:]}")
        elif ln.startswith("a=control:") and cur == "video" and video_ctrl is None:
            video_ctrl = ln[10:]
        elif ln.startswith("a=fmtp:") and cur == "video":
            has = [k for k in ("sprop-parameter-sets", "sprop-vps", "sprop-sps", "sprop-pps") if k in ln]
            out.append("    stream parameters in SDP: " + (", ".join(has) if has else "NONE (player must find them in the video)"))
        elif re.match(r"a=(framerate|x-dimensions|framesize|cliprect)", ln):
            out.append(f"    {ln[2:]}")
    return out, video_ctrl


async def probe(raw_url: str, timeout: float = 6.0) -> list[str]:
    """Run the check; return readable lines (never raises)."""
    log: list[str] = []
    try:
        u = parse_url(raw_url)
    except ValueError as e:
        return [f"✗ {e}"]
    log.append(f"Camera {u['host']}:{u['port']} {u['path']}  (user \"{u['user']}\", password {len(u['password'])} characters)")
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(u["host"], u["port"]), timeout)
    except Exception as e:  # noqa: BLE001
        return log + [f"✗ Home Assistant can't connect to {u['host']}:{u['port']}: {type(e).__name__} {e}"]
    log.append("✓ TCP connection open")
    c = _Rtsp(reader, writer, u["user"], u["password"])
    try:
        code, reason, h, _ = await asyncio.wait_for(c.request("OPTIONS", u["url"]), timeout)
        log.append(f"OPTIONS -> {code} {reason}" + (f"  (server: {h.get('server')})" if h.get("server") else ""))
        code, reason, h, body = await asyncio.wait_for(
            c.request("DESCRIBE", u["url"], {"Accept": "application/sdp"}), timeout
        )
        how = f" (login: {c.auth[0]})" if c.auth else ""
        log.append(f"DESCRIBE -> {code} {reason}{how}")
        if code == 401:
            log.append("✗ The camera refused the user / password")
            return log
        if code != 200:
            log.append("✗ The camera didn't describe the stream (wrong channel?)")
            return log
        sdp = body.decode("latin-1")
        lines, ctrl = _sdp_summary(sdp)
        log += lines
        if ctrl is None:
            log.append("✗ No video track in the stream description")
            return log
        base = h.get("content-base") or h.get("content-location") or u["url"]
        track = ctrl if ctrl.lower().startswith("rtsp://") else (base.rstrip("/") + "/" + ctrl if ctrl != "*" else base)
        code, reason, h, _ = await asyncio.wait_for(
            c.request("SETUP", track, {"Transport": "RTP/AVP/TCP;unicast;interleaved=0-1"}), timeout
        )
        log.append(f"SETUP video over TCP -> {code} {reason}")
        if code != 200:
            log.append("✗ The camera won't send video over TCP" if code == 461 else "✗ The camera refused to set up the video")
            return log
        c.session = (h.get("session") or "").split(";")[0] or None
        code, reason, h, _ = await asyncio.wait_for(c.request("PLAY", base, {"Range": "npt=0.000-"}), timeout)
        log.append(f"PLAY -> {code} {reason}")
        if code != 200:
            log.append("✗ The camera refused to play")
            return log
        got, frames = 0, 0
        loop = asyncio.get_running_loop()
        end = loop.time() + 3
        while loop.time() < end:
            try:
                b = await asyncio.wait_for(reader.readexactly(1), max(0.1, end - loop.time()))
            except asyncio.TimeoutError:
                break
            if b != b"$":
                continue
            hdr = await reader.readexactly(3)
            n = int.from_bytes(hdr[1:3], "big")
            await reader.readexactly(n)
            got += n
            frames += 1
        if got:
            log.append(f"✓ Video is flowing: {frames} packets, {got // 1024} KB in 3 s ({got * 8 // 3 // 1000} kbit/s)")
        else:
            log.append("✗ The camera said PLAY but sent no video in 3 s")
        try:
            await asyncio.wait_for(c.request("TEARDOWN", base), 2)
        except Exception:  # noqa: BLE001
            pass
    except asyncio.IncompleteReadError:
        log.append("✗ The camera closed the connection")
    except asyncio.TimeoutError:
        log.append("✗ The camera stopped answering")
    except Exception as e:  # noqa: BLE001
        log.append(f"✗ {type(e).__name__}: {e}")
    finally:
        writer.close()
    return log


__all__ = ["probe", "parse_url", "_masked"]
