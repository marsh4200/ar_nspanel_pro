"""Generate Ed25519 + WIQL1 vectors with `cryptography` for LicenceTest.kt."""
import base64, json, os, time
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

def raw_pub(k):
    return k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)

def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

out = []
# 1) raw Ed25519 vectors: random keys/messages incl. empty + long
for n in [0, 1, 2, 31, 32, 64, 200, 1023]:
    k = Ed25519PrivateKey.generate()
    msg = os.urandom(n)
    sig = k.sign(msg)
    out.append(f"ED {raw_pub(k).hex()} {msg.hex() or '-'} {sig.hex()} ok")
    bad = bytearray(sig); bad[5] ^= 1
    out.append(f"ED {raw_pub(k).hex()} {msg.hex() or '-'} {bytes(bad).hex()} bad")
    if n:
        m2 = bytearray(msg); m2[0] ^= 0x80
        out.append(f"ED {raw_pub(k).hex()} {bytes(m2).hex()} {sig.hex()} bad")

# 2) WIQL1 tokens with a test signing key
k = Ed25519PrivateKey.generate()
pub = raw_pub(k).hex()
now = int(time.time())
SID = "a1b2c3d4e5f60718"
def token(payload, mode="payload"):
    pj = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    p64 = b64u(pj)
    msg = pj if mode == "payload" else ("WIQL1." + p64).encode()
    return f"WIQL1.{p64}.{b64u(k.sign(msg))}"
base = {"license_id": "L-1", "product": "ar_nspanel_pro", "client": "Test Lodge", "server_id": SID, "issued_at": "2026-09-01T00:00:00Z"}
cases = [
    ("valid_iso", dict(base, expires_at="2099-12-31T00:00:00Z"), "payload", "valid"),
    ("valid_prefix_signed", dict(base, expires_at="2099-12-31"), "prefix", "valid"),
    ("valid_unix", dict(base, expires_at=now + 86400 * 30), "payload", "valid"),
    ("valid_perpetual_null", dict(base, expires_at=None), "payload", "valid"),
    ("valid_perpetual_flag", dict(base, expires_at="2000-01-01", perpetual=True), "payload", "valid"),
    ("expired", dict(base, expires_at="2020-01-01T00:00:00+02:00"), "payload", "expired"),
    ("expired_unix_ms", dict(base, expires_at=(now - 60) * 1000), "payload", "expired"),
    ("other_panel", dict(base, server_id="ffffffffffffffff", expires_at="2099-01-01"), "payload", "serial_mismatch"),
    ("upper_case_sid", dict(base, server_id=SID.upper(), expires_at="2099-01-01"), "payload", "valid"),
    ("wrong_product", dict(base, product="workshopiq", expires_at="2099-01-01"), "payload", "wrong_product"),
]
for name, payload, mode, want in cases:
    out.append(f"LIC {name} {pub} {SID} {token(payload, mode)} {want}")
t = token(dict(base, expires_at="2099-01-01"))
parts = t.split(".")
tampered = parts[0] + "." + b64u(json.dumps(dict(base, expires_at="2199-01-01"), separators=(",", ":"), sort_keys=True).encode()) + "." + parts[2]
out.append(f"LIC tampered {pub} {SID} {tampered} bad_signature")
out.append(f"LIC garbage {pub} {SID} hello.world malformed")
out.append(f"LIC empty {pub} {SID} - missing")
other = Ed25519PrivateKey.generate()
out.append(f"LIC foreign_key {raw_pub(other).hex()} {SID} {t} bad_signature")
open("vectors.txt", "w").write("\n".join(out) + "\n")
print(len(out), "vectors")
