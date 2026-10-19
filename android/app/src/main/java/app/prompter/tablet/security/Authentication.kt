package app.prompter.tablet.security

import app.prompter.tablet.protocol.TabletRecoveryClaim
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object Authentication {
    fun proof(
        credential: String,
        challenge: String,
        clientNonce: String,
        serverId: String,
        deviceId: String,
        protocolMajor: Int,
        recoveryClaim: TabletRecoveryClaim? = null
    ): String {
        val values = mutableListOf<Any>(challenge, clientNonce, serverId, deviceId, protocolMajor)
        recoveryClaim?.let { values += recoveryClaimBinding(it) }
        val input = values.joinToString("|")
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(credential.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(input.toByteArray(Charsets.UTF_8)))
    }

    fun recoveryClaimBinding(claim: TabletRecoveryClaim): String = listOf(
        "recovery-v1", "${claim.manuscriptId.length}:${claim.manuscriptId}", claim.contentHash,
        claim.manuscriptRevision, claim.tokenIndex, claim.character, claim.sentenceIndex,
        claim.paragraphIndex, claim.anchorFingerprint, claim.capturedAtMs
    ).joinToString("|")
}
