// Guards for the companion layout, in-app notices, and the Anthronomicon bridge.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(p, 'utf8');

test('Virtue speech never shrinks below a legible size', async () => {
  // The old fitter stepped down to 5.5px, which is unreadable on any screen and
  // worst on the phones where the bubble is smallest — "fitted" and invisible.
  const source = await read('public/assets/js/virtue_controller.js');
  const floor = Number(source.match(/MIN_FONT_PX\s*=\s*_isMobileViewport\(\)\s*\?\s*([\d.]+)/)?.[1]);
  assert.ok(Number.isFinite(floor), 'a legibility floor must be defined');
  assert.ok(floor >= 8, `mobile floor ${floor}px is below readable size`);
  assert.doesNotMatch(source, /const minimum = 5\.5/);
  // Overflow past the floor clamps instead of shrinking further.
  assert.match(source, /clamped-text/);
});

test('Virtue geometry uses the sprite ratio and a Range overflow probe', async () => {
  const source = await read('public/assets/js/virtue_controller.js');
  const css = await read('public/assets/css/theme.css');
  assert.match(source, /setProperty\('--virtue-ratio'/);
  assert.match(css, /44vh \* var\(--virtue-ratio/);
  assert.match(css, /38vh \* var\(--virtue-ratio/);
  assert.match(source, /measureRange\.getBoundingClientRect\(\)/);
});

test('Virtue text fitting does not thrash layout', async () => {
  // fit() runs multiple times per appearance and again on every resize, and
  // each iteration is a forced synchronous reflow (style write, then a
  // scrollHeight read). The old linear 0.3px walk allowed 35 of them per call.
  const source = await read('public/assets/js/virtue_controller.js');
  assert.doesNotMatch(source, /attempts\+\+ < 35/, 'linear shrink loop must be gone');
  assert.match(source, /Binary search/i);
  const iterations = Number(source.match(/for \(let i = 0; i < (\d+) && hi - lo/)?.[1]);
  assert.ok(iterations && iterations <= 10, `binary search should converge in <=10 steps, got ${iterations}`);
});

test('the Virtue resize observer cannot feed back or leak', async () => {
  // It observes the very element whose font-size the callback rewrites.
  const source = await read('public/assets/js/virtue_controller.js');
  assert.match(source, /fitScheduled/, 'resize handling must be coalesced into a frame');
  assert.match(source, /_virtueFitObserver\?\.disconnect\(\)/,
    'the observer must disconnect when the companion is off screen');
});

test('the mobile companion clears the bottom tab bar', async () => {
  // With the tab bar sitting flush at 58px / 52px at the bottom of the screen,
  // Virtue companion clears the tab bar directly with standard offsets.
  const css = await read('public/assets/css/theme.css');
  const rules = [...css.matchAll(/\.virtue-container\.active\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(rules.length >= 2, 'expected a desktop and at least one mobile companion rule');
  const withBottom = rules.filter((body) => /bottom:/.test(body));
  assert.ok(withBottom.length > 0, 'no mobile rule offsets the companion above the tab bar');
  for (const body of withBottom) {
    assert.match(body, /bottom:\s*(?:64px|58px);/,
      `companion offset does not clear the tab bar: ${body.trim()}`);
  }
});

test('short status messages use the in-app notice, not a blocking dialog', async () => {
  // alert() blocks the page, reads as a system failure inside an installed PWA,
  // and interrupts audio focus on iOS standalone.
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(ui, /export function pocketNotify/);
  assert.match(ui, /window\.virtueSpeak/, 'notices should route through the companion');
  assert.match(ui, /if \(typeof alert === 'function'\) alert\(text\)/,
    'a message must never be lost if the companion is unavailable');

  for (const file of ['public/assets/js/audio_core.js', 'public/assets/js/api_core.js']) {
    const source = await read(file);
    for (const gone of [
      "alert('No story loaded.')",
      "alert('Web Speech API not supported in this browser.')",
      "alert('Unsupported file type.')",
    ]) {
      assert.ok(!source.includes(gone), `${file} still raises a blocking dialog: ${gone}`);
    }
  }
});

test('below-the-fold imagery is deferred', async () => {
  const html = await read('public/index.html');
  const lazy = [...html.matchAll(/loading="lazy"/g)].length;
  assert.ok(lazy >= 5, `expected deferred images in hidden views, found ${lazy}`);
  // Nav icons and the landing header must stay eager — deferring those would
  // trade a real regression for a synthetic win.
  const navBlock = html.slice(html.indexOf('home%20192.png') - 200, html.indexOf('about%20192.png') + 200);
  assert.doesNotMatch(navBlock, /loading="lazy"/, 'visible nav icons must not be lazy');
});

// The masterlist used to embed the Anthronomicon in a cross-origin iframe and
// receive stories back over postMessage. That could never work while narrating:
// ?tts_fast=1 is served COEP require-corp, and a require-corp document refuses
// to nest one that does not assert the same policy. GitHub Pages sends no COEP
// header, so the frame was always blocked. The catalog is now fetched as JSON,
// which COEP does not constrain.
test('the masterlist renders natively instead of embedding the index', async () => {
  const html = await read('public/index.html');
  const ui = await read('public/assets/js/ui_controller.js');
  assert.doesNotMatch(html, /<iframe[^>]*id="hmofa-iframe"/,
    'the masterlist must not reintroduce the embed -- COEP blocks it during narration');
  assert.doesNotMatch(ui, /setupHmofaIframeBridge|pocket_reader_ping|pocket_reader_ready/,
    'the postMessage bridge is dead code once nothing is framed');
  assert.match(html, /id="hmofa-results"/, 'the native results grid must exist');
  assert.match(html, /id="hmofa-facets"/, 'the native facet rail must exist');
});

test('the catalog is fetched lazily and never pinned by the service worker', async () => {
  const list = await read('public/assets/js/hmofa_masterlist.js');
  const ui = await read('public/assets/js/ui_controller.js');
  const sw = await read('public/sw.js');

  // The published build, not the 5 MB curator file in the repo: `npm run build`
  // strips reviewer-only fields down to ~640 KB gzipped and emits it here.
  assert.match(list, /hmofa-story-index'/, 'the catalog base must point at the published index');
  assert.match(list, /\$\{CATALOG_BASE\}\/assets\/catalog\.json/,
    'the browser catalog under assets/ is the source');
  // ~640 KB gzipped is far too much to spend on every launch for a view most
  // sessions never open.
  assert.match(ui, /viewId === 'hmofa-view'[\s\S]{0,220}ensureHmofaMasterlistLoaded/,
    'the catalog must load on view open, not at app launch');

  // On the GitHub Pages build the index shares this origin, so catalog.json
  // matches the cache-first /assets/ branch and would be frozen forever.
  assert.match(sw, /url\.pathname\.indexOf\('\/hmofa-story-index\/'\) !== -1/,
    'the service worker must not cache-first the catalog');
  assert.match(sw, /cacheName === HMOFA_CATALOG_CACHE/,
    'activate() must preserve the catalog cache like the other data caches');
});

test('the vendored catalog layer stays pure so it can be diffed against upstream', async () => {
  const core = await read('public/assets/js/hmofa_catalog_core.js');
  const list = await read('public/assets/js/hmofa_masterlist.js');

  // Results must match the live index exactly. They only do so while this file
  // is a straight copy of upstream, which requires it to stay portable.
  for (const forbidden of ['document.', 'window.', 'localStorage', 'fetch(']) {
    assert.ok(!core.includes(forbidden),
      `hmofa_catalog_core.js must stay a pure data layer, found ${forbidden}`);
  }
  assert.match(core, /Upstream: Alpharius6769\/hmofa-story-index/,
    'the vendored copy must record where it came from');
  assert.match(core, /SHA-256:\s+[0-9a-f]{64}/,
    'the vendored copy must record the upstream hash it was taken from');

  // Reimplementing filtering here is how the two drift apart.
  assert.match(list, /filterCatalog|sortCatalog/,
    'the view must delegate filtering to the vendored layer');
});

test('batch import is sequential and bounded', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  const limit = Number(ui.match(/HMOFA_BATCH_LIMIT = (\d+)/)?.[1]);
  assert.ok(limit && limit <= 50, `batch limit ${limit} is too permissive for a phone`);
  // loadStory aborts any in-flight load, so parallel calls would cancel each
  // other and only the last would survive.
  assert.match(ui, /for \(const entry of entries\.slice\(0, -1\)\)[\s\S]{0,200}await window\.loadStory/);
  assert.match(ui, /await _handleHmofaStoryIntercept\(last\.url, last\.title\)/,
    'the last story must be awaited so it is counted after it actually loads');
  assert.match(ui, /preventNavigate: true/, 'batch imports must not drag the reader through each story');
});

test('Virtue does not greet the reader with "There\'s my good boy."', async () => {
  const source = await read('public/assets/js/virtue_controller.js');
  assert.doesNotMatch(source, /There's my good boy/);
});

test('Away Mode loads the narration runtime before painting the queue', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(ui, /viewId === 'away-mode-view'[\s\S]{0,500}ensureNarrationRuntime/);
  assert.match(ui, /ensureNarrationRuntime[\s\S]{0,220}renderAwayModeUI/);
  assert.match(ui, /Away Mode narration runtime failed to load[\s\S]{0,280}pocketNotify/,
    'a failed Away Mode load must tell the reader instead of failing silently');
});

test('the masterlist shares ratings and lists with the live Anthronomicon', async () => {
  const html = await read('public/index.html');
  const list = await read('public/assets/js/hmofa_masterlist.js');
  const community = await read('public/assets/js/hmofa_community.js');
  const prefs = await read('public/assets/js/hmofa_preferences.js');
  const merge = await read('public/assets/js/profile_merge.js');
  const sw = await read('public/sw.js');

  assert.match(html, /id="hmofa-open-preferences"/);
  assert.match(html, /id="hmofa-open-lists"/);
  assert.match(html, /id="hmofa-minrating"/);
  assert.match(html, /id="hmofa-view-tabs"/);

  assert.match(community, /catalog-api/);
  assert.match(community, /hmofa_device_id_v2/);
  assert.doesNotMatch(community, /cf-turnstile|turnstile\.render/,
    'rate and click must not pull in a Turnstile widget -- it cannot load under COEP');

  assert.match(prefs, /hmofa_user_prefs_v2/);
  assert.match(prefs, /hmofa_saved_lists_v1/);
  assert.match(prefs, /stampSyncedSetting/);
  assert.match(prefs, /hmofaPreferences/);
  assert.match(prefs, /hmofaSavedLists/);
  assert.match(list, /reconcileWithProfile/);

  assert.doesNotMatch(merge, /hmofaPreferences|hmofaSavedLists/,
    'HMOFA prefs and lists must sync with the profile, so they cannot sit in DEVICE_ONLY_SETTINGS');

  assert.match(sw, /hmofa_community\.js\?v=hmofa-community-v1/);
  assert.match(sw, /hmofa_preferences\.js\?v=hmofa-prefs-v2/);
});

test('the native masterlist keeps catalog freshness, URLs, prefs and lists honest', async () => {
  const list = await read('public/assets/js/hmofa_masterlist.js');
  const prefs = await read('public/assets/js/hmofa_preferences.js');
  const ui = await read('public/assets/js/ui_controller.js');

  assert.match(list, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(list, /config\?\.catalogSha256/);
  assert.match(list, /published === cached\.sha/);
  assert.doesNotMatch(list, /payload\.sha256/,
    'revalidation must hash the catalog bytes, not trust the payload digest');

  assert.match(list, /validateHttpUrl\(source\.url, source\.platform\) \|\| validateHttpUrl\(source\.url\)/);
  assert.match(list, /pr:profile-synced/);
  assert.match(list, /function applySyncedPreferences/);
  assert.match(list, /if \(state\.loaded\) \{[\s\S]{0,160}applySyncedPreferences\(\)/);
  assert.match(list, /refreshHmofaCatalog[\s\S]{0,500}loadCommunity\(\)/);
  assert.match(list, /communityTrending\.join\('\\0'\)[\s\S]{0,80}JSON\.stringify\(state\.communityRatings\)/);
  const rateStory = list.slice(list.indexOf('async function rateStory'), list.indexOf('function ratingRow'));
  assert.match(rateStory, /featuredCache = \{ key: null, ids: \[\] \}/,
    'a new rating must invalidate the featured rotation, not just the result cache');
  assert.match(list, /sort: state\.sort/);
  assert.match(list, /SORT_VALUES\.includes\(filters\.sort\)[\s\S]{0,40}state\.sort = filters\.sort/);
  assert.match(list, /if \(sort\) sort\.value = state\.sort/);
  assert.match(list, /function normalizeCatalogRecord/);
  assert.match(list, /communityLoading/);

  assert.match(prefs, /function attachPresetSort/);
  assert.match(prefs, /SORT_VALUES\.includes\(sort\)/);
  assert.match(prefs, /Saved lists keep a search, its filters and its sort together/);

  assert.match(ui, /return window\.loadStory\(url\)/);
});

test('the top bar clears the iOS notch and status bar safe areas while mobile navigation sits flush', async () => {
  const css = await read('public/assets/css/theme.css');
  // Desktop / tablet / mobile top-bar rules must all protect against top safe area encroachment
  assert.match(css, /\.top-bar\s*\{[^}]*min-height:\s*calc\(\d+px \+ env\(safe-area-inset-top/);
  assert.match(css, /\.top-bar\s*\{[^}]*padding:[^;]*env\(safe-area-inset-top/);

  // Mobile (<=600px) top-bar must size height and top padding with safe-area-inset-top
  const mobileBlock = css.match(/@media\s*\(max-width:\s*600px\)\s*\{([\s\S]*?)(?=\n\/\*|\n@media|$)/)?.[1] || '';
  assert.match(mobileBlock, /\.top-bar\s*\{[^}]*min-height:\s*calc\(52px \+ env\(safe-area-inset-top/);
  assert.match(mobileBlock, /\.top-bar\s*\{[^}]*padding:\s*calc\(4px \+ env\(safe-area-inset-top/);

  // Bottom navigation tab bar sits flush at 58px without empty dead buffer
  assert.match(mobileBlock, /\.sidebar\s*\{[^}]*height:\s*58px;/);
  assert.match(mobileBlock, /\.view-container\s*\{[^}]*padding-bottom:\s*68px;/);
});

test('100% cached stories display cached badges and fast reverification feedback on reopen', async () => {
  const css = await read('public/assets/css/theme.css');
  const lib = await read('public/assets/js/library_manager.js');
  const buf = await read('public/assets/js/buffer_manager.js');
  const api = await read('public/assets/js/api_core.js');

  // CSS cached badge styling
  assert.match(css, /\.story-status-badge\.cached\s*\{/);

  // Library manager badge logic
  assert.match(lib, /'100% Cached'/);
  assert.match(lib, /isCached \? 'cached' : ''/);
  assert.match(lib, /· Cached/);

  // Api core preserves isCached flag when loaded from local cache
  assert.match(api, /window\.currentStory\.isCached = !!\(existingLibEntry\.isCached \|\| existingLibEntry\.audioCached\)/);

  // Buffer manager reverification detection and UI
  assert.match(buf, /isReverifying: false/);
  assert.match(buf, /100% Cached Audio Found — verifying offline cache\.\.\./);
  assert.match(buf, /100% Cached Audio Found/);
  assert.match(buf, /✓ Offline audio intact — quickly verifying storage/);
  assert.match(buf, /this\._scheduleLoop\(gen, 0\)/);
});

