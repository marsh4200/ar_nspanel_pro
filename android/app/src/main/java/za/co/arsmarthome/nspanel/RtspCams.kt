package za.co.arsmarthome.nspanel

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.TextureView
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.decoder.DecoderInputBuffer
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import androidx.media3.exoplayer.rtsp.RtspMediaSource
import androidx.media3.exoplayer.video.MediaCodecVideoRenderer
import androidx.media3.exoplayer.video.VideoRendererEventListener

/**
 * The video decoder gets nothing before the stream's first keyframe.
 *
 * An RTSP stream is joined wherever the camera is in its picture group, so the
 * first frames refer to a keyframe the panel never received. Rockchip hardware
 * decoders (px30, RK3566) turn those into green pictures until the next keyframe
 * comes, seconds later on most cameras. Skipping them means the first picture
 * decoded is a whole one. The RTSP H.264 / H.265 readers mark IDR frames as keyframes.
 */
@UnstableApi
private class KeyframeFirstVideoRenderer(
    context: Context,
    selector: MediaCodecSelector,
    joiningMs: Long,
    fallback: Boolean,
    handler: Handler?,
    listener: VideoRendererEventListener?,
) : MediaCodecVideoRenderer(context, selector, joiningMs, fallback, handler, listener, 50) {
    private var seenKeyframe = false

    override fun shouldSkipDecoderInputBuffer(buffer: DecoderInputBuffer): Boolean {
        if (!seenKeyframe) {
            if (!buffer.isKeyFrame) return true
            seenKeyframe = true
        }
        return super.shouldSkipDecoderInputBuffer(buffer)
    }
}

/**
 * Which video decoder cameras use (Settings > Panel > Camera decoder on the panel):
 * "auto" = Android's first choice; "alt" = the next hardware decoder first;
 * "soft" = the software decoder first. Some panels' default H.265 hardware decoder
 * (HDL Source 10, RK3568) shows green / stale pictures on a stream other panels
 * play cleanly. If the chosen decoder can't start, the next one is tried.
 */
@UnstableApi
private fun cameraSelector(mode: String): MediaCodecSelector = MediaCodecSelector { mime, secure, tunneling ->
    val all: List<MediaCodecInfo> = MediaCodecSelector.DEFAULT.getDecoderInfos(mime, secure, tunneling)
    val hw = all.filter { !it.softwareOnly }
    val sw = all.filter { it.softwareOnly }
    when (mode) {
        "alt" -> if (hw.size > 1) hw.drop(1) + hw.take(1) + sw else sw + hw
        "soft" -> sw + hw
        else -> all
    }
}

@UnstableApi
private class CameraRenderers(context: Context, private val mode: String) : DefaultRenderersFactory(context) {
    init {
        setEnableDecoderFallback(true)
    }

    override fun buildVideoRenderers(
        context: Context,
        extensionRendererMode: Int,
        mediaCodecSelector: MediaCodecSelector,
        enableDecoderFallback: Boolean,
        eventHandler: Handler,
        eventListener: VideoRendererEventListener,
        allowedVideoJoiningTimeMs: Long,
        out: ArrayList<Renderer>,
    ) {
        val selector = if (mode == "auto") mediaCodecSelector else cameraSelector(mode)
        out.add(KeyframeFirstVideoRenderer(context, selector, allowedVideoJoiningTimeMs, enableDecoderFallback, eventHandler, eventListener))
    }
}

/**
 * RTSP cameras on the Elegant cameras page, played natively (Media3 ExoPlayer,
 * hardware decoding) straight from the camera -- no Home Assistant in between.
 *
 * The page measures each camera tile and calls show(id, url, name, x, y, w, h)
 * in screen pixels; the video is laid over the WebView exactly there. The page
 * hides them (hideAll) whenever something covers the cameras page.
 * Taps on a camera go back to the page as event "rtsp" {id, event: "tap"}.
 */
@UnstableApi
class RtspCams(private val activity: MainActivity, private val root: FrameLayout, private val below: View) {

    private class Cam(
        val box: FrameLayout,
        val video: TextureView,
        val status: TextView,
        var url: String,
        var player: ExoPlayer?,
    )

    private val cams = HashMap<String, Cam>()

    private val prefs = activity.getSharedPreferences("rtsp", Context.MODE_PRIVATE)

    /** Camera decoder: "auto" | "alt" | "soft" (kept on the panel). */
    var decoder: String = prefs.getString("decoder", "auto") ?: "auto"
        private set

    /** Change the camera decoder and restart the cameras on screen with it. */
    fun setDecoder(mode: String) {
        val m = if (mode == "alt" || mode == "soft") mode else "auto"
        if (m == decoder) return
        decoder = m
        prefs.edit().putString("decoder", m).apply()
        cams.forEach { (id, c) ->
            c.player?.release()
            c.player = null
            c.status.text = "Connecting…"
            c.status.visibility = View.VISIBLE
            start(id, c)
        }
    }

    private var listedDecoders = false

    companion object {
        /**
         * Make a pasted / typed RTSP URL safe for the player. A password with
         * @ # ? / : in it otherwise breaks the URL (the camera's address is read
         * from inside the password -> "unknown host"): the address is taken
         * after the LAST @, and the user name and password are percent-encoded.
         */
        fun normalize(raw: String): String {
            val s = raw.trim().trim('"', '\'', ' ')
            val m = Regex("^(rtsps?://)(.*)$", RegexOption.IGNORE_CASE).find(s) ?: return s
            val scheme = m.groupValues[1].lowercase()
            val rest = m.groupValues[2]
            val at = rest.lastIndexOf('@')
            val info = if (at < 0) "" else rest.substring(0, at)
            val hostPath = cleanHost(if (at < 0) rest else rest.substring(at + 1))
            if (at < 0) return scheme + hostPath
            val colon = info.indexOf(':')
            val user = if (colon < 0) info else info.substring(0, colon)
            val pass = if (colon < 0) "" else info.substring(colon + 1)
            // decode first, so an already-encoded password isn't encoded twice
            val auth = Uri.encode(unescape(user)) + (if (colon < 0) "" else ":" + Uri.encode(unescape(pass)))
            return "$scheme$auth@$hostPath"
        }

        /** Percent-decode only real %XX escapes: a typed password like "50%off"
         *  keeps its "%" (a plain decode would turn "%of" into garbage). */
        private fun unescape(s: String): String {
            if (!Regex("%[0-9A-Fa-f]{2}").containsMatchIn(s)) return s
            val out = java.io.ByteArrayOutputStream()
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c == '%' && i + 2 < s.length && s[i + 1].isHexDigitChar() && s[i + 2].isHexDigitChar()) {
                    out.write(s.substring(i + 1, i + 3).toInt(16))
                    i += 3
                } else {
                    out.write(c.toString().toByteArray(Charsets.UTF_8))
                    i++
                }
            }
            return String(out.toByteArray(), Charsets.UTF_8)
        }

        private fun Char.isHexDigitChar() = this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'

        /** The URL with the password hidden, for the log. */
        fun masked(url: String): String = url.replace(Regex("^(rtsps?://[^:@/]*:)[^@]*@"), "\$1****@")

        /** "http://192.168.88.50:554:554 /x" -> "192.168.88.50:554/x": no spaces, no
         *  scheme typed into the IP box, one port only. */
        private fun cleanHost(hp: String): String {
            var s = hp.replace(" ", "")
            s = s.replace(Regex("^(https?|rtsps?)://", RegexOption.IGNORE_CASE), "")
            val slash = s.indexOf('/')
            val host = if (slash < 0) s else s.substring(0, slash)
            val path = if (slash < 0) "" else s.substring(slash)
            val parts = host.split(':').filter { it.isNotEmpty() }
            val h = if (parts.size > 2) parts[0] + ":" + parts[1] else parts.joinToString(":")
            return h + path
        }

        fun host(url: String): String = try {
            Uri.parse(url).host ?: "?"
        } catch (e: Exception) {
            "?"
        }
    }
    private val main = Handler(Looper.getMainLooper())

    fun show(id: String, rawUrl: String, name: String, x: Int, y: Int, w: Int, h: Int) {
        val url = normalize(rawUrl)
        var c = cams[id]
        if (c != null && c.url != url) {
            hide(id)
            c = null
        }
        if (c == null) c = create(id, url, name)
        // only re-lay the video when the tile really moved: the page sends the same
        // place on every update, and a needless relayout made the picture flicker
        val old = c.box.layoutParams as? FrameLayout.LayoutParams
        if (old == null || old.width != w || old.height != h || old.leftMargin != x || old.topMargin != y) {
            val lp = FrameLayout.LayoutParams(w, h)
            lp.leftMargin = x
            lp.topMargin = y
            lp.gravity = Gravity.TOP or Gravity.START
            c.box.layoutParams = lp
        }
        c.box.visibility = View.VISIBLE
        if (c.player == null) start(id, c)
    }

    /** Hide every camera except the given ids. */
    fun retain(ids: Set<String>) {
        cams.keys.filter { it !in ids }.forEach { hide(it) }
    }

    fun hide(id: String) {
        val c = cams.remove(id) ?: return
        c.player?.release()
        c.player = null
        root.removeView(c.box)
    }

    fun hideAll() {
        cams.keys.toList().forEach { hide(it) }
    }

    private fun create(id: String, url: String, name: String): Cam {
        val d = activity.resources.displayMetrics.density
        val box = FrameLayout(activity)
        box.setBackgroundColor(Color.BLACK)
        box.clipToOutline = true
        box.background = GradientDrawable().apply {
            setColor(Color.BLACK)
            cornerRadius = 10 * d
        }
        val video = TextureView(activity)
        // hidden until the first real frame (the decoder only gets data from the
        // first keyframe on: KeyframeFirstVideoRenderer)
        video.alpha = 0f
        box.addView(video, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        val status = TextView(activity).apply {
            text = "Connecting…"
            setTextColor(Color.parseColor("#99f3f1ec"))
            textSize = 13f
            gravity = Gravity.CENTER
        }
        box.addView(status, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        val label = TextView(activity).apply {
            text = name
            setTextColor(Color.WHITE)
            textSize = 12f
            setTypeface(typeface, Typeface.BOLD)
            setShadowLayer(4 * d, 0f, 0f, Color.BLACK)
            setPadding((8 * d).toInt(), 0, 0, (6 * d).toInt())
        }
        box.addView(label, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START))
        box.setOnClickListener { activity.emit("rtsp", "{\"id\":${MiniJson.quote(id)},\"event\":\"tap\"}") }
        // above the WebView, below the screen-off blackout
        root.addView(box, root.indexOfChild(below))
        val c = Cam(box, video, status, url, null)
        cams[id] = c
        return c
    }

    private fun start(id: String, c: Cam) {
        // small buffers: live view, not smooth playback of a recording
        val load = DefaultLoadControl.Builder()
            .setBufferDurationsMs(500, 2000, 300, 300)
            .build()
        // CameraRenderers: no green start (see KeyframeFirstVideoRenderer)
        val p = ExoPlayer.Builder(activity, CameraRenderers(activity, decoder)).setLoadControl(load).build()
        // the player log (HA: ADB > Check camera) says which decoder plays, and the choices
        if (!listedDecoders) {
            listedDecoders = true
            for (mime in listOf("video/hevc", "video/avc")) {
                val names = try {
                    MediaCodecUtil.getDecoderInfos(mime, false, false).joinToString(", ") { it.name + if (it.softwareOnly) " (software)" else "" }
                } catch (e: Exception) {
                    "?"
                }
                android.util.Log.i("ARRtsp", "decoders for $mime: $names")
            }
        }
        val mode = decoder
        p.addAnalyticsListener(object : AnalyticsListener {
            override fun onVideoDecoderInitialized(eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) {
                android.util.Log.i("ARRtsp", "camera $id plays with decoder $decoderName (setting: $mode)")
            }

            override fun onDroppedVideoFrames(eventTime: AnalyticsListener.EventTime, droppedFrames: Int, elapsedMs: Long) {
                android.util.Log.w("ARRtsp", "camera $id: $droppedFrames frames dropped in $elapsedMs ms (decoder too slow?)")
            }
        })
        p.volume = 0f
        c.video.animate().cancel()
        c.video.alpha = 0f
        p.setVideoTextureView(c.video)
        p.addListener(object : Player.Listener {
            override fun onRenderedFirstFrame() {
                // the first frame is a whole picture (keyframe first): show it, and
                // only now drop "Connecting…" so the tile is never an empty box
                main.postDelayed({
                    if (cams[id] === c && c.player === p) {
                        c.status.visibility = View.GONE
                        c.video.animate().alpha(1f).setDuration(150).start()
                    }
                }, 80)
            }

            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) {
                    activity.emit("rtsp", "{\"id\":${MiniJson.quote(id)},\"event\":\"playing\"}")
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                // say what went wrong, so a bad URL / login / address is visible on the panel
                // the useful exception can sit anywhere in the cause chain
                val chain = ArrayList<Throwable>()
                var t: Throwable? = error
                while (t != null && chain.size < 8 && t !in chain) {
                    chain.add(t)
                    t = t.cause
                }
                val msgs = chain.joinToString(" ") { it.message ?: "" }
                // the deepest cause, in plain words, so a photo of the tile says what broke
                val root = chain.last()
                val why = (root.javaClass.simpleName + (root.message?.let { ": " + it.take(90) } ?: "")).trim()
                android.util.Log.w("ARRtsp", "camera $id (${masked(c.url)}) failed: ${error.errorCodeName} | " + chain.joinToString(" <- ") { it.javaClass.simpleName + ": " + (it.message ?: "") })
                c.status.text = when {
                    chain.any { it is java.net.UnknownHostException } -> "Can't find the camera at \"${host(c.url)}\" — check the IP"
                    chain.any { it is java.net.ConnectException || it is java.net.SocketTimeoutException } -> "No answer from ${host(c.url)} — check the IP / port (554)"
                    msgs.contains("401") -> "The camera refused the login — check user / password"
                    msgs.contains("403") -> "The camera refused this panel (403) — locked out after wrong logins? Wait 30 min or reboot the camera"
                    msgs.contains("404") -> "The camera doesn't know that stream — check the channel (102)"
                    msgs.contains("461") -> "The camera won't send video over TCP (461)"
                    chain.any { it is java.net.SocketException } || msgs.contains("reset", true) || msgs.contains("EOF", true) ->
                        "The camera dropped the connection — locked out after wrong logins (wait 30 min / reboot it), or a wrong channel?\n$why"
                    else -> "Can't play this camera (${error.errorCodeName}) — retrying…\n$why"
                }
                c.status.visibility = View.VISIBLE
                activity.emit("rtsp", "{\"id\":${MiniJson.quote(id)},\"event\":\"error\",\"msg\":${MiniJson.quote(error.errorCodeName)}}")
                // try again while it is still on screen. After a refused login wait a
                // minute: Hikvision locks a device out after a few wrong logins in a row.
                val loginRefused = msgs.contains("401") || msgs.contains("403")
                main.postDelayed({
                    if (cams[id] === c) {
                        c.player?.release()
                        c.player = null
                        start(id, c)
                    }
                }, if (loginRefused) 60_000L else 5_000L)
            }
        })
        // RTP over TCP: works through panels' and cameras' firewalls, no lost UDP packets
        android.util.Log.i("ARRtsp", "camera $id -> ${masked(c.url)} (host ${host(c.url)})")
        val source = RtspMediaSource.Factory()
            .setForceUseRtpTcp(true)
            .setTimeoutMs(8000)
            .createMediaSource(MediaItem.fromUri(c.url))
        p.setMediaSource(source)
        p.playWhenReady = true
        p.prepare()
        c.player = p
    }
}
