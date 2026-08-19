package app.prompter.tablet.session

import app.prompter.tablet.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SnapshotSyncAssemblerTest {
    private fun header(contentLength: Int = 11, tokenCount: Int = 2) = SessionSnapshotStart(
        syncId = "sync-1", sessionRevision = 4, manuscriptRevision = 2,
        manuscript = ManuscriptSyncManifest("m", "sha256:test", contentLength, 1, tokenCount),
        chunkCounts = SnapshotChunkCounts(2, 1, 1),
        acceptedPosition = Position(0, 0, 0, 0), followState = "following", currentConfidence = 1.0,
        displayHints = DisplayHints()
    )

    @Test fun `bounded chunks assemble the original manuscript and anchors`() {
        val assembler = SnapshotSyncAssembler()
        assembler.begin(header())
        assembler.append(ManuscriptContentChunk("sync-1", 0, 2, "hello "))
        assembler.append(ManuscriptContentChunk("sync-1", 1, 2, "world"))
        assembler.append(ManuscriptParagraphChunk("sync-1", 0, 1, listOf(ParagraphAnchor(0, CharacterRange(0, 11), 0, 1))))
        assembler.append(ManuscriptTokenChunk("sync-1", 0, 1, 0, intArrayOf(0, 0), intArrayOf(0, 0), intArrayOf(0, 6), intArrayOf(5, 11)))
        val snapshot = assembler.complete(SessionSnapshotComplete("sync-1"))

        assertEquals("hello world", snapshot.manuscript.normalizedContent)
        assertEquals(2, snapshot.manuscript.tokens.size)
        assertEquals(6, snapshot.manuscript.tokens[1].characterRange.start)
    }

    @Test fun `oversized or incomplete sync is rejected before allocation or publication`() {
        val assembler = SnapshotSyncAssembler()
        assertThrows(IllegalArgumentException::class.java) { assembler.begin(header(SnapshotSyncAssembler.MAX_MANUSCRIPT_CHARACTERS + 1)) }
        assembler.begin(header())
        assertThrows(IllegalArgumentException::class.java) { assembler.complete(SessionSnapshotComplete("sync-1")) }
    }
}
