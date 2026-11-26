// Guards for the bugs found auditing the three-tier rollout, 2026-08-29.
//
// The theme: every one of them was an `=== 'kokoro'` or `!== 'pocket'` written
// when there were two engines. None failed loudly. Two of them made the new tier
// completely inert while it still appeared selectable in Settings, which is the
// worst shape a bug can take here -- the reader picks it and nothing says no.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('the loader and resolver both admit every tier', async () => {
  const audio = strip(await read('public/assets/js/audio_core.js'));
  const utils = strip(await read('public/assets/js/engine_utils.js'));

  // One predicate, used by every site that used to name Kokoro.
  assert.match(audio, /function _isStyleTts2Engine\(engine\) \{/);
  assert.match(audio, /function _isStyleTts2Engine\(engine\) \{\s*\n\s*return engine === 'kokoro';/);
  assert.match(audio, /if \(engine !== 'pocket' && !_isStyleTts2Engine\(engine\)\) return false;/);

  // The resolver returns what the policy picked, validated -- not a hardcoded name.
  assert.match(utils, /NARRATION_ENGINE_TIERS\.includes\(choice\.engine\)/);
  assert.match(utils, /return choice\.engine;/);
});

test('every neural engine gets its own cache version', async () => {
  const audio = strip(await read('public/assets/js/audio_core.js'));
  assert.match(audio, /const NEURAL_CACHE_VERSIONS = Object\.freeze\(\{/);
  assert.match(audio, /if \(_isStyleTts2Engine\(engine\)\) return `#\$\{NEURAL_CACHE_VERSIONS\[engine\]\}`/);

  // A shared version would let two models' renders collide on one key.
  const kokoro = audio.match(/const KOKORO_NARRATION_CACHE_VERSION = '([^']+)'/)?.[1];
  assert.ok(kokoro, 'Kokoro needs a declared cache version');
  assert.match(audio, /const NEURAL_CACHE_VERSIONS = Object\.freeze\(\{\s*kokoro: KOKORO_NARRATION_CACHE_VERSION,\s*\}\);/);
});

test('the Kokoro worker does not claim a fixed sequence axis', async () => {
  // The claim that the graph fixes the sequence axis is false: input_ids is
  // [1, sequence_length] with a dynamic dim_param.
  for (const name of ['kokoro_worker.js']) {
    const src = await read(`public/assets/js/${name}`);
    assert.doesNotMatch(strip(src), /exported graph fixes the sequence axis/,
      `${name} repeats a claim that was checked against the model and is wrong`);
  }
});
