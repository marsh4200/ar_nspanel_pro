package za.co.arsmarthome.nspanel

import android.Manifest
import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.wifi.SupplicantState
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSuggestion
import android.os.Build
import android.provider.Settings
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Wi-Fi from the setup screen (hold the top-left corner), on every panel:
 * scan, pick a network, type the password, connect. Moves a panel to a new
 * site's Wi-Fi without a factory reset.
 *
 * How it joins depends on what Android allows the app:
 *  * device owner (locked panels, the HDL Source 7) or Android 9 and older
 *    (NSPanel Pro, Android 5 panels): the classic WifiManager calls join directly;
 *  * Android 11+ otherwise (HDL Source 10): Android's own "Save this network?"
 *    sheet opens with the name and password filled in; one tap on Save joins it;
 *  * Android 10 otherwise: Android's Wi-Fi panel opens to finish there.
 */
@Suppress("DEPRECATION")
object Wifi {
    private const val TAG = "ARWifi"

    private fun wm(c: Context) = c.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    private fun q(s: String) = "\"" + s.replace("\"", "") + "\""

    /** The network connect() is joining now, and the one the panel was on before
     * (for rollback() when the join doesn't work). -1: none. */
    @Volatile
    private var joinId = -1
    @Volatile
    private var prevId = -1
    /** connect() added joinId itself (so rollback() may remove it again). */
    @Volatile
    private var joinAdded = false
    /** connect() failed because Android keeps a saved copy the app may not change. */
    @Volatile
    private var blocked = false

    private var lock: WifiManager.WifiLock? = null

    /** Keep the Wi-Fi radio out of power-save while the panel screen runs: a
     * sleepy radio answers late, which looks like a dropped connection. */
    fun hold(c: Context) {
        if (lock != null) return
        try {
            lock = wm(c).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "ar:panel").also {
                it.setReferenceCounted(false)
                it.acquire()
            }
        } catch (e: Exception) {
            Log.w(TAG, "wifi lock", e)
        }
    }

    fun release() {
        try {
            lock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) {
            Log.w(TAG, "wifi unlock", e)
        }
        lock = null
    }

    /** What the last scan says about this network ("[WPA2-PSK-CCMP][ESS]"), or
     * null when the scan didn't see it (hidden, out of range, or no scan). */
    private fun caps(c: Context, ssid: String): String? = try {
        wm(c).scanResults?.filter { it.SSID == ssid }?.maxByOrNull { it.level }?.capabilities
    } catch (e: Exception) {
        null
    }

    /** WPA3 only (no WPA2 fallback): the classic join can't do it. */
    private fun wpa3Only(cap: String?) = cap != null && cap.contains("SAE") && !cap.contains("PSK")
    private fun unq(s: String?) = (s ?: "").removePrefix("\"").removeSuffix("\"")

    /** Can join directly with WifiManager (else Android's own screens finish it). */
    fun direct(c: Context): Boolean = Build.VERSION.SDK_INT < 29 || Kiosk.isOwner(c)

    private fun hasLocation(c: Context): Boolean =
        Build.VERSION.SDK_INT < 23 ||
            c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            c.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Scanning (and reading the current network's name) needs location access
     * on Android 6+. Home Assistant's installer grants it over ADB; a panel set
     * up another way asks once on screen. */
    private fun askLocation(c: Context) {
        if (hasLocation(c) || Build.VERSION.SDK_INT < 23) return
        val a = c as? Activity ?: return
        a.runOnUiThread {
            try {
                a.requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), REQ_LOCATION)
            } catch (e: Exception) {
                Log.w(TAG, "location ask", e)
            }
        }
    }

    /** Android 9+ only returns scan results while Location is on. With
     * WRITE_SECURE_SETTINGS (granted by the installer) the app switches it on. */
    private fun locationOn(c: Context) {
        if (Build.VERSION.SDK_INT < 28) return
        try {
            val cr = c.contentResolver
            if (Settings.Secure.getInt(cr, Settings.Secure.LOCATION_MODE, 0) == 0 &&
                c.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED
            ) {
                Settings.Secure.putInt(cr, Settings.Secure.LOCATION_MODE, Settings.Secure.LOCATION_MODE_HIGH_ACCURACY)
            }
        } catch (e: Exception) {
            Log.w(TAG, "location on", e)
        }
    }

    private const val REQ_LOCATION = 7102

    /** Device owner grants itself the location permission scanning needs (Android 9+). */
    private fun grant(c: Context) {
        if (Build.VERSION.SDK_INT < 23) return
        if (!Kiosk.isOwner(c)) {
            askLocation(c)
            locationOn(c)
            return
        }
        try {
            val d = c.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val ad = ComponentName(c, KioskAdmin::class.java)
            for (p in arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) {
                d.setPermissionGrantState(ad, c.packageName, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
            }
            locationOn(c)
        } catch (e: Exception) {
            Log.w(TAG, "grant failed", e)
        }
    }

    /** {"enabled":true,"ssid":"Home","rssi":-55,"ip":"192.168.1.20","state":"COMPLETED"} */
    fun info(c: Context): String {
        val o = JSONObject()
        try {
            val w = wm(c)
            o.put("enabled", w.isWifiEnabled)
            o.put("direct", direct(c))
            o.put("location", hasLocation(c))
            val i = w.connectionInfo
            if (i != null) {
                val ssid = unq(i.ssid)
                o.put("ssid", if (ssid == "<unknown ssid>") "" else ssid)
                o.put("rssi", i.rssi)
                o.put("state", i.supplicantState?.name ?: "")
                val ip = i.ipAddress
                o.put("ip", if (ip == 0) "" else "${ip and 255}.${ip shr 8 and 255}.${ip shr 16 and 255}.${ip shr 24 and 255}")
                // on the network connect() asked for: true even when Android
                // hides the network's name (location off / not allowed)
                o.put("joined", joinId >= 0 && i.networkId == joinId && ip != 0 && i.supplicantState == SupplicantState.COMPLETED)
            }
        } catch (e: Exception) {
            o.put("error", e.message ?: "error")
        }
        return o.toString()
    }

    /** Start a scan (results come from list() a few seconds later). */
    fun scan(c: Context): Boolean = try {
        grant(c)
        val w = wm(c)
        if (!w.isWifiEnabled) w.isWifiEnabled = true
        w.startScan()
        true
    } catch (e: Exception) {
        Log.w(TAG, "scan failed", e)
        false
    }

    /** [{"ssid":"Home","rssi":-50,"secure":true}], strongest first, one per name. */
    fun list(c: Context): String {
        val best = HashMap<String, JSONObject>()
        try {
            for (r in wm(c).scanResults ?: emptyList()) {
                val ssid = r.SSID ?: ""
                if (ssid.isBlank()) continue
                val cap = r.capabilities ?: ""
                val prev = best[ssid]
                if (prev != null && prev.getInt("rssi") >= r.level) continue
                best[ssid] = JSONObject()
                    .put("ssid", ssid)
                    .put("rssi", r.level)
                    .put("secure", cap.contains("WPA") || cap.contains("PSK") || cap.contains("SAE") || cap.contains("WEP") || cap.contains("EAP"))
                    .put("enterprise", cap.contains("EAP"))
                    .put("wpa3only", wpa3Only(cap) && direct(c))
            }
        } catch (e: Exception) {
            Log.w(TAG, "list failed", e)
        }
        val a = JSONArray()
        best.values.sortedByDescending { it.getInt("rssi") }.forEach { a.put(it) }
        return a.toString()
    }

    /**
     * Join a network on any panel. Returns how:
     *  "ok"       joining directly (watch info() for the new IP),
     *  "dialog"   Android's "Save this network?" sheet is open, filled in: tap Save,
     *  "settings" Android's Wi-Fi panel is open to finish there,
     *  "fail"     Android refused.
     */
    fun join(c: Context, ssid: String, pass: String): String {
        if (direct(c)) {
            if (connect(c, ssid, pass)) return "ok"
            // Android keeps its own saved copy of this network and the app may
            // not change it (Android 6+): finish on Android's Wi-Fi screen
            if (blocked && !Kiosk.isOwner(c) && c is Activity && openSettings(c)) return "settings"
            return "fail"
        }
        val a = c as? Activity ?: return "fail"
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                val b = WifiNetworkSuggestion.Builder().setSsid(ssid)
                if (pass.isNotEmpty()) {
                    if (wpa3Only(caps(c, ssid))) b.setWpa3Passphrase(pass) else b.setWpa2Passphrase(pass)
                }
                if (caps(c, ssid) == null) b.setIsHiddenSsid(true) // not in the scan: hidden
                val list = ArrayList<WifiNetworkSuggestion>()
                list.add(b.build())
                val i = Intent(Settings.ACTION_WIFI_ADD_NETWORKS)
                    .putParcelableArrayListExtra(Settings.EXTRA_WIFI_NETWORK_LIST, list)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                a.startActivity(i) // throws when this Android has no such sheet
                return "dialog"
            } catch (e: Exception) {
                Log.w(TAG, "add-network sheet", e)
            }
        }
        return if (openSettings(a)) "settings" else "fail"
    }

    /** Android's own Wi-Fi screen (the quick panel on Android 10+). */
    fun openSettings(a: Activity): Boolean {
        val intents = ArrayList<Intent>()
        if (Build.VERSION.SDK_INT >= 29) intents.add(Intent(Settings.Panel.ACTION_WIFI))
        intents.add(Intent(Settings.ACTION_WIFI_SETTINGS))
        for (i in intents) {
            try {
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                a.startActivity(i) // a blocked or missing screen throws: try the next
                return true
            } catch (e: Exception) {
                Log.w(TAG, "wifi settings", e)
            }
        }
        return false
    }

    /** Join a network (WPA/WPA2 password, or open when the password is empty).
     * The network the panel is on stays saved until the new one works: see
     * rollback() and keepOnly(). */
    fun connect(c: Context, ssid: String, pass: String): Boolean {
        blocked = false
        return try {
            grant(c)
            val w = wm(c)
            if (!w.isWifiEnabled) w.isWifiEnabled = true
            val before = w.connectionInfo?.networkId ?: -1
            val conf = WifiConfiguration()
            conf.SSID = q(ssid)
            // not in the scan results: a hidden network, which Android only
            // finds when told to ask for it by name
            if (caps(c, ssid) == null) conf.hiddenSSID = true
            if (pass.isEmpty()) {
                conf.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
            } else {
                conf.preSharedKey = q(pass)
                conf.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK)
            }
            // a saved copy of the same name (it may hold an old password): give
            // it the new details in place; only when Android refuses that, drop
            // it and add the network fresh
            val old = try {
                w.configuredNetworks?.filter { unq(it.SSID) == ssid } ?: emptyList()
            } catch (e: Exception) {
                Log.w(TAG, "old copy", e)
                emptyList()
            }
            var id = -1
            var added = false
            for (o in old) {
                conf.networkId = o.networkId
                if (w.updateNetwork(conf) >= 0) {
                    id = o.networkId
                    break
                }
            }
            if (id < 0) {
                var stuck = false
                for (o in old) if (!w.removeNetwork(o.networkId)) stuck = true
                conf.networkId = -1
                id = w.addNetwork(conf)
                added = id >= 0
                if (id < 0 && stuck) blocked = true
            }
            if (id < 0) {
                Log.w(TAG, "Android refused $ssid" + if (blocked) " (its saved copy isn't the app's to change)" else "")
                return false
            }
            prevId = if (before != id) before else -1
            joinAdded = added
            joinId = id
            w.disconnect()
            val ok = w.enableNetwork(id, true)
            w.reconnect()
            w.saveConfiguration()
            ok
        } catch (e: Exception) {
            Log.w(TAG, "connect failed", e)
            false
        }
    }

    /** The join didn't work (wrong password, out of range): forget the network
     * connect() added and go back to the one the panel was on before. */
    fun rollback(c: Context): Boolean {
        val id = joinId
        val back = prevId
        joinId = -1
        prevId = -1
        if (!direct(c)) return false
        return try {
            val w = wm(c)
            if (id >= 0 && joinAdded) w.removeNetwork(id)
            // enableNetwork(id, true) may have switched the other saved networks off
            w.configuredNetworks?.forEach { if (it.networkId != id) w.enableNetwork(it.networkId, false) }
            val ok = back >= 0 && w.enableNetwork(back, true)
            w.reconnect()
            w.saveConfiguration()
            ok
        } catch (e: Exception) {
            Log.w(TAG, "rollback failed", e)
            false
        }
    }

    /** Once the new Wi-Fi works: forget every other saved network so the panel can't fall back.
     * Only where the app may manage saved networks (direct()); elsewhere Android keeps them.
     * False when Android kept one (Android 6+: a network the app didn't save itself). */
    fun keepOnly(c: Context, ssid: String): Boolean {
        joinId = -1
        prevId = -1
        if (!direct(c)) return false
        return try {
            val w = wm(c)
            var all = true
            w.configuredNetworks?.forEach {
                if (unq(it.SSID) == ssid) w.enableNetwork(it.networkId, false)
                else if (!w.removeNetwork(it.networkId)) all = false
            }
            w.saveConfiguration()
            all
        } catch (e: Exception) {
            Log.w(TAG, "keepOnly failed", e)
            false
        }
    }
}
