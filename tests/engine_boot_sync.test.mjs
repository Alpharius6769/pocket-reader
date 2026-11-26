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

