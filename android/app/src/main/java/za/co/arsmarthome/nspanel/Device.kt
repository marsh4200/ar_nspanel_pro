package za.co.arsmarthome.nspanel

import android.os.Build

/**
 * Recognised panel hardware.
 *
 * ADDITIVE ONLY. This object exists so a consumer tablet pressed into service
 * as a panel can be *recognised* and given tablet-friendly defaults. It must
 * never change behaviour on the purpose-built panels (Sonoff NSPanel Pro, the
 * Akubela/Akuvox PHX1, the HDL Source 7 / Source 10): every property here is
 * false / null on those, so the existing code paths run exactly as before.
 *
 * The vendor-specific layers (AkuOff, BootTweaks) gate themselves on root
 * (`/system/xbin/su`), which a stock Samsung tablet does not have, so they are
 * already automatic no-ops here — nothing in those files is touched.
 */
object Device {

    /**
     * Samsung Galaxy Tab A7 Lite — `SM-T220` (Wi-Fi) and `SM-T225` (LTE).
     * Both report manufacturer "samsung". Matched on the model prefix so a
     * regional variant suffix (e.g. `SM-T220N`) still counts.
     */
    val isGalaxyTabA7Lite: Boolean by lazy {
        (Build.MANUFACTURER ?: "").equals("samsung", ignoreCase = true) &&
            Regex("^SM-T22[05]").containsMatchIn(Build.MODEL ?: "")
    }

    /**
     * A general-purpose Android tablet acting as a panel, as opposed to a
     * wall-panel appliance. Today that is only the Tab A7 Lite; add future
     * tablets here so the rest of the app needs no new branches.
     */
    val isTabletPanel: Boolean
        get() = isGalaxyTabA7Lite

    /**
     * Short hardware tag reported to Home Assistant in `sys/info` so the setup
     * screen can name the panel. Null on every existing device, which keeps
     * their info payload byte-for-byte unchanged.
     */
    val hardwareTag: String?
        get() = when {
            isGalaxyTabA7Lite -> "galaxy_tab_a7_lite"
            else -> null
        }
}
