# AR NSPanel Pro - first install over USB, for panels with USB debugging only
# (the HDL S10 touch). After this, Home Assistant updates the app over MQTT:
# Settings > Updates (the panel's "App" update entity). No ADB needed again.
#
#   .\ar-panel-usb.ps1                 install / update the app (+ silent updates)
#   .\ar-panel-usb.ps1 -Takeover       ...and switch HDL's screen off, our app = Home
#   .\ar-panel-usb.ps1 -Restore        back to HDL's screen (app stays installed)
#   .\ar-panel-usb.ps1 -Uninstall      remove the app, HDL screen back
#
#   -Apk FILE    use this APK (default: the newest matching APK next to this script,
#                else it is downloaded from the latest GitHub release. Android 7+
#                gets ar-nspanel-pro-X.Y.Z.apk, Android 5/6 gets
#                ar-nspanel-pro-legacy-X.Y.Z.apk (own browser engine))
#   -NoOwner     don't make the app device owner (updates then need a tap)
#   -Kiosk       also lock the panel in (no Home / Recents). Off by default.
#   -NoTcpip     don't switch on network ADB (port 5555) at the end
#   -Serial X    which device, when more than one is plugged in
#
# Needs Android platform-tools: adb.exe on PATH or in .\platform-tools\
# Easiest: double-click install.bat (or takeover.bat / restore.bat / uninstall.bat).
param(
  [switch]$Takeover, [switch]$Restore, [switch]$Uninstall,
  [string]$Apk = "", [switch]$NoOwner, [switch]$Kiosk, [switch]$NoTcpip, [string]$Serial = ""
)
$ErrorActionPreference = "Continue"
$PKG = "za.co.arsmarthome.nspanel"
$OWNER_ADMIN = "$PKG/.KioskAdmin"
$CTRL = "$PKG/.KioskControl"
$REPO = "marsh4200/ar_nspanel_pro"
$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path
# HDL S57: HDL's software is WallApp (not a Home app) over stock Launcher3; Android 6, root shell, no `cmd`
$S57_APP = "com.example.wallapp"; $S57_LAUNCHER = "com.android.launcher3"
$BOOT_RX = "$PKG/.BootReceiver"; $FS_HELPER = "$PKG/$PKG.FullscreenHelper"

function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X]  $m" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }
function Step($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }

$ADB = (Get-Command adb -ErrorAction SilentlyContinue).Source
if (-not $ADB -and (Test-Path "$HERE\platform-tools\adb.exe")) { $ADB = "$HERE\platform-tools\adb.exe" }
if (-not $ADB) { Die "adb not found. Download Android 'SDK Platform-Tools' for Windows and unzip it into $HERE\platform-tools\" }

# Plain functions on purpose: $args passes "-r", "-a", "-n"... straight to adb
# (a param() block would make PowerShell read them as its own parameters).
function Run-Adb([object[]]$a) {
  if ($Serial) { $a = @("-s", $Serial) + $a }
  $out = & $ADB @a 2>&1 | ForEach-Object { "$_" } | Out-String
  return $out.Replace("`r", "").Trim()
}
function A { return Run-Adb @(, [object[]]$args) }
function S { return Run-Adb @(, ([object[]]@("shell") + [object[]]$args)) }

function Installed($p) { return ((S pm list packages $p) -split "`n") -contains "package:$p" }
function OwnerPkg {
  $m = [regex]::Match((S dumpsys device_policy), 'admin=ComponentInfo\{([^/}]+)/')
  if ($m.Success) { return $m.Groups[1].Value } else { return "" }
}
function HdlPkgs {
  return @((S pm list packages com.hdl) -split "`n" | Where-Object { $_ -like "package:*" } |
    ForEach-Object { $_.Substring(8).Trim() } | Where-Object { $_ -notlike "*factory*" })
}
function HdlLauncher { return (HdlPkgs | Where-Object { $_ -like "*.launcher" } | Select-Object -First 1) }
function HomeOf($p) {
  $l = (S cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME $p) -split "`n"
  return $l[-1].Trim()
}
function SetHome($comp, $p) {
  if ((S cmd package set-home-activity $comp) -match "(?i)success") { Ok "Home -> $p"; return }
  S cmd role add-role-holder android.app.role.HOME $p | Out-Null
  if ((S cmd role get-role-holders android.app.role.HOME) -match [regex]::Escape($p)) { Ok "Home -> $p (Home role)" }
  else { Warn "Couldn't make $p the Home app: press Home on the panel and pick it with 'Always'" }
}
function UnlockOwner {
  if ((OwnerPkg) -eq $PKG) {
    S am broadcast -a za.co.arsmarthome.nspanel.KIOSK_UNLOCK -n $CTRL --include-stopped-packages | Out-Null
    for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Milliseconds 400; if ((OwnerPkg) -ne $PKG) { break } }
    if ((OwnerPkg) -eq $PKG) { Warn "The app is still device owner (it didn't answer)" } else { Ok "Released device owner" }
  }
}

# --- device ---------------------------------------------------------------------
Step "Looking for the panel on USB..."
$devs = @((& $ADB devices) | Select-Object -Skip 1 | Where-Object { $_ -match "\tdevice$" })
if (-not $Serial -and $devs.Count -gt 1) { & $ADB devices -l; Die "More than one device: run again with -Serial <serial>" }
Write-Host "  (if the panel shows 'Allow USB debugging?', tick 'Always allow' and tap Allow)"
A wait-for-device | Out-Null
$state = A get-state
if ($state -ne "device") { Die "Panel says '$state' - accept the USB debugging prompt on the panel and run again" }
$MODEL = S getprop ro.product.model; $SDK = [int](S getprop ro.build.version.sdk); $REL = S getprop ro.build.version.release
Ok "Found $MODEL (Android $REL, SDK $SDK)"
# Android 5/6 (SDK < 24): the legacy APK with its own browser engine
$LEGACY = ($SDK -gt 0 -and $SDK -lt 24)
$KIND = if ($LEGACY) { "legacy" } else { "standard" }
Ok "This panel needs the $KIND APK"
$HDL_L = HdlLauncher
if ($HDL_L) { Ok "HDL software found ($HDL_L)" }
$S57 = (-not $HDL_L) -and (Installed $S57_APP)
if ($S57) { Ok "HDL S57 found (WallApp)" }
function S57Back {
  S wm overscan reset | Out-Null
  if ((S settings get secure enabled_accessibility_services) -eq $FS_HELPER) {
    S settings put secure enabled_accessibility_services "''" | Out-Null; S settings put secure accessibility_enabled 0 | Out-Null
  }
  foreach ($p in @($S57_LAUNCHER, $S57_APP)) { Ok "${p}: $(S pm enable $p)" }
  if (Installed $PKG) { S pm disable $BOOT_RX | Out-Null }
  S am start -n "$S57_APP/.SplashActivity" | Out-Null
  S sync | Out-Null
}

# --- restore / uninstall ------------------------------------------------------------
if ($Restore -or $Uninstall) {
  Step "Giving the panel back to HDL..."
  UnlockOwner
  foreach ($p in HdlPkgs) { S pm enable $p | Out-Null; Ok "enabled $p" }
  if ($HDL_L) { SetHome (HomeOf $HDL_L) $HDL_L }
  if ($S57) { S57Back }
  if ($Uninstall) {
    if (Installed $PKG) {
      $out = A uninstall $PKG
      if ($out -match "Success") { Ok "App uninstalled" } else { Warn "Uninstall: $out" }
    } else { Ok "App wasn't installed" }
  }
  if ($S57) { S am start -n "$S57_APP/.SplashActivity" | Out-Null } else { S input keyevent 3 | Out-Null }
  Step "Done."; Read-Host "Press Enter to close"; exit 0
}

# --- APK --------------------------------------------------------------------------
Step "Getting the app..."
if (-not $Apk) {
  $f = Get-ChildItem -Path $HERE -Filter "ar-nspanel-pro-*.apk" -ErrorAction SilentlyContinue |
    Where-Object { ($_.Name -like "*-legacy-*") -eq $LEGACY } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) { $Apk = $f.FullName }
}
if (-not $Apk) {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $rel = Invoke-RestMethod -UseBasicParsing -Headers @{ "User-Agent" = "ar-panel-usb" } "https://api.github.com/repos/$REPO/releases/latest"
    $asset = $rel.assets | Where-Object { $_.name -like "*.apk" -and (($_.name -like "*-legacy-*") -eq $LEGACY) } | Select-Object -First 1
    if (-not $asset) { throw "no apk in $($rel.tag_name)" }
    $Apk = Join-Path $HERE $asset.name
    Write-Host "  downloading $($asset.name)..."
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $Apk
  } catch { Die "Couldn't download the latest release ($_). Download the APK and pass -Apk FILE" }
}
if (-not (Test-Path $Apk)) { Die "APK not found: $Apk" }
Ok (Split-Path -Leaf $Apk)

# --- Chrome (HDL S57: the panel screen runs in Chrome; its own WebView is too old) ----
if ($S57) {
  Step "Chrome..."
  $cv = [regex]::Match((S dumpsys package com.android.chrome), 'versionName=(\S+)').Groups[1].Value
  if ($cv) { Ok "Chrome $cv already installed" }
  else {
    $c = Get-ChildItem -Path $HERE -Filter "chrome*.apk" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($c) {
      $out = A install -r "$($c.FullName)"
      if ($out -match "Success") { Ok "Chrome installed ($($c.Name))" } else { Warn "Chrome install failed: $out" }
    } else { Warn "Chrome isn't installed and there's no chrome*.apk next to this script: the AR screen stays blank until Chrome 106 (arm64-v8a, Android 6.0+) is installed" }
  }
  S "echo 'chrome --disable-fre --no-first-run --no-default-browser-check' > /data/local/tmp/chrome-command-line" | Out-Null
  Ok "Chrome skips its welcome / sign-in screens"
}

# --- install -------------------------------------------------------------------------
Step "Installing over USB..."
# -g (grant runtime permissions) exists from Android 6; Android 5 grants them at install anyway
if ($SDK -ge 23) { $out = A install -r -d -g "$Apk" } else { $out = A install -r -d "$Apk" }
if ($out -notmatch "Success") {
  if ($out -match "(?i)signatures do not match|UPDATE_INCOMPATIBLE|INCONSISTENT_CERTIFICATES") {
    Die "A copy signed with a different key is on the panel. Run uninstall.bat first (wipes its settings), then again."
  }
  Die "Install failed: $out"
}
$ver = [regex]::Match((S dumpsys package $PKG), 'versionName=(\S+)').Groups[1].Value
Ok "Installed $ver"

Step "Permissions for updates without ADB..."
S pm grant $PKG android.permission.WRITE_SECURE_SETTINGS | Out-Null; Ok "may keep USB debugging switched on"
S appops set $PKG SYSTEM_ALERT_WINDOW allow | Out-Null; Ok "may start itself after a reboot / update"
S appops set $PKG REQUEST_INSTALL_PACKAGES allow | Out-Null; Ok "may install its own updates"
$out = S pm set-installer $PKG $PKG
if ($out -match "(?i)error|exception|unknown") { Warn "couldn't set installer of record: $out" } else { Ok "is its own installer (Android 12+: silent updates)" }

S am start -n "$PKG/.MainActivity" | Out-Null
if ($S57 -and -not $Takeover) { S pm disable $BOOT_RX | Out-Null; Ok "WallApp stays in charge (the AR app doesn't open itself at boot)" }

$UPDATE_MODE = "tap Update on the panel once per update"
if (-not $NoOwner) {
  Step "Device owner (silent updates)..."
  $cur = OwnerPkg
  if ($cur -eq $PKG) { Ok "already device owner"; $UPDATE_MODE = "silent" }
  elseif ($cur) { Warn "$cur is this panel's device owner already: skipped" }
  else {
    if (-not $Kiosk) { S am broadcast -a za.co.arsmarthome.nspanel.KIOSK_OWNER_ONLY -n $CTRL --include-stopped-packages | Out-Null }
    $out = S dpm set-device-owner $OWNER_ADMIN
    if ($out -match "Success") { Ok "device owner (not locked)"; $UPDATE_MODE = "silent" }
    else {
      Warn "Android refused device owner: $out"
      if ($out -match "(?i)account") { Warn "  An account is signed in on the panel (Settings > Accounts). Remove it and run again for silent updates." }
      if ($out -match "(?i)already (has|provisioned)|users") { Warn "  Android only allows this on a freshly set-up panel; updates will ask for a tap instead." }
    }
  }
  if ($Kiosk) { S am broadcast -a za.co.arsmarthome.nspanel.KIOSK_LOCK -n $CTRL | Out-Null; Ok "kiosk lock on" }
}
if ($UPDATE_MODE -ne "silent" -and $SDK -ge 31) { $UPDATE_MODE = "silent (Android 12+)" }

# --- take over from HDL ----------------------------------------------------------------
if ($Takeover -and $S57) {
  Step "Taking the S57 over from HDL..."
  S settings put global adb_enabled 1 | Out-Null
  S pm enable $BOOT_RX | Out-Null; Ok "the AR app opens itself at boot"
  S settings put secure enabled_accessibility_services $FS_HELPER | Out-Null
  S settings put secure accessibility_enabled 1 | Out-Null; Ok "full screen with no tap"
  $nb = [regex]::Match((S dumpsys window windows), 'NavigationBar[\s\S]{0,4000}?mFrame=\[\d+,(\d+)\]\[\d+,(\d+)\]')
  if ($nb.Success) {
    $h = [int]$nb.Groups[2].Value - [int]$nb.Groups[1].Value
    if ($h -ge 16 -and $h -le 200) { S wm overscan "0,0,0,-$h" | Out-Null; Ok "navigation bar hidden ($h px)" }
  }
  # Android 6 has no `cmd` to choose Home: with WallApp and Launcher3 off, ours is the only Home app
  foreach ($p in @($S57_APP, $S57_LAUNCHER)) { Ok "${p}: $(S pm disable-user --user 0 $p)" }
  S settings put global device_provisioned 1 | Out-Null
  S settings put secure user_setup_complete 1 | Out-Null
  S am force-stop $S57_APP | Out-Null
  S am start -n "$PKG/.MainActivity" | Out-Null
  S sync | Out-Null
} elseif ($Takeover) {
  Step "Taking the panel over from HDL..."
  SetHome "$PKG/.MainActivity" $PKG
  foreach ($p in (HdlPkgs | Where-Object { $_ -notlike "*.launcher" })) { Ok "${p}: $(S pm disable-user --user 0 $p)" }
  if ($HDL_L) { Ok "${HDL_L}: $(S pm disable-user --user 0 $HDL_L)" }
  S settings put global device_provisioned 1 | Out-Null
  S settings put secure user_setup_complete 1 | Out-Null
  S settings put global adb_enabled 1 | Out-Null
  SetHome "$PKG/.MainActivity" $PKG
  S am start -n "$PKG/.MainActivity" | Out-Null
}

# --- network ADB (optional: for Home Assistant's ADB tools, not needed for updates) ------
$IP = ""
$m = [regex]::Matches((S ip -4 -o addr show), '^\d+:\s+(\S+)\s+inet\s+([\d.]+)', 'Multiline') | Where-Object { $_.Groups[1].Value -ne "lo" } | Select-Object -First 1
if ($m) { $IP = $m.Groups[2].Value }
if (-not $NoTcpip) {
  Step "Network ADB (for Home Assistant's ADB tools - not needed for updates)..."
  $persist = $false
  if ($S57) {
    # the S57's shell is root already (no su on it)
    S setprop persist.adb.tcp.port 5555 | Out-Null
    if ((S getprop persist.adb.tcp.port) -eq "5555") { Ok "port 5555, kept after reboots (root)"; $persist = $true }
  } elseif ((S "command -v su") -match "su") {
    S su 0 setprop persist.adb.tcp.port 5555 | Out-Null
    if ((S getprop persist.adb.tcp.port) -eq "5555") { Ok "port 5555, kept after reboots (root)"; $persist = $true }
  }
  $out = A tcpip 5555
  if ($out -match "(?i)restarting|5555") { Ok "on now: ${IP}:5555" } else { Warn "this firmware won't do network ADB ($out)" }
  if (-not $persist) { Warn "no root: network ADB goes off at the next reboot (updates don't need it)" }
}

Step "Done."
Write-Host "  Panel IP:   $IP"
Write-Host "  Updates:    $UPDATE_MODE"
Write-Host "  Next:       on the panel's setup screen enter the broker (ws://<home-assistant>:1884),"
Write-Host "              then in Home Assistant: Settings > Updates > <panel> App > Install."
Read-Host "Press Enter to close"
