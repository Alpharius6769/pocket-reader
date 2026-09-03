// Field reports from a desktop session and a Pixel 6 Pro, 2026-09-03, with the
// device's own diagnostic export as evidence.
//
// Theme: three of the six are one sentence disagreeing with another sentence
// about the same fact -- a label that could not see the measurement beside it,
// a "device test" that read back the answer it was meant to produce, and a
// retry that replayed a route the engine underneath it had already left.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const policy = await import('../public/assets/js/pocket_backend_policy.js');

// ── "Automatic - Kokoro on this device" on a phone that resolves to Pocket ──

test('ignoreOverride suppresses the manual choice without blinding the measurement', () => {
  // `override: null` cannot express "ignore the manual choice" -- `??` falls
  // through on null, straight back to storage. The only way to suppress it was
  // `storage: null`, which also hid the measured headroom the ladder turns on.
  const storage = { getItem: (key) => (String(key).includes('override') ? 'kokoro' : null) };
  const pixel = {
    userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36',
    deviceMemory: 8,
    hardwareConcurrency: 8,
    memoryHeadroomMb: 1024,
  };

  const honoured = policy.selectNarrationEngine({ ...pixel, storage });
  assert.equal(honoured.engine, 'kokoro');
  assert.equal(honoured.automatic, false, 'a manual choice is still a manual choice');

  const automatic = policy.selectNarrationEngine({ ...pixel, ignoreOverride: true, storage });
  assert.equal(automatic.engine, 'pocket', 'the measurement decides when the override is ignored');
  assert.equal(automatic.automatic, true);
  assert.match(automatic.reason, /measured 1024 MB/);

  // The old shape, reproduced: suppressing the override by removing storage
  // takes the headroom with it and lands on the wrong tier.
  const blinded = policy.selectNarrationEngine({
    userAgent: pixel.userAgent, override: null, storage: null,
  });
  assert.equal(blinded.engine, 'kokoro', 'this is the answer the label used to show');
});

test('the Settings label reads the same measurement as the line beneath it', async () => {
  // The panel contradicted itself: "Automatic - Kokoro on this device" directly
  // above "Detected: This device measured 1024MB of working memory", which is
  // the reason string for Pocket. Two calls, one of which could not see the
  // measurement.
  const source = await read('public/assets/js/settings_manager.js');
  const render = source.slice(
    source.indexOf('export function renderNarrationEngineControls'),
    source.indexOf('window.renderNarrationEngineControls = renderNarrationEngineControls'),
  );
  const autoPick = render.slice(render.indexOf('const autoPick = selectNarrationEngine({'), render.indexOf('const select = document.getElementById'));
  assert.match(autoPick, /ignoreOverride: true/);
  assert.match(autoPick, /storage: localStorage/);
  assert.doesNotMatch(autoPick, /storage: null/, 'storage is what carries the measurement');
  assert.match(autoPick, /deviceMemory:/, 'the reported-RAM fallback needs the RAM figure too');
});

test('a device test measures rather than echoing the manual choice', async () => {
  // Reported: "Re-run device test always recommends the audio engine I have it
  // manually set to." It passed storage and no override, so it read the choice
  // back out ("Chosen in Settings.") -- and wrote it into the device record as
  // narrationEngine, turning a preference into the stored measurement.
  const source = await read('public/assets/js/device_setup.js');
  const call = source.slice(
    source.indexOf('const narration = selectNarrationEngine({'),
    source.indexOf('const record = writePocketDeviceSetup('),
  );
  assert.match(call, /ignoreOverride: true/);
  assert.match(call, /memoryHeadroomMb: memory\.measured/, 'the probe it just ran must still reach it');
});

// ── A retry that outlived its engine ────────────────────────────────────────

test('the quality-guard retry re-resolves the route after the engine reload', async () => {
  // From the device diagnostic:
  //   quality guard retrying...  voice: expr-voice-3-f  first: "Pocket backend reset"
  //   Pocket runtime: WASM ... 4 WASM threads
  //   WASM decode-block4 core active (83MB).
  //   rejected both attempts. qualityReason: "Unknown built-in voice: expr-voice-3-f"
  // expr-voice-3-f is a Kitten voice; "Unknown built-in voice" is thrown by
  // pocket_worker.js. The retry rebuilds whatever engine is active now and then
  // replayed a route belonging to the one that just went away.
  const source = await read('public/assets/js/audio_core.js');
  const generate = source.match(/window\.generateChunk = async function[\s\S]*?\n};/)?.[0] || '';
  assert.ok(generate.length > 1000, 'generateChunk must be locatable');

  const reloadAt = generate.indexOf('await _loadPocketEngine();');
  const resolveAt = generate.indexOf('const retryEngine = _resolveActiveEngine();');
  const attemptAt = generate.indexOf('_generatePocketAttempt(null, text, retryRoute, 1)');
  assert.ok(reloadAt !== -1 && resolveAt !== -1 && attemptAt !== -1);
  assert.ok(reloadAt < resolveAt, 'resolved AFTER the reload, or it learns nothing');
  assert.ok(resolveAt < attemptAt);
  assert.match(generate, /retryEngine === route\.engine\s*\n?\s*\? route/,
    'an unchanged engine must keep its route, emotion plan and all');
});

// ── Play on a short runway ──────────────────────────────────────────────────

test('Play restarts the cache job the runway gate is waiting on', async () => {
  // Reported on both platforms: stop caching, press Play before 20/20, and
  // Virtue reports the shortfall forever. Nothing resumed. The gate was right
  // to refuse playback and wrong to leave the job stopped.
  const source = await read('public/assets/js/audio_core.js');
  const toggle = source.slice(
    source.indexOf('export function togglePlayState'),
    source.indexOf('let resumePausedPocketAudio = false;'),
  );
  assert.match(toggle, /window\.BufferManager\.resume\(\)/, 'a paused job resumes');
  assert.match(toggle, /window\._resumeCaching\?\.\(\)/, 'a stopped job restarts');
  assert.match(toggle, /Picking caching back up/, 'and says so, instead of repeating the shortfall');
  // Still a gate: it must not fall through into playback.
  const returnAt = toggle.lastIndexOf('return;');
  const resumeAt = toggle.indexOf('window._resumeCaching');
  assert.ok(resumeAt < returnAt, 'playback stays blocked until the runway is real');
});

// ── A rating beat for something that was not a rating ───────────────────────

test('virtue_smile is fired only by an actual star rating', async () => {
  // Screenshot: "A solid middle-of-the-road score. I'm glad it was still
  // enjoyable." with nothing rated. That is verbatim virtue_smile's pool, whose
  // declared trigger in the data is "User rates a story 3 stars".
  const virtue = await read('public/assets/js/virtue_controller.js');
  const smile = virtue.slice(virtue.indexOf('"virtue_smile": {'), virtue.indexOf('"virtue_smile": {') + 400);
  assert.match(smile, /"trigger": "User rates a story 3 stars\."/,
    'if this stops being a rating trigger the rule below can relax');

  for (const file of ['public/assets/js/buffer_manager.js', 'public/assets/js/settings_manager.js']) {
    const source = await read(file);
    assert.doesNotMatch(source, /triggerVirtue\('virtue_smile'\)/,
      `${file} must not announce a review the reader never wrote`);
  }
  // The one legitimate caller is the rating handler itself.
  const library = await read('public/assets/js/library_manager.js');
  const uses = [...library.matchAll(/triggerVirtue\('virtue_smile'\)/g)];
  assert.equal(uses.length, 1);
  const before = library.slice(Math.max(0, uses[0].index - 200), uses[0].index);
  assert.match(before, /rating === 3/, 'and only on three stars');
});

// ── The download that looked like a dead worker ─────────────────────────────

test('a model download reports progress and cannot stall forever', async () => {
  // Reported: Kokoro hangs at 0 paragraphs while Kitten and Pocket cache fine.
  // fetchBuffer's timeout wrapped fetch() alone, which resolves at the response
  // HEADERS -- so the body read had no deadline, and nothing was posted for its
  // whole duration. audio_core allows 75 s of worker silence; on the reporting
  // device's own "4g / 10 Mbps" the 86 MB Kokoro model is ~69 s of it, against
  // ~19 s for Kitten's 23.8 MB.
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /const WORKER_SILENCE_TIMEOUT_MS = 75000;/,
    'the budget these downloads have to fit inside');

  for (const file of ['public/assets/js/kokoro_worker.js', 'public/assets/js/kitten_worker.js']) {
    const source = await read(file);
    const fetchBuffer = source.slice(
      source.indexOf('async function fetchBuffer(url, label)'),
      source.indexOf('async function loadOrtRuntime()'),
    );
    assert.ok(fetchBuffer.length > 400, `${file}: fetchBuffer must be locatable`);
    assert.match(fetchBuffer, /withTimeout\(\s*\n?\s*reader\.read\(\), STREAM_IDLE_TIMEOUT_MS/,
      `${file}: the body read needs its own deadline`);
    assert.match(fetchBuffer, /loadedBytes: filled/, `${file}: progress is proof of life`);
    assert.match(fetchBuffer, /totalBytes: out\.byteLength/);
    assert.match(fetchBuffer, /STREAM_PROGRESS_INTERVAL_MS/, `${file}: throttled, not per chunk`);
    // An idle timeout, not a transfer budget: a slow connection must finish.
    const idle = Number(source.match(/const STREAM_IDLE_TIMEOUT_MS = (\d+);/)?.[1]);
    const total = Number(source.match(/const FETCH_TIMEOUT_MS = (\d+);/)?.[1]);
    assert.ok(idle > 0 && idle < total, `${file}: idle ${idle} must be well under ${total}`);
  }
});
