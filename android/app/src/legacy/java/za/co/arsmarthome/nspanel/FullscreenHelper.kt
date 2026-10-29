package za.co.arsmarthome.nspanel

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Legacy build: puts the Chrome-hosted panel into full screen with no tap.
 *
 * Chrome only lets a page go full screen after a real user action, and a page
 * can't fake one. An accessibility service can: Chrome treats its "click" on a
 * page element as the user's. The panel page carries a tiny invisible button
 * labelled [LABEL] (LocalBridge's script) whose click asks for full screen;
 * when the page isn't full screen it asks the app (/__ar/autofs) and this
 * service presses that button.
 *
 * Switched on once by hand: Settings → Accessibility → "AR NSPanel Pro full
 * screen". Without it, the first tap on the panel does the same.
 */
class FullscreenHelper : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        current = this
        Log.i(TAG, "accessibility helper on")
    }

    override fun onDestroy() {
        if (current === this) current = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    /** Find the page's full-screen button in Chrome and press it; retries while the page settles. */
    private fun press(triesLeft: Int) {
        val ok = try {
            val root = rootInActiveWindow
            val node = root?.let { find(it, 0) }
            val done = node != null && click(node)
            root?.recycle()
            done
        } catch (e: Exception) {
            Log.w(TAG, "press failed: ${e.message}")
            false
        }
        if (ok) {
            Log.i(TAG, "pressed the panel's full-screen button")
        } else if (triesLeft > 0) {
            main.postDelayed({ press(triesLeft - 1) }, 1500)
        } else {
            Log.w(TAG, "the panel's full-screen button wasn't found in Chrome")
        }
    }

    private fun find(n: AccessibilityNodeInfo, depth: Int): AccessibilityNodeInfo? {
        if (depth > 40) return null
        val label = (n.contentDescription ?: n.text)?.toString() ?: ""
        if (label.contains(LABEL)) return n
        for (i in 0 until n.childCount) {
            val c = n.getChild(i) ?: continue
            val hit = find(c, depth + 1)
            if (hit != null) return hit
            c.recycle()
        }
        return null
    }

    /** Click the node, or the nearest clickable parent. */
    private fun click(start: AccessibilityNodeInfo): Boolean {
        var n: AccessibilityNodeInfo? = start
        var hops = 0
        while (n != null && hops < 4) {
            if (n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            n = n.parent
            hops++
        }
        return false
    }

    companion object {
        private const val TAG = "ARFullscreen"
        /** aria-label of the page's hidden full-screen button (LocalBridge script). */
        const val LABEL = "AR full screen"

        @Volatile
        private var current: FullscreenHelper? = null

        val enabled: Boolean get() = current != null

        /** The page isn't full screen: press its button (if the helper is switched on). */
        fun request(): Boolean {
            val s = current ?: return false
            s.main.post { s.press(6) }
            return true
        }
    }
}
