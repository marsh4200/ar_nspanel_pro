#!/system/bin/sh
# AR Smart Home: strip the panel down to Android + the AR app (any panel).
# Reversible: apps are switched off, never deleted. Undo: ar-unoptimise.sh.
# Run as root when the panel has root (su 0 sh ...); without root the parts
# that need it are skipped.
export PATH=/system/bin:/system/xbin:$PATH   # Android's own tools, not an old BusyBox
PM=/system/bin/pm; ST=/system/bin/settings
ROOT=0; [ "$(id -u)" = "0" ] && ROOT=1

# apps a wall panel never uses (each only if this panel has it)
APPS="
acr.browser.barebones com.android.quicksearchbox com.android.htmlviewer com.android.bookmarkprovider
com.android.calculator2 com.android.calendar com.android.contacts com.android.deskclock
com.android.camera2 com.android.gallery3d com.android.music com.android.musicfx com.android.soundrecorder
android.rk.RockVideoPlayer com.android.egg com.android.traceur com.DeviceTest
com.android.dreams.basic com.android.dreams.phototable
com.android.wallpaper.livepicker com.android.wallpaperpicker com.android.wallpapercropper com.android.wallpaperbackup
com.android.printspooler com.android.bips com.android.printservice.recommendation
com.android.smspush com.android.mms.service com.android.simappdialog
com.android.statementservice com.android.documentsui com.android.storagemanager
com.android.hotspot2.osulogin com.android.bluetoothmidiservice
"
# Akubela apps marked "always running": the firmware starts them even when
# they are switched off, so they are removed for the panel's user instead
# (still on the system; ar-unoptimise.sh / "Back to Akubela screen" bring them back).
RESIDENT="com.akuvox.voiceassist com.cghs.stresstest"

echo "== switching off unused apps =="
for p in $APPS; do
  $PM path "$p" >/dev/null 2>&1 && $PM disable-user --user 0 "$p" >/dev/null 2>&1 && echo "off     $p"
done
echo "== removing always-running Akubela leftovers (for this user only) =="
for p in $RESIDENT; do
  $PM path "$p" >/dev/null 2>&1 && $PM uninstall -k --user 0 "$p" >/dev/null 2>&1 && echo "removed $p"
done
if [ $ROOT = 1 ]; then
  # Akubela face recognition's AI-chip server (the AR app doesn't use the NPU);
  # init starts it again at boot, so the AR app stops it at every start too
  [ "$(getprop init.svc.rknn_server)" = "running" ] && setprop ctl.stop rknn_server && echo "stopped rknn_server"
  touch /data/local/tmp/ar_optimised && chmod 644 /data/local/tmp/ar_optimised
else
  echo "(no root: rknn_server left running)"
fi
echo "== settings =="
$ST put global window_animation_scale 0
$ST put global transition_animation_scale 0
$ST put global animator_duration_scale 0
$ST put global wifi_networks_available_notification_on 0
$ST put global heads_up_notifications_enabled 0
echo "animations off, Wi-Fi and heads-up pop-ups off"
echo "done"
