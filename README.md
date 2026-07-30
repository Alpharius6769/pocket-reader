# Alpharius' Pocket Reader

Pocket Reader is an offline-capable story reader with browser-side Pocket TTS
narration and optional Supabase accounts.

## Architecture

- **Cloudflare Pages:** frontend and PWA shell (`https://pocket-reader-f2y.pages.dev`).
- **Supabase:** authentication, profiles, and account synchronization.
- **Hugging Face Space:** story search, scraping, uploads, curated-library API,
  FicHub relay, masterlist data, health endpoints, and push subscriptions.
- **Cloudflare Worker:** edge routing for Pocket TTS, ONNX Runtime Web, and
  Voice-Zero assets.
- **Backblaze B2:** origin storage for model bundles and voice assets.
- **Zyte API:** optional protected-source fetch path used by the backend.

Pocket TTS inference runs in the browser. Web Speech is the low-power fallback.
Story text, generated audio, model files, cookies, and hardware tuning remain
on the device.

## Verification

```powershell
node --test tests/*.test.mjs
node tools/verify_release_parity.mjs --live
```
