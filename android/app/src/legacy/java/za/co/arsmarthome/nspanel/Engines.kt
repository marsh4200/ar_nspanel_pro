package za.co.arsmarthome.nspanel

/**
 * Legacy build (Android 5+): the panel UI runs in Chrome (Chrome 95 is the last
 * for Android 5), served by this app over 127.0.0.1. See [ChromeEngine].
 */
object Engines {
    const val BUILD = "legacy"

    @androidx.media3.common.util.UnstableApi
    fun create(activity: MainActivity, bridge: NativeBridge): PanelEngine = ChromeEngine(activity, bridge)
}
