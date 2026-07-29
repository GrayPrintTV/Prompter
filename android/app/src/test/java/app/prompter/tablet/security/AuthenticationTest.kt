package app.prompter.tablet.security

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
}
