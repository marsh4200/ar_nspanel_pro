package za.co.arsmarthome.nspanel

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
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.rtsp.RtspMediaSource

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
            val auth = Uri.encode(Uri.decode(user)) + (if (colon < 0) "" else ":" + Uri.encode(Uri.decode(pass)))
            return "$scheme$auth@$hostPath"
        }

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
        val lp = FrameLayout.LayoutParams(w, h)
        lp.leftMargin = x
        lp.topMargin = y
        lp.gravity = Gravity.TOP or Gravity.START
        c.box.layoutParams = lp
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
        val p = ExoPlayer.Builder(activity).setLoadControl(load).build()
        p.volume = 0f
        p.setVideoTextureView(c.video)
        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) {
                    c.status.visibility = View.GONE
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
                c.status.text = when {
                    chain.any { it is java.net.UnknownHostException } -> "Can't find the camera at \"${host(c.url)}\" — check the IP"
                    chain.any { it is java.net.ConnectException || it is java.net.SocketTimeoutException } -> "No answer from ${host(c.url)} — check the IP / port (554)"
                    msgs.contains("401") -> "The camera refused the login — check user / password"
                    msgs.contains("404") -> "The camera doesn't know that stream — check the channel (102)"
                    else -> "Can't play this camera (${error.errorCodeName}) — retrying…"
                }
                c.status.visibility = View.VISIBLE
                activity.emit("rtsp", "{\"id\":${MiniJson.quote(id)},\"event\":\"error\",\"msg\":${MiniJson.quote(error.errorCodeName)}}")
                // try again while it is still on screen
                main.postDelayed({
                    if (cams[id] === c) {
                        c.player?.release()
                        c.player = null
                        start(id, c)
                    }
                }, 5000)
            }
        })
        // RTP over TCP: works through panels' and cameras' firewalls, no lost UDP packets
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
