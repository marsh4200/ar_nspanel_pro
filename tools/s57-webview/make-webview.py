"""Make the HDL S57's WebView 106 from Bromite's SystemWebView.

Android 6 only takes a WebView named com.android.webview (unless the framework
is patched). Bromite's SystemWebView 106 (the last Chromium for Android 6) is
named org.bromite.webview -- the same length, so the name is swapped in place in
the compiled manifest and the resource table (the framework finds the WebView's
resources by that name), Bromite's signature is dropped and the APK is signed
again (v1). Nothing else changes.

  python make-webview.py arm64_SystemWebView.apk webview.apk

Needs Java's keytool + jarsigner on PATH. Download the input from
https://github.com/bromite/bromite/releases/download/106.0.5249.163/arm64_SystemWebView.apk
(sha256 bc966d7f556439d7186ad5ab5bfaf249d1e9622897512c5fba288512e70e15a9).
"""
import os
import subprocess
import sys
import zipfile

OLD = "org.bromite.webview".encode("utf-16-le") + b"\x00\x00"
NEW = "com.android.webview".encode("utf-16-le") + b"\x00\x00"
KEYSTORE = "ar-webview.jks"
PASS = "arwebview"


def patch(data: bytes, want: int, what: str) -> bytes:
    n = data.count(OLD)
    if n != want:
        sys.exit(f"{what}: expected {want} copies of the name, found {n} - not Bromite SystemWebView 106?")
    return data.replace(OLD, NEW)


def main(src: str, dst: str) -> None:
    tmp = dst + ".unsigned"
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w") as zout:
        for info in zin.infolist():
            name = info.filename
            if name.startswith("META-INF/") and name.split("/")[-1].upper().endswith((".SF", ".RSA", ".DSA", ".EC", "MANIFEST.MF")):
                continue  # Bromite's signature: replaced below
            data = zin.read(name)
            if name == "AndroidManifest.xml":
                data = patch(data, 1, name)
            elif name == "resources.arsc":
                data = patch(data, 3, name)
            zi = zipfile.ZipInfo(name, date_time=info.date_time)
            zi.compress_type = info.compress_type
            zi.external_attr = info.external_attr
            zout.writestr(zi, data)
    if not os.path.exists(KEYSTORE):
        subprocess.run(["keytool", "-genkeypair", "-keystore", KEYSTORE, "-storepass", PASS, "-keypass", PASS,
                        "-alias", "arwebview", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
                        "-dname", "CN=AR Smart Home WebView"], check=True)
    subprocess.run(["jarsigner", "-keystore", KEYSTORE, "-storepass", PASS, "-sigalg", "SHA256withRSA",
                    "-digestalg", "SHA-256", "-signedjar", dst, tmp, "arwebview"], check=True)
    os.remove(tmp)
    print("made", dst)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
