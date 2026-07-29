package app.prompter.tablet

import android.Manifest
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.view.WindowCompat
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.prompter.tablet.ui.AppNavigation
import app.prompter.tablet.ui.MainViewModel
import app.prompter.tablet.ui.Screen

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()
    private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { viewModel.onMicrophonePermissionResult(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent {
            val state by viewModel.ui.collectAsStateWithLifecycle()
            LaunchedEffect(state.display.brightness) {
                window.attributes = window.attributes.apply { screenBrightness = state.display.brightness }
            }
            LaunchedEffect(state.screen) {
                val controller = WindowCompat.getInsetsController(window, window.decorView)
                if (state.screen == Screen.PROMPTER) {
                    controller.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
                    controller.systemBarsBehavior = androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                } else controller.show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            }
            AppNavigation(state, viewModel, onRequestMicrophonePermission = { microphonePermission.launch(Manifest.permission.RECORD_AUDIO) })
        }
    }

    override fun onStart() { super.onStart(); viewModel.onForeground("activity onStart") }
    override fun onResume() { super.onResume(); viewModel.onResume() }
    override fun onPause() { viewModel.onPause(); super.onPause() }
    override fun onStop() { viewModel.onBackground("activity onStop; app no longer visible"); super.onStop() }
}
