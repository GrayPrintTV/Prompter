package app.prompter.tablet.ui.prompter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistCruiseControllerTest {
    @Test fun `160 WPM prior produces bounded visual cruise after a reliable anchor`() {
        val cruise = AssistCruiseController(staleSlowMs = 100, staleStopMs = 500)
        cruise.acceptAnchor(AssistCruiseAnchor(10, 1_000, .95, "on-track"), 48f)
        val frame = cruise.nextFrame(1_016, 16, 48f, true, null)
        assertFalse(frame.stopped)
        assertTrue(frame.deltaPx > 0f)
        assertTrue(frame.predictedDistancePx <= frame.predictionBoundPx)
        repeat(300) { cruise.nextFrame(1_032L + it * 16L, 16, 48f, true, null) }
        val bounded = cruise.nextFrame(1_400, 16, 48f, true, null)
        assertTrue(bounded.deltaPx <= 12f)
    }

    @Test fun `reliable forward anchors adapt pace but remain regularized`() {
        val cruise = AssistCruiseController()
        cruise.acceptAnchor(AssistCruiseAnchor(10, 1_000, .95, "on-track"), 50f)
        val sample = cruise.acceptAnchor(AssistCruiseAnchor(15, 3_000, .95, "on-track"), 50f)
        assertTrue(sample.eligible)
        assertTrue(sample.measuredPixelsPerSecond!! > 0f)
        assertTrue(sample.regularizedPixelsPerSecond!! > 0f)
    }

    @Test fun `low confidence and held anchors never cruise`() {
        val cruise = AssistCruiseController()
        cruise.acceptAnchor(AssistCruiseAnchor(10, 1_000, .2, "on-track"), 48f)
        assertTrue(cruise.nextFrame(1_016, 16, 48f, true, null).stopped)
        cruise.acceptAnchor(AssistCruiseAnchor(12, 2_000, .95, "held while lost"), 48f)
        assertTrue(cruise.nextFrame(2_016, 16, 48f, true, null).stopped)
    }

    @Test fun `manual hold gate stops cruise without changing semantic state`() {
        val cruise = AssistCruiseController()
        cruise.acceptAnchor(AssistCruiseAnchor(10, 1_000, .95, "on-track"), 48f)
        val frame = cruise.nextFrame(1_016, 16, 48f, true, "manual-scroll hold active")
        assertTrue(frame.stopped)
        assertEquals("manual-scroll hold active", frame.reason)
    }

    @Test fun `stale anchors stop prediction`() {
        val cruise = AssistCruiseController(staleSlowMs = 100, staleStopMs = 200)
        cruise.acceptAnchor(AssistCruiseAnchor(10, 1_000, .95, "on-track"), 48f)
        val frame = cruise.nextFrame(1_200, 16, 48f, true, null)
        assertTrue(frame.stopped)
        assertEquals("authoritative anchor stale", frame.reason)
    }

    @Test fun `duplicate anchor cannot reset the stale timer or supersede visual prediction`() {
        val cruise = AssistCruiseController(staleSlowMs = 100, staleStopMs = 200)
        cruise.acceptAnchor(AssistCruiseAnchor(10, 1_000, .95, "on-track"), 48f)
        val sample = cruise.acceptAnchor(AssistCruiseAnchor(10, 1_150, .95, "on-track"), 48f)
        assertFalse(sample.eligible)
        assertTrue(cruise.nextFrame(1_200, 16, 48f, true, null).stopped)
    }

    @Test fun `backward and reacquisition anchors do not contaminate pace estimation`() {
        val cruise = AssistCruiseController()
        cruise.acceptAnchor(AssistCruiseAnchor(20, 1_000, .95, "on-track"), 48f)
        val backward = cruise.acceptAnchor(AssistCruiseAnchor(18, 3_000, .95, "backward restart"), 48f)
        assertFalse(backward.eligible)
        val reacquired = cruise.acceptAnchor(AssistCruiseAnchor(30, 5_000, .95, "bounded forward reacquired"), 48f)
        assertFalse(reacquired.eligible)
    }

    @Test fun `layout reset clears stale pixel pace and returns to the 160 WPM prior`() {
        val cruise = AssistCruiseController()
        cruise.acceptAnchor(AssistCruiseAnchor(10, 1_000, .95, "on-track"), 48f)
        cruise.acceptAnchor(AssistCruiseAnchor(16, 3_000, .95, "on-track"), 48f)
        cruise.reset(clearPace = true)
        val sample = cruise.acceptAnchor(AssistCruiseAnchor(20, 4_000, .95, "on-track"), 48f)
        assertEquals(12.8f, sample.regularizedPixelsPerSecond!!, .01f)
    }

    @Test fun `manual hold keeps the visual anchor but excludes its pace sample`() {
        val cruise = AssistCruiseController()
        cruise.acceptAnchor(AssistCruiseAnchor(10, 1_000, .95, "on-track"), 48f)
        val sample = cruise.acceptAnchor(AssistCruiseAnchor(15, 3_000, .95, "on-track"), 48f, allowPaceSample = false)
        assertFalse(sample.eligible)
        assertEquals("manual hold excludes pace sample", sample.reason)
    }
}
