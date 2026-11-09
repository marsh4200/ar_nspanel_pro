# USB setup (panels with USB debugging only)

For panels like the **HDL S10 touch**, where only USB debugging is available and Home
Assistant can't reach ADB over the network. You plug in a laptop once. After that, Home
Assistant updates the app over MQTT, with no cable and no ADB.

## What you need

- A laptop with **Android SDK Platform-Tools** (`adb`). On Windows, unzip
  [platform-tools](https://developer.android.com/tools/releases/platform-tools) into a
  `platform-tools` folder next to these scripts. You don't need to install anything else.
- A USB cable to the panel, with USB debugging switched on in the panel's Developer options.
- Optional: the APK (`ar-nspanel-pro-X.Y.Z.apk`) in this folder. If it isn't there, the script
  downloads the latest release from GitHub.

The scripts pick the right APK from the panel's Android version: Android 7+ gets
`ar-nspanel-pro-X.Y.Z.apk`, Android 5–6 gets `ar-nspanel-pro-legacy-X.Y.Z.apk`.

**Installing from a USB memory stick instead** (the panel's USB port only takes a stick): copy
the right APK onto the stick, open it on the panel and tap Install, allowing "Unknown sources"
if Android asks. Then the first time you press Install in Home Assistant, the panel opens
"Install unknown apps" for AR NSPanel Pro: switch it on once. On Android 5 there is no such
switch; "Unknown sources" covers it. Updates then ask for one tap on the panel.

## HDL S57

The S57 (5.7" portrait, Android 6.0.1) is found by itself: its HDL software is **WallApp**.
Its own browser engine is too old for the panel screen, so the screen runs in **Chrome**.

- Put **Chrome 106** next to these scripts as `chrome106.apk`: from APKMirror, choose the
  *arm64-v8a*, *Android 6.0+* build, as a plain APK (not a bundle, and not Trichrome). The
  scripts install it if it isn't on the panel yet. Chrome 106 is the last version for Android 6.
- `install.bat` leaves WallApp in charge. The AR app is installed, but it doesn't open itself at boot.
- `takeover.bat` switches WallApp and the stock launcher off. That leaves the AR app as the only
  Home app (Android 6 can't choose one any other way), so it opens at boot, full screen, with
  the navigation bar hidden.
- `restore.bat` switches WallApp and the launcher back on, and WallApp opens again.
- ADB on the S57 runs as root, so network ADB on port 5555 stays on after reboots. Home Assistant's
  Setup tool (panel type **HDL S57**) can then do installs, updates, "Use AR app (HDL off)" and
  "Back to HDL screen" over the network. Keep the panel on a trusted network: anyone on it
  can reach ADB.

## Run it

| Windows (double-click) | Mac / Linux | What it does |
|---|---|---|
| `install.bat` | `./ar-panel-usb.sh` | Installs or updates the app and sets it up for updates without ADB. HDL's screen stays. |
| `takeover.bat` | `./ar-panel-usb.sh --takeover` | Same, then switches HDL's app and launcher off and makes ours the Home screen. |
| `restore.bat` | `./ar-panel-usb.sh --restore` | Turns HDL's screen back on. The app stays installed. |
| `uninstall.bat` | `./ar-panel-usb.sh --uninstall` | Turns HDL's screen back on and removes the app. |

The first time, the panel asks **"Allow USB debugging?"**. Tick *Always allow* and tap *Allow*.

## What it sets up

1. `adb install -r -d -g` installs the APK and grants the runtime permissions (microphone,
   location for the Wi-Fi scan).
2. It lets the app **install its own updates**: the `REQUEST_INSTALL_PACKAGES` app-op, and the
   app becomes its own installer of record, so updates are silent on Android 12+.
3. It makes the app **device owner**, without the kiosk lock. Updates are then silent on any
   Android version, and nobody has to tap anything. Android only allows this when no account
   (Google etc.) is signed in on the panel. If it refuses, updates still work, but Android asks
   once on the panel screen and someone taps *Update*. Use `--no-owner` to skip this step and
   `--kiosk` to also lock the panel in.
4. It grants `WRITE_SECURE_SETTINGS`, so the app keeps USB debugging switched on, and lets the
   app start itself after a reboot or an update.
5. It switches on network ADB (port 5555) for Home Assistant's Setup/Update tools. Without root
   on the panel, this lasts only until the next reboot. **Updates don't need it.** Use
   `--no-tcpip` to skip this step.

## Afterwards

1. On the panel's setup screen, enter the broker (`ws://<home-assistant>:1884`) and a Panel ID.
2. Add the panel in Home Assistant as usual.
3. New versions show under **Settings → Updates → *<panel>* App**. Press *Install*. The
   entity's `install_mode` attribute tells you whether the install is `silent` or needs a
   `prompt` tap on the panel.

## If something goes wrong

- **"signatures do not match"**: another build of the app is installed. Run `uninstall` first.
  This wipes the app's settings.
- **The device owner step is refused because of an account**: remove the account under
  Settings → Accounts and run `install` again.
- **Removing the app later**: run `uninstall`. A device-owner app can't be removed from Android's
  Settings, so the script releases device owner first.
