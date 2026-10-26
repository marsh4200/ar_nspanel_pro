#!/system/bin/sh
# AR Smart Home: undo aku-clean.sh - the Akubela services run again.
# Run as root:  su 0 sh /data/local/tmp/aku-restore.sh
export PATH=/system/bin:/system/xbin:$PATH

rm -f /data/local/tmp/ar_aku_off /data/local/tmp/aku-stop.sh /data/local/tmp/ar_ledoff.py /tmp/kill_ha /tmp/kill_mqtt

# older versions (2.0.20-2.0.24) edited the boot files: put the originals back
for bak in $(ls /system/etc/init/*.ar_bak /system/etc/init/hw/*.ar_bak /vendor/etc/init/*.ar_bak /vendor/etc/init/hw/*.ar_bak 2>/dev/null); do
  mount -o remount,rw / 2>/dev/null || mount -o remount,rw /system
  mount -o remount,rw /vendor 2>/dev/null
  rc=${bak%.ar_bak}
  cat "$bak" > "$rc" && rm -f "$bak" && echo "restored $rc"
done
mount -o remount,ro / 2>/dev/null
mount -o remount,ro /vendor 2>/dev/null

for s in log_debug pmonitor autop lighttpd sipall netcast dclient homeassistant gesturekit knx dropbear; do setprop ctl.start $s; done
echo "done - the Akubela services run again (restart the panel to be sure)"
