package app.prompter.tablet.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import app.prompter.tablet.ui.connection.ConnectionScreen
import app.prompter.tablet.ui.diagnostics.DiagnosticsScreen
import app.prompter.tablet.ui.prompter.PrompterScreen
import app.prompter.tablet.ui.prompter.ReaderViewportCache
import app.prompter.tablet.ui.prompter.readerManuscriptKey
import app.prompter.tablet.ui.settings.SettingsScreen
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.remember

@Composable
fun AppNavigation(state: MainUiState, viewModel: MainViewModel, onRequestMicrophonePermission: () -> Unit) {
    val readerViewport = remember { ReaderViewportCache() }
        .forManuscript(readerManuscriptKey(state.session.snapshot))
    val runtime = state.session.runtimeSettings
    val readingScheme = darkColorScheme(
        primary = Color(0xFFE2CF9E), onPrimary = Color(0xFF2C202C),
        secondary = Color(0xFF745A70), onSecondary = Color(0xFFF6EDF0),
        secondaryContainer = Color(0xFF443141), onSecondaryContainer = Color(0xFFF6EDF0),
        background = Color(0xFF2C202C), onBackground = Color(0xFFF6EDF0),
        surface = Color(0xFF443141), onSurface = Color(0xFFF6EDF0),
        surfaceVariant = Color(0xFF443141), onSurfaceVariant = Color(0xFFC7B4C5),
        outline = Color(0xFF745A70), error = Color(0xFFFFC3C7), onError = Color(0xFF641A34)
    )
    val controllerDark = darkColorScheme(
        primary = Color(0xFFE2CF9E), onPrimary = Color(0xFF2C202C),
        secondary = Color(0xFF745A70), onSecondary = Color(0xFFF6EDF0),
        secondaryContainer = Color(0xFF443141), onSecondaryContainer = Color(0xFFF6EDF0),
        background = Color(0xFF2C202C), onBackground = Color(0xFFF6EDF0),
        surface = Color(0xFF443141), onSurface = Color(0xFFF6EDF0),
        surfaceVariant = Color(0xFF443141), onSurfaceVariant = Color(0xFFC7B4C5),
        outline = Color(0xFF745A70), error = Color(0xFFFFC3C7), onError = Color(0xFF641A34)
    )
    val controllerLight = lightColorScheme(
        primary = Color(0xFF641A34), onPrimary = Color(0xFFFFF7F2),
        secondary = Color(0xFFE8ADBA), onSecondary = Color(0xFF641A34),
        secondaryContainer = Color(0xFFFFF7F2), onSecondaryContainer = Color(0xFF641A34),
        background = Color(0xFFF1D3DB), onBackground = Color(0xFF641A34),
        surface = Color(0xFFFFF7F2), onSurface = Color(0xFF641A34),
        surfaceVariant = Color(0xFFE8ADBA), onSurfaceVariant = Color(0xFF7B4A5E),
        outline = Color(0xFFCBA2B1), error = Color(0xFFAD2E3D), onError = Color(0xFFFFF7F2)
    )
    val fallback = if (state.display.darkTheme) controllerDark else controllerLight
    val scheme = if (runtime == null || state.screen != Screen.PROMPTER) fallback else readingScheme.copy(
        background = runtime.display.backgroundColor.toComposeColor(), surface = runtime.display.backgroundColor.toComposeColor(),
        onBackground = runtime.display.textColor.toComposeColor(), onSurface = runtime.display.textColor.toComposeColor(),
        primary = runtime.display.highlightColor.toComposeColor(),
        onPrimary = Color(0xFF2C202C), secondary = Color(0xFF745A70),
        onSecondary = Color(0xFFF6EDF0), surfaceVariant = runtime.display.backgroundColor.toComposeColor(),
        onSurfaceVariant = Color(0xFFC7B4C5), outline = Color(0xFF745A70),
        error = Color(0xFFFFC3C7), onError = Color(0xFF641A34)
    )
    MaterialTheme(
        colorScheme = scheme,
        typography = Typography(),
        shapes = Shapes(small = RoundedCornerShape(14.dp), medium = RoundedCornerShape(topStart = 22.dp, topEnd = 12.dp, bottomEnd = 22.dp, bottomStart = 12.dp), large = RoundedCornerShape(22.dp))
    ) {
        when (state.screen) {
            Screen.CONNECTION -> ConnectionScreen(state, viewModel)
            Screen.PROMPTER -> PrompterScreen(state, viewModel, readerViewport) {
                if (viewModel.hasMicrophonePermission()) viewModel.requestMicrophone() else onRequestMicrophonePermission()
            }
            Screen.DIAGNOSTICS -> DiagnosticsScreen(state, viewModel) { viewModel.show(if (state.session.snapshot == null) Screen.CONNECTION else Screen.PROMPTER) }
            Screen.SETTINGS -> SettingsScreen(state, viewModel) { viewModel.show(Screen.PROMPTER) }
        }
    }
}

private fun String.toComposeColor() = runCatching { Color(android.graphics.Color.parseColor(this)) }.getOrElse { Color.Unspecified }
