package app.prompter.tablet.security

import app.prompter.tablet.protocol.TabletRecoveryClaim
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class AuthenticationTest {
    @Test fun `proof matches Windows AuthenticationService vector`() {
        assertEquals(
            "52yPzQu88CfFyZw-Wqzb0jXkb1eR7jzlZ0iyFyg6KVs",
            Authentication.proof("credential-123", "challenge-abc", "nonce-xyz", "server-1", "android-device", 1)
        )
    }
    @Test fun `invalid credential cannot produce the compatible proof`() {
        assertNotEquals("52yPzQu88CfFyZw-Wqzb0jXkb1eR7jzlZ0iyFyg6KVs", Authentication.proof("wrong", "challenge-abc", "nonce-xyz", "server-1", "android-device", 1))
    }

    @Test fun `recovery claim is bound into the proof`() {
        val claim = TabletRecoveryClaim(
            manuscriptId = "book-1",
            contentHash = "sha256:" + "a".repeat(64),
            manuscriptRevision = 3,
            tokenIndex = 10,
            character = 42,
            sentenceIndex = 2,
            paragraphIndex = 1,
            anchorFingerprint = "sha256:" + "b".repeat(64),
            capturedAtMs = 99_000
        )
        assertEquals(
            "recovery-v1|6:book-1|${claim.contentHash}|3|10|42|2|1|${claim.anchorFingerprint}|99000",
            Authentication.recoveryClaimBinding(claim)
        )
        assertNotEquals(
            Authentication.proof("credential-123", "challenge-abc", "nonce-xyz", "server-1", "android-device", 1),
            Authentication.proof("credential-123", "challenge-abc", "nonce-xyz", "server-1", "android-device", 1, claim)
        )
        assertEquals(
            "rUKVQ9HiHOp2CMQJQyiwR0vYp4arc1BcQZC-_Bi78Gk",
            Authentication.proof("credential-123", "challenge-abc", "nonce-xyz", "server-1", "android-device", 1, claim)
        )
    }
}
