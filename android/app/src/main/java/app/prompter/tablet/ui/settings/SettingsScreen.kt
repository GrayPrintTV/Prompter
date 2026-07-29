package app.prompter.tablet.ui.settings

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.prompter.tablet.ui.MainUiState
import app.prompter.tablet.ui.MainViewModel
import app.prompter.tablet.settings.effectiveDisplaySettings

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun SettingsScreen(state: MainUiState, viewModel: MainViewModel, onBack: () -> Unit) {
    Scaffold(topBar = { TopAppBar(title = { Text("Display settings") }, navigationIcon = { TextButton(onClick = onBack) { Text("Back") } }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            val inherited = state.session.runtimeSettings?.display
            val effective = effectiveDisplaySettings(inherited, state.display)
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text("Match desktop display", Modifier.weight(1f))
                Switch(state.display.useWindowsDisplaySettings, { value -> viewModel.updateDisplay { it.copy(useWindowsDisplaySettings = value) } })
            }
            Text(if (state.display.useWindowsDisplaySettings && inherited != null) "Using the desktop appearance" else "Using a custom tablet appearance")
            Text("Font size: ${effective.fontSizeSp.toInt()} sp")
            Slider(state.display.fontSizeSp, { value -> viewModel.updateDisplay { it.copy(fontSizeSp = value) } }, valueRange = 22f..80f, enabled = !state.display.useWindowsDisplaySettings)
            Text("Line spacing: ${"%.2f".format(effective.lineSpacing)}")
            Slider(state.display.lineSpacing, { value -> viewModel.updateDisplay { it.copy(lineSpacing = value) } }, valueRange = 1f..2.2f, enabled = !state.display.useWindowsDisplaySettings)
            Text("Text width: ${(effective.contentWidthFraction * 100).toInt()}%")
            Slider(state.display.contentWidthFraction, { value -> viewModel.updateDisplay { it.copy(contentWidthFraction = value) } }, valueRange = .52f..94f, enabled = !state.display.useWindowsDisplaySettings)
            Text("Reading band: ${(effective.readingBandFraction * 100).toInt()}%")
            Slider(state.display.readingBandPercent, { value -> viewModel.updateDisplay { it.copy(readingBandPercent = value) } }, valueRange = 20f..65f, enabled = !state.display.useWindowsDisplaySettings)
            OutlinedButton(onClick = viewModel::resetDisplayToWindows, enabled = inherited != null) { Text("Reset to desktop appearance") }
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text("Dark theme", Modifier.weight(1f)); Switch(state.display.darkTheme, { value -> viewModel.updateDisplay { it.copy(darkTheme = value) } })
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(state.display.alignment == "start", { viewModel.updateDisplay { it.copy(alignment = "start") } }, label = { Text("Left") })
                FilterChip(state.display.alignment == "center", { viewModel.updateDisplay { it.copy(alignment = "center") } }, label = { Text("Center") })
            }
            Text("Brightness (${if (state.display.brightness < 0) "system" else "${(state.display.brightness * 100).toInt()}%"})")
            Slider(state.display.brightness.coerceAtLeast(0f), { value -> viewModel.updateDisplay { it.copy(brightness = value) } }, valueRange = 0.05f..1f)
            OutlinedButton(onClick = { viewModel.updateDisplay { it.copy(brightness = -1f) } }) { Text("Use system brightness") }
        }
    }
}
