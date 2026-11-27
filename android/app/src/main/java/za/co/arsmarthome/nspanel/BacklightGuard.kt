package za.co.arsmarthome.nspanel

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.io.File

/**
 * Shelly Wall Display: keep the backlight where the panel set it.
 *
 * Shelly's software (and apps like it) writes the backlight file directly
 * (/sys/…/backlight/…/brightness), past Android. Android only writes that file
 * again when this app asks for a DIFFERENT brightness, so the screen stayed
 * dim: touching changed nothing, moving the brightness slider fixed it.
 *
 * Here: the backlight value is read just after the app sets the brightness
 * (the baseline), then every 1.5 s and on touch. When something else has
 * changed it, the app nudges its brightness (a few % and straight back), so
 * Android writes the file again. Each fix is logged ("ARBacklight … put back"),
 * which Home Assistant's Boot check shows under "screen / brightness".
 *
 * If no backlight file can be read, a touch still nudges the brightness (at
 * most every 3 s), so touching the screen brings it back.
 *
 * Shelly panels only. Every other panel is untouched.
 */
object BacklightGuard {
    private const val TAG = "ARBacklight"
    private const val EVERY_MS = 1500L

    private val CANDIDATES = listOf(
        "/sys/class/backlight/backlight/brightness",
        "/sys/devices/platform/backlight/backlight/backlight/brightness",
        "/sys/class/leds/lcd-backlight/brightness",
        "/sys/devices/platform/leds-mt65xx/leds/lcd-backlight/brightness",
        "/sys/devices/platform/sprd_backlight/backlight/sprd_backlight/brightness",
    )

    private val main = Handler(Looper.getMainLooper())
    private var act: MainActivity? = null
    private var node: File? = null
    private var nodeLooked = false
    private var level = -1f
    private var baseline = -1
    private var lastCheck = 0L
    private var lastNudge = 0L
    private var fixes = 0
    private var running = false

    fun active(a: MainActivity): Boolean = Shelly.isShelly(a)

    private fun findNode(): File? {
        if (nodeLooked) return node
        nodeLooked = true
        val list = ArrayList<File>()
        CANDIDATES.forEach { list.add(File(it)) }
        try {
            File("/sys/class/backlight").listFiles()?.forEach { list.add(File(it, "brightness")) }
        } catch (e: Exception) {
        }
        node = list.firstOrNull { f -> read(f) != null }
        Log.i(TAG, "backlight file: ${node?.path ?: "none readable (touch nudges instead)"}")
        return node
    }

    private fun read(f: File? = node): Int? = try {
        f?.readText()?.trim()?.toIntOrNull()
    } catch (e: Exception) {
        null
    }

    /** The app just set [l] (0..1, 0 = backlight off): learn the backlight value it gives. */
    fun applied(a: MainActivity, l: Float) {
        if (!active(a)) return
        act = a
        level = l
        baseline = -1
        main.removeCallbacks(settle)
        main.postDelayed(settle, 1200) // Android ramps the brightness: read it once it's there
    }

    private val settle = Runnable { baseline = read(findNode()) ?: -1 }

    fun start(a: MainActivity) {
        if (!active(a)) return
        act = a
        if (running) return
        running = true
        findNode()
        main.postDelayed(tick, EVERY_MS)
    }

    fun stop() {
        running = false
        main.removeCallbacks(tick)
    }

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            check(false)
            main.postDelayed(this, EVERY_MS)
        }
    }

    /** A touch: check now (at most every 0.8 s). */
    fun touched(a: MainActivity) {
        if (!active(a)) return
        act = a
        val now = SystemClock.uptimeMillis()
        if (now - lastCheck < 800) return
        check(true)
    }

    private fun check(byTouch: Boolean) {
        lastCheck = SystemClock.uptimeMillis()
        val a = act ?: return
        if (level <= 0f) return // the panel itself switched the backlight off
        val f = findNode()
        if (f == null) {
            // can't see the backlight: a touch puts the brightness back anyway
            if (byTouch && lastCheck - lastNudge > 3000) nudge(a, "touch")
            return
        }
        val v = read(f) ?: return
        if (baseline < 0) {
            baseline = v
            return
        }
        val off = kotlin.math.abs(v - baseline)
        if (off > maxOf(6, baseline / 7)) {
            fixes++
            Log.w(TAG, "backlight changed by something else: $v (was $baseline, the panel wants ${Math.round(level * 100)}%), put back (#$fixes)")
            nudge(a, "changed")
        }
    }

    /** Make Android write the backlight again: a few % away and straight back. */
    private fun nudge(a: MainActivity, why: String) {
        lastNudge = SystemClock.uptimeMillis()
        val l = level
        val away = if (l > 0.5f) l - 0.03f else l + 0.03f
        try {
            val lp = a.window.attributes
            lp.screenBrightness = away.coerceIn(0.01f, 1f)
            a.window.attributes = lp
            main.postDelayed({
                if (level == l) {
                    val lp2 = a.window.attributes
                    lp2.screenBrightness = l.coerceIn(0.01f, 1f)
                    a.window.attributes = lp2
                    // the baseline stays: it was learned when the panel set this level,
                    // re-learning now could adopt the other software's dim value
                }
            }, 120)
        } catch (e: Exception) {
            Log.w(TAG, "nudge ($why) failed", e)
        }
    }
}
