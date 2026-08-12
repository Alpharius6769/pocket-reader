---
title: Alpharius' Pocket Reader
colorFrom: blue
colorTo: purple
sdk: docker
python_version: '3.10'
app_file: app.py
pinned: false
license: other
license_name: pocket-reader-proprietary
license_link: LICENSE
short_description: Edge-routed audiobook reader with browser-side TTS.
---

# Alpharius' Pocket Reader

Pocket Reader is an offline-capable story reader with browser-side Pocket TTS narration and optional Supabase accounts.

## Architecture

- **GitHub Pages:** frontend and PWA shell (`https://alpharius6769.github.io/pocket-reader/`).
- **Supabase:** authentication, profiles, and account synchronization.
- **Hugging Face Space:** story search, scraping, uploads, curated-library API, FicHub relay, masterlist data, health endpoints, and push subscriptions.
- **Cloudflare Worker:** edge routing for Pocket TTS, ONNX Runtime Web, and Voice-Zero assets.
- **Backblaze B2:** origin storage for model bundles and voice assets.
- **Zyte API:** optional protected-source fetch path used by the backend.

Pocket TTS inference runs in the browser. Web Speech is the low-power fallback. Story text, generated audio, model files, cookies, and hardware tuning remain on the device.

## Verification

```powershell
node --test tests/*.test.mjs
node tools/verify_release_parity.mjs --live
```

## Backend API

FastAPI backend for the Pocket Reader web app. This Space is a lightweight I/O router: it searches and scrapes supported story sources, parses uploaded files, serves bundled curated PDFs, registers push subscriptions, and provides health and diagnostics endpoints.

No neural text-to-speech inference runs on this backend. Narration runs in the browser through Pocket TTS assets loaded by the frontend, with the browser's native Web Speech voices available as a fallback.
The shipped Pocket voice catalog is the Voice-Zero Emotional Pack: three male and three female CC0-positioned Voice-Zero voices with neutral, calm, happy, sad, worried, surprised, tired, frustrated, and optional high-intensity emotion references.

The frontend is hosted separately on Cloudflare Pages and talks to this backend through the Cloudflare Worker over HTTPS. Supabase provides authentication and the authenticated profile-sync bridge used by the web app. The unauthenticated FastAPI `/api/state/*` endpoints are intentionally disabled.
Cloud sync stores canonical JSON profile objects with schema version, sanitized library entries, settings, stats, and deletion tombstones.

### API Surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Basic health check |
| GET | `/api/health` | Backend liveness/config probe |
| GET | `/api/diag/logs` | Recent backend logs; requires `X-Admin-Secret` |
| POST | `/api/search` | Search AO3 using basic/advanced filters; returns paged results with `limit` defaulting to 15 |
| POST | `/api/scrape` | Fetch and parse a supported story URL |
| POST | `/api/upload` | Parse EPUB/PDF/DOCX/TXT/HTML upload |
| GET | `/api/masterlist` | Proxy/cache HMOFA masterlist CSV data |
| GET | `/api/library/curated` | List bundled curated PDFs |
| GET | `/api/library/curated/{filename}` | Parse a bundled curated PDF |
| GET | `/api/library/curated/{filename}/download` | Download a bundled curated PDF |
| GET | `/api/ao3` | AO3-specific EPUB/FicHub fetch and parse path |
| GET | `/api/ao3/chapter_count` | Published AO3 chapter count probe |
| GET | `/api/fichub-proxy` | Backend FicHub JSON proxy |
| GET | `/api/fetch-epub` | Backend FicHub EPUB relay |
| GET | `/api/health/sites` | Supported-source reachability probe |
| GET | `/api/vapid-public-key` | Public VAPID key for browser push setup |
| POST | `/api/subscribe` | Register a browser push subscription and explicit AO3 story-update subscriptions |
| POST | `/api/unsubscribe` | Remove a browser push subscription |
| POST | `/api/send-push/{user_id}` | Admin-only push delivery |
| POST | `/api/sync/chapters` | Admin-only throttled chapter-refresh sweep |
| POST | `/api/state/save` | Disabled; returns `410` |
| GET | `/api/state/load/{user_id}` | Disabled; returns `410` |

### Required Configuration

Set these in the Hugging Face Space settings.

Public variables:

- `VAPID_PUBLIC` - browser push public key.
- `ALLOWED_ORIGINS` - comma-separated exact frontend origins. Avoid `*` in production.

Secrets:

- `VAPID_PRIVATE` - browser push private key.
- `VAPID_SUB` - real contact URI for VAPID claims, for example `mailto:...`.
- `ADMIN_PUSH_SECRET` - required for `/api/send-push/{user_id}`, `/api/diag/logs`, and `/api/sync/chapters`.

Recommended:

- `SUBSCRIPTIONS_DB=/data/subscriptions.sqlite`

`/data` exists only when persistent storage is enabled on the Hugging Face Space. If the directory is unavailable, the backend falls back to an ephemeral SQLite file so the container can still boot, but push subscriptions will not survive redeploys/restarts.

Push update checks do not use the disabled public `/api/state/*` endpoints. The `pocket-reader-proxy` Cloudflare Worker invokes `/api/sync/chapters` at minutes 17 and 47 each hour. Its `ADMIN_PUSH_SECRET` Worker secret must match the Space secret; the secret is never sent to a browser.
When browser push is enabled, `/api/subscribe` stores only explicitly subscribed AO3 story titles, URLs, stable keys, and chapter-count snapshots needed by the admin-only chapter sweep.

Optional scraping/model routing:

- `WORKER_PROXY_BASE` - Cloudflare Worker proxy base URL.
- `ZYTE_API_KEY` - optional Zyte smart-proxy key for Cloudflare-heavy sources.
- `FICHUB_TOKEN` - optional FicHub bearer token for datacenter-IP access.
- `FICHUB_USER_AGENT` - custom FicHub user-agent/contact string.

### Maintainer Tools

- `tools/build_voice_zero_pack.py` audits, downloads, and optionally converts the curated Voice-Zero emotional voice pack into upload-ready Pocket TTS `.safetensors` files. Use `--convert --output <dir>` after installing the optional Pocket conversion dependencies, then upload the generated files to the Cloudflare/B2 voice asset path as `/models/voices/{voice}_{emotion}.safetensors`.
- `tools/convert_pocket_voice.py` converts local voice samples into Pocket TTS `.safetensors` conditioning files. It is not runtime app code. Optional dependencies are documented in the script header.

### Operational Notes

- Curated-library responses are sanitized server-side before listing, fetching, or downloading bundled PDFs.
- The browser service worker uses network-first caching for theme JS/CSS so deployed UI fixes replace stale app code quickly. Large visual/model assets remain cache-friendly.
- Browser-reported device data is approximate by design. A PWA does not unlock exact RAM, CPU, GPU, or thermal telemetry; exact hardware telemetry requires a native wrapper.

Optional tuning:

- `MAX_FETCH_BYTES`
- `MAX_UPLOAD_BYTES`
- `MAX_EPUB_BYTES`
- `MAX_REDIRECTS`
- `SCRAPER_TIMEOUT`
- `SEARCH_NEGATIVE_TTL_SECONDS`
- `SEARCH_OVERLOAD_TTL_SECONDS`
- `SEARCH_POSITIVE_TTL_SECONDS` - cache TTL for result-bearing searches (default 1800)
- `AO3_MAX_CONCURRENCY` - max concurrent AO3-bound requests across all users (default 2)
- `AO3_429_STREAK_THRESHOLD` - consecutive AO3 429s before Zyte failover (default 3)
- `AO3_ZYTE_COOLDOWN_SEC` - how long AO3 traffic stays routed via Zyte after failover (default 600)
- `SYNC_MIN_INTERVAL_SEC`
- `SYNC_MAX_STORIES_PER_SWEEP`
- `RR_CHAPTER_DELAY`

All users' AO3 traffic egresses from this backend's (or the worker's) IP, so AO3 sees the whole userbase as one client. The AO3 politeness gate in `scrapers_core.py` serializes AO3-bound requests and, after a streak of 429s, temporarily routes AO3 fetches through Zyte's rotating IPs.

## Licensing Summary

This repository contains multiple categories of works:

- Code authored for Pocket Reader is proprietary, all rights reserved. No license to reuse, redistribute, or self-host is granted. See `LICENSE` and `NOTICE`. Versions published before 2026-07-26 were Apache-2.0; that grant remains valid for those versions only.
- The Virtue character, her artwork, dialogue, lore, and Pocket Reader branding are proprietary creative works owned by Chris (Alpharius67 / Fluffarius), all rights reserved. See `CHARACTER_LICENSE.md`.
- Third-party libraries, models, services, icons, and story-source platforms retain their own licenses and terms. See `ATTRIBUTIONS.md`.
- Story content belongs entirely to its original authors. Pocket Reader claims no ownership over any fetched, uploaded, listed, or bundled story content.

This README is an engineering summary, not legal advice.
