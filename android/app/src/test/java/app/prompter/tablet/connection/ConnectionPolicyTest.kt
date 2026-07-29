package app.prompter.tablet.connection

import kotlin.random.Random
import org.junit.Assert.*
import org.junit.Test

class ConnectionPolicyTest {
    @Test fun `backoff is bounded and jittered`() {
        val policy = ReconnectPolicy(Random(1))
        assertTrue(policy.delayMs(0) in 425..575)
        assertTrue(policy.delayMs(100) in 12_750..17_250)
    }
    @Test fun `cleartext connections reject public addresses`() {
        PrompterConnectionRepository.requirePrivateIpv4("192.168.1.2")
        assertThrows(IllegalArgumentException::class.java) { PrompterConnectionRepository.requirePrivateIpv4("8.8.8.8") }
    }
}
