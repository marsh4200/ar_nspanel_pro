package za.co.arsmarthome.nspanel

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest

/**
 * Over-the-air app update: no ADB needed after the first install.
 *
 * Built for panels that only have USB debugging (the HDL S10 touch): the app
 * is put on once over USB (tools/usb-setup), then Home Assistant updates it
 * over MQTT (cmd/update -> this). The panel downloads the APK itself and
 * installs it with Android's PackageInstaller.
 *
 * How quiet the install is depends on what the USB setup managed:
 *  * device owner (dpm set-device-owner): silent, any Android version.
 *  * Android 12+ and this app is its own "installer of record"
 *    (pm set-installer): silent, via USER_ACTION_NOT_REQUIRED.
 *  * otherwise: Android shows its "Do you want to update this app?" screen on
 *    the panel and someone taps Update once.
 *
 * Safety: only release APKs from this project's GitHub, or files served by
 * the panel's own Home Assistant / broker host, are fetched; and Android
 * itself refuses an APK that isn't signed with the same key as this app.
 *
 * Progress goes to the page as the "update" event (and from there to
 * sys/update): {state, pct?, message?, version?, mode}.
 */
object Updater {
    private const val TAG = "ARUpdate"
    const val ACTION_STATUS = "za.co.arsmarthome.nspanel.UPDATE_STATUS"
    private const val GITHUB_PATH = "/marsh4200/ar_nspanel_pro/releases/download/"
    private const val MAX_BYTES = 80L * 1024 * 1024

    @Volatile
    private var busy = false

    /** "silent" when no tap is needed, "prompt" when Android will ask, "none" if it can't. */
    fun mode(ctx: Context): String {
        if (Kiosk.isOwner(ctx)) return "silent"
        if (Build.VERSION.SDK_INT >= 31 && isOwnInstaller(ctx)) return "silent"
        if (Build.VERSION.SDK_INT >= 26 && !ctx.packageManager.canRequestPackageInstalls()) return "none"
        return "prompt"
    }

    private fun isOwnInstaller(ctx: Context): Boolean = try {
        val who = if (Build.VERSION.SDK_INT >= 30) {
            ctx.packageManager.getInstallSourceInfo(ctx.packageName).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            ctx.packageManager.getInstallerPackageName(ctx.packageName)
        }
        who == ctx.packageName
    } catch (e: Exception) {
        false
    }

    fun versionCode(ctx: Context): Long = try {
        val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else @Suppress("DEPRECATION") pi.versionCode.toLong()
    } catch (e: Exception) {
        0L
    }

    /** Is [url] somewhere we fetch updates from? */
    fun allowed(url: String, homeHosts: Set<String>): Boolean = try {
        val u = URI(url)
        val host = (u.host ?: "").lowercase()
        when {
            u.scheme.equals("https", true) && host == "github.com" && (u.path ?: "").startsWith(GITHUB_PATH) -> true
            (u.scheme.equals("http", true) || u.scheme.equals("https", true)) && host.isNotEmpty() && host in homeHosts -> true
            else -> false
        }
    } catch (e: Exception) {
        false
    }

    /**
     * Download [url] and install it. [sha256] (hex) is checked when given.
     * [force] allows the same or an older version. Runs on its own thread;
     * [report] gets the progress (any thread).
     */
    fun start(
        ctx: Context,
        url: String,
        sha256: String?,
        force: Boolean,
        homeHosts: Set<String>,
        report: (Map<String, Any?>) -> Unit,
    ) {
        val app = ctx.applicationContext
        val mode = mode(app)
        fun say(state: String, extra: Map<String, Any?> = emptyMap()) {
            val m = linkedMapOf<String, Any?>("state" to state, "mode" to mode)
            m.putAll(extra)
            m["ts"] = System.currentTimeMillis()
            remember(app, m)
            report(m)
        }
        if (mode == "none") {
            // Installed from a USB stick / file manager: the app hasn't been
            // allowed to install apps yet. Open that switch on the panel; once
            // it is on, the next Install from Home Assistant goes through.
            val opened = openInstallPermission(app)
            say(
                "error",
                mapOf(
                    "message" to if (opened) {
                        "On the panel: switch on 'Allow from this source' for AR NSPanel Pro (now open), then press Install again."
                    } else {
                        "Allow the app to install updates: panel Settings > Apps > Special app access > Install unknown apps > AR NSPanel Pro, then press Install again."
                    },
                ),
            )
            return
        }
        if (!allowed(url, homeHosts)) {
            say("error", mapOf("message" to "Update refused: not a release of this app or a file on your Home Assistant ($url)"))
            return
        }
        synchronized(this) {
            if (busy) {
                say("error", mapOf("message" to "An update is already running"))
                return
            }
            busy = true
        }
        Thread {
            val file = File(app.cacheDir, "update.apk")
            try {
                say("downloading", mapOf("pct" to 0))
                download(url, file) { got, total ->
                    val pct = if (total > 0) (got * 100 / total).toInt() else -1
                    say("downloading", mapOf("pct" to pct, "bytes" to got))
                }
                if (sha256 != null && sha256.isNotBlank()) {
                    val got = sha256Hex(file)
                    if (!got.equals(sha256.trim(), true)) throw UpdateError("The download is damaged (checksum differs). Try again.")
                }
                val info = archiveInfo(app, file) ?: throw UpdateError("The download isn't an Android app (APK).")
                if (info.packageName != app.packageName) throw UpdateError("That APK is a different app (${info.packageName}).")
                if (!sameSigner(app, info)) throw UpdateError("That APK isn't signed with this app's key; Android would refuse it.")
                val newCode = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
                if (!force && newCode <= versionCode(app)) {
                    say("done", mapOf("message" to "Already up to date (v${info.versionName})", "version" to info.versionName))
                    return@Thread
                }
                say("installing", mapOf("version" to info.versionName, "pct" to 100))
                install(app, file)
                // The rest arrives in UpdateReceiver. On success Android stops
                // this app and BootReceiver (MY_PACKAGE_REPLACED) starts it again.
                if (mode == "prompt") {
                    say("waiting", mapOf("version" to info.versionName, "message" to "Tap Update on the panel screen"))
                }
            } catch (e: UpdateError) {
                say("error", mapOf("message" to e.message))
            } catch (e: Exception) {
                Log.w(TAG, "update failed", e)
                say("error", mapOf("message" to "${e.javaClass.simpleName}: ${e.message}"))
            } finally {
                busy = false
            }
        }.start()
    }

    private class UpdateError(msg: String) : Exception(msg)

    /** Android's "Install unknown apps" switch for this app (8.0+). */
    fun openInstallPermission(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < 26) return false
        return try {
            val i = Intent(
                android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                android.net.Uri.parse("package:" + ctx.packageName),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(i)
            true
        } catch (e: Exception) {
            false
        }
    }

    private fun download(url: String, out: File, tick: (Long, Long) -> Unit) {
        var c = URL(url).openConnection() as HttpURLConnection
        // GitHub redirects https -> https (objects.githubusercontent.com): followed automatically
        c.instanceFollowRedirects = true
        c.connectTimeout = 15000
        c.readTimeout = 60000
        c.setRequestProperty("User-Agent", "ar-nspanel-pro-app")
        val code = c.responseCode
        if (code !in 200..299) {
            c.disconnect()
            throw UpdateError("Download failed: HTTP $code")
        }
        val total = c.contentLengthLong
        if (total > MAX_BYTES) throw UpdateError("The download is unexpectedly large ($total bytes).")
        out.delete()
        var got = 0L
        var lastTick = 0L
        c.inputStream.use { input ->
            out.outputStream().use { o ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    o.write(buf, 0, n)
                    got += n
                    if (got > MAX_BYTES) throw UpdateError("The download is unexpectedly large.")
                    val now = System.currentTimeMillis()
                    if (now - lastTick > 700) {
                        lastTick = now
                        tick(got, total)
                    }
                }
            }
        }
        c.disconnect()
        if (total > 0 && got != total) throw UpdateError("The download stopped early ($got of $total bytes).")
        tick(got, if (total > 0) total else got)
    }

    private fun sha256Hex(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    @SuppressLint("PackageManagerGetSignatures")
    @Suppress("DEPRECATION")
    private fun archiveInfo(ctx: Context, f: File): PackageInfo? =
        ctx.packageManager.getPackageArchiveInfo(f.path, PackageManager.GET_SIGNATURES)

    @SuppressLint("PackageManagerGetSignatures")
    @Suppress("DEPRECATION")
    private fun sameSigner(ctx: Context, apk: PackageInfo): Boolean = try {
        val mine = ctx.packageManager.getPackageInfo(ctx.packageName, PackageManager.GET_SIGNATURES).signatures
        val theirs = apk.signatures
        if (mine.isNullOrEmpty() || theirs.isNullOrEmpty()) {
            true // couldn't read them: let Android's own check decide
        } else {
            mine.map { it.toCharsString() }.toSet() == theirs.map { it.toCharsString() }.toSet()
        }
    } catch (e: Exception) {
        true
    }

    private fun install(ctx: Context, f: File) {
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        params.setSize(f.length())
        if (Build.VERSION.SDK_INT >= 31) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            f.inputStream().use { input ->
                s.openWrite("app.apk", 0, f.length()).use { o ->
                    input.copyTo(o, 64 * 1024)
                    s.fsync(o)
                }
            }
            val intent = Intent(ctx, UpdateReceiver::class.java).setAction(ACTION_STATUS)
            var flags = PendingIntent.FLAG_UPDATE_CURRENT
            // PackageInstaller fills in the result extras: must be mutable on 12+
            if (Build.VERSION.SDK_INT >= 31) flags = flags or PendingIntent.FLAG_MUTABLE
            val pending = PendingIntent.getBroadcast(ctx, id, intent, flags)
            s.commit(pending.intentSender)
        }
    }

    // --- last status, kept so the page can report it after the app restarts ---

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("update", Context.MODE_PRIVATE)

    fun remember(ctx: Context, m: Map<String, Any?>) {
        prefs(ctx).edit().putString("last", MiniJson.stringify(m)).apply()
    }

    fun last(ctx: Context): String = prefs(ctx).getString("last", "") ?: ""

    /** After an update the app comes back as a new version: say so once. */
    fun markInstalledIfUpdated(ctx: Context) {
        val last = last(ctx)
        if (last.isEmpty()) return
        val m = try {
            MiniJson.parse(last) as? Map<*, *>
        } catch (e: Exception) {
            null
        } ?: return
        val state = m["state"] as? String
        if (state == "installing" || state == "waiting") {
            val v = try {
                ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName
            } catch (e: Exception) {
                null
            }
            remember(ctx, linkedMapOf("state" to "done", "version" to v, "message" to "Updated to v$v", "mode" to mode(ctx), "ts" to System.currentTimeMillis()))
        }
    }
}

/** PackageInstaller's answer for an update session. */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // No device owner: Android asks on screen. Show its dialog.
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                }
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    try {
                        context.startActivity(confirm)
                    } catch (e: Exception) {
                        report(context, "error", "Couldn't show Android's install screen: ${e.message}")
                        return
                    }
                }
                report(context, "waiting", "Tap Update on the panel screen")
            }
            PackageInstaller.STATUS_SUCCESS -> report(context, "done", "Installed")
            PackageInstaller.STATUS_FAILURE_ABORTED -> report(context, "error", "The update was cancelled on the panel")
            else -> report(context, "error", "Android refused the update: ${msg ?: "status $status"}")
        }
    }

    private fun report(ctx: Context, state: String, message: String) {
        val m = linkedMapOf<String, Any?>("state" to state, "message" to message, "mode" to Updater.mode(ctx), "ts" to System.currentTimeMillis())
        Updater.remember(ctx, m)
        MainActivity.current?.emit("update", MiniJson.stringify(m))
    }
}
