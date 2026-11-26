// Guards for the companion layout, in-app notices, and the Anthronomicon bridge.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(p, 'utf8');

test('the vendored catalog layer stays pure so it can be diffed against upstream', async () => {
  const core = await read('public/assets/js/hmofa_catalog_core.js');
  const list = await read('public/assets/js/hmofa_masterlist.js');

  // Results must match the live index exactly. They only do so while this file
  // is a straight copy of upstream, which requires it to stay portable.
  for (const forbidden of ['document.', 'window.', 'localStorage', 'fetch(']) {
    assert.ok(!core.includes(forbidden),
      `hmofa_catalog_core.js must stay a pure data layer, found ${forbidden}`);
  }
  assert.match(core, /Upstream: Alpharius6769\/hmofa-story-index/,
    'the vendored copy must record where it came from');
  assert.match(core, /SHA-256:\s+[0-9a-f]{64}/,
    'the vendored copy must record the upstream hash it was taken from');

  // Reimplementing filtering here is how the two drift apart.
  assert.match(list, /filterCatalog|sortCatalog/,
    'the view must delegate filtering to the vendored layer');
});

test('Virtue does not greet the reader with "There\'s my good boy."', async () => {
  // v2: Virtue's lines live in the new UI.
  const source = await read('web/src/lib/virtue/sprites.ts');
  assert.match(source, /export const LINES/, 'the v2 line table must be locatable');
  assert.doesNotMatch(source, /There's my good boy/);
});


