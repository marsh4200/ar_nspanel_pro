package za.co.arsmarthome.nspanel

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.hardware.Sensor
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
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
class NativeBridge(private val activity: MainActivity) {

    private val prefs = activity.getSharedPreferences("panel", Context.MODE_PRIVATE)
    private val cacheDir = File(activity.filesDir, "ui-cache").apply { mkdirs() }

    // --- settings + offline cache --------------------------------------------

    @JavascriptInterface
    fun getSettings(): String = prefs.getString("settings", "{}") ?: "{}"

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
            NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
                .filter { it.isUp && !it.isLoopback }
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
        val webview = if (Build.VERSION.SDK_INT >= 26) WebView.getCurrentWebViewPackage()?.versionName else null
        val m = linkedMapOf<Any?, Any?>(
            "model" to (Build.MANUFACTURER + " " + Build.MODEL).trim(),
            "version" to version,
            "fwVersion" to Build.DISPLAY,
            "android" to Build.VERSION.RELEASE,
            "serial" to hardwareSerial(),
            "serverId" to serverId(),
            "ip" to ip(),
            "rssi" to rssi(),
            "uptimeS" to SystemClock.elapsedRealtime() / 1000,
            "freeMemMB" to mi.availMem / (1024 * 1024),
            "webview" to webview,
        )
        return toJson(m)
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
                val wv = activity.webView
                val w = wv.width.coerceAtLeast(1)
                val h = wv.height.coerceAtLeast(1)
                val full = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                wv.draw(Canvas(full))
                // 480x480 is the panel's native size; bigger screens get scaled down
                val scale = Math.min(1f, 480f / Math.max(w, h))
                val out = if (scale < 1f) Bitmap.createScaledBitmap(full, (w * scale).toInt(), (h * scale).toInt(), true) else full
                Thread {
                    val bos = ByteArrayOutputStream()
                    out.compress(Bitmap.CompressFormat.PNG, 100, bos)
                    val b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
                    activity.emit("screenshot", "{\"id\":${MiniJson.quote(id)},\"data\":\"$b64\"}")
                }.start()
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
            when (v) {
                null -> sb.append("null")
                is Number, is Boolean -> sb.append(v.toString())
                else -> sb.append(MiniJson.quote(v.toString()))
            }
        }
        return sb.append('}').toString()
    }
}
