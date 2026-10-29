package za.co.arsmarthome.nspanel

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper

/**
 * An invisible screen that opens over Chrome for a moment and closes again.
 * It makes Android recalculate its bars and Chrome redo its layout, the way a
 * two-finger touch does: on Chrome 95 / Android 5 full screen sometimes leaves
 * a white strip where the navigation bar was. Test-menu button 6 (LocalBridge).
 */
class NudgeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
        Handler(Looper.getMainLooper()).postDelayed({ finish() }, 350)
    }

    override fun finish() {
        super.finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }
}
