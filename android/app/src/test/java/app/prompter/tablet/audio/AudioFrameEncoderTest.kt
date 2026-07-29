package app.prompter.tablet.audio

import org.junit.Assert.*
import org.junit.Test

class AudioFrameEncoderTest {
    @Test fun `encodes signed PCM16 little endian`() {
        assertArrayEquals(byteArrayOf(0x34, 0x12, 0xFE.toByte(), 0xFF.toByte()), AudioFrameEncoder.pcm16LittleEndian(shortArrayOf(0x1234, -2)))
    }
    @Test fun `validates sample count for 16 and 48 kHz frame sizes`() {
        assertTrue(AudioFrameEncoder.validate(ByteArray(3200 * 2), 3200))
        assertTrue(AudioFrameEncoder.validate(ByteArray(9600 * 2), 9600))
        assertFalse(AudioFrameEncoder.validate(ByteArray(10), 6))
    }
}
