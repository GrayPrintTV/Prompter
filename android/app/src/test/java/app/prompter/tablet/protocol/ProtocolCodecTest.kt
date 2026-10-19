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
        assertEquals(3, ProtocolVersion.requireCompatible(1, 4))
    }

    @Test fun `envelope serialization round trips`() {
        val encoded = codec.encodeEnvelope("requestSnapshot", RequestSnapshot(), RequestSnapshot.serializer(), "server-1", "session-1", "connection-1", 3)
        assertEquals(3, codec.decodeEnvelope(encoded).sequence)
    }

    @Test fun `authentication round trip retains tablet to Windows recovery claim`() {
        val claim = TabletRecoveryClaim(
            manuscriptId = "book-1",
            contentHash = "sha256:" + "a".repeat(64),
            manuscriptRevision = 3,
            tokenIndex = 10,
            character = 42,
            sentenceIndex = 2,
            paragraphIndex = 1,
            anchorFingerprint = "sha256:" + "b".repeat(64),
            capturedAtMs = 99_000
        )
        val authenticate = Authenticate(
            deviceId = "tablet", clientNonce = "nonce", timestampMs = 100_000,
            proof = "proof", recoveryClaim = claim
        )
        val encoded = codec.encodeEnvelope(
            "authenticate", authenticate, Authenticate.serializer(),
            "server-1", "session-1", "connection-1", 3
        )
        assertEquals(claim, codec.decodePayload<Authenticate>(codec.decodeEnvelope(encoded)).recoveryClaim)
    }

    @Test fun `manual reposition accepts every shared input source including fast scroll`() {
        for (source in listOf("touch", "pointer", "fast-scroll", "unknown")) {
            val reposition = ManualReposition(
                manuscriptRevision = 1,
                visibleTokenIndex = 1,
                visibleCharacter = 1,
                sentenceIndex = 1,
                paragraphIndex = 1,
                direction = "stationary",
                inputSource = source,
                scrollContainer = "manuscript",
                detectedAtMs = 10
            )
            assertEquals(source, reposition.inputSource)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ManualReposition(
                manuscriptRevision = 1,
                visibleTokenIndex = 1,
                visibleCharacter = 1,
                sentenceIndex = 1,
                paragraphIndex = 1,
                direction = "stationary",
                inputSource = "mouse-wheel",
                scrollContainer = "manuscript",
                detectedAtMs = 10
            )
        }
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
