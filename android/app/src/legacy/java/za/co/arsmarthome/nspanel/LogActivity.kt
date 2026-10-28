package za.co.arsmarthome.nspanel

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * "AR Panel Log" (legacy build only): a second launcher icon that shows this
 * app's own log, for panels with no ADB. Runs in its own process (":diag")
 * and uses plain Android views only — no browser engine, no app start-up code —
 * so it opens even when the panel app crashes at start. Open the panel app,
 * let it crash, open this, photograph the screen.
 */
class LogActivity : Activity() {
    private lateinit var text: TextView
    private lateinit var scroll: ScrollView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val d = resources.displayMetrics.density
        val pad = (10 * d).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            setPadding(pad, pad, pad, pad)
        }
        col.addView(TextView(this).apply {
            text = "AR Panel Log — open the panel app, let it close, come back, tap Refresh, photograph this"
            setTextColor(Color.parseColor("#f2b866"))
            textSize = 12f
        })
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(Button(this).apply {
            text = "Refresh"
            setOnClickListener { load() }
        })
        row.addView(Button(this).apply {
            text = "Start panel app"
            setOnClickListener {
                startActivity(Intent(this@LogActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        })
        row.addView(Button(this).apply {
            text = "Errors only"
            setOnClickListener { load(errorsOnly = true) }
        })
        col.addView(row)
        scroll = ScrollView(this)
        text = TextView(this).apply {
            setTextColor(Color.parseColor("#d8d8d8"))
            textSize = 8.5f
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
        }
        scroll.addView(text)
        col.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(col)
        load()
    }

    private fun load(errorsOnly: Boolean = false) {
        val head = StringBuilder()
        head.append("Android ").append(Build.VERSION.RELEASE).append(" SDK ").append(Build.VERSION.SDK_INT)
            .append(" · ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
            .append(" · ABIs ").append(Build.SUPPORTED_ABIS.joinToString(","))
            .append(" · 64-bit ABIs ").append(Build.SUPPORTED_64_BIT_ABIS.joinToString(",").ifEmpty { "none" })
            .append(" · process arch ").append(System.getProperty("os.arch") ?: "?")
            .append('\n')
        try {
            val p = packageManager.getPackageInfo(packageName, 0)
            head.append("App ").append(p.versionName).append(" (legacy)\n")
        } catch (e: Exception) {
        }
        try {
            val prefs = getSharedPreferences("startup", MODE_PRIVATE)
            head.append("Last start stopped at: ").append(prefs.getString("stage", "(never recorded)")).append('\n')
        } catch (e: Exception) {
        }
        val crash = java.io.File(filesDir, "last-crash.txt")
        if (crash.exists()) head.append("\n== Java crash ==\n").append(crash.readText().take(5000)).append('\n')
        head.append("\n== Log ==\n")
        val log = try {
            val p = Runtime.getRuntime().exec(arrayOf("logcat", "-d", "-v", "time", "-t", "1500"))
            val lines = p.inputStream.bufferedReader().readLines()
            p.destroy()
            val keep = if (errorsOnly) {
                val level = Regex("^\\S+ \\S+ [EF]/")
                lines.filter { level.containsMatchIn(it) || it.contains("FATAL") || it.contains("signal", true) || it.contains("Exception") }
            } else {
                lines
            }
            keep.takeLast(400).joinToString("\n")
        } catch (e: Exception) {
            "(couldn't read the log: $e)"
        }
        text.text = head.toString() + log
        scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }
}
