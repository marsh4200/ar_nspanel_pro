package za.co.arsmarthome.nspanel

import android.graphics.Bitmap
import android.view.View

/**
 * What draws the panel UI. Two builds of the app, one interface:
 *
 *  * standard (Android 7+): Android's own WebView      -> src/standard/.../Engines.kt
 *  * legacy   (Android 5+): a bundled Gecko (Firefox)  -> src/legacy/.../Engines.kt
 *    engine, for panels whose system WebView is too old for the UI (the
 *    HDL S10 touch on Android 5.1 ships Chrome 39).
 *
 * Both give the page the same `window.ARNative` ([NativeBridge]) and the same
 * `window.__arNative.emit(type, json)` events, so the panel UI, the MQTT
 * protocol and the Home Assistant integration are identical on both.
 */
interface PanelEngine {
    /** The view to put on screen. */
    val view: View

    /** "webview" or "gecko", and its version (sys/info `webview`). */
    val kind: String
    val version: String?

    /** Load the UI: [MainActivity.BUNDLED_UI], a file:// copy (UiCache) or an http(s) URL. */
    fun load(url: String)

    /** window.__arNative.emit(type, json) on the page. Any thread. */
    fun emit(type: String, json: String)

    /** Run JavaScript on the page (no result). Any thread. */
    fun eval(js: String)

    /** What the page shows right now, as a bitmap (UI thread; [done] may run later). */
    fun capture(done: (Bitmap?) -> Unit)

    fun onResume() {}
    fun onPause() {}
    fun destroy() {}

    /** Forwarded from the activity (the WebView build asks for the microphone this way). */
    fun onPermissionsResult(requestCode: Int, grantResults: IntArray) {}
}
