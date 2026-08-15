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

test('Rayne is honestly declared as neutral-only', async () => {
  // Only rayne_neutral.safetensors exists in B2; every other voice has 13
  // references. Declaring emotions Rayne does not have would resolve to asset
  // IDs that 404 rather than making it expressive.
  const source = await read('public/assets/js/engine_utils.js');
  const rayne = source.match(/id: 'rayne',[\s\S]*?\}/)?.[0] || '';
  assert.match(rayne, /availableEmotions: \['neutral'\]/,
    'Rayne must not claim emotions it has no reference audio for');
});
