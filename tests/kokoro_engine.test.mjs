// Kokoro-82M fallback engine for memory-constrained devices.
//
// Pocket TTS is autoregressive: three sessions (~126 MB) plus a ~47 MB fp32
// state crossing the JS/WASM boundary every frame. That sustained churn is what
// kills a 4 GB iPhone mid-cache. Kokoro is one 86 MB non-autoregressive session
// with no per-frame state, so the pattern that was fatal does not exist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const policy = await import(
  new URL('../public/assets/js/pocket_backend_policy.js', import.meta.url).href
);

// Superseded by the three-tier ladder in kitten_engine.test.mjs, which owns the
// per-generation cases. What stays here are the invariants that are still true
// regardless of tier count.
test('constrained devices never get Pocket, and iOS never depends on RAM', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.6 Mobile Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) Chrome/126 Mobile Safari/537.36';
  const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36';

  // Safari reports neither RAM nor model, so iOS must not depend on either.
  const ios = policy.selectNarrationEngine({ userAgent: IPHONE, storage: null,
    screenWidth: 0, screenHeight: 0 });
  assert.notEqual(ios.engine, policy.POCKET_ENGINE,
    'an unidentifiable iPhone must never be handed the heaviest engine');
  assert.equal(ios.automatic, true);

  assert.equal(
    policy.selectNarrationEngine({ userAgent: ANDROID, deviceMemory: 4, storage: null }).engine,
    policy.KOKORO_ENGINE, 'a 4 GB Android must fall back');
  // Cores are stated explicitly. Leaving them out let the selector fall back to
  // globalThis.navigator.hardwareConcurrency, so this passed on a dev machine
  // with 8+ cores and failed on CI's smaller runner -- the assertion was reading
  // the host rather than the rule. Android needs 6 GB AND a good CPU for Pocket.
  assert.equal(
    policy.selectNarrationEngine({ userAgent: ANDROID, deviceMemory: 8, hardwareConcurrency: 8, storage: null }).engine,
    policy.POCKET_ENGINE, 'a roomy Android with a real CPU keeps Pocket');
  assert.equal(
    policy.selectNarrationEngine({ userAgent: ANDROID, deviceMemory: 8, hardwareConcurrency: 4, storage: null }).engine,
    policy.KOKORO_ENGINE, 'RAM alone is not enough -- a weak CPU still drops a tier');
  assert.equal(
    policy.selectNarrationEngine({ userAgent: DESKTOP, deviceMemory: 16, storage: null }).engine,
    policy.POCKET_ENGINE, 'desktop keeps Pocket');
  assert.notEqual(
    policy.selectNarrationEngine({ userAgent: DESKTOP, deviceMemory: 16, lowMemoryMode: true, storage: null }).engine,
    policy.POCKET_ENGINE, 'low-memory mode forces a lighter engine');
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
  // Was chunkTokenIds(), a blind slice every 510 ids. Splitting still never
  // truncates, but it now falls between clauses instead of inside a word.
  assert.match(worker, /function packUnitsIntoChunks\(units\)/);
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
  // Returns whatever the policy picked, validated against the known tiers.
  // Naming one engine here made 'kitten' unreachable: the policy selected it,
  // this returned 'pocket', and every gate downstream followed.
  assert.match(utils, /NARRATION_ENGINE_TIERS\.includes\(choice\.engine\)/);
  assert.match(utils, /return choice\.engine;/);
  // Decided once at boot and observable before narration is requested.
  assert.match(utils, /window\._narrationEngineDecision = decision;/);
  assert.match(utils, /Narration engine resolved at startup/);

  assert.match(settings, /selectNarrationEngine,/, 'settings imports the policy directly');
  assert.doesNotMatch(settings, /window\.describeNarrationEngineChoice\?\.\(\)/,
    'settings must not depend on audio_core being loaded');
});

test('audio_core loads and routes the Kokoro worker', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  // Generalised: naming one engine here is what shipped Kitten selectable,
  // routed, and dead - the loader refused it outright.
  assert.match(audio, /if \(engine !== 'pocket' && !_isStyleTts2Engine\(engine\)\) return false;/);
  assert.match(audio, /function _isStyleTts2Engine\(engine\) \{/);
  assert.match(audio, /kokoro_worker\.js\?v=kokoro-v\d+/);
  // The Pocket backend planner has nothing to decide for a single WASM graph.
  assert.match(audio, /const backendPlan = _isStyleTts2Engine\(engine\)/);
  assert.match(audio, /const ENGINE_LOAD_LABELS = \{ kokoro: 'Kokoro TTS', kitten: 'Kitten TTS', pocket: 'Pocket TTS' \}/);
  // A voice id from the other engine must never be handed to a worker.
  assert.match(audio, /window\.resolveVoiceForEngine = function/);
  assert.match(audio, /if \(_isStyleTts2Engine\(engine\)\) return window\.resolveVoiceForEngine\(engine, voice\);/);
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
  // Generalised to three engines: the picker shows when the RESOLVED engine
  // has a shell-side voice list, not when it happens to be Kokoro.
  assert.match(settings, /display:\$\{voicePickerActive \? 'block' : 'none'\}/);
  assert.match(settings, /const voicePickerActive = !usingWebSpeech && voices\.length > 0/);
  assert.match(settings, /const voices = voicesForEngine\(choice\.engine\)/,
    'the list must follow the resolved engine, never a fixed constant');
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
  // And a comma join discarded which KIND of pause it was. The real mark is
  // restored per clause now; see the punctuation test below for the contract.
  // Counted on the NORMALISED string, not the raw one: alignment compares mark
  // count against clause count, and normalizeForPocketTts can change the mark
  // count (a stripped [2s] tag, an expanded contraction).
  assert.match(fn, /const marks = clauseMarksFrom\(spoken\);/);
  assert.match(fn, /const phonemes = await phonemize\(spoken, 'en-us'\);/);
  assert.doesNotMatch(fn, /clauses\.join\(', '\)/);
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
  assert.match(audio, /engineVal === 'auto' \|\| engineVal === 'kokoro'/);
  assert.match(audio, /engineVal === 'kitten' \|\| engineVal === 'pocket'/,
    'kitten is a UI value too, or picking it falls through to the device voice');
  assert.match(audio, /writeNarrationEngineOverride\(localStorage, engineVal === 'auto' \? null : engineVal\)/);
});

test('Automatic is labelled with the engine actually detected for this device', async () => {
  const settings = await read('public/assets/js/settings_manager.js');
  // Previously hardcoded to Pocket, so it read "Pocket on this device" even on
  // hardware routed to Kokoro.
  assert.match(settings, /const ENGINE_LABELS = \{ kokoro: 'Kokoro', kitten: 'Kitten', pocket: 'Pocket TTS' \}/);
  assert.match(settings, /ENGINE_LABELS\[autoPick\.engine\]/);
  assert.match(settings, /Detected: \$\{_escapeSettingsHtml\(choice\.reason/);
});

test('first-run detection resolves the narration engine, not just the backend', async () => {
  const setup = await read('public/assets/js/device_setup.js');
  assert.match(setup, /selectNarrationEngine,/, 'device_setup must import the selector');
  assert.match(setup, /narrationEngine: narration\.engine,/);
  assert.match(setup, /narrationEngineReason: narration\.reason,/);
  // And it has to be visible in the summary the reader is shown.
  assert.match(setup, /SETUP_ENGINE_NAMES = \{ kokoro: 'Kokoro-82M', kitten: 'KittenTTS Nano', pocket: 'Pocket TTS' \}/);
});

// Reported from a live build: the reader page's own engine dropdown still
// offered only "Pocket TTS" and "Device", so a reader routed to Kokoro could see
// it in Settings but neither switch it nor pick its voices from the page they
// actually narrate on.
test('the reader playbar offers the same engines as Settings', async () => {
  const html = await read('public/index.html');
  const select = html.slice(html.indexOf('id="reader-engine-select"'),
                            html.indexOf('id="voice-selector"'));
  for (const value of ['"auto"', '"pocket"', '"kokoro"', '"webspeech"']) {
    assert.ok(select.includes(`value=${value}`), `the reader select needs ${value}`);
  }
});

test('the reader voice list follows the engine that will actually run', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  // 'pocket' is the collapsed UI value; the running model may be Kokoro.
  assert.match(audio, /const neuralEngine = engineVal === 'pocket' \? _resolveActiveEngine\(\) : engineVal;/);
  // Keyed on the resolved engine having a shell-side list, so a third tier
  // cannot be left showing the previous engine's voices.
  assert.match(audio, /const neuralVoices = voicesForEngine\(neuralEngine\);/);
  assert.match(audio, /if \(neuralVoices\.length\) \{/);
  // Grouped by gender like the Pocket list, with grades shown.
  assert.match(audio, /<optgroup label="Female voices">/);
  assert.match(audio, /byGender\('male'\)/);
  // The playbar select must show the real choice, not the collapsed value.
  assert.match(audio, /if \(playbarSel\) playbarSel\.value = controlValue;/);
});

test('a Kokoro voice id is never canonicalised against the Pocket voice list', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const handler = audio.slice(audio.indexOf('window.onVoiceSelectionChange = function'),
                              audio.indexOf('window.switchReaderVoiceEngine = switchReaderVoiceEngine'));
  // Covers BOTH neural engines now: a Kitten id reaching canonicalPocketVoice
  // would be rewritten to donald_malone just as a Kokoro one would.
  const neuralIdx = handler.indexOf('const neuralEngine =');
  const canonIdx = handler.indexOf('canonicalPocketVoice');
  assert.ok(neuralIdx >= 0, 'neural ids need their own branch');
  assert.ok(canonIdx < 0 || neuralIdx < canonIdx,
    'the neural branch must return before canonicalPocketVoice rewrites the id');
  assert.match(handler, /isKittenVoice\(newVoice\)/);
  assert.match(handler, /window\.userProfile\.settings\[savedKey\] = newVoice;/);
});

// Audit findings, 2026-08-26. None of these could surface in a structural test
// alone; each was found by checking the worker against what is actually hosted
// and against the protocol's caching behaviour.
test('ORT wasm binaries are pinned, because only the threaded ones are published', async () => {
  const worker = await read('public/assets/js/kokoro_worker.js');
  // ort-wasm-simd.wasm and ort-wasm.wasm both 404 on the proxy. Handed a bare
  // base directory, ORT derives the filename itself and asks for the
  // non-threaded build when numThreads is 1 -- so base + numThreads:1 was a
  // guaranteed 404 and the engine could never have initialised at all.
  assert.match(worker, /ort\.env\.wasm\.wasmPaths = \{/);
  assert.match(worker, /mjs: `\$\{ORT_BASE\}ort-wasm-simd-threaded\.mjs`/);
  assert.match(worker, /wasm: `\$\{ORT_BASE\}ort-wasm-simd-threaded\.wasm`/);
  assert.doesNotMatch(worker, /ort\.env\.wasm\.wasmPaths = ORT_BASE;/,
    'a bare base string lets ORT pick a filename that is not hosted');
  assert.doesNotMatch(worker, /ort\.env\.wasm\.numThreads = 1;/,
    'a hardcoded 1 forces the non-threaded binary');
  assert.match(worker, /const isolated = self\.crossOriginIsolated === true/);
});

test('a cancelled generation fails instead of caching truncated audio', async () => {
  const worker = await read('public/assets/js/kokoro_worker.js');
  const fn = worker.slice(worker.indexOf('async function generate('),
                          worker.indexOf('self.onmessage'));
  // Breaking out of the loop resolved generate_done with partial audio, which
  // the caller caches — a paragraph interrupted once stayed half-spoken forever.
  assert.doesNotMatch(fn, /if \(cancelRequested\) break;/);
  assert.match(fn, /if \(cancelRequested\) throw new Error\('Narration cancelled\.'\);/);
  assert.match(fn, /if \(pieces\.length !== chunks\.length\) throw new Error/);
});

// The most consequential audit finding: caching is the entire reason Kokoro
// exists on these devices, and it was switched off for them. BufferManager
// tested for the literal 'pocket', so _resolveActiveEngine() returning 'kokoro'
// hid the caching UI and returned, and Away Mode disabled itself because the
// merged select now reports 'auto'/'kokoro' rather than 'pocket'.
test('caching and Away Mode treat Kokoro as a neural engine', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  // buffer_manager keeps its OWN copy. Every engine must be in it, or caching
  // switches itself off for the tier that was added to serve those devices.
  const bufAt = buffer.indexOf('function _isNeuralEngine');
  const bufBody = buffer.slice(bufAt, bufAt + 400);
  for (const e of ['pocket', 'kokoro', 'kitten']) {
    assert.ok(bufBody.includes(`'${e}'`), `buffer_manager _isNeuralEngine must accept ${e}`);
  }
  assert.match(buffer, /function _isNeuralControlValue\(value\) \{\s*\n\s*return value !== 'webspeech';/);

  // The bail-out that hid the caching UI.
  assert.match(buffer, /if \(!_isNeuralEngine\(engine\)\) \{/);
  assert.doesNotMatch(buffer, /const engine = _resolveActiveEngine\(\);\s*\n\s*if \(engine !== 'pocket'\) \{/);

  // Away Mode read the select, which now yields 'auto' or 'kokoro'.
  assert.match(buffer, /if \(!_isNeuralControlValue\(selectedEngine\)\) \{/);
  assert.doesNotMatch(buffer, /if \(selectedEngine !== 'pocket'\) \{/);

  // And the modal gate, which only worked because both engines store
  // voiceEngine:'pocket' — now explicit rather than incidental.
  assert.match(buffer, /if \(_isNeuralEngine\(activeEngine\)\) \{/);
});

// Reported: switching engines popped a "preparing narration" overlay with no
// story open. switchReaderVoiceEngine is a DEFERRED action, so the Settings
// select was importing audio_core and buffer_manager just to record a
// preference. And every generation gate tested for the literal 'pocket', so a
// Kokoro device fell through to the OS voice — the engine was chosen, listed,
// and never asked to speak.
test('every neural gate in audio_core accepts Kokoro', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const nAt = audio.indexOf('function _isNeuralEngine');
  const nBody = audio.slice(nAt, nAt + 400);
  for (const e of ["'pocket'", "'kokoro'", 'KITTEN_ENGINE']) {
    assert.ok(nBody.includes(e), `_isNeuralEngine must accept ${e}`);
  }
  // The generation paths specifically: returning null here is what made
  // playback fall back to the device voice.
  assert.match(audio, /if \(!_isNeuralEngine\(engine\)\) return null;/);
  // generateChunkStream resolves the engine into a local now, because it also
  // has to hand that engine to _resolvePocketRoute -- it used to pass the
  // literal 'pocket', which rewrote a Kokoro voice into a Pocket emotion asset.
  assert.match(audio, /const engine = _resolveActiveEngine\(\);\s*\n\s*if \(!_isNeuralEngine\(engine\)\) return null;/);
  assert.doesNotMatch(audio, /_resolvePocketRoute\('pocket'/,
    "a route built for the literal 'pocket' cannot serve a Kokoro session");
  // No generation/playback gate may still test the bare literal.
  for (const dead of [
    /const engine = _resolveActiveEngine\(\);\s*\n\s*if \(engine !== 'pocket'\) return null;/,
    /if \(_resolveActiveEngine\(\) !== 'pocket'\) return null;/,
    /if \(!window\.isPlaying \|\| _resolveActiveEngine\(\) !== 'pocket'\) return;/,
  ]) {
    assert.doesNotMatch(audio, dead, 'a pocket-literal gate would strand Kokoro on the device voice');
  }
  // The default voice must follow the engine, not always be a Pocket id.
  assert.match(audio, /function _defaultVoiceForEngine\(engine\)/);
  assert.match(audio, /const defaultVoice = _defaultVoiceForEngine\(engine\);/);
});

test('changing engine does not drag in the narration runtime', async () => {
  const settings = await read('public/assets/js/settings_manager.js');
  const html = await read('public/index.html');
  const loader = await read('public/assets/js/narration_runtime_loader.js');

  // Still deferred — that is correct for narration, wrong for a preference.
  assert.match(loader, /'switchReaderVoiceEngine',/);
  // So the Settings select must not call it directly.
  assert.match(html, /onchange="onNarrationEngineSelect\(this\.value\)"/);
  assert.match(settings, /window\.onNarrationEngineSelect = function/);
  // The runtime is touched only when it is already up.
  assert.match(settings, /if \(window\.__pocketNarrationRuntimeLoaded === true\) \{/);
});

test('Away Mode has first-visit tips like every other page', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  // Anchor on the ASSIGNMENT, not a call site: window._maybeShowPageTips is
  // referenced from showView long before the registry is declared, so
  // indexOf() there yields an empty slice that silently passes nothing.
  const start = ui.indexOf('const _TIPS_BY_VIEW');
  const registry = ui.slice(start, ui.indexOf('window._maybeShowPageTips = ', start));
  assert.match(registry, /'away-mode-view': \[/);
  // Anchored to elements that actually exist, or the tip is skipped silently.
  assert.match(registry, /sel: '#away-quick-add-list'/);
  assert.match(registry, /sel: '#away-queue-list'/);
  const html = await read('public/index.html');
  for (const id of ['away-quick-add-list', 'away-queue-list']) {
    assert.ok(html.includes(`id="${id}"`), `${id} must exist for its tip to render`);
  }
});

// Reported from a live Kokoro session: opening a story showed an EMPTY voice
// dropdown and caching never started.
test('opening a story rebuilds the voice list for the active engine', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const ui = await read('public/assets/js/ui_controller.js');
  const loader = await read('public/assets/js/narration_runtime_loader.js');

  // The list was only built inside switchReaderVoiceEngine, so it was populated
  // when the engine CHANGED and never when a story was opened in a session
  // already on Kokoro.
  assert.match(audio, /window\.refreshVoiceSelectorForEngine = function/);
  // Superseded: the reader now calls the SHELL sync, because the deferred
  // refresher imported the whole runtime just to fill a dropdown.
  assert.match(ui, /viewId === 'reading-view' && typeof window\.syncNarrationControls === 'function'/);
  assert.match(loader, /'refreshVoiceSelectorForEngine',/);
});

test('cache queues never canonicalise a Kokoro voice against the Pocket list', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  // canonicalPocketVoice() rewrites anything not in POCKET_VOICES to
  // donald_malone. Applied to a Kokoro id that silently queues an entire cache
  // job against a voice table Kokoro has no file for — every paragraph would
  // fail on a 404.
  const occurrences = buffer.match(/if \(voicesForEngine\((engine|activeNeural)\)\.length\)/g) || [];
  assert.equal(occurrences.length, 2,
    'both the single-story queue and the Away Mode queue need the engine branch');
  // Imported from the policy, not read off window: audio_core publishes that
  // global and is lazy-loaded, so it is absent exactly when a cache job starts
  // cold.
  assert.match(buffer, /^\s*voicesForEngine,$/m);
  assert.match(buffer, /\? window\.resolveVoiceForEngine\((engine|activeNeural), selected\)/);
  // And the refusal message must describe the real gate, which is neural vs
  // device voice — not Pocket specifically.
  assert.doesNotMatch(buffer, /Away Mode caching requires Pocket TTS/);
});

// Fifth and sixth instances of the same slip, both found by sweeping every
// comparison against the RESOLVED engine rather than the stored setting (which
// is 'pocket' for both neural engines and therefore safe to compare).
test('the playback dispatch and cache decision both accept Kokoro', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const buffer = await read('public/assets/js/buffer_manager.js');

  // Playback: the else branch is Web Speech, so a literal 'pocket' test sent
  // every Kokoro paragraph to the OS voice with the engine loaded and idle.
  assert.match(audio, /if \(_isNeuralEngine\(engine\)\) \{\s*\n\s*await _playGeneratedAudio\(/);
  assert.doesNotMatch(audio, /if \(engine === 'pocket'\) \{\s*\n\s*await _playGeneratedAudio\(/);

  // Cache decision: without this, opening a story on Kokoro never called
  // startCaching at all — no modal, no queue, no narration.
  assert.match(buffer, /if \(_isNeuralEngine\(engine\)\) \{\s*\n\s*window\.startCaching\('Normal'\);/);
  assert.doesNotMatch(buffer, /if \(engine === 'pocket'\) \{\s*\n\s*window\.startCaching\('Normal'\);/);
});

test('no behavioural gate compares the resolved engine to the bare literal', async () => {
  // The stored settings.voiceEngine is 'pocket' for BOTH neural engines, so
  // comparing THAT is safe. Comparing the value returned by
  // _resolveActiveEngine() is not — that is where every one of these bugs lived.
  const files = ['audio_core.js', 'buffer_manager.js'];
  const allowed = [
    // Pocket-only expressive prosody; correctly skipped for an engine without it.
    /if \(_resolveActiveEngine\(\) === 'pocket'\) \{\s*\n\s*try \{ await window\.refreshPocketDeviceCapability/,
    // UI value mapping, not a behavioural gate.
    /const neuralEngine = engineVal === 'pocket' \? _resolveActiveEngine\(\) : engineVal;/,
    // The loadable-engine check, which names both explicitly.
    /if \(engine !== 'pocket' && !_isStyleTts2Engine\(engine\)\) return false;/,
  ];
  for (const name of files) {
    let src = await read(`public/assets/js/${name}`);
    for (const ok of allowed) src = src.replace(ok, '');
    // Anything left that assigns from _resolveActiveEngine and then compares to
    // 'pocket' is a gate that would strand Kokoro.
    const bad = src.match(/const engine = _resolveActiveEngine\(\);[\s\S]{0,120}?engine (===|!==) 'pocket'/g) || [];
    assert.deepEqual(bad, [], `${name} still gates the resolved engine on the bare literal`);
  }
});

// Seventh instance of the same shape, one layer down: a hardcoded 'pocket'
// filename in the service worker instead of a hardcoded 'pocket' engine name.
//
// A dedicated worker inherits its creator's COEP and the browser refuses to run
// one whose own script response does not also assert require-corp — reporting
// it as a bare `error` Event with no message, filename, or line. GitHub Pages
// sends no COEP header, so sw.js stamps one; it stamped only pocket_worker.js.
// Inside a ?tts_fast=1 isolated session that made Kokoro impossible: the worker
// died on construction, audio_core fell back to the device voice and PERSISTED
// 'webspeech' as the engine, and every later story open then found a non-neural
// engine and skipped the cache modal entirely.
test('the service worker stamps isolation headers on every dedicated worker', async () => {
  const serviceWorker = await read('public/sw.js');

  // The predicate must be a suffix match, not a list of names to keep in sync.
  const predicate = serviceWorker.match(
    /function isDedicatedWorkerScript\(pathname\) \{\s*\n\s*return (.+);\s*\n\s*\}/,
  );
  assert.ok(predicate, 'sw.js must classify worker scripts through one predicate');
  const matchesWorkerScript = new Function('pathname', `return ${predicate[1]};`);

  // Find the worker scripts by SHAPE rather than by name, so a future worker
  // that does not follow the _worker.js convention still fails this test
  // instead of silently losing its headers. Only a dedicated worker global
  // owns self.postMessage; the PCM worklet posts through this.port and is
  // correctly excluded, because worklets do not carry the COEP requirement.
  const workerScripts = [];
  for (const name of await readdir(path.join(ROOT, 'public/assets/js'))) {
    if (!name.endsWith('.js')) continue;
    if ((await read(`public/assets/js/${name}`)).includes('self.postMessage(')) workerScripts.push(name);
  }
  assert.ok(workerScripts.includes('kokoro_worker.js'), 'the sweep must see the Kokoro worker');
  assert.ok(workerScripts.includes('pocket_worker.js'), 'the sweep must see the Pocket worker');
  for (const file of workerScripts) {
    assert.ok(
      matchesWorkerScript(`/pocket-reader/assets/js/${file}`),
      `${file} runs as a dedicated worker but sw.js would serve it without COEP, `
      + 'so it cannot start in an isolated narration session',
    );
  }

  // And the stamp must actually be applied on both the network and cache paths.
  const applications = serviceWorker.match(/isWorkerScript \? withNarrationIsolation\(/g) || [];
  assert.equal(applications.length, 3, 'network, versioned-cache and offline-cache paths must all stamp');
  assert.ok(!/indexOf\('\/[a-z_]+_worker\.js'\)/.test(serviceWorker),
    'sw.js must not special-case a single worker filename again');
});

// espeak splits on punctuation and DROPS the mark it split on. Rejoining the
// clauses with ", " turned every sentence end, question and exclamation in a
// paragraph into one long comma-separated run -- a flat delivery that was ours,
// not the model's: Kokoro's vocab carries . ! ? ; : — … and the quote marks.
test('Kokoro is given the punctuation the writing actually had', async () => {
  const worker = await read('public/assets/js/kokoro_worker.js');

  assert.match(worker, /const CLAUSE_MARK_RE = /);
  assert.match(worker, /function clauseMarksFrom\(text\)/);
  // Verified against phonemizer 1.2.1: the clause count equals the source mark
  // count exactly, for commas, terminals, semicolons, colons, em dashes and
  // commas inside quotes. Where it does not, inventing a boundary is worse than
  // a flat one, so the old comma join is the fallback.
  assert.match(worker, /const aligned = marks\.length === clauses\.length;/);
  assert.match(worker, /aligned \? marks\[index\] : \(index < clauses\.length - 1 \? ',' : ''\)/);
  assert.doesNotMatch(worker, /clauses\.join\(', '\)/,
    'every boundary must no longer collapse to a comma');

  // "..." is one pause, not three sentence ends, and there is a token for it.
  assert.match(worker, /'\u2026'/, 'an ellipsis run must map to the ellipsis token');
});

test('a Kokoro chunk boundary can only fall between clauses', async () => {
  const worker = await read('public/assets/js/kokoro_worker.js');

  // The graph's sequence axis is fixed at 512. This used to slice the token
  // stream every 510 ids, which lands wherever it lands -- mid-word, mid
  // diphthong -- and the halves were rendered as separate utterances and
  // concatenated, so a long paragraph fractured audibly inside a word.
  assert.doesNotMatch(worker, /function chunkTokenIds\(/,
    'the blind fixed-stride splitter must be gone');
  assert.match(worker, /function packUnitsIntoChunks\(units\)/);
  assert.match(worker, /const chunks = packUnitsIntoChunks\(units\);/);

  // The packer takes STRINGS now, not pre-tokenized ids, precisely so it can
  // fall back to word gaps when one clause exceeds the cap on its own.
  assert.match(worker, /function wordPiecesOf\(unitText\)/);
  assert.match(worker, /for \(const word of wordPiecesOf\(unit\)\)/);

  const pack = worker.slice(
    worker.indexOf('function packUnitsIntoChunks(units)'),
    worker.indexOf('async function runChunk('),
  );
  assert.ok(pack.length > 200, 'the packer must be locatable');

  // A clause that does not fit on its own flushes what came before it, then
  // breaks at word gaps -- never inside a word. That fallback used to be the
  // pathological path at a 510-token cap; at 192 (~48 words) a long sentence
  // routinely exceeds the cap, so it is now the common path and a blind slice
  // there would put a cut mid-word on ordinary prose.
  assert.match(pack, /if \(ids\.length <= limit\) \{ add\(ids\); continue; \}/);
  assert.match(pack, /flush\(\);\s*\n\s*for \(const word of wordPiecesOf\(unit\)\)/);

  // Slicing survives only for a single "word" longer than the entire cap.
  assert.match(pack, /if \(wordIds\.length > limit\)[\s\S]{0,220}?wordIds\.slice\(index, index \+ limit\)/);

  // Units are packed up to the limit rather than one per chunk.
  assert.match(pack, /if \(current\.length \+ ids\.length > limit\) flush\(\);/);
});

// Kokoro is non-autoregressive: it materialises the whole utterance in one pass
// and the vocoder's intermediates live at the 24 kHz output rate, so activation
// memory tracks how much audio ONE call produces. Filling the graph's 512-token
// axis is therefore the single most expensive thing the worker can do.
test('one inference is capped well below the graph sequence axis', async () => {
  const worker = await read('public/assets/js/kokoro_worker.js');

  // Two caps now, chosen by device class. constrainedMemoryMode was already in
  // every init message and the worker dropped it, so the phone this engine
  // exists for got the same cap as a desktop with room to spare.
  const constrained = Number(worker.match(/const CONSTRAINED_MAX_CHUNK_TOKENS = (\d+);/)?.[1]);
  const roomy = Number(worker.match(/const ROOMY_MAX_CHUNK_TOKENS = (\d+);/)?.[1]);
  assert.ok(Number.isFinite(constrained) && Number.isFinite(roomy),
    'the worker must declare a chunk cap for each device class');
  assert.ok(constrained <= roomy, 'the constrained cap must not exceed the roomy one');
  for (const cap of [constrained, roomy]) {
    assert.ok(cap <= 256, `the cap must stay near the measured knee; found ${cap}`);
    assert.ok(cap >= 96, `too small a cap only adds seams for no memory; found ${cap}`);
  }
  assert.match(worker, /data\.constrainedMemoryMode === false \? ROOMY_MAX_CHUNK_TOKENS : CONSTRAINED_MAX_CHUNK_TOKENS/,
    'the device class the main thread sends must pick the cap');

  // Measured over identical text: 510 -> 592 MB, 256 -> 440 MB, 192 -> 355 MB,
  // 128 -> 355 MB. Below 192 the peak stops falling, so a smaller cap buys
  // nothing and costs extra seams.
  assert.match(worker, /function chunkTokenLimit\(\)/);
  assert.match(worker, /Math\.max\(32, Math\.min\(MAX_TOKENS - 2, maxChunkTokens\)\)/,
    'the cap must stay clamped inside the graph axis');
  assert.match(worker, /maxChunkTokens = Number\(data\.maxChunkTokens\) > 0/,
    'the cap must be overridable so it can be re-measured without a code change');

  // The ORT arena guard was tried here and removed: measured twice at 592 vs
  // 594 MB (cap 510) and 356.6 vs 354.7 MB (cap 192), i.e. no effect, while the
  // arena-off run was the slower of the two at the small cap. Kokoro has no
  // autoregressive KV cache for an arena to ratchet, which is why the guard
  // Pocket needs does nothing here.
  // Scan CODE, not comments. The worker documents why the arena guard is absent
  // and has to name it to do so; matching raw source would flag the explanation
  // and push the next person to delete the reasoning instead of keeping it.
  const workerCode = worker.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(workerCode, /enableCpuMemArena|enableMemPattern/,
    'a measured no-op must not ship as if it were a fix');
});

// Reported: switching engine on the READER page looped a "preparing narration"
// modal with no story open, and the two selects never reflected each other.
// One cause: they ran different handlers, and the reader one was a DEFERRED
// action, so changing a preference there imported the whole narration runtime.
test('both engine selects share one handler and stay in sync', async () => {
  const html = await read('public/index.html');
  const settings = await read('public/assets/js/settings_manager.js');

  // Same handler on both, or they cannot agree.
  const readerSel = html.slice(html.indexOf('id="reader-engine-select"'), html.indexOf('id="voice-selector"'));
  assert.match(readerSel, /onchange="onNarrationEngineSelect\(this\.value\)"/);
  const settingsSel = html.slice(html.indexOf('id="voice-engine-select"'));
  assert.match(settingsSel.slice(0, 300), /onchange="onNarrationEngineSelect\(this\.value\)"/);
  // The reader select must NOT call the deferred action any more.
  assert.doesNotMatch(readerSel, /switchReaderVoiceEngine/);

  // One writer keeps both elements aligned.
  assert.match(settings, /function _syncEngineSelects\(controlValue\)/);
  assert.match(settings, /for \(const id of \['voice-engine-select', 'reader-engine-select'\]\)/);
  // Assigning .value must not re-enter the change handler, so the sync writer
  // must set .value directly and never dispatch an event or call the handler.
  const syncFn = settings.slice(settings.indexOf('function _syncEngineSelects'));
  const syncBody = syncFn.slice(0, syncFn.indexOf('window.onNarrationEngineSelect'));
  assert.match(syncBody, /el\.value = controlValue/);
  assert.doesNotMatch(syncBody, /el\.value !== controlValue/,
    'skipping an already-matching value leaves iOS showing the stale hidden-select label');
  assert.doesNotMatch(syncBody, /dispatchEvent|onNarrationEngineSelect\(/,
    're-entering the handler from the sync writer would loop the two selects');
});

test('opening the reader does not drag in the narration runtime', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  const settings = await read('public/assets/js/settings_manager.js');
  const loader = await read('public/assets/js/narration_runtime_loader.js');

  // refreshVoiceSelectorForEngine is deferred, so calling it on view entry
  // loaded audio_core + buffer_manager just to fill a dropdown.
  assert.match(loader, /'refreshVoiceSelectorForEngine',/);
  assert.match(ui, /viewId === 'reading-view' && typeof window\.syncNarrationControls === 'function'/);
  assert.doesNotMatch(ui, /viewId === 'reading-view' && typeof window\.refreshVoiceSelectorForEngine/);

  // Kokoro/Kitten lists live in the shell policy. Pocket's catalog is a shell
  // global (renderPocketVoiceOptions). Device voices come from speechSynthesis.
  // None of those may wait for audio_core, or the playbar stays empty until
  // the reader is left and re-entered after narration has started.
  assert.match(settings, /window\.syncNarrationControls = function/);
  assert.match(settings, /const voices = voicesForEngine\(engine\);/);
  assert.match(settings, /if \(voices\.length\) \{/);
  assert.match(settings, /window\.renderPocketVoiceOptions/);
  assert.match(settings, /function _fillWebSpeechVoiceSelector/);
  assert.match(settings, /speechSynthesis\.addEventListener\('voiceschanged'/);
  // Changing the engine on the playbar must rebuild the list immediately.
  const handler = settings.slice(
    settings.indexOf('window.onNarrationEngineSelect = function'),
    settings.indexOf('function _fillWebSpeechVoiceSelector'),
  );
  assert.match(handler, /window\.syncNarrationControls\(\)/);
  // populateReaderUI used to stamp pocketVoice onto #voice-selector, which
  // blanks a Kokoro/Kitten list. The playbar list is owned by the shell sync.
  assert.match(ui, /window\.syncNarrationControls\(\)/);
  assert.doesNotMatch(ui, /el\('voice-selector'\)\.value = voice/);
});

// Eighth instance of the same slip, and the one that mattered most: not an
// engine name this time but a VOICE ASSET, one layer below where every gate
// above stops looking.
//
// generateChunk resolved the engine correctly and _resolvePocketRoute passed a
// Kokoro id straight through -- and then _generatePocketAttempt called
// ensurePocketVoiceLoaded() on it unconditionally. That helper answers
// donald_malone_neutral for any id it does not recognise, so every Kokoro
// paragraph downloaded a ~5-6 MB Pocket .safetensors and posted
// register_precompiled_voice to a worker that handles four message types and
// not that one. No ack, 60s registration timeout, fatal quality failure, one
// retry, then null -- playback stopped with "The neural engine couldn't produce
// audio" and caching with "Neural engine failed". On every iOS device, which is
// the whole population selectNarrationEngine routes to Kokoro.
test('Pocket voice registration cannot run on a Kokoro session', async () => {
  const audio = await read('public/assets/js/audio_core.js');

  // The route records which engine it was built for, so the decision below
  // matches the route being run rather than re-deriving it.
  assert.match(audio, /return \{ engine, voiceId: _normalizeVoice\(engine, voice \|\| null\)/);
  assert.match(audio, /return \{ engine, voiceId, baseVoice, emotion, emotionInfo \};/);

  // And the Pocket-only preparation is gated on it.
  assert.match(
    audio,
    /if \(route\.engine === 'pocket'\) \{\s*\n\s*workerVoice = await ensurePocketVoiceLoaded\(route\.voiceId\);\s*\n\s*await _ensurePocketBackendOptimizedForVoice\(workerVoice\);\s*\n\s*\}/,
    'voice registration and backend calibration must not run for a non-Pocket engine',
  );
  // Exactly one call site, and the positive assertion above pins it inside the
  // gate -- so a second, ungated one cannot creep back alongside it.
  assert.equal(
    (audio.match(/ensurePocketVoiceLoaded\(route\.voiceId\)/g) || []).length, 1,
    'an ungated call is the bug: it resolves a Kokoro id to a Pocket voice pack',
  );

  // The worker really does handle only these four, which is why an ungated
  // register_precompiled_voice never gets an answer.
  const worker = await read('public/assets/js/kokoro_worker.js');
  assert.doesNotMatch(worker, /register_precompiled_voice/);
  for (const type of ['init', 'cancel_generation', 'generate', 'dispose_backend']) {
    assert.match(worker, new RegExp(`type === '${type}'`));
  }
});

// Same shape, on the prefetch path: a hardcoded engine rather than the resolved
// one. Pinned to 'pocket' the lookahead rewrote the Kokoro voice into a Pocket
// emotion asset, then read and wrote cache keys under engine 'pocket' with the
// Pocket prosody tag while playback reads 'kokoro' -- so every slot missed, and
// every miss committed the worker to a synthesis that could not succeed.
test('the playback lookahead resolves its engine instead of assuming one', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.doesNotMatch(audio, /const engine = 'pocket';/,
    'a literal engine cannot be right for both engines');
  assert.match(audio, /const selVoice = document\.getElementById\('voice-selector'\)\?\.value \|\| _defaultVoiceForEngine\(engine\);/,
    'the fallback voice must follow the engine too');
});

// Kokoro renders were keyed on position and voice alone: _prosodyCacheTag
// returned '' for every non-Pocket engine, so none of the markers that say HOW
// a chunk was rendered were in the key. Changing the per-inference chunk cap
// moves every seam in a paragraph, and textHash only catches re-segmentation of
// the paragraph itself.
test('Kokoro audio is cached under a render-shape version', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /const KOKORO_NARRATION_CACHE_VERSION = '[a-z0-9]+';/);
  // Every StyleTTS2 engine carries a render tag. Returning '' for one of them
  // meant its audio was keyed on position and voice alone - uninvalidatable,
  // and able to collide with the other engine's renders.
  assert.match(audio, /if \(_isStyleTts2Engine\(engine\)\) return `#\$\{NEURAL_CACHE_VERSIONS\[engine\]\}`;/);
  assert.match(audio, /const KITTEN_NARRATION_CACHE_VERSION = '[a-z0-9]+';/);
  assert.match(audio, /if \(_isStyleTts2Engine\(engine\)\) return \[_prosodyCacheTag\(engine\)\];/);
});

// The other door into the Pocket voice-pack path. _loadPocketEngine already
// skips the backend planner for Kokoro, but the cache loop reaches it through
// window.ensurePocketBackendOptimized -- which ends in ensurePocketVoiceLoaded()
// and would resolve a Kokoro id to donald_malone_neutral all the same.
test('Pocket backend calibration is gated on the Pocket engine at both ends', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const buffer = await read('public/assets/js/buffer_manager.js');

  assert.match(buffer, /if \(_resolveActiveEngine\(\) === 'pocket'\) \{\s*\n\s*await window\.ensurePocketBackendOptimized\?\.\(voice\);/);
  assert.match(audio, /async function _ensurePocketBackendOptimizedForVoice\(voiceName\) \{[\s\S]{0,500}?if \(_resolveActiveEngine\(\) !== 'pocket'\) return _pocketBackendRuntime;/);
});

// Second audit, 2026-08-28. Both of these only became reachable when Kokoro
// could first synthesize past its opening paragraph, so neither had ever run in
// anger before the previous commit.
test('Kokoro applies the same pronunciation rules Pocket does', async () => {
  const worker = await read('public/assets/js/kokoro_worker.js');
  const core = await read('public/assets/js/tts_pronunciation_core.js');

  // normalizeForPocketTts had exactly one caller in the codebase, inside
  // pocket_worker.js, so on Kokoro the reader's Settings overrides, their
  // per-story overrides and the whole built-in ruleset were discarded in
  // silence -- and an inline [2s] tag was read out character by character.
  assert.match(worker, /import \{ normalizeForPocketTts \} from '\.\/tts_pronunciation_core\.js\?v=[a-z0-9-]+';/);
  assert.match(worker, /const spoken = normalizeForPocketTts\(String\(text \|\| ''\), \{/);
  assert.match(worker, /pronunciationOverrides: opts\.pronunciationOverrides \|\| \[\],/);
  // The normalised string is what gets phonemized AND what marks are counted on.
  assert.doesNotMatch(worker, /phonemize\(String\(text \|\| ''\), 'en-us'\)/,
    'the raw text must not reach the phonemizer once normalisation exists');

  // Kokoro tokenizes the em-dash and splits clauses on it, so Pocket's cadence
  // hack that flattens em-dashes to commas must not apply to it.
  assert.match(worker, /keepClausePunctuation: true,/);
  assert.match(core, /const keepClausePunctuation = !Array\.isArray\(settings\) && settings\.keepClausePunctuation === true;/);
  assert.match(core, /if \(!keepClausePunctuation\) \{[\s\S]{0,200}?out = out\.replace\(\/—\/g, ', '\);/);
  // The pause-tag strip is NOT optional -- left in, the characters reach the
  // phonemizer and get spoken by whichever engine is running. A two-space indent
  // means it sits at the top level of the function; four would mean somebody had
  // moved it inside the guard.
  const coreLines = core.split('\n');
  const tagComment = coreLines.findIndex((l) => l.includes('Strip pseudo-SSML inline pause tags'));
  assert.ok(tagComment > 0, 'the [Ns] pause-tag strip must exist');
  const stripLine = coreLines.slice(tagComment).find((l) => l.trimStart().startsWith('out = '));
  assert.match(stripLine, /^ {2}out = /,
    'the [Ns] strip must sit outside the keepClausePunctuation guard');

  // The render changed, so cached Kokoro audio has to be invalidated. Assert the
  // version is at or past the bump this change required, not that it equals it:
  // pinning the literal makes every LATER legitimate bump fail here, which
  // pressures the next person to edit the test rather than the cache key.
  const audio = await read('public/assets/js/audio_core.js');
  const cacheVer = Number(audio.match(/const KOKORO_NARRATION_CACHE_VERSION = 'kokorov(\d+)';/)?.[1]);
  assert.ok(Number.isFinite(cacheVer) && cacheVer >= 2,
    `normalizeForPocketTts changed the render, so the Kokoro cache key must be at least v2; found v${cacheVer}`);
});

test('the Pocket worker recycle does not run on Kokoro', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const fn = audio.slice(audio.indexOf('async function _maybeRecyclePocketEngine()'),
                         audio.indexOf('window.generateChunk = async function'));
  assert.ok(fn.length > 0, '_maybeRecyclePocketEngine not found');

  // The drift it clears is autoregressive. Kokoro is one forward pass with no KV
  // cache -- the same reason the ORT arena guard was measured as a no-op there --
  // so a recycle rebuilt an 86 MB session every 20 paragraphs for nothing.
  assert.match(fn, /if \(_resolveActiveEngine\(\) !== 'pocket'\) return false;/);
  // And it must bail BEFORE the paragraph counter, or Kokoro still advances a
  // threshold it can never legitimately reach.
  const gate = fn.indexOf("_resolveActiveEngine() !== 'pocket'");
  const counter = fn.indexOf('window._pocketParagraphCount = (window._pocketParagraphCount || 0) + 1');
  assert.ok(gate > 0 && counter > gate, 'the engine gate must precede the paragraph counter');
});

test('Pocket-only settings are hidden when Pocket is not the running engine', async () => {
  const settings = await read('public/assets/js/settings_manager.js');
  const html = await read('public/index.html');

  // Both cards were shown unconditionally. On Kokoro the emotion controls have
  // no per-emotion voices to choose between, and the backend card is inert --
  // and "Re-run backend optimization" could force a whole ?tts_fast=1 page
  // reload on an un-isolated device to reach a call that returns immediately.
  assert.match(html, /id="expressive-narration-card"/);
  assert.match(html, /id="narration-backend-card"/);
  assert.match(settings, /export function syncPocketOnlySettings\(\)/);
  assert.match(settings, /const pocketActive = !usingWebSpeech && engine === 'pocket';/);
  assert.match(settings, /for \(const id of \['expressive-narration-card', 'narration-backend-card'\]\)/);
  // hidden alone loses to a class-set display in this stylesheet.
  assert.match(settings, /card\.style\.display = pocketActive \? '' : 'none';/);
  assert.match(settings, /^\s*syncPocketOnlySettings\(\);$/m, 'it has to actually be called');
});
