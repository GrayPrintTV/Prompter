import java.time.Instant

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

val repositoryRoot = rootProject.projectDir.resolve("..")
val buildTimestamp = providers.environmentVariable("PROMPTER_ANDROID_BUILD_TIMESTAMP")
    .getOrElse(Instant.now().toString())
val buildGitHash = providers.environmentVariable("PROMPTER_ANDROID_GIT_HASH").orElse(
    providers.exec {
        workingDir(repositoryRoot)
        commandLine("git", "rev-parse", "--short=12", "HEAD")
    }.standardOutput.asText.map { it.trim().ifBlank { "unavailable" } }
).get()
val buildDirty = providers.environmentVariable("PROMPTER_ANDROID_GIT_DIRTY").orElse(
    providers.exec {
        workingDir(repositoryRoot)
        commandLine("git", "status", "--porcelain")
    }.standardOutput.asText.map { it.trim().isNotBlank().toString() }
).get().toBoolean()

android {
    namespace = "app.prompter.tablet"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.prompter.tablet"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
        buildConfigField("String", "BUILD_TIMESTAMP", "\"$buildTimestamp\"")
        buildConfigField("String", "GIT_HASH", "\"$buildGitHash\"")
        buildConfigField("boolean", "GIT_DIRTY", buildDirty.toString())
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging.resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    testOptions.unitTests.isIncludeAndroidResources = true
}

val syncProtocolFixtures by tasks.registering(Copy::class) {
    from(rootProject.projectDir.resolve("../shared/protocol/fixtures"))
    into(layout.buildDirectory.dir("generated/test-resources/protocol"))
}
android.sourceSets["test"].resources.srcDir(layout.buildDirectory.dir("generated/test-resources").get().asFile)
tasks.withType<Test>().configureEach { dependsOn(syncProtocolFixtures) }
tasks.matching { it.name == "processDebugUnitTestJavaRes" }.configureEach { dependsOn(syncProtocolFixtures) }

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.06.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-process:2.9.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.navigation:navigation-compose:2.9.8")
    implementation("androidx.datastore:datastore-preferences:1.2.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:5.4.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("com.squareup.okhttp3:mockwebserver3:5.4.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
