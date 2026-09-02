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

### 4. Inject the proxy key

The bundled app is served from `https://localhost`, and the Cloudflare Worker
cannot treat that origin as proof of anything -- any non-browser caller can send
the same header. The public model assets (`/models/`, `/ggml/`) are reachable
without it, so narration works unkeyed, but the routes that attach the Worker's
own credentials refuse an unkeyed build:

| Route | Unkeyed native build |
|---|---|
| `/models/`, `/ggml/`, `/backup/` | works -- public B2 assets, no credential attached |
| `/api/*` (story search, scrape, upload, sync) | **403** |
| `/catalog-api/*` (shared ratings, click tracking) | **403** |
| `/?url=` (AO3 / FicHub fetch) | **403** |

Generate a token, set it on the Worker, and inject the same value into the
assets `cap sync` copied:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```bash
npx wrangler secret put APP_PROXY_TOKEN --config worker/wrangler.toml
```

```bash
npx cap sync android && node tools/inject_native_app_key.mjs --key "$APP_PROXY_TOKEN"
```

Verify before building: `node tools/inject_native_app_key.mjs --check`

**Re-run the injector after every `npx cap sync`** -- sync overwrites the copied
assets with the empty-keyed `public/` original.

> **What this key is and is not.** It ships inside the APK, so anyone holding
> the binary can extract it. It raises the cost of abuse from "send an Origin
> header" to "unpack a build" -- it is not a secret, and nothing that must stay
> secret may rest on it. It is intentionally a *different* token from
> `PROXY_AUTH_TOKEN` so a leak is rotated on its own and never confers the
> backend's identity. The injector refuses to write into `public/`, which ships
> verbatim to GitHub Pages.

### 5. Build the APK / Open in Android Studio
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
2. Inject the proxy key (same rationale and caveats as Android step 4):
   ```bash
   node tools/inject_native_app_key.mjs --key "$APP_PROXY_TOKEN"
   ```
3. Open in Xcode:
   ```bash
   npx cap open ios
   ```
4. In Xcode $\rightarrow$ **App Target** $\rightarrow$ **Signing & Capabilities**:
   - Click `+ Capability` $\rightarrow$ **Background Modes**.
   - Check **Audio, AirPlay, and Picture in Picture**.
   - Check **Background fetch** and **Background processing**.
5. Connect your iPhone and click **Run** (Cmd + R) or build for TestFlight/App Store.

---

## Testing Native Background Execution

Once installed on your phone:
1. Open a story.
2. Hit Play or Start Away Mode.
3. Lock your phone screen or switch to another app.
4. Because the native media service and wake lock are active at the OS level, playback and synthesis will continue 24/7 without being stopped by mobile power managers.
