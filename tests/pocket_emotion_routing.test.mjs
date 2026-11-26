import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Expressive narration was neutral on every paragraph: each curated voice
// declared availableEmotions: ['neutral'], so the router could only ever resolve
// neutral and the per-emotion sampling temperature never applied (43 of 43
// paragraphs at 0.30 in tools/longform_bench.mjs). Emotion states and reference
// recordings are now separate: the router may pick any state, and every fetch
// lands on the voice's own neutral recording, because that is the only file
// Kyutai shipped and asking for any other is a 404 and a worker stall.

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
await import('../public/assets/js/engine_utils.js');

test('the router can resolve emotion states for every curated voice', () => {
  for (const voice of window.POCKET_VOICES) {
    assert.equal(window.resolvePocketAssetVoiceId(voice, 'happy'), `${voice}_happy`);
    assert.equal(window.resolvePocketAssetVoiceId(voice, 'sad'), `${voice}_sad`);
    assert.equal(window.resolvePocketAssetVoiceId(voice, 'neutral'), `${voice}_neutral`);
    // An emotion id survives canonicalisation as the same speaker.
    assert.equal(window.canonicalPocketVoice(`${voice}_worried`), `${voice}_worried`);
  }
});

test('every emotion state fetches its own speaker\'s neutral reference', () => {
  for (const voice of window.POCKET_VOICES) {
    for (const emotion of ['neutral', 'calm', 'happy', 'sad', 'worried', 'surprised', 'tired', 'frustrated', 'anger', 'shout', 'confused']) {
      assert.equal(window.resolvePocketReferenceVoiceId(`${voice}_${emotion}`), `${voice}_neutral`, `${voice}_${emotion}`);
    }
    assert.equal(window.resolvePocketReferenceVoiceId(voice), `${voice}_neutral`);
  }
  // Retired and unknown ids still resolve to a live voice's real recording.
  assert.equal(window.resolvePocketReferenceVoiceId('rayne_sad'), 'alba_neutral');
  assert.equal(window.resolvePocketReferenceVoiceId('donald_malone_happy'), 'charles_neutral');
  assert.equal(window.resolvePocketReferenceVoiceId('nobody_happy'), 'alba_neutral');
});

test('no reference outside the shipped neutral recordings is ever produced', () => {
  const references = new Set(window.POCKET_VOICE_ASSET_IDS.map((id) => window.resolvePocketReferenceVoiceId(id)));
  assert.deepEqual([...references].sort(), window.POCKET_VOICES.map((v) => `${v}_neutral`).sort());
});

test('audio_core fetches voices only through the reference resolver', async () => {
  const audio = await readFile(new URL('../public/assets/js/audio_core.js', import.meta.url), 'utf8');
  const loader = audio.slice(audio.indexOf('async function ensurePocketVoiceLoaded('), audio.indexOf('async function prefetchPocketVoiceAssets('));
  const prefetch = audio.slice(audio.indexOf('async function prefetchPocketVoiceAssets('), audio.indexOf('window.prefetchPocketVoiceAssets ='));
  const fallbacks = audio.slice(audio.indexOf('function _sameBaseFallbackVoiceIds('), audio.indexOf('async function ensurePocketVoiceLoaded('));
  assert.match(loader, /let targetVoice = _pocketReferenceVoiceId\(voiceName\);/);
  assert.match(prefetch, /_pocketReferenceVoiceId\(id\)/);
  assert.doesNotMatch(fallbacks, /resolvePocketAssetVoiceId/);
  for (const [name, body] of [['loader', loader], ['prefetch', prefetch]]) {
    assert.doesNotMatch(body, /resolvePocketAssetVoiceId\(/, `${name} must not fetch a routed emotion id directly`);
  }
  // The route still builds emotion ids, and the prosody opts take the route's
  // emotion rather than re-deriving it from the (neutral) registered voice.
  assert.match(audio, /window\.resolvePocketAssetVoiceId\(baseVoice, emotion\)/);
  assert.match(audio, /_buildPocketProsodyOpts\(workerVoice, \{\s*paragraphEmotion: route\.emotion,/);
});
