package app.prompter.tablet.ui.prompter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

class ReaderViewportStateTest {
    @Test fun `navigation keeps viewport and manual hold for the same manuscript`() {
        val cache = ReaderViewportCache()
        val key = ReaderManuscriptKey("book-a", "hash-a", 3)
        val reader = requireNotNull(cache.forManuscript(key))
        reader.followController.recordUserTouch()
        reader.manualTouchGeneration = 1

        val returned = requireNotNull(cache.forManuscript(key))
        assertSame(reader, returned)
        assertSame(reader.followController, returned.followController)
        assertEquals(TabletManualOverrideState.USER_SCROLLING, returned.followController.manualOverrideState())
        assertEquals(1, returned.manualTouchGeneration)
    }

    @Test fun `different manuscript or revision cannot inherit old viewport`() {
        val cache = ReaderViewportCache()
        val first = requireNotNull(cache.forManuscript(ReaderManuscriptKey("book-a", "hash-a", 3)))
        assertNotSame(first, cache.forManuscript(ReaderManuscriptKey("book-b", "hash-a", 3)))
        val second = requireNotNull(cache.forManuscript(ReaderManuscriptKey("book-b", "hash-a", 3)))
        assertNotSame(second, cache.forManuscript(ReaderManuscriptKey("book-b", "hash-b", 3)))
        val third = requireNotNull(cache.forManuscript(ReaderManuscriptKey("book-b", "hash-b", 3)))
        assertNotSame(third, cache.forManuscript(ReaderManuscriptKey("book-b", "hash-b", 4)))
        cache.forManuscript(null)
        val fourth = requireNotNull(cache.forManuscript(ReaderManuscriptKey("book-b", "hash-b", 4)))
        assertSame(fourth, cache.forManuscript(ReaderManuscriptKey("book-b", "hash-b", 4)))
    }
}
