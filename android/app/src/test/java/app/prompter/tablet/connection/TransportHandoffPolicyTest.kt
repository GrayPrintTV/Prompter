package app.prompter.tablet.connection

import app.prompter.tablet.discovery.DiscoveredServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class TransportHandoffPolicyTest {
    private val lan = DiscoveredServer("server", "LAN", "192.168.1.2", 43127, 1, 2, false)
    private val usb = UsbEndpoint("server", 43128, TransportPreference.AUTO).discovered()

    @Test fun `candidate is promoted only after authentication and matching server identity`() {
        assertFalse(transportPromotionDecision(false, true).promote)
        assertFalse(transportPromotionDecision(true, false).promote)
        val accepted = transportPromotionDecision(true, true)
        assertTrue(accepted.promote)
        assertTrue(accepted.retirePreviousAfterPromotion)
        assertTrue(accepted.preserveNarrationSession)
    }

    @Test fun `USB loss falls back to LAN unless diagnostics forced USB only`() {
        assertSame(lan, reconnectTargetAfterLoss(usb, lan, TransportPreference.AUTO))
        assertSame(usb, reconnectTargetAfterLoss(usb, lan, TransportPreference.USB_ONLY))
        assertSame(lan, reconnectTargetAfterLoss(lan, null, TransportPreference.AUTO))
    }

    @Test fun `retiring transport generation cannot deliver messages after promotion`() {
        val fence = TransportGenerationFence()
        val lanGeneration = fence.activate()
        assertTrue(fence.accepts(lanGeneration))
        val usbGeneration = fence.activate()
        assertFalse(fence.accepts(lanGeneration))
        assertTrue(fence.accepts(usbGeneration))
        assertEquals(2L, usbGeneration)
    }
}
