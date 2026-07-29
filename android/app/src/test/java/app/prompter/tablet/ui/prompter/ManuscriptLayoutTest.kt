package app.prompter.tablet.ui.prompter

import app.prompter.tablet.protocol.*
import org.junit.Assert.*
import org.junit.Test

class ManuscriptLayoutTest {
    private fun snapshot(content: String, ranges: List<CharacterRange> = listOf(CharacterRange(0, content.length))) = SessionSnapshot(
        1, 1,
        ManuscriptPayload(
            "m", "hash", content,
            paragraphs = ranges.mapIndexed { index, range -> ParagraphAnchor(index, range, index, index + 1) },
            sentences = emptyList(), tokens = emptyList()
        ),
        Position(0, 0, 0, 0), "following", 1.0, displayHints = DisplayHints()
    )

    @Test fun `long paragraphs are chunked with stable keys`() {
        // 249 characters is approximately three 96-character display chunks. The previous
        // 4,500-character fixture expected three chunks from the obsolete ~2,000-char target.
        val text = "word ".repeat(50).trimEnd()
        val snapshot = snapshot(text)
        val first = manuscriptChunks(snapshot)
        val second = manuscriptChunks(snapshot)
        assertEquals(3, first.size)
        assertEquals(listOf("hash:0:0", "hash:0:1", "hash:0:2"), first.map { it.key })
        assertEquals(first.map { it.key }, second.map { it.key })
    }

    @Test fun `chunks reconstruct text with continuous absolute offsets`() {
        val first = "First paragraph is deliberately long enough to require more than one bounded display chunk. ".repeat(3).trimEnd()
        val second = "Short second paragraph."
        val content = "$first\n\n$second"
        val secondStart = first.length + 2
        val chunks = manuscriptChunks(snapshot(content, listOf(CharacterRange(0, first.length), CharacterRange(secondStart, content.length))))
        assertEquals(first, chunks.filter { it.paragraphIndex == 0 }.joinToString("") { it.text })
        assertEquals(second, chunks.filter { it.paragraphIndex == 1 }.joinToString("") { it.text })
        chunks.groupBy { it.paragraphIndex }.values.forEach { paragraphChunks ->
            paragraphChunks.zipWithNext().forEach { (left, right) -> assertEquals(left.characterEnd, right.characterStart) }
        }
        assertEquals(0, chunks.first { it.paragraphIndex == 0 }.characterStart)
        assertEquals(first.length, chunks.last { it.paragraphIndex == 0 }.characterEnd)
        assertEquals(secondStart, chunks.first { it.paragraphIndex == 1 }.characterStart)
        assertEquals(content.length, chunks.last { it.paragraphIndex == 1 }.characterEnd)
    }

    @Test fun `movement regions within one long paragraph resolve to different chunks`() {
        val text = "narration ".repeat(40).trimEnd()
        val snapshot = snapshot(text)
        val chunks = manuscriptChunks(snapshot)
        fun movement(character: Int) = MovementEvent(1, 1, 0, 0, character, 0, 0, .9, 500, "on-track", "test")
        val early = resolveMovementTarget(snapshot, chunks, movement(20)) as MovementTargetResolution.Resolved
        val late = resolveMovementTarget(snapshot, chunks, movement(text.length - 20)) as MovementTargetResolution.Resolved
        assertNotEquals(early.itemIndex, late.itemIndex)
    }

    @Test fun `normal short paragraphs remain one item`() {
        val first = "Short first paragraph."
        val second = "Short second paragraph."
        val content = "$first\n\n$second"
        val chunks = manuscriptChunks(snapshot(content, listOf(CharacterRange(0, first.length), CharacterRange(first.length + 2, content.length))))
        assertEquals(2, chunks.size)
        assertEquals(listOf(0, 1), chunks.map { it.paragraphIndex })
    }

    @Test fun `visual paragraphs hide adjacent chunk boundaries but keep real paragraph boundaries`() {
        val first = "continuous narration ".repeat(20).trimEnd()
        val second = "A distinct source paragraph."
        val content = "$first\n\n$second"
        val snapshot = snapshot(content, listOf(CharacterRange(0, first.length), CharacterRange(first.length + 2, content.length)))
        val chunks = manuscriptChunks(snapshot, maxCharacters = 40)
        val visual = visualParagraphs(snapshot, chunks)
        assertTrue(chunks.count { it.paragraphIndex == 0 } > 1)
        assertEquals(2, visual.size)
        assertEquals(first, visual[0].text)
        assertEquals(second, visual[1].text)
    }

    @Test fun `different character positions within a visual paragraph estimate distinct line positions`() {
        assertTrue(estimatedTargetLineCenter(10, 100, 400) < estimatedTargetLineCenter(80, 100, 400))
    }

    @Test fun `overlong unbroken token makes progress without loss`() {
        val text = "x".repeat(250)
        val chunks = manuscriptChunks(snapshot(text))
        assertEquals(3, chunks.size)
        assertEquals(text, chunks.joinToString("") { it.text })
        assertTrue(chunks.all { it.text.isNotEmpty() })
        assertEquals(listOf(0, 96, 192), chunks.map { it.characterStart })
        assertEquals(text.length, chunks.last().characterEnd)
    }
}
