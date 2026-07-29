package app.prompter.tablet.protocol

import java.io.File
import kotlinx.serialization.MissingFieldException
import org.junit.Assert.*
import org.junit.Test

class ProtocolCodecTest {
    private val codec = ProtocolCodec()
    private fun fixture(name: String) = requireNotNull(javaClass.classLoader?.getResource("protocol/$name")).readText()

    @Test fun `shared positive snapshot fixture decodes and ignores future fields`() {
        val text = fixture("valid-session-snapshot.json").replace("\"payload\": {", "\"futureEnvelopeField\": true, \"payload\": { \"futurePayloadField\": 1,")
        val envelope = codec.decodeEnvelope(text)
        val snapshot = codec.decodePayload<SessionSnapshot>(envelope)
        assertEquals("sessionSnapshot", envelope.type)
        assertEquals("sha256:fixture", snapshot.manuscript.contentHash)
    }

    @Test fun `shared movement fixture decodes`() {
        val envelope = codec.decodeEnvelope(fixture("valid-movement.json"))
        assertTrue(codec.decodePayload<MovementEvent>(envelope).targetTokenIndex >= 0)
    }

    @Test fun `missing required sequence is rejected`() {
        assertThrows(MissingFieldException::class.java) { codec.decodeEnvelope(fixture("invalid-missing-sequence.json")) }
    }

    @Test fun `major mismatch rejects while higher minor negotiates`() {
        assertThrows(IllegalArgumentException::class.java) { ProtocolVersion.requireCompatible(2, 0) }
        assertEquals(2, ProtocolVersion.requireCompatible(1, 4))
    }

    @Test fun `envelope serialization round trips`() {
        val encoded = codec.encodeEnvelope("requestSnapshot", RequestSnapshot(), RequestSnapshot.serializer(), "server-1", "session-1", "connection-1", 3)
        assertEquals(3, codec.decodeEnvelope(encoded).sequence)
    }

    @Test fun `server challenge exposes connected build and protocol identity`() {
        val payload = ServerChallenge(
            nonce = "redacted",
            issuedAtMs = 10,
            serverId = "server-1",
            protocolMajor = 1,
            protocolMinor = 2,
            serverBuild = BuildIdentityPayload(
                versionName = "0.1.0",
                buildTimestamp = "2026-07-28T12:00:00Z",
                gitHash = "abc123",
                dirty = true
            ),
            serverStartedAtMs = 20
        )
        val encoded = codec.encodeEnvelope("serverChallenge", payload, ServerChallenge.serializer(), "server-1", "session-1", "connection-1", 0)
        val decoded = codec.decodePayload<ServerChallenge>(codec.decodeEnvelope(encoded))
        assertEquals("abc123", decoded.serverBuild?.gitHash)
        assertEquals(2, decoded.protocolMinor)
        assertEquals(20L, decoded.serverStartedAtMs)
    }
}
