package za.co.arsmarthome.nspanel

/** Standard build (Android 7+): the panel UI runs in Android's own WebView. */
object Engines {
    const val BUILD = "standard"

    @androidx.media3.common.util.UnstableApi
    fun create(activity: MainActivity, bridge: NativeBridge): PanelEngine = WebViewEngine(activity, bridge)
}
