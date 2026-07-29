package app.prompter.tablet.ui.prompter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TabletProductStatusTest {
    @Test fun `normal tablet status uses narrator language`() {
        assertEquals("Disconnected", tabletNarrationStatus(false, false, false, false, false))
        assertEquals("Reconnecting…", tabletNarrationStatus(false, true, false, false, false))
        assertEquals("Connected — preparing microphone", tabletNarrationStatus(true, false, false, false, false))
        assertEquals("Ready to start", tabletNarrationStatus(true, false, true, false, false))
        assertEquals("Microphone ready", tabletNarrationStatus(true, false, true, true, false))
        assertEquals("Following narration", tabletNarrationStatus(true, false, true, true, true))
    }

    @Test fun `manual reposition status stays simple and normal following stays quiet`() {
        assertNull(manualFollowProductStatus("normal"))
        assertEquals("Repositioning…", manualFollowProductStatus("user scrolling"))
        assertEquals("Finding your place…", manualFollowProductStatus("waiting for reacquire"))
        assertEquals("Holding at your chosen position", manualFollowProductStatus("holding wrong-section"))
        assertEquals("Following resumed", manualFollowProductStatus("reacquired/resumed"))
    }
}
