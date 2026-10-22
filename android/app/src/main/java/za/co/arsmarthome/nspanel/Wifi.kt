package za.co.arsmarthome.nspanel

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Wi-Fi from the setup screen's recovery section (locked panels = device
 * owner, the HDL Source 7). A locked panel can't open Android's Settings, so
 * moving it to a new site's Wi-Fi without a factory reset happens here:
 * scan, pick a network, type the password, connect.
 *
 * Uses the classic WifiManager calls. On Android 10+ those only work for the
 * device owner, which is the only time the setup screen shows this.
 */
@Suppress("DEPRECATION")
object Wifi {
    private const val TAG = "ARWifi"

    private fun wm(c: Context) = c.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    private fun q(s: String) = "\"" + s.replace("\"", "") + "\""
    private fun unq(s: String?) = (s ?: "").removePrefix("\"").removeSuffix("\"")

    /** Device owner grants itself the location permission scanning needs (Android 9+). */
    private fun grant(c: Context) {
        if (Build.VERSION.SDK_INT < 23 || !Kiosk.isOwner(c)) return
        try {
            val d = c.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val ad = ComponentName(c, KioskAdmin::class.java)
            for (p in arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) {
                d.setPermissionGrantState(ad, c.packageName, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
            }
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
            val i = w.connectionInfo
            if (i != null) {
                val ssid = unq(i.ssid)
                o.put("ssid", if (ssid == "<unknown ssid>") "" else ssid)
                o.put("rssi", i.rssi)
                o.put("state", i.supplicantState?.name ?: "")
                val ip = i.ipAddress
                o.put("ip", if (ip == 0) "" else "${ip and 255}.${ip shr 8 and 255}.${ip shr 16 and 255}.${ip shr 24 and 255}")
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
            }
        } catch (e: Exception) {
            Log.w(TAG, "list failed", e)
        }
        val a = JSONArray()
        best.values.sortedByDescending { it.getInt("rssi") }.forEach { a.put(it) }
        return a.toString()
    }

    /** Join a network (WPA/WPA2 password, or open when the password is empty). */
    fun connect(c: Context, ssid: String, pass: String): Boolean {
        return try {
            grant(c)
            val w = wm(c)
            if (!w.isWifiEnabled) w.isWifiEnabled = true
            // drop an old saved copy of the same name (it may hold an old password)
            try {
                w.configuredNetworks?.filter { unq(it.SSID) == ssid }?.forEach { w.removeNetwork(it.networkId) }
            } catch (e: Exception) {
                Log.w(TAG, "old copy", e)
            }
            val conf = WifiConfiguration()
            conf.SSID = q(ssid)
            if (pass.isEmpty()) {
                conf.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
            } else {
                conf.preSharedKey = q(pass)
                conf.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK)
            }
            val id = w.addNetwork(conf)
            if (id < 0) return false
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

    /** Once the new Wi-Fi works: forget every other saved network so the panel can't fall back. */
    fun keepOnly(c: Context, ssid: String) {
        try {
            val w = wm(c)
            w.configuredNetworks?.forEach {
                if (unq(it.SSID) == ssid) w.enableNetwork(it.networkId, false)
                else w.removeNetwork(it.networkId)
            }
            w.saveConfiguration()
        } catch (e: Exception) {
            Log.w(TAG, "keepOnly failed", e)
        }
    }
}
