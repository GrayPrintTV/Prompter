package app.prompter.tablet.session

import android.content.Context
import app.prompter.tablet.diagnostics.DiagnosticLogger
import app.prompter.tablet.protocol.MovementEvent
import app.prompter.tablet.protocol.ManualRepositionResult
import app.prompter.tablet.protocol.ProtocolEnvelope
import app.prompter.tablet.protocol.SessionSnapshot
import app.prompter.tablet.protocol.TranscriptEvent
import app.prompter.tablet.protocol.RuntimeSettings
import app.prompter.tablet.protocol.SessionState
import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class TabletSessionState(
    val sessionId: String? = null,
    val snapshot: SessionSnapshot? = null,
    val latestTranscript: String? = null,
    val latestMovement: MovementEvent? = null,
    val latestMovementEventId: String? = null,
    val lastRemoteMovementStatus: String = "normal",
    val lastAcceptedMovementReason: String? = null,
    val awaitingSnapshot: Boolean = true,
    val lastSequence: Long = -1,
    val sequenceGaps: Int = 0,
    val latestMovementRejection: String? = null,
    val runtimeSettings: RuntimeSettings? = null,
    val snapshotAnchor: SnapshotAnchor? = null,
    val manualRepositionResult: ManualRepositionResult? = null
)

data class SnapshotAnchor(
    val identity: String,
    val sessionId: String,
    val manuscriptRevision: Long,
    val tokenIndex: Int,
    val character: Int,
    val sentenceIndex: Int,
    val paragraphIndex: Int,
    val consumed: Boolean = false
)

data class IncrementalDecision(val accepted: Boolean, val reason: String? = null)
data class MovementApplication(val accepted: Boolean, val reason: String? = null)

class SessionRepository private constructor(private val cacheDir: File, private val diagnostics: DiagnosticLogger?) {
    constructor(context: Context, diagnostics: DiagnosticLogger? = null) : this(File(context.filesDir, "manuscripts"), diagnostics)
    constructor(cacheRoot: File, forTesting: Boolean = true) : this(File(cacheRoot, "manuscripts"), null)
    init { cacheDir.mkdirs() }
    private val _state = MutableStateFlow(TabletSessionState())
    val state: StateFlow<TabletSessionState> = _state.asStateFlow()

    fun applySnapshot(envelope: ProtocolEnvelope, snapshot: SessionSnapshot) {
        require(snapshot.manuscript.normalizedContent != null || snapshot.manuscript.contentReference != null)
        snapshot.manuscript.normalizedContent?.let { content ->
            val file = cacheFile(snapshot.manuscript.contentHash)
            // The cache filename is content-addressed. Avoid reading a second full
            // manuscript String into the tablet heap just to compare it.
            if (!file.exists()) file.writeText(content)
        }
        val current = _state.value
        val restored = restoreCachedContent(snapshot)
        val anchorIdentity = "${envelope.sessionId}:${snapshot.manuscriptRevision}:${snapshot.narrationSessionId ?: "legacy"}"
        val previousAnchor = current.snapshotAnchor
        val anchor = if (previousAnchor?.identity == anchorIdentity) previousAnchor else SnapshotAnchor(
            identity = anchorIdentity, sessionId = envelope.sessionId, manuscriptRevision = snapshot.manuscriptRevision,
            tokenIndex = snapshot.acceptedPosition.tokenIndex, character = snapshot.acceptedPosition.character,
            sentenceIndex = snapshot.acceptedPosition.sentenceIndex, paragraphIndex = snapshot.acceptedPosition.paragraphIndex
        )
        if (previousAnchor?.identity != anchorIdentity) diagnostics?.record("anchor", "info", "android.snapshot_anchor.received", "New snapshot anchor received.", details = mapOf("identity" to anchorIdentity.take(80), "character" to anchor.character.toString(), "paragraphIndex" to anchor.paragraphIndex.toString()))
        // A snapshot is recovery/state confirmation, not a command to discard a newer-or-equal
        // live semantic target. Keep it until the next movement event replaces it.
        val preserveMovement = current.sessionId == envelope.sessionId &&
            current.latestMovement?.manuscriptRevision == snapshot.manuscriptRevision &&
            (current.latestMovement?.sessionRevision ?: Long.MAX_VALUE) <= snapshot.sessionRevision
        _state.value = TabletSessionState(
            sessionId = envelope.sessionId,
            snapshot = restored,
            latestTranscript = snapshot.latestTranscript,
            latestMovement = current.latestMovement.takeIf { preserveMovement },
            latestMovementEventId = current.latestMovementEventId.takeIf { preserveMovement },
            lastRemoteMovementStatus = current.lastRemoteMovementStatus,
            lastAcceptedMovementReason = current.lastAcceptedMovementReason,
            awaitingSnapshot = false,
            lastSequence = envelope.sequence,
            sequenceGaps = current.sequenceGaps,
            latestMovementRejection = current.latestMovementRejection,
            runtimeSettings = chooseSettings(current.runtimeSettings, restored.runtimeSettings),
            snapshotAnchor = anchor,
            manualRepositionResult = current.manualRepositionResult
        )
    }

    fun applyState(envelope: ProtocolEnvelope, state: SessionState) {
        val manuscript = _state.value.snapshot?.manuscript
        require(manuscript != null && manuscript.contentHash == state.manuscript.contentHash) {
            "Server sent state for a manuscript that is not cached in memory."
        }
        applySnapshot(envelope, SessionSnapshot(
            sessionRevision = state.sessionRevision,
            manuscriptRevision = state.manuscriptRevision,
            manuscript = manuscript.copy(manuscriptId = state.manuscript.manuscriptId),
            acceptedPosition = state.acceptedPosition,
            followState = state.followState,
            currentConfidence = state.currentConfidence,
            latestTranscript = state.latestTranscript,
            controllerLease = state.controllerLease,
            displayHints = state.displayHints,
            runtimeSettings = state.runtimeSettings,
            narrationSessionId = state.narrationSessionId,
            movementDecision = state.movementDecision
        ))
    }

    fun cachedManuscriptHash(): String? = _state.value.snapshot?.manuscript?.contentHash

    fun acceptIncremental(envelope: ProtocolEnvelope): Boolean = evaluateIncremental(envelope).accepted

    fun evaluateIncremental(envelope: ProtocolEnvelope): IncrementalDecision {
        val current = _state.value
        if (current.sessionId != null && envelope.sessionId != current.sessionId) {
            _state.value = current.copy(sessionId = envelope.sessionId, awaitingSnapshot = true)
            return IncrementalDecision(false, "server session ID changed")
        }
        if (envelope.sequence <= current.lastSequence) return IncrementalDecision(false, "stale or duplicate sequence")
        if (current.lastSequence >= 0 && envelope.sequence > current.lastSequence + 1) {
            _state.value = current.copy(awaitingSnapshot = true, sequenceGaps = current.sequenceGaps + 1)
            return IncrementalDecision(false, "sequence gap")
        }
        _state.value = current.copy(lastSequence = envelope.sequence)
        return if (current.awaitingSnapshot) IncrementalDecision(false, "fresh snapshot required") else IncrementalDecision(true)
    }

    fun recordControlEnvelope(envelope: ProtocolEnvelope) {
        val current = _state.value
        if (current.sessionId != null && envelope.sessionId != current.sessionId) {
            _state.value = current.copy(sessionId = envelope.sessionId, awaitingSnapshot = true)
        } else if (envelope.sequence > current.lastSequence) {
            _state.value = current.copy(lastSequence = envelope.sequence)
        }
    }

    fun applyTranscript(event: TranscriptEvent) {
        val current = _state.value
        val snapshot = current.snapshot ?: return
        if (event.sessionRevision < snapshot.sessionRevision || event.manuscriptRevision != snapshot.manuscriptRevision) return
        _state.value = current.copy(latestTranscript = event.text)
    }

    fun applyRuntimeSettings(settings: RuntimeSettings): Boolean {
        val current = _state.value
        val prior = current.runtimeSettings
        if (prior != null && settings.settingsRevision <= prior.settingsRevision) return false
        _state.value = current.copy(runtimeSettings = settings)
        diagnostics?.record("settings", "info", "android.runtime_settings.applied", "Windows runtime settings applied.", details = mapOf("settingsRevision" to settings.settingsRevision.toString()))
        return true
    }

    fun applyManualRepositionResult(result: ManualRepositionResult) {
        _state.value = _state.value.copy(manualRepositionResult = result)
    }

    fun applyMovement(event: MovementEvent, eventId: String? = null): MovementApplication {
        val current = _state.value
        val snapshot = current.snapshot ?: return rejectMovement("missing manuscript snapshot")
        if (current.awaitingSnapshot) return rejectMovement("fresh snapshot required")
        if (event.sessionRevision < snapshot.sessionRevision) return rejectMovement("stale session revision")
        if (event.manuscriptRevision != snapshot.manuscriptRevision) return rejectMovement("stale manuscript revision")
        if ((current.latestMovement?.sessionRevision ?: -1) > event.sessionRevision) return rejectMovement("stale movement revision")
        val content = snapshot.manuscript.normalizedContent
            ?: return rejectMovement("missing manuscript content")
        if (event.targetCharacter !in 0..content.length) return rejectMovement("target character outside content")
        if (snapshot.manuscript.paragraphs.none { it.paragraphIndex == event.paragraphIndex }) return rejectMovement("target paragraph missing")
        _state.value = current.copy(
            latestMovement = event,
            latestMovementEventId = eventId ?: "${event.sessionRevision}:${event.targetTokenIndex}",
            lastRemoteMovementStatus = event.manualRepositionStatus ?: "normal",
            lastAcceptedMovementReason = event.reason,
            latestMovementRejection = null
        )
        diagnostics?.record("movement", "info", "android.movement.accepted", "Semantic movement accepted by SessionRepository.", details = mapOf("sessionRevision" to event.sessionRevision.toString(), "manuscriptRevision" to event.manuscriptRevision.toString(), "targetCharacter" to event.targetCharacter.toString(), "paragraphIndex" to event.paragraphIndex.toString(), "classification" to event.classification))
        return MovementApplication(true)
    }

    fun markDisconnected() { _state.value = _state.value.copy(awaitingSnapshot = true) }
    fun consumeSnapshotAnchor(identity: String): Boolean {
        val anchor = _state.value.snapshotAnchor ?: return false
        if (anchor.identity != identity || anchor.consumed) return false
        _state.value = _state.value.copy(snapshotAnchor = anchor.copy(consumed = true))
        diagnostics?.record("anchor", "info", "android.snapshot_anchor.consumed", "Snapshot anchor applied once and consumed.", details = mapOf("identity" to identity.take(80)))
        return true
    }
    fun clear() { _state.value = TabletSessionState() }
    fun recordMovementRejection(reason: String) = rejectMovement(reason)
    fun clearMovementRejection() { _state.value = _state.value.copy(latestMovementRejection = null) }

    private fun rejectMovement(reason: String): MovementApplication {
        _state.value = _state.value.copy(latestMovementRejection = reason)
        diagnostics?.record("movement", "warn", "android.movement.rejected", "Semantic movement rejected: $reason.", details = mapOf("reason" to reason))
        return MovementApplication(false, reason)
    }

    private fun restoreCachedContent(snapshot: SessionSnapshot): SessionSnapshot {
        if (snapshot.manuscript.normalizedContent != null) return snapshot
        val cached = cacheFile(snapshot.manuscript.contentHash).takeIf { it.exists() }?.readText() ?: return snapshot
        return snapshot.copy(manuscript = snapshot.manuscript.copy(normalizedContent = cached))
    }

    private fun chooseSettings(previous: RuntimeSettings?, incoming: RuntimeSettings?): RuntimeSettings? = when {
        incoming == null -> previous
        previous == null || incoming.settingsRevision >= previous.settingsRevision -> incoming
        else -> previous
    }

    private fun cacheFile(hash: String) = File(cacheDir, hash.replace(Regex("[^A-Za-z0-9._-]"), "_") + ".txt")
}
