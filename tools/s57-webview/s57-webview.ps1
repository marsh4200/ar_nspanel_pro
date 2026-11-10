# HDL S57: replace the panel's built-in WebView 44 with WebView 106, so the AR
# app draws the panel screen itself (no Chrome, no address bar, no white strip).
#
#   .\s57-webview.ps1             back up the old WebView, put WebView 106 in, reboot
#   .\s57-webview.ps1 -Restore    put the backed-up original back, reboot
#
#   -Apk FILE    the WebView APK (default: webview.apk next to this script). It must
#                be named com.android.webview (Android 6 accepts no other name) and
#                hold 64-bit + 32-bit ARM libraries. Use LineageOS's
#                "Android System WebView 106.0.5249.126 (arm64-v8a + arm-v7a)
#                (Android 6.0+)" from APKMirror, as it is (not Google's WebView:
#                that one is com.google.android.webview). make-webview.py is a
#                fallback that renames Bromite's SystemWebView 106.
#   -Serial X    which device, when more than one is plugged in
#
# Needs the S57's root ADB (its firmware is an engineering build) and Android
# platform-tools: adb.exe on PATH or in .\platform-tools\. Uses Windows' own
# tar.exe to unpack the libraries (Windows 10 1803 and later).
# Double-click webview-install.bat / webview-restore.bat.
param([switch]$Restore, [string]$Apk = "", [string]$Serial = "")
$ErrorActionPreference = "Continue"
$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path
$WV = "/system/app/webview"
$BACKUP = Join-Path $HERE "s57-webview-backup"

function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X]  $m" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }
function Step($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }

$ADB = (Get-Command adb -ErrorAction SilentlyContinue).Source
if (-not $ADB -and (Test-Path "$HERE\platform-tools\adb.exe")) { $ADB = "$HERE\platform-tools\adb.exe" }
if (-not $ADB -and (Test-Path "$HERE\..\usb-setup\platform-tools\adb.exe")) { $ADB = "$HERE\..\usb-setup\platform-tools\adb.exe" }
if (-not $ADB) { Die "adb not found. Unzip Android 'SDK Platform-Tools' into $HERE\platform-tools\" }

# Plain functions on purpose: $args passes "-p", "-R"... straight to adb
function Run-Adb([object[]]$a) {
  if ($Serial) { $a = @("-s", $Serial) + $a }
  $out = & $ADB @a 2>&1 | ForEach-Object { "$_" } | Out-String
  return $out.Replace("`r", "").Trim()
}
function A { return Run-Adb @(, [object[]]$args) }
function S { return Run-Adb @(, ([object[]]@("shell") + [object[]]$args)) }
function WebViewVersion { return [regex]::Match((S dumpsys package com.android.webview), 'versionName=(\S+)').Groups[1].Value }
function Writable {
  # adb remount is the one the S57 accepts (its toolbox mount refuses "-o rw,remount /system")
  A remount | Out-Null
  if ((S "mount | grep ' /system '") -notmatch "\srw[,\s]") { S mount -o remount,rw /system | Out-Null }
  if ((S "mount | grep ' /system '") -notmatch "\srw[,\s]") { S mount -o rw,remount -t ext4 /dev/block/by-name/system /system | Out-Null }
  if ((S "mount | grep ' /system '") -notmatch "\srw[,\s]") { Die "Couldn't make /system writable on this panel. Nothing was changed." }
  Ok "/system is writable"
}
function Finish {
  S sync | Out-Null
  S mount -o ro,remount /system | Out-Null
  Step "Rebooting the panel (the first boot takes a minute or two: Android prepares the new WebView)..."
  A reboot | Out-Null
  Start-Sleep -Seconds 8
  A wait-for-device | Out-Null
  for ($i = 0; $i -lt 90; $i++) { if ((S getprop sys.boot_completed) -eq "1") { break }; Start-Sleep -Seconds 2 }
  if ((S getprop sys.boot_completed) -ne "1") { Warn "The panel hasn't finished starting yet: check it, then run 'adb shell dumpsys package com.android.webview | findstr versionName'" ; return }
  Ok "Panel started"
  Ok "WebView now: $(WebViewVersion)"
  $err = S "logcat -d | grep -i -E 'WebViewFactory|chromium' | grep -i -E 'error|fail|exception' | tail -5"
  if ($err) { Warn "WebView messages in the log:"; Write-Host $err }
}

# --- device ---------------------------------------------------------------------------
Step "Looking for the S57 on USB..."
A wait-for-device | Out-Null
if ((A get-state) -ne "device") { Die "The panel isn't ready on USB (accept 'Allow USB debugging' on it and run again)." }
$MODEL = S getprop ro.product.model; $SDK = S getprop ro.build.version.sdk
Ok "Found $MODEL (SDK $SDK)"
if ($MODEL -notmatch "sc3859q" -or $SDK -ne "23") { Die "This tool is for the HDL S57 (Android 6, sc3859q) only. Nothing was changed." }
if ((S id) -notmatch "uid=0") { Die "ADB isn't root on this panel, so /system can't be changed. Nothing was changed." }
Ok "ADB is root"
Ok "WebView now: $(WebViewVersion)"

# --- restore ------------------------------------------------------------------------------
if ($Restore) {
  $orig = Join-Path $BACKUP "webview"
  if (-not (Test-Path (Join-Path $orig "webview.apk"))) { Die "No backup at $orig. Nothing was changed." }
  Step "Putting the original WebView back..."
  Writable
  S rm -rf $WV | Out-Null
  $out = A push "$orig" "/system/app/"
  if ($out -notmatch "pushed") { Die "Copy failed: $out (the panel's WebView folder may be incomplete: run -Restore again)" }
  S chown -R root:root $WV | Out-Null
  S chmod -R 755 $WV | Out-Null
  S "chmod 644 $WV/webview.apk $WV/oat/*/* 2>/dev/null" | Out-Null
  S "rm -f /data/dalvik-cache/*/system@app@webview@webview.apk@classes.dex" | Out-Null
  Ok "Original WebView copied back"
  Finish
  Step "Done: the panel has its original WebView again."
  Read-Host "Press Enter to close"; exit 0
}

# --- the new WebView -------------------------------------------------------------------------
Step "Checking the new WebView..."
if (-not $Apk) { $Apk = Join-Path $HERE "webview.apk" }
if (-not (Test-Path $Apk)) { Die "WebView APK not found: $Apk" }
$TMP = Join-Path $env:TEMP ("s57wv-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $TMP | Out-Null
& tar.exe -xf "$Apk" -C "$TMP" lib/arm64-v8a lib/armeabi-v7a 2>&1 | Out-Null
$L64 = Join-Path $TMP "lib\arm64-v8a"; $L32 = Join-Path $TMP "lib\armeabi-v7a"
if (-not (Test-Path "$L64\libwebviewchromium.so") -or -not (Test-Path "$L32\libwebviewchromium.so")) {
  Die "Couldn't unpack the WebView's libraries from $Apk (64-bit and 32-bit libwebviewchromium.so are needed)."
}
# the name check: Android 6 only loads a WebView called com.android.webview
& tar.exe -xf "$Apk" -C "$TMP" AndroidManifest.xml 2>&1 | Out-Null
$man = Join-Path $TMP "AndroidManifest.xml"
if (-not (Test-Path $man)) { Die "Couldn't read the WebView's manifest from $Apk. Nothing was changed." }
$mb = [System.IO.File]::ReadAllBytes($man)
$mt = [System.Text.Encoding]::Unicode.GetString($mb) + [System.Text.Encoding]::UTF8.GetString($mb)
if ($mt -match "com\.google\.android\.webview" -or $mt -notmatch "com\.android\.webview") {
  Die "$(Split-Path -Leaf $Apk) isn't named com.android.webview (Google's WebView won't load on Android 6). Use LineageOS's WebView 106. Nothing was changed."
}
Ok "Named com.android.webview"
# Android's folder names for system apps: lib/arm64 and lib/arm
Rename-Item $L64 "arm64"; Rename-Item $L32 "arm"
Ok "$(Split-Path -Leaf $Apk): 64-bit and 32-bit libraries unpacked"

# --- back up the original once -------------------------------------------------------------
Step "Backing up the original WebView..."
if (Test-Path (Join-Path $BACKUP "webview\webview.apk")) { Ok "Backup already there: $BACKUP\webview (kept, not overwritten)" }
else {
  New-Item -ItemType Directory -Path $BACKUP -Force | Out-Null
  A pull $WV "$BACKUP" | Out-Null
  $b = Get-Item (Join-Path $BACKUP "webview\webview.apk") -ErrorAction SilentlyContinue
  if (-not $b -or $b.Length -lt 10MB) { Die "The backup didn't work, so nothing was changed. Check that $BACKUP can be written." }
  Ok "Backed up to $BACKUP\webview ($([math]::Round($b.Length / 1MB)) MB)"
}

# --- swap it in ------------------------------------------------------------------------------
Step "Putting WebView 106 in..."
Writable
S rm -rf "$WV/oat" "$WV/lib" "$WV/webview.apk" | Out-Null
$out = A push "$Apk" "$WV/webview.apk"
if ($out -notmatch "pushed") { Die "Copy failed: $out. Run with -Restore to put the original back." }
$o1 = A push (Join-Path $TMP "lib") "$WV/"
if ($o1 -notmatch "pushed" -or (S ls "$WV/lib/arm64/libwebviewchromium.so" "$WV/lib/arm/libwebviewchromium.so") -match "No such") { Die "Copying the libraries failed. Run with -Restore to put the original back." }
S chown -R root:root $WV | Out-Null
S chmod 755 $WV "$WV/lib" "$WV/lib/arm64" "$WV/lib/arm" | Out-Null
S "chmod 644 $WV/webview.apk $WV/lib/arm64/* $WV/lib/arm/*" | Out-Null
# the old WebView's compiled code must go, or Android may keep using it
S "rm -f /data/dalvik-cache/*/system@app@webview@webview.apk@classes.dex" | Out-Null
# Android 6 keeps a fixed 100 MB block for the WebView library and on the S57 never
# grows it by itself; WebView 106's 64-bit library is 120 MB ("reserved address space
# ... smaller than ... needed"). 250 MB fits both; it applies from the next boot.
S setprop persist.sys.webview.vmsize 262144000 | Out-Null
if ((S getprop persist.sys.webview.vmsize) -ne "262144000") { Warn "Couldn't set the WebView memory size: after the reboot run  adb shell setprop persist.sys.webview.vmsize 262144000  and reboot again" }
else { Ok "WebView memory size set (250 MB)" }
Ok "WebView 106 copied in"
Remove-Item -Recurse -Force $TMP -ErrorAction SilentlyContinue
Finish
Step "Done. Next: update the AR app (5.0.1 or later), then restart it: it now draws the panel screen itself."
Write-Host "  Something wrong? Run webview-restore.bat: the original WebView goes back."
Read-Host "Press Enter to close"
