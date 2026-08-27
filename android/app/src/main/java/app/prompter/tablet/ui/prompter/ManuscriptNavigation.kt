package app.prompter.tablet.ui.prompter

import kotlin.math.roundToInt

enum class ManuscriptStructureLevel { PART, CHAPTER, SUBSECTION }

enum class ManuscriptStructureKind {
    PART, BOOK, VOLUME, ACT, CHAPTER, SECTION, NAMED_MATTER, SUBSECTION, UNLABELED_ORDINAL
}

data class ManuscriptStructureMarker(
    val characterStart: Int,
    val paragraphIndex: Int,
    val level: ManuscriptStructureLevel,
    val kind: ManuscriptStructureKind,
    val heading: String,
    val title: String?,
    val ordinal: Int?,
    val hierarchyOrdinal: List<Int>?,
    val confidence: Int,
    val sequenceSupported: Boolean,
    val resetsAncestors: Boolean = false
) {
    val displayText: String get() = title?.let { "$heading · $it" } ?: heading
}

typealias ManuscriptSection = ManuscriptStructureMarker

data class ManuscriptHierarchy(
    val part: ManuscriptStructureMarker? = null,
    val chapter: ManuscriptStructureMarker? = null,
    val subsection: ManuscriptStructureMarker? = null
) {
    val isEmpty: Boolean get() = part == null && chapter == null && subsection == null

    companion object {
        val EMPTY = ManuscriptHierarchy()
    }
}

data class ManuscriptNavigationPreview(
    val fraction: Float,
    val percent: Int,
    val wordPosition: Int,
    val totalWords: Int,
    val hierarchy: ManuscriptHierarchy,
    val snippet: String
)

private data class HierarchyPoint(val characterStart: Int, val hierarchy: ManuscriptHierarchy)

class ManuscriptNavigationIndex private constructor(
    private val paragraphs: List<VisualParagraph>,
    val manuscriptLength: Int,
    val markers: List<ManuscriptStructureMarker>,
    private val hierarchyPoints: List<HierarchyPoint>,
    private val wordStarts: IntArray
) {
    val sections: List<ManuscriptStructureMarker> get() = markers
    val totalWords: Int get() = wordStarts.size

    fun previewAtFraction(fraction: Float): ManuscriptNavigationPreview {
        val boundedFraction = fraction.coerceIn(0f, 1f)
        val character = (boundedFraction * manuscriptLength).roundToInt()
        return ManuscriptNavigationPreview(
            fraction = boundedFraction,
            percent = (boundedFraction * 100).roundToInt(),
            wordPosition = wordPositionAt(character),
            totalWords = totalWords,
            hierarchy = activeHierarchyAt(character),
            snippet = snippetAt(character)
        )
    }

    fun activeHierarchyAt(character: Int): ManuscriptHierarchy {
        val index = hierarchyPoints.lastIndexAtOrBefore(character) { it.characterStart }
        return hierarchyPoints.getOrNull(index)?.hierarchy ?: ManuscriptHierarchy.EMPTY
    }

    fun activeSectionAt(character: Int): ManuscriptStructureMarker? {
        val hierarchy = activeHierarchyAt(character)
        return hierarchy.subsection ?: hierarchy.chapter ?: hierarchy.part
    }

    fun wordPositionAt(character: Int): Int {
        var low = 0
        var high = wordStarts.size
        while (low < high) {
            val middle = (low + high) ushr 1
            if (wordStarts[middle] <= character) low = middle + 1 else high = middle
        }
        return low
    }

    fun snippetAt(character: Int, radius: Int = 72): String {
        if (paragraphs.isEmpty()) return ""
        val paragraphIndex = paragraphs.lastIndexAtOrBefore(character) { it.characterStart }.coerceAtLeast(0)
        val paragraph = paragraphs[paragraphIndex]
        val text = paragraph.text
        if (text.isBlank()) return ""
        val localCharacter = (character - paragraph.characterStart).coerceIn(0, text.length)
        var start = (localCharacter - radius).coerceAtLeast(0)
        var end = (localCharacter + radius).coerceAtMost(text.length)
        if (start > 0) {
            while (start < localCharacter && !text[start].isWhitespace()) start += 1
            while (start < end && text[start].isWhitespace()) start += 1
        }
        if (end < text.length) {
            while (end > localCharacter && !text[end - 1].isWhitespace()) end -= 1
            while (end > start && text[end - 1].isWhitespace()) end -= 1
        }
        if (start >= end) {
            start = (localCharacter - radius).coerceAtLeast(0)
            end = (localCharacter + radius).coerceAtMost(text.length)
        }
        val body = collapseWhitespace(text.substring(start, end)).trim()
        return buildString(body.length + 4) {
            append('“')
            if (start > 0) append('…')
            append(body)
            if (end < text.length) append('…')
            append('”')
        }
    }

    companion object {
        fun build(paragraphs: List<VisualParagraph>, manuscriptLength: Int): ManuscriptNavigationIndex {
            val ordered = paragraphs.sortedBy { it.characterStart }
            val candidates = collectStructureCandidates(ordered)
            val markers = analyzeStructureCandidates(candidates)
            return ManuscriptNavigationIndex(
                ordered,
                manuscriptLength.coerceAtLeast(0),
                markers,
                buildHierarchyPoints(markers),
                buildWordStarts(ordered)
            )
        }
    }
}

private enum class OrdinalStyle { ARABIC, ROMAN, WORD }
private data class ParsedOrdinal(val value: Int, val style: OrdinalStyle)

private data class StructureCandidate(
    val paragraphIndex: Int,
    val characterStart: Int,
    val level: ManuscriptStructureLevel,
    val kind: ManuscriptStructureKind,
    val heading: String,
    val title: String?,
    val ordinal: Int?,
    val ordinalStyle: OrdinalStyle?,
    val hierarchyOrdinal: List<Int>?,
    val baseConfidence: Int,
    val acceptWithoutSequence: Boolean,
    val resetsAncestors: Boolean = false
)

private val explicitHeadingPattern = Regex("^(chapter|part|book|section|act|volume)\\s+(.+)$", RegexOption.IGNORE_CASE)
private val hierarchyHeadingPattern = Regex("^(\\d{1,3}(?:\\.\\d{1,3}){1,3})(?:\\s+(.+))?$")
private val arabicOrdinalPattern = Regex("^\\d{1,4}$")
private val validRomanPattern = Regex("^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$", RegexOption.IGNORE_CASE)
private val standaloneHeadings = setOf(
    "introduction", "preface", "foreword", "prologue", "epilogue", "afterword",
    "acknowledgments", "acknowledgements", "conclusion", "appendix", "appendices",
    "bibliography", "notes", "glossary", "interlude", "prelude"
)
private val titleConnectorWords = setOf("a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with")

private val cardinalWordValues = mapOf(
    "zero" to 0, "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5,
    "six" to 6, "seven" to 7, "eight" to 8, "nine" to 9, "ten" to 10,
    "eleven" to 11, "twelve" to 12, "thirteen" to 13, "fourteen" to 14,
    "fifteen" to 15, "sixteen" to 16, "seventeen" to 17, "eighteen" to 18,
    "nineteen" to 19, "twenty" to 20, "thirty" to 30, "forty" to 40,
    "fifty" to 50, "sixty" to 60, "seventy" to 70, "eighty" to 80, "ninety" to 90
)
private val ordinalWordValues = mapOf(
    "first" to 1, "second" to 2, "third" to 3, "fourth" to 4, "fifth" to 5,
    "sixth" to 6, "seventh" to 7, "eighth" to 8, "ninth" to 9, "tenth" to 10,
    "eleventh" to 11, "twelfth" to 12, "thirteenth" to 13, "fourteenth" to 14,
    "fifteenth" to 15, "sixteenth" to 16, "seventeenth" to 17, "eighteenth" to 18,
    "nineteenth" to 19, "twentieth" to 20, "thirtieth" to 30, "fortieth" to 40,
    "fiftieth" to 50, "sixtieth" to 60, "seventieth" to 70, "eightieth" to 80,
    "ninetieth" to 90
)

fun parseBookOrdinal(value: String): Int? = parseOrdinalWithStyle(value)?.value

private fun parseOrdinalWithStyle(value: String): ParsedOrdinal? {
    val candidate = value.trim().removeSuffix(".").trim()
    if (candidate.isEmpty()) return null
    if (arabicOrdinalPattern.matches(candidate)) {
        return candidate.toIntOrNull()?.takeIf { it > 0 }?.let { ParsedOrdinal(it, OrdinalStyle.ARABIC) }
    }
    if (validRomanPattern.matches(candidate)) {
        return parseRomanOrdinal(candidate)?.let { ParsedOrdinal(it, OrdinalStyle.ROMAN) }
    }
    return parseEnglishOrdinal(candidate)?.let { ParsedOrdinal(it, OrdinalStyle.WORD) }
}

private fun parseRomanOrdinal(value: String): Int? {
    if (value.isEmpty() || !validRomanPattern.matches(value)) return null
    val values = mapOf('I' to 1, 'V' to 5, 'X' to 10, 'L' to 50, 'C' to 100, 'D' to 500, 'M' to 1000)
    val upper = value.uppercase()
    var total = 0
    upper.forEachIndexed { index, character ->
        val current = values[character] ?: return null
        val next = upper.getOrNull(index + 1)?.let(values::get) ?: 0
        total += if (current < next) -current else current
    }
    return total.takeIf { it > 0 }
}

private fun parseEnglishOrdinal(value: String): Int? {
    val tokens = value.lowercase().split(Regex("[\\s-]+")).filter { it.isNotBlank() && it != "and" }
    if (tokens.isEmpty()) return null
    var total = 0
    var current = 0
    var previousValue: Int? = null
    var usedThousand = false
    tokens.forEachIndexed { index, token ->
        if (token == "hundred") {
            if (current !in 1..9) return null
            current *= 100
            previousValue = 100
            return@forEachIndexed
        }
        if (token == "thousand") {
            if (usedThousand || current !in 1..999) return null
            total += current * 1000
            current = 0
            previousValue = null
            usedThousand = true
            return@forEachIndexed
        }
        val ordinalValue = ordinalWordValues[token]
        if (ordinalValue != null && index != tokens.lastIndex) return null
        val number = ordinalValue ?: cardinalWordValues[token] ?: return null
        val prior = previousValue
        when {
            number in 20..90 && number % 10 == 0 -> if (prior != null && prior != 100) return null
            number in 1..9 -> {
                if (prior != null && prior < 20) return null
                if (prior != null && prior in 20..90 && prior % 10 != 0) return null
            }
            number in 10..19 -> if (prior != null && prior != 100) return null
        }
        current += number
        previousValue = number
    }
    return (total + current).takeIf { it in 1..9999 }
}

private fun collectStructureCandidates(paragraphs: List<VisualParagraph>): List<StructureCandidate> = buildList {
    paragraphs.forEachIndexed { index, paragraph ->
        val text = paragraph.text.trim()
        if (!isStandaloneCandidate(text)) return@forEachIndexed
        val followingTitle = paragraphs.getOrNull(index + 1)?.text?.let(::detectedSectionTitle)
        parseExplicitCandidate(paragraph, text, followingTitle)?.let { add(it); return@forEachIndexed }
        parseNamedCandidate(paragraph, text, followingTitle)?.let { add(it); return@forEachIndexed }
        parseHierarchyCandidate(paragraph, text, followingTitle)?.let { add(it); return@forEachIndexed }
        parseUnlabeledCandidate(paragraph, text, followingTitle)?.let { add(it) }
    }
}

private fun isStandaloneCandidate(text: String): Boolean =
    text.isNotEmpty() && text.length <= 200 && text.none { it == '\n' || it == '\r' }

private fun parseExplicitCandidate(paragraph: VisualParagraph, text: String, followingTitle: String?): StructureCandidate? {
    val match = explicitHeadingPattern.matchEntire(text) ?: return null
    val label = match.groupValues[1]
    val parsed = splitOrdinalAndInlineTitle(match.groupValues[2].trim()) ?: return null
    val kind = when (label.lowercase()) {
        "part" -> ManuscriptStructureKind.PART
        "book" -> ManuscriptStructureKind.BOOK
        "volume" -> ManuscriptStructureKind.VOLUME
        "act" -> ManuscriptStructureKind.ACT
        "chapter" -> ManuscriptStructureKind.CHAPTER
        else -> ManuscriptStructureKind.SECTION
    }
    val level = when (kind) {
        ManuscriptStructureKind.PART, ManuscriptStructureKind.BOOK,
        ManuscriptStructureKind.VOLUME, ManuscriptStructureKind.ACT -> ManuscriptStructureLevel.PART
        else -> ManuscriptStructureLevel.CHAPTER
    }
    return StructureCandidate(
        paragraph.paragraphIndex, paragraph.characterStart, level, kind,
        "$label ${parsed.ordinalText}".trim(), parsed.title ?: followingTitle,
        parsed.ordinal.value, parsed.ordinal.style, null, 88, true
    )
}

private data class SplitOrdinalTitle(val ordinalText: String, val ordinal: ParsedOrdinal, val title: String?)

private fun splitOrdinalAndInlineTitle(value: String): SplitOrdinalTitle? {
    val separators = buildList {
        value.indexOf(':').takeIf { it >= 0 }?.let { add(it to 1) }
        value.indexOf('—').takeIf { it >= 0 }?.let { add(it to 1) }
        value.indexOf('–').takeIf { it >= 0 }?.let { add(it to 1) }
        value.indexOf(" - ").takeIf { it >= 0 }?.let { add(it to 3) }
    }
    val separator = separators.minByOrNull { it.first }
    val ordinalText = separator?.let { value.substring(0, it.first).trim() } ?: value.trim()
    val ordinal = parseOrdinalWithStyle(ordinalText) ?: return null
    val title = separator?.let { value.substring(it.first + it.second).trim().takeIf(String::isNotEmpty) }
    return SplitOrdinalTitle(ordinalText, ordinal, title)
}

private fun parseNamedCandidate(paragraph: VisualParagraph, text: String, followingTitle: String?): StructureCandidate? {
    if (text.lowercase() !in standaloneHeadings) return null
    return StructureCandidate(
        paragraph.paragraphIndex, paragraph.characterStart, ManuscriptStructureLevel.CHAPTER,
        ManuscriptStructureKind.NAMED_MATTER, text, followingTitle, null, null, null,
        92, true, resetsAncestors = true
    )
}

private fun parseHierarchyCandidate(paragraph: VisualParagraph, text: String, followingTitle: String?): StructureCandidate? {
    val match = hierarchyHeadingPattern.matchEntire(text) ?: return null
    val components = match.groupValues[1].split('.').mapNotNull(String::toIntOrNull)
    if (components.size < 2 || components.any { it <= 0 }) return null
    val inlineTitle = match.groupValues.getOrNull(2)?.trim()?.takeIf(String::isNotEmpty)
    val strongTitle = inlineTitle?.let { isStrongTitle(it, 180, 24) } == true
    return StructureCandidate(
        paragraph.paragraphIndex, paragraph.characterStart, ManuscriptStructureLevel.SUBSECTION,
        ManuscriptStructureKind.SUBSECTION, match.groupValues[1], inlineTitle ?: followingTitle,
        null, null, components, if (strongTitle) 72 else 42, strongTitle
    )
}

private fun parseUnlabeledCandidate(paragraph: VisualParagraph, text: String, followingTitle: String?): StructureCandidate? {
    if (text.length > 32 || text.lastOrNull() in listOf(':', ';', '?', '!')) return null
    val ordinal = parseOrdinalWithStyle(text) ?: return null
    return StructureCandidate(
        paragraph.paragraphIndex, paragraph.characterStart, ManuscriptStructureLevel.CHAPTER,
        ManuscriptStructureKind.UNLABELED_ORDINAL, text, followingTitle,
        ordinal.value, ordinal.style, null, 18, false
    )
}

private fun analyzeStructureCandidates(candidates: List<StructureCandidate>): List<ManuscriptStructureMarker> {
    val sequenceSupported = mutableSetOf<Int>()
    markOrdinalRuns(
        candidates.filter { it.kind !in setOf(ManuscriptStructureKind.UNLABELED_ORDINAL, ManuscriptStructureKind.NAMED_MATTER, ManuscriptStructureKind.SUBSECTION) },
        2, false, sequenceSupported
    )
    markOrdinalRuns(
        candidates.filter { it.kind == ManuscriptStructureKind.UNLABELED_ORDINAL },
        3, true, sequenceSupported
    )
    markHierarchyRuns(candidates.filter { it.kind == ManuscriptStructureKind.SUBSECTION }, sequenceSupported)
    return candidates.mapNotNull { candidate ->
        val supported = candidate.paragraphIndex in sequenceSupported
        val boost = when (candidate.kind) {
            ManuscriptStructureKind.UNLABELED_ORDINAL -> if (supported) 62 else 0
            ManuscriptStructureKind.SUBSECTION -> if (supported) 48 else 0
            else -> if (supported) 12 else 0
        }
        val confidence = (candidate.baseConfidence + boost).coerceAtMost(100)
        if (!candidate.acceptWithoutSequence && confidence < 70) return@mapNotNull null
        ManuscriptStructureMarker(
            candidate.characterStart, candidate.paragraphIndex, candidate.level, candidate.kind,
            candidate.heading, candidate.title, candidate.ordinal, candidate.hierarchyOrdinal,
            confidence, supported, candidate.resetsAncestors
        )
    }.sortedBy { it.characterStart }
}

private fun markOrdinalRuns(
    candidates: List<StructureCandidate>,
    minimumRun: Int,
    requireParagraphGap: Boolean,
    sequenceSupported: MutableSet<Int>
) {
    candidates.groupBy { Triple(it.kind, it.ordinalStyle, it.level) }.values.forEach { family ->
        val ordered = family.sortedBy { it.characterStart }
        var run = mutableListOf<StructureCandidate>()
        fun flush() {
            if (run.size >= minimumRun) sequenceSupported += run.map { it.paragraphIndex }
            run = mutableListOf()
        }
        ordered.forEach { candidate ->
            val previous = run.lastOrNull()
            val characterGap = previous?.let { candidate.characterStart - it.characterStart } ?: 0
            val hasUnlabeledChapterEvidence = previous != null &&
                candidate.paragraphIndex - previous.paragraphIndex >= 2 &&
                characterGap >= 80 &&
                (previous.title != null || candidate.title != null || characterGap >= 400)
            val linked = previous != null && candidate.ordinal == previous.ordinal?.plus(1) &&
                (!requireParagraphGap || hasUnlabeledChapterEvidence)
            if (!linked) {
                flush()
                run += candidate
            } else run += candidate
        }
        flush()
    }
}

private fun markHierarchyRuns(candidates: List<StructureCandidate>, sequenceSupported: MutableSet<Int>) {
    candidates.groupBy { it.hierarchyOrdinal?.size ?: 0 }.values.forEach { family ->
        val ordered = family.sortedBy { it.characterStart }
        var run = mutableListOf<StructureCandidate>()
        fun flush() {
            if (run.size >= 2) sequenceSupported += run.map { it.paragraphIndex }
            run = mutableListOf()
        }
        ordered.forEach { candidate ->
            val previous = run.lastOrNull()
            if (previous == null || !hierarchyFollows(previous.hierarchyOrdinal.orEmpty(), candidate.hierarchyOrdinal.orEmpty())) {
                flush()
                run += candidate
            } else run += candidate
        }
        flush()
    }
}

private fun hierarchyFollows(previous: List<Int>, current: List<Int>): Boolean {
    if (previous.size != current.size || previous.isEmpty()) return false
    val changedIndex = previous.indices.firstOrNull { previous[it] != current[it] } ?: return false
    if ((0 until changedIndex).any { previous[it] != current[it] }) return false
    if (current[changedIndex] != previous[changedIndex] + 1) return false
    return (changedIndex + 1 until current.size).all { current[it] == 1 }
}

private fun buildHierarchyPoints(markers: List<ManuscriptStructureMarker>): List<HierarchyPoint> {
    var hierarchy = ManuscriptHierarchy.EMPTY
    return markers.map { marker ->
        hierarchy = when (marker.level) {
            ManuscriptStructureLevel.PART -> ManuscriptHierarchy(part = marker)
            ManuscriptStructureLevel.CHAPTER -> ManuscriptHierarchy(
                part = if (marker.resetsAncestors) null else hierarchy.part,
                chapter = marker
            )
            ManuscriptStructureLevel.SUBSECTION -> hierarchy.copy(subsection = marker)
        }
        HierarchyPoint(marker.characterStart, hierarchy)
    }
}

private fun buildWordStarts(paragraphs: List<VisualParagraph>): IntArray = buildList {
    paragraphs.forEach { paragraph ->
        var inWord = false
        paragraph.text.forEachIndexed { localIndex, character ->
            if (character.isWhitespace()) inWord = false
            else if (!inWord) {
                add(paragraph.characterStart + localIndex)
                inWord = true
            }
        }
    }
}.toIntArray()

fun detectedSectionHeading(text: String): String? {
    val paragraph = VisualParagraph("candidate", 0, 0, text)
    return parseExplicitCandidate(paragraph, text.trim(), null)?.heading
        ?: parseNamedCandidate(paragraph, text.trim(), null)?.heading
}

fun detectedSectionTitle(text: String): String? {
    val candidate = text.trim()
    if (!isStrongTitle(candidate, 80, 12)) return null
    if (detectedSectionHeading(candidate) != null || hierarchyHeadingPattern.matches(candidate)) return null
    return candidate
}

private fun isStrongTitle(candidate: String, maximumLength: Int, maximumWords: Int): Boolean {
    if (candidate.isEmpty() || candidate.length > maximumLength || candidate.any { it == '\n' || it == '\r' }) return false
    if (candidate.last() in ".?!;") return false
    val words = candidate.split(Regex("\\s+")).filter(String::isNotBlank)
    if (words.isEmpty() || words.size > maximumWords) return false
    val letters = candidate.filter(Char::isLetter)
    if (letters.isEmpty()) return false
    val allUppercase = letters.all(Char::isUpperCase)
    val titleCase = words.withIndex().all { (index, word) ->
        val firstLetter = word.firstOrNull(Char::isLetter)
        firstLetter == null || firstLetter.isUpperCase() ||
            (index > 0 && word.lowercase().trim('-', '—', '–', ':') in titleConnectorWords)
    }
    return allUppercase || titleCase
}

private inline fun <T> List<T>.lastIndexAtOrBefore(character: Int, position: (T) -> Int): Int {
    var low = 0
    var high = size
    while (low < high) {
        val middle = (low + high) ushr 1
        if (position(this[middle]) <= character) low = middle + 1 else high = middle
    }
    return low - 1
}

private fun collapseWhitespace(value: String): String = buildString(value.length) {
    var pendingSpace = false
    value.forEach { character ->
        if (character.isWhitespace()) pendingSpace = isNotEmpty()
        else {
            if (pendingSpace) append(' ')
            append(character)
            pendingSpace = false
        }
    }
}
