// Guards for the curated-library split, first-run modal, cache manager,
// diagnostics clarity, and the feedback link.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(p, 'utf8');

test('curated stories do not unlock First Edition or Hoarder', async () => {
  // Twenty stories ship in every library at launch. Counting them handed out
  // First Edition and Hoarder Bronze/Silver for installing the app.
  const source = await read('public/assets/js/library_manager.js');
  assert.match(source, /export function isCuratedStory/);
  assert.match(source, /const ownLibrary = window\.userProfile\.library\.filter\(\(s\) => !isCuratedStory\(s\)\)/);
  assert.match(source, /stats\.firstStory = ownLibrary\.length > 0/);
  assert.match(source, /stats\.unread = ownLibrary\.filter/);
  // Favourites still counts the whole library on purpose: favouriting a
  // curated story is a deliberate act by the reader.
  assert.match(source, /stats\.favorites = window\.userProfile\.library\.filter/);
});

test('the curated tag is backfilled onto older profiles', async () => {
  // Profiles created before the tag existed hold these stories untagged, which
  // would keep them counting toward achievements and hide them from the tab.
  const source = await read('public/assets/js/library_manager.js');
  assert.match(source, /if \(existing\.source !== 'curated'\)[\s\S]{0,120}existing\.source = 'curated'/);
});

test('the Library has a Curated shelf and All still means all', async () => {
  const html = await read('public/index.html');
  const source = await read('public/assets/js/library_manager.js');
  assert.match(html, /data-filter="curated"/);
  assert.match(source, /filter === 'curated'\) library = library\.filter\(\(s\) => isCuratedStory\(s\)\)/);
  // The ask was for a tab, not for hiding the bundled stories everywhere else.
  assert.doesNotMatch(source, /filter !== 'curated'[\s\S]{0,80}!isCuratedStory/);
});

test('the first view a reader lands on gets its entry work', async () => {
  // home-view is pre-marked active-view in the shell and never routed through
  // showView(), so first-visit tips and the achievement check never ran until
  // the reader navigated away and back.
  const source = await read('public/assets/js/ui_controller.js');
  assert.match(source, /function _runInitialViewEntry/);
  assert.match(source, /document\.querySelector\('\.view\.active-view'\)/);
  assert.match(source, /_maybeShowPageTips\(viewId\)/);
  assert.match(source, /checkForNewAchievements/);
  // Must be deferred past module evaluation or the helpers are still undefined.
  assert.match(source, /setTimeout\(_runInitialViewEntry, 0\)/);
});

test('the welcome modal leads with the cloud account', async () => {
  const html = await read('public/index.html');
  const modal = html.slice(html.indexOf('id="first-time-setup-title"'), html.indexOf('id="setup-complete-btn"'));
  const cloudAt = modal.indexOf('setup-cloud-btn');
  const avatarAt = modal.indexOf('setup-avatar-upload');
  const usernameAt = modal.indexOf('setup-username');
  assert.ok(cloudAt > 0, 'the cloud account block must be inside the modal');
  assert.ok(cloudAt < avatarAt && cloudAt < usernameAt,
    'signing in first is what makes the rest of the form save to an account');
});

test('every profile field is offered at setup, and actually saved', async () => {
  const html = await read('public/index.html');
  const ui = await read('public/assets/js/ui_controller.js');
  for (const id of ['setup-fandom', 'setup-length', 'setup-mood']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} missing from the setup modal`);
  }
  // Collected but never persisted would be worse than not asking at all, and
  // the property names must match what the profile editor reads back.
  assert.match(ui, /p\.favoriteFandom = \(document\.getElementById\('setup-fandom'\)/);
  assert.match(ui, /p\.preferredLength = document\.getElementById\('setup-length'\)/);
  assert.match(ui, /p\.readingMood = document\.getElementById\('setup-mood'\)/);
  // And they must survive a reload of a half-finished setup.
  assert.match(ui, /'setup-fandom', 'setup-length', 'setup-mood'/);
});

test('cache manager pin and delete scan one story, not the whole store', async () => {
  // Both used to walk every chunk of every story and filter in JS, which is
  // what made the cache manager crawl once a few stories were fully cached.
  const source = await read('public/assets/js/storage_core.js');
  assert.match(source, /function _storyChunkRange/);
  assert.match(source, /openCursor\(_storyChunkRange\(storyTitle\)\)/);
  const rangeUses = [...source.matchAll(/openCursor\(_storyChunkRange\(/g)].length;
  assert.equal(rangeUses, 2, 'both pin and delete should use the narrowed range');
  // The exact check must survive: one ref can be a prefix of another.
  assert.match(source, /cursor\.value\?\.storyRef === storyTitle/);
});

test('the storage dialog paints before it starts aggregating', async () => {
  const source = await read('public/assets/js/storage_core.js');
  assert.match(source, /requestAnimationFrame[\s\S]{0,80}const rows = await getOfflineStoryUsage/);
});

test('Away Mode distinguishes an empty library from a fully queued one', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  const library = await read('public/assets/js/library_manager.js');
  assert.match(buffer, /if \(library\.length === 0\)/);
  assert.match(buffer, /Your library is still loading/);
  // And it must refill once the library arrives.
  assert.match(library, /_refreshAwayModeWithLibrary/);
  assert.match(library, /currentActiveView !== 'away-mode-view'/);
});

test('diagnostics explains a network failure instead of just "Failed to fetch"', async () => {
  const source = await read('public/assets/js/diagnostics.js');
  assert.match(source, /const describeError/);
  assert.match(source, /navigator\.onLine === false/);
  assert.match(source, /log\('FAIL', label, 'FAIL', describeError\(e\)\)/);
  // Defined before timedTest uses it, or non-network failures hit a TDZ.
  assert.ok(source.indexOf('const describeError') < source.indexOf('const timedTest'),
    'describeError must be initialised before timedTest references it');
});

test('Settings offers a feedback link that opens safely', async () => {
  const html = await read('public/index.html');
  const link = html.match(/<a[^>]*docs\.google\.com\/forms[^>]*>/)?.[0] || '';
  assert.ok(link, 'the feedback link must exist in Settings');
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/,
    'a target=_blank link without noopener hands the opener to the other page');
});

test('the Anthronomicon panel explains what tapping a story actually does', async () => {
  // This used to tell readers to copy a link out of the frame and paste it
  // back, because a cross-origin iframe swallows its own clicks. The catalog is
  // rendered natively now, so tapping really does load the story -- but the
  // banner may only promise that while a handler is actually wired to it.
  const html = await read('public/index.html');
  const list = await read('public/assets/js/hmofa_masterlist.js');
  assert.match(html, /Tap any story below/i);
  assert.doesNotMatch(html, /App Interceptor Active/);
  assert.match(list, /_handleHmofaStoryIntercept/,
    'the card action must route through the shared story-load handler');
  // Not everything is in the catalog, so the paste box has to survive.
  assert.match(html, /id="hmofa-url-input"/);
});

// The stored profile has to be read back at boot, and nothing did.
//
// loadLocalData() had NO callers anywhere in the repo. Its only caller had been
// FrontEnd_code.py in the Anvil host, and when the frontend was restructured
// into public/ and Anvil was dropped, the module came across and the boot call
// did not. Measured in a browser: a guest wrote displayName, library and
// settings to pocketReaderData correctly, and after a reload window.userProfile
// was the empty default while the good copy sat unread in localStorage.
test('the stored profile is read back at boot', async () => {
  const source = await read('public/assets/js/library_manager.js');

  // A caller that is not the definition or the window assignment.
  const callers = [...source.matchAll(/(^|[^.\w])loadLocalData\(\)/gm)]
    .filter((m) => !source.slice(Math.max(0, m.index - 40), m.index).includes('function'));
  assert.ok(callers.length > 0, 'loadLocalData() must actually be invoked somewhere');
  assert.match(source, /async function _hydrateLocalProfile\(\)/);
  assert.match(source, /window\.__pocketProfileHydration = /,
    'hydration must be kicked off by this module, not by a user action');
  // It must wait for DOMContentLoaded, though: loadLocalData refreshes the UI
  // through initSettingsUI / applySettings / updateDisplayName, all of which
  // live in settings_manager.js, which index.html loads AFTER this module.
  // Running at module-evaluation time made every one of those typeof guards
  // false, so the profile hydrated but the reader's name still read
  // "Guest Reader". Safe to wait because _flushLocalData refuses to write
  // until the latch releases.
  assert.match(source, /document\.readyState === 'loading'[\s\S]{0,220}DOMContentLoaded/,
    'hydration must wait for the later modules to define their globals');
});

test('a save cannot run before the stored profile has been read back', async () => {
  const source = await read('public/assets/js/library_manager.js');

  // _flushLocalData serialises whatever is in memory. Before hydration that is
  // the empty default, so an early save is not a save, it is a deletion -- the
  // library was destroyed a moment after being made invisible.
  const flush = source.slice(
    source.indexOf('function _flushLocalData(options = {}) {'),
    source.indexOf('function _flushLocalData(options = {}) {') + 400,
  );
  assert.match(flush, /if \(!_profileHydrated\) \{\s*\n\s*_saveDeferredDuringHydration = true;\s*\n\s*return;/,
    'a save before hydration must be deferred, never written');

  // The latch has to release even when hydration throws, or one bad read would
  // block every future write for the life of the page.
  const hydrate = source.slice(
    source.indexOf('async function _hydrateLocalProfile()'),
    source.indexOf('window.__pocketProfileHydration'),
  );
  assert.match(hydrate, /finally \{[\s\S]{0,80}_profileHydrated = true;/,
    'the latch must release in a finally, not only on success');
  assert.match(hydrate, /_saveDeferredDuringHydration[\s\S]{0,120}saveLocalData\(\{ immediate: true \}\)/,
    'a deferred save must be flushed once hydration settles, not dropped');
  // The first renderLibrary() has already run against the empty default.
  assert.match(hydrate, /window\.renderLibrary\?\.\(true\)/,
    'the shelf must repaint, or restored stories stay invisible');
});

test('the boot chain that hangs off the profile read is still intact', async () => {
  const source = await read('public/assets/js/library_manager.js');
  const body = source.slice(
    source.indexOf('export async function loadLocalData()'),
    source.indexOf('window.loadLocalData = loadLocalData;'),
  );
  assert.ok(body.length > 500, 'loadLocalData body must be locatable');
  // These all live INSIDE loadLocalData, so the missing call disabled every one
  // of them for everyone, not just local persistence.
  for (const step of ['seedCuratedLibrary()', 'checkCloudSyncOnStartup', '_loadUserAvatar', 'pr_engine_auto_detected']) {
    assert.ok(body.includes(step), `${step} must still run as part of the profile read`);
  }
});
