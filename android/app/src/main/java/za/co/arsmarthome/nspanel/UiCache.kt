package za.co.arsmarthome.nspanel

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * "Load UI from" an http:// Home Assistant address: Android only lets a page
 * use the microphone (intercom) from a secure origin, and plain http isn't one.
 * So the files are copied from HA onto the panel and run from there (file://,
 * which counts as secure), fresh on every load. HA unreachable: the last copy
 * runs; never copied: the URL loads straight (as before, just no intercom).
 */
object UiCache {
    private const val TAG = "ARUi"
    private val FILES = listOf("index.html", "app.js", "app.css", "kit.css", "hls.light.min.js", "version.json")

    /** The URL to load for [url]; blocks on the network, so call it off the UI thread. */
    fun resolve(c: Context, url: String): String {
        if (!url.startsWith("http://", ignoreCase = true)) return url
        val dir = File(c.filesDir, "ui")
        val tmp = File(c.filesDir, "ui-new")
        try {
            val base = URL(URL(url), "./")
            tmp.deleteRecursively()
            tmp.mkdirs()
            for (f in FILES) {
                val bytes = get(URL(base, f)) ?: if (f == "index.html" || f == "app.js") throw Exception("no $f") else continue
                val out = if (f == "index.html") String(bytes).replace(Regex("\\?v=[^\"']*"), "").toByteArray() else bytes
                File(tmp, f).writeBytes(out)
            }
            dir.deleteRecursively()
            if (!tmp.renameTo(dir)) throw Exception("can't save the copy")
            Log.i(TAG, "UI copied from $base")
        } catch (e: Exception) {
            Log.w(TAG, "couldn't copy the UI from $url: ${e.message}")
            tmp.deleteRecursively()
        }
        val index = File(dir, "index.html")
        return if (index.exists()) "file://" + index.absolutePath else url
    }

    private fun get(u: URL): ByteArray? {
        val con = u.openConnection() as HttpURLConnection
        return try {
            con.connectTimeout = 4000
            con.readTimeout = 15000
            con.useCaches = false
            if (con.responseCode != 200) null else con.inputStream.use { it.readBytes() }
        } finally {
            con.disconnect()
        }
    }
}
