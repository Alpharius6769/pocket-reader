import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('startup avoids hidden diagnostics polling and eager library rendering', async () => {
  // The three assertions that guarded FrontEnd_code.py are gone with the file:
  // the Anvil form no longer exists, so it cannot poll or eagerly render. The
  // equivalent guard for the shell that replaced it is below.
  const html = await read('public/index.html');
  const library = await read('public/assets/js/library_manager.js');
  assert.doesNotMatch(html, /setInterval\(\s*window\.refreshPerfPanel/);
  assert.doesNotMatch(library, /generateChunk\('\.'/);
  assert.doesNotMatch(library, /requestIdleCallback\(\(\) => \{\s*renderLibrary/);
});

test('narration stays deferred while runtime and UI modules use canonical URLs', async () => {
  const html = await read('public/index.html');
  const loader = await read('public/assets/js/narration_runtime_loader.js');
  const serviceWorker = await read('public/sw.js');
  const tagVersion = (source, module) =>
    source.match(new RegExp(`${module}\\.js\\?v=([a-z0-9-]+)`))?.[1];
  // Heavy narration modules must not be executable script tags in the form
  // template. The loader and SW may share one canonical URL without parsing the
  // runtime during ordinary startup.
  for (const module of ['audio_core', 'buffer_manager']) {
    assert.doesNotMatch(html, new RegExp(`<script[^>]+${module}\\.js`));
    const loaderVersion = tagVersion(loader, module);
    assert.ok(loaderVersion, `${module} dynamic import missing from narration loader`);
    assert.equal(tagVersion(serviceWorker, module), loaderVersion,
      `${module}: serviceworker precache differs from narration loader`);
  }
  for (const module of ['ui_controller', 'narration_runtime_loader']) {
    const pageTag = tagVersion(html, module);
    assert.ok(pageTag, `${module} script tag missing from FrontEnd_html.html`);
    assert.equal(tagVersion(serviceWorker, module), pageTag,
      `${module}: serviceworker precache differs from form-template tag`);
  }
  assert.match(loader, /ensureNarrationRuntime/);
  const deferredActions = loader.match(/const DEFERRED_NARRATION_ACTIONS = \[[\s\S]*?\];/)?.[0] || '';
  assert.doesNotMatch(deferredActions, /onSpeedSliderInput/);
  // There is no speed slider or label in the app. The handler that used to
  // mirror slider input into a label is gone; playback speed comes from the
  // profile/preset via audio_core's getEffectivePlaybackRate().
  assert.doesNotMatch(loader, /onSpeedSliderInput/);
});

test('service worker uses bounded navigation and lifetime-protected cache writes', async () => {
  const source = await read('public/sw.js');
  assert.match(source, /pocket-reader-core-v\d+/);
  // Navigation must stay bounded, and the bound must stay short enough that a
  // stalled mobile network never shows a long blank screen before the cached
  // shell appears. The exact value may be tuned; the ceiling is the invariant.
  const navTimeout = Number(source.match(/fetchWithTimeout\(event\.request,\s*(\d+)\)/)?.[1]);
  assert.ok(Number.isFinite(navTimeout), 'navigation fetch must carry an explicit timeout');
  assert.ok(navTimeout <= 2500, `navigation timeout ${navTimeout}ms is too long for a stalled mobile network`);
  assert.match(source, /event\.waitUntil\(updatePromise/);
  assert.match(source, /url\.searchParams\.has\('v'\)/);
});

test('onboarding and hidden controls are accessibility-isolated', async () => {
  const html = await read('public/index.html');
  const setup = await read('public/assets/js/device_setup.js');
  const ui = await read('public/assets/js/ui_controller.js');
  const virtue = await read('public/assets/js/virtue_controller.js');
  assert.match(html, /id="first-time-setup-modal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(setup, /activatePocketModal/);
  assert.match(setup, /deactivatePocketModal/);
  assert.match(ui, /_syncNavMoreAccessibility/);
  assert.match(virtue, /_syncVirtueAccessibility/);
});

test('uploads use a size-aware deadline and always clear timers', async () => {
  const source = await read('public/assets/js/api_core.js');
  const upload = source.match(/export async function processUploadedFile[\s\S]*?\n}\r?\nwindow\.processUploadedFile/)?.[0] || '';
  assert.match(upload, /uploadTimeoutMs/);
  assert.match(upload, /Math\.min\(\s*240000/);
  assert.match(upload, /finally\s*\{\s*clearTimeout\(timeoutId\)/);
  assert.doesNotMatch(upload, /controller\.abort\(\), 15000/);
});

test('backend database durability and health refresh are fail-visible and singleflight', async () => {
  const source = await read('backend/app.py');
  assert.match(source, /ALLOW_EPHEMERAL_DB/);
  assert.match(source, /database_durable/);
  assert.match(source, /SITE_HEALTH_REFRESH_LOCK/);
  assert.match(source, /client\.stream\("GET", url\)/);
});

test('narration defaults to natural speed and an emotion-aware profile', async () => {
  const tuning = await read('public/assets/js/tts_pronunciation_core.js');
  const library = await read('public/assets/js/library_manager.js');
  const features = await read('public/assets/js/reader_features.js');
  const html = await read('public/index.html');

  assert.match(tuning, /DEFAULT_POCKET_PLAYBACK_SPEED = 1(?:\.0)?;/);
  assert.match(library, /voiceEmotionMode:\s*"balanced"/);
  assert.match(features, /_migratedEmotionBalanced/);
  assert.match(html, /<option value="balanced" selected>/);
});

test('stored AO3 export front matter is removed before narration', async () => {
  const storage = await read('public/assets/js/storage_core.js');
  const ui = await read('public/assets/js/ui_controller.js');

  assert.match(storage, /function _isNarrationFrontMatterChapter/);
  assert.match(storage, /preface/);
  assert.match(storage, /posted\\s\+originally\\s\+on\\s\+the\\s\+archive\\s\+of\\s\+our\\s\+own/i);
  assert.match(ui, /storyAuthor/);
  assert.match(ui, /chapter\|part\|book/);
});
