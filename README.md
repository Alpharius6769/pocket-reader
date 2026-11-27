# Alpharius' Pocket Reader

Pocket Reader is a phone-first story reader that narrates in the browser. Stories, generated audio, model files, and settings stay on the device. There are no accounts and no cloud profile.

This is the v2 rebuild: a Svelte 5 interface in `web/` running on the existing narration cores in `public/assets/js/`. It is what GitHub Pages serves. A separate preview deployment at `https://pocket-reader-next.alpharius67.workers.dev` is used to try a build before it reaches `main`.

## The app

Five tabs: **Home**, **Library**, **Player**, **Discover**, and **Settings**.

- **Home** resumes the current story at its saved chapter and paragraph.
- **Library** holds saved stories with favourites, ratings, bookmarks, and per-story new-chapter alerts.
- **Player** has a listening view and a reading view, chapters, bookmarks, a voice picker, playback speed, and a sleep timer. Play unlocks once the next ten paragraphs are rendered, so narration does not start and then stall.
- **Discover** has three sources: AO3 search with filters, the Anthronomicon catalog, and file import (EPUB, PDF, DOCX, TXT, HTML).
- **Settings** covers narration, pronunciation rules, appearance, the Virtue companion, notifications, storage, and backup and restore to a local `.prbackup` file.

Removed in v2: Away mode, accounts, sign-in and cloud sync, the Kitten engine, and the in-app curated shelf. `web/src/App.test.ts` fails if Away mode, accounts, or Kitten reappear in the interface.

## Narration

Narration runs on the device through ONNX Runtime Web. No speech is synthesised on a server.

| Engine | Model | Voices |
| --- | --- | --- |
| Pocket | Kyutai Pocket TTS (`english_2026-10`), autoregressive, CC BY 4.0 | Alba, Mary, Eve / Charles, George, Paul |
| Kokoro | Kokoro-82M, one 86 MB session, Apache-2.0 | Heart, Bella, Emma / Michael, Fenrir, Puck |

Each engine ships three female and three male voices. Alba is voice-acted by Alba MacKenna; the other five Pocket voices are VCTK corpus speakers republished by Kyutai. Paul is the default Pocket voice. Noah has no `english_2026-10` embedding, so a stored setting naming Noah migrates to Paul; other retired voice ids migrate to a live voice of the same gender.

The engine is chosen per device by a measured memory-headroom probe and can be changed in Settings. The interface offers Pocket and Kokoro. The cores keep the device's own speech voice as the bottom rung, so a phone that cannot safely build a Kokoro session steps down to it instead of crashing the tab.

Starting narration reloads the app with `?tts_fast=1`. The service worker serves that session with cross-origin isolation headers, which enables SharedArrayBuffer and threaded WebAssembly.

## Architecture

- **GitHub Pages:** the built app and PWA shell (`https://alpharius6769.github.io/pocket-reader/`). `npm run build` bundles `web/` into `dist/` and copies `public/` in unbundled.
- **Cloudflare Worker (`pocket-reader-proxy`):** the host the app talks to. It serves the model bundles, ONNX Runtime Web, and voice assets, forwards `/api/*` to the backend, re-origins the Anthronomicon community routes at `/catalog-api/*`, and runs the scheduled chapter-refresh sweep.
- **Hugging Face Space:** FastAPI backend for story search, scraping, upload parsing, FicHub relay, health endpoints, and push subscriptions.
- **Backblaze B2:** origin storage for model bundles and voice assets.
- **HMOFA Anthronomicon & Masterlist:** story catalog (`https://alpharius6769.github.io/hmofa-story-index/`) authored by Chris (Alpharius67 / Fluffarius). Pocket Reader renders it natively from the index's published catalog JSON. The standalone site is unaffected. See `ANTHRONOMICON_BRIDGE.md`.
- **Zyte API:** optional protected-source fetch path used by the backend.
- **Capacitor:** optional native Android and iOS wrapper around `dist/`. See `CAPACITOR_MOBILE_BUILD.md`.

## Repository layout

| Path | Contents |
| --- | --- |
| `web/` | v2 interface: Svelte 5, TypeScript, Vite. `web/src/lib/core/bridge.ts` is the only seam to the cores. See `web/README.md`. |
| `public/` | Narration cores, workers, service worker, fonts, icons, and Virtue sprites. Copied into `dist/` as-is. |
| `backend/` | FastAPI app, scrapers, parsers, and the Space `Dockerfile`. |
| `worker/` | Cloudflare Worker source and `wrangler.toml`. |
| `preview/` | Wrangler config for the v2 preview deployment. |
| `tests/` | Node test suites, backend regression suites, and browser smoke tests. |
| `tools/` | Benchmarks, model build and upload scripts, and release checks. |

## Development

CI builds with Node 22.

```powershell
npm install
```

```powershell
npm run dev
```

The dev server runs at <http://localhost:5180> on the real cores. Add `?mock=1` for sample data.

To serve the production build instead, run `npm run build` and then `node tools/serve_public.mjs 4173`, which serves `dist/`. Pass `--local-services` to use FastAPI on port 8097 and a local Worker on port 8787.

## Verification

CI (`.github/workflows/test.yml`) runs these, then the backend regression suites and the Chromium and WebKit smoke tests:

```powershell
node --test tests/*.test.mjs
```

```powershell
node tools/check_module_versions.mjs
```

```powershell
node tools/verify_release_parity.mjs
```

```powershell
npm run check:ui
```

```powershell
npm run test:ui
```

```powershell
npm run build
```

## Deployment

- **Frontend:** a push to `main` runs the tests and, if they pass, builds `dist/` and publishes it to GitHub Pages.
- **Backend:** `.github/workflows/deploy-backend.yml` deploys `backend/` to the Hugging Face Space.
- **Worker:** not deployed by a push. Run `wrangler deploy` from `worker/`.
- **Preview:** `npm run build`, then `wrangler deploy` from `preview/`. Its origin is listed in `ALLOWED_ORIGINS` in `worker/wrangler.toml`; remove it there if the preview is retired.

## Backend API

FastAPI backend for the Pocket Reader web app. This Space is a lightweight I/O router: it searches and scrapes supported story sources, parses uploaded files, registers push subscriptions, and provides health and diagnostics endpoints. No text-to-speech inference runs on it.

The frontend reaches this backend through the Cloudflare Worker over HTTPS. The unauthenticated FastAPI `/api/state/*` endpoints are intentionally disabled. The curated-library endpoints still exist and serve the bundled PDFs, but the v2 interface does not call them.

### API Surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Basic health check |
| GET | `/api/health` | Backend liveness/config probe |
| GET | `/api/diag/logs` | Recent backend logs; requires `X-Admin-Secret` |
| POST | `/api/search` | Search AO3 using basic/advanced filters; returns paged results with `limit` defaulting to 15 |
| POST | `/api/scrape` | Fetch and parse a supported story URL |
| POST | `/api/upload` | Parse EPUB/PDF/DOCX/TXT/HTML upload |
| GET | `/api/masterlist` | Retired; returns `410`. The catalog is served by the Anthronomicon index |
| GET | `/api/library/curated` | List bundled curated PDFs (not called by the v2 interface) |
| GET | `/api/library/curated/{filename}` | Parse a bundled curated PDF |
| GET | `/api/library/curated/{filename}/download` | Download a bundled curated PDF |
| GET | `/api/ao3` | AO3-specific EPUB/FicHub fetch and parse path (server-side fallback; the web app uses `/api/scrape` + `/api/upload`) |
| GET | `/api/ao3/chapter_count` | Published AO3 chapter count probe |
| GET | `/api/fichub-proxy` | Backend FicHub JSON proxy |
| GET | `/api/fetch-epub` | Backend FicHub EPUB relay |
| GET | `/api/health/sites` | Supported-source reachability probe |
| GET | `/api/vapid-public-key` | Public VAPID key for browser push setup |
| POST | `/api/subscribe` | Register a browser push subscription and explicit AO3 story-update subscriptions |
| POST | `/api/unsubscribe` | Remove a browser push subscription |
| POST | `/api/send-push/{user_id}` | Admin-only push delivery |
| POST | `/api/sync/chapters` | Admin-only throttled chapter-refresh sweep |
| GET | `/api/state/load/{user_id}` | Disabled; returns `410`. There is no cloud profile |

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
- `WORKER_PROXY_TOKEN` or `PROXY_AUTH_TOKEN` - shared secret sent as `X-Pocket-Proxy-Key` when this backend hops through the Worker. Either name is accepted on the Space and on the Worker (`PROXY_AUTH_TOKEN` is the Wrangler secret name). Do not rename a production secret.
- `ZYTE_API_KEY` - optional Zyte smart-proxy key for Cloudflare-heavy sources.
- `FICHUB_TOKEN` - optional FicHub bearer token for datacenter-IP access.
- `FICHUB_USER_AGENT` - custom FicHub user-agent/contact string.

### Maintainer Tools

- `backend/tools/build_voice_zero_pack.py` built the Voice-Zero emotional voice pack, which is retired from the shipped catalog. Kept for the conversion pipeline it documents; it is not part of the current build.
- `backend/tools/convert_pocket_voice.py` converts local voice samples into Pocket TTS `.safetensors` conditioning files. It is not runtime app code. Optional dependencies are documented in the script header.

### Operational Notes

- Curated-library responses are sanitized server-side before listing, fetching, or downloading bundled PDFs.
- Every core module URL in `public/` carries a `?v=` tag that changes with its content, so the service worker serves those cache-first with no revalidation: a deploy reaches a returning browser because the URL itself changed, not because the cache was re-checked. `tools/check_module_versions.mjs` fails the build if a module's content changed without its version. The v2 bundle in `dist/app/` uses content-hashed file names, which the build writes into the service worker's precache list. Unversioned assets stay network-first.
- GitHub Pages sends no custom response headers, so `public/_headers` is inert there. `Referrer-Policy` is set by a `<meta>` in `web/index.html`; `X-Content-Type-Options` and `X-Frame-Options` have no meta equivalent and are simply absent on this host.
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

This repository contains several categories of work under different terms:

- **Pocket Reader code** is proprietary, all rights reserved. No license to reuse, redistribute, or self-host is granted. See `LICENSE` and `NOTICE`. Versions published before 2026-07-26 were Apache-2.0; that grant remains valid for those versions only.
- **The Virtue character**, her artwork, dialogue, and lore, and the Pocket Reader branding are proprietary creative works owned by Chris (Alpharius67 / Fluffarius), all rights reserved. See `CHARACTER_LICENSE.md`.
- **Third-party components** keep their own licenses. The ones that carry obligations in what is distributed:
  - Pocket TTS model and voices: `kyutai/pocket-tts`, CC BY 4.0, with five of the six voices drawn from the VCTK corpus (CC BY 4.0). The ONNX, INT8, and FP16 builds served to the app are modified exports; attribution and the list of changes are in `ATTRIBUTIONS.md`.
  - Kokoro-82M: Apache-2.0.
  - ONNX Runtime Web: MIT.
  - Svelte: MIT. Lucide icons: ISC.
  - Literata font: SIL Open Font License 1.1, with its license text shipped beside the font files.
  - Achievement icons from Game-Icons.net: CC BY 3.0.
  - `pywebpush` on the backend: MPL-2.0.
- **Story content** belongs entirely to its original authors. Pocket Reader claims no ownership over any fetched, uploaded, listed, or bundled story content.

`ATTRIBUTIONS.md` is the full inventory. The app shows the license, attributions, and character license under Settings, About, from the copies in `public/` (`LICENSE.txt`, `ATTRIBUTIONS.txt`, `CHARACTER_LICENSE.txt`). Keep those copies identical to the root files.

This README is an engineering summary, not legal advice.
