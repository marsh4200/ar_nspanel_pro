package za.co.arsmarthome.nspanel

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.hardware.Sensor
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.webkit.JavascriptInterface
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URL

/**
 * `window.ARNative` — everything the panel UI cannot do from a web page.
 * Methods are called on the WebView's JavaBridge thread; anything touching
 * views hops to the UI thread.
 */
@androidx.media3.common.util.UnstableApi
class NativeBridge(private val activity: MainActivity) {

    private val prefs = activity.getSharedPreferences("panel", Context.MODE_PRIVATE)
    private val cacheDir = File(activity.filesDir, "ui-cache").apply { mkdirs() }

    // --- settings + offline cache --------------------------------------------

    @JavascriptInterface
    fun getSettings(): String {
        StartupGuard.ok(activity) // the page is up and talking to the app: this start worked
        return prefs.getString("settings", "{}") ?: "{}"
    }

    @JavascriptInterface
    fun saveSettings(json: String) {
        prefs.edit().putString("settings", json).apply()
    }

    fun uiUrl(): String? = try {
        (MiniJson.parse(getSettings()) as? Map<*, *>)?.get("uiUrl") as? String
    } catch (e: Exception) {
        null
    }

    @JavascriptInterface
    fun setUiUrl(url: String) {
        val current = try {
            (MiniJson.parse(getSettings()) as? Map<*, *>)?.toMutableMap() ?: mutableMapOf()
        } catch (e: Exception) {
            mutableMapOf<Any?, Any?>()
        }
        current["uiUrl"] = url
        saveSettings(toJson(current))
        activity.runOnUiThread { activity.loadUi() }
    }

    // --- RTSP cameras (Elegant cameras page) -----------------------------------

    /** Lay an RTSP camera over the page at x/y/w/h (screen pixels). */
    @JavascriptInterface
    fun rtspShow(id: String, url: String, name: String, x: Int, y: Int, w: Int, h: Int) {
        activity.runOnUiThread { activity.rtsp.show(id, url, name, x, y, w, h) }
    }

    /** Keep only these cameras (comma separated ids). */
    @JavascriptInterface
    fun rtspRetain(ids: String) {
        val keep = ids.split(",").filter { it.isNotBlank() }.toSet()
        activity.runOnUiThread { activity.rtsp.retain(keep) }
    }
    @JavascriptInterface
    fun rtspHideAll() {
        activity.runOnUiThread { activity.rtsp.hideAll() }
    }

    // --- kiosk recovery (setup screen, locked panels only) ---------------------

    @JavascriptInterface
    fun kioskState(): String =
        "{\"owner\":${Kiosk.isOwner(activity)},\"locked\":${Kiosk.isLocked(activity)}}"

    @JavascriptInterface
    fun kioskUnlock() {
        activity.runOnUiThread { Kiosk.unlock(activity, activity) }
    }

    /** Wipe the panel to factory state. Device owner (locked Source 7) only. */
    @JavascriptInterface
    fun factoryReset(): Boolean = Kiosk.wipe(activity)

    // --- Wi-Fi (setup screen, every panel) ---------------------------------------

    @JavascriptInterface
    fun wifiInfo(): String = Wifi.info(activity)

    @JavascriptInterface
    fun wifiScan(): Boolean = Wifi.scan(activity)

    @JavascriptInterface
    fun wifiList(): String = Wifi.list(activity)

    @JavascriptInterface
    fun wifiConnect(ssid: String, pass: String): Boolean = Wifi.connect(activity, ssid, pass)

    @JavascriptInterface
    fun wifiKeepOnly(ssid: String) = Wifi.keepOnly(activity, ssid)

    /** Join on any panel: "ok" | "dialog" | "settings" | "fail" (see Wifi.join). */
    @JavascriptInterface
    fun wifiJoin(ssid: String, pass: String): String = Wifi.join(activity, ssid, pass)

    /** Open Android's own Wi-Fi screen. */
    @JavascriptInterface
    fun wifiSettings(): Boolean = Wifi.openSettings(activity)

    // --- other apps (the music page's "Spotify app" button) -----------------

    @JavascriptInterface
    fun appInstalled(pkg: String): Boolean =
        activity.packageManager.getLaunchIntentForPackage(pkg) != null

    /** Open another app; a small "Panel" button floats over it to come back. */
    @JavascriptInterface
    fun launchApp(pkg: String): Boolean {
        val intent = activity.packageManager.getLaunchIntentForPackage(pkg) ?: return false
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.runOnUiThread {
            activity.showReturnButton()
            activity.startActivity(intent)
        }
        return true
    }

    @JavascriptInterface
    fun reload() {
        activity.runOnUiThread { activity.loadUi() }
    }

    private fun cacheFile(key: String) = File(cacheDir, key.replace(Regex("[^A-Za-z0-9_.-]"), "_") + ".json")

    @JavascriptInterface
    fun cacheGet(key: String): String? = cacheFile(key).takeIf { it.exists() }?.readText()

    @JavascriptInterface
    fun cachePut(key: String, json: String) {
        val f = cacheFile(key)
        if (json.isEmpty()) f.delete() else f.writeText(json)
    }

    // --- device info --------------------------------------------------------------

    @SuppressLint("HardwareIds")
    fun serverId(): String =
        (Settings.Secure.getString(activity.contentResolver, Settings.Secure.ANDROID_ID) ?: "").lowercase()

    @SuppressLint("PrivateApi")
    private fun hardwareSerial(): String? {
        return try {
            val sp = Class.forName("android.os.SystemProperties")
            val v = sp.getMethod("get", String::class.java).invoke(null, "ro.serialno") as String?
            v?.takeIf { it.isNotBlank() && it != "unknown" }
        } catch (e: Exception) {
            null
        }
    }

    private fun ip(): String? {
        return try {
            // the address of the network in use: the cable's when LAN is in use
            val ifs = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
                .filter { it.isUp && !it.isLoopback }
            val lan = LanFirst.via == "lan"
            ifs.sortedBy { if (it.name.startsWith(if (lan) "eth" else "wlan")) 0 else 1 }
                .flatMap { it.inetAddresses.toList() }
                .firstOrNull { it is Inet4Address }
                ?.hostAddress
        } catch (e: Exception) {
            null
        }
    }

    @Suppress("DEPRECATION")
    private fun rssi(): Int? = try {
        val wm = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        wm.connectionInfo?.rssi?.takeIf { it > -127 && it < 0 }
    } catch (e: Exception) {
        null
    }

    @JavascriptInterface
    fun getInfo(): String {
        val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        val version = try {
            activity.packageManager.getPackageInfo(activity.packageName, 0).versionName
        } catch (e: Exception) {
            null
        }
        val webview = activity.engine.version
        val m = linkedMapOf<Any?, Any?>(
            "model" to (Build.MANUFACTURER + " " + Build.MODEL).trim(),
            "version" to version,
            "fwVersion" to Build.DISPLAY,
            "android" to Build.VERSION.RELEASE,
            "serial" to hardwareSerial(),
            "serverId" to serverId(),
            "ip" to ip(),
            "net" to LanFirst.via,
            "rssi" to rssi(),
            "uptimeS" to SystemClock.elapsedRealtime() / 1000,
            "freeMemMB" to mi.availMem / (1024 * 1024),
            "webview" to webview,
            "versionCode" to Updater.versionCode(activity),
            // which APK this is: "standard" (WebView, Android 7+) or "legacy"
            // (UI in Chrome, Android 5+). HA updates each panel with its own kind.
            "build" to Engines.BUILD,
            "engine" to activity.engine.kind,
            // how an over-the-air update would install: silent | prompt | none
            "updater" to Updater.mode(activity),
            "owner" to Kiosk.isOwner(activity),
        )
        // Recognised consumer-tablet panels tag themselves so the setup screen
        // can name the hardware. Null (absent) on every other device, so their
        // payload is unchanged.
        Device.hardwareTag?.let { m["hardware"] = it }
        return toJson(m)
    }

    // --- ADB (find / keep it reachable) -------------------------------------------

    @JavascriptInterface
    fun adbStatus(): String = toJson(AdbHelper.status(activity))

    /** Scan this device for ADB ports in the background; answers as event "adb". */
    @JavascriptInterface
    fun findAdb(id: String) {
        Thread {
            val m = LinkedHashMap<Any?, Any?>(AdbHelper.status(activity))
            m["id"] = id
            m["ip"] = ip()
            m["ports"] = AdbHelper.findPorts()
            activity.emit("adb", toJson(m))
        }.start()
    }

    @JavascriptInterface
    fun enableAdb(wireless: Boolean): Boolean = AdbHelper.enable(activity, wireless)

    @JavascriptInterface
    fun openAdbSettings(): Boolean = AdbHelper.openSettings(activity)

    // --- over-the-air app update (no ADB) -------------------------------------------

    /** Hosts that count as "this panel's own Home Assistant": the broker and the UI URL. */
    private fun homeHosts(): Set<String> {
        val out = HashSet<String>()
        try {
            val m = MiniJson.parse(getSettings()) as? Map<*, *>
            for (k in listOf("brokerUrl", "uiUrl")) {
                val v = m?.get(k) as? String ?: continue
                java.net.URI(v.trim()).host?.let { out.add(it.lowercase()) }
            }
        } catch (e: Exception) {
        }
        return out
    }

    /** Download and install a new app version; progress arrives as the "update" event. */
    @JavascriptInterface
    fun updateApp(url: String, sha256: String, force: Boolean) {
        Updater.start(activity, url, sha256.ifBlank { null }, force, homeHosts()) { m ->
            activity.emit("update", MiniJson.stringify(m))
        }
    }

    /** {mode: silent|prompt|none, versionCode, last: <last status or null>} */
    @JavascriptInterface
    fun updateState(): String {
        val last = Updater.last(activity)
        return "{\"mode\":${MiniJson.quote(Updater.mode(activity))},\"versionCode\":${Updater.versionCode(activity)}," +
            "\"last\":${if (last.isEmpty()) "null" else last}}"
    }

    @JavascriptInterface
    fun getSensors(): String =
        "{\"light\":${activity.hasSensor(Sensor.TYPE_LIGHT)},\"proximity\":${activity.hasSensor(Sensor.TYPE_PROXIMITY)}}"

    // --- screen + audio ------------------------------------------------------------

    @JavascriptInterface
    fun setBrightness(level: Float) {
        activity.runOnUiThread { activity.applyBrightness(level) }
    }

    @JavascriptInterface
    fun keepScreenOn(on: Boolean) {
        activity.runOnUiThread { activity.keepOn(on) }
    }

    private fun audio() = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    @JavascriptInterface
    fun setVolume(level: Float): Boolean {
        val am = audio()
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(level.coerceIn(0f, 1f) * max), 0)
        return true
    }

    @JavascriptInterface
    fun getVolume(): Float {
        val am = audio()
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        return am.getStreamVolume(AudioManager.STREAM_MUSIC).toFloat() / max
    }

    // --- licence ------------------------------------------------------------------

    @JavascriptInterface
    fun verifyLicense(token: String): String =
        Licence.verify(token, serverId(), System.currentTimeMillis() / 1000).toJson()

    // --- screenshot ------------------------------------------------------------------

    @JavascriptInterface
    fun screenshot(id: String) {
        activity.runOnUiThread {
            try {
                activity.engine.capture { full ->
                    if (full == null) return@capture
                    val w = full.width
                    val h = full.height
                    // 480x480 is the panel's native size; bigger screens get scaled down
                    val scale = Math.min(1f, 480f / Math.max(w, h))
                    val out = if (scale < 1f) Bitmap.createScaledBitmap(full, (w * scale).toInt(), (h * scale).toInt(), true) else full
                    Thread {
                        val bos = ByteArrayOutputStream()
                        out.compress(Bitmap.CompressFormat.PNG, 100, bos)
                        val b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
                        activity.emit("screenshot", "{\"id\":${MiniJson.quote(id)},\"data\":\"$b64\"}")
                    }.start()
                }
            } catch (e: Exception) {
                android.util.Log.w("ARPanel", "screenshot failed", e)
            }
        }
    }

    // --- HTTP (Music Assistant login; avoids CORS) --------------------------------------

    @JavascriptInterface
    fun httpPost(id: String, url: String, body: String) {
        Thread {
            var status = -1
            var text: String
            try {
                val c = URL(url).openConnection() as HttpURLConnection
                c.requestMethod = "POST"
                c.connectTimeout = 8000
                c.readTimeout = 15000
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                status = c.responseCode
                val stream = if (status >= 400) c.errorStream else c.inputStream
                text = stream?.bufferedReader()?.use { it.readText() } ?: ""
                c.disconnect()
            } catch (e: Exception) {
                text = e.message ?: "network error"
            }
            activity.eval(
                "window.__arHttp&&window.__arHttp[${MiniJson.quote(id)}]&&window.__arHttp[${MiniJson.quote(id)}]($status,${MiniJson.quote(text)})",
            )
        }.start()
    }

    // --- helpers ------------------------------------------------------------------------

    private fun toJson(m: Map<*, *>): String {
        val sb = StringBuilder("{")
        var first = true
        for ((k, v) in m) {
            if (!first) sb.append(',')
            first = false
            sb.append(MiniJson.quote(k.toString())).append(':')
            sb.append(jsonValue(v))
        }
        return sb.append('}').toString()
    }

    private fun jsonValue(v: Any?): String = when (v) {
        null -> "null"
        is Number, is Boolean -> v.toString()
        is Map<*, *> -> toJson(v)
        is List<*> -> v.joinToString(",", "[", "]") { jsonValue(it) }
        else -> MiniJson.quote(v.toString())
    }
}
