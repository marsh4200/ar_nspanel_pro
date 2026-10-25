package za.co.arsmarthome.nspanel

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Akubela with "Use AR app": its own background services are started by
 * Android's init at every boot. HA's takeover leaves a stop script on the
 * panel; run it as root each time the app starts (and once more a minute
 * later, for services that start late). No marker: nothing happens.
 */
object AkuOff {
    private const val TAG = "ARAku"
    private const val CMD = "[ -f /data/local/tmp/ar_aku_off ] && sh /data/local/tmp/aku-stop.sh"
    @Volatile
    private var started = false

    fun run(c: Context) {
        if (started) return
        if (!File("/system/xbin/su").exists()) return
        // the vendor app is switched off by then, so look for disabled ones too
        val aku = android.os.Build.MODEL.contains("PHX1", true) || try {
            c.packageManager.getApplicationInfo("com.akubela.panel", android.content.pm.PackageManager.MATCH_DISABLED_COMPONENTS)
            true
        } catch (e: Exception) {
            false
        }
        if (!aku) return
        started = true
        Thread {
            for (wait in longArrayOf(0L, 60_000L)) {
                try {
                    Thread.sleep(wait)
                    val p = ProcessBuilder("/system/xbin/su", "0", "sh", "-c", CMD).redirectErrorStream(true).start()
                    p.inputStream.bufferedReader().readText()
                    p.waitFor()
                } catch (e: Exception) {
                    Log.w(TAG, "couldn't stop the Akubela services: ${e.message}")
                }
            }
        }.start()
    }
}
