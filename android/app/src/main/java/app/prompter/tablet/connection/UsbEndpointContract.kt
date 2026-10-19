package app.prompter.tablet.connection

import app.prompter.tablet.discovery.DiscoveredServer
import app.prompter.tablet.protocol.ProtocolVersion

enum class TransportPreference { AUTO, LAN_ONLY, USB_ONLY }

data class UsbEndpoint(
    val serverId: String,
    val port: Int,
    val preference: TransportPreference
) {
    fun discovered() = DiscoveredServer(
        serverId = serverId,
        displayName = "Prompter over USB",
        host = "127.0.0.1",
        port = port,
        protocolMajor = ProtocolVersion.MAJOR,
        protocolMinor = ProtocolVersion.MINOR,
        pairingAvailable = false,
        transport = "usb-adb-reverse"
    )
}

data class UsbIntentExtra(val name: String, val value: Any?)

object UsbEndpointContract {
    const val ACTION = "app.prompter.tablet.action.CONNECT_USB"
    const val EXTRA_SERVER_ID = "usb_server_id"
    const val EXTRA_PORT = "usb_port"
    const val EXTRA_MODE = "usb_mode"

    fun parse(action: String?, extras: List<UsbIntentExtra>): UsbEndpoint {
        require(action == ACTION) { "Unsupported Prompter USB connection action." }
        require(extras.size == 3) { "USB connection intent must contain exactly three extras." }
        val grouped = extras.groupBy(UsbIntentExtra::name)
        require(grouped.values.all { it.size == 1 }) { "USB connection intent contains duplicate extras." }
        require(grouped.keys == setOf(EXTRA_SERVER_ID, EXTRA_PORT, EXTRA_MODE)) {
            "USB connection intent contains missing or unknown extras."
        }
        val serverId = grouped.getValue(EXTRA_SERVER_ID).single().value as? String
            ?: throw IllegalArgumentException("USB server identifier must be a string.")
        require(serverId.matches(Regex("[A-Za-z0-9._:/-]{1,200}"))) { "USB server identifier is invalid." }
        val port = grouped.getValue(EXTRA_PORT).single().value as? Int
            ?: throw IllegalArgumentException("USB endpoint port must be an integer.")
        require(port in 1..65_535) { "USB endpoint port is invalid." }
        val mode = grouped.getValue(EXTRA_MODE).single().value as? String
            ?: throw IllegalArgumentException("USB transport preference must be a string.")
        val preference = when (mode) {
            "auto" -> TransportPreference.AUTO
            "lan-only" -> TransportPreference.LAN_ONLY
            "usb-only" -> TransportPreference.USB_ONLY
            else -> throw IllegalArgumentException("USB transport preference is invalid.")
        }
        return UsbEndpoint(serverId, port, preference)
    }
}

fun isAllowedConnectionTarget(server: DiscoveredServer): Boolean =
    if (server.transport == "usb-adb-reverse") server.host == "127.0.0.1"
    else runCatching {
        val address = java.net.InetAddress.getByName(server.host)
        address is java.net.Inet4Address && address.isSiteLocalAddress
    }.getOrDefault(false)
