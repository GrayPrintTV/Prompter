package app.prompter.tablet.discovery

data class DiscoveredServer(
    val serverId: String,
    val displayName: String,
    val host: String,
    val port: Int,
    val protocolMajor: Int,
    val protocolMinor: Int,
    val pairingAvailable: Boolean,
    val transport: String = "ws-cleartext-lan-prototype",
    val manual: Boolean = false
) {
    val endpoint: String get() = "ws://$host:$port"
}
