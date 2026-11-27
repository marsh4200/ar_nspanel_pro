package za.co.arsmarthome.nspanel

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * Shelly Wall Display, firmware 2.6+: "AR on top".
 *
 * On this firmware Shelly's app (Stargate) is the device owner and runs as the
 * system user: Android won't let anyone switch it off, hide it, stop it or take
 * Home away from it ("only Stargate is allowed as the Home app"). So it keeps
 * running underneath, and this app stays in front:
 *
 *  - Shelly's floating windows (the Shelly icon, and a see-through full-screen
 *    one) are gone: HA's takeover denies it "draw over other apps"
 *    (appops SYSTEM_ALERT_WINDOW deny). Re-applied here through the panel's own
 *    ADB at every start, in case Shelly switches it back.
 *  - Whenever Shelly's screen comes to the front, this app comes back on top
 *    within ~2 s. It only reacts to Shelly's own packages: Android Settings or
 *    anything else opened on purpose is left alone.
 *  - A foreground service, so Shelly ("background apps are killed on resume")
 *    and Android's battery saver can't kill it.
 *
 * Stops by itself once "Back to Shelly screen" has run (Shelly.takenOver false).
 */
class ShellyWatch : Service() {
    private val main = Handler(Looper.getMainLooper())
    private var lastBring = 0L
    private var brings = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        goForeground()
        Thread({ Shelly.reassertOverlays(applicationContext) }, "ar-shelly-overlays").apply { isDaemon = true }.start()
        main.postDelayed(tick, EVERY_MS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!Shelly.onTop(applicationContext)) {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        main.removeCallbacks(tick)
        running = false
        super.onDestroy()
    }

    private fun goForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val b = if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Panel on top", NotificationManager.IMPORTANCE_MIN))
            Notification.Builder(this, CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val n = b.setContentTitle("AR NSPanel Pro")
            .setContentText("Keeps the panel in front of Shelly's screen")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .build()
        try {
            startForeground(NOTE_ID, n)
        } catch (e: Exception) {
            Log.w(TAG, "foreground", e) // still works as a plain service while the app runs
        }
    }

    private val tick = object : Runnable {
        override fun run() {
            val app = applicationContext
            if (!Shelly.onTop(app)) {
                stopSelf()
                return
            }
            try {
                check(app)
            } catch (e: Exception) {
                Log.w(TAG, "check", e)
            }
            main.postDelayed(this, EVERY_MS)
        }
    }

    private fun check(app: Context) {
        val pm = app.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isInteractive) return // screen off: nothing to see
        if (System.currentTimeMillis() < Shelly.pausedUntil) return
        val top = foreground(app) ?: return
        if (top == app.packageName || top !in Shelly.offPackages(app)) return
        val now = System.currentTimeMillis()
        if (now - lastBring < 1500) return
        lastBring = now
        brings++
        Log.i(TAG, "Shelly's screen came to the front ($top): back on top (#$brings)")
        try {
            app.startActivity(
                Intent(app, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
            )
        } catch (e: Exception) {
            Log.w(TAG, "bring to front", e)
        }
    }

    /** The app in front now: the last one resumed (needs usage access, which HA's takeover allows). */
    private fun foreground(app: Context): String? {
        if (Build.VERSION.SDK_INT < 22) return null
        val usm = app.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager ?: return null
        val now = System.currentTimeMillis()
        val ev = usm.queryEvents(now - 10 * 60_000, now) ?: return null
        val e = UsageEvents.Event()
        var last: String? = null
        while (ev.hasNextEvent()) {
            ev.getNextEvent(e)
            @Suppress("DEPRECATION")
            if (e.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND) last = e.packageName
        }
        return last
    }

    companion object {
        private const val TAG = "ARShellyWatch"
        private const val CHANNEL = "ar_on_top"
        private const val NOTE_ID = 4711
        private const val EVERY_MS = 2000L
        @Volatile private var running = false

        /** Start the watch when "AR on top" is on (safe to call often). */
        fun start(c: Context) {
            val app = c.applicationContext
            if (!Shelly.onTop(app) || running) return
            running = true
            try {
                val i = Intent(app, ShellyWatch::class.java)
                if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(i) else app.startService(i)
            } catch (e: Exception) {
                running = false
                Log.w(TAG, "start", e)
            }
        }
    }
}
