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
  const standardPage = await read('public/standard-page.html');
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
    assert.equal(tagVersion(standardPage, module), pageTag,
      `${module}: standard-page modulepreload differs from form-template tag`);
  }
  assert.match(loader, /ensureNarrationRuntime/);
  const deferredActions = loader.match(/const DEFERRED_NARRATION_ACTIONS = \[[\s\S]*?\];/)?.[0] || '';
  assert.doesNotMatch(deferredActions, /onSpeedSliderInput/);
  assert.match(loader, /window\.onSpeedSliderInput = function onSpeedSliderInput/);
});

test('service worker uses bounded navigation and lifetime-protected cache writes', async () => {
  const source = await read('public/sw.js');
  assert.match(source, /pocket-reader-core-v129/);
  assert.match(source, /fetchWithTimeout\(event\.request, 6000\)/);
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
