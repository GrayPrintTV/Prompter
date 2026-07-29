package app.prompter.tablet.security

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.prompter.tablet.discovery.DiscoveredServer
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.pairedServerDataStore by preferencesDataStore("paired_server")

data class PairedServer(
    val serverId: String,
    val displayName: String,
    val host: String,
    val port: Int,
    val protocolMajor: Int,
    val protocolMinor: Int,
    val lastConnectedAt: Long = 0,
    val nickname: String? = null
) {
    fun discovered() = DiscoveredServer(serverId, nickname ?: displayName, host, port, protocolMajor, protocolMinor, false)
}

class PairedServerStore(private val context: Context) {
    private object Keys {
        val id = stringPreferencesKey("server_id"); val name = stringPreferencesKey("server_name")
        val host = stringPreferencesKey("host"); val port = intPreferencesKey("port")
        val major = intPreferencesKey("protocol_major"); val minor = intPreferencesKey("protocol_minor")
        val last = longPreferencesKey("last_connected_at"); val nickname = stringPreferencesKey("nickname")
    }

    val pairedServer: Flow<PairedServer?> = context.pairedServerDataStore.data.map { p ->
        val id = p[Keys.id] ?: return@map null
        PairedServer(id, p[Keys.name] ?: id, p[Keys.host] ?: return@map null, p[Keys.port] ?: 43127,
            p[Keys.major] ?: 1, p[Keys.minor] ?: 0, p[Keys.last] ?: 0, p[Keys.nickname])
    }

    suspend fun save(server: DiscoveredServer, lastConnectedAt: Long = 0) {
        context.pairedServerDataStore.edit { p ->
            p[Keys.id] = server.serverId; p[Keys.name] = server.displayName; p[Keys.host] = server.host; p[Keys.port] = server.port
            p[Keys.major] = server.protocolMajor; p[Keys.minor] = server.protocolMinor; p[Keys.last] = lastConnectedAt
        }
    }

    suspend fun markConnected(at: Long) { context.pairedServerDataStore.edit { it[Keys.last] = at } }
    suspend fun clear() { context.pairedServerDataStore.edit { it.clear() } }
}
