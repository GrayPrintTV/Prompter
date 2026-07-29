package app.prompter.tablet.security

import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object Authentication {
    fun proof(credential: String, challenge: String, clientNonce: String, serverId: String, deviceId: String, protocolMajor: Int): String {
        val input = listOf(challenge, clientNonce, serverId, deviceId, protocolMajor).joinToString("|")
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(credential.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(input.toByteArray(Charsets.UTF_8)))
    }
}
