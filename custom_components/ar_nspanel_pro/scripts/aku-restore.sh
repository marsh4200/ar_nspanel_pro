#!/system/bin/sh
# AR Smart Home: undo aku-clean.sh - put the original Akubela boot files back
# and start their services again.
# Run as root:  su 0 sh /data/local/tmp/aku-restore.sh

# Android's own (toybox) tools first: this panel also has a 2009 BusyBox in its PATH
export PATH=/system/bin:/system/xbin:$PATH

SVCS="log_debug pmonitor autop lighttpd sipall netcast dclient homeassistant gesturekit knx dropbear"

mount -o remount,rw / 2>/dev/null || mount -o remount,rw /system
mount -o remount,rw /vendor 2>/dev/null
for bak in $(ls /system/etc/init/*.ar_bak /system/etc/init/hw/*.ar_bak /vendor/etc/init/*.ar_bak /vendor/etc/init/hw/*.ar_bak 2>/dev/null); do
  rc=${bak%.ar_bak}
  cat "$bak" > "$rc" && rm -f "$bak" && echo "restored $rc"
done
mount -o remount,ro / 2>/dev/null
mount -o remount,ro /vendor 2>/dev/null

rm -f /tmp/kill_ha /tmp/kill_mqtt
for s in $SVCS; do setprop ctl.start $s; done
echo "done - the Akubela services run again (restart the panel to be sure)"
