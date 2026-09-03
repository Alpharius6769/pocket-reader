// The stored narration engine has to be visible in the UI at boot, not just
// after the reader touches something.
//
// The bug: loadLocalData() finishes hydrating the profile and then calls
//
//     if (typeof window.initSettingsUI === 'function') window.initSettingsUI();
//
// but it runs from library_manager's module body, and library_manager is loaded
// BEFORE settings_manager in the shell. When hydration wins that race the guard
// is false and the whole settings render is skipped in silence. The guard reads
// as defensive and is precisely what turns a load-order race into a permanent
// no-op.
//
// Observed with 'kitten' stored: both engine selects sat on "Automatic" for the
// entire boot window and the voice picker listed POCKET voices with `alba`
// selected, while _resolveActiveEngine() correctly answered 'kitten'. The
// policy was right and every control disagreed -- including a Pocket voice id
// staged against a Kitten engine, which is the cross-engine mismatch the voice
// contract exists to prevent.
//
// Fixed in three places, verified in-browser across a reload for all three
// engines. These pin the parts that are easy to undo by accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

test('hydration publishes a latch a later module can act on', async () => {
  const library = await read('public/assets/js/library_manager.js');
  const hydrate = library.slice(
    library.indexOf('async function _hydrateLocalProfile'),
    library.indexOf('async function _hydrateLocalProfile') + 1400,
  );
  assert.match(hydrate, /window\.__pocketProfileHydrated = true;/,
    'without the latch, a module loading after hydration cannot know it missed the render');
  assert.match(hydrate, /_profileHydrated = true;/);
});

test('settings_manager catches up when hydration beat it', async () => {
  const settings = await read('public/assets/js/settings_manager.js');
  assert.match(settings, /window\.__pocketProfileHydrated === true && window\.userProfile\?\.settings/);
  const guardAt = settings.indexOf('window.__pocketProfileHydrated === true');
  const block = settings.slice(guardAt, guardAt + 400);
  assert.match(block, /initSettingsUI\(\)/);
  assert.match(block, /applySettings/);
  assert.match(block, /syncNarrationControls/);
});

test('the catch-up runs LAST, after every window export exists', async () => {
  // Position matters as much as existence. Placed next to the
  // `window.initSettingsUI =` export, this ran BEFORE
  // `window.syncNarrationControls` was assigned further down, so the optional
  // call no-opped: the engine selects came back correct while the voice picker
  // still listed the previous engine's voices. The same load-order trap, one
  // module lower.
  const settings = await read('public/assets/js/settings_manager.js');
  const guardAt = settings.indexOf('window.__pocketProfileHydrated === true');
  assert.notEqual(guardAt, -1);

  for (const exportName of ['window.syncNarrationControls =', 'window.initSettingsUI =', 'window.applySettings =']) {
    const at = settings.indexOf(exportName);
    if (at === -1) continue;
    assert.ok(at < guardAt,
      `${exportName} must be assigned before the boot catch-up runs, or the catch-up calls undefined`);
  }
  // And nothing of substance may follow it.
  assert.match(settings.slice(guardAt).trim(), /\}\s*$/,
    'the catch-up must be the last statement in the module');
});

test('initSettingsUI syncs the VOICE list, not only the engine selects', async () => {
  // Calling it alone left the selects right and the voice picker wrong, which
  // is the worse of the two failures: it puts a cross-engine voice id in front
  // of the reader.
  const settings = await read('public/assets/js/settings_manager.js');
  const init = settings.slice(
    settings.indexOf('export function initSettingsUI()'),
    settings.indexOf('export function initSettingsUI()') + 3000,
  );
  assert.match(init, /_syncEngineSelects\(_voiceEngineControlValue\(settings\)\)/);
  assert.match(init, /window\.syncNarrationControls\?\.\(\)/);
});

test('the engine control value reads the override, not just the stored field', async () => {
  // settings.voiceEngine is 'pocket' for Kitten, Kokoro AND Pocket TTS, so it
  // cannot distinguish them. The device-local override is what does.
  for (const rel of ['public/assets/js/settings_manager.js', 'public/assets/js/audio_core.js']) {
    const source = await read(rel);
    const at = source.indexOf('function _voiceEngineControlValue');
    assert.notEqual(at, -1, `${rel} must define the control-value helper`);
    const fn = source.slice(at, at + 400);
    assert.match(fn, /readNarrationEngineOverride\(localStorage\) \|\| 'auto'/, rel);
  }
});

test('both engine selects offer the same engines and share one handler', async () => {
  // Two views of one preference. If they ever diverge in options or handler,
  // the reader can pick something in one place that the other cannot show.
  const shell = await read('public/index.html');
  const optionsOf = (id) => {
    const at = shell.indexOf(`id="${id}"`);
    assert.notEqual(at, -1, `${id} must exist`);
    const block = shell.slice(at, shell.indexOf('</select>', at));
    return {
      handler: /onchange="onNarrationEngineSelect\(this\.value\)"/.test(block),
      values: [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]),
    };
  };
  const reader = optionsOf('reader-engine-select');
  const settings = optionsOf('voice-engine-select');
  assert.deepEqual(reader.values, settings.values,
    'the reader playbar and Settings must offer exactly the same engines');
  assert.deepEqual(reader.values, ['auto', 'pocket', 'kokoro', 'kitten', 'webspeech']);
  assert.ok(reader.handler && settings.handler,
    'both must route through onNarrationEngineSelect so each reflects the other');
});

test('every engine lists female voices before male, consistently', async () => {
  // Pocket was the only engine listing male first, so the picker reordered
  // itself purely because the reader changed engine.
  const engineUtils = await read('public/assets/js/engine_utils.js');
  // getPocketVoiceLabel is defined ABOVE renderPocketVoiceOptions, so slicing
  // between them in source order yields nothing. Take a forward window instead.
  const renderAt = engineUtils.indexOf('window.renderPocketVoiceOptions');
  assert.notEqual(renderAt, -1, 'the Pocket voice renderer must exist');
  const render = engineUtils.slice(renderAt, renderAt + 1600);
  assert.match(render, /\['female', 'male'\]\.forEach/);
  // Assert on the option TEMPLATE, not the whole function: the comment above it
  // explains why the badge was dropped and naturally contains the word.
  const template = render.match(/opt\.textContent = `[^`]*`/)?.[0] || '';
  assert.equal(template, 'opt.textContent = `${voice.displayName} - ${voice.accent}`',
    'a badge on every option distinguishes nothing and crowds a phone dropdown');

  const settings = await read('public/assets/js/settings_manager.js');
  // Anchor on the DEFINITION. initSettingsUI now also references
  // window.syncNarrationControls, and it appears earlier in the file, so a
  // plain indexOf lands in the wrong function.
  const syncAt = settings.indexOf('window.syncNarrationControls = function syncNarrationControls');
  assert.notEqual(syncAt, -1, 'the narration control sync must exist');
  const sync = settings.slice(syncAt, syncAt + 2000);
  const femaleAt = sync.indexOf('optgroup label="Female voices"');
  const maleAt = sync.indexOf('optgroup label="Male voices"');
  assert.ok(femaleAt !== -1 && maleAt !== -1 && femaleAt < maleAt,
    'Kokoro and Kitten must list female voices first too');
});
