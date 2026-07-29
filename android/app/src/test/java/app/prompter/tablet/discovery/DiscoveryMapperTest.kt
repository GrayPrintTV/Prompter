package app.prompter.tablet.discovery

import org.junit.Assert.*
import org.junit.Test

class DiscoveryMapperTest {
    @Test fun `maps TXT metadata and stable identity independently of duplicate names`() {
        val first = DiscoveryMapper.map("Prompter - PC", "192.168.1.2", 43127, mapOf("serverId" to "stable-a", "protocolMajor" to "1", "protocolMinor" to "0", "pairing" to "1"))
        val second = DiscoveryMapper.map("Prompter - PC", "192.168.1.9", 43127, mapOf("serverId" to "stable-b", "protocolMajor" to "1"))
        assertEquals("stable-a", first.serverId)
        assertTrue(first.pairingAvailable)
        assertNotEquals(first.serverId, second.serverId)
    }
    @Test fun `same server identity accepts DHCP address update`() {
        val old = DiscoveryMapper.map("Prompter", "192.168.1.2", 43127, mapOf("serverId" to "server"))
        val updated = DiscoveryMapper.map("Prompter", "192.168.1.44", 43127, mapOf("serverId" to "server"))
        assertEquals(old.serverId, updated.serverId)
        assertNotEquals(old.host, updated.host)
    }
    @Test fun `manual fallback has expected endpoint`() {
        assertEquals("ws://192.168.1.8:43127", DiscoveredServer("manual", "Manual", "192.168.1.8", 43127, 1, 0, true, manual = true).endpoint)
    }
}
