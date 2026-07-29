package app.prompter.tablet

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test

class MainActivityTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()
    @Test fun launchesNativeConnectionScreen() { rule.onNodeWithText("Prompter Tablet").assertIsDisplayed() }
}
