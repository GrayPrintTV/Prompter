package app.prompter.tablet.ui

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.prompter.tablet.PrompterApplication
import app.prompter.tablet.AppBuildIdentity
import app.prompter.tablet.audio.AudioDiagnostics
import app.prompter.tablet.connection.ConnectionDiagnostics
import app.prompter.tablet.connection.ConnectionState
import app.prompter.tablet.connection.ManualRepositionSendOutcome
import app.prompter.tablet.discovery.DiscoveredServer
import app.prompter.tablet.discovery.DiscoveryState
import app.prompter.tablet.diagnostics.AndroidDiagnosticEvent
import app.prompter.tablet.protocol.ProtocolVersion
import app.prompter.tablet.session.TabletSessionState
import app.prompter.tablet.settings.TabletDisplaySettings
import app.prompter.tablet.settings.inheritedDisplaySettings
import app.prompter.tablet.protocol.MovementEvent
import app.prompter.tablet.protocol.ManualReposition
import app.prompter.tablet.ui.prompter.TabletVisibleAnchor
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class Screen { CONNECTION, PROMPTER, DIAGNOSTICS, SETTINGS }

data class ManualFollowUiDiagnostics(
    val overrideState: String = "normal",
    val anchorTokenIndex: Int? = null,
    val anchorSentenceIndex: Int? = null,
    val anchorParagraphIndex: Int? = null,
    val lastSuppressedReason: String? = null,
    val lastAcceptedReason: String? = null
)

data class MainUiState(
    val screen: Screen = Screen.CONNECTION,
    val discovery: DiscoveryState = DiscoveryState(),
    val connection: ConnectionState = ConnectionState.Disconnected,
    val connectionDiagnostics: ConnectionDiagnostics = ConnectionDiagnostics(),
    val session: TabletSessionState = TabletSessionState(),
    val audio: AudioDiagnostics = AudioDiagnostics(),
    val display: TabletDisplaySettings = TabletDisplaySettings(),
    val pairingCode: String = "",
    val manualAddress: String = "",
    val microphonePermissionDenied: Boolean = false,
    val lastError: String? = null,
    val diagnosticEvents: List<AndroidDiagnosticEvent> = emptyList(),
    val manualFollow: ManualFollowUiDiagnostics = ManualFollowUiDiagnostics()
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val services = (application as PrompterApplication).services
    private val _ui = MutableStateFlow(MainUiState())
    val ui: StateFlow<MainUiState> = _ui.asStateFlow()
    private var pendingAudio: Pair<String, Int>? = null
    private var autoConnected = false
    private var resumeMicrophoneOnForeground = false

    init {
        viewModelScope.launch { services.discovery.state.collect { update { copy(discovery = it, lastError = it.lastError ?: lastError) } } }
        viewModelScope.launch { services.connections.state.collect { state ->
            update {
                copy(
                    connection = state,
                    lastError = (state as? ConnectionState.Error)?.message ?: lastError,
                    manualFollow = if (state !is ConnectionState.Connected && manualFollow.anchorTokenIndex != null) {
                        manualFollow.copy(overrideState = "anchor queued during reconnect")
                    } else manualFollow
                )
            }
            if (state is ConnectionState.Connected && resumeMicrophoneOnForeground) {
                resumeMicrophoneOnForeground = false
                requestMicrophone()
            }
        } }
        viewModelScope.launch { services.connections.diagnostics.collect { diagnostic ->
            update { copy(connectionDiagnostics = diagnostic, lastError = diagnostic.lastError ?: lastError) }
            if (
                diagnostic.controllerLease &&
                diagnostic.registeredAudioStreamId == pendingAudio?.first &&
                pendingAudio != null &&
                !services.audio.diagnostics.value.active
            ) startPreparedAudio()
        } }
        viewModelScope.launch { services.sessions.state.collect { session ->
            update { copy(session = session, screen = if (session.snapshot != null && screen == Screen.CONNECTION) Screen.PROMPTER else screen) }
        } }
        viewModelScope.launch { services.audio.diagnostics.collect { update { copy(audio = it, lastError = it.lastError ?: lastError) } } }
        viewModelScope.launch { services.displaySettings.settings.collect { update { copy(display = it) } } }
        viewModelScope.launch {
            services.diagnostics.events.collect { events ->
                if (_ui.value.screen == Screen.DIAGNOSTICS) {
                    update { copy(diagnosticEvents = events) }
                }
            }
        }
        viewModelScope.launch { services.pairedServers.pairedServer.collect { paired ->
            if (paired != null && !autoConnected) { autoConnected = true; services.connections.connect(paired.discovered()) }
        } }
    }

    fun onForeground(cause: String = "activity onStart") {
        services.discovery.start()
        services.connections.onAppForeground(cause)
        if (resumeMicrophoneOnForeground && _ui.value.connection is ConnectionState.Connected) {
            resumeMicrophoneOnForeground = false
            requestMicrophone()
        }
    }
    fun onResume() = services.connections.logLifecycleTransition("android.lifecycle.on_resume", "activity onResume")
    fun onPause() = services.connections.logLifecycleTransition("android.lifecycle.on_pause", "activity onPause; resources retained until onStop")
    fun onBackground(cause: String = "activity onStop") {
        services.connections.onAppBackground(cause)
        services.discovery.stop()
        resumeMicrophoneOnForeground = services.audio.diagnostics.value.active || pendingAudio != null
        stopMicrophone()
    }
    fun refreshDiscovery() { services.discovery.stop(); services.discovery.start() }
    fun setPairingCode(value: String) { update { copy(pairingCode = value.filter(Char::isDigit).take(6)) } }
    fun setManualAddress(value: String) { update { copy(manualAddress = value) } }

    fun addManualAddress() {
        val raw = _ui.value.manualAddress.trim().removePrefix("ws://")
        val host = raw.substringBefore(':')
        val port = raw.substringAfter(':', "43127").toIntOrNull() ?: 43127
        runCatching { services.discovery.addManual(host, port) }.onFailure { update { copy(lastError = it.message) } }
    }

    fun pair(server: DiscoveredServer) {
        runCatching { ProtocolVersion.requireCompatible(server.protocolMajor, server.protocolMinor) }
            .onSuccess { services.pairing.pair(server, _ui.value.pairingCode.takeIf { it.length == 6 }) }
            .onFailure { update { copy(lastError = it.message) } }
    }

    fun connect(server: DiscoveredServer) = services.connections.connect(server)
    fun reconnect() = services.connections.reconnectNow("user tapped reconnect")
    fun show(screen: Screen) = update {
        copy(
            screen = screen,
            diagnosticEvents = if (screen == Screen.DIAGNOSTICS) services.diagnostics.snapshot() else emptyList()
        )
    }
    fun copyDiagnostics() {
        val clipboard = getApplication<Application>().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val state = _ui.value
        val serverBuild = state.connectionDiagnostics.serverBuild
        val summary = buildString {
            appendLine("Prompter manual-follow runtime diagnostics")
            appendLine("androidBuild=${AppBuildIdentity.summary()}")
            appendLine("serverBuild=${serverBuild?.versionName ?: "unavailable"} timestamp=${serverBuild?.buildTimestamp ?: "unavailable"} git=${serverBuild?.gitHash ?: "unavailable"} dirty=${serverBuild?.dirty ?: "unavailable"}")
            appendLine("serverProtocol=${state.connectionDiagnostics.serverProtocolMajor ?: "?"}.${state.connectionDiagnostics.serverProtocolMinor ?: "?"} serverStartedAtMs=${state.connectionDiagnostics.serverStartedAtMs ?: "unavailable"}")
            appendLine("connection=${state.connection} cause=${state.connectionDiagnostics.lastStateTransitionCause ?: "none"} lifecycle=${state.connectionDiagnostics.appLifecycleState}")
            appendLine("controllerLease=${state.connectionDiagnostics.controllerLease} leaseState=${state.connectionDiagnostics.controllerLeaseState}")
            appendLine("registeredAudioStreamId=${state.connectionDiagnostics.registeredAudioStreamId ?: "none"} audioSocketGeneration=${state.connectionDiagnostics.audioSocketGeneration ?: "none"} serverAudioConnectionGeneration=${state.connectionDiagnostics.serverAudioConnectionGeneration ?: "none"} registrationAttempts=${state.connectionDiagnostics.streamRegistrationAttempts}")
            appendLine("queuedAnchor=${state.connectionDiagnostics.pendingManualAnchorTokenIndex ?: "none"} queuedReason=${state.connectionDiagnostics.pendingManualAnchorReason ?: "none"}")
            appendLine("sessionRevision=${state.session.latestMovement?.sessionRevision ?: state.session.snapshot?.sessionRevision ?: "unavailable"} movementEvent=${state.session.latestMovementEventId ?: "unavailable"}")
            appendLine("manualState=${state.manualFollow.overrideState} anchorToken=${state.manualFollow.anchorTokenIndex ?: "none"} anchorSentence=${state.manualFollow.anchorSentenceIndex ?: "none"} anchorParagraph=${state.manualFollow.anchorParagraphIndex ?: "none"}")
            appendLine("remoteStatus=${state.session.lastRemoteMovementStatus} suppressedReason=${state.manualFollow.lastSuppressedReason ?: "none"} acceptedReason=${state.manualFollow.lastAcceptedReason ?: state.session.lastAcceptedMovementReason ?: "none"}")
            appendLine()
            append(services.diagnostics.copyText())
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("Prompter diagnostics", summary))
    }
    fun clearDiagnostics() = services.diagnostics.clear()
    fun logMovementTargetResolved(movement: MovementEvent, itemIndex: Int, localOffset: Int) {
        services.sessions.clearMovementRejection()
        update { copy(manualFollow = manualFollow.copy(lastAcceptedReason = movement.reason)) }
        services.diagnostics.record(
            "movement", "info", "android.movement.target_resolved", "Semantic movement target resolved to a Compose list item.",
            details = mapOf("itemIndex" to itemIndex.toString(), "localCharacterOffset" to localOffset.toString(), "targetCharacter" to movement.targetCharacter.toString(), "paragraphIndex" to movement.paragraphIndex.toString(), "reason" to movement.reason, "manualStatus" to (movement.manualRepositionStatus ?: "normal"))
        )
    }
    fun logMovementLinePosition(movement: MovementEvent, paragraphIndex: Int, lineIndex: Int, geometry: app.prompter.tablet.ui.prompter.ViewportTargetGeometry, viewportEndOffset: Int, itemSize: Int, firstVisibleIndex: Int, firstVisibleScrollOffset: Int) = services.diagnostics.record(
        "movement", "debug", "android.movement.line_positioned", "Target character positioned within its visual source paragraph.",
        details = mapOf("paragraphIndex" to paragraphIndex.toString(), "targetCharacter" to movement.targetCharacter.toString(), "lineIndex" to lineIndex.toString(), "itemOffset" to geometry.itemOffset.toString(), "itemSize" to itemSize.toString(), "viewportStartOffset" to geometry.viewportStartOffset.toString(), "viewportEndOffset" to viewportEndOffset.toString(), "beforeContentPadding" to geometry.beforeContentPadding.toString(), "paragraphTopInViewport" to geometry.paragraphTopInViewport.toString(), "targetLineY" to geometry.lineCenterInsideParagraph.toString(), "targetCenterInViewport" to geometry.targetLineCenterInViewport.toString(), "readingBandY" to geometry.readingBandCenter.toString(), "rawDesiredDelta" to geometry.desiredScrollDelta.toString(), "dispatchDelta" to geometry.desiredScrollDelta.toString(), "firstVisibleIndex" to firstVisibleIndex.toString(), "firstVisibleScrollOffset" to firstVisibleScrollOffset.toString())
    )
    fun logMovementGeometryRetry(reason: String) = services.diagnostics.record(
        "movement", "debug", "android.movement.geometry_retry", "Movement geometry unavailable; reevaluation scheduled.", details = mapOf("reason" to reason)
    )
    fun logMovementWaitingForConnectionOrLease(reason: String, movement: MovementEvent) = services.diagnostics.record(
        "movement", "info", "android.movement.waiting_for_connection_or_lease",
        "Movement rendering paused until the authenticated connection owns the controller lease.",
        details = mapOf(
            "reason" to reason,
            "targetTokenIndex" to movement.targetTokenIndex.toString(),
            "connectionState" to (_ui.value.connection::class.simpleName ?: _ui.value.connection.toString()),
            "leaseState" to _ui.value.connectionDiagnostics.controllerLeaseState.name,
            "rejected" to "false"
        )
    )
    fun consumeSnapshotAnchor(identity: String) { services.sessions.consumeSnapshotAnchor(identity) }
    fun logSnapshotAnchorApplied(identity: String) = services.diagnostics.record("anchor", "info", "android.snapshot_anchor.applied", "Snapshot anchor aligned to reading band.", details = mapOf("identity" to identity.take(80)))
    fun logSnapshotAnchorIgnored(identity: String) = services.diagnostics.record("anchor", "debug", "android.snapshot_anchor.ignored", "Consumed snapshot anchor was not reapplied.", details = mapOf("identity" to identity.take(80)))
    fun logManualScrollStarted(inputSource: String, scrollContainer: String) {
        update { copy(manualFollow = manualFollow.copy(overrideState = "user scrolling", anchorTokenIndex = null, anchorSentenceIndex = null, anchorParagraphIndex = null)) }
        services.diagnostics.record(
            "movement", "info", "android.manual_scroll.touch_detected", "Tablet manual touch detected; auto-follow suppressed.",
            details = mapOf("inputSource" to inputSource, "scrollContainer" to scrollContainer)
        )
    }
    fun logTabletScrollObserved() {
        update { copy(manualFollow = manualFollow.copy(overrideState = "user scrolling")) }
        services.diagnostics.record("movement", "info", "android.manual_scroll.scroll_observed", "Tablet list scroll observed.")
    }
    fun logTabletMomentumSettled() = services.diagnostics.record(
        "movement", "info", "android.manual_scroll.momentum_settled", "Tablet scroll momentum settled; selecting reading-band anchor."
    )
    fun logTabletVisibleAnchorSelected(anchor: TabletVisibleAnchor, direction: String) {
        update {
            copy(manualFollow = manualFollow.copy(
                overrideState = "anchor selected",
                anchorTokenIndex = anchor.tokenIndex,
                anchorSentenceIndex = anchor.sentenceIndex,
                anchorParagraphIndex = anchor.paragraphIndex
            ))
        }
        services.diagnostics.record(
            "movement", "info", "android.manual_scroll.anchor_selected", "Tablet visible anchor selected at the reading band.",
            details = mapOf(
                "visibleTokenIndex" to anchor.tokenIndex.toString(),
                "visibleCharacter" to anchor.character.toString(),
                "sentenceIndex" to anchor.sentenceIndex.toString(),
                "paragraphIndex" to anchor.paragraphIndex.toString(),
                "distanceFromReadingBandPx" to anchor.distanceFromReadingBandPx.toString(),
                "direction" to direction,
                "scrollContainer" to "prompter-lazy-column"
            )
        )
    }
    fun sendTabletManualReposition(
        anchor: TabletVisibleAnchor,
        manuscriptRevision: Long,
        direction: String,
        inputSource: String,
        detectedAtMs: Long
    ): ManualRepositionSendOutcome {
        val payload = ManualReposition(
            manuscriptRevision = manuscriptRevision,
            visibleTokenIndex = anchor.tokenIndex,
            visibleCharacter = anchor.character,
            sentenceIndex = anchor.sentenceIndex,
            paragraphIndex = anchor.paragraphIndex,
            direction = direction,
            inputSource = inputSource,
            scrollContainer = "prompter-lazy-column",
            detectedAtMs = detectedAtMs
        )
        val outcome = services.connections.sendManualReposition(payload)
        val sent = outcome is ManualRepositionSendOutcome.Sent
        val queued = outcome is ManualRepositionSendOutcome.Queued
        val failureReason = when (outcome) {
            ManualRepositionSendOutcome.Sent -> null
            is ManualRepositionSendOutcome.Queued -> outcome.reason
            is ManualRepositionSendOutcome.Failed -> outcome.reason
        }
        update {
            copy(
                manualFollow = manualFollow.copy(
                    overrideState = when {
                        sent -> "anchor sent"
                        queued -> "anchor queued during reconnect"
                        else -> "anchor send failed"
                    },
                    lastSuppressedReason = failureReason ?: manualFollow.lastSuppressedReason
                ),
                lastError = if (outcome is ManualRepositionSendOutcome.Failed) failureReason else lastError
            )
        }
        services.diagnostics.record(
            "movement",
            if (sent) "info" else if (queued) "warn" else "error",
            if (sent) "android.manual_scroll.anchor_sent" else if (queued) "android.manual_scroll.anchor_queued" else "android.manual_scroll.anchor_send_failed",
            if (sent) "Tablet manual anchor sent to the shared session coordinator." else if (queued) "Tablet manual anchor queued until connection and lease recover." else "Tablet manual anchor could not be queued; local hold will be cleared.",
            details = mapOf(
                "visibleTokenIndex" to anchor.tokenIndex.toString(),
                "manuscriptRevision" to manuscriptRevision.toString(),
                "scrollContainer" to payload.scrollContainer,
                "reason" to (failureReason ?: "sent")
            )
        )
        return outcome
    }
    fun logRemoteMovementSuppressed(movement: MovementEvent, reason: String) {
        services.sessions.recordMovementRejection("tablet manual reposition active")
        val wrongSection = movement.manualRepositionStatus == "holding"
        update {
            copy(manualFollow = manualFollow.copy(
                overrideState = if (wrongSection) "holding wrong-section" else manualFollow.overrideState,
                lastSuppressedReason = reason
            ))
        }
        services.diagnostics.record(
            "movement", "info", "android.manual_scroll.remote_update_suppressed",
            "Remote/session movement suppressed because tablet manual reposition is active.",
            details = mapOf(
                "targetTokenIndex" to movement.targetTokenIndex.toString(),
                "classification" to movement.classification,
                "reason" to reason,
                "manualStatus" to (movement.manualRepositionStatus ?: "normal"),
                "manualAnchorTokenIndex" to (movement.manualAnchorTokenIndex?.toString() ?: "none"),
                "manualAnchorDistanceTokens" to (movement.manualAnchorDistanceTokens?.toString() ?: "none"),
                "snapbackPrevented" to "true"
            )
        )
        if (wrongSection) services.diagnostics.record(
            "movement", "warn", "android.manual_scroll.wrong_section_hold",
            "Wrong-section movement held; tablet remains at its manual anchor.",
            details = mapOf(
                "reason" to reason,
                "targetTokenIndex" to movement.targetTokenIndex.toString(),
                "anchorTokenIndex" to (movement.manualAnchorTokenIndex?.toString() ?: "none"),
                "distanceTokens" to (movement.manualAnchorDistanceTokens?.toString() ?: "none")
            )
        )
    }
    fun logTabletAutoFollowResumed(movement: MovementEvent, reason: String) {
        update { copy(manualFollow = manualFollow.copy(overrideState = "reacquired/resumed", lastAcceptedReason = reason)) }
        services.diagnostics.record(
            "movement", "info", "android.manual_scroll.override_cleared",
            "Manual override cleared by matching server reacquisition.",
            details = mapOf("targetTokenIndex" to movement.targetTokenIndex.toString(), "reason" to reason)
        )
        services.diagnostics.record(
            "movement", "info", "android.manual_scroll.auto_follow_resumed",
            "Incoming speech matched near the tablet anchor; normal following resumed.",
            details = mapOf("targetTokenIndex" to movement.targetTokenIndex.toString(), "classification" to movement.classification, "reason" to reason)
        )
    }
    fun logTabletManualCoordinatorResult(
        result: app.prompter.tablet.protocol.ManualRepositionResult,
        state: app.prompter.tablet.ui.prompter.TabletManualOverrideState
    ) {
        update {
            copy(manualFollow = manualFollow.copy(
                overrideState = if (result.accepted) "waiting for reacquire" else "holding wrong-section",
                anchorTokenIndex = result.visibleTokenIndex,
                lastSuppressedReason = if (result.accepted) manualFollow.lastSuppressedReason else result.reason
            ))
        }
        services.diagnostics.record(
            "movement",
            if (result.accepted) "info" else "warn",
            if (result.accepted) "android.manual_scroll.waiting_for_nearby_speech" else "android.manual_scroll.rejected_hold",
            if (result.accepted) "Tablet anchor accepted; waiting for nearby speech evidence." else "Tablet anchor rejected; safe hold remains active.",
            details = mapOf("visibleTokenIndex" to result.visibleTokenIndex.toString(), "sessionRevision" to result.sessionRevision.toString(), "overrideState" to state.name, "reason" to result.reason)
        )
    }
    fun logTabletManualOverrideReplaced() {
        update { copy(manualFollow = manualFollow.copy(overrideState = "user scrolling", anchorTokenIndex = null, anchorSentenceIndex = null, anchorParagraphIndex = null)) }
        services.diagnostics.record("movement", "info", "android.manual_scroll.override_replaced", "A second tablet swipe replaced the pending manual anchor.")
    }
    fun logManualTouchWithoutScroll() {
        update { copy(manualFollow = manualFollow.copy(overrideState = "normal", anchorTokenIndex = null, anchorSentenceIndex = null, anchorParagraphIndex = null)) }
        services.diagnostics.record("movement", "debug", "android.manual_scroll.touch_released", "Touch ended without a tablet scroll; manual override released.")
    }
    fun logTabletManualOverrideCleared(reason: String) {
        update {
            copy(manualFollow = manualFollow.copy(
                overrideState = "normal",
                anchorTokenIndex = null,
                anchorSentenceIndex = null,
                anchorParagraphIndex = null,
                lastSuppressedReason = reason
            ))
        }
        services.diagnostics.record(
            "movement", "warn", "android.manual_scroll.override_cleared_after_send_failure",
            "Manual override cleared because the anchor could not be sent or queued.",
            details = mapOf("reason" to reason)
        )
    }
    fun logMovementDeferredDuringHold(movement: MovementEvent, remainingMs: Long) = services.diagnostics.record("movement", "info", "android.movement.deferred", "Movement deferred during manual-scroll hold.", details = mapOf("targetCharacter" to movement.targetCharacter.toString(), "remainingMs" to remainingMs.toString()))
    fun logResumeTargetSelected(movement: MovementEvent) = services.diagnostics.record("movement", "info", "android.movement.resume_target", "Resuming toward latest effect target after manual hold.", details = mapOf("targetCharacter" to movement.targetCharacter.toString()))
    fun logMovementUnresolved(reason: String, movement: MovementEvent?) {
        services.sessions.recordMovementRejection(reason)
        services.diagnostics.record(
            "movement", "warn", "android.movement.target_unresolved", "Semantic movement target could not be resolved: $reason.",
            details = mapOf("reason" to reason, "targetCharacter" to (movement?.targetCharacter?.toString() ?: "unknown"), "paragraphIndex" to (movement?.paragraphIndex?.toString() ?: "unknown"))
        )
    }
    fun logMovementAnimationStarted(movement: MovementEvent, itemIndex: Int, policy: String, durationMs: Int, distancePx: Float, readingBandTarget: Int) = services.diagnostics.record(
        "movement", "info", "android.movement.animation_started", "Native Compose movement animation started.",
        details = mapOf("itemIndex" to itemIndex.toString(), "durationHintMs" to movement.durationHintMs.toString(), "classification" to movement.classification, "policy" to policy, "chosenDurationMs" to durationMs.toString(), "estimatedPixelDistance" to distancePx.toString(), "readingBandTarget" to readingBandTarget.toString())
    )
    fun logMovementAnimationCompleted(movement: MovementEvent, itemIndex: Int, policy: String, elapsedMs: Long, distancePx: Float) = services.diagnostics.record(
        "movement", "info", "android.movement.animation_completed", "Native Compose movement animation completed.",
        details = mapOf("itemIndex" to itemIndex.toString(), "targetCharacter" to movement.targetCharacter.toString(), "policy" to policy, "actualElapsedMs" to elapsedMs.toString(), "estimatedPixelDistance" to distancePx.toString())
    )
    fun logMovementAnimationCancelled(movement: MovementEvent, itemIndex: Int, reason: String) = services.diagnostics.record(
        "movement", "info", "android.movement.animation_cancelled", "Native Compose movement animation cancelled.",
        details = mapOf("itemIndex" to itemIndex.toString(), "targetCharacter" to movement.targetCharacter.toString(), "reason" to reason)
    )
    fun logAssistAnchor(movement: MovementEvent, receivedAtMs: Long, lineHeightPx: Float, sample: app.prompter.tablet.ui.prompter.AssistCruisePaceSample) = services.diagnostics.record(
        "assist", "info", "android.assist.anchor.received", "Authoritative movement anchor considered for visual-only Assist Cruise.",
        details = mapOf(
            "targetToken" to movement.targetTokenIndex.toString(), "classification" to movement.classification,
            "sessionRevision" to movement.sessionRevision.toString(), "receivedAtMs" to receivedAtMs.toString(),
            "lineHeightPx" to lineHeightPx.toString(), "paceEligible" to sample.eligible.toString(),
            "paceReason" to sample.reason, "measuredPixelsPerSecond" to (sample.measuredPixelsPerSecond?.toString() ?: "none"),
            "regularizedPixelsPerSecond" to (sample.regularizedPixelsPerSecond?.toString() ?: "none")
        )
    )
    fun logAssistCruiseStarted(movement: MovementEvent, distancePx: Float) = services.diagnostics.record(
        "assist", "info", "android.assist.cruise.started", "Assist Cruise started after authoritative correction.",
        details = mapOf("targetToken" to movement.targetTokenIndex.toString(), "targetCharacter" to movement.targetCharacter.toString(), "initialViewportErrorPx" to distancePx.toString())
    )
    fun logAssistCruiseFrame(frame: app.prompter.tablet.ui.prompter.AssistCruiseFrame) = services.diagnostics.record(
        "assist", "debug", "android.assist.cruise.frame", "Assist Cruise applied a bounded visual frame.",
        details = mapOf("deltaPx" to frame.deltaPx.toString(), "velocityPixelsPerSecond" to frame.velocityPixelsPerSecond.toString(), "staleAgeMs" to frame.staleAgeMs.toString(), "predictedDistancePx" to frame.predictedDistancePx.toString(), "predictionBoundPx" to frame.predictionBoundPx.toString())
    )
    fun logAssistCruiseStopped(reason: String, staleAgeMs: Long) = services.diagnostics.record(
        "assist", "info", "android.assist.cruise.stopped", "Assist Cruise stopped; settling to the last authoritative anchor.",
        details = mapOf("reason" to reason, "staleAgeMs" to staleAgeMs.toString())
    )
    fun logAssistCruiseSettled(target: MovementEvent, finalDistancePx: Float) = services.diagnostics.record(
        "assist", "info", "android.assist.cruise.settled", "Last authoritative anchor settled at the reading band.",
        details = mapOf("targetToken" to target.targetTokenIndex.toString(), "targetCharacter" to target.targetCharacter.toString(), "finalViewportErrorPx" to finalDistancePx.toString())
    )
    fun logAssistCruiseSuperseded(movement: MovementEvent, reason: String) = services.diagnostics.record(
        "assist", "debug", "android.assist.cruise.superseded", "Assist Cruise was superseded by a newer visual target.",
        details = mapOf("targetCharacter" to movement.targetCharacter.toString(), "reason" to reason)
    )
    fun logAssistCruiseReset(reason: String) = services.diagnostics.record(
        "assist", "debug", "android.assist.cruise.reset", "Assist Cruise state was reset without changing semantic position.",
        details = mapOf("reason" to reason)
    )
    fun logManualMovementHold(remainingMs: Long) {
        services.sessions.recordMovementRejection("manual-scroll hold active")
        services.diagnostics.record(
            "movement", "info", "android.movement.rejected", "Automatic movement held after real user touch.",
            details = mapOf("reason" to "manual-scroll hold active", "remainingMs" to remainingMs.toString())
        )
    }

    fun hasMicrophonePermission(): Boolean = ContextCompat.checkSelfPermission(getApplication(), Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    fun onMicrophonePermissionResult(granted: Boolean) {
        update { copy(microphonePermissionDenied = !granted, lastError = if (granted) lastError else "Microphone permission was denied.") }
        if (granted) requestMicrophone()
    }

    fun requestMicrophone() {
        if (!hasMicrophonePermission()) { update { copy(microphonePermissionDenied = true) }; return }
        if (_ui.value.connection !is ConnectionState.Connected) { update { copy(lastError = "Connect and authenticate before starting the microphone.") }; return }
        if (services.audio.diagnostics.value.active) return
        if (pendingAudio != null) {
            if (!services.connections.retryControllerRegistration("Start microphone tapped while registration was pending")) {
                update { copy(lastError = "Could not retry audio stream registration on the active connection.") }
            }
            return
        }
        val prepared = services.audio.prepare().getOrElse { update { copy(lastError = it.message) }; return }
        pendingAudio = prepared
        if (!services.connections.requestController(prepared.first, prepared.second)) update { copy(lastError = "Could not request the controller lease.") }
    }

    fun stopMicrophone() {
        val diagnostics = services.audio.diagnostics.value
        diagnostics.streamId?.let { services.connections.stopController(it, diagnostics.lastSequence.coerceAtLeast(0)) }
        pendingAudio = null
        services.audio.stop()
    }

    fun updateDisplay(transform: (TabletDisplaySettings) -> TabletDisplaySettings) {
        viewModelScope.launch { services.displaySettings.save(transform(_ui.value.display)) }
    }

    fun resetDisplayToWindows() {
        val inherited = inheritedDisplaySettings(_ui.value.session.runtimeSettings?.display) ?: return
        viewModelScope.launch {
            services.displaySettings.save(_ui.value.display.copy(
                useWindowsDisplaySettings = true,
                fontSizeSp = inherited.fontSizeSp,
                lineSpacing = inherited.lineSpacing,
                contentWidthFraction = inherited.contentWidthFraction,
                readingBandPercent = inherited.readingBandFraction * 100f
            ))
        }
    }

    fun logRelayoutStarted(settingsRevision: Long?, targetCharacter: Int?, layoutKey: String) = services.diagnostics.record(
        "layout", "info", "android.layout.relayout_started", "Typography/layout changed; retaining the latest semantic target for remeasurement.",
        details = mapOf("settingsRevision" to (settingsRevision?.toString() ?: "local"), "targetCharacter" to (targetCharacter?.toString() ?: "none"), "layoutKey" to layoutKey)
    )
    fun logRelayoutAlignmentCompleted(targetCharacter: Int) = services.diagnostics.record(
        "layout", "info", "android.layout.relayout_aligned", "Semantic target was remeasured and aligned after layout.", details = mapOf("targetCharacter" to targetCharacter.toString())
    )

    private fun startPreparedAudio() {
        val (streamId, rate) = pendingAudio ?: return
        services.audio.start(streamId, rate) { metadata, bytes -> services.connections.sendAudio(metadata, bytes) }
            .onFailure { update { copy(lastError = it.message) } }
    }

    private fun update(transform: MainUiState.() -> MainUiState) { _ui.value = _ui.value.transform() }
}
