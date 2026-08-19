package app.prompter.tablet.connection

import app.prompter.tablet.AppBuildIdentity
import app.prompter.tablet.discovery.DiscoveredServer
import app.prompter.tablet.diagnostics.DiagnosticLogger
import app.prompter.tablet.protocol.*
import app.prompter.tablet.security.Authentication
import app.prompter.tablet.security.CredentialStore
import app.prompter.tablet.security.PairedServerStore
import app.prompter.tablet.session.SessionRepository
import app.prompter.tablet.session.SnapshotSyncAssembler
import java.net.Inet4Address
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer

class PrompterConnectionRepository(
    private val scope: CoroutineScope,
    private val socket: WebSocketClient,
    private val codec: ProtocolCodec,
    private val credentials: CredentialStore,
    private val pairedServers: PairedServerStore,
    private val sessions: SessionRepository,
    private val deviceId: () -> String,
    private val log: DiagnosticLogger,
    private val networkPreflight: NetworkPreflight,
    private val reconnectPolicy: ReconnectPolicy = ReconnectPolicy(),
    private val streamRegistrationAckTimeoutMs: Long = 1_500
) : WebSocketEvents {
    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()
    private val _diagnostics = MutableStateFlow(ConnectionDiagnostics())
    val diagnostics: StateFlow<ConnectionDiagnostics> = _diagnostics.asStateFlow()

    private var server: DiscoveredServer? = null
    private var pendingPair: PairRequest? = null
    private var manualDisconnect = false
    private var reconnectJob: Job? = null
    private var authTimeout: Job? = null
    private var streamRegistrationTimeout: Job? = null
    private var reconnectAttempt = 0
    private val outgoingSequence = AtomicLong(0)
    private val outgoingSendLock = Any()
    private var incomingSequence = -1L
    private var connectionId = "android-${UUID.randomUUID()}"
    private var sessionId = "android-pending"
    @Volatile private var authenticated = false
    private var suppressReconnectOnce = false
    @Volatile private var socketOpen = false
    private var appForeground = true
    @Volatile private var desiredControllerRequest: AudioStreamStart? = null
    @Volatile private var registeredAudioStreamId: String? = null
    @Volatile private var activeAudioGeneration: Int? = null
    private val streamRegistration = AudioStreamRegistrationTracker()
    private val pendingManualReposition = PendingManualRepositionTracker()
    private val snapshotSync = SnapshotSyncAssembler()

    fun pair(target: DiscoveredServer, request: PairRequest) {
        log.record("pairing", "info", "pairing.user.requested", "User requested pairing.", deviceId = request.deviceId, serverId = target.serverId, remoteAddress = target.endpoint, details = mapOf("source" to if (target.manual) "manual" else "discovery", "hasCode" to (request.pairingCode != null).toString()))
        pendingPair = request
        connectInternal(target)
    }

    fun connect(target: DiscoveredServer) {
        log.record("connection", "info", "connection.user.requested", "User requested connection.", serverId = target.serverId, remoteAddress = target.endpoint, details = mapOf("source" to if (target.manual) "manual" else "discovery"))
        pendingPair = null
        connectInternal(target)
    }

    fun disconnect() {
        manualDisconnect = true
        reconnectJob?.cancel(); authTimeout?.cancel(); streamRegistrationTimeout?.cancel(); socket.close()
        authenticated = false; socketOpen = false
        desiredControllerRequest = null
        registeredAudioStreamId = null
        activeAudioGeneration = null
        streamRegistration.clear()
        pendingManualReposition.clear()
        snapshotSync.clear()
        transition(ConnectionState.Disconnected, "user requested disconnect")
        _diagnostics.value = _diagnostics.value.copy(
            controllerLease = false,
            controllerLeaseState = ControllerLeaseState.NOT_REQUESTED,
            registeredAudioStreamId = null,
            audioSocketGeneration = null,
            serverAudioConnectionGeneration = null,
            streamRegistrationAttempts = 0,
            pendingManualAnchorTokenIndex = null,
            pendingManualAnchorReason = null
        )
        sessions.markDisconnected()
    }

    fun reconnectNow(cause: String = "user requested reconnect") {
        val target = server ?: return
        reconnectJob?.cancel()
        log.record("connection", "info", "android.connection.reconnect_requested", "Immediate reconnect requested.", connectionId = connectionId, serverId = target.serverId, details = mapOf("cause" to cause, "previousState" to stateName(_state.value)))
        connectInternal(target, cause)
    }

    @Synchronized
    fun requestController(streamId: String, sampleRate: Int): Boolean {
        val request = AudioStreamStart(
        streamId = streamId, sampleRate = sampleRate, sequenceStart = 0, captureTimestampMs = System.currentTimeMillis(), frameDurationMs = 200
        )
        desiredControllerRequest = request
        registeredAudioStreamId = null
        activeAudioGeneration = null
        streamRegistrationTimeout?.cancel()
        streamRegistration.begin(streamId)
        _diagnostics.value = _diagnostics.value.copy(
            controllerLeaseState = ControllerLeaseState.REQUESTING,
            registeredAudioStreamId = null,
            audioSocketGeneration = null,
            serverAudioConnectionGeneration = null,
            streamRegistrationAttempts = 0,
            lastError = null
        )
        log.record("connection", "info", "android.controller.lease_requested", "Tablet requested the controller lease.", connectionId = connectionId, details = mapOf("streamId" to streamId, "sampleRate" to sampleRate.toString(), "authenticated" to authenticated.toString(), "socketOpen" to socketOpen.toString()))
        return sendControllerRequestIfReady("start microphone")
    }

    @Synchronized
    fun stopController(streamId: String, lastSequence: Long): Boolean {
        desiredControllerRequest = null
        registeredAudioStreamId = null
        activeAudioGeneration = null
        streamRegistrationTimeout?.cancel()
        streamRegistration.clear()
        _diagnostics.value = _diagnostics.value.copy(
            controllerLease = false,
            controllerLeaseState = ControllerLeaseState.NOT_REQUESTED,
            registeredAudioStreamId = null,
            audioSocketGeneration = null,
            serverAudioConnectionGeneration = null,
            streamRegistrationAttempts = 0
        )
        log.record("connection", "info", "android.controller.lease_release_requested", "Tablet released the controller lease.", connectionId = connectionId, details = mapOf("streamId" to streamId, "lastSequence" to lastSequence.toString()))
        return send(
            "audioStreamStop", AudioStreamStop(streamId = streamId, lastSequence = lastSequence, captureTimestampMs = System.currentTimeMillis()), AudioStreamStop.serializer()
        )
    }

    fun sendAudio(metadata: AudioFrameMetadata, pcm: ByteArray): Boolean {
        val requestedStreamId = desiredControllerRequest?.streamId
        val currentSocketGeneration = socket.currentOpenGeneration()
        val dropReason = audioFrameDropReason(
            authenticated = authenticated,
            controllerLease = _diagnostics.value.controllerLease,
            socketOpen = socketOpen,
            metadataStreamId = metadata.streamId,
            requestedStreamId = requestedStreamId,
            registeredStreamId = registeredAudioStreamId,
            activeAudioGeneration = activeAudioGeneration,
            currentSocketGeneration = currentSocketGeneration
        )
        if (dropReason != null) {
            logAudioDrop(metadata, dropReason, currentSocketGeneration)
            return false
        }
        val target = server ?: run {
            logAudioDrop(metadata, "no server target", currentSocketGeneration)
            return false
        }
        val generation = activeAudioGeneration ?: run {
            logAudioDrop(metadata, "no registered audio socket generation", currentSocketGeneration)
            return false
        }
        val result = synchronized(outgoingSendLock) {
            val text = codec.encodeEnvelope(
                "audioFrameMetadata",
                metadata,
                AudioFrameMetadata.serializer(),
                target.serverId,
                sessionId,
                connectionId,
                outgoingSequence.getAndIncrement()
            )
            socket.sendAudioPair(text, pcm, generation)
        }
        if (!result.sent) {
            logAudioDrop(metadata, result.reason, result.generation)
            return false
        }
        if (shouldLogAudioFrameProgress(metadata.sequence)) {
            log.record(
                "audio", "debug", "android.audio.frames_progress",
                "Audio streaming remains active; metadata and PCM are being queued on the registered WebSocket generation.",
                connectionId = connectionId,
                details = mapOf(
                    "streamId" to metadata.streamId,
                    "audioSequence" to metadata.sequence.toString(),
                    "socketGeneration" to generation.toString()
                )
            )
        }
        return true
    }

    fun requestSnapshot() = send("requestSnapshot", RequestSnapshot(), RequestSnapshot.serializer())

    fun sendManualReposition(payload: ManualReposition): ManualRepositionSendOutcome {
        pendingManualReposition.replace(payload)
        _diagnostics.value = _diagnostics.value.copy(
            pendingManualAnchorTokenIndex = payload.visibleTokenIndex,
            pendingManualAnchorReason = null
        )
        if (authenticated && socketOpen && _diagnostics.value.controllerLease) {
            if (sendPendingManualReposition("manual anchor selected")) return ManualRepositionSendOutcome.Sent
        }
        val reason = manualRepositionUnavailableReason()
        if (!manualDisconnect && server != null && _state.value !is ConnectionState.Error) {
            _diagnostics.value = _diagnostics.value.copy(pendingManualAnchorReason = reason)
            log.record("movement", "warn", "android.manual_scroll.anchor_queued", "Manual anchor queued until connection and controller lease recover.", connectionId = connectionId, details = mapOf("visibleTokenIndex" to payload.visibleTokenIndex.toString(), "reason" to reason, "connectionState" to stateName(_state.value)))
            if (_state.value is ConnectionState.Disconnected) reconnectNow("manual anchor queued while disconnected")
            return ManualRepositionSendOutcome.Queued(reason)
        }
            pendingManualReposition.clear()
        _diagnostics.value = _diagnostics.value.copy(pendingManualAnchorTokenIndex = null, pendingManualAnchorReason = reason)
        return ManualRepositionSendOutcome.Failed(reason)
    }

    fun sendManualFollowDiagnostic(payload: ManualFollowDiagnostic): Boolean {
        if (!authenticated) return false
        return send("manualFollowDiagnostic", payload, ManualFollowDiagnostic.serializer())
    }

    override fun onOpen() {
        socketOpen = true
        log.record("connection", "info", "connection.awaiting_challenge", "WebSocket open; waiting for server challenge.", connectionId = connectionId, webSocketState = "OPEN")
        transition(ConnectionState.AwaitingChallenge, "WebSocket opened")
        authTimeout?.cancel()
        authTimeout = scope.launch {
            delay(10_000)
            if (!authenticated) { val reason = "Timed out waiting for server challenge or authentication."; log.record("authentication", "error", "authentication.timeout", reason, connectionId = connectionId); _diagnostics.value = _diagnostics.value.copy(lastError = reason); transition(ConnectionState.Error(reason), "authentication timeout"); socket.close() }
        }
    }

    override fun onText(text: String) {
      try {
        runCatching { codec.decodeEnvelope(text) }.onFailure {
            log.record("protocol", "error", "protocol.message.invalid", "Incoming JSON/envelope could not be decoded.", connectionId = connectionId, throwable = it)
            transition(ConnectionState.Error(it.message ?: "Invalid protocol message."), "incoming protocol decode failed")
            throw it
        }.onSuccess { envelope ->
            _diagnostics.value = _diagnostics.value.copy(
                serverProtocolMajor = envelope.protocolMajor,
                serverProtocolMinor = envelope.protocolMinor
            )
            log.record("protocol", "debug", "protocol.message.decoded", "Incoming envelope decoded.", connectionId = envelope.connectionId, serverId = envelope.serverId, protocolMessageType = envelope.type, details = mapOf("sequence" to envelope.sequence.toString()))
            if (envelope.sequence <= incomingSequence) {
                if (envelope.type == "movementEvent") { sessions.recordMovementRejection("stale or duplicate sequence"); log.record("movement", "warn", "android.movement.rejected", "Semantic movement rejected: stale or duplicate connection sequence.", connectionId = envelope.connectionId, protocolMessageType = envelope.type, details = mapOf("sequence" to envelope.sequence.toString(), "lastSequence" to incomingSequence.toString())) }
                return
            }
            if (incomingSequence >= 0 && envelope.sequence > incomingSequence + 1 && envelope.type !in setOf("serverChallenge", "sessionSnapshot")) {
                if (envelope.type == "movementEvent") { sessions.recordMovementRejection("sequence gap"); log.record("movement", "warn", "android.movement.rejected", "Semantic movement rejected: connection sequence gap.", connectionId = envelope.connectionId, protocolMessageType = envelope.type, details = mapOf("sequence" to envelope.sequence.toString(), "lastSequence" to incomingSequence.toString())) }
                sessions.markDisconnected(); requestSnapshot(); incomingSequence = envelope.sequence; return
            }
            incomingSequence = envelope.sequence
            connectionId = envelope.connectionId
            sessionId = envelope.sessionId
            when (envelope.type) {
                "serverChallenge" -> handleChallenge(envelope)
                "pairCredential" -> handlePairCredential(envelope)
                "pairDenied", "authenticationFailed", "protocolError" -> handleError(envelope)
                "authenticated" -> {
                    authenticated = true; authTimeout?.cancel(); reconnectAttempt = 0
                    val target = server ?: return
                    transition(ConnectionState.Connected(envelope.serverId, target.endpoint), "server authenticated tablet")
                    _diagnostics.value = _diagnostics.value.copy(authenticationState = "authenticated", lastError = null)
                    log.record(
                        "connection", "info", "android.connection.authenticated",
                        "Authenticated to server ${envelope.serverId}.",
                        connectionId = envelope.connectionId,
                        serverId = envelope.serverId,
                        details = mapOf(
                            "clientBuild" to AppBuildIdentity.summary(),
                            "serverProtocol" to "${envelope.protocolMajor}.${envelope.protocolMinor}",
                            "controllerLease" to _diagnostics.value.controllerLease.toString()
                        )
                    )
                    scope.launch { pairedServers.markConnected(System.currentTimeMillis()) }
                    sendControllerRequestIfReady("authentication completed")
                }
                "sessionSnapshot" -> sessions.applySnapshot(envelope, codec.decodePayload(envelope))
                "sessionState" -> sessions.applyState(envelope, codec.decodePayload(envelope))
                "sessionSnapshotStart" -> snapshotSync.begin(codec.decodePayload<SessionSnapshotStart>(envelope))
                "manuscriptContentChunk" -> snapshotSync.append(codec.decodePayload<ManuscriptContentChunk>(envelope))
                "manuscriptParagraphChunk" -> snapshotSync.append(codec.decodePayload<ManuscriptParagraphChunk>(envelope))
                "manuscriptTokenChunk" -> snapshotSync.append(codec.decodePayload<ManuscriptTokenChunk>(envelope))
                "sessionSnapshotComplete" -> sessions.applySnapshot(envelope, snapshotSync.complete(codec.decodePayload<SessionSnapshotComplete>(envelope)))
                "runtimeSettings" -> {
                    val settings = codec.decodePayload<RuntimeSettings>(envelope)
                    if (sessions.applyRuntimeSettings(settings)) log.record("settings", "info", "android.runtime_settings.received", "Live Windows runtime settings received.", connectionId = envelope.connectionId, details = mapOf("settingsRevision" to settings.settingsRevision.toString()))
                    else log.record("settings", "warn", "android.runtime_settings.rejected", "Stale runtime settings ignored.", connectionId = envelope.connectionId, details = mapOf("settingsRevision" to settings.settingsRevision.toString()))
                }
                "transcriptEvent" -> if (sessions.acceptIncremental(envelope)) sessions.applyTranscript(codec.decodePayload(envelope))
                "movementEvent" -> {
                    val movement = codec.decodePayload<MovementEvent>(envelope)
                    log.record("movement", "info", "android.movement.received", "Semantic movement event received.", connectionId = envelope.connectionId, serverId = envelope.serverId, protocolMessageType = envelope.type, details = mapOf(
                        "sequence" to envelope.sequence.toString(),
                        "eventId" to "${movement.sessionRevision}:${envelope.sequence}",
                        "sessionRevision" to movement.sessionRevision.toString(),
                        "manuscriptRevision" to movement.manuscriptRevision.toString(),
                        "targetTokenIndex" to movement.targetTokenIndex.toString(),
                        "targetCharacter" to movement.targetCharacter.toString(),
                        "sentenceIndex" to movement.sentenceIndex.toString(),
                        "paragraphIndex" to movement.paragraphIndex.toString(),
                        "classification" to movement.classification,
                        "manualStatus" to (movement.manualRepositionStatus ?: "normal"),
                        "manualAnchorTokenIndex" to (movement.manualAnchorTokenIndex?.toString() ?: "none"),
                        "manualAnchorDistanceTokens" to (movement.manualAnchorDistanceTokens?.toString() ?: "none")
                    ))
                    if (movementLeaseDisposition(_diagnostics.value.controllerLease) == MovementLeaseDisposition.IGNORE_WHILE_WAITING_FOR_LEASE) {
                        log.record("movement", "info", "android.movement.before_lease", "Movement arrived before the controller lease; ignored while waiting for control.", connectionId = envelope.connectionId, details = mapOf("sequence" to envelope.sequence.toString(), "leaseState" to _diagnostics.value.controllerLeaseState.name, "wedged" to "false"))
                    } else {
                        val decision = sessions.evaluateIncremental(envelope)
                          if (decision.accepted) sessions.applyMovement(movement, "${movement.sessionRevision}:${envelope.sequence}")
                        else { sessions.recordMovementRejection(decision.reason ?: "unknown"); log.record("movement", "warn", "android.movement.rejected", "Semantic movement rejected: ${decision.reason}.", connectionId = envelope.connectionId, details = mapOf("reason" to (decision.reason ?: "unknown"))) }
                    }
                }
                  "manualRepositionAccepted" -> {
                      val result = codec.decodePayload<ManualRepositionResult>(envelope)
                      if (pendingManualReposition.acknowledge(result.visibleTokenIndex)) {
                          _diagnostics.value = _diagnostics.value.copy(
                              pendingManualAnchorTokenIndex = null,
                              pendingManualAnchorReason = null
                          )
                      }
                      sessions.applyManualRepositionResult(result)
                      log.record(
                        "movement",
                        if (result.accepted) "info" else "warn",
                        if (result.accepted) "android.manual_scroll.coordinator_accepted" else "android.manual_scroll.coordinator_rejected",
                        result.reason,
                        connectionId = envelope.connectionId,
                        details = mapOf(
                            "visibleTokenIndex" to result.visibleTokenIndex.toString(),
                            "manuscriptRevision" to result.manuscriptRevision.toString(),
                            "sessionRevision" to result.sessionRevision.toString(),
                            "snapbackPrevented" to result.accepted.toString()
                        )
                    )
                }
                "controllerLease" -> {
                    sessions.recordControlEnvelope(envelope)
                    val lease = codec.decodePayload<ControllerLeaseResult>(envelope)
                    val requestedStreamId = desiredControllerRequest?.streamId
                    val acknowledgement = streamRegistration.acknowledge(
                        granted = lease.granted,
                        streamRegistered = lease.streamRegistered == true,
                        acknowledgedStreamId = lease.streamId,
                        acknowledgedConnectionId = lease.connectionGeneration,
                        activeConnectionId = envelope.connectionId
                    )
                    val staleStreamAcknowledgement =
                        lease.streamId != null &&
                        requestedStreamId != null &&
                        lease.streamId != requestedStreamId
                    val controllerLeaseGranted = if (staleStreamAcknowledgement) {
                        _diagnostics.value.controllerLease
                    } else {
                        lease.granted
                    }
                    val acknowledgedSocketGeneration = socket.currentOpenGeneration()
                    val streamRegistered =
                        acknowledgement == StreamRegistrationAckDisposition.REGISTERED &&
                        acknowledgedSocketGeneration != null
                    if (streamRegistered) {
                        registeredAudioStreamId = lease.streamId
                        activeAudioGeneration = acknowledgedSocketGeneration
                        streamRegistrationTimeout?.cancel()
                    } else {
                        registeredAudioStreamId = null
                        activeAudioGeneration = null
                    }
                    val leaseState = when {
                        streamRegistered -> ControllerLeaseState.GRANTED
                        acknowledgement == StreamRegistrationAckDisposition.REJECTED ->
                            ControllerLeaseState.STREAM_REGISTRATION_FAILED
                        controllerLeaseGranted && requestedStreamId != null ->
                            ControllerLeaseState.STREAM_REGISTRATION_PENDING
                        controllerLeaseGranted -> ControllerLeaseState.LEASE_GRANTED_NO_STREAM
                        else -> ControllerLeaseState.REVOKED
                    }
                    val registrationError = if (acknowledgement == StreamRegistrationAckDisposition.REJECTED) {
                        lease.reason ?: "Server rejected audio stream registration for ${requestedStreamId ?: "the requested stream"}."
                    } else null
                    _diagnostics.value = _diagnostics.value.copy(
                        controllerLease = controllerLeaseGranted,
                        controllerLeaseState = leaseState,
                        registeredAudioStreamId = registeredAudioStreamId,
                        audioSocketGeneration = activeAudioGeneration,
                        serverAudioConnectionGeneration = if (streamRegistered) lease.connectionGeneration else null,
                        streamRegistrationAttempts = streamRegistration.attempts,
                        lastError = registrationError ?: if (streamRegistered) null else _diagnostics.value.lastError
                    )
                    log.record(
                        "connection", if (streamRegistered || lease.granted) "info" else "warn", "android.controller.lease",
                        when {
                            streamRegistered -> "Tablet controller lease and matching audio stream registration granted."
                            lease.granted -> "Tablet controller lease granted; matching audio stream registration is still pending."
                            else -> "Tablet controller lease or stream registration was not granted."
                        },
                        connectionId = envelope.connectionId,
                        details = mapOf(
                            "granted" to lease.granted.toString(),
                            "deviceId" to lease.deviceId,
                            "cause" to (lease.reason ?: if (lease.granted) "server grant" else "server revoke"),
                            "acknowledgedStreamId" to (lease.streamId ?: "none"),
                            "requestedStreamId" to (requestedStreamId ?: "none"),
                            "streamRegistered" to streamRegistered.toString(),
                            "socketGeneration" to (activeAudioGeneration?.toString() ?: "none"),
                            "acknowledgedConnectionGeneration" to (lease.connectionGeneration ?: "none"),
                            "serverStreamRegistered" to (lease.streamRegistered?.toString() ?: "none"),
                            "registrationState" to leaseState.name,
                            "registrationAttempts" to streamRegistration.attempts.toString()
                        )
                    )
                    if (streamRegistered) {
                        sendPendingManualReposition("controller lease granted")
                    } else if (controllerLeaseGranted && requestedStreamId != null) {
                        sendControllerRequestIfReady("controller lease granted before matching stream registration")
                    } else if (acknowledgement == StreamRegistrationAckDisposition.REJECTED) {
                        streamRegistrationTimeout?.cancel()
                    }
                }
                "serverShutdown" -> { sessions.markDisconnected(); _diagnostics.value = _diagnostics.value.copy(lastError = "Windows server was disabled.") }
            }
        }
      } catch (error: Exception) {
          snapshotSync.clear()
          val reason = error.message ?: "Unsupported inbound protocol message."
          log.record("protocol", "error", "protocol.message.rejected", "Inbound message was rejected without further parsing.", connectionId = connectionId, throwable = error, details = mapOf("reason" to reason.take(200)))
          transition(ConnectionState.Error(reason), "incoming protocol message rejected")
          socket.rejectProtocolMessage("Unsupported or oversized message")
      }
    }

    override fun onClosing(code: Int, reason: String) {
        val concrete = "Server closing WebSocket: $code ${reason.ifBlank { "(no reason)" }}"
        socketOpen = false
        registeredAudioStreamId = null
        activeAudioGeneration = null
        streamRegistrationTimeout?.cancel()
        _diagnostics.value = _diagnostics.value.copy(
            lastError = concrete,
            registeredAudioStreamId = null,
            audioSocketGeneration = null,
            serverAudioConnectionGeneration = null
        )
        log.record("connection", "warn", "android.connection.websocket_closing", concrete, connectionId = connectionId, webSocketState = "CLOSING", closeCode = code, closeReason = reason, details = mapOf("appLifecycle" to if (appForeground) "foreground" else "background"))
    }
    override fun onClosed(code: Int, reason: String) = lost("Server closed: $code ${reason.ifBlank { "(no reason)" }}")
    override fun onFailure(message: String, exceptionClass: String, httpCode: Int?, responseSummary: String?) {
        val concrete = when {
            httpCode != null -> "WebSocket rejected: HTTP $httpCode${responseSummary?.let { " ($it)" } ?: ""}"
            message.contains("CLEARTEXT", true) -> "Cleartext connection blocked by Android: $message"
            else -> "$exceptionClass: $message"
        }
        lost(concrete)
    }

    fun onAppForeground(cause: String) {
        appForeground = true
        _diagnostics.value = _diagnostics.value.copy(appLifecycleState = "foreground")
        log.record("lifecycle", "info", "android.lifecycle.foreground", "Android app entered foreground.", connectionId = connectionId, details = mapOf("cause" to cause, "connectionState" to stateName(_state.value), "socketOpen" to socketOpen.toString(), "controllerLease" to _diagnostics.value.controllerLease.toString()))
        if (shouldReconnectOnForeground(_state.value, socketOpen)) reconnectNow("app returned foreground")
        else sendControllerRequestIfReady("app returned foreground")
    }

    fun onAppBackground(cause: String) {
        appForeground = false
        _diagnostics.value = _diagnostics.value.copy(appLifecycleState = "background")
        log.record("lifecycle", "warn", "android.lifecycle.background", "Android app entered background; connection remains observable while audio is paused by the UI.", connectionId = connectionId, details = mapOf("cause" to cause, "connectionState" to stateName(_state.value), "socketOpen" to socketOpen.toString(), "controllerLease" to _diagnostics.value.controllerLease.toString()))
    }

    fun logLifecycleTransition(event: String, cause: String) {
        log.record("lifecycle", "info", event, "Android activity lifecycle transition.", connectionId = connectionId, details = mapOf("cause" to cause, "connectionState" to stateName(_state.value), "socketOpen" to socketOpen.toString(), "controllerLease" to _diagnostics.value.controllerLease.toString()))
    }

    private fun connectInternal(target: DiscoveredServer, cause: String = "connect requested") {
        suppressReconnectOnce = false
        networkPreflight.failureReason()?.let { reason ->
            log.record("network", "error", "network.preflight.failed", reason, serverId = target.serverId, remoteAddress = target.endpoint)
            _diagnostics.value = _diagnostics.value.copy(resolvedAddress = target.host, port = target.port, lastError = reason)
            transition(ConnectionState.Error(reason), "network preflight failed")
            return
        }
        runCatching { requirePrivateIpv4(target.host) }.onFailure {
            transition(ConnectionState.Error(it.message ?: "Only private IPv4 servers are allowed."), "server address rejected"); return
        }
        server = target
        manualDisconnect = false; authenticated = false; socketOpen = false; outgoingSequence.set(0); incomingSequence = -1
        snapshotSync.clear()
        registeredAudioStreamId = null
        activeAudioGeneration = null
        streamRegistrationTimeout?.cancel()
        streamRegistration.connectionChanged()
        connectionId = "android-${UUID.randomUUID()}"; sessionId = "android-pending"
        transition(ConnectionState.Connecting(target.endpoint), cause)
        _diagnostics.value = _diagnostics.value.copy(
            resolvedAddress = target.host,
            port = target.port,
            controllerLease = false,
            controllerLeaseState = if (desiredControllerRequest == null) ControllerLeaseState.NOT_REQUESTED else ControllerLeaseState.REQUESTING,
            registeredAudioStreamId = null,
            audioSocketGeneration = null,
            serverAudioConnectionGeneration = null,
            streamRegistrationAttempts = 0,
            serverProtocolMajor = target.protocolMajor,
            serverProtocolMinor = target.protocolMinor,
            serverBuild = null,
            serverStartedAtMs = null
        )
        log.record("connection", "info", "connection.endpoint.selected", "Server endpoint selected.", connectionId = connectionId, serverId = target.serverId, remoteAddress = target.endpoint, webSocketState = "CONNECTING", details = mapOf("path" to "/", "source" to if (target.manual) "manual" else "discovery"))
        socket.connect(target.endpoint, this)
    }

    private fun handleChallenge(envelope: ProtocolEnvelope) {
        val challenge = codec.decodePayload<ServerChallenge>(envelope)
        _diagnostics.value = _diagnostics.value.copy(
            serverProtocolMajor = challenge.protocolMajor ?: envelope.protocolMajor,
            serverProtocolMinor = challenge.protocolMinor ?: envelope.protocolMinor,
            serverBuild = challenge.serverBuild,
            serverStartedAtMs = challenge.serverStartedAtMs
        )
        val serverBuild = challenge.serverBuild
        log.record(
            "connection", "info", "android.server.identity",
            "Server challenge identifies protocol ${challenge.protocolMajor ?: envelope.protocolMajor}.${challenge.protocolMinor ?: envelope.protocolMinor}, build ${serverBuild?.versionName ?: "unavailable"}.",
            connectionId = envelope.connectionId,
            serverId = challenge.serverId,
            details = mapOf(
                "serverVersion" to (serverBuild?.versionName ?: "unavailable"),
                "serverBuildTimestamp" to (serverBuild?.buildTimestamp ?: "unavailable"),
                "serverGitHash" to (serverBuild?.gitHash ?: "unavailable"),
                "serverDirty" to (serverBuild?.dirty?.toString() ?: "unavailable"),
                "serverProtocol" to "${challenge.protocolMajor ?: envelope.protocolMajor}.${challenge.protocolMinor ?: envelope.protocolMinor}",
                "serverStartedAtMs" to (challenge.serverStartedAtMs?.toString() ?: "unavailable"),
                "clientBuild" to AppBuildIdentity.summary()
            )
        )
        if (kotlin.math.abs(System.currentTimeMillis() - challenge.issuedAtMs) > 30_000) {
            transition(ConnectionState.Error("Server authentication challenge is stale."), "stale server challenge")
            socket.close(); return
        }
        val target = server ?: return
        server = target.copy(serverId = challenge.serverId)
        pendingPair?.let { request ->
            transition(ConnectionState.PairingPending(target.displayName), "pair request sent")
            log.record("pairing", "info", "pairing.request.sending", "Sending pairRequest after server challenge.", connectionId = envelope.connectionId, deviceId = request.deviceId, serverId = challenge.serverId, protocolMessageType = "pairRequest", details = mapOf("hasCode" to (request.pairingCode != null).toString()))
            send("pairRequest", request, PairRequest.serializer(), challenge.serverId)
            return
        }
        val credential = credentials.load(challenge.serverId)
        if (credential == null) {
            transition(ConnectionState.Error("This server is not paired on this tablet."), "paired credential missing")
            socket.close(); return
        }
        val nonce = UUID.randomUUID().toString()
        transition(ConnectionState.Authenticating, "authentication response sent")
        log.record("authentication", "info", "authentication.response.sending", "Sending challenge authentication response.", connectionId = envelope.connectionId, deviceId = deviceId(), serverId = challenge.serverId, protocolMessageType = "authenticate")
        _diagnostics.value = _diagnostics.value.copy(authenticationState = "authenticating")
        send("authenticate", Authenticate(
            deviceId = deviceId(), clientNonce = nonce, timestampMs = System.currentTimeMillis(),
            proof = Authentication.proof(credential, challenge.nonce, nonce, challenge.serverId, deviceId(), ProtocolVersion.MAJOR),
            clientBuild = AppBuildIdentity.payload,
            cachedManuscriptHash = sessions.cachedManuscriptHash()
        ), Authenticate.serializer(), challenge.serverId)
    }

    private fun handlePairCredential(envelope: ProtocolEnvelope) {
        val paired = codec.decodePayload<PairCredential>(envelope)
        val target = server ?: return
        credentials.save(envelope.serverId, paired.credential)
        scope.launch {
            pairedServers.save(target.copy(serverId = envelope.serverId)); pendingPair = null
            suppressReconnectOnce = true; socket.close(); delay(150); connectInternal(target.copy(serverId = envelope.serverId))
        }
    }

    private fun handleError(envelope: ProtocolEnvelope) {
        val reason = envelope.payload["reason"]?.toString()?.trim('"') ?: "Server rejected the request."
        pendingPair = null
        suppressReconnectOnce = true
        transition(ConnectionState.Error(reason), "server rejected request")
        _diagnostics.value = _diagnostics.value.copy(lastError = reason, authenticationState = "rejected")
    }

    private fun lost(reason: String) {
        socketOpen = false
        registeredAudioStreamId = null
        activeAudioGeneration = null
        streamRegistrationTimeout?.cancel()
        streamRegistration.connectionChanged()
        log.record("connection", "error", "connection.lost", reason, connectionId = connectionId, serverId = server?.serverId, remoteAddress = server?.endpoint, webSocketState = "CLOSED", details = mapOf("appLifecycle" to if (appForeground) "foreground" else "background", "manualAnchorPending" to (pendingManualReposition.payload != null).toString()))
        pendingManualReposition.retain("connection lost; waiting to resend after reconnect")
        authTimeout?.cancel(); authenticated = false; _diagnostics.value = _diagnostics.value.copy(
            controllerLease = false,
            controllerLeaseState = if (desiredControllerRequest == null) ControllerLeaseState.REVOKED else ControllerLeaseState.REQUESTING,
            registeredAudioStreamId = null,
            audioSocketGeneration = null,
            serverAudioConnectionGeneration = null,
            streamRegistrationAttempts = 0,
            lastError = reason,
            pendingManualAnchorReason = pendingManualReposition.reason
        )
        sessions.markDisconnected()
        snapshotSync.clear()
        if (suppressReconnectOnce) { suppressReconnectOnce = false; return }
        if (manualDisconnect || server == null) { transition(ConnectionState.Disconnected, reason); return }
        if (pendingPair != null) { pendingPair = null; transition(ConnectionState.Error("Pairing connection failed: $reason"), "pairing connection lost"); return }
        val delayMs = reconnectPolicy.delayMs(reconnectAttempt)
        val attempt = ++reconnectAttempt
        transition(ConnectionState.Reconnecting(attempt, delayMs), reason)
        log.record("connection", "warn", "connection.reconnect.scheduled", "Reconnect scheduled after failure: $reason", connectionId = connectionId, serverId = server?.serverId, details = mapOf("attempt" to attempt.toString(), "delayMs" to delayMs.toString()))
        _diagnostics.value = _diagnostics.value.copy(reconnectCount = _diagnostics.value.reconnectCount + 1)
        reconnectJob?.cancel()
        reconnectJob = scope.launch { delay(delayMs); server?.let { connectInternal(it, "scheduled reconnect attempt $attempt") } }
    }

    @Synchronized
    fun retryControllerRegistration(cause: String = "user requested stream registration retry"): Boolean {
        if (desiredControllerRequest == null) return false
        streamRegistrationTimeout?.cancel()
        streamRegistration.resetAttemptsForUserRetry()
        _diagnostics.value = _diagnostics.value.copy(
            controllerLeaseState = if (_diagnostics.value.controllerLease) {
                ControllerLeaseState.STREAM_REGISTRATION_PENDING
            } else {
                ControllerLeaseState.REQUESTING
            },
            registeredAudioStreamId = null,
            audioSocketGeneration = null,
            serverAudioConnectionGeneration = null,
            streamRegistrationAttempts = 0,
            lastError = null
        )
        return sendControllerRequestIfReady(cause, force = true)
    }

    @Synchronized
    private fun sendControllerRequestIfReady(cause: String, force: Boolean = false): Boolean {
        val request = desiredControllerRequest ?: return false
        if (!authenticated || !socketOpen) {
            log.record("connection", "info", "android.controller.lease_waiting", "Controller lease request retained until authentication completes.", connectionId = connectionId, details = mapOf("cause" to cause, "authenticated" to authenticated.toString(), "socketOpen" to socketOpen.toString()))
            return false
        }
        val generation = socket.currentOpenGeneration() ?: run {
            log.record(
                "connection", "warn", "android.controller.stream_registration_send_failed",
                "Audio stream registration could not be sent because the WebSocket has no open generation.",
                connectionId = connectionId,
                details = mapOf("cause" to cause, "streamId" to request.streamId)
            )
            return false
        }
        if (!streamRegistration.shouldSend(generation, force)) {
            log.record(
                "connection", "debug", "android.controller.lease_request_already_sent",
                "Controller stream registration is awaiting acknowledgement on the active WebSocket generation.",
                connectionId = connectionId,
                details = mapOf(
                    "cause" to cause,
                    "streamId" to request.streamId,
                    "socketGeneration" to generation.toString(),
                    "attempt" to streamRegistration.attempts.toString(),
                    "retryScheduled" to "true"
                )
            )
            return true
        }
        val sent = send("audioStreamStart", request, AudioStreamStart.serializer())
        val attempt = if (sent) streamRegistration.markSent(generation) else streamRegistration.attempts
        _diagnostics.value = _diagnostics.value.copy(
            controllerLeaseState = if (_diagnostics.value.controllerLease) {
                ControllerLeaseState.STREAM_REGISTRATION_PENDING
            } else {
                ControllerLeaseState.REQUESTING
            },
            streamRegistrationAttempts = attempt,
            lastError = if (sent) null else "Audio stream registration could not be queued on the WebSocket."
        )
        log.record(
            "connection", if (sent) "info" else "warn",
            if (sent) "android.controller.stream_registration_sent" else "android.controller.stream_registration_send_failed",
            if (sent) "Controller audio stream registration sent; waiting for matching server acknowledgement." else "Controller audio stream registration could not be queued on WebSocket.",
            connectionId = connectionId,
            details = mapOf(
                "cause" to cause,
                "streamId" to request.streamId,
                "socketGeneration" to generation.toString(),
                "attempt" to attempt.toString()
            )
        )
        if (sent) scheduleStreamRegistrationTimeout(request.streamId, generation)
        return sent
    }

    private fun scheduleStreamRegistrationTimeout(streamId: String, generation: Int) {
        streamRegistrationTimeout?.cancel()
        streamRegistrationTimeout = scope.launch {
            delay(streamRegistrationAckTimeoutMs)
            if (
                desiredControllerRequest?.streamId != streamId ||
                registeredAudioStreamId == streamId ||
                socket.currentOpenGeneration() != generation
            ) return@launch

            if (streamRegistration.timeoutDisposition() == StreamRegistrationTimeoutDisposition.RETRY) {
                log.record(
                    "connection", "warn", "android.controller.stream_registration_retry",
                    "Matching audio stream registration acknowledgement did not arrive; retrying on the same socket generation.",
                    connectionId = connectionId,
                    details = mapOf(
                        "streamId" to streamId,
                        "socketGeneration" to generation.toString(),
                        "completedAttempts" to streamRegistration.attempts.toString()
                    )
                )
                sendControllerRequestIfReady("registration acknowledgement timeout", force = true)
            } else {
                val reason = "Audio stream registration failed after ${streamRegistration.attempts} attempts; no matching server acknowledgement arrived."
                _diagnostics.value = _diagnostics.value.copy(
                    controllerLeaseState = ControllerLeaseState.STREAM_REGISTRATION_FAILED,
                    registeredAudioStreamId = null,
                    audioSocketGeneration = null,
                    serverAudioConnectionGeneration = null,
                    streamRegistrationAttempts = streamRegistration.attempts,
                    lastError = reason
                )
                log.record(
                    "connection", "error", "android.controller.stream_registration_failed",
                    reason,
                    connectionId = connectionId,
                    details = mapOf(
                        "streamId" to streamId,
                        "socketGeneration" to generation.toString(),
                        "attempts" to streamRegistration.attempts.toString()
                    )
                )
            }
        }
    }

    private fun sendPendingManualReposition(cause: String): Boolean {
        val payload = pendingManualReposition.payload ?: return false
        if (!authenticated || !socketOpen || !_diagnostics.value.controllerLease) return false
        val sent = send("manualReposition", payload, ManualReposition.serializer())
        _diagnostics.value = _diagnostics.value.copy(
            pendingManualAnchorTokenIndex = payload.visibleTokenIndex,
            pendingManualAnchorReason = if (sent) "sent; awaiting server acknowledgement" else "WebSocket send failed; waiting to retry"
        )
        log.record("movement", if (sent) "info" else "warn", if (sent) "android.manual_scroll.anchor_send_attempt" else "android.manual_scroll.anchor_send_retry_failed", if (sent) "Pending manual anchor sent; awaiting server acknowledgement." else "Pending manual anchor could not be sent and remains queued.", connectionId = connectionId, details = mapOf("visibleTokenIndex" to payload.visibleTokenIndex.toString(), "cause" to cause))
        return sent
    }

    private fun manualRepositionUnavailableReason() = when {
        manualDisconnect || server == null -> "disconnected with no reconnect target"
        !socketOpen -> "WebSocket disconnected or reconnecting"
        !authenticated -> "WebSocket open but authentication incomplete"
        !_diagnostics.value.controllerLease -> "authenticated; waiting for controller lease"
        else -> "WebSocket send failed"
    }

    private fun transition(next: ConnectionState, cause: String) {
        val previous = _state.value
        _state.value = next
        _diagnostics.value = _diagnostics.value.copy(lastStateTransitionCause = cause)
        log.record("connection", "info", "android.connection.state_transition", "Connection state changed from ${stateName(previous)} to ${stateName(next)}.", connectionId = connectionId, details = mapOf("from" to stateName(previous), "to" to stateName(next), "cause" to cause, "appLifecycle" to if (appForeground) "foreground" else "background"))
    }

    private fun stateName(state: ConnectionState) = state::class.simpleName ?: state.toString()

    private fun <T> send(type: String, payload: T, serializer: KSerializer<T>, explicitServerId: String? = null): Boolean {
        val target = server ?: return false
        val (text, sent) = synchronized(outgoingSendLock) {
            val encoded = codec.encodeEnvelope(type, payload, serializer, explicitServerId ?: target.serverId, sessionId, connectionId, outgoingSequence.getAndIncrement())
            encoded to socket.send(encoded)
        }
        log.record("protocol", "debug", "android.message.sent", "Application message queued.", connectionId = connectionId, serverId = explicitServerId ?: target.serverId, protocolMessageType = type, details = mapOf("bytes" to text.toByteArray().size.toString()))
        return sent
    }

    private fun logAudioDrop(metadata: AudioFrameMetadata, reason: String, socketGeneration: Int?) {
        log.record(
            "audio", "warn", "android.audio.frame_dropped",
            "Audio frame was not sent: $reason.",
            connectionId = connectionId,
            details = mapOf(
                "reason" to reason,
                "streamId" to metadata.streamId,
                "audioSequence" to metadata.sequence.toString(),
                "authenticated" to authenticated.toString(),
                "controllerLease" to _diagnostics.value.controllerLease.toString(),
                "requestedStreamId" to (desiredControllerRequest?.streamId ?: "none"),
                "registeredStreamId" to (registeredAudioStreamId ?: "none"),
                "audioSocketGeneration" to (activeAudioGeneration?.toString() ?: "none"),
                "currentSocketGeneration" to (socketGeneration?.toString() ?: "none")
            )
        )
    }

    companion object {
        fun requirePrivateIpv4(host: String) {
            val address = InetAddress.getByName(host)
            require(address is Inet4Address) { "The prototype Windows server requires IPv4." }
            val b = address.address.map { it.toInt() and 0xff }
            require(b[0] == 10 || (b[0] == 172 && b[1] in 16..31) || (b[0] == 192 && b[1] == 168) || b[0] == 127) {
                "Refusing cleartext connection to a non-private address."
            }
        }
    }
}
