// AR NSPanel Pro — thin WebView kiosk around the panel UI.
//
// No AndroidX, no third-party libraries: the only dependency is the Kotlin
// stdlib. The panel UI (custom_components/ar_nspanel_pro/www/app, built by
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
    compileSdk = 34

    defaultConfig {
        applicationId = "za.co.arsmarthome.nspanel"
        minSdk = 24
        targetSdk = 34
        versionCode = (project.findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("versionName") as String?) ?: "1.0.0"
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
    }
}

// Bundle the built panel UI as assets/app/ (the offline copy the app boots from).
val panelAssets = layout.buildDirectory.dir("generated/panelAssets")
val copyPanelUi by tasks.registering(Copy::class) {
    from(rootProject.file("../custom_components/ar_nspanel_pro/www/app"))
    into(panelAssets.map { it.dir("app") })
}
android.sourceSets.getByName("main").assets.srcDir(panelAssets)
tasks.named("preBuild") { dependsOn(copyPanelUi) }
