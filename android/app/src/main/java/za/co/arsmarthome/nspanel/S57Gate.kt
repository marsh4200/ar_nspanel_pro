package za.co.arsmarthome.nspanel

import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.util.Log
import java.io.File

/**
 * HDL S57 only: don't start the browser engine while the panel is still
 * installing.
 *
 * At boot (above all the first one after a reset, a WebView update or an APK
 * install) the S57 runs its own install scripts (bootclone / precopy /
 * boot_app / data_resume / rm_app, from its init files) and Android 6 is still
 * optimising apps (dex2oat), WebView 106 among them. Creating the WebView in
 * the middle of that blocked the app's main thread: a frozen screen, and with
 * WallApp and Launcher3 off nothing else to show.
 *
 * So the app first shows a plain "Starting…" screen and waits until Android
 * says it has booted, none of those scripts / installs / optimisers is running,
 * and that has stayed so for a quiet spell (longer the first time this app
 * version starts). It goes ahead anyway after [MAX_WAIT_MS].
 *
 * Every other panel: [needed] is false and nothing changes.
 */
object S57Gate {
    private const val TAG = "ARS57Gate"
    private const val WALLAPP = "com.example.wallapp"
    private const val PREFS = "s57gate"

    /** Quiet spell needed on a normal boot / on the first start of this app version. */
    private const val QUIET_MS = 20_000L
    private const val QUIET_FIRST_MS = 90_000L
    /** Android up at least this long before the panel UI starts. */
    private const val MIN_UPTIME_MS = 45_000L
    /** Never wait longer than this. */
    private const val MAX_WAIT_MS = 10 * 60_000L
    private const val POLL_MS = 2_000L

    /** What still running means "the panel is busy installing". */
    private val BUSY = listOf(
        "bootclone.sh", "precopy.sh", "boot_app.sh", "data_resume.sh", "rm_app.sh",
        "dex2oat", "com.android.commands.pm", "/system/bin/pm ", "WebViewLoader",
    )

    @Volatile
    private var passed = false

    /** An HDL S57 (Android 6 with HDL's WallApp on it, switched on or off). */
    fun isS57(c: Context): Boolean {
        if (Build.VERSION.SDK_INT != 23) return false
        return try {
            @Suppress("DEPRECATION")
            c.packageManager.getApplicationInfo(WALLAPP, android.content.pm.PackageManager.GET_UNINSTALLED_PACKAGES)
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Wait before starting the panel UI? (Once per app process.) */
    fun needed(c: Context): Boolean = !passed && isS57(c)

    private fun versionCode(c: Context): Int = try {
        @Suppress("DEPRECATION")
        c.packageManager.getPackageInfo(c.packageName, 0).versionCode
    } catch (e: Exception) {
        0
    }

    /**
     * Blocking (run it off the main thread): returns when the panel is quiet.
     * [status] gets a short line for the screen every poll.
     */
    fun waitQuiet(c: Context, status: (String) -> Unit) {
        val app = c.applicationContext
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val ver = versionCode(app)
        val first = prefs.getInt("okVersion", -1) != ver
        val quietNeeded = if (first) QUIET_FIRST_MS else QUIET_MS
        val start = SystemClock.elapsedRealtime()
        var quietSince = -1L
        while (true) {
            val now = SystemClock.elapsedRealtime()
            val busy = busyReason()
            if (busy == null) {
                if (quietSince < 0) quietSince = now
            } else {
                quietSince = -1L
            }
            val quietFor = if (quietSince < 0) 0L else now - quietSince
            if (busy == null && quietFor >= quietNeeded && now >= MIN_UPTIME_MS) break
            if (now - start >= MAX_WAIT_MS) {
                Log.w(TAG, "still busy after ${MAX_WAIT_MS / 1000} s ($busy): starting anyway")
                break
            }
            val left = ((quietNeeded - quietFor).coerceAtLeast(MIN_UPTIME_MS - now).coerceAtLeast(0) + 999) / 1000
            status(
                if (busy != null) "The panel is still installing ($busy)…"
                else "Almost ready… ${left} s",
            )
            try {
                Thread.sleep(POLL_MS)
            } catch (e: InterruptedException) {
                return
            }
        }
        Log.i(TAG, "panel quiet after ${(SystemClock.elapsedRealtime() - start) / 1000} s (first=$first)")
        prefs.edit().putInt("okVersion", ver).commit()
        passed = true
    }

    /** Why the panel is busy right now, or null when it is quiet. */
    private fun busyReason(): String? {
        if (prop("sys.boot_completed") != "1") return "Android is starting"
        try {
            val procs = File("/proc").listFiles() ?: return null
            for (p in procs) {
                if (!p.name.all { it.isDigit() }) continue
                val cmd = try {
                    File(p, "cmdline").readText().replace('\u0000', ' ')
                } catch (e: Exception) {
                    continue
                }
                if (cmd.isBlank()) continue
                for (b in BUSY) if (cmd.contains(b)) return b.trim().removeSuffix(".sh").substringAfterLast('/').substringAfterLast('.')
            }
        } catch (e: Exception) {
            Log.w(TAG, "can't look at the running processes: ${e.message}")
        }
        return null
    }

    private fun prop(name: String): String = try {
        val p = ProcessBuilder("/system/bin/getprop", name).redirectErrorStream(true).start()
        val v = p.inputStream.bufferedReader().readText().trim()
        p.waitFor()
        v
    } catch (e: Exception) {
        ""
    }
}
