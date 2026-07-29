package app.prompter.tablet.connection

import app.prompter.tablet.protocol.ManualReposition
import org.junit.Assert.*
import org.junit.Test

class ConnectionRecoveryPolicyTest {
    private fun anchor(tokenIndex: Int) = ManualReposition(
        manuscriptRevision = 1,
        visibleTokenIndex = tokenIndex,
        visibleCharacter = tokenIndex * 6,
        sentenceIndex = 10,
        paragraphIndex = 4,
        direction = "forward",
        inputSource = "touch",
        scrollContainer = "prompter-lazy-column",
        detectedAtMs = 1
    )

    @Test fun `movement before lease is ignored and later grant permits processing without a wedge`() {
        assertEquals(
            MovementLeaseDisposition.IGNORE_WHILE_WAITING_FOR_LEASE,
            movementLeaseDisposition(controllerLease = false)
        )
        assertEquals(
            MovementLeaseDisposition.PROCESS,
            movementLeaseDisposition(controllerLease = true)
        )
    }

    @Test fun `connection drop retains pending manual anchor for resend after reconnect`() {
        val tracker = PendingManualRepositionTracker()
        tracker.replace(anchor(48))
        tracker.retain("connection lost; waiting to resend after reconnect")

        assertEquals(48, tracker.payload?.visibleTokenIndex)
        assertTrue(tracker.reason!!.contains("reconnect"))
        assertTrue(tracker.acknowledge(48))
        assertNull(tracker.payload)
    }

    @Test fun `second swipe replaces queued anchor and stale acknowledgement cannot clear it`() {
        val tracker = PendingManualRepositionTracker()
        tracker.replace(anchor(48))
        tracker.replace(anchor(58))

        assertFalse(tracker.acknowledge(48))
        assertEquals(58, tracker.payload?.visibleTokenIndex)
        assertTrue(tracker.acknowledge(58))
    }

    @Test fun `foreground reconnect policy recovers disconnected reconnecting and stale connected states`() {
        assertTrue(shouldReconnectOnForeground(ConnectionState.Disconnected, socketOpen = false))
        assertTrue(shouldReconnectOnForeground(ConnectionState.Reconnecting(2, 1000), socketOpen = false))
        assertTrue(shouldReconnectOnForeground(ConnectionState.Error("network"), socketOpen = false))
        assertTrue(shouldReconnectOnForeground(ConnectionState.Connected("server", "ws://server"), socketOpen = false))
        assertFalse(shouldReconnectOnForeground(ConnectionState.Connected("server", "ws://server"), socketOpen = true))
    }

    @Test fun `audio is held until authentication lease and server stream registration all match`() {
        val base = mapOf(
            "metadataStreamId" to "stream-1",
            "requestedStreamId" to "stream-1",
            "registeredStreamId" to "stream-1"
        )
        fun reason(
            authenticated: Boolean = true,
            lease: Boolean = true,
            socketOpen: Boolean = true,
            metadata: String = base.getValue("metadataStreamId"),
            requested: String? = base.getValue("requestedStreamId"),
            registered: String? = base.getValue("registeredStreamId"),
            audioGeneration: Int? = 4,
            socketGeneration: Int? = 4
        ) = audioFrameDropReason(
            authenticated, lease, socketOpen, metadata, requested, registered, audioGeneration, socketGeneration
        )

        assertTrue(reason(authenticated = false)!!.contains("not authenticated"))
        assertTrue(reason(lease = false)!!.contains("lease"))
        assertTrue(reason(registered = null)!!.contains("not registered"))
        assertTrue(reason(audioGeneration = 3, socketGeneration = 4)!!.contains("stale audio generation"))
        assertTrue(reason(metadata = "old-stream")!!.contains("stale audio producer"))
        assertNull(reason())
    }

    @Test fun `successful audio frame logging is throttled to five second summaries`() {
        val logged = (0L until 100L).filter(::shouldLogAudioFrameProgress)
        assertEquals(listOf(0L, 24L, 49L, 74L, 99L), logged)
    }

    @Test fun `grant without acknowledged stream and connection does not make audio usable`() {
        val tracker = AudioStreamRegistrationTracker()
        tracker.begin("stream-current")
        tracker.markSent(4)

        assertEquals(
            StreamRegistrationAckDisposition.WAITING_FOR_MATCHING_ACK,
            tracker.acknowledge(
                granted = true,
                streamRegistered = false,
                acknowledgedStreamId = null,
                acknowledgedConnectionId = "server-connection",
                activeConnectionId = "server-connection"
            )
        )
        assertEquals(
            StreamRegistrationAckDisposition.WAITING_FOR_MATCHING_ACK,
            tracker.acknowledge(
                granted = true,
                streamRegistered = true,
                acknowledgedStreamId = "stream-current",
                acknowledgedConnectionId = "stale-connection",
                activeConnectionId = "server-connection"
            )
        )
        assertEquals(
            StreamRegistrationAckDisposition.REGISTERED,
            tracker.acknowledge(
                granted = true,
                streamRegistered = true,
                acknowledgedStreamId = "stream-current",
                acknowledgedConnectionId = "server-connection",
                activeConnectionId = "server-connection"
            )
        )
    }

    @Test fun `missing ack permits bounded retry then requires visible failure`() {
        val tracker = AudioStreamRegistrationTracker(maxAttempts = 3)
        tracker.begin("stream-current")
        assertTrue(tracker.shouldSend(7))
        tracker.markSent(7)
        assertTrue(tracker.canRetry())
        assertEquals(StreamRegistrationTimeoutDisposition.RETRY, tracker.timeoutDisposition())
        tracker.markSent(7)
        assertTrue(tracker.canRetry())
        tracker.markSent(7)
        assertFalse(tracker.canRetry())
        assertEquals(StreamRegistrationTimeoutDisposition.FAIL_VISIBLE, tracker.timeoutDisposition())
    }

    @Test fun `reconnect and repeated start cannot retain stale queued registration state`() {
        val tracker = AudioStreamRegistrationTracker()
        tracker.begin("stream-one")
        tracker.markSent(3)
        assertFalse(tracker.shouldSend(3))

        tracker.connectionChanged()
        assertTrue(tracker.shouldSend(4))
        tracker.markSent(4)

        tracker.begin("stream-two")
        assertEquals("stream-two", tracker.requestedStreamId)
        assertEquals(0, tracker.attempts)
        assertTrue(tracker.shouldSend(4))
        assertEquals(
            StreamRegistrationAckDisposition.WAITING_FOR_MATCHING_ACK,
            tracker.acknowledge(true, true, "stream-one", "connection-two", "connection-two")
        )
        assertEquals(
            StreamRegistrationAckDisposition.WAITING_FOR_MATCHING_ACK,
            tracker.acknowledge(false, false, "stream-one", "connection-two", "connection-two")
        )
    }
}
