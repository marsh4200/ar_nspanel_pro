package za.co.arsmarthome.nspanel

import android.util.Log
import java.io.File

/**
 * "Optimise panel" (HA's ADB tool) leaves the marker /data/local/tmp/ar_optimised.
 * Most of what it does stays done (apps switched off), but services the panel's
 * own boot files start - Rockchip's AI-chip server (rknn_server, used only by the
 * Akubela face recognition) - come back at every boot. Stop them again as root
 * each time the app starts, and once more a minute later for late starters.
 * No root or no marker: nothing happens.
 */
object BootTweaks {
    private const val TAG = "ARBoot"
    private const val CMD = "[ -f /data/local/tmp/ar_optimised ] || exit 0; " +
        "[ \"\$(getprop init.svc.rknn_server)\" = running ] && setprop ctl.stop rknn_server; true"

    @Volatile
    private var started = false

    fun run() {
        if (started) return
        if (!File("/system/xbin/su").exists()) return
        started = true
        Thread {
            for (wait in longArrayOf(0L, 15_000L, 45_000L)) {
                try {
                    Thread.sleep(wait)
                    val p = ProcessBuilder("/system/xbin/su", "0", "sh", "-c", CMD).redirectErrorStream(true).start()
                    p.inputStream.bufferedReader().readText()
                    p.waitFor()
                } catch (e: Exception) {
                    Log.w(TAG, "boot tweaks: ${e.message}")
                }
            }
        }.start()
    }
}
