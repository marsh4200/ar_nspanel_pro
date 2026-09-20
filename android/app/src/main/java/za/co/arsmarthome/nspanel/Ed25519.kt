package za.co.arsmarthome.nspanel

import java.math.BigInteger
import java.security.MessageDigest

/**
 * Ed25519 signature VERIFICATION (RFC 8032 §5.1.7), pure JVM.
 *
 * The NSPanel Pro runs Android 8.1, whose crypto providers have no Ed25519,
 * and this app deliberately carries no third-party libraries — so this is a
 * small port of the RFC's reference implementation on BigInteger, using
 * extended homogeneous coordinates. It runs once per licence check, so speed
 * is irrelevant; correctness is covered by the RFC 8032 test vectors (see
 * android/test/Ed25519Test.kt).
 */
object Ed25519 {
    private val P: BigInteger = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19))
    private val L: BigInteger = BigInteger.ONE.shiftLeft(252).add(BigInteger("27742317777372353535851937790883648493"))
    private val D: BigInteger = BigInteger.valueOf(-121665).multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P)
    private val SQRT_M1: BigInteger = BigInteger.valueOf(2).modPow(P.subtract(BigInteger.ONE).shiftRight(2), P)
    private val TWO = BigInteger.valueOf(2)

    /** Point in extended coordinates (X, Y, Z, T), x = X/Z, y = Y/Z, xy = T/Z. */
    private class Pt(val x: BigInteger, val y: BigInteger, val z: BigInteger, val t: BigInteger)

    private val G: Pt by lazy {
        val gy = BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P)
        val gx = recoverX(gy, 0) ?: error("bad base point")
        Pt(gx, gy, BigInteger.ONE, gx.multiply(gy).mod(P))
    }

    private fun add(p: Pt, q: Pt): Pt {
        val a = p.y.subtract(p.x).multiply(q.y.subtract(q.x)).mod(P)
        val b = p.y.add(p.x).multiply(q.y.add(q.x)).mod(P)
        val c = TWO.multiply(p.t).multiply(q.t).multiply(D).mod(P)
        val d = TWO.multiply(p.z).multiply(q.z).mod(P)
        val e = b.subtract(a)
        val f = d.subtract(c)
        val g = d.add(c)
        val h = b.add(a)
        return Pt(e.multiply(f).mod(P), g.multiply(h).mod(P), f.multiply(g).mod(P), e.multiply(h).mod(P))
    }

    private fun mul(sIn: BigInteger, pIn: Pt): Pt {
        var s = sIn
        var p = pIn
        var q = Pt(BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO)
        while (s.signum() > 0) {
            if (s.testBit(0)) q = add(q, p)
            p = add(p, p)
            s = s.shiftRight(1)
        }
        return q
    }

    private fun equal(p: Pt, q: Pt): Boolean {
        if (p.x.multiply(q.z).subtract(q.x.multiply(p.z)).mod(P).signum() != 0) return false
        return p.y.multiply(q.z).subtract(q.y.multiply(p.z)).mod(P).signum() == 0
    }

    private fun recoverX(y: BigInteger, sign: Int): BigInteger? {
        if (y >= P) return null
        val y2 = y.multiply(y).mod(P)
        val x2 = y2.subtract(BigInteger.ONE).multiply(D.multiply(y2).add(BigInteger.ONE).modInverse(P)).mod(P)
        if (x2.signum() == 0) return if (sign != 0) null else BigInteger.ZERO
        var x = x2.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P)
        if (x.multiply(x).subtract(x2).mod(P).signum() != 0) x = x.multiply(SQRT_M1).mod(P)
        if (x.multiply(x).subtract(x2).mod(P).signum() != 0) return null
        if ((if (x.testBit(0)) 1 else 0) != sign) x = P.subtract(x)
        return x
    }

    /** Little-endian bytes -> non-negative BigInteger. */
    private fun le(bytes: ByteArray): BigInteger {
        val be = bytes.reversedArray()
        return BigInteger(1, be)
    }

    private fun decompress(s: ByteArray): Pt? {
        if (s.size != 32) return null
        val copy = s.copyOf()
        val sign = (copy[31].toInt() ushr 7) and 1
        copy[31] = (copy[31].toInt() and 0x7f).toByte()
        val y = le(copy)
        val x = recoverX(y, sign) ?: return null
        return Pt(x, y, BigInteger.ONE, x.multiply(y).mod(P))
    }

    private fun sha512modL(vararg parts: ByteArray): BigInteger {
        val md = MessageDigest.getInstance("SHA-512")
        for (p in parts) md.update(p)
        return le(md.digest()).mod(L)
    }

    fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        if (publicKey.size != 32 || signature.size != 64) return false
        val a = decompress(publicKey) ?: return false
        val rs = signature.copyOfRange(0, 32)
        val r = decompress(rs) ?: return false
        val s = le(signature.copyOfRange(32, 64))
        if (s >= L) return false
        val h = sha512modL(rs, publicKey, message)
        val sB = mul(s, G)
        val hA = mul(h, a)
        return equal(sB, add(r, hA))
    }

    fun hex(s: String): ByteArray {
        val clean = s.trim()
        require(clean.length % 2 == 0) { "odd hex length" }
        return ByteArray(clean.length / 2) { i -> clean.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }
}
