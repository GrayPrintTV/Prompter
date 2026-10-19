package app.prompter.tablet.connection

import app.prompter.tablet.security.Authentication
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class UsbEndpointContractTest {
    private fun extras(
        serverId: Any? = "server-123",
        port: Any? = 43128,
        mode: Any? = "auto"
    ) = listOf(
        UsbIntentExtra(UsbEndpointContract.EXTRA_SERVER_ID, serverId),
        UsbIntentExtra(UsbEndpointContract.EXTRA_PORT, port),
        UsbIntentExtra(UsbEndpointContract.EXTRA_MODE, mode)
    )

    @Test fun `typed API 26 compatible intent extras select loopback and preserve authentication identity`() {
        val endpoint = UsbEndpointContract.parse(UsbEndpointContract.ACTION, extras())
        val server = endpoint.discovered()
        assertEquals("ws://127.0.0.1:43128", server.endpoint)
        assertEquals("server-123", server.serverId)
        assertEquals("usb-adb-reverse", server.transport)
        assertTrue(isAllowedConnectionTarget(server))
        assertEquals(
            Authentication.proof("credential", "challenge", "client", server.serverId, "tablet", 1),
            Authentication.proof("credential", "challenge", "client", "server-123", "tablet", 1)
        )
    }

    @Test fun `rejects omitted duplicated and unknown extras`() {
        assertThrows(IllegalArgumentException::class.java) {
            UsbEndpointContract.parse(UsbEndpointContract.ACTION, extras().dropLast(1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            UsbEndpointContract.parse(
                UsbEndpointContract.ACTION,
                extras() + UsbIntentExtra(UsbEndpointContract.EXTRA_PORT, 1)
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            UsbEndpointContract.parse(
                UsbEndpointContract.ACTION,
                extras().dropLast(1) + UsbIntentExtra("unexpected", "value")
            )
        }
    }

    @Test fun `rejects malformed types ranges actions modes and hostile strings`() {
        val hostile = "server & space ' \" ; | ${'$'}() < >"
        val invalidContracts = listOf(
            Pair("wrong.action", extras()),
            Pair(UsbEndpointContract.ACTION, extras(serverId = hostile)),
            Pair(UsbEndpointContract.ACTION, extras(serverId = 42)),
            Pair(UsbEndpointContract.ACTION, extras(port = "43128")),
            Pair(UsbEndpointContract.ACTION, extras(port = 0)),
            Pair(UsbEndpointContract.ACTION, extras(port = 65_536)),
            Pair(UsbEndpointContract.ACTION, extras(mode = "maybe")),
            Pair(UsbEndpointContract.ACTION, extras(mode = 1))
        )
        invalidContracts.forEach { (action, values) ->
            assertThrows(IllegalArgumentException::class.java) {
                UsbEndpointContract.parse(action, values)
            }
        }
    }
}
