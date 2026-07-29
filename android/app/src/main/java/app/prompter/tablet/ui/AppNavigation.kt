package app.prompter.tablet.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import app.prompter.tablet.ui.connection.ConnectionScreen
import app.prompter.tablet.ui.diagnostics.DiagnosticsScreen
import app.prompter.tablet.ui.prompter.PrompterScreen
import app.prompter.tablet.ui.settings.SettingsScreen
import androidx.compose.ui.graphics.Color

@Composable
fun AppNavigation(state: MainUiState, viewModel: MainViewModel, onRequestMicrophonePermission: () -> Unit) {
    val runtime = state.session.runtimeSettings
    val fallback = if (state.display.darkTheme) darkColorScheme() else lightColorScheme()
    val scheme = if (runtime == null) fallback else fallback.copy(
        background = runtime.display.backgroundColor.toComposeColor(), surface = runtime.display.backgroundColor.toComposeColor(),
        onBackground = runtime.display.textColor.toComposeColor(), onSurface = runtime.display.textColor.toComposeColor(),
        primary = runtime.display.highlightColor.toComposeColor()
    )
    MaterialTheme(colorScheme = scheme) {
        when (state.screen) {
            Screen.CONNECTION -> ConnectionScreen(state, viewModel)
            Screen.PROMPTER -> PrompterScreen(state, viewModel) {
                if (viewModel.hasMicrophonePermission()) viewModel.requestMicrophone() else onRequestMicrophonePermission()
            }
            Screen.DIAGNOSTICS -> DiagnosticsScreen(state, viewModel) { viewModel.show(if (state.session.snapshot == null) Screen.CONNECTION else Screen.PROMPTER) }
            Screen.SETTINGS -> SettingsScreen(state, viewModel) { viewModel.show(Screen.PROMPTER) }
        }
    }
}

private fun String.toComposeColor() = runCatching { Color(android.graphics.Color.parseColor(this)) }.getOrElse { Color.Unspecified }
