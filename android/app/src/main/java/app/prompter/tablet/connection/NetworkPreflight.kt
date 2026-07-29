package app.prompter.tablet.connection

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

class NetworkPreflight(context: Context) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)

    fun failureReason(): String? {
        val network = connectivity.activeNetwork
            ?: return "No active network. Connect the tablet to the same Wi-Fi as the Windows PC."
        val capabilities = connectivity.getNetworkCapabilities(network)
            ?: return "The active network has no usable capabilities. Reconnect tablet Wi-Fi."
        if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
            return "No active Wi-Fi route. Connect the tablet to the same Wi-Fi as the Windows PC."
        }
        val links = connectivity.getLinkProperties(network)?.linkAddresses.orEmpty()
        if (links.none { it.address.address.size == 4 }) {
            return "Wi-Fi has no IPv4 address. Reconnect Wi-Fi before pairing with the Windows server."
        }
        return null
    }
}
