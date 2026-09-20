# The JS bridge is called by name from the WebView.
-keepclassmembers class za.co.arsmarthome.nspanel.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
