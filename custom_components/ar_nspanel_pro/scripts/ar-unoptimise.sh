#!/system/bin/sh
# AR Smart Home: undo ar-optimise.sh.
export PATH=/system/bin:/system/xbin:$PATH
PM=/system/bin/pm; ST=/system/bin/settings
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
RESIDENT="com.akuvox.voiceassist com.cghs.stresstest"
for p in $APPS; do $PM path "$p" >/dev/null 2>&1 && $PM enable "$p" >/dev/null 2>&1 && echo "on      $p"; done
for p in $RESIDENT; do
  if $PM install-existing --user 0 "$p" >/dev/null 2>&1; then
    # still on the AR app ("Use AR app"): the Akubela software stays off
    [ -f /data/local/tmp/ar_aku_off ] && $PM disable-user --user 0 "$p" >/dev/null 2>&1
    echo "back    $p"
  fi
done
rm -f /data/local/tmp/ar_optimised 2>/dev/null
[ "$(id -u)" = "0" ] && setprop ctl.start rknn_server 2>/dev/null
$ST put global window_animation_scale 0.5
$ST put global transition_animation_scale 0.5
$ST put global animator_duration_scale 1
$ST put global wifi_networks_available_notification_on 1
$ST put global heads_up_notifications_enabled 1
echo "done - everything is back on"
