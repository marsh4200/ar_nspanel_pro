package za.co.arsmarthome.nspanel

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.math.BigInteger
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec

/**
 * A tiny ADB client that talks to the panel's OWN adbd over 127.0.0.1.
 *
 * Why: an app can't switch another app back on (`pm enable`), but the ADB
 * shell can. When Home Assistant can't reach the panel any more, the panel's
 * "Back to Shelly screen" button connects to itself over ADB and runs the
 * restore commands as the shell user, with nobody needing a computer.
 *
 * The first connection shows Android's own "Allow USB debugging?" prompt ON
 * THE PANEL (this app's key). Tap "Always allow" once; from then on it
 * connects without asking. Nothing here needs root.
 *
 * Plain JVM code (no Android classes), so it is tested off the device.
 * Only plain-TCP adbd (5555, `adb tcpip`) is spoken; Android 11's Wireless
 * debugging (TLS, port 3xxxx-4xxxx) needs pairing and is reported as "tls".
 */
object LocalAdb {
    private const val A_CNXN = 0x4e584e43
    private const val A_AUTH = 0x48545541
    private const val A_OPEN = 0x4e45504f
    private const val A_OKAY = 0x59414b4f
    private const val A_CLSE = 0x45534c43
    private const val A_WRTE = 0x45545257
    private const val A_STLS = 0x534c5453
    private const val AUTH_TOKEN = 1
    private const val AUTH_SIGNATURE = 2
    private const val AUTH_RSAPUBLICKEY = 3
    /** Version with checksums: every adbd accepts it. */
    private const val VERSION = 0x01000000
    private const val MAX_DATA = 4096
    private const val KEY_BITS = 2048
    private const val KEY_NAME = "ar-panel@localhost"

    /** SHA-1 DigestInfo prefix: adbd verifies the token as if it were a SHA-1 hash. */
    private val SHA1_PREFIX = byteArrayOf(
        0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14,
    )

    class Result(val ok: Boolean, val output: String, val error: String? = null) {
        override fun toString(): String = if (ok) output else "error: $error"
    }

    // --- key ------------------------------------------------------------------------

    /** This app's ADB key, made once and kept in [dir] (the app's private files). */
    fun keyPair(dir: File): KeyPair {
        val privF = File(dir, "localadb.key")
        val pubF = File(dir, "localadb.pub")
        if (privF.exists() && pubF.exists()) {
            try {
                val kf = KeyFactory.getInstance("RSA")
                return KeyPair(
                    kf.generatePublic(X509EncodedKeySpec(pubF.readBytes())),
                    kf.generatePrivate(PKCS8EncodedKeySpec(privF.readBytes())),
                )
            } catch (e: Exception) {
                // damaged: make a new one (the panel will ask "Allow USB debugging?" again)
            }
        }
        val g = KeyPairGenerator.getInstance("RSA")
        g.initialize(KEY_BITS)
        val kp = g.generateKeyPair()
        privF.writeBytes(kp.private.encoded)
        pubF.writeBytes(kp.public.encoded)
        return kp
    }

    /**
     * The public key the way adbd stores it (/data/misc/adb/adb_keys): Android's
     * RSAPublicKey struct, base64, a space, a name, then NUL.
     */
    fun publicKeyBlob(pub: RSAPublicKey): ByteArray {
        val n = pub.modulus
        val bytes = KEY_BITS / 8
        val r32 = BigInteger.ONE.shiftLeft(32)
        val n0inv = r32.subtract(n.mod(r32).modInverse(r32)).mod(r32) // -1/n[0] mod 2^32
        val rr = BigInteger.ONE.shiftLeft(KEY_BITS * 2).mod(n) // (2^2048)^2 mod n
        val b = ByteBuffer.allocate(4 + 4 + bytes + bytes + 4).order(ByteOrder.LITTLE_ENDIAN)
        b.putInt(bytes / 4)
        b.putInt(n0inv.toLong().toInt())
        b.put(littleEndian(n, bytes))
        b.put(littleEndian(rr, bytes))
        b.putInt(pub.publicExponent.toInt())
        val text = base64(b.array()) + " " + KEY_NAME
        return text.toByteArray(Charsets.US_ASCII) + byteArrayOf(0)
    }

    /** PKCS#1 v1.5 signature of the 20-byte token as a SHA-1 digest (what adbd checks). */
    fun sign(priv: RSAPrivateKey, token: ByteArray): ByteArray {
        val k = (priv.modulus.bitLength() + 7) / 8
        val t = SHA1_PREFIX + token
        val em = ByteArray(k)
        em[0] = 0
        em[1] = 1
        val padEnd = k - t.size - 1
        for (i in 2 until padEnd) em[i] = 0xff.toByte()
        em[padEnd] = 0
        System.arraycopy(t, 0, em, padEnd + 1, t.size)
        val s = BigInteger(1, em).modPow(priv.privateExponent, priv.modulus)
        return fixedLength(s, k)
    }

    // --- protocol --------------------------------------------------------------------

    /**
     * Run [command] in an ADB shell on this device. Tries each port in [ports]
     * (127.0.0.1). [authWaitMs]: how long to wait for someone to tap "Allow"
     * on the panel the first time.
     */
    fun shell(dir: File, command: String, ports: List<Int>, authWaitMs: Int = 60_000, readMs: Int = 30_000): Result {
        val kp = try {
            keyPair(dir)
        } catch (e: Exception) {
            return Result(false, "", "no key: ${e.message}")
        }
        var last = "ADB isn't listening on this panel (ports ${ports.joinToString()})"
        for (port in ports.distinct()) {
            val r = try {
                Socket().use { s ->
                    s.connect(InetSocketAddress("127.0.0.1", port), 800)
                    s.tcpNoDelay = true
                    runOn(s, kp, command, authWaitMs, readMs)
                }
            } catch (e: java.net.ConnectException) {
                null // nothing on this port
            } catch (e: SocketTimeoutException) {
                Result(false, "", "port $port: timed out (was “Allow USB debugging?” answered on the panel?)")
            } catch (e: Exception) {
                Result(false, "", "port $port: ${e.javaClass.simpleName}: ${e.message}")
            }
            if (r == null) continue
            if (r.ok) return r
            last = r.error ?: last
        }
        return Result(false, "", last)
    }

    /**
     * Run a long-lived [command] (e.g. `getevent -l`) and hand each output line
     * to [onLine] until it ends, [keepGoing] turns false, or the connection
     * drops. Returns why it stopped. Blocking: call it on its own thread.
     */
    fun stream(dir: File, command: String, ports: List<Int>, keepGoing: () -> Boolean, onLine: (String) -> Unit): String {
        val kp = try {
            keyPair(dir)
        } catch (e: Exception) {
            return "no key: ${e.message}"
        }
        var last = "ADB isn't listening on this panel"
        for (port in ports.distinct()) {
            try {
                Socket().use { s ->
                    s.connect(InetSocketAddress("127.0.0.1", port), 800)
                    s.tcpNoDelay = true
                    val err = connect(s, kp, 60_000)
                    if (err != null) return err
                    val out = s.getOutputStream()
                    val inp = s.getInputStream()
                    s.soTimeout = 2000 // wake up now and then to check keepGoing
                    val localId = 1
                    write(out, A_OPEN, localId, 0, "shell:$command\u0000".toByteArray())
                    val pending = StringBuilder()
                    while (keepGoing()) {
                        val p = try {
                            read(inp)
                        } catch (e: SocketTimeoutException) {
                            continue
                        } ?: return "ADB closed the connection"
                        when (p.cmd) {
                            A_WRTE -> {
                                write(out, A_OKAY, localId, p.arg0, ByteArray(0))
                                pending.append(String(p.data, Charsets.UTF_8))
                                var nl = pending.indexOf("\n")
                                while (nl >= 0) {
                                    onLine(pending.substring(0, nl).trimEnd('\r'))
                                    pending.delete(0, nl + 1)
                                    nl = pending.indexOf("\n")
                                }
                            }
                            A_CLSE -> return "the command ended"
                        }
                    }
                    return "stopped"
                }
            } catch (e: java.net.ConnectException) {
                continue
            } catch (e: Exception) {
                last = "port $port: ${e.javaClass.simpleName}: ${e.message}"
            }
        }
        return last
    }

    /** Handshake + auth on a fresh socket; null when connected, else why not. */
    private fun connect(s: Socket, kp: KeyPair, authWaitMs: Int): String? {
        val out = s.getOutputStream()
        val inp = s.getInputStream()
        s.soTimeout = 5000
        write(out, A_CNXN, VERSION, MAX_DATA, "host::\u0000".toByteArray())
        var sentSig = false
        var sentKey = false
        while (true) {
            val p = read(inp) ?: return "ADB closed the connection"
            when (p.cmd) {
                A_CNXN -> return null
                A_STLS -> return "tls"
                A_AUTH -> {
                    if (p.arg0 != AUTH_TOKEN) return "unexpected AUTH ${p.arg0}"
                    if (!sentSig) {
                        sentSig = true
                        write(out, A_AUTH, AUTH_SIGNATURE, 0, sign(kp.private as RSAPrivateKey, p.data))
                    } else if (!sentKey) {
                        sentKey = true
                        write(out, A_AUTH, AUTH_RSAPUBLICKEY, 0, publicKeyBlob(kp.public as RSAPublicKey))
                        s.soTimeout = authWaitMs
                    } else {
                        return "the panel refused this app's ADB key"
                    }
                }
                else -> {}
            }
        }
    }

    private fun runOn(s: Socket, kp: KeyPair, command: String, authWaitMs: Int, readMs: Int): Result {
        val out = s.getOutputStream()
        val inp = s.getInputStream()
        s.soTimeout = 5000
        write(out, A_CNXN, VERSION, MAX_DATA, "host::\u0000".toByteArray())
        var sentSig = false
        var sentKey = false
        while (true) {
            val p = read(inp) ?: return Result(false, "", "ADB closed the connection")
            when (p.cmd) {
                A_CNXN -> break
                A_STLS -> return Result(false, "", "tls")
                A_AUTH -> {
                    if (p.arg0 != AUTH_TOKEN) return Result(false, "", "unexpected AUTH ${p.arg0}")
                    if (!sentSig) {
                        sentSig = true
                        write(out, A_AUTH, AUTH_SIGNATURE, 0, sign(kp.private as RSAPrivateKey, p.data))
                    } else if (!sentKey) {
                        // key not known yet: the panel shows "Allow USB debugging?"
                        sentKey = true
                        write(out, A_AUTH, AUTH_RSAPUBLICKEY, 0, publicKeyBlob(kp.public as RSAPublicKey))
                        s.soTimeout = authWaitMs
                    } else {
                        return Result(false, "", "the panel refused this app's ADB key")
                    }
                }
                else -> {} // ignore anything else before CNXN
            }
        }
        s.soTimeout = readMs
        val localId = 1
        write(out, A_OPEN, localId, 0, "shell:$command\u0000".toByteArray())
        val buf = ByteArrayOutputStream()
        var remoteId = 0
        while (true) {
            val p = read(inp) ?: break
            when (p.cmd) {
                A_OKAY -> remoteId = p.arg0
                A_WRTE -> {
                    buf.write(p.data)
                    remoteId = p.arg0
                    write(out, A_OKAY, localId, remoteId, ByteArray(0))
                }
                A_CLSE -> {
                    if (remoteId == 0 && buf.size() == 0) return Result(false, "", "ADB refused the shell")
                    try {
                        write(out, A_CLSE, localId, p.arg0, ByteArray(0))
                    } catch (e: Exception) {
                    }
                    break
                }
            }
        }
        return Result(true, buf.toString("UTF-8"))
    }

    private class Packet(val cmd: Int, val arg0: Int, val arg1: Int, val data: ByteArray)

    private fun write(out: OutputStream, cmd: Int, arg0: Int, arg1: Int, data: ByteArray) {
        val h = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN)
        var sum = 0
        for (x in data) sum += x.toInt() and 0xff
        h.putInt(cmd).putInt(arg0).putInt(arg1).putInt(data.size).putInt(sum).putInt(cmd.inv())
        out.write(h.array())
        if (data.isNotEmpty()) out.write(data)
        out.flush()
    }

    private fun read(inp: InputStream): Packet? {
        val h = readFully(inp, 24) ?: return null
        val b = ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN)
        val cmd = b.int
        val a0 = b.int
        val a1 = b.int
        val len = b.int
        if (len < 0 || len > 1024 * 1024) throw IllegalStateException("bad ADB packet length $len")
        val data = if (len > 0) readFully(inp, len) ?: return null else ByteArray(0)
        return Packet(cmd, a0, a1, data)
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

    // --- helpers -------------------------------------------------------------------------

    private fun fixedLength(v: BigInteger, len: Int): ByteArray {
        val raw = v.toByteArray() // big-endian, maybe with a leading 0
        val outB = ByteArray(len)
        val copy = minOf(raw.size, len)
        System.arraycopy(raw, raw.size - copy, outB, len - copy, copy)
        return outB
    }

    private fun littleEndian(v: BigInteger, len: Int): ByteArray = fixedLength(v, len).reversedArray()

    private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

    /** Standard base64 (android.util.Base64 isn't on the JVM; java.util's needs Android 8). */
    fun base64(d: ByteArray): String {
        val sb = StringBuilder((d.size + 2) / 3 * 4)
        var i = 0
        while (i < d.size) {
            val b0 = d[i].toInt() and 0xff
            val b1 = if (i + 1 < d.size) d[i + 1].toInt() and 0xff else 0
            val b2 = if (i + 2 < d.size) d[i + 2].toInt() and 0xff else 0
            sb.append(B64[b0 shr 2])
            sb.append(B64[((b0 and 3) shl 4) or (b1 shr 4)])
            sb.append(if (i + 1 < d.size) B64[((b1 and 15) shl 2) or (b2 shr 6)] else '=')
            sb.append(if (i + 2 < d.size) B64[b2 and 63] else '=')
            i += 3
        }
        return sb.toString()
    }
}
