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
                Text("Connect to your studio", style = MaterialTheme.typography.headlineSmall)
                Text(connectionLabel(state.connection), color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (state.connection is ConnectionState.Error) {
                    state.lastError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
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
                        Text("Prompter is available on your studio network")
                        Text(if (server.pairingAvailable) "Ready to pair" else "Previously paired tablets can reconnect")
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { viewModel.pair(server) }) { Text("Pair") }
                            OutlinedButton(onClick = { viewModel.connect(server) }) { Text("Connect") }
                        }
                    }
                }
            }
            item {
                HorizontalDivider()
                Text("Can’t find your computer?", style = MaterialTheme.typography.titleMedium)
                Text("Enter the computer name or private network address shown by Prompter.")
                OutlinedTextField(state.manualAddress, viewModel::setManualAddress, label = { Text("Computer name or address") }, singleLine = true)
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = viewModel::addManualAddress) { Text("Add server") }
                Spacer(Modifier.height(24.dp))
                Text("Use tablet connection only on your private studio network.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

private fun connectionLabel(state: ConnectionState) = when (state) {
    ConnectionState.Disconnected -> "Disconnected"
    is ConnectionState.Connecting -> "Connecting…"
    ConnectionState.AwaitingChallenge -> "Verifying connection…"
    is ConnectionState.PairingPending -> "Approve this tablet on ${state.serverName}"
    ConnectionState.Authenticating -> "Signing in…"
    is ConnectionState.Connected -> "Connected to Prompter"
    is ConnectionState.Reconnecting -> "Reconnecting…"
    is ConnectionState.Error -> "Couldn’t connect to Prompter"
}
