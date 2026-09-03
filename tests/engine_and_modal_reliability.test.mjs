// Four field bugs, reported together because they share two causes: a promise
// that is forgotten rather than settled, and a queue that only orders what is
// pending while never interrupting what is running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const policy = await import('../public/assets/js/pocket_backend_policy.js');

// ── WebGPU silently becoming WASM ───────────────────────────────────────────
// _preparePocketBackendPlan re-probes on every engine reset. Every probe failure
// returned WITHOUT adapterIdentity, and that identity keys the stored
// calibration -- so the key became `unknown-adapter`, this machine's WebGPU
// calibration stopped being found, and the plan fell through to the first-run
// setup recommendation, which on a desktop benchmarked as WASM is 'wasm'.

test('a transient probe failure still reports the adapter identity', async () => {
  // Requesting an adapter or a 16 MB buffer can fail while another session
  // still holds the GPU -- exactly when an engine reset re-probes. Losing the
  // identity there repoints the calibration lookup at an empty bucket.
  const source = await read('public/assets/js/pocket_backend_policy.js');
  const probe = source.slice(
    source.indexOf('export async function probePocketWebGpuEligibility'),
    source.indexOf('export function percentile'),
  );
  assert.ok(probe.length > 500, 'the probe must be locatable');

  // The identity is read BEFORE the allocation probe, so a failure there can
  // still carry it.
  const identityAt = probe.indexOf('const identity = adapterIdentity(info);');
  const allocationAt = probe.indexOf('WebGPU allocation probe failed');
  assert.notEqual(identityAt, -1, 'the identity must be resolved up front');
  assert.ok(identityAt < allocationAt, 'and before the allocation probe can fail');
  assert.match(probe.slice(allocationAt - 400, allocationAt + 400), /adapterIdentity: identity/);

  // The three "not right now" failures are marked; the durable ones are not.
  for (const transient of ['WebGPU adapter request failed', 'No WebGPU adapter was returned', 'WebGPU allocation probe failed']) {
    const at = probe.indexOf(transient);
    assert.notEqual(at, -1, `${transient} must exist`);
    assert.match(probe.slice(Math.max(0, at - 260), at + 60), /transient: true/,
      `${transient} is transient and must say so`);
  }
  for (const durable of ['does not support shader-f16', 'WebGPU is unavailable in this browser', 'requires a secure context']) {
    const at = probe.indexOf(durable);
    if (at === -1) continue;
    const line = probe.slice(probe.lastIndexOf('\n', at) + 1, probe.indexOf('\n', at));
    assert.doesNotMatch(line, /transient: true/, `${durable} is durable and must not be forgiven`);
  }
});

test('a calibrated WebGPU device is retained across a transient failure', async () => {
  const source = await read('public/assets/js/audio_core.js');
  const plan = source.slice(
    source.indexOf('const calibratedGpu ='),
    source.indexOf('Object.assign(_pocketBackendRuntime, {'),
  );
  assert.match(plan, /eligibility\.transient === true/);
  assert.match(plan, /&& calibratedGpu && !stickyDemotion\?\.demotedFromWebGpu/,
    'only a device that already proved WebGPU is forgiven, and never one that was demoted');
  assert.match(plan, /eligible: true/);

  // And the sticky identity keeps the calibration key stable regardless --
  // across reloads too, because an engine switch can take a ?tts_fast=1
  // navigation and the first probe of the new document is both the likeliest to
  // find the GPU busy and the one with no remembered identity of its own.
  assert.match(source, /let _lastKnownAdapterIdentity = _readStoredAdapterIdentity\(\);/);
  assert.match(source, /localStorage\.setItem\(POCKET_ADAPTER_IDENTITY_KEY, value\);/);
  assert.match(source, /adapterIdentity: eligibility\.adapterIdentity \|\| _lastKnownAdapterIdentity \|\| 'unknown-adapter'/);
});

test('a downgrade off a calibrated GPU is never silent', async () => {
  // It was reported as "dropped to wasm x4 for an unknown reason".
  const source = await read('public/assets/js/audio_core.js');
  assert.match(source, /Pocket backend fell back to WASM on a WebGPU-calibrated device/);
});

// ── The 20-minute hang after stopping a cache ───────────────────────────────

test('tearing down the workers settles the backend optimization', async () => {
  // Every teardown site rejects each pending ttsQueue entry and then only
  // NULLED this promise. Nulling a variable does not settle it: the awaiter
  // waits on a promise whose only resolver was a message from a worker that no
  // longer exists, leaving the 20-minute timeout as the sole exit.
  const source = await read('public/assets/js/audio_core.js');
  assert.match(source, /function _abortPocketBackendOptimization\(reason\)/);

  // No teardown site may go back to merely forgetting it. The helper itself
  // clears the variable, which is the one legitimate assignment, so this looks
  // only outside it.
  const helperAt = source.indexOf('function _abortPocketBackendOptimization(reason)');
  const helperEnd = source.indexOf('\n}', helperAt);
  const outsideHelper = source.slice(0, helperAt) + source.slice(helperEnd);
  const assignments = [...outsideHelper.matchAll(/^[ \t]+_pocketBackendOptimizationPromise = null;$/gm)];
  assert.equal(assignments.length, 0,
    'a teardown must call _abortPocketBackendOptimization, not null the variable');
  const aborts = [...source.matchAll(/_abortPocketBackendOptimization\('The narration engine was reset\.'\)/g)];
  assert.equal(aborts.length, 4, 'all four teardown sites must settle it');
});

test('the abort is armed before the first await, not after it', async () => {
  // The first version registered the abort handle inside the innermost promise,
  // which is reached only after _loadPocketEngine() and ensurePocketVoiceLoaded()
  // -- two awaits that can each take tens of seconds. A teardown during either
  // settled nothing, so the caller waited for the voice load to finish and THEN
  // armed a 20-minute timeout against a worker that no longer existed. Stopping
  // a cache terminates those workers, and the load phase is exactly the part a
  // reader interrupts.
  const source = await read('public/assets/js/audio_core.js');
  const fn = source.slice(
    source.indexOf('async function _ensurePocketBackendOptimizedForVoice'),
    source.indexOf('window.ensurePocketBackendOptimized'),
  );
  const armedAt = fn.indexOf('_pocketBackendOptimizationAbort = (reason) =>');
  const firstAwaitAt = fn.indexOf('await _loadPocketEngine()');
  assert.notEqual(armedAt, -1, 'the abort must be armed');
  assert.ok(armedAt < firstAwaitAt, 'and armed before the engine load begins');

  // Racing is what releases the caller mid-load; the generation check is what
  // stops the orphaned attempt from continuing against a dead worker.
  assert.match(fn, /Promise\.race\(\[abortSignal, attempt\]\)/);
  assert.match(fn, /const generation = _pocketBackendOptimizationGeneration;/);
  const stillCurrent = [...fn.matchAll(/^\s+stillCurrent\(\);$/gm)];
  assert.equal(stillCurrent.length, 2, 'both awaits must be followed by a generation check');
  assert.match(source, /_pocketBackendOptimizationGeneration \+= 1;/,
    'aborting must invalidate the generation');
});

test('an abort is not treated as a failed optimization', async () => {
  // The failure path pins the session to WASM. Doing that when WE tore the
  // worker down would demote a capable machine for a reason the reader never
  // caused -- and would be a second source of the WebGPU-to-WASM drop.
  const source = await read('public/assets/js/audio_core.js');
  const catchBlock = source.slice(
    source.indexOf('Promise.race([abortSignal, attempt]).catch((error) => {'),
    source.indexOf('window.ensurePocketBackendOptimized'),
  );
  const abortAt = catchBlock.indexOf('POCKET_OPTIMIZATION_ABORTED');
  const wasmAt = catchBlock.indexOf("selectedBackend: 'wasm'");
  assert.notEqual(abortAt, -1, 'the abort must be recognised');
  assert.ok(abortAt < wasmAt, 'and must return before the WASM fallback runs');
});

// ── Modals that never appear ────────────────────────────────────────────────

test('a modal releases the queue even when nobody calls release', async () => {
  // A modal's run promise resolves only via releaseQueuedModal. A close path
  // that forgets it stranded activeEvent permanently, and pump() returns early
  // while one is set -- so NOTHING queued afterwards ever ran again.
  const source = await read('public/assets/js/experience_coordinator.js');
  const reveal = source.slice(source.indexOf('export function queueModalReveal'), source.indexOf('export function releaseQueuedModal'));
  assert.match(reveal, /setInterval/, 'the run promise must watch its own overlay');
  assert.match(reveal, /isVisible\(document\.getElementById\(modalId\)\)/);
  assert.match(reveal, /MODAL_REVEAL_GRACE_MS/,
    'a grace period, or the watchdog could fire before the modal has rendered');
  // Idempotent: the watchdog and an explicit release must not double-resolve.
  assert.match(reveal, /let settled = false;/);
  assert.match(reveal, /if \(settled\) return;/);
});

test('the close path that stranded the queue now releases it', async () => {
  const source = await read('public/assets/js/device_setup.js');
  const accept = source.slice(source.indexOf('function handleSettingsRiskAccept'), source.indexOf('function interceptAdvancedSettingsOpen'));
  assert.match(accept, /classList\.remove\('active'\)/);
  assert.match(accept, /window\.releaseQueuedModal\?\.\('settings-modal-overlay'\)/);
});

test('a modal preempts a decorative companion beat', async () => {
  // Priority orders the PENDING queue but never interrupts what is running, and
  // a Virtue beat holds the slot for its full 10 s speech. A modal asked for
  // during one waited that long, which reads as the modal being broken.
  const source = await read('public/assets/js/experience_coordinator.js');
  const enqueue = source.slice(source.indexOf('export function enqueueExperience'), source.indexOf('export function queueModalReveal'));
  assert.match(enqueue, /isVirtueEventId\(activeEvent\.id\)\s*\n?\s*&& Number\(priority\) > Number\(activeEvent\.priority \|\| 0\)/);
  assert.match(enqueue, /window\.dismissVirtue\?\.\(\)/);
});

test('dismissVirtue actually settles what the queue is waiting on', async () => {
  // Preemption only works because the beat's run promise is built on the same
  // waiters dismissVirtue resolves. If that ever changes, preemption silently
  // becomes a no-op and the delay comes back.
  const source = await read('public/assets/js/virtue_controller.js');
  const dismiss = source.slice(source.indexOf('export function dismissVirtue'), source.indexOf('export function dismissVirtue') + 600);
  assert.match(dismiss, /virtueState\.dismissWaiters\].forEach\(\(done\) => done\(\)\)/);
  assert.match(source, /_waitForVirtueDismiss\(effectiveDuration, resolve\)/,
    'the speech run promise must wait on those waiters');
  assert.match(source, /_waitForVirtueDismiss\(duration, resolve\)/,
    'and so must the trigger run promise');
});

// ── The tier ladder still behaves ───────────────────────────────────────────

test('the engine ladder is unchanged by these fixes', () => {
  assert.deepEqual([...policy.NARRATION_ENGINE_TIERS], ['kitten', 'kokoro', 'pocket']);
  for (const engine of policy.NARRATION_ENGINE_TIERS) {
    if (engine === 'pocket') continue;
    assert.equal(policy.voicesForEngine(engine).length, 6, `${engine} ships six voices`);
  }
});
