package za.co.arsmarthome.nspanel;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;

import org.mozilla.geckoview.BuildConfig;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;

import java.io.File;

import kotlin.Unit;
import kotlin.jvm.functions.Function1;

/**
 * Legacy build: the panel UI runs in a bundled Gecko (Firefox) engine instead of
 * the system WebView, for panels whose WebView is too old (Android 5.1 with
 * Chrome 39 on the HDL S10 touch). The page talks to {@link NativeBridge}
 * through {@link LocalBridge} (127.0.0.1), so the UI itself is unchanged.
 *
 * Java on purpose: GeckoView's delegate interfaces carry nullability
 * annotations that Kotlin overrides must match exactly; Java doesn't care.
 */
final class GeckoEngine implements PanelEngine {
    private static final String TAG = "ARGecko";
    private static GeckoRuntime runtime;

    private final MainActivity activity;
    private final LocalBridge local;
    private final GeckoView geckoView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private GeckoSession session;
    private String lastUrl;

    GeckoEngine(MainActivity activity, NativeBridge bridge) {
        this.activity = activity;
        StartupGuard.INSTANCE.stage(activity, "starting the local bridge (127.0.0.1:" + LocalBridge.PORT + ")");
        local = new LocalBridge(activity.getApplicationContext(), bridge);
        local.start();

        StartupGuard.INSTANCE.stage(activity, "creating GeckoView");
        geckoView = new GeckoView(activity);
        // TextureView: RTSP camera views and the screen-off blackout sit on top of it
        geckoView.setViewBackend(GeckoView.BACKEND_TEXTURE_VIEW);
        geckoView.setBackgroundColor(Color.BLACK);
        newSession();
    }

    private static synchronized GeckoRuntime runtime(Context c) {
        if (runtime == null) {
            GeckoRuntimeSettings s = new GeckoRuntimeSettings.Builder()
                    .javaScriptEnabled(true)
                    .remoteDebuggingEnabled(true) // about:debugging over ADB
                    .consoleOutput(true)          // console.log -> logcat
                    .fontInflation(false)         // same sizes as the editor preview
                    .fontSizeFactor(1f)
                    .build();
            StartupGuard.INSTANCE.stage(c, "starting the Gecko runtime (GeckoRuntime.create)");
            runtime = GeckoRuntime.create(c.getApplicationContext(), s);
            StartupGuard.INSTANCE.stage(c, "Gecko runtime started");
        }
        return runtime;
    }

    private void newSession() {
        if (session != null) {
            try {
                session.close();
            } catch (Exception ignored) {
            }
        }
        session = new GeckoSession();
        session.setPermissionDelegate(new GeckoSession.PermissionDelegate() {
            // Intercom microphone: granted at install on Android 5, so just say yes
            @Override
            public void onAndroidPermissionsRequest(GeckoSession s, String[] permissions, Callback callback) {
                callback.grant();
            }

            @Override
            public GeckoResult<Integer> onContentPermissionRequest(GeckoSession s, ContentPermission perm) {
                // autoplay (siren, TTS, chimes), and anything else the panel page asks
                return GeckoResult.fromValue(ContentPermission.VALUE_ALLOW);
            }

            @Override
            public void onMediaPermissionRequest(GeckoSession s, String uri, MediaSource[] video,
                                                 MediaSource[] audio, MediaCallback callback) {
                if (audio == null || audio.length == 0) {
                    callback.reject();
                    return;
                }
                callback.grant(null, audio[0]);
            }
        });
        session.setContentDelegate(new GeckoSession.ContentDelegate() {
            @Override
            public void onCrash(GeckoSession s) {
                Log.w(TAG, "Gecko content crashed: reloading");
                main.post(GeckoEngine.this::restart);
            }

            @Override
            public void onKill(GeckoSession s) {
                Log.w(TAG, "Gecko content killed: reloading");
                main.post(GeckoEngine.this::restart);
            }
        });
        GeckoRuntime rt = runtime(activity);
        StartupGuard.INSTANCE.stage(activity, "opening the Gecko session");
        session.open(rt);
        geckoView.setSession(session);
        StartupGuard.INSTANCE.stage(activity, "Gecko session open");
    }

    private void restart() {
        newSession();
        if (lastUrl != null) session.loadUri(lastUrl);
    }

    @Override
    public View getView() {
        return geckoView;
    }

    @Override
    public String getKind() {
        return "gecko";
    }

    @Override
    public String getVersion() {
        return "Gecko " + BuildConfig.MOZILLA_VERSION;
    }

    /** BUNDLED_UI / UiCache's file:// copy -> the same files over the local bridge. */
    @Override
    public void load(String url) {
        String uiDir = new File(activity.getFilesDir(), "ui").getAbsolutePath();
        String page;
        if (url.startsWith("file://" + uiDir + "/")) {
            page = local.pageUrl("/ui/" + url.substring(("file://" + uiDir + "/").length()));
        } else {
            if (!url.equals(MainActivity.BUNDLED_UI)) {
                // Home Assistant's UI couldn't be copied yet: the bundled copy has the bridge
                Log.w(TAG, "no local copy of " + url + "; using the bundled UI");
            }
            page = local.pageUrl("/app/index.html");
        }
        lastUrl = page;
        StartupGuard.INSTANCE.stage(activity, "Gecko loading " + page.replaceAll("t=[0-9a-f]+", "t=…"));
        session.loadUri(page);
    }

    @Override
    public void emit(String type, String json) {
        local.emit(type, json);
    }

    @Override
    public void eval(String js) {
        local.eval(js);
    }

    @Override
    public void capture(Function1<? super Bitmap, Unit> done) {
        try {
            geckoView.capturePixels().accept(
                    bmp -> done.invoke(bmp),
                    e -> {
                        Log.w(TAG, "capture failed", e);
                        done.invoke(null);
                    });
        } catch (Exception e) {
            Log.w(TAG, "capture failed", e);
            done.invoke(null);
        }
    }

    @Override
    public void onResume() {
        if (session != null) session.setActive(true);
    }

    @Override
    public void onPause() {
        // a wall panel keeps running behind a system dialog
    }

    @Override
    public void destroy() {
        if (session != null) session.close();
        local.stop();
    }

    @Override
    public void onPermissionsResult(int requestCode, int[] grantResults) {
    }
}
