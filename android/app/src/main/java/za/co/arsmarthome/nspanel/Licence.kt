package za.co.arsmarthome.nspanel

/**
 * WIQL1 licence verification — the panel's ONE licence verifier (Home
 * Assistant only stores and delivers the token, it never judges it).
 *
 * Token: `WIQL1.<base64url(payload)>.<base64url(ed25519 signature)>`, issued by
 * the AR Smart Home licence server. The payload is compact JSON with
 * `license_id, product, client, server_id, issued_at, expires_at`.
 *
 * The signature is accepted over any of the byte strings the server is known
 * to sign (the raw payload JSON, or the ASCII `WIQL1.<payload_b64>` prefix) —
 * Ed25519 makes accepting several candidate messages exactly as strong as
 * accepting one.
 *
 * Pure JVM (no android.*), so it is unit-tested off-device.
 */
object Licence {
    const val PRODUCT = "ar_nspanel_pro"

    /** AR Smart Home licence-server signing key (public half; safe to ship). */
    const val PUBLIC_KEY_HEX = "ecb4802e522dc2cc0a820824406ba004d4f70b9afea7e1325095d77309842f25"

    data class Result(
        val valid: Boolean,
        val reason: String,
        val serverId: String,
        val exp: Long? = null,
        val client: String? = null,
        val licenseId: String? = null,
    ) {
        /** The `sys/license` payload the integration's sensor + licence card read. */
        fun toJson(): String {
            val sb = StringBuilder("{")
            sb.append("\"valid\":").append(valid)
            sb.append(",\"reason\":").append(MiniJson.quote(reason))
            sb.append(",\"serial\":").append(MiniJson.quote(serverId))
            sb.append(",\"features\":").append(if (valid) "[\"full\"]" else "[]")
            sb.append(",\"exp\":").append(exp?.toString() ?: "null")
            if (client != null) sb.append(",\"client\":").append(MiniJson.quote(client))
            if (licenseId != null) sb.append(",\"license_id\":").append(MiniJson.quote(licenseId))
            sb.append(",\"product\":").append(MiniJson.quote(PRODUCT))
            sb.append("}")
            return sb.toString()
        }
    }

    fun verify(token: String?, serverId: String, nowSec: Long, publicKeyHex: String = PUBLIC_KEY_HEX): Result {
        val t = token?.trim().orEmpty()
        if (t.isEmpty()) return Result(false, "missing", serverId)
        if (serverId.isEmpty()) return Result(false, "no_serial", serverId)
        val parts = t.split('.')
        if (parts.size != 3 || parts[0] != "WIQL1") return Result(false, "malformed", serverId)
        val payloadBytes = b64url(parts[1]) ?: return Result(false, "malformed", serverId)
        val sig = b64url(parts[2]) ?: return Result(false, "malformed", serverId)
        if (sig.size != 64) return Result(false, "bad_signature", serverId)

        val key = Ed25519.hex(publicKeyHex)
        val candidates = listOf(
            payloadBytes,
            ("WIQL1." + parts[1]).toByteArray(Charsets.US_ASCII),
            parts[1].toByteArray(Charsets.US_ASCII),
        )
        if (candidates.none { Ed25519.verify(key, it, sig) }) return Result(false, "bad_signature", serverId)

        val payload = try {
            MiniJson.parse(String(payloadBytes, Charsets.UTF_8)) as? Map<*, *>
        } catch (e: Exception) {
            null
        } ?: return Result(false, "malformed", serverId)

        val product = payload["product"]?.toString()
        val boundTo = payload["server_id"]?.toString()
        val client = payload["client"]?.toString()
        val licenseId = payload["license_id"]?.toString()
        val exp = expiry(payload["expires_at"], payload["perpetual"])

        if (product != null && !product.equals(PRODUCT, ignoreCase = true)) {
            return Result(false, "wrong_product", serverId, exp, client, licenseId)
        }
        if (boundTo == null || !boundTo.equals(serverId, ignoreCase = true)) {
            return Result(false, "serial_mismatch", serverId, exp, client, licenseId)
        }
        if (exp != null && exp <= nowSec) return Result(false, "expired", serverId, exp, client, licenseId)
        return Result(true, "valid", serverId, exp, client, licenseId)
    }

    /** expires_at as unix seconds; null = perpetual. Accepts seconds, ms or ISO-8601. */
    fun expiry(v: Any?, perpetual: Any?): Long? {
        if (perpetual == true) return null
        return when (v) {
            null -> null
            is Number -> {
                val n = v.toDouble()
                if (n <= 0) null else if (n > 1e11) (n / 1000).toLong() else n.toLong()
            }
            is String -> {
                val s = v.trim()
                if (s.isEmpty() || s.equals("perpetual", true) || s.equals("never", true)) null
                else s.toDoubleOrNull()?.let { expiry(it, null) } ?: parseIso(s)
            }
            else -> null
        }
    }

    /** Minimal ISO-8601: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM]`. */
    fun parseIso(s: String): Long? {
        val m = Regex("""^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$""").find(s) ?: return null
        val g = m.groupValues
        val y = g[1].toInt()
        val mo = g[2].toInt()
        val d = g[3].toInt()
        val hh = g[4].toIntOrNull() ?: 23
        val mi = g[5].toIntOrNull() ?: 59
        val ss = g[6].toIntOrNull() ?: 59
        var epoch = daysFromCivil(y, mo, d) * 86400L + hh * 3600L + mi * 60L + ss
        val tz = g[7]
        if (tz.isNotEmpty() && tz != "Z") {
            val sign = if (tz[0] == '-') -1 else 1
            val digits = tz.substring(1).replace(":", "")
            val off = digits.substring(0, 2).toInt() * 3600 + digits.substring(2, 4).toInt() * 60
            epoch -= sign * off
        }
        return epoch
    }

    /** Howard Hinnant's days_from_civil. */
    private fun daysFromCivil(yIn: Int, m: Int, d: Int): Long {
        val y = if (m <= 2) yIn - 1 else yIn
        val era = (if (y >= 0) y else y - 399) / 400
        val yoe = y - era * 400
        val doy = (153 * (m + (if (m > 2) -3 else 9)) + 2) / 5 + d - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097L + doe - 719468L
    }

    fun b64url(s: String): ByteArray? {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        val clean = s.trim().replace('+', '-').replace('/', '_').trimEnd('=')
        val out = java.io.ByteArrayOutputStream()
        var buf = 0
        var bits = 0
        for (c in clean) {
            val v = alphabet.indexOf(c)
            if (v < 0) return null
            buf = (buf shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buf shr bits) and 0xff)
            }
        }
        return out.toByteArray()
    }
}

/** Just enough JSON for licence payloads and small bridge messages. */
object MiniJson {
    fun quote(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c < ' ') sb.append(String.format("\\u%04x", c.code)) else sb.append(c)
            }
        }
        return sb.append('"').toString()
    }

    fun parse(s: String): Any? {
        val p = Parser(s)
        val v = p.value()
        p.ws()
        if (p.i != s.length) throw IllegalArgumentException("trailing data")
        return v
    }

    private class Parser(val s: String) {
        var i = 0
        fun ws() {
            while (i < s.length && s[i].isWhitespace()) i++
        }
        fun value(): Any? {
            ws()
            if (i >= s.length) throw IllegalArgumentException("eof")
            return when (s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> lit("true", true)
                'f' -> lit("false", false)
                'n' -> lit("null", null)
                else -> num()
            }
        }
        fun lit(w: String, v: Any?): Any? {
            if (!s.startsWith(w, i)) throw IllegalArgumentException("bad literal")
            i += w.length
            return v
        }
        fun num(): Number {
            val st = i
            while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
            val t = s.substring(st, i)
            return t.toLongOrNull() ?: t.toDouble()
        }
        fun str(): String {
            i++
            val sb = StringBuilder()
            while (true) {
                if (i >= s.length) throw IllegalArgumentException("unterminated string")
                val c = s[i++]
                if (c == '"') return sb.toString()
                if (c != '\\') {
                    sb.append(c)
                    continue
                }
                when (val e = s[i++]) {
                    'n' -> sb.append('\n')
                    't' -> sb.append('\t')
                    'r' -> sb.append('\r')
                    'b' -> sb.append('\b')
                    'f' -> sb.append('\u000c')
                    'u' -> {
                        sb.append(s.substring(i, i + 4).toInt(16).toChar())
                        i += 4
                    }
                    else -> sb.append(e)
                }
            }
        }
        fun obj(): Map<String, Any?> {
            i++
            val m = LinkedHashMap<String, Any?>()
            ws()
            if (s[i] == '}') {
                i++
                return m
            }
            while (true) {
                ws()
                val k = str()
                ws()
                if (s[i++] != ':') throw IllegalArgumentException("expected :")
                m[k] = value()
                ws()
                when (s[i++]) {
                    ',' -> continue
                    '}' -> return m
                    else -> throw IllegalArgumentException("expected , or }")
                }
            }
        }
        fun arr(): List<Any?> {
            i++
            val l = ArrayList<Any?>()
            ws()
            if (s[i] == ']') {
                i++
                return l
            }
            while (true) {
                l.add(value())
                ws()
                when (s[i++]) {
                    ',' -> continue
                    ']' -> return l
                    else -> throw IllegalArgumentException("expected , or ]")
                }
            }
        }
    }
}
