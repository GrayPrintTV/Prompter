package app.prompter.tablet.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MicrophonePermissionStatusTest {
    @Test fun `granted permission clears only the resolved denial`() {
        assertEquals(MICROPHONE_PERMISSION_DENIED_ERROR, permissionErrorAfterResult(false, null))
        assertNull(permissionErrorAfterResult(true, MICROPHONE_PERMISSION_DENIED_ERROR))
        assertEquals("Audio device unavailable", permissionErrorAfterResult(true, "Audio device unavailable"))
    }
}
