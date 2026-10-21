package app.prompter.tablet.ui.prompter

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.prompter.tablet.protocol.MovementEvent
import app.prompter.tablet.protocol.SessionSnapshot

internal data class ReaderManuscriptKey(val id: String, val hash: String, val revision: Long)

internal fun readerManuscriptKey(snapshot: SessionSnapshot?) = snapshot?.let {
    ReaderManuscriptKey(it.manuscript.manuscriptId, it.manuscript.contentHash, it.manuscriptRevision)
}

internal data class RenderedMovementKey(
    val sessionId: String?, val eventId: String?, val movement: MovementEvent, val layoutKey: String,
    val viewportWidth: Int, val viewportHeight: Int
)

internal class ReaderViewportState(
    val listState: LazyListState = LazyListState(),
    val followController: MovementFollowController = MovementFollowController()
) {
    var manualTouchGeneration by mutableIntStateOf(0)
    var manualScrollObserved by mutableStateOf(false)
    var manualDetectedAtMs by mutableLongStateOf(0L)
    var manualInputSource by mutableStateOf("unknown")
    var fastScrollDragging by mutableStateOf(false)
    var renderedMovement: RenderedMovementKey? = null
}

/** Keeps only the current manuscript's visual state while non-reader screens are composed. */
internal class ReaderViewportCache {
    private var manuscriptKey: ReaderManuscriptKey? = null
    private var viewport: ReaderViewportState? = null

    fun forManuscript(key: ReaderManuscriptKey?): ReaderViewportState? {
        if (key == null) return null // A transient missing snapshot is not a new manuscript.
        if (key != manuscriptKey) {
            manuscriptKey = key
            viewport = ReaderViewportState()
        }
        return viewport
    }
}
