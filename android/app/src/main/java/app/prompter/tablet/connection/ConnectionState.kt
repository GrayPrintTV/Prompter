package app.prompter.tablet.connection

import app.prompter.tablet.protocol.BuildIdentityPayload

sealed interface ConnectionState {
    data object Disconnected : ConnectionState
    data class Connecting(val endpoint: String) : ConnectionState
    data object AwaitingChallenge : ConnectionState
    data class PairingPending(val serverName: String) : ConnectionState
    data object Authenticating : ConnectionState
    data class Connected(val serverId: String, val endpoint: String) : ConnectionState
    data class Reconnecting(val attempt: Int, val delayMs: Long) : ConnectionState
    data class Error(val message: String) : ConnectionState
}

enum class ControllerLeaseState {
    NOT_REQUESTED,
    REQUESTING,
    LEASE_GRANTED_NO_STREAM,
    STREAM_REGISTRATION_PENDING,
    STREAM_REGISTRATION_FAILED,
    GRANTED,
    REVOKED
}

sealed interface ManualRepositionSendOutcome {
    data object Sent : ManualRepositionSendOutcome
    data class Queued(val reason: String) : ManualRepositionSendOutcome
    data class Failed(val reason: String) : ManualRepositionSendOutcome
}

data class ConnectionDiagnostics(
    val reconnectCount: Int = 0,
    val authenticationState: String = "not-authenticated",
    val resolvedAddress: String? = null,
    val port: Int? = null,
    val lastError: String? = null,
    val controllerLease: Boolean = false,
    val controllerLeaseState: ControllerLeaseState = ControllerLeaseState.NOT_REQUESTED,
    val registeredAudioStreamId: String? = null,
    val audioSocketGeneration: Int? = null,
    val serverAudioConnectionGeneration: String? = null,
    val streamRegistrationAttempts: Int = 0,
    val lastStateTransitionCause: String? = null,
    val appLifecycleState: String = "foreground",
    val pendingManualAnchorTokenIndex: Int? = null,
    val pendingManualAnchorReason: String? = null,
    val serverProtocolMajor: Int? = null,
    val serverProtocolMinor: Int? = null,
    val serverBuild: BuildIdentityPayload? = null,
    val serverStartedAtMs: Long? = null,
    val cleartextWarning: String = "Manuscript and microphone audio are authenticated but not encrypted in transit."
)
