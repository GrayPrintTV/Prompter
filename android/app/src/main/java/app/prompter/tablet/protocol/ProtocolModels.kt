package app.prompter.tablet.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class BuildIdentityPayload(
    val versionName: String? = null,
    val versionCode: Int? = null,
    val buildTimestamp: String? = null,
    val gitHash: String? = null,
    val dirty: Boolean? = null,
    val protocolMajor: Int? = null,
    val protocolMinor: Int? = null
)

@Serializable
data class ProtocolEnvelope(
    val protocolMajor: Int,
    val protocolMinor: Int,
    val type: String,
    val serverId: String,
    val sessionId: String,
    val connectionId: String,
    val sequence: Long,
    val sentAtMs: Long,
    val payload: JsonObject
)

@Serializable data class CharacterRange(val start: Int, val end: Int)
@Serializable data class Position(val tokenIndex: Int, val character: Int, val sentenceIndex: Int, val paragraphIndex: Int)
@Serializable data class ParagraphAnchor(val paragraphIndex: Int, val characterRange: CharacterRange, val sentenceStart: Int, val sentenceEnd: Int)
@Serializable data class SentenceAnchor(val sentenceIndex: Int, val paragraphIndex: Int, val characterRange: CharacterRange, val tokenStart: Int, val tokenEnd: Int)
@Serializable data class TokenAnchor(val tokenIndex: Int, val sentenceIndex: Int, val paragraphIndex: Int, val characterRange: CharacterRange)

@Serializable
data class ManuscriptPayload(
    val manuscriptId: String,
    val contentHash: String,
    val normalizedContent: String? = null,
    val contentReference: String? = null,
    val paragraphs: List<ParagraphAnchor>,
    val sentences: List<SentenceAnchor>,
    val tokens: List<TokenAnchor>
)

@Serializable data class ControllerLease(val deviceId: String, val leaseId: String)
@Serializable data class DisplayHints(val readingZonePercent: Float = 38f, val readingLookaheadTokens: Int = 0, val theme: String = "dark")

@Serializable data class RuntimeDisplaySettings(val backgroundColor: String, val textColor: String, val highlightColor: String, val highlightOpacity: Float, val fontSizeSp: Float, val lineSpacing: Float, val sideMarginsDp: Float, val paragraphSpacingEm: Float, val readingBandFraction: Float, val readingBandHeightLines: Float, val contentWidthFraction: Float? = null)
@Serializable data class RuntimeFollowSettings(val enabled: Boolean, val smoothness: Float, val maximumSpeedDpPerSec: Float, val catchUpAggressiveness: Float, val deadZoneDp: Float, val largeCorrectionPolicy: String)
@Serializable data class RuntimeServerAlignmentSettings(val readingLookaheadTokens: Int)
@Serializable data class RuntimeSettings(val settingsRevision: Long, val source: String, val updatedAtMs: Long, val display: RuntimeDisplaySettings, val follow: RuntimeFollowSettings, val serverAlignment: RuntimeServerAlignmentSettings)

@Serializable
data class SessionSnapshot(
    val sessionRevision: Long,
    val manuscriptRevision: Long,
    val manuscript: ManuscriptPayload,
    val acceptedPosition: Position,
    val followState: String,
    val currentConfidence: Double,
    val latestTranscript: String? = null,
    val controllerLease: ControllerLease? = null,
    val displayHints: DisplayHints,
    val runtimeSettings: RuntimeSettings? = null,
    val narrationSessionId: String? = null,
    val movementDecision: JsonObject? = null
)

@Serializable
data class ManuscriptSyncManifest(
    val manuscriptId: String,
    val contentHash: String,
    val contentLength: Int,
    val paragraphCount: Int,
    val tokenCount: Int
)

@Serializable data class SnapshotChunkCounts(val content: Int, val paragraphs: Int, val tokens: Int)

@Serializable
data class SessionSnapshotStart(
    val syncId: String,
    val sessionRevision: Long,
    val manuscriptRevision: Long,
    val manuscript: ManuscriptSyncManifest,
    val chunkCounts: SnapshotChunkCounts,
    val acceptedPosition: Position,
    val followState: String,
    val currentConfidence: Double,
    val latestTranscript: String? = null,
    val controllerLease: ControllerLease? = null,
    val displayHints: DisplayHints,
    val runtimeSettings: RuntimeSettings? = null,
    val narrationSessionId: String? = null,
    val movementDecision: JsonObject? = null
)

@Serializable data class ManuscriptContentChunk(val syncId: String, val chunkIndex: Int, val chunkCount: Int, val text: String)
@Serializable data class ManuscriptParagraphChunk(val syncId: String, val chunkIndex: Int, val chunkCount: Int, val paragraphs: List<ParagraphAnchor>)
@Serializable data class ManuscriptTokenChunk(
    val syncId: String,
    val chunkIndex: Int,
    val chunkCount: Int,
    val firstTokenIndex: Int,
    val sentenceIndexes: IntArray,
    val paragraphIndexes: IntArray,
    val characterStarts: IntArray,
    val characterEnds: IntArray
)
@Serializable data class SessionSnapshotComplete(val syncId: String)

@Serializable
data class SessionState(
    val sessionRevision: Long,
    val manuscriptRevision: Long,
    val manuscript: CachedManuscriptIdentity,
    val acceptedPosition: Position,
    val followState: String,
    val currentConfidence: Double,
    val latestTranscript: String? = null,
    val controllerLease: ControllerLease? = null,
    val displayHints: DisplayHints,
    val runtimeSettings: RuntimeSettings? = null,
    val narrationSessionId: String? = null,
    val movementDecision: JsonObject? = null
)
@Serializable data class CachedManuscriptIdentity(val manuscriptId: String, val contentHash: String)

@Serializable
data class TranscriptEvent(
    val sessionRevision: Long,
    val manuscriptRevision: Long,
    val text: String,
    val isFinal: Boolean,
    val source: String,
    val confidence: Double? = null,
    val audioSequence: Long? = null,
    val requestId: String? = null,
    val timestampMs: Long,
    val acceptedPosition: Position
)

@Serializable
data class MovementEvent(
    val sessionRevision: Long,
    val manuscriptRevision: Long,
    val confirmedTokenIndex: Int,
    val targetTokenIndex: Int,
    val targetCharacter: Int,
    val sentenceIndex: Int,
    val paragraphIndex: Int,
    val confidence: Double,
      val durationHintMs: Long,
      val classification: String,
      val reason: String,
      val manualRepositionStatus: String? = null,
      val manualAnchorTokenIndex: Int? = null,
      val manualAnchorDistanceTokens: Int? = null
  )

@Serializable
data class ServerChallenge(
    val nonce: String,
    val issuedAtMs: Long,
    val serverId: String,
    val protocolMajor: Int? = null,
    val protocolMinor: Int? = null,
    val serverBuild: BuildIdentityPayload? = null,
    val serverStartedAtMs: Long? = null
)
@Serializable data class PairCredential(val approved: Boolean, val deviceId: String, val credential: String)
@Serializable data class PairDenied(val approved: Boolean = false, val reason: String)
@Serializable data class AuthenticationResult(val deviceId: String)
@Serializable data class ProtocolError(val reason: String)
@Serializable data class ControllerLeaseResult(
    val granted: Boolean,
    val deviceId: String,
    val reason: String? = null,
    val streamId: String? = null,
    val resumed: Boolean? = null,
    val connectionGeneration: String? = null,
    val streamRegistered: Boolean? = null
)

@Serializable
data class PairRequest(
    val action: String = "pairRequest",
    val requestId: String,
    val deviceId: String,
    val deviceName: String,
    val model: String,
    val pairingCode: String? = null,
    val protocolMajor: Int = ProtocolVersion.MAJOR,
    val protocolMinor: Int = ProtocolVersion.MINOR,
    val clientNonce: String? = null,
    val clientBuild: BuildIdentityPayload? = null
)

@Serializable
data class Authenticate(
    val action: String = "authenticate",
    val deviceId: String,
    val clientNonce: String,
    val timestampMs: Long,
    val proof: String,
    val protocolMajor: Int = ProtocolVersion.MAJOR,
    val protocolMinor: Int = ProtocolVersion.MINOR,
    val clientBuild: BuildIdentityPayload? = null,
    val cachedManuscriptHash: String? = null
)

@Serializable
data class AudioStreamStart(
    val action: String = "start",
    val streamId: String,
    val sampleRate: Int,
    val channels: Int = 1,
    val encoding: String = "pcm-s16le",
    val sequenceStart: Long,
    val captureTimestampMs: Long,
    val frameDurationMs: Int
)

@Serializable
data class AudioFrameMetadata(
    val streamId: String,
    val sequence: Long,
    val captureTimestampMs: Long,
    val sampleRate: Int,
    val channels: Int = 1,
    val encoding: String = "pcm-s16le",
    val sampleCount: Int,
    val flags: Int = 0
)

@Serializable data class AudioStreamStop(val action: String = "stop", val streamId: String, val lastSequence: Long, val captureTimestampMs: Long)
@Serializable data class RequestSnapshot(val action: String = "requestSnapshot")

@Serializable
data class ManualReposition(
    val action: String = "manualReposition",
    val manuscriptRevision: Long,
    val visibleTokenIndex: Int,
    val visibleCharacter: Int,
    val sentenceIndex: Int,
    val paragraphIndex: Int,
    val direction: String,
    val inputSource: String,
    val scrollContainer: String,
    val detectedAtMs: Long
)

@Serializable
data class ManualRepositionResult(
    val accepted: Boolean,
    val reason: String,
    val manuscriptRevision: Long,
    val visibleTokenIndex: Int,
    val sessionRevision: Long
)

@Serializable
data class ManualFollowDiagnostic(
    val action: String = "manualFollowDiagnostic",
    val timestampMs: Long,
    val sequence: Long,
    val level: String,
    val event: String,
    val message: String,
    val details: Map<String, String> = emptyMap()
)
