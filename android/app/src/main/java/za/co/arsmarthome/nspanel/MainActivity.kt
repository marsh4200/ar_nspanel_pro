package za.co.arsmarthome.nspanel

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout

/**
 * Full-screen kiosk hosting the panel UI in a WebView.
 *
 * The UI is the web app the integration ships (www/app). It boots from the copy
 * bundled in this APK (works with HA down), or from Home Assistant when a UI URL
 * is set in the panel's setup screen — then a UI update needs no APK update.
 * Everything hardware-related (backlight, sensors, screenshots, licence) is
 * exposed to it through [NativeBridge] as `window.ARNative`.
 */
class MainActivity : Activity(), SensorEventListener {

    lateinit var webView: WebView
        private set
    private lateinit var blackout: View
    private lateinit var bridge: NativeBridge
    private val main = Handler(Looper.getMainLooper())
    private var sensors: SensorManager? = null
    private var lastLightAt = 0L
    private var lastLux = -1f
    private var loadedFallback = false

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_FULLSCREEN or
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
        )

        WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect over ADB
        webView = WebView(this)
        webView.setBackgroundColor(Color.BLACK)
        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.allowFileAccess = true
        s.loadWithOverviewMode = true
        s.useWideViewPort = false
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.textZoom = 100

        bridge = NativeBridge(this)
        webView.addJavascriptInterface(bridge, "ARNative")
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                android.util.Log.i("ARPanel", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                // The HA-served UI is unreachable: boot the bundled copy instead.
                if (request.isForMainFrame && !loadedFallback) {
                    loadedFallback = true
                    main.post { view.loadUrl(BUNDLED_UI) }
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = false
        }

        blackout = View(this)
        blackout.setBackgroundColor(Color.BLACK)
        blackout.visibility = View.GONE
        blackout.isClickable = false // touches fall through to the WebView (that is how it wakes)

        val root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)
        root.addView(webView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        root.addView(blackout, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)
        immersive()
        loadUi()

        sensors = getSystemService(Context.SENSOR_SERVICE) as SensorManager?
    }

    fun loadUi() {
        loadedFallback = false
        val url = bridge.uiUrl()
        webView.loadUrl(if (url.isNullOrBlank()) BUNDLED_UI else url)
    }

    override fun onResume() {
        super.onResume()
        immersive()
        webView.onResume()
        sensors?.let { sm ->
            sm.getDefaultSensor(Sensor.TYPE_LIGHT)?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) }
            sm.getDefaultSensor(Sensor.TYPE_PROXIMITY)?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) }
        }
    }

    override fun onPause() {
        // A wall panel has nothing else to show; keep the sensors running even
        // if something briefly covers the activity (a system dialog).
        super.onPause()
    }

    override fun onDestroy() {
        sensors?.unregisterListener(this)
        webView.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // Kiosk: back does nothing.
    }

    @Suppress("DEPRECATION")
    private fun immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                )
        }
    }

    // --- called by the bridge (on the UI thread) ------------------------------

    /** 0..1; 0 = backlight off (plus a black view so nothing leaks through). */
    fun applyBrightness(level: Float) {
        val lp = window.attributes
        lp.screenBrightness = if (level <= 0f) 0.0f else level.coerceIn(0.01f, 1f)
        window.attributes = lp
        blackout.visibility = if (level <= 0f) View.VISIBLE else View.GONE
    }

    fun keepOn(on: Boolean) {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    fun hasSensor(type: Int): Boolean = sensors?.getDefaultSensor(type) != null

    /** Deliver an event to the page: window.__arNative.emit(type, json). */
    fun emit(type: String, json: String) {
        main.post {
            webView.evaluateJavascript(
                "window.__arNative&&window.__arNative.emit(${MiniJson.quote(type)},${MiniJson.quote(json)})",
                null,
            )
        }
    }

    fun eval(js: String) {
        main.post { webView.evaluateJavascript(js, null) }
    }

    // --- sensors ------------------------------------------------------------------

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_LIGHT -> {
                val lux = event.values[0]
                val now = System.currentTimeMillis()
                // throttle: the UI only needs trends (auto-brightness + a sensor)
                if (now - lastLightAt < 1000 && Math.abs(lux - lastLux) < 5) return
                lastLightAt = now
                lastLux = lux
                emit("light", "{\"lux\":$lux}")
            }
            Sensor.TYPE_PROXIMITY -> {
                emit("proximity", "{\"value\":${event.values[0]},\"max\":${event.sensor.maximumRange}}")
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {}

    companion object {
        const val BUNDLED_UI = "file:///android_asset/app/index.html"
    }
}
