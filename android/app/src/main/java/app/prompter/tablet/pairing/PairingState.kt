package app.prompter.tablet.pairing

sealed interface PairingState {
    data object Idle : PairingState
    data class WaitingForWindows(val serverName: String) : PairingState
    data class Denied(val reason: String) : PairingState
    data object Approved : PairingState
}
