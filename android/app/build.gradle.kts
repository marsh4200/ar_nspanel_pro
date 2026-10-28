// AR NSPanel Pro — thin WebView kiosk around the panel UI.
//
// One library: AndroidX Media3 (ExoPlayer + RTSP) for RTSP cameras on the
// Elegant cameras page. The panel UI (custom_components/ar_nspanel_pro/www/app, built by
// panel/build.mjs) is copied into the APK as its offline copy.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing: the repo carries its own key (android/signing/release.jks)
// so every build — CI or local — is signed identically and updates install
// over the existing app. Env vars override it if you ever move to a private key.
val keystoreFile: String = System.getenv("ANDROID_KEYSTORE_FILE") ?: rootProject.file("signing/release.jks").path
val keystorePassword: String = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: "arsmarthome-nspanel-520638ad9142"
val keyAliasName: String = System.getenv("ANDROID_KEY_ALIAS") ?: "arpanel"
val keyPasswordValue: String = System.getenv("ANDROID_KEY_PASSWORD") ?: keystorePassword

android {
    namespace = "za.co.arsmarthome.nspanel"
    // 35: Media3 1.5+ needs it (targetSdk stays 34)
    compileSdk = 35

    defaultConfig {
        applicationId = "za.co.arsmarthome.nspanel"
        minSdk = 21 // per build below
        targetSdk = 34
        versionCode = (project.findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("versionName") as String?) ?: "1.0.0"
    }

    // Two APKs, same app id and key, same UI and protocol:
    //   standard: Android 7+, the system WebView         -> ar-nspanel-pro-X.Y.Z.apk
    //   legacy:   Android 5+, the UI runs in Chrome       -> ar-nspanel-pro-legacy-X.Y.Z.apk
    //             (Chrome 95), for panels whose WebView is too old (HDL S10 touch, Android 5.1)
    flavorDimensions += "engine"
    productFlavors {
        create("standard") {
            dimension = "engine"
            minSdk = 24
        }
        create("legacy") {
            dimension = "engine"
            minSdk = 21
            // UI shown by Chrome (installed separately): no engine bundled, no native code
        }
    }

    signingConfigs {
        create("release") {
            storeFile = file(keystoreFile)
            storePassword = keystorePassword
            keyAlias = keyAliasName
            keyPassword = keyPasswordValue
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
        // GeckoView's AndroidX dependencies may be built with a newer Kotlin
        freeCompilerArgs += listOf("-Xskip-metadata-version-check")
    }
}

dependencies {
    // RTSP cameras (Elegant cameras page): played natively, hardware decoding.
    // 1.5.1, not 1.4.1: 1.4.1 cuts the camera address at the first "@" of the
    // DECODED login, so a password with @ in it sent the stream to the wrong host
    // (androidx/media#1138, fixed in 1.5.0).
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-exoplayer-rtsp:1.5.1")

}

// Bundle the built panel UI as assets/app/ (the offline copy the app boots from).
val panelAssets = layout.buildDirectory.dir("generated/panelAssets")
val copyPanelUi by tasks.registering(Copy::class) {
    from(rootProject.file("../custom_components/ar_nspanel_pro/www/app"))
    into(panelAssets.map { it.dir("app") })
}
android.sourceSets.getByName("main").assets.srcDir(panelAssets)
tasks.named("preBuild") { dependsOn(copyPanelUi) }
