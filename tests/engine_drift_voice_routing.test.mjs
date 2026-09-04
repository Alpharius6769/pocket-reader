import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
await import('../public/assets/js/engine_utils.js');
const policy = await import('../public/assets/js/pocket_backend_policy.js');

// ── A cache queue outlives the engine it was stamped with ───────────────────
//
// Field report, iPhone: the reader chose George (male Pocket voice) and was
// read to by a woman; switching to Noah changed nothing. What happened is that
// Pocket failed to load, _degradeNarrationEngine stepped down to Kokoro IN
// MEMORY (deliberately -- one transient failure must not rewrite a saved
// preference), and the cache queue kept its `engine: 'pocket'` stamp. Every
// remaining paragraph then routed its voice through Pocket's emotion routing
// -- producing "george_neutral" -- and handed that to the KOKORO worker, which
// builds `voices/<id>.bin` from whatever it is given: HTTP 404, on all 393
// paragraphs, logged as a Pocket synthesis failure. Live playback was fine
// because it re-reads the engine every paragraph; only the queue remembered.

test('the cache loop re-points a task at the engine that is actually running', async () => {
  const buf = await read('public/assets/js/buffer_manager.js');
  const loop = buf.slice(buf.indexOf('const task = this.queue.shift();'), buf.indexOf('const routedVoice = window.resolveVoiceWithSentiment'));
  assert.ok(loop.length > 0, 'the drain path must be findable');
  assert.match(loop, /const liveEngine = typeof _resolveActiveEngine === 'function' \? _resolveActiveEngine\(\) : null;/);
  assert.match(loop, /if \(liveEngine && liveEngine !== task\.engine && _isNeuralEngine\(liveEngine\)\) \{/);
  // Both halves have to move: the engine decides the routing AND the cache key.
  assert.match(loop, /task\.engine = liveEngine;/);
  assert.match(loop, /task\.voice = _voiceForEngine\(liveEngine, task\.voice\);/);
});

test('enqueue and re-point share one voice-selection rule', async () => {
  const buf = await read('public/assets/js/buffer_manager.js');
  assert.match(buf, /function _voiceForEngine\(engine, requested\) \{/);
  // The hand-rolled if/else at enqueue is gone, so the two cannot drift.
  assert.match(buf, /voice = _voiceForEngine\(engine, document\.getElementById\('voice-selector'\)\?\.value\);/);
});

// ── A StyleTTS2 worker must not turn any string into a URL ──────────────────

test('the StyleTTS2 workers refuse another engine\'s voice id', async () => {
  for (const [file, label] of [['kokoro_worker.js', 'Kokoro'], ['kitten_worker.js', 'Kitten']]) {
    const worker = await read(`public/assets/js/${file}`);
    assert.match(worker, /let ownVoiceIds = null;/, `${file} must hold the catalog`);
    assert.match(
      worker,
      new RegExp(`if \\(ownVoiceIds && ownVoiceIds\\.size && !ownVoiceIds\\.has\\(id\\)\\) \\{[\\s\\S]*?is not a ${label} voice`),
      `${file} must reject a foreign id before building a URL`,
    );
    // Not told means do not guess -- an older page or a test harness sends no
    // list, and disabling the check is safer than inventing one.
    assert.match(worker, /ownVoiceIds = Array\.isArray\(data\.voiceIds\) && data\.voiceIds\.length/);
  }
});

test('the catalog is sent from the main thread, never re-typed in a worker', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /voiceIds: \(typeof voicesForEngine === 'function' \? voicesForEngine\(engine\) : \[\]\)\.map\(\(v\) => v\.id\),/);
  for (const file of ['kokoro_worker.js', 'kitten_worker.js']) {
    const worker = await read(`public/assets/js/${file}`);
    // A second copy of the list drifts. It nearly did here: a hand-written
    // Kokoro list had "bm_george" where the catalog says "am_puck", which would
    // have disabled a working voice.
    assert.ok(!/am_puck|af_heart|expr-voice-3-f/.test(worker), `${file} must not carry its own voice list`);
  }
});

// ── A cross-engine substitution must not change the narrator's sex ──────────

test('a Pocket voice coerced to another engine keeps its gender', () => {
  const pocket = globalThis.POCKET_VOICE_PACK.voices;
  assert.ok(pocket.length >= 6);
  for (const engine of ['kokoro', 'kitten']) {
    for (const voice of pocket) {
      const got = policy.coerceVoiceForEngine(engine, voice.id);
      assert.equal(
        policy.voiceGender(got), voice.gender,
        `${voice.id} (${voice.gender}) -> ${got} on ${engine}`,
      );
    }
  }
});

test('a voice the engine already owns is never substituted', () => {
  for (const id of ['af_bella', 'am_puck', 'af_heart']) {
    assert.equal(policy.coerceVoiceForEngine('kokoro', id), id);
  }
  assert.equal(policy.coerceVoiceForEngine('kitten', 'expr-voice-3-m'), 'expr-voice-3-m');
});

test('an unknown id still falls back to the engine default', () => {
  assert.equal(policy.coerceVoiceForEngine('kokoro', 'nonsense'), policy.defaultVoiceForEngine('kokoro'));
});

test('the saved voice wins unless it contradicts the request', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const fn = audio.slice(audio.indexOf('window.resolveVoiceForEngine = function'), audio.indexOf('// The narration worker pool is sized by'));
  assert.match(fn, /const wanted = voiceGender\(requested\);/);
  assert.match(fn, /if \(wanted && voiceGender\(saved\) !== wanted\) return coerceVoiceForEngine\(engine, requested\);/);
  assert.match(fn, /return coerceVoiceForEngine\(engine, saved\);/);
});
