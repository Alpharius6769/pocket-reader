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

test('an engine switch does not wait for an element the new UI never renders', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  // Without the flag this re-scheduled itself every 50 ms forever on a page
  // with no #voice-selector, and the engine never changed.
  assert.match(audio, /if \(window\.__prLegacyShell && !document\.getElementById\('voice-selector'\)\) \{/);
  const adapter = await read('public/assets/js/legacy_ui_adapter.js');
  assert.match(adapter, /window\.__prLegacyShell = true;/);
});

test('status lines reach the UI as events, and the lock screen reads the last one', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /const _setStatus = \(msg\) => ui\.status\(msg\);/);
  assert.match(audio, /const bufText = lastStatus\(\);/);
  assert.doesNotMatch(audio, /getElementById\('reader-buffer-text'\)/);
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(buffer, /ui\.cachingProgress\(\{/);
});
