package za.co.arsmarthome.nspanel

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Process
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

/**
 * Start-up crash report, for panels where nobody can read logcat (no ADB).
 *
 * Every start records how far it got ([stage]); the page loading and making
 * its first call into the app marks the start as good ([ok]). If the app dies
 * before that — a Java exception, or the browser engine crashing natively and
 * taking the process with it — the NEXT start shows what happened on screen
 * (stage, exception, the app's own recent log) instead of crashing again, with
 * a "Try again" button. A photo of that screen is enough to fix it.
 */
object StartupGuard {
    private const val PREFS = "startup"
    @Volatile
    private var good = false

    private fun prefs(c: Context) = c.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun crashFile(c: Context) = File(c.applicationContext.filesDir, "last-crash.txt")
    fun reportFile(c: Context) = File(c.applicationContext.filesDir, "startup-report.txt")

    /** Install the Java crash catcher (once per process). */
    fun install(c: Context) {
        val app = c.applicationContext
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        if (prev is Catcher) return
        Thread.setDefaultUncaughtExceptionHandler(Catcher(app, prev))
    }

    private class Catcher(val app: Context, val prev: Thread.UncaughtExceptionHandler?) : Thread.UncaughtExceptionHandler {
        override fun uncaughtException(t: Thread, e: Throwable) {
            try {
                val sw = StringWriter()
                e.printStackTrace(PrintWriter(sw))
                crashFile(app).writeText("Thread ${t.name}\n$sw")
            } catch (x: Throwable) {
            }
            prev?.uncaughtException(t, e)
        }
    }

    /** The previous start never finished: the report text, else null. */
    fun previousFailure(c: Context): String? {
        val p = prefs(c)
        val stage = p.getString("stage", null) ?: return null
        if (stage == "ok") return null
        val sb = StringBuilder()
        sb.append("Stopped at: ").append(stage).append('\n')
        sb.append("App ").append(appVersion(c)).append(" (").append(Engines.BUILD).append(")  ·  Android ")
            .append(Build.VERSION.RELEASE).append(" (SDK ").append(Build.VERSION.SDK_INT).append(")  ·  ")
            .append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append("  ·  ")
            .append(Build.SUPPORTED_ABIS.joinToString(",")).append('\n')
        val crash = crashFile(c)
        if (crash.exists()) {
            sb.append("\n== Java crash ==\n").append(crash.readText().take(6000)).append('\n')
        } else {
            sb.append("\n(no Java exception: the process died natively — most likely inside the browser engine)\n")
        }
        sb.append("\n== Log (this app) ==\n").append(ownLog())
        val text = sb.toString()
        try {
            reportFile(c).writeText(text)
        } catch (e: Exception) {
        }
        return text
    }

    /** Starting over: forget the last failure. */
    fun clear(c: Context) {
        prefs(c).edit().remove("stage").commit()
        crashFile(c).delete()
    }

    /** Record progress; commit() so it survives a native crash right after. */
    fun stage(c: Context, name: String) {
        if (good) return
        prefs(c).edit().putString("stage", name).commit()
    }

    /** The UI is up and talking to the app: this start worked. */
    fun ok(c: Context) {
        if (good) return
        good = true
        prefs(c).edit().putString("stage", "ok").commit()
        crashFile(c).delete()
    }

    /** Recent log lines of this app (Android lets an app read its own). */
    private fun ownLog(): String = try {
        val p = Runtime.getRuntime().exec(arrayOf("logcat", "-d", "-v", "time", "-t", "400"))
        val all = p.inputStream.bufferedReader().readLines()
        p.destroy()
        // "-v time" lines: "10-28 16:20:01.123 E/Tag( 1234): message"
        val mine = Regex("\\(\\s*${Process.myPid()}\\):")
        // the previous (dead) process's lines matter, not this one's
        val lines = all.filter { !mine.containsMatchIn(it) }
        val level = Regex("^\\S+ \\S+ [EFW]/")
        val interesting = lines.filter {
            level.containsMatchIn(it) || it.contains("Gecko", true) || it.contains("/AR") ||
                it.contains("FATAL") || it.contains("signal", true) || it.contains("Exception")
        }
        (if (interesting.size > 20) interesting else lines).takeLast(120).joinToString("\n")
    } catch (e: Exception) {
        "(couldn't read the log: ${e.message})"
    }

    private fun appVersion(c: Context): String = try {
        c.packageManager.getPackageInfo(c.packageName, 0).versionName ?: "?"
    } catch (e: Exception) {
        "?"
    }

    /** Full-screen report with a Try again button (plain Android views, no browser). */
    fun show(a: Activity, report: String) {
        val d = a.resources.displayMetrics.density
        val pad = (12 * d).toInt()
        val col = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            setPadding(pad, pad, pad, pad)
        }
        col.addView(TextView(a).apply {
            text = "AR NSPanel Pro couldn't start last time"
            setTextColor(Color.WHITE)
            textSize = 18f
            setTypeface(typeface, Typeface.BOLD)
        })
        col.addView(TextView(a).apply {
            text = "Take a photo of this screen and send it to AR Smart Home, then tap Try again."
            setTextColor(Color.parseColor("#f2b866"))
            textSize = 13f
            setPadding(0, pad / 2, 0, pad / 2)
        })
        val scroll = ScrollView(a)
        scroll.addView(TextView(a).apply {
            text = report
            setTextColor(Color.parseColor("#d0d0d0"))
            textSize = 9f
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
        })
        col.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        col.addView(Button(a).apply {
            text = "Try again"
            setOnClickListener {
                clear(a)
                a.recreate()
            }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = pad / 2
            gravity = Gravity.CENTER_HORIZONTAL
        })
        a.setContentView(col)
    }
}
