package app.prompter.tablet.ui.prompter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.roundToInt

class ManuscriptNavigationTest {
    @Test fun `bounded ordinal parser supports Arabic Roman and English forms`() {
        assertEquals(12, parseBookOrdinal("12"))
        assertEquals(12, parseBookOrdinal("XII"))
        assertEquals(12, parseBookOrdinal("Twelve"))
        assertEquals(21, parseBookOrdinal("twenty-one"))
        assertEquals(112, parseBookOrdinal("One Hundred Twelve"))
        assertNull(parseBookOrdinal("IIX"))
        assertNull(parseBookOrdinal("one two"))
        assertNull(parseBookOrdinal("zero"))
    }

    @Test fun `Arabic chapter sequence is recognized and sequence supported`() {
        val index = indexOf("Chapter 1", prose("one"), "Chapter 2", prose("two"), "Chapter 3", prose("three"))
        val chapters = index.markers.filter { it.kind == ManuscriptStructureKind.CHAPTER }

        assertEquals(listOf(1, 2, 3), chapters.map { it.ordinal })
        assertTrue(chapters.all { it.sequenceSupported })
    }

    @Test fun `Roman chapter sequence is recognized`() {
        val index = indexOf("CHAPTER I", prose("one"), "CHAPTER II", prose("two"), "CHAPTER III", prose("three"))
        assertEquals(listOf(1, 2, 3), index.markers.mapNotNull { it.ordinal })
        assertTrue(index.markers.all { it.sequenceSupported })
    }

    @Test fun `number-word chapter sequence is recognized`() {
        val index = indexOf("Chapter One", prose("one"), "Chapter Two", prose("two"), "Chapter Three", prose("three"))
        assertEquals(listOf(1, 2, 3), index.markers.mapNotNull { it.ordinal })
    }

    @Test fun `inline titles are split from labeled heading ordinals`() {
        val index = indexOf(
            "Chapter 12: The Long Road",
            prose("one"),
            "Chapter XIII — The Last Valley",
            prose("two"),
            "Book Three — Departure"
        )

        assertEquals("Chapter 12", index.markers[0].heading)
        assertEquals("The Long Road", index.markers[0].title)
        assertEquals("Chapter XIII", index.markers[1].heading)
        assertEquals("The Last Valley", index.markers[1].title)
        assertEquals("Departure", index.markers[2].title)
    }

    @Test fun `heading followed by separate title is indexed without consuming prose`() {
        val titled = indexOf("CHAPTER TWELVE", "The Long Road Home", prose("body"))
        assertEquals("The Long Road Home", titled.markers.single().title)

        val proseAfter = indexOf("Chapter 2", "They walked home before the storm arrived.")
        assertNull(proseAfter.markers.single().title)
    }

    @Test fun `Part and Chapter form an active hierarchy`() {
        val paragraphs = paragraphs(
            "Part I: The Near East",
            prose("part"),
            "Chapter 1: Mesopotamia — The First Clay",
            prose("chapter"),
            "1.1 The Primordial Waters",
            prose("subsection")
        )
        val index = ManuscriptNavigationIndex.build(paragraphs, manuscriptLength(paragraphs))
        val hierarchy = index.activeHierarchyAt(paragraphs.last().characterStart)

        assertEquals("Part I", hierarchy.part?.heading)
        assertEquals("The Near East", hierarchy.part?.title)
        assertEquals("Chapter 1", hierarchy.chapter?.heading)
        assertEquals("Mesopotamia — The First Clay", hierarchy.chapter?.title)
        assertEquals("1.1", hierarchy.subsection?.heading)
    }

    @Test fun `decimal subsection sequences and hierarchy resets are recognized`() {
        val index = indexOf(
            "1.1 The Primordial Waters", prose("one"),
            "1.2 The Sovereign of Babylon", prose("two"),
            "1.7 Chapter Conclusion", prose("seven"),
            "2.1 The Weighing of the Heart", prose("new hierarchy"),
            "2.2 The Eternal Nile"
        )
        val subsections = index.markers.filter { it.level == ManuscriptStructureLevel.SUBSECTION }

        assertEquals(listOf("1.1", "1.2", "1.7", "2.1", "2.2"), subsections.map { it.heading })
        assertTrue(subsections.all { it.sequenceSupported })
    }

    @Test fun `Introduction is naturally superseded by Part and Chapter markers`() {
        val paragraphs = paragraphs(
            "Introduction", prose("intro"),
            "Part I: Origins", prose("part"),
            "Chapter 1: First Light", prose("chapter")
        )
        val index = ManuscriptNavigationIndex.build(paragraphs, manuscriptLength(paragraphs))

        assertEquals("Introduction", index.activeHierarchyAt(paragraphs[1].characterStart).chapter?.heading)
        val later = index.activeHierarchyAt(paragraphs.last().characterStart)
        assertEquals("Part I", later.part?.heading)
        assertEquals("Chapter 1", later.chapter?.heading)
        assertFalse(later.chapter?.heading == "Introduction")
    }

    @Test fun `ordinary prose mentioning labels and number words is rejected`() {
        val index = indexOf(
            "Chapter house stood at the end of the road.",
            "Part of the problem was already obvious",
            "She began chapter seventeen that evening.",
            "Twelve people crossed the square before dawn."
        )
        assertTrue(index.markers.isEmpty())
        assertNull(detectedSectionHeading("Part of the problem was already obvious"))
    }

    @Test fun `random isolated numeric paragraphs remain unaccepted`() {
        val index = indexOf("7", prose("seven"), "42", prose("forty two"), "3", prose("three"))
        assertTrue(index.markers.isEmpty())
    }

    @Test fun `short numbered list is not promoted despite a coherent numeric sequence`() {
        val index = indexOf("1", "Buy milk.", "2", "Call home.", "3", "Lock door.")
        assertTrue(index.markers.isEmpty())
    }

    @Test fun `standalone numeric sequence is promoted by global evidence`() {
        val index = indexOf(
            "1", "First Light", prose("one"),
            "2", "The Crossing", prose("two"),
            "3", "Home Again", prose("three")
        )
        val chapters = index.markers.filter { it.kind == ManuscriptStructureKind.UNLABELED_ORDINAL }

        assertEquals(listOf(1, 2, 3), chapters.map { it.ordinal })
        assertTrue(chapters.all { it.sequenceSupported && it.confidence >= 70 })
        assertEquals("The Crossing", chapters[1].title)
    }

    @Test fun `named front and back matter are accepted and reset prior hierarchy`() {
        val paragraphs = paragraphs(
            "Preface", prose("preface"),
            "Chapter 1", prose("chapter"),
            "Epilogue", prose("epilogue"),
            "Acknowledgments", prose("thanks"),
            "Bibliography"
        )
        val index = ManuscriptNavigationIndex.build(paragraphs, manuscriptLength(paragraphs))

        assertEquals(
            listOf("Preface", "Chapter 1", "Epilogue", "Acknowledgments", "Bibliography"),
            index.markers.map { it.heading }
        )
        val afterEpilogue = index.activeHierarchyAt(paragraphs[5].characterStart)
        assertNull(afterEpilogue.part)
        assertEquals("Epilogue", afterEpilogue.chapter?.heading)
    }

    @Test fun `active hierarchy lookup works before between and after markers`() {
        val paragraphs = paragraphs(
            prose("opening"),
            "Chapter 1", prose("first"),
            "Chapter 2", prose("second"),
            "Chapter 3", prose("third")
        )
        val index = ManuscriptNavigationIndex.build(paragraphs, manuscriptLength(paragraphs))

        assertTrue(index.activeHierarchyAt(0).isEmpty)
        assertEquals("Chapter 1", index.activeHierarchyAt(paragraphs[2].characterStart).chapter?.heading)
        assertEquals("Chapter 2", index.activeHierarchyAt(paragraphs[4].characterStart).chapter?.heading)
        assertEquals("Chapter 3", index.activeHierarchyAt(manuscriptLength(paragraphs)).chapter?.heading)
    }

    @Test fun `word positions are precomputed and found by character offset`() {
        val paragraphs = paragraphs("one two three", "four five")
        val index = ManuscriptNavigationIndex.build(paragraphs, manuscriptLength(paragraphs))

        assertEquals(5, index.totalWords)
        assertEquals(1, index.wordPositionAt(0))
        assertEquals(2, index.wordPositionAt(4))
        assertEquals(3, index.wordPositionAt(paragraphs[0].text.length))
        assertEquals(4, index.wordPositionAt(paragraphs[1].characterStart))
        assertEquals(5, index.wordPositionAt(manuscriptLength(paragraphs)))
    }

    @Test fun `snippets stay local near manuscript beginning middle and end`() {
        val paragraphs = paragraphs(
            "Beginning words establish the opening scene for everyone.",
            "Middle words describe the valley and the narrow road through it.",
            "Ending words close the story in a quiet room at dawn."
        )
        val index = ManuscriptNavigationIndex.build(paragraphs, manuscriptLength(paragraphs))

        assertTrue(index.snippetAt(0, 20).contains("Beginning words"))
        assertTrue(index.snippetAt(paragraphs[1].characterStart + 25, 18).contains("valley"))
        assertTrue(index.snippetAt(manuscriptLength(paragraphs), 20).contains("at dawn"))
    }

    @Test fun `130k-word indexing is deterministic for one huge paragraph`() {
        val text = (1..130_000).joinToString(" ") { "word$it" }
        val paragraph = VisualParagraph("huge", 0, 0, text)
        val first = ManuscriptNavigationIndex.build(listOf(paragraph), text.length)
        val second = ManuscriptNavigationIndex.build(listOf(paragraph), text.length)
        val preview = first.previewAtFraction(.75f)
        val targetCharacter = (text.length * .75f).roundToInt()
        val expectedWordPosition = Regex("\\S+").findAll(text.substring(0, targetCharacter + 1)).count()

        assertEquals(130_000, first.totalWords)
        assertEquals(first.markers, second.markers)
        assertEquals(expectedWordPosition, preview.wordPosition)
        assertTrue(preview.hierarchy.isEmpty)
        assertTrue(preview.snippet.length < 170)
    }

    private fun indexOf(vararg texts: String): ManuscriptNavigationIndex {
        val paragraphs = paragraphs(*texts)
        return ManuscriptNavigationIndex.build(paragraphs, manuscriptLength(paragraphs))
    }

    private fun paragraphs(vararg texts: String): List<VisualParagraph> {
        var character = 0
        return texts.mapIndexed { index, text ->
            VisualParagraph("p$index", index, character, text).also { character += text.length + 2 }
        }
    }

    private fun manuscriptLength(paragraphs: List<VisualParagraph>): Int =
        paragraphs.last().characterStart + paragraphs.last().text.length

    private fun prose(label: String) =
        "This is ordinary manuscript prose for $label, with enough words to separate structural markers clearly."
}
