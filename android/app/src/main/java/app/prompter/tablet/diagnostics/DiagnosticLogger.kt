package app.prompter.tablet.diagnostics

import android.content.Context
import android.util.Log
import app.prompter.tablet.protocol.ManualFollowDiagnostic
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class AndroidDiagnosticEvent(
    val timestampMs: Long,
    val timestampLocal: String,
    val sequence: Long,
    val component: String,
    val level: String,
    val event: String,
    val message: String,
    val connectionId: String? = null,
    val deviceId: String? = null,
    val serverId: String? = null,
    val remoteAddress: String? = null,
    val webSocketState: String? = null,
    val protocolMessageType: String? = null,
    val closeCode: Int? = null,
    val closeReason: String? = null,
    val exceptionClass: String? = null,
    val errorMessage: String? = null,
    val details: Map<String, String> = emptyMap()
)

class BoundedDiagnosticBuffer<T>(private val capacity: Int) {
    private val values = ArrayDeque<T>(capacity)

    init {
        require(capacity > 0)
    }

    @Synchronized
    fun add(value: T) {
        if (values.size == capacity) values.removeFirst()
        values.addLast(value)
    }

    @Synchronized
    fun snapshot(): List<T> = values.toList()

    @Synchronized
    fun clear() = values.clear()
}

class DiagnosticRateLimiter(private val maxKeys: Int = 128) {
    private val lastEmittedAtMs = linkedMapOf<String, Long>()

    @Synchronized
    fun shouldEmit(key: String, nowMs: Long, minimumIntervalMs: Long): Boolean {
        val previous = lastEmittedAtMs[key]
        if (previous != null && nowMs - previous < minimumIntervalMs) return false
        lastEmittedAtMs[key] = nowMs
        while (lastEmittedAtMs.size > maxKeys) lastEmittedAtMs.remove(lastEmittedAtMs.keys.first())
        return true
    }
}

private data class DiagnosticSideEffect(
    val item: AndroidDiagnosticEvent,
    val throwable: Throwable?,
    val mirror: Boolean
)

class DiagnosticLogger(context: Context, capacity: Int = 500) {
    private val file = File(context.filesDir, "tablet-connectivity.log")
    private val nextSequence = AtomicLong()
    private val buffer = BoundedDiagnosticBuffer<AndroidDiagnosticEvent>(capacity)
    private val rateLimiter = DiagnosticRateLimiter()
    private val backgroundScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sideEffects = Channel<DiagnosticSideEffect>(
        capacity = 256,
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )
    private val publishScheduled = AtomicBoolean(false)
    private val _events = kotlinx.coroutines.flow.MutableStateFlow<List<AndroidDiagnosticEvent>>(emptyList())
    val events: kotlinx.coroutines.flow.StateFlow<List<AndroidDiagnosticEvent>> = _events.asStateFlow()
    @Volatile private var manualFollowUploader: ((ManualFollowDiagnostic) -> Boolean)? = null

    init {
        backgroundScope.launch {
            for (effect in sideEffects) processSideEffect(effect)
        }
    }

    fun setManualFollowUploader(uploader: (ManualFollowDiagnostic) -> Boolean) {
        manualFollowUploader = uploader
    }

    fun record(
        component: String,
        level: String,
        event: String,
        message: String,
        connectionId: String? = null,
        deviceId: String? = null,
        serverId: String? = null,
        remoteAddress: String? = null,
        webSocketState: String? = null,
        protocolMessageType: String? = null,
        closeCode: Int? = null,
        closeReason: String? = null,
        throwable: Throwable? = null,
        details: Map<String, String> = emptyMap()
    ) {
        val now = System.currentTimeMillis()
        diagnosticThrottleMs(event)?.let { interval ->
            if (!rateLimiter.shouldEmit(event, now, interval)) return
        }
        val item = AndroidDiagnosticEvent(
            now, LOCAL_FORMAT.format(Instant.ofEpochMilli(now)), nextSequence.incrementAndGet(), component, level,
            event, redact(message), connectionId?.short(), deviceId?.short(), serverId?.short(), remoteAddress,
            webSocketState, protocolMessageType, closeCode, closeReason?.let(::redact), throwable?.javaClass?.simpleName,
            throwable?.message?.let(::redact), details.filterKeys {
                !SECRET_KEY.containsMatchIn(it) ||
                    it.equals("manuscriptRevision", true) ||
                    it.equals("audioSequence", true)
            }.mapValues { redact(it.value) }
        )
        buffer.add(item)
        scheduleComposePublish()
        sideEffects.trySend(DiagnosticSideEffect(item, throwable, shouldMirrorToManualFollowLog(item.event)))
    }

    fun clear() {
        buffer.clear()
        _events.value = emptyList()
    }

    fun snapshot(): List<AndroidDiagnosticEvent> = buffer.snapshot()

    fun copyText(): String = buildString {
        appendLine("Prompter Android connectivity diagnostics")
        appendLine("Generated: ${Instant.now()}")
        buffer.snapshot().forEach { appendLine(format(it)) }
    }.trimEnd()

    private fun scheduleComposePublish() {
        if (!publishScheduled.compareAndSet(false, true)) return
        backgroundScope.launch {
            delay(COMPOSE_PUBLISH_INTERVAL_MS)
            publishScheduled.set(false)
            _events.value = buffer.snapshot()
        }
    }

    private fun processSideEffect(effect: DiagnosticSideEffect) {
        val item = effect.item
        if (effect.mirror) {
            val line = "${item.event} | ${item.message}" +
                if (item.details.isNotEmpty()) " | ${item.details.entries.joinToString { "${it.key}=${it.value}" }}" else ""
            when (item.level.lowercase()) {
                "error" -> Log.e(MANUAL_FOLLOW_TAG, line, effect.throwable)
                "warn" -> Log.w(MANUAL_FOLLOW_TAG, line)
                "debug" -> Log.d(MANUAL_FOLLOW_TAG, line)
                else -> Log.i(MANUAL_FOLLOW_TAG, line)
            }
            runCatching {
                manualFollowUploader?.invoke(
                    ManualFollowDiagnostic(
                        timestampMs = item.timestampMs,
                        sequence = item.sequence,
                        level = item.level,
                        event = item.event,
                        message = item.message,
                        details = item.details
                    )
                )
            }
        }
        runCatching {
            if (file.exists() && file.length() > 512 * 1024) {
                file.writeText(file.readText().takeLast(256 * 1024))
            }
            file.appendText(format(item) + "\n")
        }
    }

    private fun format(item: AndroidDiagnosticEvent): String = buildString {
        append("${item.timestampLocal} [${item.sequence}] ANDROID ${item.level.uppercase()} ${item.component} ${item.event}: ${item.message}")
        item.remoteAddress?.let { append(" remote=$it") }
        item.webSocketState?.let { append(" ws=$it") }
        item.protocolMessageType?.let { append(" type=$it") }
        item.closeCode?.let { append(" close=$it") }
        item.closeReason?.let { append(" reason=$it") }
        item.exceptionClass?.let { append(" exception=$it") }
        item.errorMessage?.let { append(" error=$it") }
        if (item.details.isNotEmpty()) append(" details=${item.details}")
    }

    private fun String.short() = if (length <= 8) this else take(8) + "..."
    private fun redact(value: String): String = value
        .replace(SECRET_VALUE, "$1=[redacted]")
        .take(500)

    companion object {
        const val MANUAL_FOLLOW_TAG = "PrompterManualFollow"
        private const val COMPOSE_PUBLISH_INTERVAL_MS = 500L
        private val LOCAL_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS z").withZone(ZoneId.systemDefault())
        private val SECRET_KEY = Regex("credential|proof|challenge|nonce|pairing.?code|pcm|audio|manuscript|content", RegexOption.IGNORE_CASE)
        private val SECRET_VALUE = Regex("(?i)(credential|proof|challenge|nonce|pairing.?code)\\s*[=:]\\s*[^, }]+")

        private fun diagnosticThrottleMs(event: String): Long? = when (event) {
            "android.audio.frames_progress" -> 5_000
            "android.audio.frame_dropped" -> 2_000
            "android.assist.cruise.frame" -> 5_000
            "android.movement.geometry_retry" -> 1_000
            "android.manual_scroll.scroll_observed" -> 500
            else -> null
        }

        private fun shouldMirrorToManualFollowLog(event: String) =
            event == "android.app.launch" ||
                event == "android.server.identity" ||
                event == "android.connection.authenticated" ||
                event.startsWith("android.connection.") ||
                event.startsWith("android.websocket.") ||
                event.startsWith("android.lifecycle.") ||
                event == "android.audio.frames_progress" ||
                event == "android.audio.frame_dropped" ||
                event == "android.controller.lease" ||
                event.startsWith("android.controller.") ||
                event.startsWith("android.manual_scroll.") ||
                event in setOf(
                    "android.movement.received",
                    "android.movement.before_lease",
                    "android.movement.waiting_for_connection_or_lease",
                    "android.movement.rejected",
                    "android.movement.target_resolved",
                    "android.movement.target_unresolved"
                )
    }
}
