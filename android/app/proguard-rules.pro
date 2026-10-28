# The JS bridge is called by name from the WebView.
-keepclassmembers class za.co.arsmarthome.nspanel.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# Legacy build: GeckoView brings SnakeYAML (its config-file reader), which refers to
# desktop Java's java.beans. Android has none and that path is never used on a panel.
-dontwarn java.beans.**
