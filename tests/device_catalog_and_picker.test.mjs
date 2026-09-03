// Device identification: a catalogue, a first-run picker, and the rule that
// keeps a wrong answer cheap.
//
// The ladder turns on how much working memory a tab can hold, and the platform
// will not say. Chrome's UA Reduction froze the Android UA to "Android 10; K";
// navigator.deviceMemory is quantised AND capped at 8; Safari implements
// neither and offers only a screen size several models share.
//
// So: a model gives a CEILING, never an answer. Being wrong upward costs
// nothing while a measurement exists; being wrong downward costs only quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const catalog = await import('../public/assets/js/device_catalog.js');
const policy = await import('../public/assets/js/pocket_backend_policy.js');

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
};

// ── The catalogue itself ────────────────────────────────────────────────────

test('RAM maps to the ladder, and the 13 is a Kitten device', () => {
  // The decision that started this: a 4 GB iPhone 13 has a documented ~400 MB
  // heap budget, and Kokoro's session build peaks at 396-421 MB. The middle
  // engine is a coin flip on exactly that device.
  assert.equal(catalog.tierForRamGb(4), 'kitten');
  assert.equal(catalog.tierForRamGb(6), 'kokoro');
  assert.equal(catalog.tierForRamGb(8), 'pocket');
  assert.equal(catalog.tierForRamGb(12), 'pocket');

  assert.equal(catalog.tierCeilingForDevice('iphone-13-mini'), 'kitten');
  assert.equal(catalog.tierCeilingForDevice('iphone-13'), 'kitten');
  assert.equal(catalog.tierCeilingForDevice('iphone-13-pro'), 'kokoro');
  // 15 Pro is the first 8 GB iPhone, which is why "15 Pro and above -> Pocket"
  // was the right boundary all along.
  assert.equal(catalog.tierCeilingForDevice('iphone-15'), 'kokoro');
  assert.equal(catalog.tierCeilingForDevice('iphone-15-pro'), 'pocket');
  assert.equal(catalog.tierCeilingForDevice('iphone-16'), 'pocket');
});

test('every catalogue entry is well formed', () => {
  const ids = new Set();
  for (const entry of catalog.DEVICE_CATALOG) {
    assert.ok(entry.id && !ids.has(entry.id), `duplicate or missing id: ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.label, `${entry.id} needs a label`);
    assert.ok(Number(entry.ramGb) > 0, `${entry.id} needs RAM`);
    assert.ok(['ios', 'android'].includes(entry.platform), `${entry.id} platform`);
    assert.ok(catalog.deviceById(entry.id) === entry, `${entry.id} must be findable`);
    if (entry.geometry) assert.match(entry.geometry, /^\d+x\d+$/, `${entry.id} geometry`);
  }
  assert.ok(ids.size > 40, 'the catalogue must actually cover the range');
});

test('geometry candidates are derived from RAM, not hand-written', () => {
  // The old table kept the model names in comments and the candidate lists by
  // hand, so the two could drift. These fall out of the RAM figures.
  const span = (key) => catalog.tiersForGeometry(key).candidates.join(',');
  assert.equal(span('375x812'), 'kitten', 'X, XS, 11 Pro, 12 mini, 13 mini are all <= 4 GB');
  assert.equal(span('414x896'), 'kitten');
  assert.equal(span('428x926'), 'kokoro', '12 Pro Max, 13 Pro Max, 14 Plus are all 6 GB');
  assert.equal(span('393x852'), 'kokoro,pocket', '14 Pro and 15 are 6 GB; 15 Pro and 16 are 8 GB');
  assert.equal(span('440x956'), 'pocket');
  // An unrecognised size opens the whole ladder and lets the measurement speak.
  assert.equal(span('999x1999'), 'kitten,kokoro,pocket');
});

test('ProMotion is positive evidence only', () => {
  const models = catalog.tiersForGeometry('390x844').models;
  assert.ok(models.length > 3);
  // 120 Hz at this size is the 13 Pro and nothing else -- the one 6 GB device
  // among several 4 GB ones.
  const fast = catalog.refreshRateNarrows(models, 120);
  assert.deepEqual(fast.map((entry) => entry.id), ['iphone-13-pro']);
  // Every way the measurement can be wrong reports 60: Low Power Mode, a hidden
  // tab, a busy benchmark. So 60 must decide nothing.
  assert.equal(catalog.refreshRateNarrows(models, 60).length, models.length);
  assert.equal(catalog.refreshRateNarrows(models, 0).length, models.length);
});

test('an inferred Android class may only ever demote', () => {
  // A catalogue entry that understates RAM would otherwise cap a capable
  // device forever -- an 8 GB Pixel 8a matching a "6 GB a-series" row, say.
  // Android already reaches the top tier on its own, so inference has nothing
  // to add upward.
  assert.equal(catalog.androidInferredCeiling('Pixel 6 Pro'), '');
  assert.equal(catalog.androidInferredCeiling('Pixel 8a'), '');
  assert.equal(catalog.androidInferredCeiling('SM-S918B'), '');
  assert.equal(catalog.androidInferredCeiling('OnePlus 12'), '');
  // Known-weak classes do demote.
  assert.equal(catalog.androidInferredCeiling('SM-A536B'), 'kitten');
  assert.equal(catalog.androidInferredCeiling('moto g power'), 'kitten');
  assert.equal(catalog.androidInferredCeiling('Redmi Note 12'), 'kitten');
  assert.equal(catalog.androidInferredCeiling(''), '');

  // And the a-series is not the flagship class, whichever runs first.
  assert.equal(catalog.androidClassForModel('Pixel 7a')?.id, 'pixel-a');
  assert.equal(catalog.androidClassForModel('Pixel 7 Pro')?.id, 'pixel-flagship');
});

// ── The precedence rule ─────────────────────────────────────────────────────

const iphone = (extra = {}) => policy.selectNarrationEngine({
  capability: { platform: 'ios' },
  userAgent: IOS_UA,
  screenWidth: 393,
  screenHeight: 852,
  devicePixelRatio: 3,
  hardwareConcurrency: 4,
  storage: null,
  ...extra,
});

test('a declared model sets a ceiling the measurement resolves inside', () => {
  // Unmeasured and undeclared: the conservative floor of everything that
  // shares 393x852.
  assert.equal(iphone().engine, 'kokoro');

  // Declared, unmeasured: the claim stands. The reader asserted their own
  // hardware and Settings can still override in either direction.
  const claimed = iphone({ declaredDeviceId: 'iphone-15-pro' });
  assert.equal(claimed.engine, 'pocket');
  assert.match(claimed.reason, /You selected iPhone 15 Pro/);

  // Declared too high for what the device actually holds: the measurement
  // vetoes, and says so rather than silently disagreeing.
  const vetoed = iphone({ declaredDeviceId: 'iphone-15-pro', memoryHeadroomMb: 300 });
  assert.equal(vetoed.engine, 'kitten');
  assert.match(vetoed.reason, /measured only 300 MB/);

  // Declared LOWER than a generous measurement: honour the claim. Being wrong
  // downward costs quality; being wrong upward costs the tab.
  assert.equal(iphone({ declaredDeviceId: 'iphone-14-pro', memoryHeadroomMb: 900 }).engine, 'kokoro');
});

test('a failed probe can never promote through a claim', () => {
  // resolveTierByHeadroom returns candidates[0] when nothing clears, so a
  // single-element candidate list from a claim would have bypassed the veto
  // entirely. Truncating the ladder at the ceiling keeps the veto underneath.
  assert.deepEqual(policy.tiersUpTo('pocket'), ['kitten', 'kokoro', 'pocket']);
  assert.deepEqual(policy.tiersUpTo('kokoro'), ['kitten', 'kokoro']);
  assert.deepEqual(policy.tiersUpTo('kitten'), ['kitten']);
  assert.deepEqual(policy.tiersUpTo('nonsense'), ['kitten', 'kokoro', 'pocket']);

  // A measurement below every floor lands on the lightest tier, not the claim.
  assert.equal(iphone({ declaredDeviceId: 'iphone-17-pro', memoryHeadroomMb: 10 }).engine, 'kitten');
});

test('a manual Settings choice still outranks everything', () => {
  const chosen = iphone({ declaredDeviceId: 'iphone-13', override: 'pocket' });
  assert.equal(chosen.engine, 'pocket');
  assert.equal(chosen.automatic, false);
  assert.match(chosen.reason, /Chosen in Settings/);
});

test('a weak Android class demotes a device the old rule would have promoted', () => {
  const android = (extra = {}) => policy.selectNarrationEngine({
    capability: { platform: 'android' },
    userAgent: 'Mozilla/5.0 (Linux; Android 10; K) Mobile Safari/537.36',
    deviceMemory: 8,
    hardwareConcurrency: 8,
    storage: null,
    ...extra,
  });
  // Eight logical cores and a reported 8 GB is exactly what a budget SoC looks
  // like through the quantised APIs.
  assert.equal(android().engine, 'pocket');
  assert.equal(android({ model: 'SM-A536B' }).engine, 'kitten');
  assert.equal(android({ model: 'moto g power' }).engine, 'kitten');
  // A flagship is untouched.
  assert.equal(android({ model: 'Pixel 8 Pro' }).engine, 'pocket');
  // And a measurement still wins inside the demotion.
  assert.equal(android({ model: 'Pixel 8 Pro', memoryHeadroomMb: 900 }).engine, 'pocket');
});

// ── Storage and invalidation ────────────────────────────────────────────────

test('a declared model is device-local and dies with the hardware', () => {
  const storage = memoryStorage();
  const here = policy.deviceFingerprint({
    platform: 'ios', screenWidth: 393, screenHeight: 852, devicePixelRatio: 3, hardwareConcurrency: 4,
  });
  assert.equal(here, 'ios|393x852|3|4');

  policy.writeDeclaredDevice(storage, 'iphone-15-pro', here);
  assert.equal(policy.readDeclaredDevice(storage, here)?.id, 'iphone-15-pro');

  // A backup restored onto a different phone must not carry a claim about the
  // old one -- that is the exact failure the ceiling exists to prevent.
  const elsewhere = policy.deviceFingerprint({
    platform: 'ios', screenWidth: 440, screenHeight: 956, devicePixelRatio: 3, hardwareConcurrency: 4,
  });
  assert.equal(policy.readDeclaredDevice(storage, elsewhere), null);

  // Rotation must NOT invalidate it: the key is built from the sorted geometry.
  const rotated = policy.deviceFingerprint({
    platform: 'ios', screenWidth: 852, screenHeight: 393, devicePixelRatio: 3, hardwareConcurrency: 4,
  });
  assert.equal(rotated, here);

  policy.clearDeclaredDevice(storage);
  assert.equal(policy.readDeclaredDevice(storage, here), null);
  // An id the catalogue does not know is refused rather than stored.
  assert.equal(policy.writeDeclaredDevice(storage, 'iphone-99-ultra', here), null);
});

test('the declared model never reaches the synced profile', async () => {
  // It describes THIS handset. Syncing it would carry a claim about hardware
  // the other device does not have.
  const source = await read('public/assets/js/pocket_backend_policy.js');
  assert.match(source, /export const DECLARED_DEVICE_KEY = 'pr_declared_device_v1';/);
  for (const file of ['public/assets/js/profile_merge.js', 'public/assets/js/sync_core.js', 'public/assets/js/library_manager.js']) {
    const text = await read(file);
    assert.doesNotMatch(text, /declaredDevice|pr_declared_device/i, `${file} must not carry it`);
  }
});

// ── The picker ──────────────────────────────────────────────────────────────

test('the iPhone picker is narrowed by what was already measured', () => {
  const all = catalog.pickerOptions({ platform: 'ios', geometryKey: '', includeIpad: false });
  const iphoneCount = all.groups[0].options.length;

  const narrowed = catalog.pickerOptions({ platform: 'ios', geometryKey: '393x852', includeIpad: false });
  assert.equal(narrowed.narrowed, true);
  assert.ok(narrowed.groups[0].options.length < iphoneCount);
  assert.deepEqual(
    narrowed.groups[0].options.map((entry) => entry.id).sort(),
    ['iphone-14-pro', 'iphone-15', 'iphone-15-pro', 'iphone-16'],
  );

  // ProMotion narrows further where it can.
  const promotion = catalog.pickerOptions({ platform: 'ios', geometryKey: '390x844', refreshHz: 120, includeIpad: false });
  assert.deepEqual(promotion.groups[0].options.map((entry) => entry.id), ['iphone-13-pro']);

  // An unrecognised size offers everything rather than an empty list.
  const unknown = catalog.pickerOptions({ platform: 'ios', geometryKey: '999x1999', includeIpad: false });
  assert.equal(unknown.groups[0].options.length, iphoneCount);
});

test('iPads are offered, as classes rather than invented precision', () => {
  const withIpad = catalog.pickerOptions({ platform: 'ios', geometryKey: '393x852' });
  const ipadGroup = withIpad.groups.find((group) => group.label === 'iPad');
  assert.ok(ipadGroup && ipadGroup.options.length >= 5);
  // Pro RAM varies by STORAGE tier on the same model name, so exact figures
  // would be inventing precision. Nothing infers an iPad automatically either.
  for (const entry of ipadGroup.options) {
    assert.equal(entry.kind, 'ipad');
    assert.equal(entry.geometry, '', 'an iPad must never claim a geometry bucket');
  }
});

test('desktop is offered nothing to declare', () => {
  assert.deepEqual(catalog.pickerOptions({ platform: 'desktop' }).groups, []);
  assert.deepEqual(catalog.pickerOptions({}).groups, []);
});

// ── Setup wiring ────────────────────────────────────────────────────────────

test('the refresh probe cannot hang the setup flow', async () => {
  // rAF does not fire in a hidden tab at all, and this sits in front of the
  // whole first-run screen. Verified in a real browser: it returns 0 there and
  // 0 means "no evidence", which is exactly the old behaviour.
  const source = await read('public/assets/js/device_setup.js');
  const probe = source.slice(source.indexOf('async function measureRefreshHz'), source.indexOf('function readDownlinkMbps'));
  assert.match(probe, /document\.visibilityState === 'hidden'/);
  assert.match(probe, /setTimeout\(\(\) => resolve\(0\), 1500\)/);
  assert.match(probe, /gaps\.sort/, 'a median, not a mean: one dropped frame skews a mean');
});

test('the picker choice is committed before the benchmark can fail', async () => {
  const source = await read('public/assets/js/device_setup.js');
  const run = source.slice(source.indexOf('export async function runPocketDeviceDiagnostics'), source.indexOf('window.startPocketDeviceSetup'));
  const commitAt = run.indexOf('commitDevicePickerChoice()');
  const benchAt = run.indexOf('benchmarkCpu(');
  assert.ok(commitAt !== -1 && benchAt !== -1);
  assert.ok(commitAt < benchAt, 'a benchmark that dies partway must not lose the answer');

  // The refresh measurement has to happen before the CPU benchmark too: a
  // saturated device drops frames, and a dropped frame reads as 60 Hz.
  const refreshAt = run.indexOf('await measureRefreshHz()');
  assert.ok(refreshAt !== -1 && refreshAt < benchAt);

  // And the claim has to reach the selector, or none of this decides anything.
  assert.match(run, /declaredDeviceId: declaredDevice\?\.id \|\| ''/);
  assert.match(run, /refreshHz,/);
  assert.match(run, /model: capability\.model \|\| ''/);
});

test('a slow link is reported rather than looking like a hang', async () => {
  // Measured in the field at 1.7 Mbps: Kokoro's 86 MB model is about seven
  // minutes before a word is spoken, and that used to be indistinguishable from
  // the stall it really was. The engine choice is unaffected -- a slow link
  // says nothing about what a device can RUN.
  //
  // device_setup.js touches document at module scope, so the arithmetic is
  // checked against the source rather than by importing it.
  const source = await read('public/assets/js/device_setup.js');
  const fn = source.slice(
    source.indexOf('export function estimateModelDownloadSeconds'),
    source.indexOf('function currentDeviceSignals'),
  );
  const sizes = Object.fromEntries(
    [...fn.matchAll(/(kokoro|kitten|pocket): (\d+)/g)].map((m) => [m[1], Number(m[2])]),
  );
  assert.equal(sizes.kokoro, 86, 'the model this was reported against');
  assert.ok(sizes.kitten < sizes.kokoro && sizes.kokoro < sizes.pocket);
  // megabytes * 8 / mbps, in seconds.
  assert.match(fn, /\(megabytes \* 8\) \/ mbps/);
  assert.equal(Math.round((sizes.kokoro * 8) / 1.7), 405, 'about seven minutes at 1.7 Mbps');
  assert.equal(Math.round((sizes.kitten * 8) / 1.7), 113, 'against about two for Kitten');

  // Only surfaced when it is long enough to be mistaken for a stall.
  const label = source.slice(source.indexOf('const seconds = estimateModelDownloadSeconds'), source.indexOf('${download}`'));
  assert.match(label, /seconds >= 90/);
  assert.match(label, /first download about/);
});

// ── An iPhone 13 told it was running one thread ─────────────────────────────

test('the StyleTTS2 plan publishes its thread count to the runtime object', async () => {
  // Reported from an iPhone 13: "Slow 1-thread mode (isolation off)" on a device
  // that runs two performance-core threads -- and which the catalogue has just
  // moved to Kitten, i.e. onto the StyleTTS2 path where this goes wrong.
  //
  // _pocketBackendRuntime.threadCount is only written by
  // _preparePocketBackendPlan, and that planner is deliberately skipped for
  // Kokoro and Kitten. The stub that replaces it computes the real count and
  // hands it to the worker, but never wrote it back -- so the runtime object
  // kept the 1 from its own declaration, and every user-facing surface reads
  // the runtime object.
  const source = await read('public/assets/js/audio_core.js');
  assert.match(source, /^ {2}threadCount: 1,$/m, 'the declared default this used to be stuck on');

  const load = source.slice(
    source.indexOf('const backendPlan = _isStyleTts2Engine(engine)'),
    source.indexOf('const ENGINE_LOAD_LABELS'),
  );
  assert.match(load, /if \(_isStyleTts2Engine\(engine\)\) \{\s*\n\s*Object\.assign\(_pocketBackendRuntime, \{/);
  assert.match(load, /threadCount: backendPlan\.threadCount,/);
});

test('the worker\'s own thread count is believed over the plan\'s intention', async () => {
  // Both StyleTTS2 workers report ort.env.wasm.numThreads in init_done
  // telemetry -- with a comment recording that this same bug was fixed once
  // INSIDE the worker. The main thread merged telemetry on 'backend_selected'
  // and 'backend_status', which is what Pocket sends, and ignored it on
  // 'init_done', which is what StyleTTS2 sends.
  for (const file of ['public/assets/js/kokoro_worker.js', 'public/assets/js/kitten_worker.js']) {
    const worker = await read(file);
    assert.match(worker, /threads: ort\?\.env\?\.wasm\?\.numThreads \|\| 1,/, `${file} reports its real count`);
  }
  const source = await read('public/assets/js/audio_core.js');
  const branch = source.slice(
    source.indexOf("} else if (data.type === 'init_done' || data.type === 'ready'"),
    source.indexOf('if (!workerObj.ready) {'),
  );
  assert.match(branch, /data\.telemetry && typeof data\.telemetry === 'object'/);
  assert.match(branch, /threadCount: Number\(telemetry\.threads \|\| _pocketBackendRuntime\.threadCount \|\| 1\)/);
  // Pocket posts init_done with no telemetry at all, so this is a no-op there.
  const pocket = await read('public/assets/js/pocket_worker.js');
  assert.match(pocket, /postMessage\(\{ type: 'init_done' \}\);/);
});

test('the runtime label stops blaming isolation for a thread count', async () => {
  // `!isolated || threads <= 1` printed "(isolation off)" whenever EITHER was
  // true, so a properly isolated single-threaded session accused the browser of
  // something that was not happening -- and that is the half a reader acts on.
  const source = await read('public/assets/js/buffer_manager.js');
  const label = source.slice(
    source.indexOf('function _narrationRuntimeLabel'),
    source.indexOf('function _minimumPlaybackReadyCount'),
  );
  assert.doesNotMatch(label, /!isolated \|\| threads <= 1/, 'two conditions, two messages');
  assert.match(label, /if \(!_isolationReady\(\)\) \{\s*\n\s*return 'Slow 1-thread mode \(isolation off\)/);
  assert.match(label, /if \(threads <= 1\) \{\s*\n\s*return 'Slow 1-thread mode —/);
  assert.match(label, /Threaded WASM ×\$\{threads\}/);
});

test('an isolated iPhone gets the two threads it is capable of', () => {
  // iOS reports a constant hardwareConcurrency of 4 for anti-fingerprinting but
  // has two performance cores; extra threads land on the E-cores and stall
  // ORT's per-layer barrier. So 2 is the right answer, and 2 is what the
  // StyleTTS2 workers now ask ORT for.
  const iosIsolated = { crossOriginIsolated: true, platform: 'ios', mobile: true, hardwareConcurrency: 4 };
  assert.equal(policy.recommendedWasmThreadCount(iosIsolated), 2);
  // Without isolation there is no SharedArrayBuffer, so one thread is correct
  // and the "(isolation off)" message is the true one.
  assert.equal(policy.recommendedWasmThreadCount({ ...iosIsolated, crossOriginIsolated: false }), 1);
});

// ── Re-running the device test on an iPhone 13 ──────────────────────────────

test('a re-run keeps the declared model instead of erasing it', async () => {
  // The picker's <select> only exists inside the first-run modal. Re-running
  // the test from Settings found no element, read '' as the answer, and wrote
  // that -- deleting the record. Then geometry alone decided, every time.
  const source = await read('public/assets/js/device_setup.js');
  const commit = source.slice(
    source.indexOf('export function commitDevicePickerChoice'),
    source.indexOf('window.commitDevicePickerChoice ='),
  );
  assert.match(commit, /if \(!select\) return readDeclaredDevice\(localStorage, fingerprint\);/,
    'no picker on screen means nobody was asked');
  // An explicit "Not sure" still clears it: the reader is looking at the
  // control and has withdrawn the claim.
  assert.match(commit, /if \(!id\) \{ writeDeclaredDevice\(localStorage, '', fingerprint\); return null; \}/);
});

test('an undeclared measurement may climb only one tier', () => {
  // 390x844 spans all three tiers now that the 16e and 17e are recorded as
  // sharing the iPhone 14 chassis at 8 GB. Without a cap, a measurement above
  // Pocket's floor promoted a 4 GB iPhone 13 two tiers -- which the old
  // hand-written candidate list made structurally impossible.
  //
  // The probe cannot carry that. It allocates plain arrays and touches a page
  // each, ORT dies on a transient spike during session build, and the probe
  // stops at its own 1024 MB ceiling.
  const at = (extra) => policy.selectNarrationEngine({
    capability: { platform: 'ios' }, userAgent: 'iPhone',
    screenWidth: 390, screenHeight: 844, storage: null, ...extra,
  }).engine;
  assert.equal(at({ memoryHeadroomMb: 0 }), 'kitten');
  assert.equal(at({ memoryHeadroomMb: 500 }), 'kokoro');
  assert.equal(at({ memoryHeadroomMb: 1024 }), 'kokoro', 'never two tiers on a guess');

  // Declaring settles it in both directions.
  assert.equal(at({ memoryHeadroomMb: 1024, declaredDeviceId: 'iphone-13' }), 'kitten');
  assert.equal(at({ memoryHeadroomMb: 900, declaredDeviceId: 'iphone-16e' }), 'pocket');
});

test('every size that existed before the catalogue behaves as it did', () => {
  // The cap must be invisible everywhere the old hand-written lists already
  // spanned exactly two tiers, which is every size but 390x844.
  const at = (w, h, mb) => policy.selectNarrationEngine({
    capability: { platform: 'ios' }, userAgent: 'iPhone',
    screenWidth: w, screenHeight: h, memoryHeadroomMb: mb, storage: null,
  }).engine;
  assert.equal(at(393, 852, 900), 'pocket');
  assert.equal(at(393, 852, 500), 'kokoro');
  assert.equal(at(430, 932, 900), 'pocket');
  assert.equal(at(430, 932, 500), 'kokoro');
  assert.equal(at(375, 812, 900), 'kitten');
  assert.equal(at(428, 926, 900), 'kokoro');
  assert.equal(at(402, 874, 0), 'pocket');
});

test('every iPhone is offered to someone, and a narrowed list is never a trap', () => {
  // The reader saw only the models sharing their screen, which is the point --
  // but it must be possible to reach the rest. First: no model is orphaned.
  const iphones = catalog.DEVICE_CATALOG.filter((entry) => entry.kind === 'iphone');
  const reachable = new Set();
  for (const key of new Set(iphones.map((entry) => entry.geometry))) {
    for (const option of catalog.pickerOptions({ platform: 'ios', geometryKey: key, includeIpad: false }).groups[0].options) {
      reachable.add(option.id);
    }
  }
  for (const entry of iphones) {
    assert.ok(reachable.has(entry.id), `${entry.id} is offered to nobody`);
  }
  // Named explicitly, because these are the ones a reader would notice missing.
  for (const id of ['iphone-17', 'iphone-17-pro', 'iphone-17-pro-max', 'iphone-air', 'iphone-16e']) {
    assert.ok(reachable.has(id), `${id} must be selectable by its own owner`);
  }
});

test('the picker offers a way out of its own narrowing', async () => {
  // The 2025 geometries are the best available rather than verified, so a phone
  // this table has wrong would otherwise never find its model at all.
  const source = await read('public/assets/js/device_setup.js');
  assert.match(source, /const SHOW_ALL_MODELS = '__show_all__';/);
  assert.match(source, /My device isn't listed — show all/);
  assert.match(source, /geometryKey: showAll \? '' : geometryKey\(/,
    'showing all means dropping the geometry filter');
  assert.match(source, /refreshHz: showAll \? 0 : refreshHz/,
    'and the ProMotion narrowing with it');
  // The sentinel must never be stored as if it were a device.
  assert.match(source, /raw === SHOW_ALL_MODELS \? '' : raw/);
  assert.equal(catalog.deviceById('__show_all__'), null);
  // Nor written, even if it somehow arrived.
  const storage = { getItem: () => null, setItem: () => { throw new Error('must not write'); }, removeItem: () => {} };
  assert.equal(policy.writeDeclaredDevice(storage, '__show_all__', 'fp'), null);
});
