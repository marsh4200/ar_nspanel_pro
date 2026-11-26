package za.co.arsmarthome.nspanel

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Shelly Wall Display: the relay on the back (one output, X2i) and the wall
 * switch wired to its SW terminal, for when Shelly's own app is switched off.
 *
 * Settings come from Home Assistant (device.shellyRelay, set in the panel's
 * Device settings > Built-in relay): {enabled, name, firstLight, room,
 * wall: "toggle"|"event"|"none", boot: "restore"|"off"|"on"}. They are kept
 * here too, so the relay is right after a power cut before Home Assistant is
 * back.
 *
 * Shelly doesn't document how its software switches the relay, so every known
 * way is tried, and the first that works is remembered ("method", reported to
 * Home Assistant in sys/relay):
 *   sysfs           this app writes /sys/class/strelay/relay1 (newer models)
 *   sysfs-leds      this app writes /sys/devices/platform/leds/red_enable (first models)
 *   adb-sysfs       the same, as the shell user through the panel's own ADB (LocalAdb)
 *   adb-sysfs-leds
 *   adb-prop        setprop shelly.relay.0.state / shelly.relay.1.state
 * If none works, sys/relay says so (ok:false, error) and Boot check shows it.
 *
 * Wall switch: `getevent -l` through the panel's own ADB. A key press
 * (EV_KEY … DOWN) or a switch flip (EV_SW) toggles the relay ("toggle"), and
 * is sent to Home Assistant as the "Wall switch" event either way unless
 * "none". The key's name rides along, so an unexpected one can be spotted.
 */
object ShellyRelay {
    private const val TAG = "ARRelay"
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "ar-relay").apply { isDaemon = true } }

    private const val SYS_V2 = "/sys/class/strelay/relay1"
    private const val SYS_V1 = "/sys/devices/platform/leds/red_enable"
    private val METHODS = listOf("sysfs", "sysfs-leds", "adb-sysfs", "adb-sysfs-leds", "adb-prop")

    /** Keys that are never the wall switch (power, volume, proximity, touch). */
    private val NOT_WALL = setOf(
        "KEY_POWER", "KEY_WAKEUP", "KEY_SLEEP", "KEY_VOLUMEUP", "KEY_VOLUMEDOWN", "KEY_MUTE",
        "KEY_F5", "KEY_F6", "BTN_TOUCH", "BTN_TOOL_FINGER", "KEY_BACK", "KEY_HOME", "KEY_MENU",
    )

    @Volatile private var on: Boolean? = null
    @Volatile private var method: String? = null
    @Volatile private var error: String? = null
    @Volatile private var lastInput: String? = null
    @Volatile private var watching = false
    @Volatile private var wallMode = "toggle"
    @Volatile private var started = false
    private var lastToggleAt = 0L
    private var app: Context? = null

    private fun prefs(c: Context) = c.applicationContext.getSharedPreferences("shellyRelay", Context.MODE_PRIVATE)

    private fun cfg(c: Context): JSONObject = try {
        JSONObject(prefs(c).getString("cfg", null) ?: "{}")
    } catch (e: Exception) {
        JSONObject()
    }

    fun enabled(c: Context): Boolean = Shelly.isShelly(c) && cfg(c).optBoolean("enabled", false)

    /** Settings from Home Assistant (JSON or "null"). Returns the state for sys/relay. */
    fun configure(c: Context, json: String?): String {
        val a = c.applicationContext
        app = a
        val o = try {
            if (json.isNullOrBlank() || json == "null") JSONObject() else JSONObject(json)
        } catch (e: Exception) {
            JSONObject()
        }
        val was = enabled(a)
        prefs(a).edit().putString("cfg", o.toString()).apply()
        wallMode = o.optString("wall", "toggle")
        if (enabled(a)) {
            if (!was) {
                started = false
                start(a)
            } else {
                ensureWatch(a)
            }
        } else {
            watching = false
        }
        return state(a)
    }

    /** At app start: settings kept from last time, the relay after a power cut. */
    fun start(c: Context) {
        val a = c.applicationContext
        app = a
        if (!enabled(a)) return
        if (started) {
            ensureWatch(a) // every resume: only make sure the wall switch is watched
            return
        }
        started = true // once per app start (= after a power cut / reboot)
        val cfg = cfg(a)
        wallMode = cfg.optString("wall", "toggle")
        method = prefs(a).getString("method", null)
        io.execute {
            val want = when (cfg.optString("boot", "restore")) {
                "on" -> true
                "off" -> false
                else -> if (prefs(a).contains("last")) prefs(a).getBoolean("last", false) else null
            }
            if (want != null) apply(a, want) else readNow(a)
            report(a)
        }
        ensureWatch(a)
    }

    /** {on:true|false} or {toggle:true} from Home Assistant (cmd/relay). */
    fun command(c: Context, json: String?) {
        val a = c.applicationContext
        app = a
        if (!enabled(a)) {
            error = "The built-in relay is off in the panel's Device settings."
            report(a)
            return
        }
        val o = try {
            JSONObject(json ?: "{}")
        } catch (e: Exception) {
            JSONObject()
        }
        io.execute {
            val want = when {
                o.optBoolean("toggle", false) -> !(on ?: readNow(a) ?: false)
                o.has("on") -> o.optBoolean("on")
                else -> null
            }
            if (want != null) apply(a, want) else readNow(a)
            report(a)
        }
    }

    fun state(c: Context): String = JSONObject().apply {
        put("enabled", enabled(c))
        put("on", on ?: JSONObject.NULL)
        put("ok", error == null && on != null)
        put("method", method ?: JSONObject.NULL)
        put("error", error ?: JSONObject.NULL)
        put("wall", wallMode)
        put("watching", watching)
        put("lastInput", lastInput ?: JSONObject.NULL)
        put("ts", System.currentTimeMillis())
    }.toString()

    private fun report(c: Context) {
        val s = state(c)
        MainActivity.current?.let { act -> act.runOnUiThread { act.emit("relay", s) } }
    }

    // --- switching --------------------------------------------------------------------

    /** Switch the relay, trying the remembered way first, then every other. */
    private fun apply(c: Context, want: Boolean) {
        val v = if (want) "1" else "0"
        val order = (listOfNotNull(method) + METHODS).distinct()
        val errors = ArrayList<String>()
        for (m in order) {
            val got = try {
                set(c, m, v)
            } catch (e: Exception) {
                errors.add("$m: ${e.javaClass.simpleName}")
                null
            }
            if (got == want) {
                if (method != m) {
                    method = m
                    prefs(c).edit().putString("method", m).apply()
                    Log.i(TAG, "relay works with: $m")
                }
                on = want
                error = null
                prefs(c).edit().putBoolean("last", want).apply()
                return
            }
            if (got != null) errors.add("$m: read back ${if (got) "on" else "off"}")
        }
        error = "Couldn't switch the relay (" + errors.joinToString("; ").ifEmpty { "no way worked" } + ")"
        Log.w(TAG, error ?: "")
    }

    /** One way: write [v], read it back (null: this way can't reach the relay). */
    private fun set(c: Context, m: String, v: String): Boolean? = when (m) {
        "sysfs" -> writeFile(SYS_V2, v)
        // the first models' path only where the newer one doesn't exist: on newer
        // models it may be a plain LED, which must not pass for the relay
        "sysfs-leds" -> if (File(SYS_V2).exists()) null else writeFile(SYS_V1, v)
        "adb-sysfs" -> adbBool(c, "[ -e $SYS_V2 ] && echo $v > $SYS_V2 2>/dev/null; cat $SYS_V2 2>/dev/null")
        "adb-sysfs-leds" -> adbBool(c, "[ ! -e $SYS_V2 ] && [ -e $SYS_V1 ] && echo $v > $SYS_V1 2>/dev/null; [ ! -e $SYS_V2 ] && cat $SYS_V1 2>/dev/null")
        "adb-prop" -> adbBool(
            c,
            "setprop shelly.relay.0.state $v 2>/dev/null; setprop shelly.relay.1.state $v 2>/dev/null; " +
                "a=$(getprop shelly.relay.0.state); [ -n \"\$a\" ] && echo \$a || getprop shelly.relay.1.state",
        )
        else -> null
    }

    /** Read the relay the remembered way (or any that can read it). */
    private fun readNow(c: Context): Boolean? {
        val order = (listOfNotNull(method) + METHODS).distinct()
        for (m in order) {
            val r = try {
                when (m) {
                    "sysfs" -> readFile(SYS_V2)
                    "sysfs-leds" -> if (File(SYS_V2).exists()) null else readFile(SYS_V1)
                    "adb-sysfs" -> adbBool(c, "cat $SYS_V2 2>/dev/null")
                    "adb-sysfs-leds" -> adbBool(c, "[ ! -e $SYS_V2 ] && cat $SYS_V1 2>/dev/null")
                    "adb-prop" -> adbBool(c, "a=$(getprop shelly.relay.0.state); [ -n \"\$a\" ] && echo \$a || getprop shelly.relay.1.state")
                    else -> null
                }
            } catch (e: Exception) {
                null
            }
            if (r != null) {
                on = r
                return r
            }
        }
        return null
    }

    private fun writeFile(path: String, v: String): Boolean? {
        val f = File(path)
        if (!f.exists()) return null
        return try {
            f.writeText(v)
            readFile(path)
        } catch (e: Exception) {
            null // no permission for this app: the ADB ways may still work
        }
    }

    private fun readFile(path: String): Boolean? = try {
        parseBool(File(path).readText())
    } catch (e: Exception) {
        null
    }

    private fun adbBool(c: Context, cmd: String): Boolean? {
        val r = LocalAdb.shell(c.filesDir, cmd, listOf(5555), authWaitMs = 30_000, readMs = 8000)
        return if (r.ok) parseBool(r.output) else null
    }

    /** "1" / "0" / "on" / "off" / "true" / "false" (first word). */
    fun parseBool(s: String?): Boolean? {
        val w = (s ?: "").trim().lowercase().split(Regex("\\s+")).firstOrNull() ?: return null
        return when (w) {
            "1", "on", "true", "255" -> true
            "0", "off", "false" -> false
            else -> w.toIntOrNull()?.let { it > 0 }
        }
    }

    // --- the wall switch --------------------------------------------------------------

    private fun ensureWatch(c: Context) {
        val a = c.applicationContext
        if (watching || !enabled(a) || wallMode == "none") return
        watching = true
        Thread({
            var wait = 3000L
            while (watching && enabled(a) && wallMode != "none") {
                val why = LocalAdb.stream(
                    a.filesDir,
                    "getevent -l 2>/dev/null | grep --line-buffered -E 'EV_KEY|EV_SW' 2>/dev/null || getevent -l",
                    listOf(5555),
                    keepGoing = { watching && enabled(a) && wallMode != "none" },
                ) { line -> onInput(a, line) }
                Log.i(TAG, "wall switch watch ended: $why")
                if (!watching) break
                Thread.sleep(wait)
                wait = minOf(wait * 2, 60_000L)
            }
            watching = false
        }, "ar-wallswitch").apply { isDaemon = true }.start()
    }

    /** One `getevent -l` line, e.g. "/dev/input/event3: EV_KEY  KEY_F1  DOWN". */
    fun parseInput(line: String): Pair<String, String>? {
        val parts = line.substringAfter(": ", line).trim().split(Regex("\\s+"))
        if (parts.size < 3) return null
        val (type, code, value) = Triple(parts[0], parts[1], parts[2])
        return when (type) {
            "EV_KEY" -> if (code in NOT_WALL || value != "DOWN") null else "press" to code
            "EV_SW" -> when (value.trimStart('0').ifEmpty { "0" }) {
                "1" -> "on" to code
                "0" -> "off" to code
                else -> null
            }
            else -> null
        }
    }

    private fun onInput(c: Context, line: String) {
        val (action, code) = parseInput(line) ?: return
        val now = System.currentTimeMillis()
        if (now - lastToggleAt < 300) return // contact bounce
        lastToggleAt = now
        lastInput = code
        if (wallMode == "toggle") {
            io.execute {
                apply(c, !(on ?: readNow(c) ?: false))
                report(c)
            }
        } else {
            report(c)
        }
        val ev = JSONObject().put("action", action).put("value", code).toString()
        MainActivity.current?.let { act -> act.runOnUiThread { act.emit("wallswitch", ev) } }
    }
}
