package za.co.arsmarthome.nspanel

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import java.net.InetSocketAddress

/**
 * LAN cable first. When the panel has a network cable plugged in, the whole
 * app (the page, MQTT, cameras) talks over the cable, even with Wi-Fi also
 * connected, and even when the LAN has no internet: Android on its own
 * would then keep using Wi-Fi, because it calls a LAN without internet
 * "not validated". Unplug the cable and it falls back to Wi-Fi.
 *
 * The cable is only used while the MQTT broker (Home Assistant) answers over
 * it: a cable on a network that can't reach HA would otherwise take the
 * panel offline. Checked when the cable comes up and every 30 s after.
 */
object LanFirst {
    private const val TAG = "ARLan"
    private const val RECHECK_MS = 30_000L

    /** "lan" while the cable is in use, else "wifi". */
    @Volatile
    var via: String = "wifi"
        private set

    private var cb: ConnectivityManager.NetworkCallback? = null
    @Volatile
    private var eth: Network? = null
    private var worker: HandlerThread? = null
    private var h: Handler? = null

    /** target() gives the broker's host and port, or null when none is set yet. */
    fun start(c: Context, target: () -> Pair<String, Int>?, onChange: (String) -> Unit) {
        if (cb != null) return
        val cm = c.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val t = HandlerThread("ar-lan").also { it.start() }
        worker = t
        val handler = Handler(t.looper)
        h = handler

        fun set(network: Network?) {
            val want = if (network != null) "lan" else "wifi"
            if (via == want) return
            try {
                bind(cm, network)
            } catch (e: Exception) {
                Log.w(TAG, "bind failed", e)
                return
            }
            via = want
            Log.i(TAG, if (network != null) "LAN cable in use" else "on Wi-Fi")
            onChange(want)
        }

        lateinit var check: Runnable
        check = Runnable {
            val n = eth ?: return@Runnable
            set(if (reaches(n, target())) n else null)
            handler.removeCallbacks(check)
            handler.postDelayed(check, RECHECK_MS)
        }

        val req = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            // a site LAN often has no internet; it is still the network we want
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                eth = network
                handler.removeCallbacks(check)
                handler.post(check)
            }

            override fun onLost(network: Network) {
                if (network != eth) return
                eth = null
                handler.removeCallbacks(check)
                handler.post { set(null) }
            }
        }
        try {
            cm.registerNetworkCallback(req, callback)
            cb = callback
        } catch (e: Exception) {
            Log.w(TAG, "can't watch the LAN", e)
        }
    }

    /** Can the broker be reached over this network? No broker set yet: yes. */
    private fun reaches(n: Network, hp: Pair<String, Int>?): Boolean {
        if (hp == null) return true
        return try {
            n.socketFactory.createSocket().use { s -> s.connect(InetSocketAddress(n.getByName(hp.first), hp.second), 3000) }
            true
        } catch (e: Exception) {
            Log.i(TAG, "broker ${hp.first}:${hp.second} not reachable over the LAN: ${e.message}")
            false
        }
    }

    /** Android 6+: bindProcessToNetwork; Android 5: its older name. */
    @Suppress("DEPRECATION")
    private fun bind(cm: ConnectivityManager, network: Network?) {
        if (android.os.Build.VERSION.SDK_INT >= 23) cm.bindProcessToNetwork(network)
        else ConnectivityManager.setProcessDefaultNetwork(network)
    }

    fun stop(c: Context) {
        val callback = cb ?: return
        cb = null
        val cm = c.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        try {
            cm.unregisterNetworkCallback(callback)
            bind(cm, null)
        } catch (e: Exception) {
            Log.w(TAG, "stop failed", e)
        }
        h?.removeCallbacksAndMessages(null)
        worker?.quitSafely()
        worker = null
        h = null
        eth = null
        via = "wifi"
    }
}
