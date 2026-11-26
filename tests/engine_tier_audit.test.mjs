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

test('no module decides behaviour by naming a single neural engine', async () => {
  // The generic sweep. A branch that names one engine is fine when it is about
  // that engine's own assets or label; it is a bug when it gates BEHAVIOUR that
  // every StyleTTS2 engine shares. These are the shapes that were wrong.
  const banned = [
    // The loader gate. This one returned false for Kitten, so the engine was
    // selectable, routed, and dead.
    /engine !== 'pocket' && engine !== 'kokoro'/,
    // Cache tagging. Returning '' for an engine leaves its audio keyed on
    // position and voice alone: uninvalidatable, and able to collide.
    /if \(engine === 'kokoro'\) return `#\$\{KOKORO_NARRATION_CACHE_VERSION\}`/,
    /if \(engine === 'kokoro'\) return \[_prosodyCacheTag/,
    // Voice resolution. Falling through hands one engine's id to another's worker.
    /if \(engine === 'kokoro'\) return window\.resolveVoiceForEngine\('kokoro'/,
    // The backend planner, which has nothing to decide for a wasm-only graph.
    /const backendPlan = engine === 'kokoro'/,
    // The resolver. This could only ever return 'kokoro', so 'kitten' was
    // unreachable no matter what the policy chose.
    /if \(choice\?\.engine === 'kokoro'\) return 'kokoro'/,
    // Cache-job voice selection, which canonicalises against POCKET_VOICES.
    /if \(activeNeural === 'kokoro'\)/,
  ];
  const files = ['audio_core.js', 'buffer_manager.js', 'engine_utils.js',
                 'reader_features.js', 'settings_manager.js', 'device_setup.js'];
  for (const name of files) {
    const code = strip(await read(`public/assets/js/${name}`));
    for (const pattern of banned) {
      assert.doesNotMatch(code, pattern, `${name} still gates behaviour on one engine's name`);
    }
  }
});

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

test('shell modules import the voice contract rather than reading window', async () => {
  // audio_core publishes voicesForEngine on window and is LAZY-LOADED, so any
  // module that runs before narration starts must import it. reader_features
  // already carried a comment saying exactly this about POCKET_VOICES.
  for (const name of ['buffer_manager.js', 'reader_features.js']) {
    const src = await read(`public/assets/js/${name}`);
    // Matches either import style: buffer_manager uses a multi-line list,
    // reader_features a single line. Anchoring on one shape fails on the other.
    // The symbol must be bound as a module import, and must NOT be read off
    // window: audio_core publishes it there and is lazy-loaded, so the global
    // is absent exactly when a cold cache job or dialog needs it.
    const code = strip(src);
    assert.match(code, /voicesForEngine/, `${name} must use voicesForEngine`);
    assert.doesNotMatch(code, /window\.voicesForEngine/,
      `${name} must not depend on a global published by lazy-loaded audio_core`);
    const policyImport = code.slice(0, code.indexOf('pocket_backend_policy'));
    assert.ok(policyImport.includes('voicesForEngine'),
      `${name} must import voicesForEngine from the policy, not elsewhere`);
  }
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
