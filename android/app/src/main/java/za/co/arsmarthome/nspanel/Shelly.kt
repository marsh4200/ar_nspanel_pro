package za.co.arsmarthome.nspanel

import android.app.Activity
import android.app.Dialog
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Shelly Wall Display (X2i "Jenna", SAWD-5A1XX10EU0; the other SAWD-* models
 * are recognised the same way). Android 11, Rockchip RK3326.
 *
 * Home Assistant's "Use AR app (Shelly off)" switches Shelly's own app
 * (cloud.shelly.stargate) off and makes this app Home. It tells this app which
 * packages it switched off and what Shelly's Home screen is (ShellyControl,
 * SHELLY_OFF), so the panel can undo it BY ITSELF later:
 *
 *  "Back to Shelly screen" (setup screen, start-up report, or hold the top-right
 *  corner for 8 s) puts Shelly back without Home Assistant or a computer:
 *   1. device owner (set by Home Assistant when Android allows it): Shelly's app
 *      was only *hidden*, so the app un-hides it and pins Shelly as Home itself;
 *   2. otherwise the app connects to the panel's own ADB (LocalAdb, 127.0.0.1)
 *      and runs `pm enable …` / set Home as the shell user;
 *   3. if neither works, it opens Android's Settings on Shelly's app (Enable)
 *      and on Default apps > Home app, so it can be done by hand.
 *  Then this app stops opening itself at boot and Shelly's screen opens.
 */
object Shelly {
    private const val TAG = "ARShelly"
    const val STOCK_APP = "cloud.shelly.stargate"
    const val ACTION_OFF = "za.co.arsmarthome.nspanel.SHELLY_OFF"
    const val ACTION_ON = "za.co.arsmarthome.nspanel.SHELLY_ON"
    const val ACTION_ADB_PAIR = "za.co.arsmarthome.nspanel.SHELLY_ADB_PAIR"

    private fun prefs(c: Context) = c.applicationContext.getSharedPreferences("shelly", Context.MODE_PRIVATE)
    private fun dpm(c: Context) = c.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    private fun admin(c: Context) = ComponentName(c, KioskAdmin::class.java)

    /** A Shelly Wall Display: model SAWD-…, or Home Assistant took one over here. */
    fun isShelly(c: Context): Boolean =
        Device.isShellyWallDisplay || prefs(c).contains("pkgs")

    /** Packages Home Assistant switched off (Shelly's app at least). */
    fun offPackages(c: Context): List<String> {
        val saved = (prefs(c).getString("pkgs", null) ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }
        return if (saved.isEmpty()) listOf(STOCK_APP) else saved
    }

    private fun savedHome(c: Context): String? = prefs(c).getString("home", null)?.takeIf { "/" in it }

    /** HA switched Shelly off: remember what, so the panel can undo it alone. */
    fun remember(c: Context, pkgs: List<String>, home: String?) {
        val e = prefs(c).edit().putString("pkgs", pkgs.joinToString(","))
        if (!home.isNullOrBlank() && "/" in home) e.putString("home", home)
        e.commit()
    }

    fun adbPaired(c: Context): Boolean = prefs(c).getBoolean("adbPaired", false)

    // --- state -------------------------------------------------------------------------

    private fun isHidden(c: Context, pkg: String): Boolean = try {
        Kiosk.isOwner(c) && dpm(c).isApplicationHidden(admin(c), pkg)
    } catch (e: Exception) {
        false
    }

    /** Installed and switched on (null: not installed / can't see it). */
    private fun isEnabled(c: Context, pkg: String): Boolean? = try {
        @Suppress("DEPRECATION")
        val flags = PackageManager.GET_DISABLED_COMPONENTS or PackageManager.GET_UNINSTALLED_PACKAGES
        val ai = c.packageManager.getApplicationInfo(pkg, flags)
        val st = c.packageManager.getApplicationEnabledSetting(pkg)
        ai.enabled && st != PackageManager.COMPONENT_ENABLED_STATE_DISABLED &&
            st != PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER
    } catch (e: Exception) {
        null
    }

    /** For the setup screen: {shelly, owner, pkgs, off:[…], adbPaired}. */
    fun state(c: Context): Map<String, Any?> {
        val pkgs = offPackages(c)
        return linkedMapOf(
            "shelly" to isShelly(c),
            "owner" to Kiosk.isOwner(c),
            "pkgs" to pkgs,
            "off" to pkgs.filter { isHidden(c, it) || isEnabled(c, it) == false },
            "adbPaired" to adbPaired(c),
        )
    }

    // --- take over (from Home Assistant, over ADB) ---------------------------------------

    /** Device owner: hide Shelly's packages and pin this app as Home. Hidden ones listed. */
    fun hideAll(c: Context, pkgs: List<String>): List<String> {
        if (!Kiosk.isOwner(c)) return emptyList()
        val d = dpm(c)
        val a = admin(c)
        try {
            d.clearPackagePersistentPreferredActivities(a, c.packageName)
            d.addPersistentPreferredActivity(a, homeFilter(), ComponentName(c, MainActivity::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "pin home failed", e)
        }
        val done = ArrayList<String>()
        for (p in pkgs) {
            if (p == c.packageName) continue
            try {
                if (d.setApplicationHidden(a, p, true) || d.isApplicationHidden(a, p)) done.add(p)
            } catch (e: Exception) {
                Log.w(TAG, "hide $p failed", e)
            }
        }
        setBootStart(c, true)
        return done
    }

    private fun homeFilter() = IntentFilter(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_HOME)
        addCategory(Intent.CATEGORY_DEFAULT)
    }

    /** This app opening itself at boot (off once Shelly is back in charge). */
    fun setBootStart(c: Context, on: Boolean) {
        try {
            c.packageManager.setComponentEnabledSetting(
                ComponentName(c, BootReceiver::class.java),
                if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP,
            )
        } catch (e: Exception) {
            Log.w(TAG, "boot receiver", e)
        }
    }

    // --- back to Shelly (on the panel, no Home Assistant needed) -------------------------

    /** The local ADB ports to try: the usual one, the one in use now, and any found. */
    private fun adbPorts(): List<Int> {
        val l = ArrayList<Int>()
        l.add(5555)
        for (prop in arrayOf("service.adb.tcp.port", "persist.adb.tcp.port")) {
            sysProp(prop)?.toIntOrNull()?.takeIf { it in 1..65535 }?.let { l.add(it) }
        }
        return l.distinct()
    }

    private fun sysProp(name: String): String? = try {
        val p = Runtime.getRuntime().exec(arrayOf("getprop", name))
        val v = p.inputStream.bufferedReader().readText().trim()
        p.destroy()
        v.ifEmpty { null }
    } catch (e: Exception) {
        null
    }

    /** Shelly's Home activity: what HA saw before switching it off, else ask Android. */
    private fun shellyHome(c: Context, pkgs: List<String>): ComponentName? {
        try {
            val i = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
            @Suppress("DEPRECATION")
            val found = c.packageManager.queryIntentActivities(i, PackageManager.GET_DISABLED_COMPONENTS)
                .map { it.activityInfo }
                .firstOrNull { it.packageName in pkgs }
            if (found != null) return ComponentName(found.packageName, found.name)
        } catch (e: Exception) {
        }
        return savedHome(c)?.let { ComponentName.unflattenFromString(it) }
    }

    /** Shell commands that put Shelly back (run over the panel's own ADB). */
    fun restoreScript(c: Context, pkgs: List<String>, home: ComponentName?): String {
        val sb = StringBuilder()
        for (p in pkgs) {
            sb.append("pm unhide $p >/dev/null 2>&1; pm install-existing --user 0 $p >/dev/null 2>&1; ")
            sb.append("echo \"$p: $(pm enable $p 2>&1)\"; ")
        }
        sb.append("settings put global adb_enabled 1; ")
        if (home != null) {
            val h = home.flattenToShortString()
            sb.append("r=$(cmd package set-home-activity $h 2>&1); case \"\$r\" in *uccess*) echo \"Home: ${home.packageName}\";; ")
            sb.append("*) cmd role add-role-holder android.app.role.HOME ${home.packageName} >/dev/null 2>&1; echo \"Home role: ${home.packageName}\";; esac; ")
        }
        sb.append("pm disable ${c.packageName}/${BootReceiver::class.java.name} >/dev/null 2>&1; sync; echo done")
        return sb.toString()
    }

    /**
     * Put Shelly back. Blocking: call it off the main thread. [say] gets progress
     * lines. Returns true when Shelly's app is on again.
     */
    fun restore(c: Context, say: (String) -> Unit): Boolean {
        val app = c.applicationContext
        val pkgs = offPackages(app)
        say("Switching Shelly back on: ${pkgs.joinToString()}")
        if (AdbHelper.enable(app, false)) say("ADB switched on (so Home Assistant can reach the panel again).")
        val owner = Kiosk.isOwner(app)
        var homeDone = false
        if (owner) {
            val d = dpm(app)
            val a = admin(app)
            for (p in pkgs) {
                try {
                    if (d.isApplicationHidden(a, p)) {
                        d.setApplicationHidden(a, p, false)
                        say("$p: shown again ✓")
                    }
                } catch (e: Exception) {
                    say("$p: couldn't show it (${e.javaClass.simpleName})")
                }
            }
            try {
                d.clearPackagePersistentPreferredActivities(a, app.packageName)
                val h = shellyHome(app, pkgs)
                if (h != null) {
                    d.addPersistentPreferredActivity(a, homeFilter(), h)
                    homeDone = true
                    say("Home = Shelly ✓")
                }
            } catch (e: Exception) {
                say("Couldn't set Home (${e.javaClass.simpleName})")
            }
        }
        val stillOff = pkgs.filter { isEnabled(app, it) == false || isHidden(app, it) }
        if (stillOff.isNotEmpty() || !homeDone) {
            say("Asking the panel's own ADB… (if “Allow USB debugging?” appears, tap “Always allow”)")
            val r = LocalAdb.shell(app.filesDir, restoreScript(app, pkgs, shellyHome(app, pkgs)), adbPorts())
            if (r.ok) {
                prefs(app).edit().putBoolean("adbPaired", true).commit()
                r.output.lines().filter { it.isNotBlank() }.forEach { say(it.trim()) }
                homeDone = true
            } else {
                say(if (r.error == "tls") "Only Wireless debugging is on (needs pairing), not plain network ADB." else "ADB: ${r.error}")
            }
        }
        setBootStart(app, false)
        val off = pkgs.filter { isEnabled(app, it) == false || isHidden(app, it) }
        val ok = off.isEmpty() && pkgs.any { isEnabled(app, it) == true }
        if (ok) {
            prefs(app).edit().putBoolean("restored", true).commit()
            if (owner) {
                // Device owner stays (so Home Assistant can take over again), but
                // without the lock: Shelly's screen has to be able to show.
                Kiosk.setLockWanted(app, false)
            }
            say("Shelly is back ✓ Opening the Shelly screen…")
            if (!homeDone) say("Press Home once and choose Shelly with “Always”, if Android asks.")
        } else {
            say("Shelly is still off: ${off.joinToString()}. Use the buttons below to switch it on in Android's Settings.")
        }
        return ok
    }

    /** Open Shelly's screen (its Home activity, else its launcher activity). */
    fun openShelly(c: Context): Boolean {
        val pkgs = offPackages(c)
        val h = shellyHome(c, pkgs)
        val tries = ArrayList<Intent>()
        if (h != null) tries.add(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).setComponent(h))
        for (p in pkgs) c.packageManager.getLaunchIntentForPackage(p)?.let { tries.add(it) }
        tries.add(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME))
        for (i in tries) {
            try {
                c.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                return true
            } catch (e: Exception) {
            }
        }
        return false
    }

    fun openAppSettings(c: Context): Boolean = start(
        c,
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + offPackages(c).first())),
        Intent(Settings.ACTION_MANAGE_ALL_APPLICATIONS_SETTINGS),
        Intent(Settings.ACTION_SETTINGS),
    )

    fun openHomeSettings(c: Context): Boolean = start(
        c,
        Intent(Settings.ACTION_HOME_SETTINGS),
        Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS),
        Intent(Settings.ACTION_SETTINGS),
    )

    private fun start(c: Context, vararg tries: Intent): Boolean {
        for (i in tries) {
            try {
                c.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return true
            } catch (e: Exception) {
            }
        }
        return false
    }

    // --- the rescue screen (plain Android views: works even if the panel page doesn't) ----

    private var open: Dialog? = null

    /** Full-screen "Back to Shelly screen". Safe to call on any panel. */
    fun showRescue(a: Activity) {
        if (open?.isShowing == true) return
        val d = a.resources.displayMetrics.density
        val pad = (16 * d).toInt()
        val dlg = Dialog(a, android.R.style.Theme_DeviceDefault_NoActionBar_Fullscreen)
        val col = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#101418"))
            setPadding(pad, pad, pad, pad)
        }
        col.addView(TextView(a).apply {
            text = "Back to the Shelly screen"
            setTextColor(Color.WHITE)
            textSize = 22f
            setTypeface(typeface, Typeface.BOLD)
        })
        col.addView(TextView(a).apply {
            text = "Switches Shelly's own app back on, makes it the Home screen and stops AR NSPanel Pro opening at boot. " +
                "AR NSPanel Pro stays installed: Home Assistant's Device Setup can take the panel over again." +
                if (!Kiosk.isOwner(a) && !adbPaired(a)) "\n\nIf Android asks “Allow USB debugging?”, tap “Always allow”." else ""
            setTextColor(Color.parseColor("#c8d0d8"))
            textSize = 15f
            setPadding(0, pad / 2, 0, pad / 2)
        })
        val logView = TextView(a).apply {
            setTextColor(Color.parseColor("#9fe0a8"))
            textSize = 13f
            typeface = Typeface.MONOSPACE
        }
        val scroll = ScrollView(a).apply { addView(logView) }
        val main = Handler(Looper.getMainLooper())
        fun say(s: String) {
            main.post {
                logView.append(s + "\n")
                scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
            }
        }
        fun btn(label: String, bg: String, fg: String = "#ffffff") = Button(a).apply {
            text = label
            isAllCaps = false
            textSize = 17f
            setTextColor(Color.parseColor(fg))
            background = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = 14 * d
                setColor(Color.parseColor(bg))
            }
            minHeight = (60 * d).toInt()
        }
        val lp = { LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = pad / 2 } }
        val go = btn("Back to Shelly screen", "#d9822b")
        val appSet = btn("Open Shelly app in Android Settings (tap Enable)", "#2a3440")
        val homeSet = btn("Open Default apps › Home app", "#2a3440")
        val cancel = btn("Cancel", "#1c232b", "#c8d0d8")
        go.setOnClickListener {
            go.isEnabled = false
            go.text = "Working…"
            Kiosk.release(a, a) // the lock would keep Shelly's screen from showing
            Thread {
                val ok = try {
                    restore(a, ::say)
                } catch (e: Exception) {
                    say("Failed: ${e.javaClass.simpleName}: ${e.message}")
                    false
                }
                main.post {
                    go.isEnabled = true
                    go.text = if (ok) "Done" else "Try again"
                    if (ok) main.postDelayed({
                        dlg.dismiss()
                        openShelly(a)
                        a.finish()
                    }, 2500)
                }
            }.start()
        }
        appSet.setOnClickListener {
            Kiosk.release(a, a)
            if (!openAppSettings(a)) say("Android didn't open Settings.")
        }
        homeSet.setOnClickListener {
            Kiosk.release(a, a)
            if (!openHomeSettings(a)) say("Android didn't open Settings.")
        }
        cancel.setOnClickListener { dlg.dismiss() }
        col.addView(go, lp())
        col.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f).apply { topMargin = pad / 2 })
        col.addView(appSet, lp())
        col.addView(homeSet, lp())
        col.addView(cancel, lp())
        dlg.setContentView(col)
        dlg.setOnDismissListener { if (open === dlg) open = null }
        open = dlg
        dlg.show()
    }

    /** Hold the top-right corner for this long to open the rescue screen. */
    const val HOLD_MS = 8000L
    /** Corner size (dp). */
    const val CORNER_DP = 110
}

/**
 * From Home Assistant's ADB tools (shell / system only, DUMP):
 *   SHELLY_OFF  --es pkgs a,b --es home pkg/.Activity   remember + hide (device owner)
 *   SHELLY_ON                                          put Shelly back (same as the button)
 *   SHELLY_ADB_PAIR                                    connect to our own ADB once, so the
 *                                                      panel asks "Allow USB debugging?" now
 */
class ShellyControl : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        when (intent.action) {
            Shelly.ACTION_OFF -> {
                val pkgs = (intent.getStringExtra("pkgs") ?: Shelly.STOCK_APP).split(',').map { it.trim() }.filter { it.isNotEmpty() }
                Shelly.remember(app, pkgs, intent.getStringExtra("home"))
                Shelly.setBootStart(app, true)
                val hidden = Shelly.hideAll(app, pkgs)
                resultData = if (Kiosk.isOwner(app)) "hidden:" + hidden.joinToString(",") else "not_owner"
            }
            Shelly.ACTION_ON -> {
                val act = MainActivity.current
                if (act != null) act.runOnUiThread { Kiosk.release(app, act) } else Kiosk.release(app, null)
                val pending = goAsync()
                Thread {
                    val sb = StringBuilder()
                    val ok = try {
                        Shelly.restore(app) { sb.append(it).append('\n') }
                    } catch (e: Exception) {
                        false
                    }
                    if (ok) Shelly.openShelly(app)
                    MainActivity.current?.let { a -> a.runOnUiThread { a.finish() } }
                    pending.resultData = (if (ok) "ok\n" else "failed\n") + sb
                    pending.finish()
                }.start()
            }
            Shelly.ACTION_ADB_PAIR -> {
                Thread {
                    val r = LocalAdb.shell(app.filesDir, "echo paired", listOf(5555), authWaitMs = 90_000)
                    if (r.ok) app.getSharedPreferences("shelly", Context.MODE_PRIVATE).edit().putBoolean("adbPaired", true).commit()
                    Log.i("ARShelly", "local ADB pair: $r")
                }.start()
                resultData = "asking"
            }
        }
    }
}
