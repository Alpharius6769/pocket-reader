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

// ── Recycles stay off the live path ─────────────────────────────────────────
// Symptom: a multi-second pause every ~20 paragraphs, mid-chapter. The worker
// recycle was checked at the top of every generateChunk, the live one included.

test('the worker recycle defers past live playback until a hard ceiling', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const recycle = slice(audio, 'async function _maybeRecyclePocketEngine() {', '\n}\n');
  assert.match(recycle, /if \(window\._playPriority === true && window\._pocketParagraphCount < recycleEvery \* 2\) return false;/);
  assert.ok(
    recycle.indexOf('window._playPriority === true') < recycle.indexOf('_resetPocketEngineForBackend'),
    'the live-path check must come before the teardown',
  );
});

// ── A reload failure does not swap the narrator mid-chapter ─────────────────
// Symptom: the voice changed to Kokoro partway through a chapter after one
// failed recycle reload.

test('reloading an engine that already ran retries before stepping down', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /const POCKET_RELOAD_BACKOFF_MS = Object\.freeze\(\[2000, 6000\]\);/);
  const wrapper = slice(audio, 'async function _loadPocketEngine() {', '\nasync function _loadPocketEngineOnce(');
  assert.match(wrapper, /const isReload = _enginesLoadedThisPage\.has\(engine\);/);
  assert.match(wrapper, /_loadPocketEngineOnce\(\{ suppressDegrade: isReload \}\)/,
    'a first load still steps down immediately; a reload does not');
  assert.match(wrapper, /_loadPocketEngineOnce\(\{ suppressDegrade: !last \}\)/,
    'the final retry is allowed to step down, so the reader is never left in silence');
  const once = slice(audio, 'async function _loadPocketEngineOnce(options = {}) {', '\n}\n\n// A failed engine');
  assert.match(once, /if \(!options\.suppressDegrade\) _degradeNarrationEngine\(engineLabel, e\);/);
});

// ── Gentle emotion actually reaches the render ──────────────────────────────
// Symptom (found by tools/longform_bench.mjs): expressive narration was flat.
// Every shipped voice lists only a neutral reference FILE, and the delivery
// emotion was clipped to that list, so every paragraph rendered at the neutral
// temperature. Delivery and file are now separate questions.

test('delivery emotion is not clipped to the voice files that exist', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const resolve = slice(audio, 'function _resolveEmotionForVoice(', '\n}\n');
  assert.doesNotMatch(resolve, /availableEmotions/, 'reference files must not decide the delivery emotion');
  assert.match(resolve, /const available = mode === 'expressive' \? POCKET_ALL_EMOTIONS : POCKET_SAFE_EMOTIONS;/);
  // The file still falls back to neutral, so the timbre stays one narrator...
  const utils = await read('public/assets/js/engine_utils.js');
  assert.match(utils, /if \(voice && voice\.availableEmotions\.includes\(emotion\)\) return `\$\{base\}_\$\{emotion\}`;\s*\n\s*return `\$\{base\}_\$\{window\.POCKET_DEFAULT_EMOTION\}`;/);
  // ...and the onset fade keys on the FILE, so a delivery-only change adds none.
  assert.match(audio, /const switched = _lastSynthesizedVoiceAsset !== null && voiceAsset !== _lastSynthesizedVoiceAsset;/);
  // Gentle: the balanced caps stay inside a narrow band around neutral.
  const caps = slice(audio, 'const POCKET_BALANCED_TEMP_CAPS = {', '};');
  const values = [...caps.matchAll(/: (0\.\d+)/g)].map((m) => Number(m[1]));
  assert.ok(values.length >= 8 && Math.max(...values) - Math.min(...values) <= 0.06, `balanced caps ${values}`);
});

// ── The playback runway follows measured speed ──────────────────────────────
// Symptom: "slow to start". With a cache job running, Play waited for a flat
// 20 paragraphs even on a phone rendering at twice real time.

test('the runway is 20 when slow or unknown and shrinks to 2 when fast', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  const fnSource = slice(buffer, 'export function playbackRunwayForRtf(rtf) {', '\n}\n');
  const runway = new Function('PLAYBACK_RUNWAY_MAX', 'PLAYBACK_RUNWAY_MIN',
    `${fnSource.replace('export ', '')}\n}\nreturn playbackRunwayForRtf;`)(20, 2);
  assert.equal(runway(null), 20, 'no measurement keeps the safe runway');
  assert.equal(runway(1.4), 20, 'slower than real time keeps the safe runway');
  assert.equal(runway(0.95), 20);
  assert.equal(runway(0.49), 2, 'the benchmarked desktop speed starts almost at once');
  assert.equal(runway(0.5), 2);
  const mid = runway(0.72);
  assert.ok(mid > 2 && mid < 20, `0.72 interpolates (got ${mid})`);
  assert.match(buffer, /recordNarrationRtf\(diag\.realTimeFactor\);/);
  assert.match(buffer, /const RTF_MIN_SAMPLES = 3;/, 'one fast paragraph must not unlock playback');
  assert.match(buffer, /stored\.context === _rtfContextKey\(\)/, 'a stored speed only applies to the same engine and threads');
});

// ── A frame-budget cut is a bad render ──────────────────────────────────────
// Symptom: clipped sentence endings. The worker counted chunks it stopped at
// the frame budget before end-of-speech, but only as telemetry.

test('a chunk cut at the frame budget is a fatal verdict, so it is re-rolled', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const inspect = slice(audio, 'function _inspectPocketAudioQuality(', '\n}\n');
  assert.match(inspect, /if \(Number\(result\?\.telemetry\?\.frameBudgetStops\) > 0\) \{\s*\n\s*fatal = true;\s*\n\s*reasons\.push\('frame budget cut'\);/);
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /if \(!control\.frameLimit && reachedFrameBudget && !eosTailComplete\) frameBudgetStops/);
});
