package app.prompter.tablet.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidWireCompatibilityTest {
    private val codec = ProtocolCodec { 1_700_000_000_000 }
    private fun fixture(name: String) = requireNotNull(javaClass.classLoader?.getResource("protocol/$name")).readText().trim()
    private fun <T> encode(type: String, payload: T, serializer: kotlinx.serialization.KSerializer<T>) =
        codec.encodeEnvelope(type, payload, serializer, "server-wire", "android-pending", "android-wire", 0)

    @Test fun `real Android codec emits Windows-compatible pairing bytes`() {
        val base = PairRequest(requestId = "request-wire", deviceId = "device-wire", deviceName = "Galaxy Tab A8", model = "SM-X200")
        assertEquals(fixture("android-wire/pair-request.json"), encode("pairRequest", base, PairRequest.serializer()))
        assertEquals(fixture("android-wire/pair-request-code.json"), encode("pairRequest", base.copy(pairingCode = "012345"), PairRequest.serializer()))
    }

    @Test fun `real Android codec emits auth snapshot and audio bytes`() {
        assertEquals(fixture("android-wire/authenticate.json"), encode("authenticate", Authenticate(deviceId = "device-wire", clientNonce = "client-nonce-wire", timestampMs = 1_700_000_000_000, proof = "proof-wire"), Authenticate.serializer()))
        assertEquals(fixture("android-wire/request-snapshot.json"), encode("requestSnapshot", RequestSnapshot(), RequestSnapshot.serializer()))
        assertEquals(fixture("android-wire/audio-stream-start.json"), encode("audioStreamStart", AudioStreamStart(streamId = "stream-wire", sampleRate = 16000, sequenceStart = 0, captureTimestampMs = 1_700_000_000_000, frameDurationMs = 200), AudioStreamStart.serializer()))
    }

    @Test fun `real Android codec decodes Windows challenge bytes`() {
        val envelope = codec.decodeEnvelope(fixture("windows-wire/server-challenge.json"))
        assertEquals("challenge-wire", codec.decodePayload<ServerChallenge>(envelope).nonce)
    }
}
