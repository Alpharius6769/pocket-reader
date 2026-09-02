// When a narration engine fails to start, the session steps DOWN one tier
// instead of abandoning neural narration entirely.
//
// It used to go straight from any neural engine to the device voice. The three
// tiers exist precisely because devices differ in what they can hold, so
// jumping the whole ladder threw away the two answers most likely to work: a
// phone that cannot sustain Pocket over a long session -- thermally, or once
// other tabs have taken the memory -- can almost always still run Kokoro, and
// nearly anything runs Kitten. Trading a neural voice for a robotic one on the
// first worker death is the biggest quality cliff in the app, and it is most
// likely hours in, which is when a reader is least willing to lose the narrator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const policy = await import('../public/assets/js/pocket_backend_policy.js');

test('the tier order is lightest-first, which is what "down" means', () => {
  // _nextNarrationTierDown walks toward index 0. If this order ever flips, the
  // degrade path silently becomes an UPGRADE path and a device that just failed
  // to start Kokoro would be handed Pocket.
  assert.deepEqual([...policy.NARRATION_ENGINE_TIERS], ['kitten', 'kokoro', 'pocket']);
});

test('degradation walks the ladder down and stops at the device voice', async () => {
  const source = await read('public/assets/js/audio_core.js');
  const fn = source.slice(
    source.indexOf('function _nextNarrationTierDown('),
    source.indexOf('window._degradeNarrationEngine ='),
  );
  assert.ok(fn.length > 200, 'the degrade helpers must be locatable');

  // Already-lightest, or an engine not on the ladder at all, has nowhere to go.
  assert.match(fn, /if \(index <= 0\) return null;/);
  // Walk downward, skipping tiers this page has already failed.
  assert.match(fn, /for \(let next = index - 1; next >= 0; next -= 1\)/);
  assert.match(fn, /_failedNarrationEngines\.has\(candidate\)/);
  // Only when nothing is left does the device voice happen.
  assert.match(fn, /if \(!nextEngine\) \{[\s\S]{0,220}_fallbackToWebSpeech\(\);/);
  // The engine that just failed is recorded BEFORE choosing, or a repeated
  // failure would pick the same tier forever.
  assert.match(fn, /_failedNarrationEngines\.add\(failed\);[\s\S]{0,120}_nextNarrationTierDown\(failed\)/);
});

test('the step-down is session-only and never rewrites the saved preference', async () => {
  const source = await read('public/assets/js/audio_core.js');
  const fn = source.slice(
    source.indexOf('function _degradeNarrationEngine('),
    source.indexOf('window._degradeNarrationEngine ='),
  );
  // The precedent this follows: a transient failure once PERSISTED
  // voiceEngine:'webspeech' and demoted the account for good.
  assert.doesNotMatch(fn, /writeNarrationEngineOverride/);
  assert.doesNotMatch(fn, /saveLocalData/);
  assert.doesNotMatch(fn, /userProfile\.settings\.voiceEngine\s*=/);
  assert.match(fn, /window\._pocketRuntimeEngineOverride = nextEngine;/);
});

test('the runtime override is actually honoured by the resolver', async () => {
  // Setting a global nothing reads is decoration. The resolver must consult it,
  // and only for a real tier name.
  const utils = await read('public/assets/js/engine_utils.js');
  assert.match(utils, /if \(NARRATION_ENGINE_TIERS\.includes\(window\._pocketRuntimeEngineOverride\)\) \{/);
  assert.match(utils, /return window\._pocketRuntimeEngineOverride;/);

  // Ordering matters: the device-voice flag is still the last resort and must
  // be checked FIRST, so a hard failure is not overridden back onto a tier.
  const unavailable = utils.indexOf("window._pocketNeuralEngineUnavailable === true) return 'webspeech'");
  const override = utils.indexOf('window._pocketRuntimeEngineOverride)');
  const stored = utils.indexOf('let engine = window.userProfile?.settings?.voiceEngine;');
  assert.ok(unavailable !== -1 && override !== -1 && stored !== -1);
  assert.ok(unavailable < override, 'the device-voice fallback outranks the step-down');
  assert.ok(override < stored, 'what the device can run now outranks what it was assigned at setup');
});

test('an explicit engine choice clears the step-down, in both recovery paths', async () => {
  // Otherwise the reader who disagrees with the automatic downgrade picks an
  // engine, nothing changes, and the control looks broken.
  const audio = await read('public/assets/js/audio_core.js');
  const switcher = audio.slice(audio.indexOf('export function switchReaderVoiceEngine('), audio.length);
  assert.match(switcher, /window\._pocketRuntimeEngineOverride = null;/);
  assert.match(switcher, /window\._failedNarrationEngines\?\.clear\?\.\(\);/);

  const library = await read('public/assets/js/library_manager.js');
  assert.match(library, /window\._pocketRuntimeEngineOverride = null;/);
  assert.match(library, /window\._failedNarrationEngines\?\.clear\?\.\(\);/);
});

test('clearing is gated on an explicit choice, or the step-down undoes itself', async () => {
  // Found by running it rather than reading it, and invisible to every
  // structural assertion above. switchReaderVoiceEngine is ALSO the plumbing:
  // refreshVoiceSelectorForEngine calls it with silent=true purely to rebuild
  // the voice list. With the clear ungated, the degrade path set the override,
  // refreshed the selector to match, and that refresh re-entered the switcher
  // and wiped the override it had just set. The notice still fired and the
  // engine never moved -- a downgrade that announced itself and did nothing.
  const audio = await read('public/assets/js/audio_core.js');
  const switcher = audio.slice(audio.indexOf('export function switchReaderVoiceEngine('), audio.length);
  const clearIndex = switcher.indexOf('window._pocketRuntimeEngineOverride = null;');
  assert.notEqual(clearIndex, -1);
  const guard = switcher.slice(Math.max(0, clearIndex - 400), clearIndex);
  assert.match(guard, /if \(!silent\) \{/,
    'the clear must not run on an internal, silent refresh');

  // And the internal refresh really does pass silent=true, which is what makes
  // that gate meaningful rather than decorative.
  assert.match(audio, /switchReaderVoiceEngine\(_voiceEngineControlValue\(\), true\)/);
});

test('the voice moves down with the engine', async () => {
  // A voice id from the failed engine handed to the next one is an unknown id
  // at the worker, which stalls for 60 s rather than failing -- the same
  // contract the retired-voice aliases exist to protect.
  const source = await read('public/assets/js/audio_core.js');
  const fn = source.slice(
    source.indexOf('function _degradeNarrationEngine('),
    source.indexOf('window._degradeNarrationEngine ='),
  );
  assert.match(fn, /coerceVoiceForEngine\(nextEngine, current\)/);
  assert.match(fn, /refreshVoiceSelectorForEngine/);
});

test('coerceVoiceForEngine really does move a voice across every tier pair', () => {
  // The guard above pins the call; this pins that the call does something. A
  // cross-engine voice must never survive the switch.
  for (const from of policy.NARRATION_ENGINE_TIERS) {
    for (const to of policy.NARRATION_ENGINE_TIERS) {
      if (from === to) continue;
      for (const voice of policy.voicesForEngine(from)) {
        const moved = policy.coerceVoiceForEngine(to, voice.id);
        assert.ok(policy.isVoiceValidForEngine(to, moved),
          `${voice.id} (${from}) must become a valid ${to} voice, got ${moved}`);
      }
    }
  }
});

test('the reader is told, rather than the narrator just changing character', async () => {
  const source = await read('public/assets/js/audio_core.js');
  const fn = source.slice(
    source.indexOf('function _degradeNarrationEngine('),
    source.indexOf('window._degradeNarrationEngine ='),
  );
  assert.match(fn, /window\.pocketNotify\?\.\(/);
  assert.match(fn, /Diagnostics\?\.log\?\.\('WARN'/,
    'a silent downgrade is undiagnosable after the fact');
});
