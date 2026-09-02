// Guards for the expressive-prosody work.
//
// The constraint that shapes all of this: expressiveness raises sampling
// temperature, and temperature is what destabilizes a long listen. So the tests
// below check two things in tandem — that expressiveness is actually reachable,
// and that the drift guard can always take it back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createProsodyDriftGuard,
  requestedProsodyTier,
  classifyPocketDeviceCapability,
  resolvePocketExpressiveProsody,
  POCKET_PROSODY_TIERS,
} from '../public/assets/js/pocket_backend_policy.js';
import {
  getPocketTuningPreset,
  POCKET_TTS_TUNING_PRESETS,
  DEFAULT_POCKET_VOICE_SEED,
} from '../public/assets/js/tts_pronunciation_core.js';

const read = (p) => readFile(p, 'utf8');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

test('expressive prosody is on by default on mobile', () => {
  // Previously gated on `constrained`, which is true for most iPhones, so the
  // majority of mobile users heard every paragraph in flat neutral.
  const iphone = classifyPocketDeviceCapability({ userAgent: IPHONE_UA, deviceMemory: 0 });
  assert.equal(iphone.defaultExpressiveProsody, true);
  assert.equal(resolvePocketExpressiveProsody({ capability: iphone, choice: null }), true);
  // Memory protection must NOT have been loosened along with it.
  assert.equal(iphone.constrained, true);
  assert.equal(iphone.memorySafeInference, true);
  assert.equal(iphone.fullStoryVoicePrefetch, false);
});

test('data-saver and low-memory mode still opt out of expressiveness', () => {
  for (const opt of [{ saveData: true }, { lowMemoryMode: true }]) {
    const cap = classifyPocketDeviceCapability({ userAgent: IPHONE_UA, deviceMemory: 0, ...opt });
    assert.equal(cap.defaultExpressiveProsody, false,
      `expected opt-out for ${JSON.stringify(opt)}`);
  }
});

test('an explicit user choice always beats the device default', () => {
  const cap = classifyPocketDeviceCapability({ userAgent: IPHONE_UA, deviceMemory: 0, saveData: true });
  assert.equal(resolvePocketExpressiveProsody({ capability: cap, choice: 'enabled' }), true);
  assert.equal(resolvePocketExpressiveProsody({ capability: cap, choice: 'disabled' }), false);
});

test('emotion mode maps to the right temperature tier', () => {
  assert.equal(requestedProsodyTier('neutral'), 'neutral');
  assert.equal(requestedProsodyTier('balanced'), 'balanced');
  assert.equal(requestedProsodyTier('expressive'), 'full');
  // Unknown values fall back to balanced rather than escalating.
  assert.equal(requestedProsodyTier('nonsense'), 'balanced');
  assert.deepEqual(POCKET_PROSODY_TIERS, ['neutral', 'balanced', 'full']);
});

test('the drift guard steps down on repeated quality failures', () => {
  const guard = createProsodyDriftGuard();
  assert.equal(guard.effectiveTier('expressive'), 'full');

  for (let i = 0; i < 2; i++) assert.equal(guard.record(false, 'expressive'), null,
    'two failures alone must not demote');
  const change = guard.record(false, 'expressive');
  assert.equal(change.direction, 'down');
  assert.equal(guard.effectiveTier('expressive'), 'balanced');

  for (let i = 0; i < 3; i++) guard.record(false, 'expressive');
  assert.equal(guard.effectiveTier('expressive'), 'neutral');
});

test('the drift guard floors at neutral and never goes below', () => {
  const guard = createProsodyDriftGuard();
  for (let i = 0; i < 60; i++) guard.record(false, 'expressive');
  assert.equal(guard.effectiveTier('expressive'), 'neutral');
  assert.equal(guard.demotions, 2, 'demotions must not exceed the tier count');
});

test('the drift guard recovers one tier per sustained clean streak', () => {
  const guard = createProsodyDriftGuard();
  for (let i = 0; i < 6; i++) guard.record(false, 'expressive');
  assert.equal(guard.effectiveTier('expressive'), 'neutral');

  for (let i = 0; i < 19; i++) {
    assert.equal(guard.record(true, 'expressive'), null, 'must not recover early');
  }
  const up = guard.record(true, 'expressive');
  assert.equal(up.direction, 'up');
  assert.equal(guard.effectiveTier('expressive'), 'balanced');

  for (let i = 0; i < 20; i++) guard.record(true, 'expressive');
  assert.equal(guard.effectiveTier('expressive'), 'full');
});

test('a single failure does not undo a healthy streak', () => {
  // Isolated artifacts happen; only a cluster inside the window is drift.
  const guard = createProsodyDriftGuard();
  for (let i = 0; i < 30; i++) guard.record(true, 'expressive');
  guard.record(false, 'expressive');
  assert.equal(guard.effectiveTier('expressive'), 'full');
});

test('a neutral-mode listener is never escalated by the guard', () => {
  const guard = createProsodyDriftGuard();
  for (let i = 0; i < 50; i++) guard.record(true, 'neutral');
  assert.equal(guard.effectiveTier('neutral'), 'neutral');
});

test('reset clears drift so one rough chapter does not flatten the book', () => {
  const guard = createProsodyDriftGuard();
  for (let i = 0; i < 6; i++) guard.record(false, 'expressive');
  assert.equal(guard.effectiveTier('expressive'), 'neutral');
  guard.reset();
  assert.equal(guard.effectiveTier('expressive'), 'full');
  assert.equal(guard.demotions, 0);
});

test('the full temperature cap table is actually reachable', async () => {
  // It was dead code: _artifactCappedTemperature computed the mode and then
  // unconditionally used the balanced table, so the wider caps never applied.
  const source = await read('public/assets/js/audio_core.js');
  assert.match(source, /_effectiveProsodyTier\(\) === 'full'\s*\r?\n?\s*\?\s*POCKET_FULL_TEMP_CAPS/);
  assert.doesNotMatch(source, /const caps = POCKET_BALANCED_TEMP_CAPS;/);
});

test('the expressive emotion mode is reachable everywhere it is validated', async () => {
  // Five separate clamp sites used to collapse anything outside
  // neutral|balanced, so no user could ever select the expressive tier.
  for (const file of [
    'public/assets/js/audio_core.js',
    'public/assets/js/library_manager.js',
    'public/assets/js/settings_manager.js',
  ]) {
    const source = await read(file);
    const clamps = [...source.matchAll(/\[\s*'neutral',\s*'balanced'[^\]]*\]/g)].map((m) => m[0]);
    for (const clamp of clamps) {
      assert.match(clamp, /'expressive'/,
        `${file} still clamps the emotion mode without an expressive tier: ${clamp}`);
    }
  }
});

test('the synthesis path feeds quality outcomes into the guard', async () => {
  const source = await read('public/assets/js/audio_core.js');
  // Every terminal branch of the quality guard must report, or the guard goes
  // blind exactly when a session is degrading.
  const recordCalls = [...source.matchAll(/_recordProsodyOutcome\((true|false)\)/g)].map((m) => m[1]);
  assert.ok(recordCalls.includes('true'), 'clean paragraphs must be recorded');
  assert.ok(recordCalls.filter((v) => v === 'false').length >= 3,
    'retry, fatal, and soft-warning branches must all record a failure');
  // The guard must be able to force neutral even with expressiveness enabled.
  assert.match(source, /_effectiveProsodyTier\(\) !== 'neutral'/);
});

test('the emotion detector can fire on a single unambiguous keyword', async () => {
  // The threshold was 2.05 while the happy/surprised/frustrated/calm lexicons
  // carry weight 2.0 — so one clear keyword scored 2.00 and lost by 0.05, and
  // those four emotions were unreachable on a single signal no matter how
  // obvious. "She laughed, bright and sudden" measured confidence 0.98 and
  // narrated flat neutral.
  const source = await read('public/assets/js/audio_core.js');
  const threshold = Number(source.match(/words\.length < 12 \? 3\.0 : ([\d.]+)/)?.[1]);
  assert.ok(Number.isFinite(threshold), 'long-paragraph emotion threshold must be present');
  assert.ok(threshold <= 2.0,
    `threshold ${threshold} is above the lightest lexicon weight (2.0), so one keyword can never register`);
});

test('emotion lexicons cover how prose actually carries feeling', async () => {
  // Verified in-browser against a prose corpus: before this vocabulary, 6/6
  // emotional passages scored zero and rendered neutral — including
  // '"Get away from me!" she shouted' and 'put his head in his hands'. After,
  // 6/6 detect correctly with 0 false positives on 3 plain-prose controls.
  const source = await read('public/assets/js/audio_core.js');
  const lexicons = source.slice(source.indexOf("add('anger'"), source.indexOf('if (emphatic)'));
  // Dialogue tags and physical reactions, not just the names of the emotions.
  for (const term of ['shouted', 'snapped', 'sobbed', 'trembl', 'grinned', 'slept', 'whispered', 'head in']) {
    assert.ok(lexicons.includes(term),
      `lexicons lost "${term}" — fiction signals emotion through action, not emotion words`);
  }
  // Every emotion the temperature cap tables know about must be detectable.
  for (const emotion of ['anger', 'happy', 'sad', 'worried', 'surprised', 'tired', 'frustrated', 'calm']) {
    assert.ok(lexicons.includes(`add('${emotion}'`), `no lexicon for ${emotion}`);
  }
});

test('the emotion detector is inspectable from outside the module', async () => {
  // Four separate expressiveness ceilings went unnoticed at once partly because
  // nothing outside audio_core could answer "does this actually vary".
  const source = await read('public/assets/js/audio_core.js');
  assert.match(source, /window\.inspectPocketEmotion\s*=/);
});

test('the retired voices are gone from every surface, not just the picker', async () => {
  // Voice-Zero and the personal clone were removed at the product's request.
  // A leftover mention in a shipped list is not cosmetic: an id that reaches
  // the worker without a voice pack behind it hangs synthesis for 60 seconds.
  const engineUtils = await read('public/assets/js/engine_utils.js');
  const shell = await read('public/index.html');
  const retired = ['donald_malone', 'bill_boerst', 'jason_mayoff',
                   'kristin_hughes', 'jodi_krangle_expressive', 'karen_savage', 'rayne'];
  const pack = engineUtils.slice(
    engineUtils.indexOf('window.POCKET_VOICE_PACK = {'),
    engineUtils.indexOf('window.POCKET_RETIRED_VOICES'),
  );
  for (const id of retired) {
    assert.doesNotMatch(pack, new RegExp(`id: '${id}'`), `${id} must not be a shipped voice`);
    assert.doesNotMatch(shell, new RegExp(`<option value="${id}"`), `${id} must not be selectable`);
  }
});

test('Pocket ships three female and three male Kyutai voices, each neutral-only', async () => {
  const source = await read('public/assets/js/engine_utils.js');
  const expected = {
    alba: ['female', 'English'],
    mary: ['female', 'American, Indiana'],
    eve: ['female', 'American, New Jersey'],
    charles: ['male', 'English'],
    george: ['male', 'American, New England'],
    noah: ['male', 'American, Florida'],
  };
  const pack = source.slice(
    source.indexOf('window.POCKET_VOICE_PACK = {'),
    source.indexOf('window.POCKET_RETIRED_VOICES'),
  );
  const ids = [...pack.matchAll(/id: '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids.sort(), Object.keys(expected).sort(), 'exactly the curated six');

  for (const [id, [gender, accent]] of Object.entries(expected)) {
    const block = pack.match(new RegExp(`id: '${id}',[\\s\\S]*?\\n    \\}`))?.[0] || '';
    assert.match(block, /availableEmotions: \['neutral'\]/,
      `${id} must not claim emotion states Kyutai did not ship`);
    assert.match(block, new RegExp(`gender: '${gender}'`));
    assert.match(block, new RegExp(`accent: '${accent}'`));
  }
  const genders = [...pack.matchAll(/gender: '(male|female)'/g)].map((m) => m[1]);
  assert.equal(genders.filter((g) => g === 'female').length, 3);
  assert.equal(genders.filter((g) => g === 'male').length, 3);
});

test('every retired voice migrates to a LIVE voice of the same gender', async () => {
  // The alias map used to point the old nicknames at the Voice-Zero six.
  // Leaving it that way through their removal would have been worse than
  // deleting it: canonicalPocketVoice returns an alias hit directly, so the
  // lookup would have produced a retired id and stalled the worker.
  const source = await read('public/assets/js/engine_utils.js');
  const aliases = source.slice(
    source.indexOf('window.POCKET_VOICE_ALIASES = {'),
    source.indexOf('window.POCKET_VOICE_ASSET_IDS = []'),
  );
  const female = ['alba', 'mary', 'eve'];
  const male = ['charles', 'george', 'noah'];
  const live = [...female, ...male];
  const pairs = [...aliases.matchAll(/([a-z_'-]+):\s*'([a-z_]+)'/g)]
    .map((m) => [m[1].replace(/'/g, ''), m[2]]);
  assert.ok(pairs.length >= 15, 'every retired id needs an alias, not just the nicknames');
  for (const [from, to] of pairs) {
    assert.ok(live.includes(to), `alias ${from} -> ${to} must name a live voice`);
  }
  const by = Object.fromEntries(pairs);
  for (const id of ['kristin_hughes', 'jodi_krangle_expressive', 'karen_savage', 'jane', 'rayne']) {
    assert.ok(female.includes(by[id]), `${id} was female and must stay female (got ${by[id]})`);
  }
  for (const id of ['donald_malone', 'bill_boerst', 'jason_mayoff', 'michael']) {
    assert.ok(male.includes(by[id]), `${id} was male and must stay male (got ${by[id]})`);
  }
  // And the resolver refuses an alias that does not name a live voice, however
  // the map is edited later.
  assert.match(source, /if \(alias && window\.POCKET_VOICES\.includes\(alias\)\) return alias;/);
});

test('high-end Pocket TTS uses four LSD steps instead of the 1-step grain path', async () => {
  const source = await read('public/assets/js/audio_core.js');
  const config = source.slice(
    source.indexOf('function _pocketTuningConfig'),
    source.indexOf('function _pocketVoiceSeed'),
  );
  assert.match(config, /isPocketDeviceConstrained\?\.\(\) === true/);
  assert.match(config, /lsdSteps = 4/);
  assert.doesNotMatch(config, /isPocketDeviceMemorySafeMode/);
});

test('Alba is the configured default voice across the engine', async () => {
  // Every module-load fallback has to name a voice that still exists. These
  // literals are what run before engine_utils has set window.POCKET_DEFAULT_VOICE,
  // so one left on a retired id is a real 60-second worker stall, not a typo.
  const engineUtils = await read('public/assets/js/engine_utils.js');
  assert.match(engineUtils, /window\.POCKET_DEFAULT_VOICE = 'alba'/);

  for (const rel of ['public/assets/js/audio_core.js', 'public/assets/js/buffer_manager.js']) {
    assert.match(await read(rel), /const POCKET_DEFAULT_VOICE = window\.POCKET_DEFAULT_VOICE \|\| 'alba'/, rel);
  }

  const library = await read('public/assets/js/library_manager.js');
  assert.match(library, /const defaultVoice = window\.POCKET_DEFAULT_VOICE \|\| 'alba'/);
  assert.match(library, /pocketVoice: window\.POCKET_DEFAULT_VOICE \|\| "alba"/);

  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(ui, /narratorPref === 'Male' \? 'charles' : 'alba'/,
    'the narrator gender preference must pick from the live catalog');
});

test('getPocketTuningPreset allows expressive temperature tuning without forced fallback', async () => {
  const ttsCore = await read('public/assets/js/tts_pronunciation_core.js');
  assert.doesNotMatch(ttsCore, /if \(key === 'expressive'\) key = DEFAULT_POCKET_TEMPERATURE_PRESET;/);
});

test('temperature presets sit well above the old 0.70 ceiling', () => {
  assert.equal(POCKET_TTS_TUNING_PRESETS.stable.temperature, 0.70);
  assert.equal(POCKET_TTS_TUNING_PRESETS.balanced.temperature, 0.86);
  assert.equal(POCKET_TTS_TUNING_PRESETS.expressive.temperature, 0.93);
  assert.equal(POCKET_TTS_TUNING_PRESETS.balanced.lsdSteps, 4);
  assert.ok(POCKET_TTS_TUNING_PRESETS.expressive.temperature < 0.96,
    'must stay inside the worker clamp of 0.95');
});

test('getPocketTuningPreset escalates with the emotion profile and never de-escalates', () => {
  // Settings → Expressive used to leave pocketTemperaturePreset at balanced,
  // so this function returned 0.70 and the voices stayed flat.
  const expressive = getPocketTuningPreset('balanced', 'expressive');
  assert.equal(expressive.name, 'expressive');
  assert.equal(expressive.temperature, 0.93);

  const fullAlias = getPocketTuningPreset('balanced', 'full');
  assert.equal(fullAlias.name, 'expressive');

  const balanced = getPocketTuningPreset('balanced', 'balanced');
  assert.equal(balanced.name, 'balanced');
  assert.equal(balanced.temperature, 0.86);

  const keepHot = getPocketTuningPreset('expressive', 'neutral');
  assert.equal(keepHot.name, 'expressive');
  assert.equal(keepHot.temperature, 0.93);

  const keepStable = getPocketTuningPreset('stable', 'neutral');
  assert.equal(keepStable.name, 'stable');
  assert.equal(keepStable.temperature, 0.70);

  const quality = getPocketTuningPreset('quality', 'expressive');
  assert.equal(quality.name, 'quality');
  assert.equal(quality.lsdSteps, 4);
});

test('per-emotion temperature tables are the sampling temps, not a ceiling on 0.70', async () => {
  const source = await read('public/assets/js/audio_core.js');
  // The old min(preset, cap) flattened every paragraph whenever the default
  // balanced preset sat below every cap.
  assert.doesNotMatch(source, /Math\.min\(Number\(baseTemperature\) \|\| cap, cap\)/);
  assert.match(source, /const intended = Number\(caps\[emotion\] \|\| caps\.neutral\)/);
  assert.match(source, /const chosen = Number\.isFinite\(intended\)/);

  const balanced = source.match(/const POCKET_BALANCED_TEMP_CAPS = \{[\s\S]*?\};/)?.[0] || '';
  const full = source.match(/const POCKET_FULL_TEMP_CAPS = \{[\s\S]*?\};/)?.[0] || '';
  const num = (block, key) => Number(block.match(new RegExp(`${key}:\\s*([0-9.]+)`))?.[1]);

  assert.ok(num(balanced, 'happy') >= 0.90, `balanced happy ${num(balanced, 'happy')} is still near the old 0.74`);
  assert.ok(num(balanced, 'surprised') >= 0.92, `balanced surprised ${num(balanced, 'surprised')} is still near the old 0.76`);
  assert.ok(num(full, 'happy') >= 0.90, `full happy ${num(full, 'happy')} is still near the old 0.84`);
  assert.ok(num(full, 'anger') >= 0.94, `full anger ${num(full, 'anger')} is still near the old 0.88`);
  assert.ok(num(full, 'shout') <= 0.95, 'must stay inside the worker clamp');
  assert.ok(num(full, 'happy') > num(balanced, 'happy'), 'expressive profile must run hotter than balanced');
});

test('hotter sampling busts the Pocket audio cache', async () => {
  const source = await read('public/assets/js/audio_core.js');
  assert.match(source, /const POCKET_NARRATION_CACHE_VERSION = 'narrv20'/);
});

test('cache and live share one Pocket take: seed, token cap, pause, decode batch', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const worker = await read('public/assets/js/pocket_worker.js');

  assert.equal(DEFAULT_POCKET_VOICE_SEED, 'pr-voice-1');
  assert.match(audio, /function _pocketVoiceSeed\(/);
  assert.match(audio, /return DEFAULT_POCKET_VOICE_SEED/);
  assert.match(audio, /seed: voiceSeed/);
  assert.match(audio, /tokenSoftCap: 120/);
  assert.doesNotMatch(audio, /throughput \? 176/);
  assert.doesNotMatch(audio, /throughput \? Math\.min\(POCKET_PARAGRAPH_PAUSE_SEC/);
  assert.doesNotMatch(audio, /tt176/);

  assert.doesNotMatch(worker, /opts\.throughputMode \? POCKET_THROUGHPUT_TOKEN_SOFT_CAP/);
  assert.doesNotMatch(worker, /throughputBatch \? 48/);
  assert.match(worker, /const normalChunkFrames = 12/);
  assert.match(worker, /Number\(opts\.lsdSteps\)/);
});

test('emotion switches dwell long enough that adjacent paragraphs share a voice', async () => {
  const source = await read('public/assets/js/audio_core.js');
  const dwell = Number(source.match(/const EMOTION_PLAN_DWELL = (\d+)/)?.[1]);
  assert.ok(dwell >= 4, `dwell ${dwell} still lets emotion flip every other paragraph`);
});

test('pocket worker implements Mulberry32 PRNG with paired Box-Muller Gaussian sampling', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /function seededGaussian/);
  assert.match(worker, /Math\.imul\(z \^ \(z >>> 15\), z \| 1\)/, 'worker must use Mulberry32 PRNG');
  assert.match(worker, /_spareGaussian = mag \* Math\.sin\(angle\)/, 'worker must use paired Box-Muller generation');
  assert.match(worker, /_hashSeedString/, 'worker must use 32-bit avalanche hash for seeds');
  assert.match(worker, /0x85ebca6b/, 'seed hash must keep the MurmurHash3 finalizer avalanche');
});

test('pocket worker and audio core support structured voice seed anchoring', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /const explicitSeed = control && \(control\.voiceSeed != null \? control\.voiceSeed : control\.seed\);/);
  assert.match(worker, /const voiceSeedSuffix = explicitSeed != null \? \('\|s' \+ explicitSeed\) : '';/);

  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /function _pocketVoiceSeed\(/);
  assert.match(audio, /seed: voiceSeed/);
  assert.match(audio, /voiceSeed,/);
});
