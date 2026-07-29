package app.prompter.tablet.pairing

import android.content.Context
import android.os.Build
import app.prompter.tablet.connection.PrompterConnectionRepository
import app.prompter.tablet.AppBuildIdentity
import app.prompter.tablet.discovery.DiscoveredServer
import app.prompter.tablet.protocol.PairRequest
import app.prompter.tablet.security.DeviceIdentity
import java.util.UUID

class PairingRepository(private val context: Context, private val connections: PrompterConnectionRepository, identity: DeviceIdentity) {
    val deviceId: String = identity.deviceId

    fun pair(server: DiscoveredServer, code: String? = null) {
        connections.pair(server, PairRequest(
            requestId = UUID.randomUUID().toString(), deviceId = deviceId,
            deviceName = "${Build.MANUFACTURER} ${Build.MODEL}", model = Build.MODEL,
            pairingCode = code?.takeIf { it.isNotBlank() }, clientNonce = UUID.randomUUID().toString(),
            clientBuild = AppBuildIdentity.payload
        ))
    }
}
