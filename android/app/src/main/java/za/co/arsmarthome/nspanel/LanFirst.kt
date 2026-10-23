package za.co.arsmarthome.nspanel

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log

/**
 * LAN cable first. When the panel has a network cable plugged in, the whole
 * app (the page, MQTT, cameras) talks over the cable, even with Wi-Fi also
 * connected, and even when the LAN has no internet: Android on its own
 * would then keep using Wi-Fi, because it calls a LAN without internet
 * "not validated". Unplug the cable and it falls back to Wi-Fi.
 */
object LanFirst {
    private const val TAG = "ARLan"

    /** "lan" while the cable is in use, else "wifi". */
    @Volatile
    var via: String = "wifi"
        private set

    private var cb: ConnectivityManager.NetworkCallback? = null
    private var eth: Network? = null

    fun start(c: Context, onChange: (String) -> Unit) {
        if (cb != null) return
        val cm = c.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val req = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            // a site LAN often has no internet; it is still the network we want
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                eth = network
                try {
                    cm.bindProcessToNetwork(network)
                } catch (e: Exception) {
                    Log.w(TAG, "bind to LAN failed", e)
                    return
                }
                via = "lan"
                Log.i(TAG, "LAN cable in use")
                onChange("lan")
            }

            override fun onLost(network: Network) {
                if (network != eth) return
                eth = null
                try {
                    cm.bindProcessToNetwork(null)
                } catch (e: Exception) {
                    Log.w(TAG, "unbind failed", e)
                }
                via = "wifi"
                Log.i(TAG, "LAN cable gone, back on Wi-Fi")
                onChange("wifi")
            }
        }
        try {
            cm.registerNetworkCallback(req, callback)
            cb = callback
        } catch (e: Exception) {
            Log.w(TAG, "can't watch the LAN", e)
        }
    }

    fun stop(c: Context) {
        val callback = cb ?: return
        cb = null
        val cm = c.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        try {
            cm.unregisterNetworkCallback(callback)
            cm.bindProcessToNetwork(null)
        } catch (e: Exception) {
            Log.w(TAG, "stop failed", e)
        }
        eth = null
        via = "wifi"
    }
}
