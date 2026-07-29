package app.prompter.tablet

import app.prompter.tablet.protocol.BuildIdentityPayload
import app.prompter.tablet.protocol.ProtocolVersion

object AppBuildIdentity {
    val payload: BuildIdentityPayload
        get() = BuildIdentityPayload(
            versionName = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE,
            buildTimestamp = BuildConfig.BUILD_TIMESTAMP,
            gitHash = BuildConfig.GIT_HASH,
            dirty = BuildConfig.GIT_DIRTY,
            protocolMajor = ProtocolVersion.MAJOR,
            protocolMinor = ProtocolVersion.MINOR
        )

    fun summary(): String = with(payload) {
        "$versionName ($versionCode), build $buildTimestamp, git $gitHash${if (dirty == true) "-dirty" else ""}, protocol $protocolMajor.$protocolMinor"
    }
}
