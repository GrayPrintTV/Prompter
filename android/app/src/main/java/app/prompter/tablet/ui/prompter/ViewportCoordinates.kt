package app.prompter.tablet.ui.prompter

/** Converts LazyColumn's content-relative item coordinates into overlay/viewport coordinates. */
data class ViewportTargetGeometry(
    val itemOffset: Int,
    val viewportStartOffset: Int,
    val beforeContentPadding: Int,
    val lineCenterInsideParagraph: Float,
    val readingBandCenter: Int
) {
    val paragraphTopInViewport: Float get() = itemOffset - viewportStartOffset.toFloat()
    val targetLineCenterInViewport: Float get() = paragraphTopInViewport + lineCenterInsideParagraph
    val desiredScrollDelta: Float get() = targetLineCenterInViewport - readingBandCenter
}
