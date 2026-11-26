// The cores reach the UI only through core_events.js. These pin the contract
// the new UI's bridge relies on, and the replay that keeps the old shell alive
// until it is deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

globalThis.window = globalThis;
// Same specifier the cores and the adapter use: ES modules are keyed by URL, so
// an import without the ?v= token would be a second, unconnected bus.
const EVENTS_VERSION = (await read('public/assets/js/legacy_ui_adapter.js')).match(/core_events\.js\?v=([a-z0-9-]+)/)[1];
const events = await import(`../public/assets/js/core_events.js?v=${EVENTS_VERSION}`);
await import('../public/assets/js/legacy_ui_adapter.js');

test('each facade call is one typed event with named fields and the original args', () => {
  const seen = [];
  const off = events.onCore(events.CORE_EVENT.NOTICE, (detail) => seen.push(detail));
  events.ui.notify('Saved.', 3000);
  off();
  events.ui.notify('after unsubscribe');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, 'Saved.');
  assert.equal(seen[0].duration, 3000);
  assert.deepEqual(seen[0].args, ['Saved.', 3000]);
});

test('a listener result is returned to the core, synchronously', () => {
  const off = events.onCore(events.CORE_EVENT.CACHE_PANEL, (detail) => { detail.result = `handled:${detail.action}`; });
  // The legacy adapter also listens; with no global defined it must not
  // overwrite a result another listener set.
  assert.equal(events.ui.askCacheDecision(), 'handled:ask');
  off();
});

test('the legacy adapter replays the old global call with the same arguments', () => {
  const calls = [];
  window.showLoadingOverlay = (...args) => { calls.push(args); return 'shown'; };
  const cancel = () => {};
  const result = events.ui.loading('Opening', 'Chapter 3', cancel);
  delete window.showLoadingOverlay;
  assert.deepEqual(calls, [['Opening', 'Chapter 3', cancel]]);
  assert.equal(result, 'shown');
});

test('a missing legacy global is a no-op, as the guarded call sites were', () => {
  delete window.triggerVirtue;
  assert.doesNotThrow(() => events.ui.companion('virtue_thinking'));
});

test('every legacy name the facade emits is a real UI function name', async () => {
  const source = await read('public/assets/js/core_events.js');
  const names = [...source.matchAll(/call\(CORE_EVENT\.[A-Z_]+, '([A-Za-z]+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 15, 'the facade must be locatable');
  const js = await Promise.all([
    'ui_controller.js', 'library_manager.js', 'virtue_controller.js', 'settings_manager.js',
    'buffer_manager.js', 'audio_core.js', 'cinematic_ui.js', 'experience_coordinator.js', 'engine_utils.js',
  ].map((f) => read(`public/assets/js/${f}`)));
  const all = js.join('\n');
  for (const name of names) {
    assert.match(all, new RegExp(`(function ${name}\\b|window\\.${name}\\s*=)`), `${name} is not defined by any shell module`);
  }
});

test('the cores never call a UI global directly', async () => {
  const UI_GLOBALS = [
    'triggerVirtue', 'virtueSpeak', 'pocketNotify', 'queueNotice', 'updateReaderUIText', 'updateDeckTransport',
    'updatePlayButtons', 'showView', 'populateReaderUI', 'showLoadingOverlay', 'hideLoadingOverlay',
    'showSettingsModal', 'renderLibrary', 'updateContinueReading', 'renderBookmarksTab', 'closeCacheModal',
    'showCacheDecisionModal', 'renderNarrationEngineControls', 'refreshVoiceSelectorForEngine',
    'updateReaderDrawerStatus',
  ];
  for (const file of ['audio_core.js', 'buffer_manager.js', 'api_core.js', 'storage_core.js']) {
    const source = await read(`public/assets/js/${file}`);
    assert.match(source, /import \{ ui(, [^}]*)? \} from '\.\/core_events\.js\?v=core-events-v\d+';/, `${file} imports the facade`);
    for (const name of UI_GLOBALS) {
      const direct = new RegExp(`window\\.${name}(\\?\\.)?\\(|typeof window\\.${name}\\b`);
      assert.doesNotMatch(source, direct, `${file} calls window.${name} directly; use ui.* from core_events.js`);
    }
  }
});

test('the old shell loads the adapter before any core that can emit', async () => {
  const html = await read('public/index.html');
  const adapter = html.indexOf('assets/js/legacy_ui_adapter.js?v=');
  const storage = html.indexOf("<script src='assets/js/storage_core.js?v=");
  assert.ok(adapter > 0 && adapter < storage, 'adapter must load first');
  const sw = await read('public/sw.js');
  assert.match(sw, /'assets\/js\/core_events\.js\?v=core-events-v\d+'/);
  assert.match(sw, /'assets\/js\/legacy_ui_adapter\.js\?v=legacy-ui-v\d+'/);
});
