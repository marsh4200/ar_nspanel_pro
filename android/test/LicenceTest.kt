// Off-device test for Ed25519 + WIQL1 licence verification.
//   python3 gen_vectors.py && kotlinc ../app/src/main/java/za/co/arsmarthome/nspanel/{Ed25519,Licence}.kt LicenceTest.kt -include-runtime -d t.jar && java -jar t.jar vectors.txt
import za.co.arsmarthome.nspanel.Ed25519
import za.co.arsmarthome.nspanel.Licence
import java.io.File

fun main(args: Array<String>) {
    var pass = 0
    var fail = 0
    // RFC 8032 §7.1 test vector 1 (empty message)
    val rfcOk = Ed25519.verify(
        Ed25519.hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
        ByteArray(0),
        Ed25519.hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
    )
    if (rfcOk) pass++ else { fail++; println("FAIL rfc8032 test 1") }
    val now = System.currentTimeMillis() / 1000
    for (line in File(args[0]).readLines()) {
        if (line.isBlank()) continue
        val f = line.split(" ")
        if (f[0] == "ED") {
            val msg = if (f[2] == "-") ByteArray(0) else Ed25519.hex(f[2])
            val got = Ed25519.verify(Ed25519.hex(f[1]), msg, Ed25519.hex(f[3]))
            val want = f[4] == "ok"
            if (got == want) pass++ else { fail++; println("FAIL $line") }
        } else if (f[0] == "LIC") {
            val tok = if (f[4] == "-") "" else f[4]
            val r = Licence.verify(tok, f[3], now, f[2])
            if (r.reason == f[5]) pass++ else { fail++; println("FAIL ${f[1]}: got ${r.reason} want ${f[5]}") }
            if (f[1] == "valid_iso") println("sample sys/license: " + r.toJson())
        }
    }
    println("passed $pass, failed $fail")
    if (fail > 0) System.exit(1)
}
