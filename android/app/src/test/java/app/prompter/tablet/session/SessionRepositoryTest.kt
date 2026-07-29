package app.prompter.tablet.session

import app.prompter.tablet.protocol.*
import java.nio.file.Files
import kotlinx.serialization.json.buildJsonObject
import app.prompter.tablet.ui.prompter.ManualMovementDecision
import app.prompter.tablet.ui.prompter.MovementFollowController
import app.prompter.tablet.ui.prompter.TabletVisibleAnchor
import org.junit.Assert.*
import org.junit.Test

class SessionRepositoryTest {
    private fun settings(revision: Long) = RuntimeSettings(revision, "windows", 1,
        RuntimeDisplaySettings("#111315", "#F4EBDD", "#80CBC4", .14f, 34f, 1.55f, 28f, 1.35f, .38f, 1f),
        RuntimeFollowSettings(true, .45f, 840f, .45f, 18f, "animate"), RuntimeServerAlignmentSettings(6))
    private fun envelope(sequence: Long, sessionId: String = "session-a") = ProtocolEnvelope(1, 0, "event", "server", sessionId, "connection", sequence, 1, buildJsonObject {})
    private fun snapshot(revision: Long = 1, hash: String = "sha256:a") = SessionSnapshot(
        revision, revision, ManuscriptPayload("m", hash, "First paragraph.", paragraphs = listOf(ParagraphAnchor(0, CharacterRange(0, 16), 0, 1)),
            sentences = listOf(SentenceAnchor(0, 0, CharacterRange(0, 16), 0, 2)), tokens = listOf(TokenAnchor(0, 0, 0, CharacterRange(0, 5)))),
        Position(0, 0, 0, 0), "following", .9, displayHints = DisplayHints()
    )

    @Test fun `snapshot caches manuscript and replacement follows revision`() {
        val repository = SessionRepository(Files.createTempDirectory("prompter-session").toFile())
        repository.applySnapshot(envelope(1), snapshot())
        assertEquals("sha256:a", repository.state.value.snapshot?.manuscript?.contentHash)
        repository.applySnapshot(envelope(2), snapshot(2, "sha256:b"))
        assertEquals(2L, repository.state.value.snapshot?.manuscriptRevision)
    }

    @Test fun `duplicates gaps and session changes require snapshot recovery`() {
        val repository = SessionRepository(Files.createTempDirectory("prompter-session").toFile())
        repository.applySnapshot(envelope(4), snapshot())
        assertFalse(repository.acceptIncremental(envelope(4)))
        assertFalse(repository.acceptIncremental(envelope(6)))
        assertTrue(repository.state.value.awaitingSnapshot)
        repository.applySnapshot(envelope(7), snapshot())
        assertFalse(repository.acceptIncremental(envelope(8, "new-session")))
    }

    @Test fun `fresh transcript and movement incrementals apply`() {
        val repository = SessionRepository(Files.createTempDirectory("prompter-session").toFile())
        repository.applySnapshot(envelope(1), snapshot())
        repository.recordControlEnvelope(envelope(2))
        assertTrue(repository.acceptIncremental(envelope(3)))
        repository.applyTranscript(TranscriptEvent(1, 1, "First", true, "local-whisper", timestampMs = 1, acceptedPosition = Position(0, 0, 0, 0)))
        assertEquals("First", repository.state.value.latestTranscript)
        assertTrue(repository.acceptIncremental(envelope(4)))
        repository.applyMovement(MovementEvent(1, 1, 0, 0, 0, 0, 0, .9, 500, "on-track", "test"))
        assertEquals("on-track", repository.state.value.latestMovement?.classification)
        repository.applySnapshot(envelope(5), snapshot())
        assertEquals("on-track", repository.state.value.latestMovement?.classification)
    }

    @Test fun `movement rejection reports stale revision and missing target`() {
        val repository = SessionRepository(Files.createTempDirectory("prompter-session").toFile())
        repository.applySnapshot(envelope(1), snapshot(2))
        val stale = repository.applyMovement(MovementEvent(1, 2, 0, 0, 0, 0, 0, .9, 500, "on-track", "test"))
        assertFalse(stale.accepted)
        assertEquals("stale session revision", stale.reason)
        val outside = repository.applyMovement(MovementEvent(2, 2, 0, 0, 99, 0, 0, .9, 500, "on-track", "test"))
        assertEquals("target character outside content", outside.reason)
        assertEquals("target character outside content", repository.state.value.latestMovementRejection)
    }

    @Test fun `new runtime settings apply without changing manuscript or lease state and stale updates are ignored`() {
        val repository = SessionRepository(Files.createTempDirectory("prompter-session").toFile())
        repository.applySnapshot(envelope(1), snapshot())
        assertTrue(repository.applyRuntimeSettings(settings(2)))
        assertEquals(1L, repository.state.value.snapshot?.manuscriptRevision)
        assertEquals(2L, repository.state.value.runtimeSettings?.settingsRevision)
        assertFalse(repository.applyRuntimeSettings(settings(1)))
        assertEquals(2L, repository.state.value.runtimeSettings?.settingsRevision)
    }

    @Test fun `snapshot anchor applies once and ordinary snapshots transcripts and settings never recreate it`() {
        val repository = SessionRepository(Files.createTempDirectory("prompter-session").toFile())
        repository.applySnapshot(envelope(1), snapshot())
        val identity = requireNotNull(repository.state.value.snapshotAnchor).identity
        assertFalse(repository.state.value.snapshotAnchor!!.consumed)
        assertTrue(repository.consumeSnapshotAnchor(identity))
        repository.applySnapshot(envelope(2), snapshot())
        assertTrue(repository.state.value.snapshotAnchor!!.consumed)
        repository.applyTranscript(TranscriptEvent(1, 1, "First", true, "local-whisper", timestampMs = 1, acceptedPosition = Position(0, 0, 0, 0)))
        repository.applyRuntimeSettings(settings(2))
        assertTrue(repository.state.value.snapshotAnchor!!.consumed)
    }

    @Test fun `new narration or manuscript identity creates a fresh one-shot anchor`() {
        val repository = SessionRepository(Files.createTempDirectory("prompter-session").toFile())
        repository.applySnapshot(envelope(1), snapshot().copy(narrationSessionId = "narration-a"))
        repository.consumeSnapshotAnchor(repository.state.value.snapshotAnchor!!.identity)
        repository.applySnapshot(envelope(2), snapshot().copy(narrationSessionId = "narration-b"))
        assertFalse(repository.state.value.snapshotAnchor!!.consumed)
        repository.consumeSnapshotAnchor(repository.state.value.snapshotAnchor!!.identity)
        repository.applySnapshot(envelope(3), snapshot(2, "sha256:b").copy(narrationSessionId = "narration-b"))
        assertFalse(repository.state.value.snapshotAnchor!!.consumed)
    }

    @Test fun `ordinary newer snapshot retains the active semantic movement target`() {
        val repository = SessionRepository(Files.createTempDirectory("prompter-session").toFile())
        repository.applySnapshot(envelope(1), snapshot())
        repository.applyMovement(MovementEvent(1, 1, 0, 2, 8, 0, 0, .9, 500, "on-track", "test"))
        repository.applySnapshot(envelope(2), snapshot().copy(sessionRevision = 2))
        assertEquals(8, repository.state.value.latestMovement?.targetCharacter)
    }

    @Test fun `manual reposition acknowledgement survives the confirming snapshot`() {
        val repository = SessionRepository(Files.createTempDirectory("prompter-session").toFile())
        repository.applySnapshot(envelope(1), snapshot())
        val result = ManualRepositionResult(true, "accepted", 1, 40, 2)
        repository.applyManualRepositionResult(result)
        repository.applySnapshot(envelope(2), snapshot().copy(sessionRevision = 2))
        assertEquals(result, repository.state.value.manualRepositionResult)
    }

    @Test fun `movement diagnostics retain event identity remote status and reason`() {
        val repository = SessionRepository(Files.createTempDirectory("prompter-session").toFile())
        repository.applySnapshot(envelope(1), snapshot())
        val movement = MovementEvent(
            2, 1, 0, 0, 0, 0, 0, .9, 500, "manual scroll reacquired", "nearby speech accepted",
            "reacquired", 40, 2
        )
        assertTrue(repository.applyMovement(movement, "2:17").accepted)
        assertEquals("2:17", repository.state.value.latestMovementEventId)
        assertEquals("reacquired", repository.state.value.lastRemoteMovementStatus)
        assertEquals("nearby speech accepted", repository.state.value.lastAcceptedMovementReason)
    }

    @Test fun `repository accepted nearby manual target is not rejected by follow controller`() {
        val repository = SessionRepository(Files.createTempDirectory("prompter-session").toFile())
        repository.applySnapshot(envelope(1), snapshot())
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(TabletVisibleAnchor(121, 0, 0, 0, 0f))
        val movement = MovementEvent(
            2, 1, 12, 144, 0, 0, 0, .9, 500,
            "suspicious forward jump", "authoritative nearby target"
        )
        assertTrue(repository.applyMovement(movement, "2:20").accepted)
        assertTrue(
            controller.evaluateMovement(requireNotNull(repository.state.value.latestMovement)) is ManualMovementDecision.Resume
        )
        assertFalse(controller.isManualHoldActive())
    }
}
