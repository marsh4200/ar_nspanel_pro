package za.co.arsmarthome.nspanel

// The panel UI in Android's own WebView. Used by the standard build (Android 7+),
// and by the legacy build on a panel whose WebView is new enough (the HDL S57
// after its WebView 106 update) instead of Chrome. Moved here unchanged from
// src/standard/.../Engines.kt so both builds share it.

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

@androidx.media3.common.util.UnstableApi
@SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
@android.annotation.TargetApi(23) // standard build: Android 7+; legacy build: only on Android 6+ (Engines.kt)
internal class WebViewEngine(private val activity: MainActivity, bridge: NativeBridge) : PanelEngine {
    private val main = Handler(Looper.getMainLooper())
    private val web = WebView(activity)
    private var loadedFallback = false
    private var pendingMic: android.webkit.PermissionRequest? = null

    override val view: View get() = web
    override val kind = "webview"
    override val version: String?
        get() = if (Build.VERSION.SDK_INT >= 26) WebView.getCurrentWebViewPackage()?.versionName else systemWebViewVersion(activity)

    init {
        WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect over ADB
        web.setBackgroundColor(Color.BLACK)
        val s = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.allowFileAccess = true
        s.loadWithOverviewMode = true
        s.useWideViewPort = false
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.textZoom = 100
        web.addJavascriptInterface(bridge, "ARNative")

        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                android.util.Log.i("ARPanel", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }

            // Intercom: the page asks for the microphone (getUserMedia)
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                main.post {
                    if (!request.resources.contains(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                        request.deny()
                        return@post
                    }
                    val mic = arrayOf(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                    if (activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        request.grant(mic)
                    } else {
                        pendingMic?.deny()
                        pendingMic = request
                        activity.requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), REQ_MIC)
                    }
                }
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                // The HA-served UI is unreachable: boot the bundled copy instead.
                if (request.isForMainFrame && !loadedFallback) {
                    loadedFallback = true
                    main.post { view.loadUrl(MainActivity.BUNDLED_UI) }
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = false
        }
    }

    override fun load(url: String) {
        loadedFallback = false
        web.loadUrl(url)
    }

    override fun emit(type: String, json: String) {
        eval("window.__arNative&&window.__arNative.emit(${MiniJson.quote(type)},${MiniJson.quote(json)})")
    }

    override fun eval(js: String) {
        main.post { web.evaluateJavascript(js, null) }
    }

    override fun capture(done: (Bitmap?) -> Unit) {
        val w = web.width.coerceAtLeast(1)
        val h = web.height.coerceAtLeast(1)
        val full = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        web.draw(Canvas(full))
        done(full)
    }

    override fun onResume() = web.onResume()

    override fun destroy() = web.destroy()

    override fun onPermissionsResult(requestCode: Int, grantResults: IntArray) {
        if (requestCode != REQ_MIC) return
        val req = pendingMic ?: return
        pendingMic = null
        if (grantResults.isNotEmpty() && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            req.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else {
            req.deny()
        }
    }

    companion object {
        private const val REQ_MIC = 7101
    }
}

/** The system WebView's version on Android 5 / 6 (no getCurrentWebViewPackage there). */
internal fun systemWebViewVersion(c: android.content.Context): String? {
    for (p in arrayOf("com.android.webview", "com.google.android.webview")) {
        try {
            return c.packageManager.getPackageInfo(p, 0).versionName ?: continue
        } catch (e: Exception) {
            /* not this one */
        }
    }
    return null
}
