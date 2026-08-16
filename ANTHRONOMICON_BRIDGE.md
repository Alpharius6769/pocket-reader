# Anthronomicon in Pocket Reader

The HMOFA masterlist is rendered natively from the Anthronomicon's published
catalog. There is no iframe and no `postMessage` protocol.

## Why the embed was replaced

Pocket Reader used to embed `alpharius6769.github.io/hmofa-story-index/` and
receive stories back over `postMessage`. That arrangement could not survive a
narration session.

Starting narration reloads the app with `?tts_fast=1`, which the service worker
serves with `Cross-Origin-Embedder-Policy: require-corp` so SharedArrayBuffer
and threaded WASM are available. A `require-corp` document refuses to nest a
document that does not assert the same policy, and GitHub Pages sends no COEP
header. The frame was therefore always blocked while narrating, and nothing on
Pocket Reader's side could change that — the header has to come from the framed
origin.

Fetching the catalog as JSON is not subject to that rule. COEP constrains framed
documents and `no-cors` subresources; a same-origin or CORS fetch is unaffected.
The masterlist now works in a narration session, verified with
`crossOriginIsolated === true`.

## Where the data comes from

| | |
|---|---|
| Catalog | `https://alpharius6769.github.io/hmofa-story-index/assets/catalog.json` |
| Build metadata | `.../assets/config.json` (carries `catalogSha256`) |
| Size | ~2.7 MB raw, ~640 KB gzipped, 2,149 records |

This is the *published browser catalog*, not `catalog/catalog.json` in the index
repo. The upstream build strips reviewer-only fields (`summary`, `words`,
`updated`, and every `*Evidence` / `*Basis` key) before publishing.

On the GitHub Pages build this is the **same origin** as Pocket Reader, so no
CORS is involved at all. On Cloudflare Pages it is cross-origin and relies on
the `Access-Control-Allow-Origin: *` that GitHub Pages sends.

Loading is lazy: the catalog is fetched when the masterlist view is first
opened, never at launch.

### Caching

The parsed catalog is stored in a dedicated Cache API bucket,
`hmofa-catalog-v1`. A cached copy paints immediately and staleness is then
settled against the 343-byte `config.json` rather than by re-downloading 2.7 MB.

Two constraints keep this working:

- `sw.js` excludes `/hmofa-story-index/` by path. On GitHub Pages the catalog
  shares Pocket Reader's origin and would otherwise fall into the cache-first
  `/assets/` branch and be pinned forever with no revalidation.
- `sw.js` `activate()` preserves `hmofa-catalog-v1`, like the voice and model
  caches. Without that, every deploy would discard it.

## Files

| File | Role |
|---|---|
| `public/assets/js/hmofa_catalog_core.js` | Vendored upstream `src/catalog.js`. Do not hand-edit. |
| `public/assets/js/hmofa_masterlist.js` | Catalog loading, filter state, and all rendering. |
| `public/assets/js/hmofa_community.js` | Shared ratings, click tracking, and weekly trending via `catalog-api`. |
| `public/assets/js/hmofa_preferences.js` | Filters, blacklist, saved lists, and profile sync. |
| `#hmofa-view` in `public/index.html` | Toolbar, facet rail, results grid, pagination. |

### The vendored data layer

`hmofa_catalog_core.js` is a byte-for-byte copy of the index's `src/catalog.js`
with a provenance header recording the upstream commit and SHA-256. It is a pure
data layer — no DOM, no storage, no network — which is why it ports across
unchanged.

Keeping it identical to upstream is the point: search and filter results must
match the live index exactly. Behaviour changes belong upstream. To update,
re-copy the file and refresh the commit and hash in the header.

A test asserts the file stays free of `document.`, `window.`, `localStorage` and
`fetch(` so it cannot quietly grow a dependency that blocks the next update.

## Loading a story

Cards call the same handlers the old bridge used, so the story path is
unchanged:

```js
window._handleHmofaStoryIntercept(url, title);   // one story, opens the reader
window._handleHmofaStoryBatch([{ url, title }]); // a shelf; only the last opens
```

`_handleHmofaStoryBatch` is capped at 25 and imports sequentially — `loadStory`
aborts any load still in flight, so concurrent calls would cancel each other and
only the last would survive.

Every record is loadable: the catalog spans AO3 (1,841), SoFurry (258),
FurAffinity (88), Wattpad (7) and Royal Road (4), and the backend dispatcher
handles all five.

Adult FurAffinity and SoFurry works sit behind a sign-in wall. Upstream can only
warn that the link lands on a login page; Pocket Reader points at the fix
instead, because the scrape backend forwards the per-site cookies a reader
pastes into Settings.

## Reader preferences

On the GitHub Pages build both apps share an origin and therefore share
`localStorage`. The masterlist reads and writes the Anthronomicon's own keys, so
a blacklist edited in either app is in force in the other with no import step:

| Key | Contents |
|---|---|
| `hmofa_user_prefs_v2` | SFW/NSFW mode, worlds, blacklisted tags and POVs, tag-spam and Anon blocks |
| `hmofa_saved_lists_v1` | Named filter presets and picked-story lists |
| `hmofa_ui_prefs_v2` | Sort order, page size, and active tab |
| `hmofa_device_id_v2` | Voter identity for community ratings |
| `hmofa_user_ratings_v2` | This device's scores, so stars stay lit offline |

Those keys are per-origin, so on their own they would not follow a reader to a
second device. Pocket Reader mirrors `hmofa_user_prefs_v2` and
`hmofa_saved_lists_v1` into `userProfile.settings` as `hmofaPreferences` and
`hmofaSavedLists`, stamped through `stampSyncedSetting` so the clocked merge in
`profile_merge.js` carries them. A shadow copy (`pr_hmofa_sync_shadow_v1`)
settles newest-wins against edits made on the index, which writes the same
localStorage keys without touching Pocket Reader's clock.

Filters & Content and My Lists in the masterlist header edit these values
directly.

## Community ratings

Ratings, click counts, and Weekly Trending talk to the same backend the live
index uses:

`https://gupifxfvktfejqhfenml.supabase.co/functions/v1/catalog-api`

Production is `alpharius6769.github.io`. The browser sends that origin for
`/pocket-reader/` exactly as it does for `/hmofa-story-index/`, and the API's
allowlist already accepts it. Voter identity is the index's own device id, so a
reader is one voter across both apps rather than two.

`rate` and `click` do not call Turnstile. The three curator intake forms
(recommend, blacklist request, metadata correction) do, and they stay on the
index — `challenges.cloudflare.com` cannot load inside a `?tts_fast=1`
narration session. Open Live Site in the masterlist header is the way to those
forms.
