package app.prompter.tablet.audio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class CapturedAudioFrame(val sequence: Long, val captureTimestampMs: Long, val sampleRate: Int, val samples: ShortArray)

interface AudioFrameSource {
    fun probeSampleRate(): Int?
    fun start(onFrame: (CapturedAudioFrame) -> Unit): Result<Int>
    fun stop()
}

class AudioCapture(private val context: Context, private val scope: CoroutineScope) : AudioFrameSource {
    private var recorder: AudioRecord? = null
    private var job: Job? = null
    private val running = AtomicBoolean(false)
    var activeSampleRate: Int? = null
        private set

    override fun probeSampleRate(): Int? {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return null
        return listOf(16000, 48000).firstOrNull { rate -> createRecorder(rate)?.let { it.release(); true } == true }
    }

    @SuppressLint("MissingPermission")
    override fun start(onFrame: (CapturedAudioFrame) -> Unit): Result<Int> {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return Result.failure(SecurityException("Microphone permission is required."))
        }
        if (running.get()) return Result.success(activeSampleRate ?: 16000)
        val selected = listOf(16000, 48000).firstNotNullOfOrNull { rate -> createRecorder(rate)?.let { rate to it } }
            ?: return Result.failure(IllegalStateException("AudioRecord could not initialize at 16 or 48 kHz."))
        val (sampleRate, audioRecord) = selected
        recorder = audioRecord
        activeSampleRate = sampleRate
        audioRecord.startRecording()
        running.set(true)
        job = scope.launch(Dispatchers.IO) {
            var sequence = 0L
            val samples = ShortArray(sampleRate / 5) // 200 ms
            while (isActive && running.get()) {
                val read = audioRecord.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
                if (read > 0) onFrame(CapturedAudioFrame(sequence++, System.currentTimeMillis(), sampleRate, samples.copyOf(read)))
                else if (read < 0) break
            }
        }
        return Result.success(sampleRate)
    }

    override fun stop() {
        running.set(false)
        job?.cancel()
        job = null
        recorder?.let { runCatching { it.stop() }; it.release() }
        recorder = null
        activeSampleRate = null
    }

    @SuppressLint("MissingPermission")
    private fun createRecorder(sampleRate: Int): AudioRecord? {
        val channel = AudioFormat.CHANNEL_IN_MONO
        val encoding = AudioFormat.ENCODING_PCM_16BIT
        val minimum = AudioRecord.getMinBufferSize(sampleRate, channel, encoding)
        if (minimum <= 0) return null
        val value = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, sampleRate, channel, encoding, maxOf(minimum, sampleRate))
        return value.takeIf { it.state == AudioRecord.STATE_INITIALIZED } ?: run { value.release(); null }
    }
}
