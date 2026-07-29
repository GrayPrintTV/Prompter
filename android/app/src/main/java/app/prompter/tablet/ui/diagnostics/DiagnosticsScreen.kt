package app.prompter.tablet.ui.diagnostics

import android.os.Build
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.prompter.tablet.AppBuildIdentity
import app.prompter.tablet.protocol.ProtocolVersion
import app.prompter.tablet.settings.effectiveDisplaySettings
import app.prompter.tablet.ui.MainUiState
import app.prompter.tablet.ui.MainViewModel
import java.time.Instant

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun DiagnosticsScreen(state: MainUiState, viewModel: MainViewModel, onBack: () -> Unit) {
    val snapshot = state.session.snapshot
    val appBuild = AppBuildIdentity.payload
    val serverBuild = state.connectionDiagnostics.serverBuild
    val serverProtocol = "${state.connectionDiagnostics.serverProtocolMajor ?: "?"}.${state.connectionDiagnostics.serverProtocolMinor ?: "?"}"
    val protocolMatch = state.connectionDiagnostics.serverProtocolMajor == ProtocolVersion.MAJOR
    Scaffold(topBar = { TopAppBar(title = { Text("Diagnostics") }, navigationIcon = { TextButton(onClick = onBack) { Text("Back") } }) }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { Text("Build identity", style = MaterialTheme.typography.titleMedium) }
            item { Diagnostic("Android app", "Prompter Tablet ${appBuild.versionName} (${appBuild.versionCode})") }
            item { Diagnostic("Android build timestamp", appBuild.buildTimestamp ?: "unavailable") }
            item { Diagnostic("Android git", "${appBuild.gitHash ?: "unavailable"}${if (appBuild.dirty == true) " DIRTY" else ""}") }
            item { Diagnostic("Android protocol", "${ProtocolVersion.MAJOR}.${ProtocolVersion.MINOR}") }
            item { Diagnostic("Connected server", "${serverBuild?.versionName ?: "unavailable"}${serverBuild?.versionCode?.let { " ($it)" } ?: ""}") }
            item { Diagnostic("Server build timestamp", serverBuild?.buildTimestamp ?: "unavailable") }
            item { Diagnostic("Server git", "${serverBuild?.gitHash ?: "unavailable"}${if (serverBuild?.dirty == true) " DIRTY" else ""}") }
            item { Diagnostic("Server protocol", "$serverProtocol — ${if (protocolMatch) "MATCH" else "MISMATCH"}") }
            item { Diagnostic("Server started", state.connectionDiagnostics.serverStartedAtMs?.let { "${Instant.ofEpochMilli(it)} ($it)" } ?: "unavailable") }

            item { HorizontalDivider(); Text("Runtime/manual follow", style = MaterialTheme.typography.titleMedium) }
            item { Diagnostic("Android", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})") }
            item { Diagnostic("Device", "${Build.MANUFACTURER} ${Build.MODEL}") }
            item { Diagnostic("Connection", state.connection.toString()) }
            item { Diagnostic("Connection transition cause", state.connectionDiagnostics.lastStateTransitionCause ?: "—") }
            item { Diagnostic("App lifecycle", state.connectionDiagnostics.appLifecycleState) }
            item { Diagnostic("Address", "${state.connectionDiagnostics.resolvedAddress ?: "—"}:${state.connectionDiagnostics.port ?: "—"}") }
            item { Diagnostic("Authentication", state.connectionDiagnostics.authenticationState) }
            item { Diagnostic("Discovery", if (state.discovery.running) "running (${state.discovery.servers.size} found)" else "stopped") }
            item { Diagnostic("Session", state.session.sessionId ?: "—") }
            item { Diagnostic("Current session revision", "${state.session.latestMovement?.sessionRevision ?: snapshot?.sessionRevision ?: "—"}") }
            item { Diagnostic("Current movement event", state.session.latestMovementEventId ?: "—") }
            item { Diagnostic("Manuscript revision", "${snapshot?.manuscriptRevision ?: "—"}") }
            item { Diagnostic("Manual override state", state.manualFollow.overrideState) }
            item { Diagnostic("Pending manual anchor", "token ${state.manualFollow.anchorTokenIndex ?: "—"}, sentence ${state.manualFollow.anchorSentenceIndex ?: "—"}, paragraph ${state.manualFollow.anchorParagraphIndex ?: "—"}") }
            item { Diagnostic("Last remote movement status", state.session.lastRemoteMovementStatus) }
            item { Diagnostic("Last suppressed update", state.manualFollow.lastSuppressedReason ?: "—") }
            item { Diagnostic("Last accepted update", state.manualFollow.lastAcceptedReason ?: state.session.lastAcceptedMovementReason ?: "—") }
            item { Diagnostic("Latest movement reason", state.session.latestMovement?.reason ?: "—") }
            item { Diagnostic("Latest movement anchor distance", state.session.latestMovement?.manualAnchorDistanceTokens?.toString() ?: "—") }
            item { Diagnostic("Manuscript hash", snapshot?.manuscript?.contentHash ?: "—") }
            item { Diagnostic("Controller lease", "${state.connectionDiagnostics.controllerLeaseState} (${state.connectionDiagnostics.controllerLease})") }
            item { Diagnostic("Registered audio stream", state.connectionDiagnostics.registeredAudioStreamId ?: "waiting for server acknowledgement") }
            item { Diagnostic("Audio socket generation", state.connectionDiagnostics.audioSocketGeneration?.toString() ?: "none") }
            item { Diagnostic("Server audio connection", state.connectionDiagnostics.serverAudioConnectionGeneration ?: "none") }
            item { Diagnostic("Registration attempts", state.connectionDiagnostics.streamRegistrationAttempts.toString()) }
            item { Diagnostic("Queued manual anchor", state.connectionDiagnostics.pendingManualAnchorTokenIndex?.let { "token $it — ${state.connectionDiagnostics.pendingManualAnchorReason ?: "waiting"}" } ?: "—") }
            item { Diagnostic("Microphone", "${if (state.audio.active) "active" else "stopped"}, ${state.audio.sampleRate ?: "—"} Hz") }
            item { Diagnostic("Audio", "${state.audio.framesSent} sent, ${state.audio.framesDropped} dropped, sequence ${state.audio.lastSequence}") }
            item { Diagnostic("Sequence gaps", state.session.sequenceGaps.toString()) }
            item { Diagnostic("Reconnects", state.connectionDiagnostics.reconnectCount.toString()) }
            item { Diagnostic("Latest transcript", state.session.latestTranscript?.take(160) ?: "—") }
            item { Diagnostic("Latest movement", state.session.latestMovement?.classification ?: "—") }
            item { Diagnostic("Latest movement rejection", state.session.latestMovementRejection ?: "—") }
            item { Diagnostic("Last error", state.lastError ?: state.connectionDiagnostics.lastError ?: "—") }
            item { Diagnostic("Runtime settings", state.session.runtimeSettings?.let { "revision ${it.settingsRevision}, follow ${it.follow.enabled}" } ?: "not received") }
            item { Diagnostic("Typography", effectiveDisplaySettings(state.session.runtimeSettings?.display, state.display).let { "inherited ${state.session.runtimeSettings?.display?.fontSizeSp ?: "none"}sp; effective ${it.fontSizeSp}sp, line ${it.lineSpacing}, width ${(it.contentWidthFraction * 100).toInt()}%, local override ${!state.display.useWindowsDisplaySettings}" }) }
            item { Diagnostic("Palette", state.session.runtimeSettings?.display?.let { "${it.backgroundColor} / ${it.textColor} / ${it.highlightColor} @ ${it.highlightOpacity}" } ?: "not received") }
            item { Diagnostic("Follow", state.session.runtimeSettings?.follow?.let { "smooth ${it.smoothness}, max ${it.maximumSpeedDpPerSec} dp/s" } ?: "not received") }
            item { Text(state.connectionDiagnostics.cleartextWarning, color = MaterialTheme.colorScheme.error) }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = viewModel::copyDiagnostics) { Text("Copy Diagnostics") }
                    OutlinedButton(onClick = viewModel::clearDiagnostics) { Text("Clear View") }
                }
            }
            item { HorizontalDivider(); Text("Live connectivity log", style = MaterialTheme.typography.titleMedium) }
            items(state.diagnosticEvents.size) { index ->
                val event = state.diagnosticEvents[index]
                Text("${event.timestampLocal} [${event.sequence}] ${event.level.uppercase()} ${event.component} ${event.event}\n${event.message}" +
                    (event.closeCode?.let { " close=$it ${event.closeReason.orEmpty()}" } ?: "") +
                    (event.errorMessage?.let { " error=$it" } ?: ""), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun Diagnostic(label: String, value: String) {
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        Text(value)
    }
}
