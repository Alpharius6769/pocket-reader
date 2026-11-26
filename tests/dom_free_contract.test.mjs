// The functions the v2 bridge calls must run in a page that has none of the
// old shell's elements. Each of these used to read a form field or a <select>,
// which made them unusable from any other UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

function body(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, `${start} must be locatable`);
  const b = source.indexOf(end, a + start.length);
  return source.slice(a, b < 0 ? undefined : b);
}

test('AO3 search is available without the search form', async () => {
  const api = await read('public/assets/js/api_core.js');
  for (const name of ['buildAo3SearchPayload', 'isEmptyAo3Search', 'searchAo3']) {
    assert.match(api, new RegExp(`export (async )?function ${name}\\(`), `${name} is exported`);
  }
  const build = body(api, 'export function buildAo3SearchPayload(', 'window.buildAo3SearchPayload');
  const search = body(api, 'export async function searchAo3(', 'window.searchAo3');
  for (const [name, fn] of [['buildAo3SearchPayload', build], ['searchAo3', search]]) {
    assert.doesNotMatch(fn, /document\./, `${name} must not touch the DOM`);
  }
  // It resolves with a result object; the legacy form renders it.
  assert.match(search, /return \{ ok: true, data, displayTerm \};/);
  const submit = body(api, 'export async function handleSearchSubmit(', 'window.loadMoreAo3Results');
  assert.match(submit, /const outcome = await searchAo3\(payload\);/);
});

test('the narration voice comes from settings, not from a <select>', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const saved = body(audio, 'function _savedVoiceForEngine(engine) {', 'window._savedVoiceForEngine');
  assert.match(saved, /settings\.kokoroVoice/);
  assert.match(saved, /settings\.pocketVoice/);
  assert.match(saved, /settings\.webVoice/);
  const effective = body(audio, 'function _effectiveVoiceForEngine(engine) {', 'window._effectiveVoiceForEngine');
  assert.doesNotMatch(effective, /document\./);
  assert.doesNotMatch(audio, /getElementById\('voice-selector'\)\?\.value/,
    'no core reads the selected voice off the DOM');
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.doesNotMatch(buffer, /getElementById\('voice-selector'\)\?\.value/);
});

test('status lines reach the UI as events, and the lock screen reads the last one', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /const _setStatus = \(msg\) => ui\.status\(msg\);/);
  assert.match(audio, /const bufText = lastStatus\(\);/);
  assert.doesNotMatch(audio, /getElementById\('reader-buffer-text'\)/);
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(buffer, /ui\.cachingProgress\(\{/);
});

test('Play never waits on a service worker that is not there', async () => {
  // The v2 page did not register sw.js at first, and Play hung silently: the
  // isolation reload waited on navigator.serviceWorker.ready, which never
  // settles without a registration.
  const buffer = await read('public/assets/js/buffer_manager.js');
  const supports = body(buffer, 'function _supportsFastNarrationSession() {', '\n}\n');
  assert.match(supports, /navigator\.serviceWorker\.controller \|\| window\.__prServiceWorkerRegistration/);
  const reload = body(buffer, 'function _requestFastNarrationReload(', '\nwindow.requestPocketNarrationIsolation');
  assert.match(reload, /const deadline = new Promise\(\(resolve\) => setTimeout\(resolve, 3000\)\);/);
  assert.doesNotMatch(reload, /navigator\.serviceWorker\?\.ready\s*\n?\s*\?\.then\(\(\) => setTimeout\(go, 50\)\)/);
  // And the v2 shell registers the worker in production, where the cores look for it.
  const loader = await read('web/src/lib/core/coreLoader.ts');
  assert.match(loader, /w\.__prServiceWorkerRegistration = navigator\.serviceWorker/);
});

test('the engine lifecycle is observable without reading audio_core internals', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /window\.getNarrationEngineStatus = \(\) => neuralState;/);
  assert.match(audio, /if \(changed\) \{\s*\n\s*try \{ ui\.engineState\(nextState/);
});

test('after the isolation reload a phone asks for a tap before playback, through the v2 UI', async () => {
  // iOS starts audio only inside a user gesture, and the reload spent the one
  // that pressed Play. The playback resume used to start unprompted.
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(buffer, /if \(_isMobileNarrationPlatform\(\)\) await _awaitMobileNarrationGesture\('playback'\);\s*\n\s*window\.togglePlayState\?\.\(\);/);
  const gesture = body(buffer, 'function _awaitMobileNarrationGesture(', '\nasync function _resumeFastNarrationCache');
  assert.match(gesture, /if \(ui\.requestGesture\(verb, finish\) === true\) \{ pending\.claimed = true; return; \}/);
  // Raised before the UI subscribes, the request waits for a late claim; the
  // bare overlay only appears if nothing claims it.
  assert.match(gesture, /window\.__prPendingNarrationGesture = pending;/);
  assert.match(gesture, /if \(settled \|\| pending\.claimed\) return;\s*\n\s*showFallback\(\);/);
  const bridge = await read('web/src/lib/core/bridge.real.ts');
  assert.match(bridge, /const early = w\.__prPendingNarrationGesture;/);
  assert.match(bridge, /if \(this\.continueGesture\(\)\) return;/);
});
