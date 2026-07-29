package app.prompter.tablet.ui.prompter

import kotlin.math.max
import kotlin.math.min

/**
 * Visual-only pacing between authoritative Windows movement anchors.  This class deliberately
 * has no session mutation or transport dependency: its output is only a bounded pixel delta for
 * the Compose renderer to apply.
 */
data class AssistCruiseAnchor(
    val targetTokenIndex: Int,
    val receivedAtMs: Long,
    val confidence: Double,
    val classification: String
)

data class AssistCruisePaceSample(
    val eligible: Boolean,
    val reason: String,
    val measuredPixelsPerSecond: Float? = null,
    val regularizedPixelsPerSecond: Float? = null
)

data class AssistCruiseFrame(
    val deltaPx: Float,
    val velocityPixelsPerSecond: Float,
    val staleAgeMs: Long,
    val stopped: Boolean,
    val reason: String,
    val predictedDistancePx: Float = 0f,
    val predictionBoundPx: Float = 0f
)

class AssistCruiseController(
    private val initialWordsPerMinute: Float = 160f,
    private val wordsPerLine: Float = 10f,
    private val staleSlowMs: Long = 3_600,
    private val staleStopMs: Long = 9_000,
    private val confidenceFloor: Double = .76
) {
    private var latestAnchor: AssistCruiseAnchor? = null
    private var latestAnchorCanCruise = false
    private var estimatedPixelsPerSecond = 0f
    private var predictedSinceAnchorPx = 0f
    private var currentVelocityPixelsPerSecond = 0f

    fun acceptAnchor(anchor: AssistCruiseAnchor, lineHeightPx: Float, allowPaceSample: Boolean = true): AssistCruisePaceSample {
        val prior = priorPixelsPerSecond(lineHeightPx)
        val eligible = isReliable(anchor)
        val previous = latestAnchor
        if (previous != null && anchor.targetTokenIndex == previous.targetTokenIndex) {
            // A repeated accepted position is not new evidence. In particular it must not keep
            // resetting the stale timer while narration has moved beyond a skipped sentence.
            return AssistCruisePaceSample(false, "duplicate authoritative anchor ignored", regularizedPixelsPerSecond = estimatedPixelsPerSecond.takeIf { it > 0f })
        }
        latestAnchor = anchor
        predictedSinceAnchorPx = 0f
        currentVelocityPixelsPerSecond = 0f
        if (!eligible) {
            latestAnchorCanCruise = false
            return AssistCruisePaceSample(false, "anchor not reliable")
        }
        if (!allowPaceSample) {
            latestAnchorCanCruise = true
            if (estimatedPixelsPerSecond <= 0f) estimatedPixelsPerSecond = prior
            return AssistCruisePaceSample(false, "manual hold excludes pace sample", regularizedPixelsPerSecond = estimatedPixelsPerSecond)
        }

        if (previous == null || !isReliable(previous)) {
            latestAnchorCanCruise = true
            if (estimatedPixelsPerSecond <= 0f) estimatedPixelsPerSecond = prior
            return AssistCruisePaceSample(false, "waiting for a second reliable anchor", regularizedPixelsPerSecond = estimatedPixelsPerSecond)
        }

        val elapsedMs = anchor.receivedAtMs - previous.receivedAtMs
        val tokenDelta = anchor.targetTokenIndex - previous.targetTokenIndex
        if (elapsedMs !in 700..15_000 || tokenDelta <= 0) {
            latestAnchorCanCruise = false
            if (estimatedPixelsPerSecond <= 0f) estimatedPixelsPerSecond = prior
            return AssistCruisePaceSample(false, "anchor displacement not usable", regularizedPixelsPerSecond = estimatedPixelsPerSecond)
        }

        val measuredWordsPerMinute = tokenDelta * 60_000f / elapsedMs
        val measured = lineHeightPx * measuredWordsPerMinute / max(1f, wordsPerLine) / 60f
        if (measured !in (prior * .25f)..(prior * 3.2f)) {
            latestAnchorCanCruise = true
            if (estimatedPixelsPerSecond <= 0f) estimatedPixelsPerSecond = prior
            return AssistCruisePaceSample(false, "implausible pace sample ignored", measured, estimatedPixelsPerSecond)
        }
        val clamped = measured.coerceIn(prior * .35f, prior * 2.8f)
        estimatedPixelsPerSecond = if (estimatedPixelsPerSecond > 0f) {
            estimatedPixelsPerSecond * .65f + clamped * .35f
        } else {
            clamped
        }
        latestAnchorCanCruise = true
        return AssistCruisePaceSample(true, "reliable forward anchor displacement", measured, estimatedPixelsPerSecond)
    }

    fun nextFrame(nowMs: Long, deltaMs: Long, lineHeightPx: Float, enabled: Boolean, gateReason: String?): AssistCruiseFrame {
        val anchor = latestAnchor
            ?: return AssistCruiseFrame(0f, 0f, 0, true, "no authoritative anchor")
        if (!enabled) return stop(nowMs - anchor.receivedAtMs, "assist cruise disabled")
        if (!isReliable(anchor)) return stop(nowMs - anchor.receivedAtMs, "anchor not reliable")
        if (!latestAnchorCanCruise) return stop(nowMs - anchor.receivedAtMs, "anchor has no forward pace evidence")
        if (gateReason != null) return stop(nowMs - anchor.receivedAtMs, gateReason)

        val staleAgeMs = (nowMs - anchor.receivedAtMs).coerceAtLeast(0)
        if (staleAgeMs >= staleStopMs) return stop(staleAgeMs, "authoritative anchor stale")
        val prior = priorPixelsPerSecond(lineHeightPx)
        val targetVelocity = (if (estimatedPixelsPerSecond > 0f) estimatedPixelsPerSecond else prior) * staleMultiplier(staleAgeMs)
        val frameMs = deltaMs.coerceIn(1, 50).toFloat()
        val acceleration = max(.8f, prior * .55f)
        currentVelocityPixelsPerSecond += (targetVelocity - currentVelocityPixelsPerSecond)
            .coerceIn(-acceleration * frameMs / 1000f, acceleration * frameMs / 1000f)
        val horizon = min(lineHeightPx * 1.25f, max(lineHeightPx * .35f, targetVelocity * 2_200f / 1000f))
        val remaining = (horizon - predictedSinceAnchorPx).coerceAtLeast(0f)
        val delta = min(min(currentVelocityPixelsPerSecond * frameMs / 1000f, 12f), remaining)
        predictedSinceAnchorPx += delta
        return AssistCruiseFrame(delta, currentVelocityPixelsPerSecond, staleAgeMs, false, "cruising", predictedSinceAnchorPx, horizon)
    }

    fun reset(clearPace: Boolean = false) {
        latestAnchor = null
        latestAnchorCanCruise = false
        predictedSinceAnchorPx = 0f
        currentVelocityPixelsPerSecond = 0f
        if (clearPace) estimatedPixelsPerSecond = 0f
    }

    private fun stop(staleAgeMs: Long, reason: String): AssistCruiseFrame {
        currentVelocityPixelsPerSecond = 0f
        return AssistCruiseFrame(0f, 0f, staleAgeMs.coerceAtLeast(0), true, reason)
    }

    private fun priorPixelsPerSecond(lineHeightPx: Float) = max(1f, lineHeightPx) * initialWordsPerMinute / max(1f, wordsPerLine) / 60f

    private fun staleMultiplier(ageMs: Long): Float = when {
        ageMs <= staleSlowMs -> 1f
        else -> (1f - ((ageMs - staleSlowMs).toFloat() / max(1L, staleStopMs - staleSlowMs))).coerceIn(0f, 1f)
    }

    private fun isReliable(anchor: AssistCruiseAnchor): Boolean {
        if (anchor.confidence < confidenceFloor) return false
        val classification = anchor.classification.lowercase()
        return listOf("held", "lost", "resync", "reacquir", "backward", "restart", "retake").none(classification::contains)
    }
}
