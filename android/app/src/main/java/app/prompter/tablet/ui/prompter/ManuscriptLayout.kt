package app.prompter.tablet.ui.prompter

import app.prompter.tablet.protocol.SessionSnapshot

data class ManuscriptChunk(val key: String, val paragraphIndex: Int, val characterStart: Int, val text: String) {
    val characterEnd: Int get() = characterStart + text.length
}

/** A visual paragraph is intentionally separate from bounded movement chunks. */
data class VisualParagraph(val key: String, val paragraphIndex: Int, val characterStart: Int, val text: String)

fun visualParagraphs(snapshot: SessionSnapshot, chunks: List<ManuscriptChunk>): List<VisualParagraph> =
    chunks.groupBy { it.paragraphIndex }.map { (paragraphIndex, paragraphChunks) ->
        val first = paragraphChunks.first()
        VisualParagraph("${snapshot.manuscript.contentHash}:paragraph:$paragraphIndex", paragraphIndex, first.characterStart, paragraphChunks.joinToString("") { it.text })
    }

fun estimatedTargetLineCenter(localCharacterOffset: Int, textLength: Int, itemHeightPx: Int): Float =
    itemHeightPx * (localCharacterOffset.coerceIn(0, textLength.coerceAtLeast(1)).toFloat() / textLength.coerceAtLeast(1))

fun manuscriptChunks(snapshot: SessionSnapshot, maxCharacters: Int = 96): List<ManuscriptChunk> {
    val content = snapshot.manuscript.normalizedContent ?: return emptyList()
    return snapshot.manuscript.paragraphs.flatMap { paragraph ->
        val start = paragraph.characterRange.start.coerceIn(0, content.length)
        val end = paragraph.characterRange.end.coerceIn(start, content.length)
        val text = content.substring(start, end)
        if (text.isEmpty()) listOf(ManuscriptChunk("${snapshot.manuscript.contentHash}:${paragraph.paragraphIndex}:0", paragraph.paragraphIndex, start, " "))
        else boundedChunks(text, maxCharacters).mapIndexed { index, chunk ->
            ManuscriptChunk("${snapshot.manuscript.contentHash}:${paragraph.paragraphIndex}:$index", paragraph.paragraphIndex, start + chunk.first, chunk.second)
        }
    }
}

private fun boundedChunks(text: String, maxCharacters: Int): List<Pair<Int, String>> {
    require(maxCharacters > 0) { "maxCharacters must be positive." }
    val chunks = mutableListOf<Pair<Int, String>>()
    var start = 0
    while (start < text.length) {
        val targetEnd = (start + maxCharacters).coerceAtMost(text.length)
        val end = if (targetEnd == text.length) text.length else preferredBoundary(text, start, targetEnd, maxCharacters)
        chunks += start to text.substring(start, end)
        start = end
    }
    return chunks
}

private fun preferredBoundary(text: String, start: Int, targetEnd: Int, maxCharacters: Int): Int {
    val whitespace = charArrayOf(' ', '\n', '\t')
    val minimumUsefulEnd = start + (maxCharacters / 2).coerceAtLeast(1)
    val backward = text.lastIndexOfAny(whitespace, targetEnd - 1)
        .takeIf { it >= minimumUsefulEnd }
        ?.plus(1)
    val forwardLimit = (targetEnd + (maxCharacters / 4).coerceAtLeast(1)).coerceAtMost(text.length)
    val forward = text.indexOfAny(whitespace, targetEnd)
        .takeIf { it in targetEnd until forwardLimit }
        ?.plus(1)
    return listOfNotNull(backward, forward)
        .minByOrNull { kotlin.math.abs(it - targetEnd) }
        ?: targetEnd
}
