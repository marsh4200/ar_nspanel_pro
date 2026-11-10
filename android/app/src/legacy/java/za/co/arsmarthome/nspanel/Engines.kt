package za.co.arsmarthome.nspanel

import android.os.Build

/**
 * Legacy build (Android 5+). The panel UI runs:
 *  * in Android's own WebView ([WebViewEngine], as the standard build) when the
 *    panel's WebView is new enough -- the HDL S57 after its WebView 106 update
 *    (tools/s57-webview): no Chrome, no address bar, no switch to full screen;
 *  * else in Chrome (Chrome 95 is the last for Android 5), served by this app
 *    over 127.0.0.1. See [ChromeEngine]. Panels with an old WebView (the HDL S10
 *    touch, Chrome 39) stay exactly as they were.
 */
object Engines {
    const val BUILD = "legacy"

    /** The oldest WebView (major version) that runs the panel UI well. */
    private const val WEBVIEW_OK = 90

    @androidx.media3.common.util.UnstableApi
    fun create(activity: MainActivity, bridge: NativeBridge): PanelEngine =
        if (Build.VERSION.SDK_INT >= 23 && webViewMajor(activity) >= WEBVIEW_OK) WebViewEngine(activity, bridge)
        else ChromeEngine(activity, bridge)

    private fun webViewMajor(activity: MainActivity): Int =
        (systemWebViewVersion(activity) ?: "").substringBefore('.').toIntOrNull() ?: 0
}
