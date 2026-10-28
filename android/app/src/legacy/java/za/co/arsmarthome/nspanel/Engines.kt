package za.co.arsmarthome.nspanel

/** Legacy build (Android 5+): the panel UI runs in a bundled Gecko engine. */
object Engines {
    const val BUILD = "legacy"

    @androidx.media3.common.util.UnstableApi
    fun create(activity: MainActivity, bridge: NativeBridge): PanelEngine = GeckoEngine(activity, bridge)
}
