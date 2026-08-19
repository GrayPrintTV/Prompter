package app.prompter.tablet.session

import app.prompter.tablet.protocol.*

/** Incrementally assembles a manuscript without ever holding one giant JSON frame. */
class SnapshotSyncAssembler {
    private data class Pending(
        val header: SessionSnapshotStart,
        val content: StringBuilder,
        val paragraphs: ArrayList<ParagraphAnchor>,
        val tokens: ArrayList<TokenAnchor>,
        var nextContentChunk: Int = 0,
        var nextParagraphChunk: Int = 0,
        var nextTokenChunk: Int = 0
    )

    private var pending: Pending? = null

    fun begin(header: SessionSnapshotStart) {
        require(header.manuscript.contentLength in 0..MAX_MANUSCRIPT_CHARACTERS) { "Manuscript exceeds the supported tablet size." }
        require(header.manuscript.paragraphCount in 0..MAX_PARAGRAPHS && header.manuscript.tokenCount in 0..MAX_TOKENS) { "Manuscript anchor count exceeds the supported tablet size." }
        pending = Pending(
            header,
            StringBuilder(header.manuscript.contentLength),
            ArrayList(header.manuscript.paragraphCount),
            ArrayList(header.manuscript.tokenCount)
        )
    }

    fun append(chunk: ManuscriptContentChunk) {
        val state = requirePending(chunk.syncId)
        require(chunk.chunkCount == state.header.chunkCounts.content && chunk.chunkIndex == state.nextContentChunk) { "Content chunk is missing or out of order." }
        require(state.content.length + chunk.text.length <= state.header.manuscript.contentLength) { "Content chunk exceeds declared manuscript length." }
        state.content.append(chunk.text)
        state.nextContentChunk++
    }

    fun append(chunk: ManuscriptParagraphChunk) {
        val state = requirePending(chunk.syncId)
        require(chunk.chunkCount == state.header.chunkCounts.paragraphs && chunk.chunkIndex == state.nextParagraphChunk) { "Paragraph chunk is missing or out of order." }
        require(state.paragraphs.size + chunk.paragraphs.size <= state.header.manuscript.paragraphCount) { "Paragraph chunk exceeds declared count." }
        state.paragraphs.addAll(chunk.paragraphs)
        state.nextParagraphChunk++
    }

    fun append(chunk: ManuscriptTokenChunk) {
        val state = requirePending(chunk.syncId)
        require(chunk.chunkCount == state.header.chunkCounts.tokens && chunk.chunkIndex == state.nextTokenChunk) { "Token chunk is missing or out of order." }
        val size = chunk.sentenceIndexes.size
        require(chunk.paragraphIndexes.size == size && chunk.characterStarts.size == size && chunk.characterEnds.size == size) { "Token chunk columns have different lengths." }
        require(state.tokens.size + size <= state.header.manuscript.tokenCount) { "Token chunk exceeds declared count." }
        repeat(size) { offset ->
            state.tokens += TokenAnchor(
                tokenIndex = chunk.firstTokenIndex + offset,
                sentenceIndex = chunk.sentenceIndexes[offset],
                paragraphIndex = chunk.paragraphIndexes[offset],
                characterRange = CharacterRange(chunk.characterStarts[offset], chunk.characterEnds[offset])
            )
        }
        state.nextTokenChunk++
    }

    fun complete(message: SessionSnapshotComplete): SessionSnapshot {
        val state = requirePending(message.syncId)
        val header = state.header
        require(state.nextContentChunk == header.chunkCounts.content && state.content.length == header.manuscript.contentLength) { "Manuscript content sync is incomplete." }
        require(state.nextParagraphChunk == header.chunkCounts.paragraphs && state.paragraphs.size == header.manuscript.paragraphCount) { "Manuscript paragraph sync is incomplete." }
        require(state.nextTokenChunk == header.chunkCounts.tokens && state.tokens.size == header.manuscript.tokenCount) { "Manuscript token sync is incomplete." }
        pending = null
        return SessionSnapshot(
            sessionRevision = header.sessionRevision,
            manuscriptRevision = header.manuscriptRevision,
            manuscript = ManuscriptPayload(
                manuscriptId = header.manuscript.manuscriptId,
                contentHash = header.manuscript.contentHash,
                normalizedContent = state.content.toString(),
                paragraphs = state.paragraphs,
                sentences = emptyList(),
                tokens = state.tokens
            ),
            acceptedPosition = header.acceptedPosition,
            followState = header.followState,
            currentConfidence = header.currentConfidence,
            latestTranscript = header.latestTranscript,
            controllerLease = header.controllerLease,
            displayHints = header.displayHints,
            runtimeSettings = header.runtimeSettings,
            narrationSessionId = header.narrationSessionId,
            movementDecision = header.movementDecision
        )
    }

    fun clear() { pending = null }

    private fun requirePending(syncId: String): Pending = pending?.takeIf { it.header.syncId == syncId }
        ?: throw IllegalArgumentException("Snapshot chunk does not match an active sync.")

    companion object {
        const val MAX_MANUSCRIPT_CHARACTERS = 8_000_000
        const val MAX_PARAGRAPHS = 100_000
        const val MAX_TOKENS = 1_000_000
    }
}
