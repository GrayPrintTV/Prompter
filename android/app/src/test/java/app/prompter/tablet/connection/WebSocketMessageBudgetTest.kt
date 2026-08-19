package app.prompter.tablet.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WebSocketMessageBudgetTest {
    @Test fun `utf8 byte measurement avoids allocating a second byte array`() {
        assertEquals(5, WebSocketClient.utf8Length("hello"))
        assertEquals(2, WebSocketClient.utf8Length("é"))
        assertEquals(4, WebSocketClient.utf8Length("😀"))
        assertTrue(WebSocketClient.utf8Length("x".repeat(WebSocketClient.MAX_INBOUND_TEXT_BYTES + 1)) > WebSocketClient.MAX_INBOUND_TEXT_BYTES)
    }
}
