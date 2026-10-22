package za.co.arsmarthome.nspanel

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Kiosk lock for wall panels.
 *
 * Home Assistant's installer makes this app the panel's DEVICE OWNER over ADB
 * (`dpm set-device-owner`). As device owner it may lock itself in (lock task
 * mode): swiping up then shows no Home / Recents / Clear all, and the status
 * bar stays shut. The Spotify app is allowed too, so the music page's
 * "Spotify app" button still works.
 *
 * Home Assistant releases the lock over ADB before uninstalling, resetting or
 * going back to the HDL screen:
 *   am broadcast -a za.co.arsmarthome.nspanel.KIOSK_UNLOCK -n <pkg>/.KioskControl
 * KioskControl only accepts broadcasts from the ADB shell / system (DUMP).
 */
object Kiosk {
    private const val TAG = "ARKiosk"
    const val ACTION_LOCK = "za.co.arsmarthome.nspanel.KIOSK_LOCK"
    const val ACTION_UNLOCK = "za.co.arsmarthome.nspanel.KIOSK_UNLOCK"
    private val ALLOWED = arrayOf("com.spotify.music")

    private fun dpm(c: Context) = c.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    private fun admin(c: Context) = ComponentName(c, KioskAdmin::class.java)

    fun isOwner(c: Context): Boolean = try {
        dpm(c).isDeviceOwnerApp(c.packageName)
    } catch (e: Exception) {
        false
    }

    fun isLocked(c: Context): Boolean {
        val am = c.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return if (Build.VERSION.SDK_INT >= 23) {
            am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
        } else {
            @Suppress("DEPRECATION")
            am.isInLockTaskMode
        }
    }

    /** Lock the activity in (only when we are device owner). */
    fun lock(a: Activity) {
        if (!isOwner(a)) return
        try {
            val d = dpm(a)
            val ad = admin(a)
            d.setLockTaskPackages(ad, arrayOf(a.packageName) + ALLOWED)
            if (Build.VERSION.SDK_INT >= 28) {
                // no Home, no Recents, no notifications, no global actions
                d.setLockTaskFeatures(ad, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
            }
            d.setStatusBarDisabled(ad, true)
            if (!isLocked(a)) a.startLockTask()
        } catch (e: Exception) {
            Log.w(TAG, "lock failed", e)
        }
    }

    /**
     * Factory reset (the setup screen's recovery button on a locked panel that
     * has no reset button of its own). Device owner only. False if not allowed
     * -- e.g. the app was made device owner before it declared wipe-data:
     * reinstall or reboot once and it works.
     */
    fun wipe(c: Context): Boolean {
        if (!isOwner(c)) return false
        return try {
            dpm(c).wipeData(0)
            true
        } catch (e: Exception) {
            Log.w(TAG, "wipe failed", e)
            false
        }
    }

    /** Release the lock and give up device ownership (HA does this before uninstall / reset). */
    fun unlock(c: Context, activity: Activity?) {
        try {
            if (activity != null && isLocked(activity)) activity.stopLockTask()
        } catch (e: Exception) {
            Log.w(TAG, "stopLockTask failed", e)
        }
        if (!isOwner(c)) return
        try {
            val d = dpm(c)
            d.setStatusBarDisabled(admin(c), false)
            d.setLockTaskPackages(admin(c), arrayOf())
            @Suppress("DEPRECATION")
            d.clearDeviceOwnerApp(c.packageName)
        } catch (e: Exception) {
            Log.w(TAG, "unlock failed", e)
        }
    }
}

/** Device admin receiver: needed to be device owner. Does nothing else. */
class KioskAdmin : DeviceAdminReceiver()

/** Lock / unlock from Home Assistant's ADB tools (shell / system only). */
class KioskControl : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val act = MainActivity.current
        when (intent.action) {
            Kiosk.ACTION_UNLOCK -> {
                if (act != null) act.runOnUiThread { Kiosk.unlock(context, act) } else Kiosk.unlock(context, null)
                resultData = "unlocked"
            }
            Kiosk.ACTION_LOCK -> {
                act?.runOnUiThread { Kiosk.lock(act) }
                resultData = if (Kiosk.isOwner(context)) "locked" else "not_owner"
            }
        }
    }
}
