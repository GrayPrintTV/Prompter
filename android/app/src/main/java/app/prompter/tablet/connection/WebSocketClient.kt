package app.prompter.tablet.connection

import java.util.concurrent.TimeUnit
import app.prompter.tablet.diagnostics.DiagnosticLogger
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString

interface WebSocketEvents {
    fun onOpen()
    fun onText(text: String)
    fun onClosing(code: Int, reason: String)
    fun onClosed(code: Int, reason: String)
    fun onFailure(message: String, exceptionClass: String, httpCode: Int?, responseSummary: String?)
}

data class AudioPairSendResult(
    val sent: Boolean,
    val reason: String,
    val generation: Int?
)

class WebSocketClient(private val diagnostics: DiagnosticLogger) {
    private val client = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private var socket: WebSocket? = null
    private var generation = 0
    private var openGeneration: Int? = null

    @Synchronized
    fun connect(endpoint: String, events: WebSocketEvents) {
        close("replacing socket for a new connection")
        val activeGeneration = ++generation
        val request = Request.Builder().url(endpoint).build()
        diagnostics.record("websocket", "info", "android.websocket.connecting", "OkHttp WebSocket request started.", remoteAddress = request.url.toString(), webSocketState = "CONNECTING", details = mapOf("path" to request.url.encodedPath))
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val active = synchronized(this@WebSocketClient) {
                    (activeGeneration == generation && socket === webSocket).also {
                        if (it) openGeneration = activeGeneration
                    }
                }
                if (active) { diagnostics.record("websocket", "info", "android.websocket.open", "WebSocket upgrade succeeded (HTTP ${response.code}).", remoteAddress = request.url.toString(), webSocketState = "OPEN", details = mapOf("generation" to activeGeneration.toString())); events.onOpen() }
            }
            override fun onMessage(webSocket: WebSocket, text: String) { if (activeGeneration == generation) { diagnostics.record("websocket", "debug", "android.message.received", "Text frame received (${text.toByteArray().size} bytes).", webSocketState = "OPEN"); events.onText(text) } }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { if (activeGeneration == generation) { diagnostics.record("websocket", "warn", "android.websocket.closing", "Server initiated WebSocket close.", webSocketState = "CLOSING", closeCode = code, closeReason = reason); events.onClosing(code, reason) }; webSocket.close(code, reason) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (activeGeneration == generation) { synchronized(this@WebSocketClient) { if (openGeneration == activeGeneration) openGeneration = null }; diagnostics.record("websocket", "warn", "android.websocket.closed", "WebSocket closed.", webSocketState = "CLOSED", closeCode = code, closeReason = reason, details = mapOf("generation" to activeGeneration.toString())); events.onClosed(code, reason) } }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (activeGeneration == generation) {
                synchronized(this@WebSocketClient) { if (openGeneration == activeGeneration) openGeneration = null }
                val summary = response?.let { "HTTP ${it.code} ${it.message}" }
                diagnostics.record("websocket", "error", "android.websocket.failure", "WebSocket failed${summary?.let { ": $it" } ?: " before receiving an HTTP upgrade response"}.", remoteAddress = request.url.toString(), webSocketState = "FAILED", throwable = t, details = response?.let { mapOf("httpStatus" to it.code.toString(), "httpMessage" to it.message) } ?: emptyMap())
                events.onFailure(t.message ?: "WebSocket failed.", t.javaClass.simpleName, response?.code, summary)
            } }
        })
    }

    @Synchronized
    fun send(text: String): Boolean = (openGeneration != null && socket?.send(text) == true).also { sent -> diagnostics.record("websocket", if (sent) "debug" else "warn", "android.message.sent", if (sent) "Text frame queued (${text.toByteArray().size} bytes)." else "Text frame could not be queued.", webSocketState = if (sent) "OPEN" else "NOT_OPEN", details = mapOf("generation" to (openGeneration?.toString() ?: "none"))) }

    @Synchronized
    fun send(bytes: ByteArray): Boolean = openGeneration != null && socket?.send(bytes.toByteString()) == true

    @Synchronized
    fun sendAudioPair(metadataEnvelope: String, pcm: ByteArray, requiredGeneration: Int): AudioPairSendResult {
        val active = socket ?: return AudioPairSendResult(false, "no active socket", openGeneration)
        val currentGeneration = openGeneration
            ?: return AudioPairSendResult(false, "socket is not open", null)
        if (currentGeneration != requiredGeneration) {
            return AudioPairSendResult(false, "stale socket generation $requiredGeneration; active generation is $currentGeneration", currentGeneration)
        }
        if (!active.send(metadataEnvelope)) {
            return AudioPairSendResult(false, "metadata envelope could not be queued", currentGeneration)
        }
        if (socket !== active || openGeneration != currentGeneration) {
            return AudioPairSendResult(false, "socket generation changed after metadata", openGeneration)
        }
        if (!active.send(pcm.toByteString())) {
            return AudioPairSendResult(false, "binary PCM could not be queued after metadata", currentGeneration)
        }
        return AudioPairSendResult(true, "metadata and PCM queued atomically", currentGeneration)
    }

    @Synchronized
    fun currentOpenGeneration(): Int? = openGeneration

    @Synchronized
    fun close(reason: String = "Android client closing") {
        generation++
        openGeneration = null
        val active = socket
        if (active != null) {
            diagnostics.record("websocket", "info", "android.websocket.close_requested", "Android requested WebSocket close.", webSocketState = "CLOSING", closeCode = 1000, closeReason = reason)
            active.close(1000, reason)
        }
        socket = null
    }
}
