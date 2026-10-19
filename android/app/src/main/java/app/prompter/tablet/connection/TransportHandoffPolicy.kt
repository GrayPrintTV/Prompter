package app.prompter.tablet.connection

import app.prompter.tablet.discovery.DiscoveredServer

data class TransportPromotionDecision(
    val promote: Boolean,
    val retirePreviousAfterPromotion: Boolean,
    val preserveNarrationSession: Boolean,
    val reason: String
)

fun transportPromotionDecision(candidateAuthenticated: Boolean, identityMatches: Boolean) = when {
    !candidateAuthenticated -> TransportPromotionDecision(false, false, true, "candidate is not authenticated")
    !identityMatches -> TransportPromotionDecision(false, false, true, "candidate server identity differs")
    else -> TransportPromotionDecision(true, true, true, "authenticated candidate may be promoted atomically")
}

fun reconnectTargetAfterLoss(
    failed: DiscoveredServer,
    lanFallback: DiscoveredServer?,
    preference: TransportPreference
) = if (failed.transport == "usb-adb-reverse" && preference != TransportPreference.USB_ONLY) {
    lanFallback ?: failed
} else failed

class TransportGenerationFence {
    private var active = 0L
    fun activate(): Long = ++active
    fun accepts(generation: Long) = generation == active
}
