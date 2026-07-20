# Alpharius' Pocket Reader - Anvil Frontend

This repository is the Anvil frontend, account service, and profile-sync layer
for Alpharius' Pocket Reader. The app is an offline-capable story reader with
browser-side Pocket TTS narration and an optional private account.

## Architecture

- **Anvil Works:** frontend hosting, Google/email authentication, profile data,
  media avatars, server callables, and the service-worker endpoint.
- **Hugging Face Space:** story search, scraping, uploads, curated-library API,
  FicHub relay, masterlist data, health endpoints, and push subscriptions.
- **Cloudflare Worker:** edge routing for Pocket TTS model, ONNX Runtime Web,
  and Voice-Zero voice assets.
- **Backblaze B2:** origin storage for ONNX model bundles and Voice-Zero voice
  states. Runtime model assets are not committed to this repository.
- **Zyte API:** optional protected-source fetch path used by the HF backend.

Pocket TTS inference runs in the browser. Web Speech is the low-power fallback.
Story text, generated audio, model files, cookies, and hardware-specific tuning
remain on the device.

The default visual theme is displayed in the app as **Anthrostate**. The
internal design direction is called Midnight Theater; it is a UI design name,
not a separate product or license.

Eligible devices calibrate threaded INT8 WASM against the certified R3 FP16
WebGPU core using ONNX Runtime Web 1.27.0. Auto mode selects WebGPU only for a stable full-pipeline win. GPU
readbacks are grouped after first audio; graph capture and the FP16 Mimi decoder
are benchmark-gated independently and fall back without disabling narration.

## Account and Sync

Anvil Users is the authentication authority. The checked-in configuration
enables Google OAuth, email/password signup, email confirmation, password reset,
and remembered sessions. Guest use remains available.

`sync_user_profile(profile, base_revision, device_id)` stores schema-v3 profiles
and returns the canonical merged profile. The callable runs in an Anvil
serializable Data Table transaction, so conflicting device writes are retried
instead of overwriting one another. The merge model includes:

- per-field clocks for profile and synced preferences;
- per-story clocks for metadata, progress, favorite state, rating, bookmarks,
  narration presets, and collection membership;
- bookmark IDs and deletion tombstones;
- story deletion tombstones;
- achievement union with earliest unlock times;
- per-device monotonic statistics and dated activity counters;
- collections, reading queue, history, goals, and recap data.

The browser keeps one coalesced IndexedDB outbox entry and retries failed syncs
with exponential backoff. Playback progress is saved locally every paragraph
and cloud-checkpointed periodically.

Avatars are normalized client-side to a maximum 512px WebP and approximately
256 KB, then stored separately in the server-only `avatar_media` column.

## Main Modules

- `client_code/FrontEnd/__init__.py` - Anvil/JavaScript authentication bridge.
- `server_code/Server_code.py` - schema-v3 merge, avatar, legacy wrappers, and
  account-data deletion.
- `server_code/serviceworker.py` - versioned offline shell and asset caching.
- `theme/assets/sync_core.js` - migration, outbox, canonical profile handling.
- `theme/assets/reader_features.js` - queue, collections, history, bookmark
  notes, story presets, goals, recaps, and storage surfaces.
- `theme/assets/cinematic_ui.js` - Midnight Theater interface, account center,
  responsive reader drawers, motion policy, and settings navigation.
- `theme/assets/experience_coordinator.js` - priority queue for achievements,
  Virtue, notices, and blocking dialogs.
- `theme/assets/audio_core.js` - Pocket TTS generation, emotion routing,
  artifact guard, playback, and progress checkpoints.

## Local Assets and Licenses

The frontend bundles a small Lucide SVG sprite, Literata, and IBM Plex Sans.
Lucide is ISC licensed. Both font families are distributed under the SIL Open
Font License 1.1. Virtue art, dialogue, character identity, Pocket Reader
branding, and project-owned navigation art are proprietary and are not covered
by the source-code license. Story rights remain with their authors.

See the backend repository's `LICENSE`, `NOTICE`, `CHARACTER_LICENSE.md`, and
`ATTRIBUTIONS.md` for the complete project-wide licensing inventory.

## Deployment Checklist

1. Run JavaScript syntax checks and Python compile checks.
2. Validate the Anvil app checkout with the Anvil CLI.
3. Confirm the `user_profiles` table has `revision`, `updated_at`,
   `avatar_media`, and `avatar_hash` columns.
4. Push to the Anvil Git remote and publish the intended commit.
5. Verify every versioned asset URL, service-worker version, first-run setup,
   Google/email login form, and schema-v3 sync on the published domain.

Do not run destructive profile migrations without first exporting the Anvil
Users and user_profiles tables.
