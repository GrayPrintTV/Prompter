package app.prompter.tablet.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.decodeFromJsonElement

class ProtocolCodec(private val now: () -> Long = System::currentTimeMillis) {
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

    fun decodeEnvelope(text: String): ProtocolEnvelope {
        val envelope = json.decodeFromString<ProtocolEnvelope>(text)
        ProtocolVersion.requireCompatible(envelope.protocolMajor, envelope.protocolMinor)
        require(envelope.type.isNotBlank()) { "Envelope type is required." }
        require(envelope.serverId.isNotBlank() && envelope.connectionId.isNotBlank()) { "Envelope identifiers are required." }
        require(envelope.sequence >= 0) { "Envelope sequence must be non-negative." }
        return envelope
    }

    inline fun <reified T> decodePayload(envelope: ProtocolEnvelope): T = json.decodeFromJsonElement(envelope.payload)

    fun <T> encodeEnvelope(
        type: String,
        payload: T,
        serializer: KSerializer<T>,
        serverId: String,
        sessionId: String,
        connectionId: String,
        sequence: Long
    ): String = json.encodeToString(ProtocolEnvelope(
        protocolMajor = ProtocolVersion.MAJOR,
        protocolMinor = ProtocolVersion.MINOR,
        type = type,
        serverId = serverId.ifBlank { "unknown-server" },
        sessionId = sessionId.ifBlank { "android-pending" },
        connectionId = connectionId.ifBlank { "android-${System.currentTimeMillis()}" },
        sequence = sequence,
        sentAtMs = now(),
        payload = json.encodeToJsonElement(serializer, payload) as JsonObject
    ))
}
