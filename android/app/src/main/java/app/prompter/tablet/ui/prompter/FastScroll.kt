package app.prompter.tablet.ui.prompter

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlin.math.roundToInt

data class FastScrollTarget(val itemIndex: Int, val localCharacterOffset: Int)

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
    val thumbHeight = 64.dp
    val thumbHeightPx = with(androidx.compose.ui.platform.LocalDensity.current) { thumbHeight.roundToPx() }
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
    val thumbOffsetPx = (scrollFraction * travelPx).roundToInt()
    val opacity by animateFloatAsState(
        targetValue = if (dragging || listState.isScrollInProgress) 0.9f else 0.38f,
        label = "manuscript-fast-scroll-opacity"
    )
    val currentFraction by rememberUpdatedState(scrollFraction)
    val currentTravelPx by rememberUpdatedState(travelPx)
    val currentOnDragStart by rememberUpdatedState(onDragStart)
    val currentOnFractionChanged by rememberUpdatedState(onFractionChanged)
    val currentOnDragEnd by rememberUpdatedState(onDragEnd)

    Box(modifier = modifier.width(32.dp).onSizeChanged { trackHeightPx = it.height }) {
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .offset { IntOffset(0, thumbOffsetPx) }
                .height(thumbHeight)
                .width(32.dp)
                .semantics { contentDescription = "Manuscript fast scroll" }
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        var started = false
                        try {
                            down.consume()
                            currentOnDragStart()
                            started = true
                            val startFraction = currentFraction
                            var draggedPx = 0f
                            var lastFraction = startFraction
                            while (true) {
                                val event = awaitPointerEvent()
                                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                if (!change.pressed) break
                                draggedPx += change.positionChange().y
                                val nextFraction = (startFraction + draggedPx / currentTravelPx).coerceIn(0f, 1f)
                                if (abs(nextFraction - lastFraction) >= 0.0005f) {
                                    currentOnFractionChanged(nextFraction)
                                    lastFraction = nextFraction
                                }
                                change.consume()
                            }
                        } finally {
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
