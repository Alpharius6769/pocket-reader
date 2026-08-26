// Kokoro-82M fallback engine for memory-constrained devices.
//
// Pocket TTS is autoregressive: three sessions (~126 MB) plus a ~47 MB fp32
// state crossing the JS/WASM boundary every frame. That sustained churn is what
// kills a 4 GB iPhone mid-cache. Kokoro is one 86 MB non-autoregressive session
// with no per-frame state, so the pattern that was fatal does not exist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const policy = await import(
  new URL('../public/assets/js/pocket_backend_policy.js', import.meta.url).href
);

test('constrained devices route to Kokoro, capable ones keep Pocket', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.6 Mobile Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) Chrome/126 Mobile Safari/537.36';
  const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36';

  // Safari reports neither RAM nor model, so iOS must not depend on either.
  const ios = policy.selectNarrationEngine({ userAgent: IPHONE, storage: null });
  assert.equal(ios.engine, policy.KOKORO_ENGINE);
  assert.equal(ios.automatic, true);

  assert.equal(
    policy.selectNarrationEngine({ userAgent: ANDROID, deviceMemory: 4, storage: null }).engine,
    policy.KOKORO_ENGINE, 'a 4 GB Android must fall back');
  assert.equal(
    policy.selectNarrationEngine({ userAgent: ANDROID, deviceMemory: 8, storage: null }).engine,
    policy.POCKET_ENGINE, 'a roomy Android keeps Pocket');
  assert.equal(
    policy.selectNarrationEngine({ userAgent: DESKTOP, deviceMemory: 16, storage: null }).engine,
    policy.POCKET_ENGINE, 'desktop keeps Pocket');
  assert.equal(
    policy.selectNarrationEngine({ userAgent: DESKTOP, deviceMemory: 16, lowMemoryMode: true, storage: null }).engine,
    policy.KOKORO_ENGINE, 'low-memory mode forces the light engine');
});

test('an explicit engine choice overrides automatic selection in both directions', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/604.1';
  const forcedPocket = policy.selectNarrationEngine({ userAgent: IPHONE, override: 'pocket', storage: null });
  assert.equal(forcedPocket.engine, 'pocket');
  assert.equal(forcedPocket.automatic, false, 'a manual choice must not report as automatic');

  const forcedKokoro = policy.selectNarrationEngine({ userAgent: 'desktop', override: 'kokoro', storage: null });
  assert.equal(forcedKokoro.engine, 'kokoro');

  // Junk must not be honoured as an engine.
  assert.equal(policy.selectNarrationEngine({ userAgent: 'desktop', override: 'nonsense', storage: null }).engine,
    policy.POCKET_ENGINE);
});

test('the six voices are the graded picks and the roster is coherent', () => {
  const voices = policy.KOKORO_VOICES;
  assert.equal(voices.length, 6);
  assert.equal(voices.filter((v) => v.gender === 'female').length, 3);
  assert.equal(voices.filter((v) => v.gender === 'male').length, 3);
  for (const id of ['af_heart', 'af_bella', 'bf_emma', 'am_michael', 'am_fenrir', 'am_puck']) {
    assert.ok(voices.some((v) => v.id === id), `${id} must be present`);
  }
  assert.ok(policy.isKokoroVoice(policy.KOKORO_DEFAULT_VOICE), 'the default must be a real Kokoro voice');
  assert.equal(policy.isKokoroVoice('donald_malone'), false, 'a Pocket voice is not a Kokoro voice');
});

test('the worker speaks the existing engine protocol', async () => {
  const worker = await read('public/assets/js/kokoro_worker.js');
  // audio_core needs no special case only if these match pocket_worker.
  for (const marker of ['init_done', 'init_error', 'generate_done', 'generate_error', 'dispose_backend']) {
    assert.ok(worker.includes(marker), `${marker} is part of the shared protocol`);
  }
  assert.match(worker, /sampleRate: SAMPLE_RATE/);
  assert.match(worker, /const SAMPLE_RATE = 24000;/, 'Kokoro is 24 kHz, audio_core default');
  // Audio is transferred, not copied — it can be seconds of float32.
  assert.match(worker, /\[audio\.buffer\]/);
});

test('the worker bounds its own memory the way this device needs', async () => {
  const worker = await read('public/assets/js/kokoro_worker.js');
  // 512 is a hard graph limit; splitting keeps long paragraphs whole where
  // truncating would silently drop audio.
  assert.match(worker, /const MAX_TOKENS = 512;/);
  assert.match(worker, /function chunkTokenIds\(ids\)/);
  assert.doesNotMatch(worker, /\.slice\(0, MAX_TOKENS\)/, 'must split, never truncate');
  // Same preallocate-from-Content-Length shape the Pocket loader needed.
  assert.match(worker, /const out = new Uint8Array\(declared\);/);
  // Only one voice table resident at a time.
  assert.match(worker, /voiceCache\.clear\(\);/);
  // A long blocking session build must not trip the main-thread watchdog.
  assert.match(worker, /phase: 'blocking', budgetMs: MODEL_TIMEOUT_MS/);
});

test('kokoro assets are addressed through the proxy, never a third-party origin', async () => {
  const worker = await read('public/assets/js/kokoro_worker.js');
  const urls = worker.match(/https?:\/\/[a-zA-Z0-9._/-]+/g) || [];
  for (const url of urls) {
    assert.ok(/pocket-reader-proxy\./.test(url),
      `${url} must go through the proxy so COEP isolation and offline still hold`);
  }
  assert.match(worker, /\/models\/kokoro\/v1\.0/);
  assert.match(worker, /\/models\/kokoro\/phonemizer\//);
});

test('the engine is resolved from the shell, not from lazy-loaded audio_core', async () => {
  const utils = await read('public/assets/js/engine_utils.js');
  const settings = await read('public/assets/js/settings_manager.js');

  // The first version read a global published by audio_core, which is
  // lazy-loaded with the narration runtime. A cold session therefore resolved
  // Pocket even on a device that should never run it, and Settings rendered an
  // empty Kokoro voice list. Both now import the policy directly, so the answer
  // exists from the first frame -- which is what "best engine at startup" needs.
  assert.match(utils, /import \{\s*[\s\S]{0,120}selectNarrationEngine,/);
  assert.doesNotMatch(utils, /typeof window\.resolveNarrationEngineChoice === 'function'/,
    'must not depend on audio_core publishing a global');
  assert.match(utils, /if \(choice\?\.engine === 'kokoro'\) return 'kokoro';/);
  // Decided once at boot and observable before narration is requested.
  assert.match(utils, /window\._narrationEngineDecision = decision;/);
  assert.match(utils, /Narration engine resolved at startup/);

  assert.match(settings, /selectNarrationEngine,/, 'settings imports the policy directly');
  assert.doesNotMatch(settings, /window\.describeNarrationEngineChoice\?\.\(\)/,
    'settings must not depend on audio_core being loaded');
});

test('audio_core loads and routes the Kokoro worker', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /if \(engine !== 'pocket' && engine !== 'kokoro'\) return false;/);
  assert.match(audio, /kokoro_worker\.js\?v=kokoro-v\d+/);
  // The Pocket backend planner has nothing to decide for a single WASM graph.
  assert.match(audio, /const backendPlan = engine === 'kokoro'/);
  assert.match(audio, /engineLabel = engine === 'kokoro' \? 'Kokoro TTS' : 'Pocket TTS'/);
  // A voice id from the other engine must never be handed to a worker.
  assert.match(audio, /window\.resolveVoiceForEngine = function/);
  assert.match(audio, /if \(engine === 'kokoro'\) return window\.resolveVoiceForEngine\('kokoro', voice\);/);
});

test('voice ids cannot leak across engines', async () => {
  // resolveVoiceForEngine is defined on window inside a browser-only module, so
  // exercise the policy predicate it relies on.
  assert.equal(policy.isKokoroVoice('donald_malone'), false);
  assert.equal(policy.isKokoroVoice('af_heart'), true);
  assert.equal(policy.KOKORO_DEFAULT_VOICE, 'af_heart',
    'af_heart is the A-grade voice and the Kokoro-only default');
});

test('settings expose the Kokoro voice list without duplicating the engine control', async () => {
  const settings = await read('public/assets/js/settings_manager.js');
  const html = await read('public/index.html');
  const ui = await read('public/assets/js/ui_controller.js');

  assert.match(settings, /export function renderNarrationEngineControls\(\)/);
  // The container has to exist or the render is a silent no-op.
  assert.match(html, /id="narration-engine-controls"/);
  assert.match(ui, /window\.renderNarrationEngineControls\(\)/);
  // Voice picker is hidden unless Kokoro is the engine actually running —
  // offering a voice the active engine cannot speak is worse than none.
  assert.match(settings, /display:\$\{kokoroActive \? 'block' : 'none'\}/);
  assert.match(settings, /const kokoroActive = !usingWebSpeech && choice\.engine === 'kokoro'/);
  // Device Voice has no neural voice at all, so nothing Kokoro shows there.
  assert.match(settings, /const usingWebSpeech = window\.userProfile\?\.settings\?\.voiceEngine === 'webspeech'/);
});

test('phoneme clauses are rejoined so punctuation pauses survive', async () => {
  const worker = await read('public/assets/js/kokoro_worker.js');
  const fn = worker.slice(worker.indexOf('async function generate('),
                          worker.indexOf('self.onmessage'));
  assert.ok(fn.length > 0, 'generate() not found');
  // A plain space join would silently discard every pause the writing specified.
  assert.doesNotMatch(fn, /phonemes\.join\(' '\)/);
  assert.match(fn, /clauses\.join\(', '\)/);
  // The array shape is the documented return; a bare string must still work.
  assert.match(fn, /Array\.isArray\(phonemes\) \? phonemes : \[String\(phonemes \|\| ''\)\]/);
  assert.match(fn, /\.filter\(Boolean\)/, 'empty clauses must not become stray commas');
});

test('unmapped phoneme characters are skipped, never emitted as junk ids', async () => {
  const worker = await read('public/assets/js/kokoro_worker.js');
  const fn = worker.slice(worker.indexOf('function tokenizePhonemes('),
                          worker.indexOf('// The graph\'s sequence axis'));
  assert.match(fn, /if \(id !== undefined\) ids\.push\(id\);/,
    'an unknown symbol must be dropped, not pushed as undefined');
});

// Reported from a live build: "Voice Engine" and "Narration engine" were two
// separate selects saying overlapping things, and Automatic always read "Pocket
// on this device" because it rendered a default rather than the real decision.
test('engine choice is one control, not two overlapping ones', async () => {
  const html = await read('public/index.html');
  const settings = await read('public/assets/js/settings_manager.js');
  const audio = await read('public/assets/js/audio_core.js');

  // The neural choice now lives in the single Voice Engine select.
  const select = html.slice(html.indexOf('id="voice-engine-select"'),
                            html.indexOf('id="narration-engine-controls"'));
  for (const value of ['"auto"', '"pocket"', '"kokoro"', '"webspeech"']) {
    assert.ok(select.includes(`value=${value}`), `the merged select needs ${value}`);
  }
  // The duplicate select must be gone.
  assert.doesNotMatch(settings, /id="narration-engine-select"/,
    'the second engine select must not come back');
  assert.doesNotMatch(html, /id="narration-engine-select"/);

  // Both neural values collapse to the neural path, with the model recorded as
  // the narration override.
  assert.match(audio, /if \(engineVal === 'auto' \|\| engineVal === 'kokoro' \|\| engineVal === 'pocket'\)/);
  assert.match(audio, /writeNarrationEngineOverride\(localStorage, engineVal === 'auto' \? null : engineVal\)/);
});

test('Automatic is labelled with the engine actually detected for this device', async () => {
  const settings = await read('public/assets/js/settings_manager.js');
  // Previously hardcoded to Pocket, so it read "Pocket on this device" even on
  // hardware routed to Kokoro.
  assert.match(settings, /autoOption\.textContent = `Automatic - \$\{choice\.engine === 'kokoro' \? 'Kokoro' : 'Pocket TTS'\} on this device`/);
  assert.match(settings, /Detected: \$\{_escapeSettingsHtml\(choice\.reason/);
});

test('first-run detection resolves the narration engine, not just the backend', async () => {
  const setup = await read('public/assets/js/device_setup.js');
  assert.match(setup, /selectNarrationEngine,/, 'device_setup must import the selector');
  assert.match(setup, /narrationEngine: narration\.engine,/);
  assert.match(setup, /narrationEngineReason: narration\.reason,/);
  // And it has to be visible in the summary the reader is shown.
  assert.match(setup, /record\.narrationEngine === 'kokoro' \? 'Kokoro-82M' : 'Pocket TTS'/);
});
