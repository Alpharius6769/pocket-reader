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

test('the Anthronomicon panel explains what tapping a link actually does', async () => {
  // The iframe is cross-origin, so a click that navigates it cannot be read
  // back — promising tap-to-fetch there would be a lie until the index
  // implements the bridge protocol.
  const html = await read('public/index.html');
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(html, /Copy link/i);
  assert.match(ui, /Copy link/i);
  assert.doesNotMatch(html, /App Interceptor Active/);
});
