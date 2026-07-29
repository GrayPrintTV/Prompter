package app.prompter.tablet.protocol

object ProtocolVersion {
    const val MAJOR = 1
    const val MINOR = 2

    fun requireCompatible(major: Int, minor: Int): Int {
        require(major == MAJOR) { "Unsupported protocol major $major; expected $MAJOR." }
        return minOf(MINOR, minor)
    }
}
