// The cores reach the UI only through core_events.js. These pin the contract
// the v2 bridge (web/src/lib/core/bridge.real.ts) relies on. The old shell and
// its replay adapter were deleted with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

globalThis.window = globalThis;
// Same specifier the cores use: ES modules are keyed by URL, so an import
// without the ?v= token would be a second, unconnected bus.
const EVENTS_VERSION = (await read('public/assets/js/audio_core.js')).match(/core_events\.js\?v=([a-z0-9-]+)/)[1];
const events = await import(`../public/assets/js/core_events.js?v=${EVENTS_VERSION}`);

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

