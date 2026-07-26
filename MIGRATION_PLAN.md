# Pocket Reader — Anvil Decommission & GitHub Migration Plan

Created: 2026-07-26. Status: **Phase 0 — not yet started.**

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

2. **Possibly delete the `?tts_fast=1` isolation reload.** Cross-origin
   isolation is currently won by the service worker re-injecting COOP/COEP
   (`buffer_manager.js:146`), which forces a full page reload — and that reload
   is the root cause of the story-load Home flash the anti-flash mask in
   `standard-page.html` exists to paper over. Cloudflare Pages can set COOP/COEP
   directly via `public/_headers`, so isolation could hold from the first paint.

   Caveat: `COEP: require-corp` breaks cross-origin subresources that lack CORP.
   Audit first — the CF Worker (B2 model assets) needs
   `Cross-Origin-Resource-Policy: cross-origin` added, and the jsDelivr Motion
   import must be CORS-clean. `COEP: credentialless` is the lower-risk option.
   **Keep the SW fallback path** until real-device telemetry confirms header
   isolation holds; only then consider removing the reload and the mask.

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
- [ ] `gh auth login` — **still not authenticated.** The device flow was
      interrupted: `AppData\Local\GitHub CLI\` holds only `device-id` and no
      `hosts.yml`, so the browser authorised but the CLI never polled for and
      stored the token. Re-run and leave the terminal open until it prints
      `✓ Logged in as ...`.
- [ ] Create private GitHub repo `pocket-reader` (blocked on gh auth)
- [x] Supabase project created — `https://dctjxeqjtctyvvrdlcxo.supabase.co`
      (anon public key still needed; goes into frontend config at Phase 4)
- [x] Cloudflare Pages project named `pocket-reader` → permanent origin
      **`pocket-reader.pages.dev`**

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
- [ ] Move files into the target layout; delete duplicate copies
- [ ] Rewrite the 26 precached module URLs in `sw.js` from `/_/theme/<f>?v=`
      to `/assets/js/<f>?v=` — plus `standard-page.html` modulepreloads,
      `index.html` script tags, `narration_runtime_loader.js` imports, and the
      test pins in `tests/pocket_acceleration.test.mjs`,
      `tests/non_security_audit_fixes.test.mjs`,
      `tools/smoke_pocket_worker_runtime.mjs`
- [ ] Strip the Anvil form wrapper from `index.html`; the inline early-click
      stubs in the first inline script must survive
- [ ] Full suite green (15 files, `node --test tests/*.test.mjs`)

### Phase 2 — Backend continuity
- [ ] `backend/` becomes source of truth; HF Space becomes a push target
- [ ] GitHub Action deploys to HF on merge to main
- [ ] Add `Cross-Origin-Resource-Policy: cross-origin` to the CF Worker
      (prerequisite for Phase 3 header isolation)
- [ ] Verify all 23 routes still serve
- [ ] **Decide: public Space vs Worker-proxied private Space** (see below)

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

### Phase 3 — Frontend live on Pages (Anvil still authoritative)
- [ ] Deploy `public/` to Cloudflare Pages
- [ ] Point `PR_CONFIG.apiBase` (`api_core.js:2`) at HF as today — unchanged
- [ ] Auth still calls Anvil during this phase via a CORS shim, **or** run the
      Pages build unauthenticated for smoke-testing only
- [ ] Verify on real devices: SW registration at the new scope, COOP/COEP,
      threaded WASM, narration, caching, offline shell
- [ ] Keep Anvil live and untouched as rollback

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
- [ ] Decommission Anvil; delete `anvil-app/` and the `_/theme/` mirror

### Phase 5 — Cleanup
- [ ] Rewrite `AGENT_HANDOFF_MASTER.md` §1 and the deploy sections
- [ ] Retire `anvil-deploy-path` notes
- [ ] Consider removing the isolation reload + anti-flash mask (see win #2)

## Known migration costs

**IndexedDB is origin-scoped.** Moving from `hot-wiry-raven.anvil.app` to
`<project>.pages.dev` means every existing user loses locally cached stories and
generated audio — potentially hundreds of MB of narration that took hours to
synthesize. Mitigations:
- Ship an **export/import path for cached audio + library** before Phase 3.
- Treat `<project>.pages.dev` as permanent. A custom domain would be a second
  origin change (and costs money, so it's out of scope under the no-spend rule).

**Forced password reset** for email/password accounts at Phase 4. Unavoidable —
Anvil's password hashes are not portable into Supabase GoTrue.

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
