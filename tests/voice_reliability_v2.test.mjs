// v2 voice-reliability fixes. Each test names the field symptom it prevents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

function slice(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, `${start} must be locatable`);
  const b = source.indexOf(end, a + start.length);
  return source.slice(a, b < 0 ? undefined : b);
}

// ── A yield is not a failure ────────────────────────────────────────────────
// Symptom: a paragraph cached in the background was silently skipped whenever
// live playback preempted its render, so playback later stalled on it. The
// worker's yield was caught in _generatePocketAttempt and turned into a fatal
// quality result; buffer_manager matched that as a quality failure, set
// failCount = 3 and skipped the paragraph, and the drift guard logged a
// failure that never happened.

test('a preempted cache render reaches the cache loop as a yield', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /const NARRATION_YIELD_MESSAGE = 'Narration cache yielded to playback';/);

  const attempt = slice(audio, 'async function _generatePocketAttempt(', '\n}\n');
  const attemptCatch = attempt.slice(attempt.lastIndexOf('} catch (err) {'));
  assert.ok(
    attemptCatch.indexOf('if (_isNarrationYield(err)) throw err;') >= 0
      && attemptCatch.indexOf('if (_isNarrationYield(err)) throw err;') < attemptCatch.indexOf('fatal: true'),
    'the attempt must rethrow a yield before building a fatal quality result',
  );

  const generate = slice(audio, 'window.generateChunk = async function(text, voice) {', 'window.generateChunkStream');
  const outerCatch = generate.slice(generate.lastIndexOf('} catch (e) {'));
  assert.ok(
    outerCatch.indexOf('if (_isNarrationYield(e)) throw e;') >= 0
      && outerCatch.indexOf('if (_isNarrationYield(e)) throw e;') < outerCatch.indexOf('_resetPocketEngineForBackend'),
    'generateChunk must pass a yield through before it resets the engine or returns null',
  );
});

test('the cache loop requeues a yield on its own budget', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(buffer, /const yielded = err\?\.message === 'Narration cache yielded to playback';/);
  assert.match(buffer, /const counter = yielded \? 'yieldRetries' : 'resetRetries';/);
  assert.match(buffer, /const limit = yielded \? 40 : 6;/);
  for (const worker of ['pocket_worker.js', 'kokoro_worker.js']) {
    const source = await read(`public/assets/js/${worker}`);
    assert.match(source, /= 'Narration cache yielded to playback';/, `${worker} posts the same message`);
  }
});

// ── Drift guard: artifacts only, one tier per chapter ───────────────────────
// Symptom: emotion switched on and off between consecutive paragraphs. The
// guard counted timeouts, yields and soft warnings as failures and applied a
// demotion immediately, mid-chapter.

test('the prosody tier is frozen per chapter and moved only by real artifacts', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const tier = slice(audio, 'function _effectiveProsodyTier() {', '\n}\n');
  assert.match(tier, /_frozenProsodyTier/);
  assert.match(audio, /function _isProsodyArtifact\(attempt\) \{\s*\n\s*return attempt\?\.quality\?\.fatal === true && Number\(attempt\?\.result\?\.audio\?\.length \|\| 0\) > 0;/);
  const sync = slice(audio, 'function _syncProsodyDriftToPosition() {', '\n}\n');
  assert.match(sync, /_frozenProsodyTier = null;/, 'a chapter boundary re-freezes the tier');
  assert.doesNotMatch(sync, /if \(moved\) _prosodyDrift\.reset\(\);/, 'a chapter boundary must not discard the demotion it should apply');
});

// ── Cache tag says how the audio was rendered ───────────────────────────────
// Symptom: grain and timbre changed paragraph to paragraph in cached chapters.
// FP16- and INT8-vocoded (and block-4 vs per-frame) paragraphs shared one key.

test('the cache tag records vocoder precision, decode path and applied tier', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const tag = slice(audio, 'function _prosodyCacheTag(', 'window._prosodyCacheTag');
  assert.match(tag, /`mm\$\{_pocketBackendRuntime\.mimiPrecision \|\| 'int8'\}`/);
  assert.match(tag, /`dp\$\{_pocketBackendRuntime\.decodePath \|\| 'frame'\}`/);
  assert.match(tag, /`et\$\{_effectiveProsodyTier\(\)\}`/);
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /decodePath: \(flowLmUnifiedSession \|\| flowLmWasmBlockSession \|\| flowLmDecodeBlockSession\) \? 'block4' : 'frame',/);
  assert.match(worker, /loadedMimiFilename = filename;/);
});
