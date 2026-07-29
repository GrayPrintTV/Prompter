package app.prompter.tablet.settings

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.displayDataStore by preferencesDataStore("display_settings")

data class TabletDisplaySettings(
    val useWindowsDisplaySettings: Boolean = true,
    val fontSizeSp: Float = 36f,
    val lineSpacing: Float = 1.35f,
    val contentWidthFraction: Float = .70f,
    val alignment: String = "start",
    val readingBandPercent: Float = 38f,
    val darkTheme: Boolean = true,
    val brightness: Float = -1f
)

class DisplaySettingsStore(private val context: Context) {
    private object Keys {
        val useWindows = booleanPreferencesKey("use_windows_display_settings")
        val font = floatPreferencesKey("font_size"); val spacing = floatPreferencesKey("line_spacing")
        val width = floatPreferencesKey("content_width_fraction")
        val alignment = stringPreferencesKey("alignment"); val band = floatPreferencesKey("reading_band")
        val dark = booleanPreferencesKey("dark_theme"); val brightness = floatPreferencesKey("brightness")
    }
    val settings: Flow<TabletDisplaySettings> = context.displayDataStore.data.map { p -> TabletDisplaySettings(
        p[Keys.useWindows] ?: true, p[Keys.font] ?: 36f, p[Keys.spacing] ?: 1.35f, p[Keys.width] ?: .70f, p[Keys.alignment] ?: "start",
        p[Keys.band] ?: 38f, p[Keys.dark] ?: true, p[Keys.brightness] ?: -1f
    ) }
    suspend fun save(value: TabletDisplaySettings) { context.displayDataStore.edit { p ->
        p[Keys.useWindows] = value.useWindowsDisplaySettings; p[Keys.font] = value.fontSizeSp; p[Keys.spacing] = value.lineSpacing; p[Keys.width] = value.contentWidthFraction; p[Keys.alignment] = value.alignment
        p[Keys.band] = value.readingBandPercent; p[Keys.dark] = value.darkTheme; p[Keys.brightness] = value.brightness
    } }
}
