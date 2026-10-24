#!/system/bin/sh
# AR Smart Home: switch off the Akubela/Akuvox background services so only
# Android and the AR app run. Undo with aku-restore.sh (backups are kept).
# Run as root:  su 0 sh /data/local/tmp/aku-clean.sh

# Android's own (toybox) tools first: this panel also has a 2009 BusyBox in its PATH
export PATH=/system/bin:/system/xbin:$PATH

SVCS="log_debug pmonitor autop lighttpd sipall netcast dclient homeassistant gesturekit knx dropbear"
set -f

# mark every listed "service <name>" in an init .rc file as disabled
disable_in() {
  rc=$1
  [ -f "$rc.ar_bak" ] || cp "$rc" "$rc.ar_bak"
  cp "$rc.ar_bak" "/data/local/tmp/$(basename "$rc").ar_bak"
  : > /data/local/tmp/rc.new
  while IFS= read -r line || [ -n "$line" ]; do
    echo "$line" >> /data/local/tmp/rc.new
    set -- $line
    if [ "$1" = "service" ]; then
      case " $SVCS " in
        *" $2 "*) echo "    disabled" >> /data/local/tmp/rc.new; echo "  disabled at boot: $2 ($rc)";;
      esac
    fi
  done < "$rc.ar_bak"
  cat /data/local/tmp/rc.new > "$rc"
  rm -f /data/local/tmp/rc.new
}

echo "== making the system writable =="
mount -o remount,rw / 2>/dev/null || mount -o remount,rw /system
mount -o remount,rw /vendor 2>/dev/null

echo "== boot files =="
for rc in $(grep -rlE "^service ($(echo $SVCS | tr ' ' '|')) " /system/etc/init /vendor/etc/init 2>/dev/null); do
  disable_in "$rc"
done

mount -o remount,ro / 2>/dev/null
mount -o remount,ro /vendor 2>/dev/null

echo "== stopping them now =="
touch /tmp/kill_ha /tmp/kill_mqtt
for s in $SVCS; do setprop ctl.stop $s; done
sleep 2
killall python3.9 knx mosquitto 2>/dev/null

echo "== still running (should be empty) =="
getprop | grep init.svc | grep running | grep -E "\[init.svc.($(echo $SVCS | tr ' ' '|'))\]"
echo "done - restart the panel to check it stays off"
