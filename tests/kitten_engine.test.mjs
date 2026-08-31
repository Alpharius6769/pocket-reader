// KittenTTS as the third narration tier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const policy = await import('../public/assets/js/pocket_backend_policy.js');

const ios = (w, h) => policy.selectNarrationEngine({
  capability: { platform: 'ios' }, screenWidth: w, screenHeight: h, storage: null });
const android = (mem, cores) => policy.selectNarrationEngine({
  capability: { platform: 'android' }, deviceMemory: mem, hardwareConcurrency: cores, storage: null });

test('the iOS ladder places each generation on its intended tier', () => {
  // Geometry is the ONLY signal that tracks iPhone generation -- Safari reports
  // neither RAM nor model.
  assert.equal(ios(440, 956).engine, 'pocket', 'iPhone 16 Pro Max');
  assert.equal(ios(402, 874).engine, 'pocket', 'iPhone 16 Pro');
  assert.equal(ios(393, 852).engine, 'kokoro', 'iPhone 14 Pro / 15 / 16');
  assert.equal(ios(430, 932).engine, 'kokoro', 'iPhone 15 Plus');
  assert.equal(ios(390, 844).engine, 'kitten', 'iPhone 13 / 14');
  assert.equal(ios(375, 812).engine, 'kitten', 'iPhone 13 mini');
  assert.equal(ios(375, 667).engine, 'kitten', 'iPhone SE');
});

test('exact geometries, not ranges -- a 15 Plus must not read as a 16 Pro', () => {
  // A ">= 402 wide and >= 874 tall" rule reads naturally and is wrong: it also
  // swallows the iPhone 15 Plus at 430x932 and promotes it two tiers.
  assert.equal(ios(430, 932).engine, 'kokoro');
  assert.notEqual(ios(430, 932).engine, 'pocket');
});

test('the undecidable iPhone 13/14 case resolves DOWNWARD and says so', () => {
  const r = ios(390, 844);
  assert.equal(r.engine, 'kitten',
    'a wrong guess upward crashes the tab on the device that actually OOMs');
  assert.equal(r.confident, false, 'it must not claim confidence it does not have');
  assert.match(r.reason, /identical|indistinguishable/i);
  assert.equal(ios(375, 812).confident, true, 'a device it CAN identify should be confident');
});

test('the Android ladder floors at Kokoro, never Kitten', () => {
  assert.equal(android(8, 8).engine, 'pocket', '6GB+ and a good CPU');
  assert.equal(android(6, 8).engine, 'pocket');
  assert.equal(android(6, 4).engine, 'kokoro', 'enough RAM, too few cores');
  assert.equal(android(4, 4).engine, 'kokoro', 'weaker Android still gets Kokoro');
  for (const m of [1, 2, 3, 4, 6, 8, 12]) {
    assert.notEqual(android(m, 4).engine, 'kitten', `Android must not fall to Kitten (${m}GB)`);
  }
});

test('an explicit override wins, and only a known engine counts as one', () => {
  for (const e of ['kitten', 'kokoro', 'pocket']) {
    const r = policy.selectNarrationEngine({ override: e, capability: { platform: 'ios' }, storage: null });
    assert.equal(r.engine, e);
    assert.equal(r.automatic, false);
  }
  // Junk must fall through to automatic rather than become the engine name.
  const junk = policy.selectNarrationEngine({
    override: 'espeak', capability: { platform: 'ios' }, screenWidth: 390, screenHeight: 844, storage: null });
  assert.equal(junk.automatic, true);
  assert.equal(junk.engine, 'kitten');
});

test('low-memory mode only ever steps DOWN a tier', () => {
  const r = policy.selectNarrationEngine({
    capability: { platform: 'ios' }, screenWidth: 440, screenHeight: 956,
    lowMemoryMode: true, storage: null });
  assert.equal(r.engine, 'kitten', 'a 16 Pro Max in low-memory mode drops to the lightest');
  const floor = policy.selectNarrationEngine({
    capability: { platform: 'android' }, deviceMemory: 8, hardwareConcurrency: 8,
    lowMemoryMode: true, storage: null });
  assert.equal(floor.engine, 'kokoro', 'Android floor stays Kokoro even in low-memory mode');
});

test('voices cannot leak across engines', () => {
  // The concrete failure this prevents: an unknown id reaching the worker, which
  // previously resolved to a Pocket voice pack and hung for 60 s.
  assert.equal(policy.isKittenVoice('af_heart'), false);
  assert.equal(policy.isKokoroVoice('expr-voice-3-f'), false);
  assert.equal(policy.isVoiceValidForEngine('kitten', 'af_heart'), false);
  assert.equal(policy.isVoiceValidForEngine('kokoro', 'expr-voice-3-f'), false);
  assert.equal(policy.isVoiceValidForEngine('kitten', 'expr-voice-3-f'), true);
  assert.equal(policy.isVoiceValidForEngine('kokoro', 'af_heart'), true);

  // Coercion returns the engine's own default rather than passing junk through.
  assert.equal(policy.coerceVoiceForEngine('kitten', 'af_heart'), policy.KITTEN_DEFAULT_VOICE);
  assert.equal(policy.coerceVoiceForEngine('kokoro', 'expr-voice-3-f'), policy.KOKORO_DEFAULT_VOICE);
  assert.equal(policy.coerceVoiceForEngine('kitten', 'expr-voice-5-m'), 'expr-voice-5-m');

  // Pocket manages its own packs and must be left alone.
  assert.equal(policy.voicesForEngine('pocket').length, 0);
  assert.equal(policy.isVoiceValidForEngine('pocket', 'donald_malone'), true);

  // No id may appear in two engines' lists.
  const kitten = new Set(policy.KITTEN_VOICES.map((v) => v.id));
  for (const v of policy.KOKORO_VOICES) assert.equal(kitten.has(v.id), false, v.id);
});

test('both engine selects offer the same engines and share one handler', async () => {
  const html = await read('public/index.html');
  const settings = await read('public/assets/js/settings_manager.js');
  for (const id of ['voice-engine-select', 'reader-engine-select']) {
    const at = html.indexOf(`id="${id}"`);
    const block = html.slice(at, html.indexOf('</select>', at));
    for (const engine of ['auto', 'pocket', 'kokoro', 'kitten', 'webspeech']) {
      assert.ok(block.includes(`value="${engine}"`), `${id} is missing ${engine}`);
    }
    assert.ok(block.includes('onNarrationEngineSelect(this.value)'),
      `${id} must use the shared handler, or the two selects drift apart`);
  }
  // One preference, two views: the handler must write both back.
  assert.match(settings, /function _syncEngineSelects\(controlValue\)/);
  assert.match(settings, /\['voice-engine-select', 'reader-engine-select'\]/);
});

test('the Kitten worker loads Kitten assets and rejects a Kokoro voice table', async () => {
  const w = await read('public/assets/js/kitten_worker.js');
  const code = w.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /models\/kitten\/v0\.1/);
  assert.match(code, /const MODEL_FILE = 'model_quantized\.onnx';/);

  // Kitten voices are ONE 256-float vector; Kokoro's are a (510,1,256) table.
  // The wrong asset must fail loudly, not emit noise.
  assert.match(code, /data\.length !== STYLE_DIM/);
  assert.doesNotMatch(code, /VOICE_ROWS/);
  assert.match(w, /Kokoro voice table; Kitten voices are a single vector/);

  // It must identify itself as kitten, or diagnostics attribute its runs to Kokoro.
  assert.match(code, /engine: 'kitten'/);
  assert.doesNotMatch(code, /engine: 'kokoro'/);
});

test('every engine routes to its own worker, and Kitten counts as neural', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const sw = await read('public/sw.js');
  assert.match(audio, /kitten: 'assets\/js\/kitten_worker\.js\?v=kitten-v9'/);
  assert.match(audio, /kokoro: 'assets\/js\/kokoro_worker\.js/);
  assert.match(audio, /pocket: 'assets\/js\/pocket_worker\.js/);
  // Omitting Kitten here would make every narration gate treat it as device speech.
  const at = audio.indexOf('function _isNeuralEngine');
  assert.match(audio.slice(at, at + 400), /KITTEN_ENGINE/);
  // The SW must precache it, and its name has to end _worker.js to be stamped.
  assert.match(sw, /assets\/js\/kitten_worker\.js\?v=kitten-v9/);
});

test('overriding UPWARD warns; overriding downward does not nag', async () => {
  const settings = await read('public/assets/js/settings_manager.js');
  assert.match(settings, /rank\(override\) > rank\(auto\.engine\)/,
    'the warning must be gated on moving UP the ladder');
  assert.match(settings, /Heads up:/);
  assert.match(settings, /may stall or the tab may reload/);
});

test('Settings does not treat stored neural "pocket" as a Pocket TTS selection', async () => {
  // iPhone 13 field report: detection ran Kitten, but Narration & Playback
  // showed Pocket TTS, and picking Kitten there did not update the reader.
  // Cause: settings.voiceEngine is 'pocket' for EVERY neural engine, and
  // initSettingsUI both wrote that into the dropdown and called
  // switchReaderVoiceEngine('pocket'), which persisted a Pocket override.
  const settings = await read('public/assets/js/settings_manager.js');
  const audio = await read('public/assets/js/audio_core.js');
  const init = settings.slice(
    settings.indexOf('export function initSettingsUI()'),
    settings.indexOf('window.initSettingsUI = initSettingsUI;'),
  );
  assert.doesNotMatch(init, /switchReaderVoiceEngine\(settings\.voiceEngine/,
    'opening Settings must not persist the collapsed neural flag as Pocket TTS');
  assert.doesNotMatch(init, /el\('voice-engine-select'\)\.value = settings\.voiceEngine/,
    'the dropdown is auto/kitten/kokoro/pocket, not the stored neural flag');
  assert.match(init, /_syncEngineSelects\(_voiceEngineControlValue\(settings\)\)/);
  assert.match(settings, /function _voiceEngineControlValue\(/);
  assert.match(settings, /readNarrationEngineOverride\(localStorage\) \|\| 'auto'/);

  // Switching Kitten in Settings must land on the reader playbar too.
  const handler = settings.slice(
    settings.indexOf('window.onNarrationEngineSelect = function'),
    settings.indexOf('function _fillWebSpeechVoiceSelector'),
  );
  assert.match(handler, /_syncEngineSelects\(choice\)/);
  assert.match(handler, /window\.syncNarrationControls\(\)/);
  assert.match(handler, /writeNarrationEngineOverride\(localStorage, choice === 'auto' \? null : choice\)/);

  // A deferred retry used to pass the collapsed 'pocket' value, wiping Kitten.
  assert.match(audio, /setTimeout\(\(\) => switchReaderVoiceEngine\(controlValue, silent\)/);
  assert.doesNotMatch(audio, /setTimeout\(\(\) => switchReaderVoiceEngine\(engineVal, silent\)/);

  // The diagnostics line collapsed Kitten into "Pocket TTS".
  assert.match(settings, /kitten: 'KittenTTS Nano'/);
  assert.doesNotMatch(settings, /engine === 'kokoro' \? 'Kokoro-82M' : 'Pocket TTS'/);
});
