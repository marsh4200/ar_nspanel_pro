#!/usr/bin/env bash
# AR NSPanel Pro — first install over USB, for panels with USB debugging only
# (the HDL S10 touch). After this, Home Assistant updates the app over MQTT:
# Settings -> Updates (the panel's "App" update entity). No ADB needed again.
#
#   ./ar-panel-usb.sh                 install / update the app (+ silent updates)
#   ./ar-panel-usb.sh --takeover      ...and switch HDL's screen off, our app = Home
#   ./ar-panel-usb.sh --restore       back to HDL's screen (app stays installed)
#   ./ar-panel-usb.sh --uninstall     remove the app, HDL screen back
#
# Options:
#   --apk FILE      use this APK (default: newest ar-nspanel-pro-*.apk next to
#                   this script, else the latest GitHub release is downloaded)
#   --no-owner      don't make the app device owner (updates then need a tap
#                   on the panel, on Android 11 and older)
#   --kiosk         also lock the panel in (no Home / Recents). Off by default.
#   --no-tcpip      don't switch on network ADB (port 5555) at the end
#   -s SERIAL       which device, when more than one is plugged in
#
# Needs Android platform-tools (adb) on PATH or in ./platform-tools/.
set -u

PKG="za.co.arsmarthome.nspanel"
OWNER_ADMIN="$PKG/.KioskAdmin"
CTRL="$PKG/.KioskControl"
REPO="marsh4200/ar_nspanel_pro"
HERE="$(cd "$(dirname "$0")" && pwd)"

MODE="install"; APK=""; OWNER=1; KIOSK=0; TCPIP=1; SERIAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --takeover) MODE="takeover" ;;
    --restore) MODE="restore" ;;
    --uninstall) MODE="uninstall" ;;
    --apk) APK="$2"; shift ;;
    --no-owner) OWNER=0 ;;
    --kiosk) KIOSK=1 ;;
    --no-tcpip) TCPIP=0 ;;
    -s) SERIAL="$2"; shift ;;
    -h|--help) sed -n 2,22p "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
  shift
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

ADB_BIN="$(command -v adb || true)"
[ -z "$ADB_BIN" ] && [ -x "$HERE/platform-tools/adb" ] && ADB_BIN="$HERE/platform-tools/adb"
[ -z "$ADB_BIN" ] && die "adb not found. Install Android platform-tools, or unzip them into $HERE/platform-tools/"
adb_() { if [ -n "$SERIAL" ]; then "$ADB_BIN" -s "$SERIAL" "$@"; else "$ADB_BIN" "$@"; fi; }
sh_()  { adb_ shell "$@" 2>&1 | tr -d '\r'; }

installed() { sh_ pm list packages "$1" | grep -qx "package:$1"; }
owner_pkg() { sh_ dumpsys device_policy | sed -n 's/.*admin=ComponentInfo{\([^/}]*\)\/.*/\1/p' | head -1; }

# HDL's own app + launcher (Source 10 / S10: com.hdl.source.ten[.launcher];
# Source 7: com.hdl.launcher + com.hdl.source). com.hdl.factory is never touched.
hdl_pkgs() {
  sh_ pm list packages com.hdl | sed -n 's/^package://p' | grep -v factory
}
hdl_launcher() { hdl_pkgs | grep '\.launcher$' | head -1; }
home_of() {
  sh_ cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME "$1" | tail -1
}
set_home() { # component package
  if sh_ cmd package set-home-activity "$1" | grep -qi success; then ok "Home -> $2"; return; fi
  sh_ cmd role add-role-holder android.app.role.HOME "$2" >/dev/null
  if sh_ cmd role get-role-holders android.app.role.HOME | grep -q "$2"; then ok "Home -> $2 (Home role)"
  else warn "Couldn't make $2 the Home app: press Home on the panel and pick it with 'Always'"; fi
}
unlock_owner() {
  if [ "$(owner_pkg)" = "$PKG" ]; then
    sh_ am broadcast -a za.co.arsmarthome.nspanel.KIOSK_UNLOCK -n "$CTRL" --include-stopped-packages >/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do sleep 0.4; [ "$(owner_pkg)" != "$PKG" ] && break; done
    if [ "$(owner_pkg)" = "$PKG" ]; then warn "The app is still device owner (it didn't answer)"; else ok "Released device owner"; fi
  fi
}

# --- device -------------------------------------------------------------------
step "Looking for the panel on USB…"
COUNT=$("$ADB_BIN" devices | sed 1d | grep -c 'device$' || true)
if [ -z "$SERIAL" ] && [ "${COUNT:-0}" -gt 1 ]; then
  "$ADB_BIN" devices -l; die "More than one device: run again with -s <serial>"
fi
echo "  (if the panel shows 'Allow USB debugging?', tick 'Always allow' and tap Allow)"
adb_ wait-for-device || die "No device"
STATE="$(adb_ get-state 2>&1)"
[ "$STATE" = "device" ] || die "Panel says '$STATE' — accept the USB debugging prompt on the panel and run again"
MODEL="$(sh_ getprop ro.product.model)"; SDK="$(sh_ getprop ro.build.version.sdk)"; REL="$(sh_ getprop ro.build.version.release)"
ok "Found $MODEL (Android $REL, SDK $SDK)"
HDL_L="$(hdl_launcher)"; [ -n "$HDL_L" ] && ok "HDL software found ($HDL_L)"

# --- restore / uninstall ----------------------------------------------------------
if [ "$MODE" = "restore" ] || [ "$MODE" = "uninstall" ]; then
  step "Giving the panel back to HDL…"
  unlock_owner
  for p in $(hdl_pkgs); do sh_ pm enable "$p" >/dev/null && ok "enabled $p"; done
  if [ -n "$HDL_L" ]; then set_home "$(home_of "$HDL_L")" "$HDL_L"; fi
  if [ "$MODE" = "uninstall" ]; then
    if installed "$PKG"; then
      OUT="$(adb_ uninstall "$PKG" 2>&1)"; echo "$OUT" | grep -q Success && ok "App uninstalled" || warn "Uninstall: $OUT"
    else ok "App wasn't installed"; fi
  fi
  sh_ input keyevent 3 >/dev/null
  step "Done."; exit 0
fi

# --- APK ----------------------------------------------------------------------------
step "Getting the app…"
if [ -z "$APK" ]; then
  APK="$(ls -t "$HERE"/ar-nspanel-pro-*.apk 2>/dev/null | head -1)"
fi
if [ -z "$APK" ]; then
  URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"browser_download_url": *"[^"]*\.apk"' | head -1 | sed 's/.*"\(http[^"]*\)"/\1/')"
  [ -z "$URL" ] && die "Couldn't find the latest release on GitHub. Download the APK and pass --apk FILE"
  APK="$HERE/$(basename "$URL")"
  echo "  downloading $(basename "$URL")…"
  curl -fL --progress-bar -o "$APK" "$URL" || die "Download failed"
fi
[ -f "$APK" ] || die "APK not found: $APK"
ok "$(basename "$APK")"

# --- install ----------------------------------------------------------------------
step "Installing over USB…"
OUT="$(adb_ install -r -d -g "$APK" 2>&1)"
if ! echo "$OUT" | grep -q Success; then
  if echo "$OUT" | grep -qiE 'signatures do not match|UPDATE_INCOMPATIBLE|INCONSISTENT_CERTIFICATES'; then
    die "A copy signed with a different key is on the panel. Run with --uninstall first (wipes its settings), then again."
  fi
  die "Install failed: $OUT"
fi
ok "Installed $(sh_ dumpsys package "$PKG" | sed -n 's/.*versionName=//p' | head -1)"

step "Permissions for updates without ADB…"
sh_ pm grant "$PKG" android.permission.WRITE_SECURE_SETTINGS >/dev/null && ok "may keep USB debugging switched on"
sh_ appops set "$PKG" SYSTEM_ALERT_WINDOW allow >/dev/null && ok "may start itself after a reboot / update"
sh_ appops set "$PKG" REQUEST_INSTALL_PACKAGES allow >/dev/null && ok "may install its own updates"
OUT="$(sh_ pm set-installer "$PKG" "$PKG")"
if echo "$OUT" | grep -qiE 'error|exception|unknown'; then warn "couldn't set installer of record: $OUT"; else ok "is its own installer (Android 12+: silent updates)"; fi

sh_ am start -n "$PKG/.MainActivity" >/dev/null

UPDATE_MODE="tap Update on the panel once per update"
if [ "$OWNER" = 1 ]; then
  step "Device owner (silent updates)…"
  CUR="$(owner_pkg)"
  if [ "$CUR" = "$PKG" ]; then
    ok "already device owner"; UPDATE_MODE="silent"
  elif [ -n "$CUR" ]; then
    warn "$CUR is this panel's device owner already: skipped"
  else
    # no lock first (the activity locks itself whenever it is owner, unless told not to)
    [ "$KIOSK" = 1 ] || sh_ am broadcast -a za.co.arsmarthome.nspanel.KIOSK_OWNER_ONLY -n "$CTRL" --include-stopped-packages >/dev/null
    OUT="$(sh_ dpm set-device-owner "$OWNER_ADMIN")"
    if echo "$OUT" | grep -q Success; then
      ok "device owner (not locked)"; UPDATE_MODE="silent"
    else
      warn "Android refused device owner: $(echo "$OUT" | tail -2 | tr '\n' ' ')"
      echo "$OUT" | grep -qi account && warn "  An account is signed in on the panel (Settings > Accounts). Remove it and run again for silent updates."
      echo "$OUT" | grep -qiE 'already (has|provisioned)|users' && warn "  Android only allows this on a freshly set-up panel; updates will ask for a tap instead."
    fi
  fi
  if [ "$KIOSK" = 1 ]; then
    sh_ am broadcast -a za.co.arsmarthome.nspanel.KIOSK_LOCK -n "$CTRL" >/dev/null && ok "kiosk lock on"
  fi
fi
if [ "$UPDATE_MODE" != "silent" ] && [ "${SDK:-0}" -ge 31 ]; then UPDATE_MODE="silent (Android 12+)"; fi

# --- take over from HDL -------------------------------------------------------------
if [ "$MODE" = "takeover" ]; then
  step "Taking the panel over from HDL…"
  set_home "$PKG/.MainActivity" "$PKG"
  for p in $(hdl_pkgs | grep -v '\.launcher$'); do ok "$p: $(sh_ pm disable-user --user 0 "$p")"; done
  [ -n "$HDL_L" ] && ok "$HDL_L: $(sh_ pm disable-user --user 0 "$HDL_L")"
  sh_ settings put global device_provisioned 1 >/dev/null
  sh_ settings put secure user_setup_complete 1 >/dev/null
  sh_ settings put global adb_enabled 1 >/dev/null
  set_home "$PKG/.MainActivity" "$PKG"
  sh_ am start -n "$PKG/.MainActivity" >/dev/null
fi

# --- network ADB (optional: lets HA's Setup/Update tools reach the panel too) ---------
PERSIST=""
IP="$(sh_ ip -4 -o addr show | awk '$2!="lo"{print $4}' | cut -d/ -f1 | head -1)"
if [ "$TCPIP" = 1 ]; then
  step "Network ADB (for Home Assistant's ADB tools — not needed for updates)…"
  if sh_ 'command -v su' | grep -q su; then
    sh_ su 0 setprop persist.adb.tcp.port 5555 >/dev/null
    if [ "$(sh_ getprop persist.adb.tcp.port)" = "5555" ]; then ok "port 5555, kept after reboots (root)"; PERSIST=1; fi
  fi
  adb_ tcpip 5555 >/dev/null 2>&1 && ok "on now: ${IP:-<panel-ip>}:5555" || warn "this firmware won't do network ADB"
  [ -z "$PERSIST" ] && warn "no root: network ADB goes off at the next reboot (updates don't need it)"
fi

step "Done."
echo "  Panel IP:   ${IP:-unknown}"
echo "  Updates:    $UPDATE_MODE"
echo "  Next:       on the panel's setup screen enter the broker (ws://<home-assistant>:1884),"
echo "              then in Home Assistant: Settings > Updates > <panel> App > Install."
