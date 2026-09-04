import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const audio = await readFile(new URL('../public/assets/js/audio_core.js', import.meta.url), 'utf8');

// ── A diagnostic that names the wrong engine sends you to the wrong code ────
//
// audio_core grew up Pocket-only, so every neural synthesis was logged as
// "Pocket synth" whichever engine produced it. That is not cosmetic. In one
// day it produced two field reports that pointed at the wrong subsystem:
//
//   * "Pocket TTS - bad performance for caching" from an iPhone 13 Pro Max that
//     resolved to KOKORO at startup ("This screen size belongs to the iPhone 12
//     Pro Max, 13 Pro Max or 14 Plus family"), has never loaded a Pocket model,
//     and whose every logged render was af_heart -- a Kokoro voice.
//   * "Pocket synth quality guard rejected paragraph" wrapping
//     `voice george_neutral failed: HTTP 404`, which is kokoro_worker.js's
//     error string, not Pocket's.

test('synth log lines are labelled with the engine that produced them', () => {
  assert.match(audio, /function _synthEngineLabel\(\) \{/);
  const fn = audio.slice(audio.indexOf('function _synthEngineLabel()'), audio.indexOf('function _logPocketQuality'));
  assert.match(fn, /if \(engine === 'kokoro'\) return 'Kokoro';/);
  assert.match(fn, /if \(engine === KITTEN_ENGINE\) return 'Kitten';/);
  assert.match(fn, /return 'Pocket';/);
});

test('no synth log line hardcodes "Pocket" any more', () => {
  // The per-render line and every quality-guard line.
  for (const dead of [
    "`Pocket synth ${_ms}ms",
    "'Pocket synth quality guard retrying failed cache paragraph'",
    "`Pocket synth quality guard attempt ${level + 1} rejected`",
    "'Pocket synth quality guard rejected every attempt; keeping the least-bad render'",
    "`Pocket synth quality guard rejected paragraph (${reason})`",
    "'Pocket synth accepted with a soft quality warning'",
    "'Pocket WAV encoded'",
  ]) {
    assert.ok(!audio.includes(dead), `still hardcoded: ${dead}`);
  }
  assert.ok(audio.includes('`${_synthEngineLabel()} synth ${_ms}ms'));
});

test('the engine is recorded as a field, not only in the prose', () => {
  // So a report can be filtered by engine without inferring it from a voice id.
  const telemetry = audio.slice(audio.indexOf('throughputMode: _isPocketThroughputCache(),'));
  assert.match(telemetry.slice(0, 300), /engine: _resolveActiveEngine\(\),/);
  const guard = audio.slice(audio.indexOf('function _logPocketQuality'), audio.indexOf('function _logPocketQuality') + 700);
  assert.match(guard, /engine: _resolveActiveEngine\(\),/);
});
