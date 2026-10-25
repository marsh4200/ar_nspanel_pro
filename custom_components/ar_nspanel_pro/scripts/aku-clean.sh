#!/system/bin/sh
# AR Smart Home: switch off the Akubela/Akuvox background services so only
# Android and the AR app run. Undo with aku-restore.sh.
# Run as root:  su 0 sh /data/local/tmp/aku-clean.sh
#
# The panel's boot files are NOT edited (a damaged init file stops Android
# booting). Instead this leaves a small stop script; the AR app runs it as
# root every time the panel starts, which stops the services again.

# Android's own (toybox) tools first: this panel also has a 2009 BusyBox in its PATH
export PATH=/system/bin:/system/xbin:$PATH

# undo the boot-file edits made by older versions (2.0.20-2.0.24)
for bak in $(ls /system/etc/init/*.ar_bak /system/etc/init/hw/*.ar_bak /vendor/etc/init/*.ar_bak /vendor/etc/init/hw/*.ar_bak 2>/dev/null); do
  mount -o remount,rw / 2>/dev/null || mount -o remount,rw /system
  mount -o remount,rw /vendor 2>/dev/null
  rc=${bak%.ar_bak}
  cat "$bak" > "$rc" && rm -f "$bak" && echo "put back the original $rc"
done
mount -o remount,ro / 2>/dev/null
mount -o remount,ro /vendor 2>/dev/null

cat > /data/local/tmp/aku-stop.sh <<'STOP'
#!/system/bin/sh
export PATH=/system/bin:/system/xbin:$PATH
touch /tmp/kill_ha /tmp/kill_mqtt 2>/dev/null
for s in log_debug pmonitor autop lighttpd sipall netcast dclient homeassistant gesturekit knx dropbear; do
  setprop ctl.stop $s
done
sleep 2
killall python3.9 knx mosquitto 2>/dev/null
STOP
chmod 755 /data/local/tmp/aku-stop.sh
touch /data/local/tmp/ar_aku_off

echo "== stopping them now =="
sh /data/local/tmp/aku-stop.sh
getprop | grep init.svc | grep running | grep -E "\[init.svc.(log_debug|pmonitor|autop|lighttpd|sipall|netcast|dclient|homeassistant|gesturekit|knx|dropbear)\]"
echo "done - the AR app stops them again on every start"
