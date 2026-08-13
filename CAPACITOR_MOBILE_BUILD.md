# Pocket Reader — Native Mobile Build Guide (Capacitor)

This guide details how to compile Pocket Reader into a native **Android (APK/AAB)** and **iOS** application using **Capacitor**.

Packaging as a native app grants direct operating-system permissions:
- **Android Foreground Service (`FOREGROUND_SERVICE_MEDIA_PLAYBACK`)** — keeps the process running with highest priority in the background.
- **Native WakeLock (`WAKE_LOCK`)** — prevents CPU throttling during screen-off AI synthesis.
- **24/7 Background Neural Audio Caching** — allows the TTS worker to continue running continuously even when minimized or screen-locked.

---

## Prerequisites

1. **Node.js** (v18 or newer)
2. **Android Studio** (for Android APK builds) with Android SDK 33+
3. **Xcode** (for iOS builds, macOS required)

---

## Step-by-Step Android Build

### 1. Initialize Capacitor Android Project
In the root of the Pocket Reader workspace, run:
```bash
npm install
npx cap add android
npx cap sync
```

### 2. Configure Android Permissions for Background Audio & Compute
Open `android/app/src/main/AndroidManifest.xml` and ensure the following permissions are present inside the `<manifest>` tag:

```xml
<!-- Network & Offline Storage -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

<!-- Background Keep-Alive & Wake Lock -->
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />

<!-- Audio Output & Notifications -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

### 3. Enable Hardware Acceleration & Audio Streaming in Webview
In `android/app/src/main/AndroidManifest.xml`, inside `<application>`:
```xml
<application
    android:hardwareAccelerated="true"
    android:usesCleartextTraffic="true"
    android:name=".MainActivity" ... >
```

### 4. Build the APK / Open in Android Studio
```bash
npx cap sync android
npx cap open android
```
In Android Studio:
1. Select **Build** $\rightarrow$ **Build Bundle(s) / APK(s)** $\rightarrow$ **Build APK(s)**.
2. The generated debug APK will be located in:
   `android/app/build/outputs/apk/debug/app-debug.apk`
3. Transfer and install this APK directly onto your **Pixel 6 Pro** or any Android device.

---

## Step-by-Step iOS Build (Mac)

1. Add iOS platform:
   ```bash
   npx cap add ios
   npx cap sync ios
   ```
2. Open in Xcode:
   ```bash
   npx cap open ios
   ```
3. In Xcode $\rightarrow$ **App Target** $\rightarrow$ **Signing & Capabilities**:
   - Click `+ Capability` $\rightarrow$ **Background Modes**.
   - Check **Audio, AirPlay, and Picture in Picture**.
   - Check **Background fetch** and **Background processing**.
4. Connect your iPhone and click **Run** (Cmd + R) or build for TestFlight/App Store.

---

## Testing Native Background Execution

Once installed on your phone:
1. Open a story.
2. Hit Play or Start Away Mode.
3. Lock your phone screen or switch to another app.
4. Because the native media service and wake lock are active at the OS level, playback and synthesis will continue 24/7 without being stopped by mobile power managers.
