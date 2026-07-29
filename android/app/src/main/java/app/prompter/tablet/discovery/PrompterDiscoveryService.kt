package app.prompter.tablet.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import app.prompter.tablet.diagnostics.DiagnosticLogger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class DiscoveryState(
    val running: Boolean = false,
    val servers: List<DiscoveredServer> = emptyList(),
    val lastError: String? = null
)

class PrompterDiscoveryService(context: Context, private val diagnostics: DiagnosticLogger? = null) {
    private val nsd = context.getSystemService(NsdManager::class.java)
    private val wifi = context.applicationContext.getSystemService(WifiManager::class.java)
    private var multicastLock: WifiManager.MulticastLock? = null
    private val found = linkedMapOf<String, DiscoveredServer>()
    private val _state = MutableStateFlow(DiscoveryState())
    val state: StateFlow<DiscoveryState> = _state.asStateFlow()

    private val listener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(type: String) { diagnostics?.record("discovery", "info", "discovery.started", "DNS-SD discovery started.", details = mapOf("serviceType" to type)); _state.value = _state.value.copy(running = true, lastError = null) }
        override fun onDiscoveryStopped(type: String) { _state.value = _state.value.copy(running = false) }
        override fun onStartDiscoveryFailed(type: String, code: Int) = fail("Discovery start failed ($code).")
        override fun onStopDiscoveryFailed(type: String, code: Int) = fail("Discovery stop failed ($code).")
        override fun onServiceLost(info: NsdServiceInfo) {
            found.entries.removeAll { it.value.displayName == info.serviceName }
            publish()
        }
        override fun onServiceFound(info: NsdServiceInfo) {
            if (info.serviceType.startsWith(SERVICE_TYPE)) resolve(info)
        }
    }

    fun start() {
        if (_state.value.running) return
        multicastLock = wifi.createMulticastLock("prompter-mdns").apply { setReferenceCounted(false); acquire() }
        runCatching { nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener) }
            .onFailure { fail(it.message ?: "Discovery could not start.") }
    }

    fun stop() {
        if (_state.value.running) runCatching { nsd.stopServiceDiscovery(listener) }
        multicastLock?.let { if (it.isHeld) it.release() }
        multicastLock = null
        _state.value = _state.value.copy(running = false)
    }

    fun addManual(host: String, port: Int = 43127) {
        val cleanHost = host.trim().removePrefix("ws://").substringBefore(':')
        require(cleanHost.isNotBlank() && port in 1..65535)
        val server = DiscoveredServer("manual:$cleanHost:$port", "Manual server", cleanHost, port, 1, 0, true, manual = true)
        found[server.serverId] = server
        publish()
    }

    @Suppress("DEPRECATION")
    private fun resolve(info: NsdServiceInfo) {
        nsd.resolveService(info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = fail("Could not resolve ${serviceInfo.serviceName} ($errorCode).")
            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                val txt = serviceInfo.attributes.mapValues { String(it.value, Charsets.UTF_8) }
                val host = serviceInfo.host?.hostAddress ?: return
                val serverId = txt["serverId"] ?: "${serviceInfo.serviceName}:$host:${serviceInfo.port}"
                diagnostics?.record("discovery", "info", "discovery.server.resolved", "Prompter server resolved.", serverId = serverId, remoteAddress = "$host:${serviceInfo.port}", details = mapOf("name" to serviceInfo.serviceName, "pairing" to (txt["pairing"] ?: "unknown")))
                found[serverId] = DiscoveryMapper.map(serviceInfo.serviceName, host, serviceInfo.port, txt)
                publish()
            }
        })
    }

    private fun publish() { _state.value = _state.value.copy(servers = found.values.sortedBy { it.displayName }, lastError = null) }
    private fun fail(message: String) { diagnostics?.record("discovery", "error", "discovery.failure", message); _state.value = _state.value.copy(lastError = message) }

    companion object { const val SERVICE_TYPE = "_prompter._tcp." }
}

object DiscoveryMapper {
    fun map(name: String, host: String, port: Int, txt: Map<String, String>) = DiscoveredServer(
        serverId = txt["serverId"] ?: "$name:$host:$port", displayName = name, host = host, port = port,
        protocolMajor = txt["protocolMajor"]?.toIntOrNull() ?: 0,
        protocolMinor = txt["protocolMinor"]?.toIntOrNull() ?: 0,
        pairingAvailable = txt["pairing"] == "1",
        transport = txt["transport"] ?: "ws-cleartext-lan-prototype"
    )
}
