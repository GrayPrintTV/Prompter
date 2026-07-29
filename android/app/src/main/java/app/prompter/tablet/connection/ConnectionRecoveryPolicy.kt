package app.prompter.tablet.connection

import app.prompter.tablet.protocol.ManualReposition

enum class MovementLeaseDisposition {
    PROCESS,
    IGNORE_WHILE_WAITING_FOR_LEASE
}

fun movementLeaseDisposition(controllerLease: Boolean) =
    if (controllerLease) MovementLeaseDisposition.PROCESS
    else MovementLeaseDisposition.IGNORE_WHILE_WAITING_FOR_LEASE

fun shouldReconnectOnForeground(state: ConnectionState, socketOpen: Boolean) =
    state !is ConnectionState.Connected || !socketOpen

fun audioFrameDropReason(
    authenticated: Boolean,
    controllerLease: Boolean,
    socketOpen: Boolean,
    metadataStreamId: String,
    requestedStreamId: String?,
    registeredStreamId: String?,
    activeAudioGeneration: Int?,
    currentSocketGeneration: Int?
): String? = when {
    !socketOpen -> "WebSocket is not open"
    !authenticated -> "socket is not authenticated"
    !controllerLease -> "controller lease is not granted"
    requestedStreamId == null -> "no requested streamId"
    metadataStreamId != requestedStreamId -> "stale audio producer streamId $metadataStreamId; requested stream is $requestedStreamId"
    registeredStreamId == null -> "streamId $metadataStreamId is not registered by the server"
    metadataStreamId != registeredStreamId -> "streamId $metadataStreamId does not match registered stream $registeredStreamId"
    activeAudioGeneration == null -> "audio stream has no registered socket generation"
    currentSocketGeneration == null -> "WebSocket has no open generation"
    activeAudioGeneration != currentSocketGeneration -> "stale audio generation $activeAudioGeneration; active socket generation is $currentSocketGeneration"
    else -> null
}

fun shouldLogAudioFrameProgress(sequence: Long, intervalFrames: Long = 25) =
    sequence == 0L || (sequence + 1L) % intervalFrames == 0L

enum class StreamRegistrationAckDisposition {
    REGISTERED,
    WAITING_FOR_MATCHING_ACK,
    REJECTED
}

enum class StreamRegistrationTimeoutDisposition {
    RETRY,
    FAIL_VISIBLE
}

class AudioStreamRegistrationTracker(private val maxAttempts: Int = 3) {
    var requestedStreamId: String? = null
        private set
    var sentGeneration: Int? = null
        private set
    var attempts: Int = 0
        private set

    fun begin(streamId: String) {
        requestedStreamId = streamId
        sentGeneration = null
        attempts = 0
    }

    fun clear() {
        requestedStreamId = null
        sentGeneration = null
        attempts = 0
    }

    fun connectionChanged() {
        sentGeneration = null
        attempts = 0
    }

    fun shouldSend(generation: Int, force: Boolean = false) =
        requestedStreamId != null && (force || sentGeneration != generation)

    fun markSent(generation: Int): Int {
        sentGeneration = generation
        attempts += 1
        return attempts
    }

    fun canRetry() = attempts < maxAttempts

    fun timeoutDisposition() =
        if (canRetry()) StreamRegistrationTimeoutDisposition.RETRY
        else StreamRegistrationTimeoutDisposition.FAIL_VISIBLE

    fun resetAttemptsForUserRetry() {
        sentGeneration = null
        attempts = 0
    }

    fun acknowledge(
        granted: Boolean,
        streamRegistered: Boolean,
        acknowledgedStreamId: String?,
        acknowledgedConnectionId: String?,
        activeConnectionId: String
    ): StreamRegistrationAckDisposition {
        val requested = requestedStreamId ?: return StreamRegistrationAckDisposition.WAITING_FOR_MATCHING_ACK
        if (!granted) {
            val appliesToCurrentRequest =
                acknowledgedConnectionId == activeConnectionId &&
                (acknowledgedStreamId == null || acknowledgedStreamId == requested)
            return if (appliesToCurrentRequest) StreamRegistrationAckDisposition.REJECTED
            else StreamRegistrationAckDisposition.WAITING_FOR_MATCHING_ACK
        }
        if (!streamRegistered) return StreamRegistrationAckDisposition.WAITING_FOR_MATCHING_ACK
        return if (
            acknowledgedStreamId == requested &&
            acknowledgedConnectionId == activeConnectionId
        ) StreamRegistrationAckDisposition.REGISTERED
        else StreamRegistrationAckDisposition.WAITING_FOR_MATCHING_ACK
    }
}

class PendingManualRepositionTracker {
    var payload: ManualReposition? = null
        private set
    var reason: String? = null
        private set

    fun replace(next: ManualReposition) {
        payload = next
        reason = null
    }

    fun retain(reason: String) {
        if (payload != null) this.reason = reason
    }

    fun acknowledge(tokenIndex: Int): Boolean {
        if (payload?.visibleTokenIndex != tokenIndex) return false
        clear()
        return true
    }

    fun clear() {
        payload = null
        reason = null
    }
}
