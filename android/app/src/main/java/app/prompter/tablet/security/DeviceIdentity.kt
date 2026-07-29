package app.prompter.tablet.security

import android.content.Context
import androidx.core.content.edit
import java.util.UUID

class DeviceIdentity(context: Context) {
    val deviceId: String = run {
        val preferences = context.getSharedPreferences("device-identity", Context.MODE_PRIVATE)
        preferences.getString("device_id", null) ?: run {
            "android-${UUID.randomUUID()}".also {
                preferences.edit { putString("device_id", it) }
            }
        }
    }
}
