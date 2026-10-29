package za.co.arsmarthome.nspanel

import android.app.Notification
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Browser
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File

/**
 * Legacy build: the panel UI runs in Chrome (installed separately — Chrome 95
 * is the last for Android 5) instead of the system WebView, which is too old
 * on panels like the HDL S10 touch (Android 5.1, Chrome 39). Bundled engines
 * (GeckoView) crashed natively on that board.
 *
 * Chrome loads the UI from [LocalBridge] (127.0.0.1), which also carries
 * `window.ARNative`, so the page and the HA integration are unchanged. This app
 * stays running behind Chrome ([KeepAlive]) for the backlight, sensors,
 * start-on-boot and updates.
 *
 * Full screen: the first time, Chrome opens as a normal tab. ⋮ → "Add to Home
 * screen" once; [ShortcutCatcher] keeps the shortcut Chrome makes, and from
 * then on the panel opens through it — full screen, no address bar.
 */
class ChromeEngine(private val activity: MainActivity, bridge: NativeBridge) : PanelEngine {
    private val tag = "ARChrome"
    private val main = Handler(Looper.getMainLooper())
    private val local = LocalBridge(activity.applicationContext, bridge).also { it.start() }
    private val wm = activity.applicationContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private var page: String? = null
    private var lastOpen = 0L
    private var resumes = 0
    private var dim: View? = null
    private val info = TextView(activity).apply {
        setTextColor(Color.WHITE)
        textSize = 16f
        gravity = Gravity.CENTER
    }

    /** Only shown when something needs a hand (no Chrome, Chrome won't open). */
    private val buttons = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }

    override val view: View = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setBackgroundColor(Color.BLACK)
        val d = activity.resources.displayMetrics.density
        setPadding((24 * d).toInt(), 0, (24 * d).toInt(), 0)
        addView(info)
        addView(buttons)
        buttons.addView(Button(activity).apply {
            text = "Open the panel"
            setOnClickListener { open(force = true) }
        })
        buttons.addView(Button(activity).apply {
            text = "Android settings"
            setOnClickListener {
                try {
                    activity.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) {
                }
            }
        })
    }

    override val kind = "chrome"
    override val version: String?
        get() = chromePackage()?.let { p ->
            try {
                "Chrome " + activity.packageManager.getPackageInfo(p, 0).versionName
            } catch (e: Exception) {
                null
            }
        }

    init {
        try {
            activity.startService(Intent(activity, KeepAlive::class.java))
        } catch (e: Exception) {
            Log.w(tag, "keep-alive service didn't start", e)
        }
    }

    /** BUNDLED_UI / UiCache's file:// copy -> the same files over the local bridge. */
    override fun load(url: String) {
        val uiDir = File(activity.filesDir, "ui").absolutePath
        page = if (url.startsWith("file://$uiDir/")) {
            local.pageUrl("/ui/" + url.removePrefix("file://$uiDir/"))
        } else {
            local.pageUrl("/app/index.html")
        }
        StartupGuard.stage(activity, "opening Chrome")
        open(force = true)
    }

    /** Show the panel: through Chrome's full-screen shortcut if we have it, else a Chrome tab. */
    fun open(force: Boolean = false) {
        val url = page ?: return
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastOpen < 4000) return
        lastOpen = now
        val chrome = chromePackage()
        if (chrome == null) {
            StartupGuard.ok(activity)
            buttons.visibility = View.VISIBLE
            info.text = "Chrome isn't installed.\n\nInstall Chrome 95 (arm-v7a, Android 5.0+) on this panel " +
                "from a USB stick, then open AR NSPanel Pro again."
            return
        }
        val shortcut = savedShortcut(activity)
        if (shortcut != null) {
            try {
                activity.startActivity(shortcut)
                StartupGuard.ok(activity)
                info.text = ""
                return
            } catch (e: Exception) {
                Log.w(tag, "saved shortcut failed; opening a tab", e)
                forgetShortcut(activity)
            }
        }
        try {
            activity.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .setPackage(chrome)
                    .putExtra(Browser.EXTRA_APPLICATION_ID, activity.packageName) // reuse the same tab
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            StartupGuard.ok(activity)
            info.text = "" // nothing in between: black, then the panel
            buttons.visibility = View.GONE
        } catch (e: Exception) {
            buttons.visibility = View.VISIBLE
            info.text = "Couldn't open Chrome: ${e.message}"
        }
    }

    private fun chromePackage(): String? = listOf("com.android.chrome", "com.chrome.beta", "com.chrome.dev", "org.chromium.chrome")
        .firstOrNull {
            try {
                activity.packageManager.getPackageInfo(it, 0)
                true
            } catch (e: Exception) {
                false
            }
        }

    /** Back on this screen (Home pressed, Chrome closed): put the panel up again. */
    override fun onResume() {
        resumes++
        if (resumes > 1) main.postDelayed({ open() }, 700)
    }

    override fun emit(type: String, json: String) = local.emit(type, json)

    override fun eval(js: String) = local.eval(js)

    /** The page is in Chrome: this app can't draw it. */
    override fun capture(done: (Bitmap?) -> Unit) = done(null)

    // --- backlight + keep-awake, system-wide (Chrome is in front, not us) ----------------

    override fun applyBrightness(level: Float): Boolean {
        main.post {
            try {
                val cr = activity.contentResolver
                Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
                Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS, if (level <= 0f) 1 else (level.coerceIn(0.01f, 1f) * 255).toInt().coerceAtLeast(1))
            } catch (e: Exception) {
                Log.w(tag, "brightness: ${e.message}")
            }
            // "off": a black layer over everything; touches go through it to the page, which wakes up
            if (level <= 0f) showDim() else hideDim()
        }
        return true
    }

    @Suppress("DEPRECATION")
    private val wake = (activity.applicationContext.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager)
        .newWakeLock(android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or android.os.PowerManager.ON_AFTER_RELEASE, "ar:panel")
        .apply { setReferenceCounted(false) }

    override fun keepScreenOn(on: Boolean): Boolean {
        try {
            if (on) wake.acquire() else if (wake.isHeld) wake.release()
        } catch (e: Exception) {
            Log.w(tag, "wake lock: ${e.message}")
        }
        return true
    }

    private fun showDim() {
        if (dim == null) dim = overlay(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, Color.BLACK, 0)
    }

    private fun hideDim() {
        dim?.let { remove(it) }
        dim = null
    }

    @Suppress("DEPRECATION")
    private fun overlay(w: Int, h: Int, color: Int, extra: Int): View? {
        val v = View(activity.applicationContext).apply { setBackgroundColor(color) }
        val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY
        val lp = WindowManager.LayoutParams(
            w, h, type,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_FULLSCREEN or extra,
            PixelFormat.TRANSLUCENT,
        )
        lp.gravity = Gravity.TOP or Gravity.START
        return try {
            wm.addView(v, lp)
            v
        } catch (e: Exception) {
            Log.w(tag, "overlay: ${e.message}")
            null
        }
    }

    private fun remove(v: View) {
        try {
            wm.removeView(v)
        } catch (e: Exception) {
        }
    }

    override fun destroy() {
        hideDim()
        keepScreenOn(false)
        local.stop()
    }

    companion object {
        private const val PREFS = "chrome"

        fun savedShortcut(c: Context): Intent? {
            val s = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("shortcut", null) ?: return null
            val i = try {
                Intent.parseUri(s, Intent.URI_INTENT_SCHEME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            } catch (e: Exception) {
                null
            }
            // a bookmark kept by an older version opens a tab: drop it, use the normal path
            if (i == null || !isWebApp(i)) {
                forgetShortcut(c)
                return null
            }
            return i
        }

        /** Chrome's web-app launch (full screen), not a bookmark. */
        fun isWebApp(i: Intent): Boolean {
            val a = i.action ?: ""
            if (a.contains("WEBAPP", ignoreCase = true)) return true
            val extras = i.extras ?: return false
            return extras.keySet().any { it.contains("webapp", ignoreCase = true) }
        }

        fun saveShortcut(c: Context, i: Intent) {
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("shortcut", i.toUri(Intent.URI_INTENT_SCHEME)).commit()
        }

        fun forgetShortcut(c: Context) {
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("shortcut").commit()
        }
    }
}

/**
 * Chrome's "Add to Home screen" for the panel page: keep the shortcut it
 * hands the launcher (Android 5–7 send it as a broadcast), and open the panel
 * through it right away — full screen from now on.
 */
class ShortcutCatcher : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        @Suppress("DEPRECATION")
        val target = intent.getParcelableExtra<Intent>(Intent.EXTRA_SHORTCUT_INTENT) ?: return
        val text = target.toUri(Intent.URI_INTENT_SCHEME)
        // the URL sits in the intent percent-encoded (127.0.0.1%3A18555): match the parts
        if (!text.contains("127.0.0.1") || !text.contains(LocalBridge.PORT.toString())) return // some other shortcut
        // "Install app" makes a web-app shortcut (opens full screen); "Add to Home
        // screen" on a non-installable page only a bookmark (opens a tab): skip that
        if (!ChromeEngine.isWebApp(target)) {
            Log.i("ARChrome", "Chrome made a plain bookmark, not a web app: ignored")
            return
        }
        ChromeEngine.saveShortcut(context, target)
        Log.i("ARChrome", "kept Chrome's full-screen shortcut for the panel")
        try {
            context.startActivity(Intent(target).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
        }
    }
}

/**
 * Keeps this app (the bridge, sensors, backlight) running while Chrome is in
 * front: a foreground service, so Android doesn't stop it to free memory.
 */
class KeepAlive : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        @Suppress("DEPRECATION")
        val n = Notification.Builder(this)
            .setContentTitle("AR NSPanel Pro")
            .setContentText("Panel running")
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setOngoing(true)
            .setPriority(Notification.PRIORITY_MIN)
            .build()
        try {
            startForeground(1, n)
        } catch (e: Exception) {
        }
        return START_STICKY
    }
}
