package za.co.arsmarthome.nspanel

import android.content.Context
import android.util.Log
import android.webkit.JavascriptInterface
import java.io.BufferedInputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.lang.reflect.Method
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Legacy build: the UI runs in Chrome, which has no `addJavascriptInterface`, so the
 * page reaches [NativeBridge] through this tiny HTTP server, on 127.0.0.1 only.
 *
 *   GET  /app/...         the UI bundled in the APK (assets/app)
 *   GET  /ui/...          the UI copied from Home Assistant (UiCache)
 *   POST /__ar/call?t=    {"m": method, "a": [args]} -> {"v": result}   (sync XHR)
 *   GET  /__ar/events?t=  server-sent events: native -> page (emit / eval)
 *
 * Full screen: the page is an installable web app (manifest, icons, service
 * worker), so Chrome's ⋮ → "Install app" makes a real full-screen app, which
 * ChromeEngine then always opens. Until that's done (or if Chrome only makes a
 * bookmark), the injected script switches the page to full screen on the
 * first tap instead (tab bar, address bar and status bar gone). If Chrome
 * sometimes doesn't stretch the page over where the navigation bar was (a
 * white strip at the bottom), the page leaves full screen and goes back in.
 * Chrome 95 on Android 5 also keeps a stale zoom / visible area after going
 * full screen (the page drawn short, a white strip below, until a two-finger
 * touch); a tiny change of the page's zoom setting makes it recalculate.
 *
 * index.html is only served with the secret token (?t=), and gets a small
 * script put in front of the app that defines `window.ARNative` with exactly
 * the [NativeBridge] methods — so the panel UI is unchanged. Other apps on the
 * panel can't use the bridge: every call needs the token.
 *
 * The port is fixed (18555) so the page keeps the same origin, and with it its
 * localStorage, across restarts.
 */
class LocalBridge(private val ctx: Context, bridge: NativeBridge) {
    private val tag = "ARBridge"
    /** Kept across restarts: Chrome's home-screen shortcut (full screen) starts at a URL with it. */
    val token: String = run {
        val p = ctx.getSharedPreferences("bridge", Context.MODE_PRIVATE)
        p.getString("token", null) ?: ByteArray(16).also { SecureRandom().nextBytes(it) }
            .joinToString("") { "%02x".format(it) }.also { p.edit().putString("token", it).commit() }
    }
    private val methods: Map<String, Method> = bridge.javaClass.methods
        .filter { it.isAnnotationPresent(JavascriptInterface::class.java) }
        .associateBy { it.name }
    private val target: Any = bridge
    private val pool = Executors.newCachedThreadPool()
    private val events = LinkedBlockingDeque<String>(2000)
    private val streamGen = AtomicInteger(0)
    private val server: ServerSocket = openServer()
    val port: Int get() = server.localPort

    private fun openServer(): ServerSocket {
        val lo = InetAddress.getByName("127.0.0.1")
        return try {
            ServerSocket(PORT, 32, lo)
        } catch (e: Exception) {
            Log.w(tag, "port $PORT busy, using a random one (localStorage won't survive restarts)", e)
            ServerSocket(0, 32, lo)
        }.also { it.reuseAddress = true }
    }

    fun start() {
        Thread({
            while (!server.isClosed) {
                val s = try {
                    server.accept()
                } catch (e: Exception) {
                    if (server.isClosed) break else continue
                }
                pool.execute { handle(s) }
            }
        }, "ar-bridge").apply { isDaemon = true }.start()
    }

    fun stop() {
        try {
            server.close()
        } catch (e: Exception) {
        }
        pool.shutdownNow()
    }

    /** URL Chrome loads for a page under /app or /ui. */
    fun pageUrl(path: String): String = "http://127.0.0.1:$port$path?t=$token"

    /** Native -> page: window.__arNative.emit(type, json). */
    fun emit(type: String, json: String) = push("{\"t\":${MiniJson.quote(type)},\"j\":${MiniJson.quote(json)}}")

    /** Native -> page: run this JavaScript. */
    fun eval(js: String) = push("{\"x\":${MiniJson.quote(js)}}")

    private fun push(msg: String) {
        while (!events.offerLast(msg)) events.pollFirst() // full: drop the oldest
    }

    // --- HTTP ----------------------------------------------------------------------------

    private class Req(val method: String, val path: String, val query: Map<String, String>, val body: ByteArray)

    private fun handle(s: Socket) {
        try {
            s.soTimeout = 15000
            val input = BufferedInputStream(s.getInputStream())
            val out = s.getOutputStream()
            val req = read(input) ?: return
            route(req, out)
            out.flush()
        } catch (e: SocketTimeoutException) {
        } catch (e: Exception) {
            Log.w(tag, "request failed: ${e.message}")
        } finally {
            try {
                s.close()
            } catch (e: Exception) {
            }
        }
    }

    private fun read(input: InputStream): Req? {
        val head = readHead(input) ?: return null
        val lines = head.split("\r\n")
        val parts = lines[0].split(" ")
        if (parts.size < 2) return null
        var len = 0
        for (l in lines.drop(1)) {
            val i = l.indexOf(':')
            if (i > 0 && l.substring(0, i).trim().equals("content-length", true)) len = l.substring(i + 1).trim().toIntOrNull() ?: 0
        }
        if (len < 0 || len > 8 * 1024 * 1024) return null
        val body = ByteArray(len)
        var off = 0
        while (off < len) {
            val n = input.read(body, off, len - off)
            if (n < 0) break
            off += n
        }
        val target = parts[1]
        val q = target.indexOf('?')
        val path = if (q >= 0) target.substring(0, q) else target
        val query = HashMap<String, String>()
        if (q >= 0) {
            for (kv in target.substring(q + 1).split('&')) {
                val e = kv.indexOf('=')
                if (e > 0) query[kv.substring(0, e)] = URLDecoder.decode(kv.substring(e + 1), "UTF-8")
            }
        }
        return Req(parts[0].uppercase(), URLDecoder.decode(path, "UTF-8"), query, body)
    }

    private fun readHead(input: InputStream): String? {
        val sb = StringBuilder()
        var last4 = 0
        while (sb.length < 16384) {
            val b = input.read()
            if (b < 0) return null
            sb.append(b.toChar())
            last4 = (last4 shl 8) or b
            if (last4 == 0x0d0a0d0a) return sb.substring(0, sb.length - 4)
        }
        return null
    }

    private fun authed(r: Req) = r.query["t"] == token

    private fun route(r: Req, out: OutputStream) {
        when {
            r.path == "/__ar/call" && r.method == "POST" ->
                if (authed(r)) send(out, 200, "application/json", call(String(r.body, Charsets.UTF_8)).toByteArray()) else send(out, 403, "text/plain", "no".toByteArray())
            // the page isn't full screen: the accessibility helper presses its button
            r.path == "/__ar/autofs" ->
                if (authed(r)) send(out, 200, "text/plain", (if (FullscreenHelper.request()) "1" else "0").toByteArray())
                else send(out, 403, "text/plain", "no".toByteArray())
            r.path == "/__ar/events" ->
                if (authed(r)) stream(out) else send(out, 403, "text/plain", "no".toByteArray())
            // web-app bits so Chrome can open the panel full screen from a home-screen shortcut
            r.method == "GET" && (r.path == "/app/manifest.webmanifest" || r.path == "/ui/manifest.webmanifest") ->
                send(out, 200, "application/manifest+json", manifest(r.path.substringBeforeLast('/')).toByteArray())
            r.method == "GET" && (r.path == "/app/sw.js" || r.path == "/ui/sw.js") ->
                send(out, 200, "application/javascript", SW.toByteArray())
            r.method == "GET" && r.path.endsWith("/ar-icon-192.png") -> send(out, 200, "image/png", icon(192))
            r.method == "GET" && r.path.endsWith("/ar-icon-512.png") -> send(out, 200, "image/png", icon(512))
            r.method == "GET" && r.path.startsWith("/app/") -> file(r, out, asset(r.path.removePrefix("/")))
            r.method == "GET" && r.path.startsWith("/ui/") -> file(r, out, uiFile(r.path.removePrefix("/ui/")))
            else -> send(out, 404, "text/plain", "not found".toByteArray())
        }
    }

    private fun asset(path: String): ByteArray? = try {
        if (path.contains("..")) null else ctx.assets.open(path).use { it.readBytes() }
    } catch (e: Exception) {
        null
    }

    private fun uiFile(path: String): ByteArray? {
        if (path.contains("..")) return null
        val f = File(File(ctx.filesDir, "ui"), path)
        return if (f.isFile) f.readBytes() else null
    }

    private fun file(r: Req, out: OutputStream, bytes: ByteArray?) {
        if (bytes == null) return send(out, 404, "text/plain", "not found".toByteArray())
        if (r.path.endsWith("/index.html") || r.path.endsWith(".html")) {
            // the page is the key to the bridge: only with the token
            if (!authed(r)) return send(out, 403, "text/plain", "no".toByteArray())
            return send(out, 200, "text/html; charset=utf-8", inject(String(bytes, Charsets.UTF_8)).toByteArray(), noCache = true)
        }
        send(out, 200, mime(r.path), bytes)
    }

    private fun inject(html: String): String {
        val names = methods.keys.sorted().joinToString(",") { MiniJson.quote(it) }
        // the panel's real screen size in CSS px: on Android 5 Chrome's screen.height
        // leaves out the navigation bar, so it can't see the strip left where it was
        val dm = android.util.DisplayMetrics()
        (ctx.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager).defaultDisplay.getRealMetrics(dm)
        val d = if (dm.density > 0f) dm.density else 1f
        val js = SHIM.replace("__TOKEN__", token).replace("__METHODS__", names)
            .replace("__REALW__", Math.round(dm.widthPixels / d).toString())
            .replace("__REALH__", Math.round(dm.heightPixels / d).toString())
        val tagged = "<link rel=\"manifest\" href=\"manifest.webmanifest\">" +
            "<meta name=\"theme-color\" content=\"#000000\"><script>$js</script>"
        val i = html.indexOf("<script")
        return if (i >= 0) html.substring(0, i) + tagged + html.substring(i) else html.replace("</body>", "$tagged</body>")
    }

    private fun manifest(dir: String): String =
        "{\"name\":\"AR NSPanel Pro\",\"short_name\":\"AR Panel\"," +
            "\"start_url\":${MiniJson.quote("$dir/index.html?t=$token")},\"scope\":${MiniJson.quote("$dir/")}," +
            "\"display\":\"fullscreen\",\"orientation\":\"any\",\"background_color\":\"#000000\",\"theme_color\":\"#000000\"," +
            "\"icons\":[{\"src\":\"ar-icon-192.png\",\"sizes\":\"192x192\",\"type\":\"image/png\"}," +
            "{\"src\":\"ar-icon-512.png\",\"sizes\":\"512x512\",\"type\":\"image/png\"}]}"

    /** The app's launcher icon drawn at [size] px, as PNG. */
    private fun icon(size: Int): ByteArray {
        val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
        try {
            @Suppress("DEPRECATION")
            val d = ctx.resources.getDrawable(R.drawable.ic_launcher)
            d.setBounds(0, 0, size, size)
            d.draw(android.graphics.Canvas(bmp))
        } catch (e: Exception) {
            bmp.eraseColor(android.graphics.Color.rgb(20, 22, 26))
        }
        val bos = java.io.ByteArrayOutputStream()
        bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, bos)
        return bos.toByteArray()
    }

    private fun mime(p: String): String = when (p.substringAfterLast('.', "").lowercase()) {
        "js" -> "application/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "json" -> "application/json; charset=utf-8"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "mp3" -> "audio/mpeg"
        "wav" -> "audio/wav"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        "wasm" -> "application/wasm"
        else -> "application/octet-stream"
    }

    private fun send(out: OutputStream, code: Int, type: String, body: ByteArray, noCache: Boolean = false) {
        val status = when (code) {
            200 -> "OK"
            403 -> "Forbidden"
            404 -> "Not Found"
            else -> "Error"
        }
        val h = StringBuilder()
            .append("HTTP/1.1 $code $status\r\n")
            .append("Content-Type: $type\r\n")
            .append("Content-Length: ${body.size}\r\n")
            .append(if (noCache) "Cache-Control: no-store\r\n" else "Cache-Control: no-cache\r\n")
            .append("Connection: close\r\n\r\n")
        out.write(h.toString().toByteArray(Charsets.UTF_8))
        out.write(body)
    }

    // --- bridge calls ------------------------------------------------------------------

    private fun call(body: String): String {
        return try {
            val req = MiniJson.parse(body) as? Map<*, *> ?: return err("bad request")
            val name = req["m"] as? String ?: return err("no method")
            val m = methods[name] ?: return err("no such method: $name")
            val raw = (req["a"] as? List<*>) ?: emptyList<Any?>()
            val types = m.parameterTypes
            val args = Array<Any?>(types.size) { i -> convert(raw.getOrNull(i), types[i]) }
            val v = m.invoke(target, *args)
            "{\"v\":" + MiniJson.stringify(if (v is Unit) null else v) + "}"
        } catch (e: java.lang.reflect.InvocationTargetException) {
            Log.w(tag, "bridge call failed", e.targetException)
            err(e.targetException?.toString() ?: "failed")
        } catch (e: Exception) {
            Log.w(tag, "bridge call failed", e)
            err(e.toString())
        }
    }

    private fun err(msg: String) = "{\"e\":${MiniJson.quote(msg)}}"

    /** JSON value -> the Java parameter type (as WebView's bridge would coerce it). */
    private fun convert(v: Any?, t: Class<*>): Any? = when (t) {
        String::class.java -> when (v) {
            null -> ""
            is String -> v
            is Double -> if (v == Math.floor(v) && !v.isInfinite()) v.toLong().toString() else v.toString()
            else -> MiniJson.stringify(v).removeSurrounding("\"")
        }
        java.lang.Boolean.TYPE, java.lang.Boolean::class.java -> when (v) {
            is Boolean -> v
            is Number -> v.toDouble() != 0.0
            is String -> v.isNotEmpty() && v != "false"
            else -> false
        }
        java.lang.Integer.TYPE, java.lang.Integer::class.java -> (v as? Number)?.toInt() ?: (v as? String)?.toDoubleOrNull()?.toInt() ?: 0
        java.lang.Long.TYPE, java.lang.Long::class.java -> (v as? Number)?.toLong() ?: (v as? String)?.toDoubleOrNull()?.toLong() ?: 0L
        java.lang.Float.TYPE, java.lang.Float::class.java -> (v as? Number)?.toFloat() ?: (v as? String)?.toFloatOrNull() ?: 0f
        java.lang.Double.TYPE, java.lang.Double::class.java -> (v as? Number)?.toDouble() ?: (v as? String)?.toDoubleOrNull() ?: 0.0
        else -> v
    }

    // --- events (server-sent) ------------------------------------------------------------

    private fun stream(out: OutputStream) {
        val gen = streamGen.incrementAndGet() // a new page takes over from the old one
        out.write(
            ("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\n" +
                "Connection: keep-alive\r\n\r\nretry: 1000\n\n").toByteArray(),
        )
        out.flush()
        while (gen == streamGen.get()) {
            val msg = events.pollFirst(15, TimeUnit.SECONDS)
            if (gen != streamGen.get()) {
                if (msg != null) events.offerFirst(msg) // for the page that took over
                break
            }
            try {
                out.write((if (msg == null) ": ka\n\n" else "data: $msg\n\n").toByteArray(Charsets.UTF_8))
                out.flush()
            } catch (e: Exception) {
                if (msg != null) events.offerFirst(msg) // not delivered: keep it for the reconnect
                break
            }
        }
    }

    companion object {
        const val PORT = 18555

        /** Service worker: Chrome only offers "Install app" (a real full-screen web
         *  app, no tab) for a page whose service worker answers requests and can
         *  open the start page offline. So it serves the page's own files from the
         *  network, keeping a copy to fall back on; the bridge calls and events
         *  (/__ar/) are never touched. */
        private const val SW = "var C='ar-panel-v1';" +
            "self.addEventListener('install',function(){self.skipWaiting();});" +
            "self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});" +
            "self.addEventListener('fetch',function(e){var r=e.request;" +
            "if(r.method!=='GET'||r.url.indexOf('/__ar/')>=0||r.url.indexOf(self.location.origin)!==0)return;" +
            "e.respondWith(fetch(r).then(function(res){if(res&&res.ok){var c=res.clone();" +
            "caches.open(C).then(function(k){k.put(r,c);});}return res;})" +
            ".catch(function(){return caches.match(r).then(function(m){return m||new Response('',{status:503});});}));});"

        /** window.ARNative over sync XHR, events over EventSource. Plain ES5. */
        private val SHIM = """
(function(){
var T="__TOKEN__",M=[__METHODS__],P=[];
function call(n,a){var x=new XMLHttpRequest();x.open("POST","/__ar/call?t="+T,false);
x.setRequestHeader("Content-Type","text/plain;charset=UTF-8");x.send(JSON.stringify({m:n,a:a}));
if(x.status!==200)throw new Error("ARNative."+n+": HTTP "+x.status);
var r=JSON.parse(x.responseText);if(r.e)throw new Error("ARNative."+n+": "+r.e);return r.v;}
var N={};M.forEach(function(n){N[n]=function(){return call(n,Array.prototype.slice.call(arguments));};});
window.ARNative=N;
function run(m){if(m.x!=null){try{(0,eval)(m.x);}catch(e){console.warn("ARNative eval",e);}return true;}
if(!window.__arNative)return false;window.__arNative.emit(m.t,m.j);return true;}
function flush(){while(P.length&&run(P[0]))P.shift();if(P.length)setTimeout(flush,50);}
var es=new EventSource("/__ar/events?t="+T);
es.onmessage=function(e){var m;try{m=JSON.parse(e.data);}catch(_){return;}P.push(m);flush();};
if(navigator.serviceWorker){try{navigator.serviceWorker.register("sw.js");}catch(_){}}
function fs(){var d=document,e=d.documentElement;if(d.fullscreenElement||d.webkitFullscreenElement)return;
var r=e.requestFullscreen||e.webkitRequestFullscreen;if(!r)return;
try{var q=r.call(e,{navigationUI:"hide"});if(q&&q.catch)q.catch(function(){});}catch(_){}}
["touchend","pointerup","mousedown","click","keydown"].forEach(function(t){window.addEventListener(t,fs,true);});
function isFs(){return !!(document.fullscreenElement||document.webkitFullscreenElement);}
function btn(){if(document.getElementById("ar-fs")||!document.body)return;var b=document.createElement("div");
b.id="ar-fs";b.setAttribute("role","button");b.setAttribute("aria-label","AR full screen");b.tabIndex=0;
b.style.cssText="position:fixed;left:0;bottom:0;width:4px;height:4px;opacity:0.01;z-index:2147483647";
b.addEventListener("click",fs);document.body.appendChild(b);}
function auto(ms){setTimeout(function(){if(isFs())return;btn();
var x=new XMLHttpRequest();x.open("GET","/__ar/autofs?t="+T,true);x.send();},ms);}
window.addEventListener("load",function(){btn();auto(8000);});
document.addEventListener("fullscreenchange",function(){if(!isFs())auto(3000);});
var RW=__REALW__,RH=__REALH__,fixes=0;
function gap(){var w=window.innerWidth,h=window.innerHeight,a=RW||screen.width,b=RH||screen.height;
var full=w>h?Math.min(a,b):Math.max(a,b);return full-h;}
function check(){if(!isFs())return;if(gap()<=6){fixes=0;return;}if(fixes>=3)return;fixes++;var d=document;
var x=d.exitFullscreen||d.webkitExitFullscreen;if(x){try{var q=x.call(d);if(q&&q.catch)q.catch(function(){});}catch(_){}}}
document.addEventListener("fullscreenchange",function(){if(isFs()){setTimeout(check,1500);setTimeout(check,4000);}});
window.addEventListener("resize",function(){setTimeout(check,1500);});setInterval(check,15000);
function nudge(){var m=document.querySelector("meta[name=viewport]");if(!m)return;var c=m.getAttribute("content")||"";
var t=/initial-scale=/.test(c)?c.replace(/initial-scale=[0-9.]+/,"initial-scale=0.9999"):c+",initial-scale=0.9999";
m.setAttribute("content",t);setTimeout(function(){m.setAttribute("content",c);window.scrollTo(0,0);},150);}
function nudges(){[300,1000,2500].forEach(function(ms){setTimeout(nudge,ms);});}
document.addEventListener("fullscreenchange",nudges);
window.addEventListener("resize",function(){setTimeout(nudge,400);});
})();
""".trimIndent().replace("\n", "")
    }
}
