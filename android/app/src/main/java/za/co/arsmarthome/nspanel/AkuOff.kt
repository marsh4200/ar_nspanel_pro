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

    /**
     * The bottom RGB light. The Akubela app keeps it off when idle; with that
     * app switched off nothing sets it, and after every boot the light chip
     * flashes by default. This sends the Akubela app's own idle command:
     * ioctl(/dev/akmisc, 0x102f, RGB_MODE_DATA all zero) = mode 0, no colour.
     * Android has no tool for an ioctl, so it goes through the panel's
     * Python (installed for Akubela's built-in Home Assistant).
     */
    private const val PY = "/system/pythonenv"
    private const val LIGHT_OFF = "[ -c /dev/akmisc ] && [ -x $PY/bin/python3.9 ] && " +
        "LD_LIBRARY_PATH=$PY/lib PYTHONHOME=$PY $PY/bin/python3.9 -c " +
        "'import fcntl,os;fd=os.open(\"/dev/akmisc\",os.O_RDWR);fcntl.ioctl(fd,0x102F,bytes(36));os.close(fd)'"

    @Volatile
    private var started = false

    fun run(c: Context) {
        if (started) return
        if (!File("/system/xbin/su").exists()) return
        // the vendor app is switched off by then, so look for disabled ones too
        val info = try {
            c.packageManager.getApplicationInfo("com.akubela.panel", android.content.pm.PackageManager.MATCH_DISABLED_COMPONENTS)
        } catch (e: Exception) {
            null
        }
        val aku = android.os.Build.MODEL.contains("PHX1", true) || info != null
        if (!aku) return
        // only when the Akubela app is not running the light itself: taken
        // over by HA ("Use AR app" marker), or the Akubela app switched off
        val takenOver = File("/data/local/tmp/ar_aku_off").exists() || info == null || !info.enabled
        started = true
        Thread {
            for (wait in longArrayOf(0L, 15_000L, 45_000L)) {
                try {
                    Thread.sleep(wait)
                    val cmd = if (takenOver) "$CMD; $LIGHT_OFF" else CMD
                    val p = ProcessBuilder("/system/xbin/su", "0", "sh", "-c", cmd).redirectErrorStream(true).start()
                    p.inputStream.bufferedReader().readText()
                    p.waitFor()
                } catch (e: Exception) {
                    Log.w(TAG, "couldn't stop the Akubela services / light: ${e.message}")
                }
            }
        }.start()
    }
}
