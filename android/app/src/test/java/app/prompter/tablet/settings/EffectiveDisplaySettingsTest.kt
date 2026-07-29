package app.prompter.tablet.settings

import app.prompter.tablet.protocol.RuntimeDisplaySettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EffectiveDisplaySettingsTest {
    private fun inherited(font: Float = 35f, spacing: Float = 1.55f, width: Float = .70f) = RuntimeDisplaySettings(
        "#111315", "#F4EBDD", "#80CBC4", .14f, font, spacing, 28f, 1.35f, .38f, 1f, width
    )

    @Test fun `Windows inherited typography applies live`() {
        val display = effectiveDisplaySettings(inherited(42f, 1.8f, .82f), TabletDisplaySettings())
        assertEquals(42f, display.fontSizeSp)
        assertEquals(1.8f, display.lineSpacing)
        assertEquals(.82f, display.contentWidthFraction)
    }

    @Test fun `local override blocks inherited typography but retains safe display-only state`() {
        val local = TabletDisplaySettings(useWindowsDisplaySettings = false, fontSizeSp = 55f, lineSpacing = 1.2f, contentWidthFraction = .6f)
        val display = effectiveDisplaySettings(inherited(42f, 1.8f, .82f), local)
        assertEquals(55f, display.fontSizeSp)
        assertEquals(1.2f, display.lineSpacing)
        assertEquals(.6f, display.contentWidthFraction)
        assertEquals(1.35f, display.paragraphSpacingEm)
    }

    @Test fun `legacy margin-only snapshot derives bounded width`() {
        val legacy = inherited().copy(contentWidthFraction = null, sideMarginsDp = 70f)
        assertTrue(effectiveDisplaySettings(legacy, TabletDisplaySettings()).contentWidthFraction < .6f)
    }
}
