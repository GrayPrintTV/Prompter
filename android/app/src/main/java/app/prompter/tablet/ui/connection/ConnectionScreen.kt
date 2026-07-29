package app.prompter.tablet.ui.connection

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.prompter.tablet.connection.ConnectionState
import app.prompter.tablet.ui.MainUiState
import app.prompter.tablet.ui.MainViewModel
import app.prompter.tablet.ui.Screen

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun ConnectionScreen(state: MainUiState, viewModel: MainViewModel) {
    Scaffold(topBar = { TopAppBar(title = { Text("Prompter Tablet") }, actions = {
        TextButton(onClick = { viewModel.show(Screen.DIAGNOSTICS) }) { Text("Diagnostics") }
    }) }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text("Windows server", style = MaterialTheme.typography.headlineSmall)
                Text(connectionLabel(state.connection), color = MaterialTheme.colorScheme.onSurfaceVariant)
                state.lastError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = viewModel::refreshDiscovery) { Text(if (state.discovery.running) "Refresh" else "Discover") }
                    if (state.connection is ConnectionState.Reconnecting) OutlinedButton(onClick = viewModel::reconnect) { Text("Reconnect now") }
                }
            }
            item {
                OutlinedTextField(state.pairingCode, viewModel::setPairingCode, label = { Text("Optional 6-digit pairing code") }, singleLine = true)
            }
            items(state.discovery.servers, key = { it.serverId }) { server ->
                ElevatedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(server.displayName, style = MaterialTheme.typography.titleMedium)
                        Text("${server.host}:${server.port} · protocol ${server.protocolMajor}.${server.protocolMinor}")
                        Text(if (server.pairingAvailable) "Pairing available" else "Pairing state not advertised")
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { viewModel.pair(server) }) { Text("Pair") }
                            OutlinedButton(onClick = { viewModel.connect(server) }) { Text("Connect") }
                        }
                    }
                }
            }
            item {
                HorizontalDivider()
                Text("Manual fallback", style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(state.manualAddress, viewModel::setManualAddress, label = { Text("Private IP or hostname[:port]") }, singleLine = true)
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = viewModel::addManualAddress) { Text("Add server") }
                Spacer(Modifier.height(24.dp))
                Text("Trusted-LAN prototype: manuscript and microphone audio are not encrypted in transit.", color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

private fun connectionLabel(state: ConnectionState) = when (state) {
    ConnectionState.Disconnected -> "Disconnected"
    is ConnectionState.Connecting -> "Connecting to ${state.endpoint}"
    ConnectionState.AwaitingChallenge -> "Waiting for server challenge"
    is ConnectionState.PairingPending -> "Waiting for approval on ${state.serverName}"
    ConnectionState.Authenticating -> "Authenticating"
    is ConnectionState.Connected -> "Connected to ${state.endpoint}"
    is ConnectionState.Reconnecting -> "Reconnecting in ${state.delayMs} ms (attempt ${state.attempt})"
    is ConnectionState.Error -> state.message
}
