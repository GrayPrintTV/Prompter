package app.prompter.tablet.audio

import java.nio.ByteBuffer
import java.nio.ByteOrder

object AudioFrameEncoder {
    fun pcm16LittleEndian(samples: ShortArray, count: Int = samples.size): ByteArray {
        require(count in 0..samples.size)
        return ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN).apply {
            repeat(count) { putShort(samples[it]) }
        }.array()
    }

    fun validate(bytes: ByteArray, sampleCount: Int) = bytes.size == sampleCount * 2
}
