package app.prompter.tablet.ui.prompter

import app.prompter.tablet.protocol.RuntimeFollowSettings
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

data class SmoothFollowPlan(val policy: String, val durationMs: Int, val shouldAnimate: Boolean)

fun planSmoothFollow(distancePx: Float, durationHintMs: Long, follow: RuntimeFollowSettings): SmoothFollowPlan {
    val distance = abs(distancePx)
    if (!follow.enabled) return SmoothFollowPlan("disabled", 0, false)
    if (distance <= follow.deadZoneDp) return SmoothFollowPlan("dead-zone", 0, false)
    val large = distance > 1400f
    if (large && follow.largeCorrectionPolicy == "snap") return SmoothFollowPlan("snap", 0, false)
    val speed = max(1f, follow.maximumSpeedDpPerSec)
    val speedMinimum = ceil(distance / speed * 1000f).toInt()
    val smoothness = .35f + follow.smoothness.coerceIn(0f, 1f) * 1.4f
    val hinted = (durationHintMs.coerceIn(250, 6000) * smoothness).toInt()
    val catchUp = if (distance > 500f) (1f - follow.catchUpAggressiveness.coerceIn(0f, 1f) * .35f) else 1f
    val duration = max(speedMinimum, (hinted * catchUp).toInt()).coerceIn(180, if (large) 5000 else 4000)
    return SmoothFollowPlan(if (large) "resync" else if (distance > 500f) "catch-up" else "normal", duration, true)
}
