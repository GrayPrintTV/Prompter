package app.prompter.tablet.ui.prompter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewportCoordinatesTest {
    @Test fun `first line aligned by before padding yields dead zone delta`() {
        val geometry = ViewportTargetGeometry(itemOffset = 0, viewportStartOffset = -894, beforeContentPadding = 894, lineCenterInsideParagraph = 28f, readingBandCenter = 922)
        assertEquals(922f, geometry.targetLineCenterInViewport)
        assertEquals(0f, geometry.desiredScrollDelta)
    }

    @Test fun `later line moves content upward while target above band moves it downward`() {
        val below = ViewportTargetGeometry(0, -894, 894, 140f, 922)
        val above = ViewportTargetGeometry(-300, -894, 894, 28f, 922)
        assertTrue(below.desiredScrollDelta > 0f)
        assertTrue(above.desiredScrollDelta < 0f)
    }

    @Test fun `line progression uses line scale rather than full band distance`() {
        val first = ViewportTargetGeometry(0, -894, 894, 28f, 922)
        val second = ViewportTargetGeometry(0, -894, 894, 84f, 922)
        assertEquals(56f, second.desiredScrollDelta - first.desiredScrollDelta)
    }
}
