package app.prompter.tablet.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioStreamControllerTest {
    private class FakeFrameSource : AudioFrameSource {
        val callbacks = mutableListOf<(CapturedAudioFrame) -> Unit>()
        override fun probeSampleRate() = 16000
        override fun start(onFrame: (CapturedAudioFrame) -> Unit): Result<Int> {
            callbacks += onFrame
            return Result.success(16000)
        }
        override fun stop() = Unit
    }

    @Test fun `stale capture callback cannot send after stop and restart`() {
        val source = FakeFrameSource()
        val controller = AudioStreamController(source)
        val sentStreams = mutableListOf<String>()

        controller.start("old-stream", 16000) { metadata, _ ->
            sentStreams += metadata.streamId
            true
        }.getOrThrow()
        val oldCallback = source.callbacks.single()
        controller.stop()
        controller.start("new-stream", 16000) { metadata, _ ->
            sentStreams += metadata.streamId
            true
        }.getOrThrow()

        oldCallback(CapturedAudioFrame(0, 1, 16000, shortArrayOf(1, 2)))
        source.callbacks.last()(CapturedAudioFrame(0, 2, 16000, shortArrayOf(3, 4)))

        assertEquals(listOf("new-stream"), sentStreams)
        assertEquals(1, controller.diagnostics.value.framesDropped)
        assertTrue(controller.diagnostics.value.active)
    }

    @Test fun `audio diagnostics publish at low frequency instead of every frame`() {
        val published = (0L until 100L).filter(::shouldPublishAudioDiagnostics)
        assertEquals(listOf(0L, 4L, 9L, 14L, 19L, 24L, 29L, 34L, 39L, 44L, 49L, 54L, 59L, 64L, 69L, 74L, 79L, 84L, 89L, 94L, 99L), published)
    }
}
