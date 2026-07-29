package app.prompter.tablet

import android.app.Application
import app.prompter.tablet.audio.AudioCapture
import app.prompter.tablet.audio.AudioStreamController
import app.prompter.tablet.connection.PrompterConnectionRepository
import app.prompter.tablet.connection.NetworkPreflight
import app.prompter.tablet.connection.WebSocketClient
import app.prompter.tablet.discovery.PrompterDiscoveryService
import app.prompter.tablet.diagnostics.DiagnosticLogger
import app.prompter.tablet.pairing.PairingRepository
import app.prompter.tablet.protocol.ProtocolCodec
import app.prompter.tablet.security.CredentialStore
import app.prompter.tablet.security.DeviceIdentity
import app.prompter.tablet.security.PairedServerStore
import app.prompter.tablet.session.SessionRepository
import app.prompter.tablet.settings.DisplaySettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class PrompterApplication : Application() {
    lateinit var services: AppServices
        private set
    override fun onCreate() {
        super.onCreate()
        services = AppServices(this)
        services.diagnostics.record(
            "build", "info", "android.app.launch",
            "Prompter Tablet launched with ${AppBuildIdentity.summary()}.",
            details = mapOf(
                "versionName" to BuildConfig.VERSION_NAME,
                "versionCode" to BuildConfig.VERSION_CODE.toString(),
                "buildTimestamp" to BuildConfig.BUILD_TIMESTAMP,
                "gitHash" to BuildConfig.GIT_HASH,
                "dirty" to BuildConfig.GIT_DIRTY.toString(),
                "protocol" to "${app.prompter.tablet.protocol.ProtocolVersion.MAJOR}.${app.prompter.tablet.protocol.ProtocolVersion.MINOR}"
            )
        )
    }
}

class AppServices(application: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val identity = DeviceIdentity(application)
    val diagnostics = DiagnosticLogger(application)
    val discovery = PrompterDiscoveryService(application, diagnostics)
    val sessions = SessionRepository(application, diagnostics)
    val credentials = CredentialStore(application)
    val pairedServers = PairedServerStore(application)
    val displaySettings = DisplaySettingsStore(application)
    val connections = PrompterConnectionRepository(
        scope, WebSocketClient(diagnostics), ProtocolCodec(), credentials, pairedServers, sessions, { identity.deviceId }, diagnostics, NetworkPreflight(application)
    )
    val pairing = PairingRepository(application, connections, identity)
    val audio = AudioStreamController(AudioCapture(application, scope))
    init {
        diagnostics.setManualFollowUploader(connections::sendManualFollowDiagnostic)
    }
}
