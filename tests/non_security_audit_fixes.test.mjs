import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('startup avoids hidden diagnostics polling and eager library rendering', async () => {
  const frontend = await read('FrontEnd_code.py');
  const library = await read('library_manager.js');
  assert.doesNotMatch(frontend, /setInterval\(window\.refreshPerfPanel/);
  assert.doesNotMatch(frontend, /window\.renderLibrary\(\)/);
  assert.doesNotMatch(frontend, /window\.renderAchievements\(\)/);
  assert.doesNotMatch(library, /generateChunk\('\.'/);
  assert.doesNotMatch(library, /requestIdleCallback\(\(\) => \{\s*renderLibrary/);
});

test('narration modules load on demand rather than in the initial module graph', async () => {
  const html = await read('FrontEnd_html.html');
  const loader = await read('narration_runtime_loader.js');
  assert.match(html, /narration_runtime_loader\.js\?v=narration-loader-v7/);
  assert.doesNotMatch(html, /<script src=&quot;_\/theme\/buffer_manager\.js/);
  assert.doesNotMatch(html, /<script src=&quot;_\/theme\/audio_core\.js/);
  assert.match(loader, /ensureNarrationRuntime/);
  assert.match(loader, /import\('\.\/audio_core\.js\?v=audio-v45'\)/);
  assert.match(loader, /import\('\.\/buffer_manager\.js\?v=buffer-v36'\)/);
  const deferredActions = loader.match(/const DEFERRED_NARRATION_ACTIONS = \[[\s\S]*?\];/)?.[0] || '';
  assert.doesNotMatch(deferredActions, /onSpeedSliderInput/);
  assert.match(loader, /window\.onSpeedSliderInput = function onSpeedSliderInput/);
});

test('service worker uses bounded navigation and lifetime-protected cache writes', async () => {
  const source = await read('serviceworker.py');
  assert.match(source, /pocket-reader-core-v127/);
  assert.match(source, /fetchWithTimeout\(event\.request, 6000\)/);
  assert.match(source, /event\.waitUntil\(updatePromise/);
  assert.match(source, /url\.searchParams\.has\('v'\)/);
});

test('onboarding and hidden controls are accessibility-isolated', async () => {
  const html = await read('FrontEnd_html.html');
  const setup = await read('device_setup.js');
  const ui = await read('ui_controller.js');
  const virtue = await read('virtue_controller.js');
  assert.match(html, /id=&quot;first-time-setup-modal&quot;[^>]*role=&quot;dialog&quot;[^>]*aria-modal=&quot;true&quot;/);
  assert.match(setup, /activatePocketModal/);
  assert.match(setup, /deactivatePocketModal/);
  assert.match(ui, /_syncNavMoreAccessibility/);
  assert.match(virtue, /_syncVirtueAccessibility/);
});

test('uploads use a size-aware deadline and always clear timers', async () => {
  const source = await read('api_core.js');
  const upload = source.match(/export async function processUploadedFile[\s\S]*?\n}\r?\nwindow\.processUploadedFile/)?.[0] || '';
  assert.match(upload, /uploadTimeoutMs/);
  assert.match(upload, /Math\.min\(\s*240000/);
  assert.match(upload, /finally\s*\{\s*clearTimeout\(timeoutId\)/);
  assert.doesNotMatch(upload, /controller\.abort\(\), 15000/);
});

test('backend database durability and health refresh are fail-visible and singleflight', async () => {
  const source = await read('Back end/app.py');
  assert.match(source, /ALLOW_EPHEMERAL_DB/);
  assert.match(source, /database_durable/);
  assert.match(source, /SITE_HEALTH_REFRESH_LOCK/);
  assert.match(source, /client\.stream\("GET", url\)/);
});
