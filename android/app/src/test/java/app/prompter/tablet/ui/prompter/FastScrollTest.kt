package app.prompter.tablet.ui.prompter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FastScrollTest {
    private val paragraphs = listOf(
        VisualParagraph("first", 0, 0, "a".repeat(100)),
        VisualParagraph("second", 1, 100, "b".repeat(300)),
        VisualParagraph("third", 2, 400, "c".repeat(100))
    )

    @Test fun `drag fraction maps proportionally through manuscript characters`() {
        assertEquals(FastScrollTarget(0, 0), fastScrollTargetForFraction(0f, paragraphs, 500))
        assertEquals(FastScrollTarget(1, 150), fastScrollTargetForFraction(.5f, paragraphs, 500))
        assertEquals(FastScrollTarget(2, 100), fastScrollTargetForFraction(1f, paragraphs, 500))
    }

    @Test fun `mapping clamps fractions and supports one very long paragraph`() {
        val oneParagraph = listOf(VisualParagraph("only", 0, 0, "x".repeat(10_000)))
        assertEquals(FastScrollTarget(0, 0), fastScrollTargetForFraction(-1f, oneParagraph, 10_000))
        assertEquals(FastScrollTarget(0, 7_500), fastScrollTargetForFraction(.75f, oneParagraph, 10_000))
        assertEquals(FastScrollTarget(0, 10_000), fastScrollTargetForFraction(2f, oneParagraph, 10_000))
    }

    @Test fun `thumb fraction reflects item offset and exact list ends`() {
        assertEquals(0f, currentFastScrollFraction(0, 0, 100, paragraphs, 500, false, true))
        assertEquals(.5f, currentFastScrollFraction(1, 150, 300, paragraphs, 500, true, true), .0001f)
        assertEquals(1f, currentFastScrollFraction(2, 10, 100, paragraphs, 500, true, false))
    }

    @Test fun `fast scroll uses the existing manual hold and anchor flow`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        assertTrue(controller.isManualHoldActive())
        controller.recordVisibleAnchor(TabletVisibleAnchor(250, 1_500, 20, 8, 0f))
        assertEquals(TabletManualOverrideState.ANCHOR_SENT, controller.manualOverrideState())
    }
}
