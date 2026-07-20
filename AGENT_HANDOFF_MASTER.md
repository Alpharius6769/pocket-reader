# Alpharius' Pocket Reader - Master Agent Handoff

Last reviewed: 2026-07-20

This is the authoritative handoff for agents working on Pocket Reader. It
describes the current architecture, production paths, major changes, removed
components, asset requirements, deployment state, verification, and known
limitations. Do not treat older handoff notes as current release state.

**GGML / audio.cpp (issue #203):** see `GGML_NATIVE_PATH.md`. Browser production
remains ONNX Runtime Web. Native GGML weights live on B2 under `ggml/pocket-tts/`
and are not loaded by the Anvil worker. Full unused ONNX rollback:
`backup/onnx-ort-browser-20260717/` on B2.

## 1. Project Identity and Boundaries

Pocket Reader is an offline-capable story reader and browser-side audiobook
application. The frontend is hosted by Anvil Works. Story search, scraping,
parsing, curated-library delivery, and push subscription coordination run in a
Hugging Face Space. Large TTS/model assets are stored in Backblaze B2 and
served through a Cloudflare Worker.

Current working directories:

```text
C:\Users\Chris\Documents\Web Build Antigravity Branch
C:\Users\Chris\Documents\Web Build Antigravity Branch\anvil-app
C:\Users\Chris\Documents\Anvil Pocket Reader Sync
```

The first directory is the active engineering workspace. `anvil-app` is its
local mirror. `C:\Users\Chris\Documents\Anvil Pocket Reader Sync` is the real
deployable Anvil Git checkout and the source of truth for publishing the
frontend. The Hugging Face checkout is:

```text
C:\Users\Chris\Documents\Web Build Antigravity Branch\Hugging Face Space
```

Production services:

```text
Published Anvil app:
https://hot-wiry-raven.anvil.app

Hugging Face Space:
https://alpharius6769-pocket-reader.hf.space

Cloudflare Worker:
https://pocket-reader-proxy.christopher-gotham67.workers.dev

B2 bucket:
pocket-reader-assets
```

The Anvil app owns authentication and private profile synchronization. The
Hugging Face backend must not become a second public profile authority.

## 2. Current Production Release

Release identifier: `startup-mobile-reliability-v1`.

Important frontend/service-worker versions currently in source and production:

```text
Service worker shell: pocket-reader-core-v120
UI controller: ui-v76
Settings module: settings-v35
Device setup module: device-setup-v6
Theme stylesheet: midnight-v19
Pocket audio module: audio-v39
Pocket worker: pocket-worker-v37
Pocket backend policy: backend-v20 (calibration cal-v12)
Experience coordinator: experience-v4
Virtue controller: virtue-v4
Buffer manager: buffer-v33
API core: search-v8
Library manager: library-v5
Narration runtime loader: narration-loader-v2
ONNX Runtime Web: 1.27.0
WASM runtime: 1.27.0 relaxed-SIMD minimal ORT-format build
WASM model family: english_2026-04-ort-r1
WebGPU model family: certified R3 FP16 bundle with device-local calibration
```

The 2026-07-20 release resolved several critical UX, narration default, and background-caching issues:
- **Default Voice:** Rayne (`rayne`) is now the default voice for all new user profiles. The global fallback is updated and the voice select elements in the HTML default to Rayne.
- **Away Mode and Background Caching:** Added missing script elements to `form_template.html`. Implemented a `preventNavigate` parameter in `loadStory` to allow silent background caching without force-navigating to the reader view or popping up loading modals. Pre-reload view states (like library/HMOFA) are saved to `sessionStorage` and restored after the service worker reload required for fast-narration worker isolation, preventing jumps back to the Home page. Fixed a major bug where `_resumeFastNarrationCache` failed to match the cached story URL with the local library title, breaking Away Mode queueing.
- **Tonight's Reading Bar UI:** Fixed Virtue's sprite head being cut off by removing the restricted parent height design and styling the image to scale cleanly, and overlaid the welcome bubble text dynamically over the sprite.
- **Settings UI & Licensing:** Bumped version to `0.8.0 Alpha Test - Web`. Removed duplicate 'This Device' diagnostic tab and 'Account & Sync' navigation menu link. Updated the About page to properly link 'NOTICE' and other attributions directly to the repository files. Added the explicit '🔔 Bell -' text back to the Subscribe button in the story options menu.
- **Directory Clean-up:** Deleted 32 gitignored/obsolete temporary build, upload, and backup folders (like `ort-relaxed-build`, `.venv-*`, `voice-zero-pocket-pack*`, etc.) to declutter.

The v120 production release retains the v117 security hardening and the
2026-07-18 performance, reliability, and mobile-usability audit fixes (shipped
as v119), and adds two lazy-load regression fixes found in review: the
cache-decision modal now awaits `ensureNarrationRuntime()` before it is shown
(it lives in the now-lazy buffer_manager.js and previously silently no-opped on
a first story open), and `recordDailyActivity` was moved to the eager
library_manager.js so daily-streak tracking fires on every app open rather than
only when narration is used. Narration modules and model initialization are
deferred until the first narration or caching action; startup no longer warms
TTS, renders hidden library and achievement views, or polls hidden health
panels. Query-versioned app assets use
cache-first/background-refresh delivery, navigation is bounded by a six-second
network deadline, and cache writes are service-worker lifetime protected.
Settings health probes are singleflight, uploads use size-aware deadlines,
onboarding and collapsed mobile navigation are focus/inert isolated, and the
device-test-to-profile transition is explicitly modal-safe.

The Hugging Face backend now fails closed if its configured database cannot be
opened unless `ALLOW_EPHEMERAL_DB=true` is explicitly set. Production reports
`database_durable=true` and `/data/subscriptions.sqlite`; site-health fanout is
singleflight and reads only a bounded response prefix. Cloudflare requests that
carry credentials or admin secrets manually reject redirects.

The release was published as Anvil commits `c4e2a86`, `194c798`, and `b7097e6`,
Hugging Face commit `cea9b6e`, and Cloudflare Worker version
`4733eab5-c9a5-4fd3-bc80-7e12528edb69`. B2 was intentionally unchanged because
no model or bucket-hosted binary changed.

The preceding v117 production release hardened permanent-cache story selection, Cloudflare
fallback rendering, push relay and AO3 URL validation, push-state deletion,
upload parser resource limits, scraper rate/concurrency/response limits,
post-connect DNS validation, Worker proxy authentication/header filtering,
scheduled-secret redirect handling, and pinned SHA-256 verification for
dynamically loaded ORT/SentencePiece modules. It also adds release parity and
non-writing audit modes. It was published on 2026-07-18 as Anvil commit
`55b84c4`, Hugging Face commit `46aaaa3`, and Cloudflare Worker version
`e369de8e-50cd-4b65-b522-28cbcfb1b347`. Live Anvil v117 assets and the Hugging
Face health endpoint were rechecked after deployment.

The 2026-07-16 release moved English relaxed-SIMD WASM to ORT-format models and
an operator-reduced runtime (2,165,701 bytes versus 13,310,728 bytes for the
full build). Constrained devices use a weight-shared unified prefill/block4
graph to avoid duplicate flow-model weights. The runtime contains the upstream
relaxed i8x16/i7x16 dot-product GEMM kernel and is capability-gated with stock
WASM fallback.

High-memory isolated desktops may use exactly two x2/x4 WASM workers while
full-story caching. The gate requires desktop, `deviceMemory >= 8`, enough
logical cores, no saver/low-memory/low-battery condition, and a non-constrained
classification. Mobile, WebGPU, and unknown-memory devices remain single-worker.
The second worker is terminated after caching. Measured dual-x4 effective RTF
was 0.197 versus 0.268 single-worker, with about 1.72 GiB peak browser private
memory. The twelve-generation x4 sustained run drifted only 5.6%, so the
existing thermal-rest thresholds were loosened for mobile (trigger 1.7×, 8s/20s
rests) in SW v117 / backend-v20.

The 2026-07-18 security/reliability release moved library actions, chapter
storage, Away Mode jobs, and synthesized-audio keys onto stable story
references. Legacy title-keyed chapter data is migrated lazily, and ambiguous
same-title lookups are refused. Cache and health status HTML now escapes
untrusted values. Push records use cryptographically random browser IDs plus a
server-issued ownership capability for updates and deletion. Service-worker
shell precache failures now reject installation, and the live smoke test tracks
the active v119 worker. Cloudflare Worker observability is enabled.

Rejected benchmark branches are not production-selected: dynamic/static QDQ
quantization failed quality parity, block2 was slower, block6 was not a robust
cross-thread win, and ORT 1.27 WebGPU graph capture could not bind the recurrent
int64 state safely. Baseline R3 FP16 remains enabled for eligible devices and
is demoted by measured device-local parity when WASM is faster.

Every browser profile now runs one local-only device setup before profile
creation. The setup collects coarse browser-exposed capabilities, runs a small
disposable x1/x2/x4 CPU simulation, and attempts a tiny FP16 WebGPU compute
probe only when `shader-f16` is exposed. It never initializes or downloads the
full TTS model. The selected backend and thread count are stored in localStorage
and are not part of account/profile synchronization, so each device is tuned
independently. Users may rerun diagnostics or manually override the result.
The device-to-profile handoff has its own pending marker so an older
`pr_setup_complete` value cannot suppress profile creation after a newly run
device test. The marker survives a reload and is cleared only when profile
setup is saved or skipped.
All three service-worker registration paths (standard page, UI controller,
and Settings narration handoff) now request revision 115; older mixed
lower-revision registrations must not be reintroduced. On mobile, the install
banner reserves scroll space but remains below modal overlays so it cannot
cover setup, diagnostics, or Advanced Settings confirmations.

The official mobile support floor is capability-based but conservative:
iPhone 13 Pro/Pro Max (`iPhone14,2`/`iPhone14,3`) or newer Pro-capable hardware;
Pixel 6/Tensor generation or newer; Galaxy S21/Fold3 generation or newer;
Snapdragon 888/8-series, Exynos 2100, or Dimensity 9000 generation or newer.
Unknown Android devices need at least the 8 GB browser memory bucket and a
passing local benchmark. Unknown iPhones remain constrained/unverified because
Safari does not expose a reliable model or exact RAM signal. Devices below or
outside the floor receive one post-profile warning recommending Away Mode.

## 3. Frontend Features and Page Surface

The frontend includes these primary views and workflows:

- First-device diagnostics and automatic backend/thread selection, followed by
  profile creation with guest, Google, and email account paths.
- A device-local Advanced Settings risk acknowledgement. Normal Settings and
  diagnostics remain available without it; the warning appears only on the
  first explicit attempt to expand Advanced Settings, then opens that section
  after the user checks and accepts the acknowledgement.
- Home reading command center with continue-reading, queue, history, weekly
  goal progress, and Virtue staging.
- Library with cards/list density, ratings, favorites, collections, queue,
  history, filters, batch actions, story menus, deletion, and local storage
  controls.
- AO3 search with exact title/author/tag handling, pasted AO3 search URL
  parsing, pagination, up to 15 results per load, retry/fallback states, and
  direct exact-search fallback.
- HMOFA masterlist browsing and story import.
- Reader view with chapter navigation, bookmarks, notes, progress, cache
  controls, Pocket narration controls, voice/emotion settings, playback rate,
  queue controls, and story update actions.
- Profile/account center with avatar, achievements, statistics, history,
  account status, sync health, export, logout, and deletion controls.
- Settings grouped into account/sync, reading, narration, appearance,
  companion, accessibility, and advanced diagnostics. Storage tools live in the
  Advanced Settings & Info section (there is no separate Offline Storage pill).
  Section cards collapse by default on phones and stay expanded on wider
  viewports.
- About/licensing/architecture information and third-party attributions.

Shared interaction systems include:

- `experience_coordinator.js`: serializes achievements, Virtue messages,
  notices, dialogs, tips, and account feedback so only one blocking reveal is
  active at a time. Events are prioritized and deduplicated.
- `virtue_controller.js`: controls sprite selection, bubble coordinates,
  text fitting, dismissal, keyboard access, pointer dismissal, and responsive
  companion behavior.
- `cinematic_ui.js` and `motion_lite.js`: page styling, settings sections,
  motion presets, account surfaces, and controlled transform/opacity effects.
- `lucide-sprite.svg`: bundled interface icons replacing fragile emoji and
  improvised symbols.
- Local Literata and IBM Plex Sans font assets with their license files.

The current theme is displayed to users as **Anthrostate**. “Midnight Theater”
is the internal design direction and is not a separate product or license.

## 4. Recent Frontend Fixes

The frontend has received fixes for:

- Virtue text being clipped or offset on large desktop layouts. Bubble text now
  uses safer wrapping, reduced padding, a larger minimum compact size, and a
  resize observer that re-fits after responsive layout changes.
- The story-card menu `closeMenu.js` temporal-dead-zone error. The close-menu
  handler is initialized before subscription/menu markup is generated.
- First-run setup not appearing reliably for new users.
- Setup answers disappearing when authentication reloads the form. Draft
  answers are persisted and restored around Google/email login.
- Guest/skip setup flow requiring an incorrect extra click.
- Large-button settings being incorrectly treated as the default.
- Theme/icon controls disappearing at some viewport sizes or requiring a
  refresh.
- Story reader text/control bars having inconsistent widths and vertical
  overflow.
- Cache status showing `Idle` while background caching continued.
- Duplicate chapter entries and repeated chapter narration through chapter
  canonicalization and deduplication.
- Virtue intercepting page scrolling. The active companion is dismissible by
  pointer/touch/click or keyboard and uses non-obstructive interaction rules.
- Achievement and companion events appearing simultaneously without order.
- Visible mojibake in touched UI strings, generated markup, diagnostics, and
  comments. Continue scanning for corrupted UTF-8 sequences when changing
  text.
- Stale service-worker theme assets by using versioned shell assets and
  network-first handling for application JavaScript/CSS.
- Phone reader layouts trapping the playback controls below an inner scroll
  region. Mobile reading now delegates scrolling to the view container and
  keeps the narration bar reachable and pinned.
- Uploaded/local stories restoring into an invalid URL cache path after the
  fast-narration isolation reload. Cache resume now validates restored story
  state before restarting work.
- Duplicate constrained-device cache decisions and cache-start reload jumps.
  The explicit decision is persisted before isolation and the resumed session
  suppresses the second prompt.
- Repeated full-profile writes and full library-grid rebuilds during small
  changes. Profile saves are coalesced, achievement scans are intent-driven,
  and individual story cards can update without rebuilding the whole grid.
- Mobile HMOFA table taps, touch scrolling, and overly aggressive thermal
  pacing. Phone interactions now use delegated handlers and the sustained
  thermal thresholds match the current measured policy.
- TTS pronunciation edge cases and emotion-state pitch/identity shifts. The
  current pronunciation rules and same-base expressive routing reduce those
  artifacts while retaining the user's selected narrator.

## 5. Pocket TTS Runtime

Pocket TTS is the only packaged neural narration engine. It runs in browser
workers and uses Web Speech as the lowest-power fallback. No server-side TTS
inference is used.

The runtime supports:

- Browser-side ONNX inference.
- Threaded SIMD WASM fallback.
- Adaptive WebGPU R3 FP16 execution when device-local calibration proves a
  stable full-pipeline win.
- Device-local backend preference: `auto`, `wasm`, or calibrated `webgpu`.
- WebGPU loss, unsupported operator, allocation failure, NaN output, and
  excessive latency fallback to WASM with one paragraph retry.
- Sustained-latency demotion: two consecutive paragraphs (>=2s audio) with a
  real-time factor above 1.25 on WebGPU demote the session to WASM and
  persist WASM in the stored calibration so later sessions start fast
  (`shouldDemoteWebGpuSustained` in `pocket_backend_policy.js`).
- Mobile WASM thread count is platform-aware (`detectMobilePlatform`,
  `recommendedWasmThreadCount`, `wasmThreadCandidates` in
  `pocket_backend_policy.js`), because `navigator.hardwareConcurrency` is a poor
  proxy for the performance-core count that actually bounds thread scaling:
    - iOS: capped at 2 threads. Safari clamps `hardwareConcurrency` to a
      constant 4 for anti-fingerprinting, but every modern iPhone has exactly 2
      performance cores.
    - Android flagship (Pixel 6 Pro, Galaxy S21/S21+, 4 big cores): 4 threads.
    - Low-memory (`deviceMemory <= 4`) or Data Saver Android: capped at 2.
    - Budget Android UA blocklist (Moto G, Galaxy A/M, Pixel a-series, etc.)
      keeps weak SoCs off any WebGPU candidate path.
  Multi-thread mobile WASM requires the isolated `?tts_fast=1` session
  (SharedArrayBuffer).
- First-device backend selection:
    - Benchmarks WASM x1/x2/x4 with disposable workers. iOS remains capped at
      x2 even when the browser reports four logical processors.
    - Mobile (including Pixel 6 Pro) defaults to threaded WASM. The tiny FP16
      compute probe no longer promotes Android to WebGPU; WebGPU is Settings
      opt-in after a full device-local optimization. Desktop may still select
      WebGPU from the probe latency gate.
    - iPhone 13 Pro/Pro Max and newer positively identified supported hardware
      may qualify for memory/expressive policy. Base iPhone 13/mini, older, and
      unknown iPhones fail closed to constrained WASM. ORT WebGPU stays off on
      iOS browsers.
    - Android support combines coarse memory/model/SoC evidence with the local
      benchmark; unknown models require positive 8 GB evidence.
    - Sustained demotion compares WebGPU RTF to modeled or measured WASM RTF
      (`resolveWasmReferenceRtf` / `shouldDemoteWebGpuSustained`). After demotion
      the worker releases GPU sessions before loading INT8 and samples measured
      WASM RTF for future parity checks.
    - Sticky demotion (`writeWebGpuDemotion`) persists across sessions and
      survives the 3-strike calibration clear; only "Re-run optimization"
      clears it. Demoted devices skip WebGPU probe/HEAD on cold start.
  The full TTS watchdog still demotes WebGPU when real narration performance is
  unstable or slower than WASM.
  `tools/pocket_device_simulation.mjs` models the device spectrum.
- Local model/voice caching through IndexedDB/Cache Storage.
- Background caching and Away Mode checkpointing when the browser permits it.
- Playback speed independent of generated-audio cache identity.
- Every iOS device uses memory-safe inference mode. iOS and constrained devices
  keep one cache worker, cap text chunks at 120 tokens, disable full-story voice
  prefetch, lazily retain at most the current/next voice state, load shared
  model sessions sequentially, and terminate the cache worker after each cache
  job so ORT arenas can be reclaimed. Manually enabling expressive prosody does
  not re-enable full-story voice prefetch.

### Narration behavior

- Default new-profile playback speed is `1.08x`.
- Balanced narration temperature is currently `0.80`.
- Temperature caps are applied per emotion to control artifacts.
- Emotion selection is paragraph-level and uses confidence/hysteresis. Punctuation
  and chunk splits do not rescore emotion.
- One selected base narrator is retained for a paragraph. Emotion references
  must come from that same base voice.
- Pronunciation normalization runs before tokenization and supports built-in
  corrections plus synced user overrides.
- Inline pause tags such as `[1.2s]` are silent and add pause duration only.
- Punctuation pauses are longer audiobook-style pauses for commas, semicolons,
  colons, dashes, sentence endings, and ellipses.
- Each generated paragraph includes a `0.5s` trailing paragraph pause.
- Cache keys include voice asset, emotion mode, temperature preset,
  pronunciation ruleset, pause profile, chunking version, artifact-guard
  version, backend, model precision/revision, and runtime version.
- Audio quality checks reject empty, non-finite, silent, severely clipped, or
  implausibly short output. A single safer same-base retry is allowed.

### Voice-Zero pack

Pack identifier:

```text
voice-zero-emotional-v1
```

Source and license posture:

```text
https://github.com/OwenTyme/voice-zero
CC0 unless the upstream asset metadata says otherwise.
```

Current six displayed base voices:

| Runtime ID | Display name | Profile |
|---|---|---|
| `donald_malone` | Donald Malone | American, Midwestern male; default recommended |
| `bill_boerst` | Bill Boerst | American male |
| `jason_mayoff` | Jason Mayoff | American male alternate |
| `kristin_hughes` | Kristin Hughes | American, Iowa female; recommended female default |
| `jodi_krangle_expressive` | Jodi Krangle Expressive | American female |
| `karen_savage` | Karen Savage | American female alternate |

Each voice has the standard emotion slots:

```text
neutral, calm, happy, sad, worried, surprised, tired, frustrated,
anger, excited, enthused, shout, confused
```

The first eight are the normal safe set. High-intensity emotions are gated in
balanced mode and remain available to full mode when the asset is present.
The worker uses keyed custom voice states, not one mutable global `custom`
slot, so concurrent work cannot silently swap narrator identity.

Legacy voice IDs are migration aliases only. Old visible options such as
`rob`, `dan`, `caden`, `dave`, `ian`, `jodi`, `reeses`, `stephanie`, `vd`, and
`christine` must not be reintroduced to the UI. A legacy emergency fallback
may remain hidden for migration/recovery only.

## 6. Pocket Model and Runtime Assets

### B2 voice path

The correct B2 object prefix is:

```text
voices/
```

Examples:

```text
voices/donald_malone_neutral.safetensors
voices/donald_malone_sad.safetensors
voices/kristin_hughes_worried.safetensors
```

The browser requests:

```text
https://pocket-reader-proxy.christopher-gotham67.workers.dev/models/voices/<file>.safetensors
```

The Worker maps that request to B2 key `voices/<file>.safetensors`.

The local converted pack is under:

```text
voice-zero-pocket-pack/
```

The source FLAC pack is under:

```text
voice-zero-pocket-pack-source/
```

These contain 78 emotion assets in the current six-voice/13-slot pack. The
local `.venv-voice` environment and conversion scripts are maintainer tools,
not runtime dependencies.

### B2 model paths

Preferred core model layout:

```text
onnx/english_2026-04/
```

Preferred WebGPU R3 layout:

```text
onnx/english_2026-04-webgpu-fp16-r3/
```

ONNX Runtime Web 1.27.0 assets:

```text
onnxruntime/1.27.0/
```

Required runtime files include the standard ESM/WASM runtime, threaded SIMD
WASM files, WebGPU JSEP files, and integrity metadata. The R3 bundle includes
its manifest, certification/integrity metadata, tokenizer/BOS state, four
FP16 ONNX graphs, and compatible Voice-Zero state handling.

`voices.bin` is optional for the custom Voice-Zero setup. Do not reintroduce
built-in Pocket voice UI options merely because a bundle manifest advertises
them.

Useful maintainer guide:

```text
POCKET_TTS_ONNX_UPLOAD_TO_B2.md
```

The friendly B2 URL used previously for upload instructions is:

```text
https://f005.backblazeb2.com/file/pocket-reader-assets/voices/UPLOAD_TO_B2.md
```

## 7. Cloudflare Worker

Source:

```text
Back end/cloudflare_worker.js
Back end/wrangler.toml
```

Responsibilities:

- Proxy approved model, runtime, voice, and tokenizer assets from B2.
- Provide CORS and correct JavaScript/WASM/model MIME types.
- Support range requests for large assets.
- Apply immutable versioned caching to model assets while allowing tokenizer
  and bundle metadata revalidation when needed.
- Protect generic external fetches with host allowlists, scheme checks,
  credential/port rejection, private-host/SSRF checks, and manual redirect
  handling.
- Forward scheduled chapter-sweep requests to the Hugging Face admin endpoint.

The production Worker has a scheduled trigger at minutes `17` and `47` of
each hour. Its `ADMIN_PUSH_SECRET` must match the Hugging Face Space secret.
Secrets must never be placed in frontend files, B2 public objects, or this
handoff note.

## 8. Hugging Face Backend

Backend source is the FastAPI app in the Hugging Face Space checkout. It
provides:

- `/api/health` and site diagnostics.
- `/api/search` with AO3 exact-field normalization, pagination, structured
  status metadata, result caching, overload/transient caching, and pasted AO3
  URL parsing.
- `/api/ao3`, `/api/scrape`, `/api/fichub-proxy`, and `/api/fetch-epub`.
- File parsing for EPUB, PDF, DOCX, TXT, HTML, and supported generic sources.
- HMOFA masterlist proxy/cache.
- Curated library list/fetch/download routes.
- Browser push subscription registration and story update subscriptions.
- Admin-only chapter refresh sweep at `/api/sync/chapters`.
- Admin-only diagnostic logs and push delivery.
- Disabled legacy `/api/state/*` endpoints; Anvil owns profile sync.

### AO3, FicHub, and Zyte routing

Zyte is configured as a real backend path. AO3/FicHub requests attempt the
Zyte HTTP/browser extraction path before Cloudflare/direct fallback where the
route requires it. FicHub is used as an AO3 EPUB relay when available.

AO3 remains an external service and may throttle, block, delay, or change its
HTML. Zyte availability does not guarantee instant results. Do not bypass the
shared AO3 politeness/concurrency gate or remove the transient cache without a
measured reason.

### SSRF hardening

The shared URL guard rejects non-HTTP schemes, malformed hosts, embedded
credentials, disallowed ports, private/link-local/loopback/reserved/cloud
metadata addresses, and unsafe redirect destinations. It is applied before
direct fetches, Zyte requests, Cloudflare fallback requests, image fetches,
FicHub fetches, and every redirect hop.

## 9. Authentication, Profiles, and Sync

Anvil Users is the authentication authority. Supported account options are
guest, Google OAuth, and email/password with confirmation, password reset,
remembered sessions, logout, account switching, export, and deletion.

Profile schema is version 3. Cloud sync includes:

- Canonical JSON objects rather than JSON strings masquerading as objects.
- Cloud revision and persistent device ID.
- Synced appearance, reading, companion, narration, pronunciation, goals,
  accessibility, story metadata, progress, ratings, favorites, bookmarks,
  collections, queue, history, achievements, and statistics.
- Device-local worker choice, GPU workarounds, cache limits, storage state,
  diagnostics, model files, generated audio, cookies, and hardware tuning.
- Per-field/per-story timestamps and deletion tombstones.
- Stable bookmark IDs and bookmark deletion timestamps.
- Achievement union with earliest unlock preservation.
- Per-device monotonic counters and shared activity dates.
- One coalesced IndexedDB outbox with debounce, exponential retry, and online
  recovery.
- Periodic playback checkpoints rather than syncing every paragraph.
- Avatar normalization to approximately 512px WebP and 256 KB before storage.

The canonical callable is:

```text
sync_user_profile(profile, base_revision, device_id)
```

Old save/load wrappers exist only for schema-v2 compatibility and must not be
used for new features.

## 10. Story Subscriptions and Updates

Users may subscribe to unfinished AO3 stories identified by AO3's `chapters:
1/?` state. The subscription flow:

1. Validates that the AO3 work is incomplete.
2. Stores the explicit story subscription and chapter snapshot in the backend
   push database.
3. Cloudflare invokes the admin-only HF chapter sweep twice per hour.
4. The backend compares chapter counts and sends browser push when a new
   chapter is detected.
5. The app focuses/opens the reader and appends new chapters through canonical
   merge logic.

Updates must preserve progress, bookmarks, notes, favorites, ratings,
narration presets, collections, and deletion tombstones. Push cannot directly
write the app's IndexedDB while the app is fully closed; it is a notification
handoff, not a background database mutation.

## 11. Removed or Retired Components

The following are intentionally absent from runtime code and deployment
assets:

- Kokoro TTS and all Kokoro runtime integration.
- eSpeak NG and all eSpeak runtime integration.
- Other previously tested/retired TTS stacks and their runtime dependencies.
- Old Pocket built-in voice UI options.
- Withdrawn curated stories and their author identity from public library
  payloads and frontend rendering. Server-side hash blocklists also sanitize
  stale local/cloud/backup profiles and direct old URLs.
- Old test scripts and obsolete asset names where they were no longer needed.

Do not re-add removed engine names to runtime comments, documentation, test
fixtures, dependency lists, or generated markup. Historical notes should be
clearly marked as historical and kept out of production scans when possible.

## 12. Offline, PWA, and Mobile Behavior

The service worker provides an isolated app shell, network-first application
code updates, cache-friendly large images/model assets, and cross-origin
isolation headers needed for SharedArrayBuffer/WebGPU where supported.

Browser limitations remain important:

- A PWA cannot guarantee TTS generation while the phone is locked or the OS
  suspends the browser process.
- Media Session can expose play/pause/seek controls on supported browsers and
  lock screens, but iOS/Android/browser policy controls final behavior.
- Background caching pauses or is throttled when the page is hidden on many
  mobile browsers. Away Mode can checkpoint and resume but cannot override OS
  suspension.
- Exact RAM, GPU, CPU, thermal, and battery telemetry is unavailable to normal
  browser code. Reported values are approximate/capability-based.
- WebGPU is available only in secure, isolated, supported contexts and is
  calibration-gated. Devices that do not pass remain on threaded WASM.

## 13. Verification and Release Procedure

For frontend changes:

```powershell
cd "C:\Users\Chris\Documents\Web Build Antigravity Branch\anvil-app"
node --check theme/assets/<changed-file>.js
git diff --check
git status --short
git add <intentional-files>
git commit -m "<message>"
git push origin HEAD:master
```

Verify the published URL after pushing:

```powershell
Invoke-WebRequest https://hot-wiry-raven.anvil.app/_/theme/<asset>?v=<version>
Invoke-WebRequest https://hot-wiry-raven.anvil.app/_/api/serviceworker.js?v=119
```

For backend changes:

```powershell
python -m py_compile Back end\app.py Back end\scrapers_core.py Back end\parsers_core.py
node --check Back end\cloudflare_worker.js
git -C "Hugging Face Space" status --short
git -C "Hugging Face Space" push
```

For current frontend regression coverage:

```powershell
node --test tests\*.test.mjs
```

The current suite has 99 passing Node tests and four passing backend regression
tests covering Pocket generation, WebGPU
calibration/fallback, narration isolation, service-worker revision, mobile
playback, interrupted cache jobs, Away Mode guidance, subscriptions, menu
initialization, onboarding drafts, pronunciation, quality guards, and
performance policy. The live WebKit smoke confirms cross-origin isolation,
SharedArrayBuffer availability, zero reload loops, and zero page/console errors.
The first-device browser harness also exercises Chromium,
desktop WebKit, and simulated iPhone 13 Pro WebKit for setup ordering, safe
actions, acknowledgement gating, local-only storage, and backend selection.
Release benchmark reports are under `benchmark-results/`;
the final candidate files are `release-candidate-wasm-x1-x2-x4.json`,
`release-candidate-true-x1.json`, `release-candidate-constrained-x2.json`, and
`release-candidate-webgpu-x4.json`.

Before a major release, also run browser/device smoke tests for onboarding,
Google/email login, search, manual story add, reader controls, cache resume,
PWA reload, WebGPU/WASM selection, push subscription, story updates, profile
sync, and account deletion.

## 14. Known Limitations and Open Risks

- AO3 and FicHub are external integrations and can still be slow or blocked.
- Full multi-device account conflict testing requires real Anvil accounts and
  two devices; automated merge tests do not prove OAuth configuration.
- Background synthesis/caching under locked-screen mobile conditions is not
  guaranteed by the web platform.
- WebGPU speed is device/browser dependent; the R3 path must remain gated by
  calibration rather than assumed to beat WASM everywhere.
- No desktop process-memory result can guarantee a WebKit jetsam ceiling. The
  five-paragraph constrained x2 run showed oscillating/reclaimed memory rather
  than monotonic paragraph-by-paragraph growth, but a physical iPhone 13 Pro
  long-story cache run remains the final OOM acceptance test.
- No fresh 100,000-word endurance run is a substitute for real-device testing;
  long-form testing should measure skipped words, voice identity, artifacts,
  memory growth, battery, retries, and cache recovery.
- HF Space push subscriptions depend on persistent `/data` storage. Ephemeral
  Space storage can lose subscriptions across restart/redeploy.
- Diagnostic logs are in-memory and admin-protected; they are not a durable
  observability system.
- The app still contains legacy dynamic HTML construction. Values must remain
  escaped and new UI should prefer existing safe helpers/components.
- Do not publish secrets, admin headers, private profile data, or raw B2
  credentials in source, logs, screenshots, handoff notes, or client code.

## 15. Agent Rules for Future Changes

- Read the active source and deployable Anvil checkout before editing.
- Keep runtime Pocket TTS and Voice-Zero behavior intact unless the user
  explicitly requests an engine change.
- Preserve same-base emotional voice routing and cache-key invalidation.
- Keep Anvil as the profile/auth authority and keep device-local assets local.
- Update versioned service-worker/module references whenever cached frontend
  assets change.
- Synchronize equivalent files across the active workspace, Anvil checkout,
  Hugging Face checkout, and Cloudflare source where the file is shared.
- Never silently overwrite unrelated user changes.
- Test syntax and the full suite before committing.
- Verify the live published URL after every Anvil push.
- Update this handoff note when architecture, deployment paths, asset versions,
  licensing, or major behavior changes.
