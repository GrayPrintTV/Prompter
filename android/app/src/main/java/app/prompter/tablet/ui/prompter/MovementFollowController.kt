package app.prompter.tablet.ui.prompter

import app.prompter.tablet.protocol.MovementEvent
import app.prompter.tablet.protocol.SessionSnapshot
import kotlin.math.abs

const val TABLET_MANUAL_REACQUIRE_TOLERANCE_TOKENS = 64
const val TABLET_MANUAL_REACQUIRE_TOLERANCE_PARAGRAPHS = 1
const val TABLET_MANUAL_REACQUIRE_TOLERANCE_SENTENCES = 8
const val TABLET_MANUAL_REACQUIRE_TOLERANCE_CHARACTERS = 1200

sealed interface MovementTargetResolution {
    data class Resolved(val itemIndex: Int, val localCharacterOffset: Int) : MovementTargetResolution
    data class Unresolved(val reason: String) : MovementTargetResolution
}

fun resolveMovementTarget(snapshot: SessionSnapshot, chunks: List<ManuscriptChunk>, movement: MovementEvent): MovementTargetResolution {
    val content = snapshot.manuscript.normalizedContent
        ?: return MovementTargetResolution.Unresolved("missing manuscript")
    if (movement.manuscriptRevision != snapshot.manuscriptRevision) return MovementTargetResolution.Unresolved("stale manuscript revision")
    if (movement.sessionRevision < snapshot.sessionRevision) return MovementTargetResolution.Unresolved("stale session revision")
    if (movement.targetCharacter !in 0..content.length) return MovementTargetResolution.Unresolved("target character outside content")
    if (snapshot.manuscript.paragraphs.none { it.paragraphIndex == movement.paragraphIndex }) return MovementTargetResolution.Unresolved("target paragraph missing")
    val index = chunks.indexOfLast { it.paragraphIndex == movement.paragraphIndex && it.characterStart <= movement.targetCharacter }
    if (index < 0) return MovementTargetResolution.Unresolved("item lookup failure")
    val chunk = chunks[index]
    return MovementTargetResolution.Resolved(index, (movement.targetCharacter - chunk.characterStart).coerceIn(0, chunk.text.length))
}

data class TabletVisibleAnchor(
    val tokenIndex: Int,
    val character: Int,
    val sentenceIndex: Int,
    val paragraphIndex: Int,
    val distanceFromReadingBandPx: Float
)

fun nearestTabletVisibleAnchor(candidates: List<TabletVisibleAnchor>): TabletVisibleAnchor? =
    candidates.minByOrNull { abs(it.distanceFromReadingBandPx) }

fun isAuthoritativeMovementNearTabletAnchor(anchor: TabletVisibleAnchor, movement: MovementEvent) =
    abs(movement.targetTokenIndex - anchor.tokenIndex) <= TABLET_MANUAL_REACQUIRE_TOLERANCE_TOKENS &&
        abs(movement.paragraphIndex - anchor.paragraphIndex) <= TABLET_MANUAL_REACQUIRE_TOLERANCE_PARAGRAPHS &&
        abs(movement.sentenceIndex - anchor.sentenceIndex) <= TABLET_MANUAL_REACQUIRE_TOLERANCE_SENTENCES &&
        abs(movement.targetCharacter - anchor.character) <= TABLET_MANUAL_REACQUIRE_TOLERANCE_CHARACTERS

sealed interface ManualMovementDecision {
    data object Apply : ManualMovementDecision
    data class Suppress(val reason: String) : ManualMovementDecision
    data class Resume(val reason: String) : ManualMovementDecision
}

enum class TabletManualOverrideState {
    FOLLOWING,
    USER_SCROLLING,
    ANCHOR_SENT,
    WAITING_FOR_NEARBY_SPEECH,
    REJECTED_HOLD
}

class MovementFollowController {
    private var state = TabletManualOverrideState.FOLLOWING
    private var scrollObserved = false
    private var visibleAnchor: TabletVisibleAnchor? = null

    fun recordUserTouch(): Boolean {
        val replaced = state != TabletManualOverrideState.FOLLOWING
        state = TabletManualOverrideState.USER_SCROLLING
        scrollObserved = false
        visibleAnchor = null
        return replaced
    }

    fun recordScrollObserved() {
        if (state != TabletManualOverrideState.FOLLOWING) scrollObserved = true
    }

    fun recordVisibleAnchor(anchor: TabletVisibleAnchor) {
        state = TabletManualOverrideState.ANCHOR_SENT
        scrollObserved = true
        visibleAnchor = anchor
    }

    fun recordCoordinatorResult(accepted: Boolean, tokenIndex: Int): Boolean {
        if (state == TabletManualOverrideState.FOLLOWING || visibleAnchor?.tokenIndex != tokenIndex) return false
        state = if (accepted) {
            TabletManualOverrideState.WAITING_FOR_NEARBY_SPEECH
        } else {
            TabletManualOverrideState.REJECTED_HOLD
        }
        return true
    }

    fun cancelTouchWithoutScroll(): Boolean {
        if (state != TabletManualOverrideState.USER_SCROLLING || scrollObserved || visibleAnchor != null) return false
        state = TabletManualOverrideState.FOLLOWING
        return true
    }

    fun isManualHoldActive() = state != TabletManualOverrideState.FOLLOWING
    fun manualOverrideState() = state

    fun recordAnchorSendFailure(tokenIndex: Int): Boolean {
        if (visibleAnchor?.tokenIndex != tokenIndex) return false
        visibleAnchor = null
        state = TabletManualOverrideState.FOLLOWING
        return true
    }

    fun evaluateMovement(movement: MovementEvent): ManualMovementDecision {
        if (state == TabletManualOverrideState.FOLLOWING) return ManualMovementDecision.Apply
        val anchor = visibleAnchor
        val distance = anchor?.let { movement.targetTokenIndex - it.tokenIndex }
        val explicitlyReacquired = anchor != null &&
            movement.manualRepositionStatus == "reacquired" &&
            movement.manualAnchorTokenIndex == anchor.tokenIndex
        val structurallyNear = anchor != null && isAuthoritativeMovementNearTabletAnchor(anchor, movement)
        if (explicitlyReacquired || structurallyNear) {
            state = TabletManualOverrideState.FOLLOWING
            return ManualMovementDecision.Resume(
                if (explicitlyReacquired) {
                    "Server confirmed reacquisition for tablet anchor ${anchor.tokenIndex}; auto-follow resumed."
                } else {
                    "Authoritative target ${movement.targetTokenIndex} is in the local region of tablet anchor ${anchor.tokenIndex}; auto-follow resumed."
                }
            )
        }
        if (
            anchor != null &&
            movement.manualRepositionStatus == "holding" &&
            movement.manualAnchorTokenIndex == anchor.tokenIndex
        ) {
            state = TabletManualOverrideState.REJECTED_HOLD
        }
        return ManualMovementDecision.Suppress(
            if (anchor == null) {
                "Tablet manual scroll is settling; remote/session update suppressed."
            } else if (movement.manualRepositionStatus == "holding" && movement.manualAnchorTokenIndex == anchor.tokenIndex) {
                "Speech remains ${movement.manualAnchorDistanceTokens ?: "an unknown number of"} tokens from tablet anchor ${anchor.tokenIndex}; holding without snapback."
            } else {
                "Tablet manual anchor ${anchor.tokenIndex} is awaiting evidence from its paragraph region; snapback prevented."
            }
        )
    }
}
