package app.prompter.tablet.ui.prompter

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlin.math.roundToInt

data class FastScrollTarget(val itemIndex: Int, val localCharacterOffset: Int)

fun fastScrollPreviewWidthPx(
    containerWidthPx: Int,
    scrollbarWidthPx: Int,
    gapPx: Int,
    preferredWidthPx: Int,
    leadingInsetPx: Int
): Int = minOf(
    preferredWidthPx,
    (containerWidthPx - scrollbarWidthPx - gapPx - leadingInsetPx).coerceAtLeast(0)
)

enum class ScrubPrecision(val gain: Float) {
    COARSE(1f),
    MEDIUM(.10f),
    FINE(.02f)
}

data class PrecisionScrubUpdate(val fraction: Float, val precision: ScrubPrecision)

fun scrubPrecisionForDistance(
    distanceFromScrollbarPx: Float,
    mediumThresholdPx: Float,
    fineThresholdPx: Float
): ScrubPrecision = when {
    distanceFromScrollbarPx >= fineThresholdPx -> ScrubPrecision.FINE
    distanceFromScrollbarPx >= mediumThresholdPx -> ScrubPrecision.MEDIUM
    else -> ScrubPrecision.COARSE
}

/** Stateful, pure drag mapping that rebases whenever horizontal precision changes. */
class PrecisionScrubController(
    initialFraction: Float,
    initialPointerY: Float,
    private val trackTravelPx: Float,
    private val mediumThresholdPx: Float,
    private val fineThresholdPx: Float
) {
    private var anchorFraction = initialFraction.coerceIn(0f, 1f)
    private var anchorPointerY = initialPointerY
    private var precision = ScrubPrecision.COARSE

    fun update(pointerY: Float, distanceFromScrollbarPx: Float): PrecisionScrubUpdate {
        val nextPrecision = scrubPrecisionForDistance(distanceFromScrollbarPx, mediumThresholdPx, fineThresholdPx)
        val fractionAtPointer = mappedFraction(pointerY, precision).coerceIn(0f, 1f)
        if (nextPrecision != precision) {
            anchorFraction = fractionAtPointer
            anchorPointerY = pointerY
            precision = nextPrecision
            return PrecisionScrubUpdate(anchorFraction, precision)
        }
        val rawFraction = mappedFraction(pointerY, precision)
        val boundedFraction = rawFraction.coerceIn(0f, 1f)
        if (rawFraction != boundedFraction) {
            anchorFraction = boundedFraction
            anchorPointerY = pointerY
        }
        return PrecisionScrubUpdate(boundedFraction, precision)
    }

    private fun mappedFraction(pointerY: Float, precision: ScrubPrecision): Float =
        anchorFraction + ((pointerY - anchorPointerY) / trackTravelPx.coerceAtLeast(1f)) * precision.gain
}

/** Maps the thumb through manuscript characters so uneven paragraph lengths remain proportional. */
fun fastScrollTargetForFraction(
    fraction: Float,
    paragraphs: List<VisualParagraph>,
    manuscriptLength: Int
): FastScrollTarget? {
    if (paragraphs.isEmpty() || manuscriptLength <= 0) return null
    val targetCharacter = (fraction.coerceIn(0f, 1f) * manuscriptLength).roundToInt()
    val itemIndex = paragraphs.indexOfLast { it.characterStart <= targetCharacter }.coerceAtLeast(0)
    val paragraph = paragraphs[itemIndex]
    return FastScrollTarget(
        itemIndex = itemIndex,
        localCharacterOffset = (targetCharacter - paragraph.characterStart).coerceIn(0, paragraph.text.length)
    )
}

/** Estimates the current manuscript fraction from the first visible paragraph and its pixel offset. */
fun currentFastScrollFraction(
    firstVisibleItemIndex: Int,
    firstVisibleItemScrollOffset: Int,
    firstVisibleItemSize: Int,
    paragraphs: List<VisualParagraph>,
    manuscriptLength: Int,
    canScrollBackward: Boolean,
    canScrollForward: Boolean
): Float {
    if (paragraphs.isEmpty() || manuscriptLength <= 0 || !canScrollBackward) return 0f
    if (!canScrollForward) return 1f
    val paragraph = paragraphs.getOrNull(firstVisibleItemIndex) ?: return 0f
    val localFraction = firstVisibleItemScrollOffset.toFloat() / firstVisibleItemSize.coerceAtLeast(1)
    val visibleCharacter = paragraph.characterStart + paragraph.text.length * localFraction.coerceIn(0f, 1f)
    return (visibleCharacter / manuscriptLength).coerceIn(0f, 1f)
}

@Composable
fun ManuscriptFastScrollThumb(
    listState: LazyListState,
    paragraphs: List<VisualParagraph>,
    manuscriptLength: Int,
    navigationIndex: ManuscriptNavigationIndex,
    dragging: Boolean,
    color: Color,
    onDragStart: () -> Unit,
    onFractionChanged: (Float) -> Unit,
    onDragEnd: () -> Unit,
    modifier: Modifier = Modifier
) {
    val scrollable by remember {
        derivedStateOf { listState.canScrollBackward || listState.canScrollForward }
    }
    if (!scrollable || paragraphs.isEmpty() || manuscriptLength <= 0) return

    var trackHeightPx by remember { mutableIntStateOf(0) }
    var containerWidthPx by remember { mutableIntStateOf(0) }
    var previewHeightPx by remember { mutableIntStateOf(0) }
    var gestureDragging by remember { mutableStateOf(false) }
    var dragFraction by remember { mutableFloatStateOf(0f) }
    val thumbHeight = 64.dp
    val scrollbarWidth = 32.dp
    val density = androidx.compose.ui.platform.LocalDensity.current
    val thumbHeightPx = with(density) { thumbHeight.roundToPx() }
    val scrollbarWidthPx = with(density) { scrollbarWidth.roundToPx() }
    val cardGapPx = with(density) { 8.dp.roundToPx() }
    val preferredCardWidthPx = with(density) { 280.dp.roundToPx() }
    val leadingInsetPx = with(density) { 12.dp.roundToPx() }
    val mediumThresholdPx = with(density) { 72.dp.toPx() }
    val fineThresholdPx = with(density) { 176.dp.toPx() }
    val scrollFraction by remember(paragraphs, manuscriptLength) {
        derivedStateOf {
            val firstVisible = listState.layoutInfo.visibleItemsInfo.firstOrNull {
                it.index == listState.firstVisibleItemIndex
            }
            currentFastScrollFraction(
                firstVisibleItemIndex = listState.firstVisibleItemIndex,
                firstVisibleItemScrollOffset = listState.firstVisibleItemScrollOffset,
                firstVisibleItemSize = firstVisible?.size ?: 1,
                paragraphs = paragraphs,
                manuscriptLength = manuscriptLength,
                canScrollBackward = listState.canScrollBackward,
                canScrollForward = listState.canScrollForward
            )
        }
    }
    val travelPx = (trackHeightPx - thumbHeightPx).coerceAtLeast(1)
    val displayedFraction = if (gestureDragging) dragFraction else scrollFraction
    val thumbOffsetPx = (displayedFraction * travelPx).roundToInt()
    val opacity by animateFloatAsState(
        targetValue = if (dragging || listState.isScrollInProgress) 0.9f else 0.38f,
        label = "manuscript-fast-scroll-opacity"
    )
    val currentFraction by rememberUpdatedState(scrollFraction)
    val currentTravelPx by rememberUpdatedState(travelPx)
    val currentOnDragStart by rememberUpdatedState(onDragStart)
    val currentOnFractionChanged by rememberUpdatedState(onFractionChanged)
    val currentOnDragEnd by rememberUpdatedState(onDragEnd)
    val previewWidthPx = fastScrollPreviewWidthPx(
        containerWidthPx = containerWidthPx,
        scrollbarWidthPx = scrollbarWidthPx,
        gapPx = cardGapPx,
        preferredWidthPx = preferredCardWidthPx,
        leadingInsetPx = leadingInsetPx
    )

    Box(modifier = modifier.fillMaxWidth().onSizeChanged {
        trackHeightPx = it.height
        containerWidthPx = it.width
    }) {
        if (gestureDragging && previewWidthPx > 0) {
            val preview = navigationIndex.previewAtFraction(dragFraction)
            val previewTopPx = (thumbOffsetPx + thumbHeightPx / 2 - previewHeightPx / 2)
                .coerceIn(0, (trackHeightPx - previewHeightPx).coerceAtLeast(0))
            FastScrollPreviewCard(
                preview = preview,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .offset { IntOffset(-(scrollbarWidthPx + cardGapPx), previewTopPx) }
                    .width(with(density) { previewWidthPx.toDp() })
                    .onSizeChanged { previewHeightPx = it.height }
            )
        }
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .offset { IntOffset(0, thumbOffsetPx) }
                .height(thumbHeight)
                .width(scrollbarWidth)
                .semantics { contentDescription = "Manuscript fast scroll" }
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        var started = false
                        try {
                            down.consume()
                            gestureDragging = true
                            currentOnDragStart()
                            started = true
                            val startFraction = currentFraction
                            dragFraction = startFraction
                            var pointerY = 0f
                            var lastFraction = startFraction
                            val controller = PrecisionScrubController(
                                initialFraction = startFraction,
                                initialPointerY = pointerY,
                                trackTravelPx = currentTravelPx.toFloat(),
                                mediumThresholdPx = mediumThresholdPx,
                                fineThresholdPx = fineThresholdPx
                            )
                            while (true) {
                                val event = awaitPointerEvent()
                                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                if (!change.pressed) break
                                pointerY += change.positionChange().y
                                val distanceFromScrollbarPx = (size.width - change.position.x).coerceAtLeast(0f)
                                val update = controller.update(pointerY, distanceFromScrollbarPx)
                                val nextFraction = update.fraction
                                dragFraction = nextFraction
                                if (abs(nextFraction - lastFraction) >= 0.000001f) {
                                    currentOnFractionChanged(nextFraction)
                                    lastFraction = nextFraction
                                }
                                change.consume()
                            }
                        } finally {
                            gestureDragging = false
                            if (started) currentOnDragEnd()
                        }
                    }
                },
            contentAlignment = Alignment.CenterEnd
        ) {
            Box(
                Modifier
                    .fillMaxHeight(0.78f)
                    .width(5.dp)
                    .alpha(opacity)
                    .background(color, RoundedCornerShape(50))
            )
        }
    }
}

@Composable
private fun FastScrollPreviewCard(preview: ManuscriptNavigationPreview, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = .96f),
        contentColor = MaterialTheme.colorScheme.onSurface,
        tonalElevation = 3.dp,
        shadowElevation = 5.dp
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
            val hierarchyRows = listOfNotNull(
                preview.hierarchy.part,
                preview.hierarchy.chapter,
                preview.hierarchy.subsection
            )
            hierarchyRows.forEachIndexed { index, marker ->
                Text(
                    marker.displayText,
                    style = if (index == 0) MaterialTheme.typography.titleSmall else MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            if (hierarchyRows.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
            }
            Text(
                "${preview.percent}% · ${formatNavigationCount(preview.wordPosition)} / ${formatNavigationCount(preview.totalWords)} words",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (preview.snippet.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text(
                    preview.snippet,
                    style = MaterialTheme.typography.bodySmall,
                    fontStyle = FontStyle.Italic,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

fun formatNavigationCount(value: Int): String {
    val digits = value.coerceAtLeast(0).toString()
    return buildString(digits.length + digits.length / 3) {
        digits.forEachIndexed { index, character ->
            if (index > 0 && (digits.length - index) % 3 == 0) append(',')
            append(character)
        }
    }
}
