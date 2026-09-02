// The measured headroom has to reach the decision that actually runs, not just
// the one taken during setup.
//
// The bug these guard: the probe's result was passed into selectNarrationEngine
// at exactly ONE call site -- inside the first-run diagnostics that had just
// taken the measurement. That call decides what gets WRITTEN to the device
// record. Every decision afterwards happens in a fresh page that never saw the
// probe: _resolveActiveEngine on each narration request, getNarrationEngineDecision
// at boot, and two Settings call sites all passed no headroom, so the policy
// treated every ambiguous device as unmeasured and collapsed it to the
// conservative floor.
//
// The visible symptom would have been an iPhone 15 Pro whose setup screen said
// "Pocket" and whose narration ran on Kokoro, forever, with nothing wrong in
// any log. The measurement decided a label and nothing else -- which is the
// same defect the probe was built to fix, one layer up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const policy = await import('../public/assets/js/pocket_backend_policy.js');

const storageWith = (record) => {
  const map = new Map();
  if (record) map.set(policy.POCKET_DEVICE_SETUP_KEY, JSON.stringify(record));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
};
const record = (headroomMb, measured = true) => ({
  version: 2,
  completedAt: Date.now(),
  recommendedBackend: 'wasm',
  capability: { platform: 'ios', userAgent: 'iPhone' },
  memory: { measured, headroomMb, stoppedBy: 'ceiling' },
});
// 393x852 is the bucket that cannot be resolved without a measurement: an
// iPhone 14 Pro and a 15 Pro report it identically.
const resolveIos = (storage, w = 393, h = 852) => policy.selectNarrationEngine({
  capability: { platform: 'ios' }, screenWidth: w, screenHeight: h, storage,
});

test('a later page load reads the measurement back out of the stored record', () => {
  // No memoryHeadroomMb is passed here, exactly as _resolveActiveEngine does.
  const fifteenPro = resolveIos(storageWith(record(900)));
  assert.equal(fifteenPro.engine, 'pocket');
  assert.equal(fifteenPro.confident, true);
  assert.match(fifteenPro.reason, /measured 900 MB/);

  const fourteenPro = resolveIos(storageWith(record(500)));
  assert.equal(fourteenPro.engine, 'kokoro', 'the same geometry with less room stays down a tier');

  // And one tier lower, where the 12/13 pair sits.
  assert.equal(resolveIos(storageWith(record(500)), 390, 844).engine, 'kokoro');
  assert.equal(resolveIos(storageWith(record(300)), 390, 844).engine, 'kitten');
});

test('an explicit measurement still wins over the stored one', () => {
  // The setup run passes its fresh reading directly; that must outrank whatever
  // an older record happens to hold.
  const stale = storageWith(record(200));
  assert.equal(policy.selectNarrationEngine({
    capability: { platform: 'ios' }, screenWidth: 393, screenHeight: 852,
    memoryHeadroomMb: 900, storage: stale,
  }).engine, 'pocket');
});

test('no measurement means the conservative floor, never an optimistic guess', () => {
  // Absent, unmeasured, and malformed records must all read as "unknown" rather
  // than as evidence of a large device.
  for (const storage of [
    storageWith(null),
    storageWith(record(900, false)),
    storageWith({ version: 2, completedAt: Date.now() }),
    storageWith({ version: 1, completedAt: Date.now(), memory: { measured: true, headroomMb: 900 } }),
  ]) {
    const decision = resolveIos(storage);
    assert.equal(decision.engine, 'kokoro', 'the 393x852 bucket floors at Kokoro');
    assert.equal(decision.confident, false, 'and must not claim it measured anything');
  }
});

test('readMeasuredHeadroomMb survives every hostile storage it can be handed', () => {
  assert.equal(policy.readMeasuredHeadroomMb(storageWith(record(900))), 900);
  assert.equal(policy.readMeasuredHeadroomMb(storageWith(record(0))), 0);
  assert.equal(policy.readMeasuredHeadroomMb(storageWith(record(-5))), 0, 'negative is not a measurement');
  assert.equal(policy.readMeasuredHeadroomMb(storageWith(record('abc'))), 0, 'NaN is not a measurement');
  assert.equal(policy.readMeasuredHeadroomMb(storageWith(null)), 0);
  assert.equal(policy.readMeasuredHeadroomMb(null), 0);
  assert.equal(policy.readMeasuredHeadroomMb(undefined), 0);
  assert.equal(policy.readMeasuredHeadroomMb({ getItem: () => '{{{ not json' }), 0);
  assert.equal(policy.readMeasuredHeadroomMb({ getItem() { throw new Error('SecurityError'); } }), 0,
    'storage that throws is common in private mode and must not break narration');
});

test('the fallback lives in the selector, not at its call sites', async () => {
  // This is the structural half. Threading the value through call sites is what
  // failed the first time -- four of five forgot -- so the selector itself has
  // to reach for it. A future caller cannot forget what it never has to pass.
  const source = await readFile(path.join(ROOT, 'public/assets/js/pocket_backend_policy.js'), 'utf8');
  const signals = source.slice(source.indexOf('const signals = {'), source.indexOf('let picked;'));
  assert.match(signals, /readMeasuredHeadroomMb\(options\.storage\)/,
    'selectNarrationEngine must fall back to the persisted measurement itself');
});

test('every selectNarrationEngine caller reaches the same answer', async () => {
  // Belt and braces: no caller may hardcode a headroom of 0 in a way that
  // defeats the fallback, because `0 ?? x` short-circuits to 0.
  const roots = ['public/assets/js/engine_utils.js', 'public/assets/js/settings_manager.js'];
  for (const rel of roots) {
    const source = await readFile(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(source, /memoryHeadroomMb:\s*0\b/,
      `${rel} must not pass a literal 0, which would mask the stored measurement`);
  }
});
