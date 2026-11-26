import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeForPocketTts } from '../public/assets/js/tts_pronunciation_core.js';

// The metal "lead" rule ended in \b right after the noun, so "lead pipes" never
// matched it (no word boundary between "pipe" and "s") and fell through to the
// verb default: the narrator said "leed pipes". Found by the respelling A/B in
// tools/longform_bench.mjs.

test('metal "lead" before a plural noun is respelled "led"', () => {
  assert.equal(normalizeForPocketTts('The house still had lead pipes.'), 'The house still had led pipes.');
  assert.equal(normalizeForPocketTts('Lead weights hung from the net.'), 'Led weights hung from the net.');
  assert.equal(normalizeForPocketTts('two lead bullets'), 'two led bullets');
});

test('the singular and the verb readings are unchanged', () => {
  assert.equal(normalizeForPocketTts('A lead pipe burst.'), 'A led pipe burst.');
  assert.equal(normalizeForPocketTts('You lead and we follow.'), 'You leed and we follow.');
  // Not a metal noun after "lead": stays on the default reading.
  assert.equal(normalizeForPocketTts('a lead pipeline'), 'a leed pipeline');
});
