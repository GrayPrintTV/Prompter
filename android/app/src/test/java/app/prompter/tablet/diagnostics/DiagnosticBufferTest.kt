package app.prompter.tablet.diagnostics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DiagnosticBufferTest {
    @Test fun `diagnostic buffer remains bounded under sustained audio and movement traffic`() {
        val buffer = BoundedDiagnosticBuffer<Int>(50)
        repeat(10_000) { buffer.add(it) }

        val snapshot = buffer.snapshot()
        assertEquals(50, snapshot.size)
        assertEquals(9_950, snapshot.first())
        assertEquals(9_999, snapshot.last())
    }

    @Test fun `high frequency diagnostic limiter emits only at its configured cadence`() {
        val limiter = DiagnosticRateLimiter()
        assertTrue(limiter.shouldEmit("audio", 1_000, 5_000))
        assertFalse(limiter.shouldEmit("audio", 1_200, 5_000))
        assertFalse(limiter.shouldEmit("audio", 5_999, 5_000))
        assertTrue(limiter.shouldEmit("audio", 6_000, 5_000))
        assertTrue(limiter.shouldEmit("movement", 1_200, 5_000))
    }
}
