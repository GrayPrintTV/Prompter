package app.prompter.tablet.settings

import app.prompter.tablet.protocol.RuntimeDisplaySettings

/**
 * The single display-resolution boundary for the native prompter. Windows values are the
 * inherited baseline; a tablet can replace only its own presentation values and never sends
 * those replacements back to the server.
 */
data class EffectiveDisplaySettings(
    val fontSizeSp: Float,
    val lineSpacing: Float,
    val contentWidthFraction: Float,
    val paragraphSpacingEm: Float,
    val readingBandFraction: Float,
    val readingBandHeightLines: Float
) {
    val layoutKey: String get() = "$fontSizeSp:$lineSpacing:$contentWidthFraction:$paragraphSpacingEm:$readingBandFraction:$readingBandHeightLines"
}

fun effectiveDisplaySettings(inherited: RuntimeDisplaySettings?, local: TabletDisplaySettings): EffectiveDisplaySettings {
    val inheritedWidth = inherited?.contentWidthFraction ?: fallbackWidthFraction(inherited?.sideMarginsDp)
    val useInherited = local.useWindowsDisplaySettings && inherited != null
    return if (useInherited) {
        EffectiveDisplaySettings(
            inherited.fontSizeSp, inherited.lineSpacing, inheritedWidth,
            inherited.paragraphSpacingEm, inherited.readingBandFraction, inherited.readingBandHeightLines
        )
    } else {
        EffectiveDisplaySettings(
            local.fontSizeSp, local.lineSpacing, local.contentWidthFraction,
            inherited?.paragraphSpacingEm ?: 1.0f,
            local.readingBandPercent / 100f,
            inherited?.readingBandHeightLines ?: 1f
        )
    }
}

fun inheritedDisplaySettings(inherited: RuntimeDisplaySettings?): EffectiveDisplaySettings? = inherited?.let {
    EffectiveDisplaySettings(
        it.fontSizeSp, it.lineSpacing, it.contentWidthFraction ?: fallbackWidthFraction(it.sideMarginsDp),
        it.paragraphSpacingEm, it.readingBandFraction, it.readingBandHeightLines
    )
}

private fun fallbackWidthFraction(sideMarginsDp: Float?): Float {
    // Older snapshots only carry sideMarginsDp. Keep them usable without treating a dp margin
    // as a stable proportion on every device.
    return (0.94f - (((sideMarginsDp ?: 28f) - 12f) / 58f) * .42f).coerceIn(.52f, .94f)
}
