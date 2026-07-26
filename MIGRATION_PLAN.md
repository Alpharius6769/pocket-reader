# Pocket Reader — Anvil Decommission & GitHub Migration Plan

Created: 2026-07-26. Status: **Phases 0–2 complete. Phase 3 next.**

Live at `github.com/Alpharius6769/pocket-reader` (private). CI green; the
`backend/` → Hugging Face deploy is verified end to end.

Authoritative plan for moving Pocket Reader off Anvil Works onto a private
GitHub repo + Cloudflare Pages, with Supabase owning auth and profile sync.
Supersedes the hosting description in `AGENT_HANDOFF_MASTER.md` §1 once Phase 4
completes. Until then, **Anvil remains production**.

## Decisions (locked 2026-07-26)

| Question | Decision |
|---|---|
| Backend host | **Stay on Hugging Face.** Fly/Railway/Koyeb dropped their free tiers; Render free spins down at 15 min (worse than HF's ~48h). HF becomes a deploy target, not the source of truth. |
| Frontend host | **Cloudflare Pages**, deployed from a private GitHub repo. Free tier, unlike GitHub Pages which needs Pro for private-repo publishing. |
| Auth + profile DB | **Supabase** free tier (Postgres + GoTrue: Google OAuth, email/password, confirmation, reset). |
| Code license | **Proprietary, all rights reserved.** Replaces the current Apache-2.0 grant for future versions. |
| User base | **Tens of accounts.** Export/import tooling and a forced-reset flow are required — not optional. |
| Unchanged | Cloudflare Worker, Backblaze B2, Zyte, FicHub. |

Hard constraint: **no new recurring spend.** Every service above is free tier
or already paid for (GitHub Pro, B2, Zyte).

## Target repository layout

One copy of every file. The current four-way sync (root, `anvil-app/theme/
assets/`, `_/theme/` mirror, `anvil-app/client_code/FrontEnd/form_template.html`)
is the single biggest maintenance tax in the project and this deletes it.

```text
pocket-reader/                      (private GitHub repo)
├── .github/workflows/
│   ├── test.yml                    node --test tests/*.test.mjs
│   └── deploy-backend.yml          push backend/ → HF Space on main
├── public/                         ← Cloudflare Pages serves this dir
│   ├── index.html                  (was FrontEnd_html.html, de-Anvil'd)
│   ├── standard-page.html
│   ├── sw.js                       (was serviceworker.py, now a static file)
│   ├── _headers                    COOP/COEP + cache-control
│   └── assets/{js,css,fonts,img,icons}/
├── backend/                        (was "Back end/") → deploys to HF Space
├── supabase/
│   ├── migrations/                 schema + RLS policies
│   └── functions/sync-profile/     port of Server_code.py sync_user_profile
├── worker/                         (was Back end/cloudflare_worker.js)
├── tools/  tests/  docs/
└── LICENSE  NOTICE  ATTRIBUTIONS.md  CHARACTER_LICENSE.md
```

`anvil-app/` and the `_/theme/` mirror are deleted at Phase 4, not before.

## The Anvil coupling surface

Smaller than it looks. `FrontEnd_code.py:69-77` installs exactly 8 bridge
functions on `window`, consumed at ~25 call sites across `sync_core.js`,
`ui_controller.js`, `library_manager.js`, `settings_manager.js`, and
`cinematic_ui.js`:

```text
anvilLogin  anvilLogout  anvilGetCurrentUser  anvilSyncProfile
anvilLoadProfile  anvilSyncProfileV3  anvilSaveAvatar  anvilLoadAvatar
anvilDeleteAccountData
```

Strategy: `supabase_bridge.js` implements the **same 9 names with the same
signatures and return shapes**. Call sites stay untouched, so the swap is
one file plus a script tag. Rename the functions only after cutover is stable.

The server side is `Server_code.py`: ~500 lines of per-field-clock merge
(`_merge_profile`, `_merge_story`, `_merge_clocked_map`, `_merge_bookmarks`)
inside a serializable Anvil transaction. The merge logic is plain Python with
no Anvil-specific semantics — it ports cleanly. Postgres gives a **stronger**
isolation guarantee than what it relies on today.

## Two architectural wins to claim during the move

1. **Delete Skulpt from page load.** Anvil executes `FrontEnd_code.py` via a
   Python-to-JS interpreter in the browser, solely to install those 8 bridge
   functions. The rest of the app is vanilla JS. Dropping Anvil removes an
   entire interpreter plus the Anvil client runtime from startup.

2. ~~**Possibly delete the `?tts_fast=1` isolation reload**~~ — **RETRACTED
   2026-07-26. Do not attempt this.**

   The original idea was to set COOP/COEP globally via `public/_headers` so
   isolation holds from first paint, removing the reload (and with it the
   story-load Home flash the anti-flash mask papers over).

   **It would break Google sign-in.** `sw.js` documents the existing design
   explicitly: *"Isolation is opt-in and limited to `?tts_fast=1` narration
   sessions. The normal app stays unisolated because COOP same-origin severs
   OAuth popup relationships."* Phase 4 introduces Google OAuth through
   Supabase, which depends on exactly those popup relationships. Global COOP is
   therefore incompatible with the auth this migration is adding.

   The opt-in, per-navigation isolation applied by the service worker is the
   correct architecture. It stays, the `?tts_fast=1` reload stays, and the
   anti-flash mask stays. `public/_headers` carries a comment saying so, because
   this is exactly the kind of "obvious cleanup" a future reader would attempt.

   (The CF Worker already sends `Cross-Origin-Resource-Policy: cross-origin`,
   so the narration path's COEP requirement is satisfied as-is.)

## Phases

Each phase ends in a working, shippable state. Anvil stays live until Phase 4.

### Phase 0 — Prep (no user-visible change)
- [x] Swap LICENSE/NOTICE to proprietary; keep third-party attributions intact
      (done 2026-07-26, suite 145/145; local only, nothing pushed)
- [x] Resolve Rayne provenance — cleared, maintainer-created AI voice
- [x] Add the Rayne entry to `ATTRIBUTIONS.md`
- [x] **Purge oversized paths from git history — DONE 2026-07-26.**
      `.git` 1,400.6 MB → **33.2 MB**; tracked 497.6 MB → **36.4 MB** (262
      files). Two `git filter-repo` passes removed `vendor/`,
      `personal voices/`, `pocket-flow-qdq-sweep/`, `pocket-flow-quant-sweep/`,
      and `b2_temp/`. Largest blob in history is now 0.25 MB. Backup of the
      original 1.4 GB `.git` at
      `C:\Users\Chris\Documents\pocket-reader-git-backup-20260726`
      (restore: delete the new `.git`, copy the backup back).
      All 44 commits of real work preserved; the single pruned commit was
      "Remove old build sweeps and upload temp files from git tracking", which
      became empty once the files it deleted never existed. Suite 145/145 after.
      **All commit SHAs changed** — references in `AGENT_HANDOFF_MASTER.md` are
      now stale (e.g. `14c1943` → `ff91ee9`).
- [x] `git filter-repo` and `wrangler` 4.114.0 installed
- [x] `gh auth login` — authenticated as **Alpharius6769** (scopes: `repo`,
      `workflow`, `read:org`, `gist`). The first attempt silently half-completed:
      the browser authorised but the CLI was closed before it polled for the
      token, leaving `AppData\Local\GitHub CLI\` holding only `device-id` and no
      `hosts.yml`. **Always verify with `gh api user --jq .login`.**
- [x] Private GitHub repo created and pushed:
      `github.com/Alpharius6769/pocket-reader`
- [x] Supabase project created — key verified, see the Supabase section below
- [x] `wrangler login` — OAuth, account `5664c240e6960492187406a30f6a5ab3`
- [x] **Cloudflare Pages project `pocket-reader` created 2026-07-26.**
      Note the assigned origin is **`pocket-reader-f2y.pages.dev`**, *not*
      `pocket-reader.pages.dev` — `pages.dev` subdomains are globally unique and
      the plain name was taken, so Cloudflare appended a suffix. This is the
      permanent origin: it is what every `ALLOWED_ORIGINS` entry must name and
      what user IndexedDB will bind to.
      (Creation failed once with a Cloudflare-side HTTP 500 / `code: 8000000`;
      a plain retry succeeded. Not a permissions issue — retry before debugging.)

#### BLOCKER: repository size

This repo **cannot be pushed to GitHub as-is.**

```text
.git directory            1,400.6 MB
tracked files               497.6 MB across 316 files
largest tracked blob        208.9 MB  vendor/audiocpp-models/.../model.safetensors
```

GitHub hard-rejects any file over **100 MB**, anywhere in history — not just at
HEAD. That 208.9 MB safetensors entered history at commit `47d26d7`, so every
push attempt fails until history is rewritten. Git LFS is not a fix: GitHub Pro
includes 2 GB LFS bandwidth/month and overage is billed, which breaks the
no-spend rule.

`vendor/` should never have been tracked. Everything in it is recoverable:

| Path | Recover from |
|---|---|
| `vendor/audio.cpp/` | upstream clone, github.com/0xShug0/audio.cpp |
| `vendor/audiocpp-windows/` | published audio.cpp release binaries |
| `vendor/audiocpp-models/pocket-tts/` | B2 `ggml/pocket-tts/` |

This matches the project's own stated policy — `GGML_NATIVE_PATH.md` policy #2
("GGML assets stay on B2") and `README.md` ("Runtime model assets are not
committed to this repository"). `vendor/` and `personal voices/` are now in
`.gitignore`; history still needs cleaning.

Two ways to clear history, **maintainer's call** (both are destructive to the
local repo — bundle a backup first):

- **Rewrite (recommended).** `git filter-repo --path vendor --invert-paths`
  drops `vendor/` from every commit while keeping all app-code history, messages,
  and diffs. Shrinks `.git` from ~1.4 GB to tens of MB. All commit SHAs change,
  so references in `AGENT_HANDOFF_MASTER.md` and the agent memory go stale.
- **Fresh start.** Initialise the GitHub repo with one clean commit of the
  restructured tree. Simplest, but loses all commit history; the existing local
  repo remains on disk as the archive.

Note both nested checkouts are tracked as **bare gitlinks with no `.gitmodules`**
(mode 160000, `anvil-app` and `Hugging Face Space`), so they push as broken
submodule refs. Phase 1 must absorb or drop them before the first push.

### Phase 1 — Repo restructure (local, reversible)
- [x] **Frontend moved into `public/` — done 2026-07-26, commit `6c735af`.**
      85 files relocated to `public/{index.html,standard-page.html,
      assets/{js,css,fonts,img,icons}}`, all recorded by git as 100% renames so
      history follows each file. Bundled OFL/ISC license texts moved next to
      the assets they cover. 15 test/tool files updated (144 path replacements,
      5 ESM imports, plus the anvil-app mirror check rewritten to map bare
      names to canonical `public/` paths rather than concatenating a prefix).
      Suite 145/145.
- [x] `Back end/` → `backend/`, worker extracted to `worker/`
      (`cloudflare_worker.js` + `wrangler.toml`; `main` is relative so it still
      resolves). 60 renames; 9 test/tool files repointed.
- [x] Extracted `public/sw.js` from `serviceworker.py` — 13,464 bytes, passes
      `node --check`, no Python wrapper leakage. Added
      `tests/migration_parity.test.mjs` (4 guards) asserting `public/sw.js`
      stays byte-identical to the JS embedded in `serviceworker.py`, that
      `CACHE_NAME` matches, and that the `anvil-app` mirror still matches the
      canonical `public/` sources. Suite **149/149**.
- [x] Added `tools/sync_to_anvil.ps1` (with `-Check` mode) — flattens
      `public/assets/**` into Anvil's flat `theme/assets/`, maps
      `index.html` → `form_template.html` and `serviceworker.py` →
      `server_code/`. Guards against two files flattening onto one target.
      Verified against a negative control: injected drift → exit 1, restored →
      exit 0. Currently reports **88 files in sync**.
- [x] Recovered `away_mode_192.png` / `away_mode_512.png`, which existed only
      in the Anvil checkout despite being referenced by `index.html:302`. They
      were never in the root tree, so a Pages deploy would have shipped a
      broken nav icon.

**Deliberately NOT done in Phase 1** — both items below break Anvil the moment
they land, so they belong with the Pages cutover in Phase 3:

1. **The module-URL rewrite** from `/_/theme/<f>?v=` to `/assets/js/<f>?v=`.
   Anvil serves those paths. Must land atomically across `sw.js`,
   `standard-page.html` modulepreloads, `index.html` script tags,
   `narration_runtime_loader.js` imports, and the pins in
   `tests/pocket_acceleration.test.mjs`,
   `tests/non_security_audit_fixes.test.mjs`, and
   `tools/smoke_pocket_worker_runtime.mjs`.

2. **Converting `index.html` into a real HTML document.** This is bigger than
   "strip a wrapper" — measured 2026-07-26, the file is 92,443 bytes and is
   *not* HTML at all. The entire page is stored inside a `prop:html` attribute
   of a single `<anvil-form container="HtmlTemplate">` element, so every
   internal quote is escaped: **2,906 `&quot;` and exactly one real
   quoted attribute** (the wrapper's own). Conversion requires: unwrap the
   `<anvil-form>` element, unescape all 2,906 entities, rewrite the 31
   `_/theme/` references, and add the `<!DOCTYPE html>`/`<head>` document shell
   that Anvil currently supplies (meta, title, manifest, icon links). The
   result is **not** re-syncable to Anvil without re-escaping, which is why it
   cannot land before cutover. The inline early-click stubs in the first inline
   script must survive the transformation — they exist so nothing throws before
   the modules load.

### Phase 2 — Backend continuity — DONE 2026-07-26
- [x] `backend/` is the source of truth; the HF Space is a push target.
      `tools/verify_release_parity.mjs` reports clean (it had been broken by
      the Phase 1 path rewrite in two places — concatenating nested source
      paths onto Anvil's flat layout, and looking for the worker entrypoint
      under `backend/` after it moved to `worker/`).
- [x] `.github/workflows/test.yml` — suite on push/PR. **Green: 149 tests,
      0 fail, 3 skipped.** The 3 skips are the anvil-app mirror assertions,
      which cannot run in CI because `anvil-app` is a bare gitlink; they still
      run locally, where they guard pre-deploy drift.
- [x] `.github/workflows/deploy-backend.yml` — syncs `backend/` → HF Space on
      changes under `backend/**`. Currently fails fast and loudly on the
      `Require HF_TOKEN` guard, which is correct until the secret exists.
- [x] `Cross-Origin-Resource-Policy: cross-origin` — **already present** in
      `worker/cloudflare_worker.js` (lines 163 and 296). No change needed; the
      Phase 3 COEP prerequisite is satisfied.
- [x] Live route probe, all 200 and warm (99–679 ms): `/`, `/api/health`,
      `/api/library/curated`, `/api/vapid-public-key`, `/api/health/sites`,
      `/api/masterlist`.
- [x] Option B decided (see below); implementation deferred to after Phase 3.

- [x] **`HF_TOKEN` set and the deploy verified live 2026-07-26.** First real
      deploy published the relicensing (5 files: LICENSE, NOTICE,
      ATTRIBUTIONS.md, CHARACTER_LICENSE.md, README.md; +189/−222) as Space
      commit `129724f`. Confirmed on the live Space: `LICENSE` now serves the
      proprietary text and the README frontmatter reads `license: other`.
      `app.py`, `requirements.txt`, and `Dockerfile` were byte-identical, so no
      code shipped. A second run correctly took the no-op path and skipped the
      wait step. Space reached terminal stage `RUNNING` on `129724f`.

**Deploy-gate lesson (cost one false green).** The first deploy reported success
in **14 seconds** while the Space was in stage `RUNNING_BUILDING` — and it stayed
there for several more minutes. During an HF rebuild the OLD container keeps
serving `200 OK`, so polling `/api/health` alone certifies nothing and would
have greenlit a broken build. The gate now queries
`https://huggingface.co/api/spaces/{repo}` and requires `.sha` to equal the
commit just pushed AND `.runtime.stage` to be terminal `RUNNING` before probing
health, failing fast on `BUILD_ERROR`/`RUNTIME_ERROR`/`CONFIG_ERROR`/
`NO_APP_FILE`. **Never gate an HF Space deploy on an app-level health endpoint
alone.**

**LFS discipline (protects the no-spend rule).** The 20 `curated_library` PDFs
are the repo's only Git LFS objects (~32 MB). Both workflows check out with
`lfs: false`, and the deploy excludes `curated_library/`, so **CI never spends
metered LFS bandwidth**. Those PDFs change rarely; when they do, sync them into
the Space manually. The deploy also excludes `tools/` and `reports/`
(maintainer-only, not runtime app code) and `.wrangler/` — a local Cloudflare
credential cache that must never reach a public Space — with a guard step that
fails the run if any credential-shaped file is staged.

#### The HF visibility problem

`alpharius6769/Pocket_Reader` is a **public** Space, so its full source —
scrapers, parsers, route logic — is browsable at
`huggingface.co/spaces/alpharius6769/Pocket_Reader/tree/main`. It has to stay
public *as currently wired*, because the browser calls it directly and
unauthenticated (`api_core.js:2`); a private Space requires a bearer token on
every request, and a frontend cannot hold a secret.

So "private GitHub repo" does not by itself make the backend private. Going
proprietary still protects you legally — that's the source-available model — but
the code remains readable. Two ways out, both free:

- **Option A (accept it).** Backend source stays public; LICENSE forbids reuse.
  Zero work. Frontend + auth + everything else still goes private.
- **Option B (Worker-proxied private Space).** Make the Space private, store an
  HF read token as a Cloudflare Worker secret, and proxy `/api/*` through the
  Worker you already run. The browser talks to the Worker (public); the Worker
  talks to the Space (authenticated). Backend source becomes fully private, and
  as a bonus the API moves same-origin-ish behind Cloudflare, which helps the
  Phase 3 COEP work and lets you drop `ALLOWED_ORIGINS` CORS juggling.
  Cost: one extra hop, and API traffic now counts against the Worker free tier
  (100k req/day — comfortable at current scale, worth watching).

**DECIDED 2026-07-26: Option B.** The Space goes private and the Cloudflare
Worker proxies `/api/*` with an HF read token held as a Worker secret. Sequenced
after Phase 3 is stable — it changes the request path for every API call and
must not be in flight during the frontend move.

#### CORS trap — `ALLOWED_ORIGINS` lives in THREE places

All three currently name only Anvil. Miss one and the Pages frontend is
CORS-blocked with no obvious culprit. Add `https://pocket-reader-f2y.pages.dev`
to every one before the cutover:

1. **HF Space variable** `ALLOWED_ORIGINS` (Space Settings → Variables).
2. **`backend/app.py:85`** — `DEFAULT_ALLOWED_ORIGINS` hardcodes
   `https://hot-wiry-raven.anvil.app,https://vu5ls67qwlzkeklw.anvil.app` as the
   fallback used whenever the env var is empty. Easy to miss because the Space
   variable normally masks it.
3. **`worker/wrangler.toml`** — `[vars] ALLOWED_ORIGINS`, currently the single
   Anvil origin. Requires a `wrangler deploy` to take effect.

Keep the Anvil origins in all three during Phase 3 so both frontends work
simultaneously. **Strip them in Phase 5**, when the Anvil app is deleted
outright (maintainer decision 2026-07-26 — Anvil is not merely decommissioned,
the published app and the local checkout are both being removed).

Related, already confirmed present: the Space has a persistent storage bucket
mounted at `/data` (`alpharius6769/Pocket_Reader-storage`, read/write), which is
where `SUBSCRIPTIONS_DB` lives — so the deploy workflow's Space rebuilds do NOT
wipe push subscriptions.

### Phase 3 — Frontend live on Pages (Anvil still authoritative)

**Build + deploy done 2026-07-26; functional verification outstanding.**

- [x] `tools/convert_to_static.mjs` — idempotent, `--check` mode. Unwraps the
      `<anvil-form>`, unescapes, rewrites 45 `_/theme/` assets onto
      `/assets/**`, repoints the service-worker registration, and emits a real
      document with `standard-page.html` as its `<head>`.
- [x] `public/manifest.webmanifest` (Anvil auto-injected one; source had none)
- [x] `public/_headers` — caching + security, **no COOP/COEP** (see win #2)
- [x] Suite **154/154**, including new guards for the converted document, the
      `/sw.js` registration, the COOP prohibition, and manifest validity.
- [x] Deployed to preview `https://phase3-preview.pocket-reader-f2y.pages.dev`
      and verified live: correct headers, no COOP/COEP, no Anvil residue.
      (Immediately after deploy the edge returned 522 for ~30s — propagation,
      not a build fault. Retry before investigating.)
- [ ] **`ALLOWED_ORIGINS` — the app cannot talk to the backend until this is
      done in all three places** (see the CORS trap above). Until then the
      preview loads but every API call is blocked.
- [ ] Functional verification on a real browser + device: boot, story load,
      narration, threaded WASM under `?tts_fast=1`, caching, offline shell
- [ ] Ship the IndexedDB export/import path before production cutover
- [ ] Promote to the production branch

Note the conversion is a **one-way door**: `public/index.html` can no longer be
synced to Anvil. `tools/sync_to_anvil.ps1` now detects this, skips that one
file, and says so — Anvil's `form_template.html` is frozen at its
pre-Phase-3 state while JS/CSS/assets keep syncing.
- [ ] Deploy `public/` to Cloudflare Pages
- [ ] Point `PR_CONFIG.apiBase` (`api_core.js:2`) at HF as today — unchanged
- [ ] Auth still calls Anvil during this phase via a CORS shim, **or** run the
      Pages build unauthenticated for smoke-testing only
- [ ] Verify on real devices: SW registration at the new scope, COOP/COEP,
      threaded WASM, narration, caching, offline shell
- [ ] Keep Anvil live and untouched as rollback

#### Supabase state (verified live 2026-07-26)

```text
Project ref  dctjxeqjtctyvvrdlcxo
API base     https://dctjxeqjtctyvvrdlcxo.supabase.co
Publishable  sb_publishable_KUGiCZjxfxQb2eQwOTQO0A_MY8ihwur
GoTrue       v2.193.1
Org / branch Alpharius' Arts (FREE) / main [PRODUCTION]
```

The publishable key is safe to ship in frontend JS — that is its purpose. RLS
policies, not key secrecy, are what enforce access. The `sb_secret_...` key must
never appear in the frontend or this repo.

Verified via `/auth/v1/settings`:

| Setting | State | Notes |
|---|---|---|
| email signup | **enabled** | matches Anvil |
| email confirmation | **required** (`mailer_autoconfirm: false`) | matches Anvil |
| signups | allowed | |
| **Google OAuth** | **DISABLED** | ⚠️ **blocks Phase 4** |

**⚠️ Google OAuth must be enabled before the auth cutover.** Anvil currently
authenticates users through Google (`anvil.yaml` loads
`/runtime/services/google.yml`), and the plan relies on re-linking those users
by email address. With Google disabled in Supabase, **every Google-authenticated
account is locked out at cutover** and cannot self-recover — they have no
password to reset. Required before Phase 4:

1. Google Cloud Console → APIs & Services → Credentials → create an **OAuth 2.0
   Client ID**, application type **Web application**.
2. Authorised redirect URI (exact):
   `https://dctjxeqjtctyvvrdlcxo.supabase.co/auth/v1/callback`
3. Authorised JavaScript origins: `https://pocket-reader-f2y.pages.dev` and
   `http://localhost:8788`. **No Anvil origin** — Supabase auth never runs on
   the Anvil frontend, which keeps Anvil Users until it is deleted.
4. Supabase Dashboard → Authentication → Providers → Google → paste the Client
   ID and Client Secret, enable.
5. Supabase → Authentication → URL Configuration → Site URL
   `https://pocket-reader-f2y.pages.dev`; Redirect URLs
   `https://pocket-reader-f2y.pages.dev/**` and `http://localhost:*/**`.
6. Re-verify with `/auth/v1/settings` that `external.google` is `true`.

Observed in the Google Cloud project 2026-07-26:
- It already holds an OAuth client **"Alpharius' Desktop Reader", type
  Desktop**, which is unusable for Supabase (Desktop clients permit only
  loopback redirects) and belongs to the separate Pocket Reader Desktop
  project. **Create a second Web application client; do not modify or delete
  the Desktop one.**
- **Publishing status is the classic failure.** A consent screen left in
  *Testing* admits only explicitly listed test users — everyone else gets
  `403: access_denied`. It must be **Published**. No Google verification review
  is required, since `email`/`profile`/`openid` are non-sensitive scopes.

Note the Supabase project uses **branching**, with `main` marked PRODUCTION.
Given a real user base, rehearse the Anvil profile import on a preview branch
before applying migrations to `main`.

### Phase 4 — Auth cutover (the risky one)
- [ ] Export Anvil `user_profiles` + user rows (Anvil Uplink script)
- [ ] Import into Supabase; Google OAuth users re-link automatically by email
- [ ] Email/password users **cannot** have hashes migrated → forced reset flow
      plus advance notice in-app
- [ ] Port `sync_user_profile` to a Supabase Edge Function with a serializable
      transaction; port `save/load_user_avatar` (avatar stays in a server-only
      column, ≤512px WebP ~256 KB, as today)
- [ ] Ship `supabase_bridge.js`; delete the Anvil bridge
- [ ] Dual-write window: both Anvil and Supabase accept syncs, so rollback
      stays possible for at least one release
- [ ] Anvil still running at the end of Phase 4 — deletion is Phase 5

### Phase 5 — Delete Anvil entirely

Maintainer decision 2026-07-26: the published Anvil app **and** the local
checkout are being removed outright, not merely bypassed. That makes this the
point of no return, so the ordering below matters.

**⚠️ Before deleting anything on Anvil**

1. [ ] **Export the Data Tables and keep the dump.** Deleting the Anvil app
       destroys `user_profiles` — every profile, avatar blob, and sync clock.
       Once gone there is no recovery and no support path. Export via Anvil
       Uplink to JSON, verify the row count matches the Supabase import, and
       archive it off-machine for at least one release cycle.
2. [ ] Confirm Supabase has been the sole write authority for a full release,
       with no rollback to Anvil pending.
3. [ ] Verify every migrated account can sign in — **Google users especially**,
       since they have no password to fall back on.

**User-facing consequences to announce in advance**

- Deleting the app kills `hot-wiry-raven.anvil.app`. Any bookmark, shared link,
  or **installed PWA** pointing there breaks permanently — an installed PWA is
  bound to its origin and cannot be redirected.
- Combined with the origin-scoped IndexedDB loss (see Known migration costs),
  users must reinstall from `pocket-reader-f2y.pages.dev` **and** re-cache any
  narration they want offline. Give notice inside the app before cutover, not
  after.
- Consider leaving the Anvil app up but empty for a grace period, serving only
  a redirect notice, before deleting the account.

**Then delete, in this order**

4. [ ] Delete the published Anvil app from the Anvil dashboard.
5. [ ] Remove the local checkout `anvil-app/` and the `_/theme/` mirror.
6. [ ] Delete the now-orphaned Anvil sources: `FrontEnd_code.py`,
       `Server_code.py`, `serviceworker.py`, `anvil.yaml`.
       **`serviceworker.py` only after** `public/sw.js` is the live worker —
       it is currently the canonical copy that `sw.js` is checked against.
7. [ ] Delete `tools/sync_to_anvil.ps1` (transitional tooling).
8. [ ] Drop the root repo's `anvil-app` gitlink (mode 160000, no `.gitmodules`).
9. [ ] Strip the Anvil origins from all three `ALLOWED_ORIGINS` locations
       (Space variable, `backend/app.py` `DEFAULT_ALLOWED_ORIGINS`,
       `worker/wrangler.toml` + `wrangler deploy`).

**Test suite changes this forces**

10. [ ] Delete the three anvil-app mirror assertions (in
        `migration_parity.test.mjs`, `ui_reload_and_upload_fixes.test.mjs`,
        `background_reliability.test.mjs`) — they become permanently skipped
        dead weight.
11. [ ] Rewrite the `public/sw.js` ↔ `serviceworker.py` parity test: with the
        Python endpoint gone, `sw.js` is the only copy and the guard is moot.
        Replace it with a check that `sw.js` and the precache list agree.
12. [ ] Update `tools/verify_release_parity.mjs` to drop the anvil-app leg
        entirely.

**Docs**

13. [ ] Rewrite `AGENT_HANDOFF_MASTER.md` §1 (hosting), §2 (release state), and
        the deploy sections; the commit SHAs there are already stale from the
        history purge.
14. [ ] Retire the `anvil-deploy-path` agent memory note.
15. [ ] Reconsider removing the `?tts_fast=1` isolation reload and the
        anti-flash mask (architectural win #2), once header isolation is
        confirmed on real devices.

## Known migration costs

**IndexedDB is origin-scoped.** Moving from `hot-wiry-raven.anvil.app` to
`pocket-reader-f2y.pages.dev` means every existing user loses locally cached stories and
generated audio — potentially hundreds of MB of narration that took hours to
synthesize. Mitigations:
- Ship an **export/import path for cached audio + library** before Phase 3.
- Treat `pocket-reader-f2y.pages.dev` as permanent. A custom domain would be a second
  origin change (and costs money, so it's out of scope under the no-spend rule).

**Forced password reset** for email/password accounts at Phase 4. Unavoidable —
Anvil's password hashes are not portable into Supabase GoTrue.

**Installed PWAs break permanently at Phase 5.** A PWA installed from
`hot-wiry-raven.anvil.app` is bound to that origin; deleting the Anvil app
leaves those installs pointing at nothing, with no redirect possible. Anyone who
added Pocket Reader to a home screen must reinstall from
`pocket-reader-f2y.pages.dev`. Announce in-app before cutover — after deletion
there is no channel left to reach those users through.

## Licensing position (audited 2026-07-26)

Dependency stack is clean for commercial use: MIT, BSD-3, ISC, Apache-2.0,
OFL-1.1, HPND, CC0. `pywebpush` is MPL-2.0 (file-level copyleft; unmodified use
is fine). Game-Icons.net achievement icons are CC-BY-3.0 — **attribution must
stay visible** even after going proprietary. `.mobi`/`.azw` remain unsupported
to avoid GPL/AGPL parsers; keep it that way.

Going proprietary is fully within the maintainer's rights as sole copyright
holder. It applies to **future** versions only — anyone who already received an
Apache-2.0 build retains those rights to that build, irrevocably.

The genuine ceiling on commercialization is **not** a license, it's third-party
terms of service: AO3 and Wattpad prohibit commercial exploitation of their
content, and the 20 bundled `curated_library` PDFs are authored by others.
Re-hosting changes none of that.

## Open questions — all resolved 2026-07-26

1. **Rayne provenance — RESOLVED, no restriction.** Confirmed by the maintainer
   as an AI-generated voice he created himself, free to use. It is a
   documentation gap only. **TODO:** add a Rayne entry to `ATTRIBUTIONS.md`
   (author: Chris, AI-generated, project-owned) so the default voice is
   inventoried alongside the six Voice-Zero voices.
2. **HMOFA masterlist — RESOLVED.** Continued use post-move is covered.
3. **Supabase 7-day pause — RESOLVED, acceptable.** No keep-alive ping needed.
