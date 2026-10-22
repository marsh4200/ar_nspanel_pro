package za.co.arsmarthome.nspanel

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/**
 * Keeps the panel reachable over ADB and finds which port ADB is on.
 *
 * Some panels (the HDL Source 10) switch network ADB off or move it the moment
 * another app takes over. The setup screen can then show where ADB is right now
 * (a local port scan that only counts real ADB endpoints), turn debugging back
 * on, and open Developer options / Wireless debugging.
 *
 * Turning debugging on needs WRITE_SECURE_SETTINGS, which Home Assistant's
 * installer grants over ADB (`pm grant`); without it those calls are no-ops.
 */
object AdbHelper {

    private const val ADB_ENABLED = "adb_enabled"
    private const val ADB_WIFI_ENABLED = "adb_wifi_enabled"
    private const val A_CNXN = 0x4e584e43
    private const val A_AUTH = 0x48545541
    private const val A_STLS = 0x534c5453

    fun canWriteSecure(ctx: Context): Boolean =
        ctx.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED

    fun status(ctx: Context): Map<String, Any?> {
        val cr = ctx.contentResolver
        return linkedMapOf(
            "usbDebugging" to (Settings.Global.getInt(cr, ADB_ENABLED, 0) == 1),
            "wirelessDebugging" to (Settings.Global.getInt(cr, ADB_WIFI_ENABLED, 0) == 1),
            "canEnable" to canWriteSecure(ctx),
        )
    }

    /** Switch USB debugging (which also carries network ADB) back on. */
    fun enable(ctx: Context, wireless: Boolean): Boolean {
        if (!canWriteSecure(ctx)) return false
        return try {
            val cr = ctx.contentResolver
            Settings.Global.putInt(cr, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 1)
            Settings.Global.putInt(cr, ADB_ENABLED, 1)
            if (wireless) Settings.Global.putInt(cr, ADB_WIFI_ENABLED, 1)
            true
        } catch (e: Exception) {
            false
        }
    }

    private var observer: ContentObserver? = null

    /**
     * While the app runs, put debugging straight back on if something turns it
     * off (HDL does on the Source 10). Only works once WRITE_SECURE_SETTINGS
     * has been granted.
     */
    fun keepOn(ctx: Context) {
        if (!canWriteSecure(ctx)) return
        val app = ctx.applicationContext
        enable(app, false)
        if (observer != null) return
        val obs = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                if (Settings.Global.getInt(app.contentResolver, ADB_ENABLED, 0) != 1) enable(app, false)
            }
        }
        app.contentResolver.registerContentObserver(Settings.Global.getUriFor(ADB_ENABLED), false, obs)
        observer = obs
    }

    /** Open Wireless debugging (or Developer options, or Settings) on the panel. */
    fun openSettings(ctx: Context): Boolean {
        val tries = listOf(
            Intent().setComponent(ComponentName("com.android.settings", "com.android.settings.Settings\$AdbWirelessDebuggingActivity")),
            Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS),
            Intent(Settings.ACTION_SETTINGS),
        )
        for (i in tries) {
            try {
                ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return true
            } catch (e: ActivityNotFoundException) {
            } catch (e: SecurityException) {
            }
        }
        return false
    }

    /**
     * Ports on this device where ADB answers: 5555, 8555 and the ephemeral
     * range Wireless debugging picks from. A port only counts when it replies
     * to an ADB handshake with CNXN, AUTH or STLS (TLS = Wireless debugging),
     * so the panel's MQTT broker and other servers are ignored.
     */
    fun findPorts(): List<Map<String, Any>> {
        val candidates = ArrayList<Int>()
        candidates.add(5555)
        candidates.add(8555)
        for (p in 30000..60999) candidates.add(p)
        val pool = Executors.newFixedThreadPool(64)
        try {
            val open = candidates.map { p -> p to pool.submit<Boolean> { isOpen(p) } }
            val found = ArrayList<Map<String, Any>>()
            for ((p, f) in open) {
                if (!getQuiet(f)) continue
                val kind = adbKind(p) ?: continue
                found.add(linkedMapOf("port" to p, "kind" to kind))
            }
            return found
        } finally {
            pool.shutdownNow()
        }
    }

    private fun getQuiet(f: Future<Boolean>): Boolean = try {
        f.get(5, TimeUnit.SECONDS)
    } catch (e: Exception) {
        false
    }

    private fun isOpen(port: Int): Boolean = try {
        Socket().use { s ->
            s.connect(InetSocketAddress("127.0.0.1", port), 150)
            true
        }
    } catch (e: Exception) {
        false
    }

    /** "adb" (plain, e.g. 5555/8555), "tls" (Wireless debugging) or null. */
    private fun adbKind(port: Int): String? = try {
        Socket().use { s ->
            s.connect(InetSocketAddress("127.0.0.1", port), 300)
            s.soTimeout = 600
            val banner = "host::\u0000".toByteArray()
            val hdr = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN)
            hdr.putInt(A_CNXN).putInt(0x01000001).putInt(256 * 1024).putInt(banner.size)
                .putInt(banner.sumOf { it.toInt() and 0xff }).putInt(A_CNXN.inv())
            s.getOutputStream().apply { write(hdr.array()); write(banner); flush() }
            val reply = readFully(s.getInputStream(), 24) ?: return null
            when (ByteBuffer.wrap(reply).order(ByteOrder.LITTLE_ENDIAN).int) {
                A_STLS -> "tls"
                A_CNXN, A_AUTH -> "adb"
                else -> null
            }
        }
    } catch (e: Exception) {
        null
    }

    private fun readFully(input: InputStream, n: Int): ByteArray? {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = input.read(buf, off, n - off)
            if (r < 0) return null
            off += r
        }
        return buf
    }
}
