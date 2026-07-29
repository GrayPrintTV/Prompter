package app.prompter.tablet.connection

import kotlin.random.Random

class ReconnectPolicy(private val random: Random = Random.Default) {
    private val delays = longArrayOf(500, 1_000, 2_000, 4_000, 8_000, 15_000)
    fun delayMs(attempt: Int): Long {
        val base = delays[attempt.coerceIn(0, delays.lastIndex)]
        return (base * random.nextDouble(0.85, 1.15)).toLong().coerceAtLeast(250)
    }
}
