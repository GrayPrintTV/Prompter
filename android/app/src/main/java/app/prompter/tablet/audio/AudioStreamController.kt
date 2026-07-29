package app.prompter.tablet.audio

import app.prompter.tablet.protocol.AudioFrameMetadata
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class AudioDiagnostics(
    val active: Boolean = false,
    val sampleRate: Int? = null,
    val streamId: String? = null,
    val framesSent: Long = 0,
    val framesDropped: Long = 0,
    val lastSequence: Long = -1,
    val lastError: String? = null
)

class AudioStreamController(private val capture: AudioFrameSource) {
    private val _diagnostics = MutableStateFlow(AudioDiagnostics())
    val diagnostics: StateFlow<AudioDiagnostics> = _diagnostics.asStateFlow()
    private val captureGeneration = AtomicLong(0)
    private val framesSent = AtomicLong(0)
    private val framesDropped = AtomicLong(0)
    private val lastSequence = AtomicLong(-1)

    fun prepare(): Result<Pair<String, Int>> = capture.probeSampleRate()?.let { Result.success(UUID.randomUUID().toString() to it) }
        ?: Result.failure(IllegalStateException("Microphone permission or a supported sample rate is unavailable."))

    fun start(streamId: String, expectedSampleRate: Int, send: (AudioFrameMetadata, ByteArray) -> Boolean): Result<Pair<String, Int>> {
        val activeGeneration = captureGeneration.incrementAndGet()
        framesSent.set(0)
        framesDropped.set(0)
        lastSequence.set(-1)
        val result = capture.start frame@{ frame ->
            if (captureGeneration.get() != activeGeneration) {
                framesDropped.incrementAndGet()
                lastSequence.set(frame.sequence)
                if (shouldPublishAudioDiagnostics(frame.sequence)) publishDiagnostics("Stale audio capture generation was dropped.")
                return@frame
            }
            val bytes = AudioFrameEncoder.pcm16LittleEndian(frame.samples)
            val metadata = AudioFrameMetadata(streamId, frame.sequence, frame.captureTimestampMs, frame.sampleRate, sampleCount = frame.samples.size)
            val sent = send(metadata, bytes)
            if (sent) framesSent.incrementAndGet() else framesDropped.incrementAndGet()
            lastSequence.set(frame.sequence)
            if (shouldPublishAudioDiagnostics(frame.sequence)) publishDiagnostics()
        }
        return result.mapCatching { rate ->
            require(rate == expectedSampleRate) { "Audio route changed from $expectedSampleRate to $rate Hz before capture." }
            _diagnostics.value = AudioDiagnostics(active = true, sampleRate = rate, streamId = streamId)
            streamId to rate
        }.onFailure { _diagnostics.value = AudioDiagnostics(lastError = it.message) }
    }

    fun stop() {
        captureGeneration.incrementAndGet()
        capture.stop()
        publishDiagnostics(active = false)
    }

    private fun publishDiagnostics(lastError: String? = _diagnostics.value.lastError, active: Boolean = _diagnostics.value.active) {
        _diagnostics.value = _diagnostics.value.copy(
            active = active,
            framesSent = framesSent.get(),
            framesDropped = framesDropped.get(),
            lastSequence = lastSequence.get(),
            lastError = lastError
        )
    }
}

fun shouldPublishAudioDiagnostics(sequence: Long, intervalFrames: Long = 5) =
    sequence == 0L || (sequence + 1L) % intervalFrames == 0L
