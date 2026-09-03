// Second-pass audit of the reliability work that shipped in 6cab470.
//
// Theme: each of yesterday's fixes was correct about its own mechanism and
// stopped one step short of the phase the failure actually happens in. The
// modal watchdog covers a modal that is already open; the companion preemption
// covers a beat that is already on screen; the optimization abort covers a
// calibration that has already started. Every one of those is the SECOND half
// of the operation, and the reader interrupts things during the first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

// ── A dismiss during the sprite load ────────────────────────────────────────
// Measured in the running app before the fix: trigger a companion beat, ask for
// a priority-80 modal 80 ms later, and the modal was still pending 1800 ms on.
// Wait 700 ms first, so the sprite has rendered, and it appeared in under one
// frame. Opening a story lands in the first case, not the second: api_core
// fires virtue_story_loading and the feature dialog follows milliseconds later.

test('a dismiss arriving before the sprite renders still cancels the beat', async () => {
  const source = await read('public/assets/js/virtue_controller.js');
  const display = source.slice(
    source.indexOf('function _displayVirtue'),
    source.indexOf('export function triggerVirtue'),
  );

  // The run promise is resolved by _waitForVirtueDismiss, which lives inside
  // displayFn -- so between enqueue and decode there is nothing for
  // dismissVirtue() to walk. A stand-in waiter has to cover that window.
  const parkedAt = display.indexOf('virtueState.dismissWaiters.add(cancelDuringLoad)');
  const imageAt = display.indexOf('const img = new Image()');
  const decodeAt = display.indexOf('img.decode()');
  assert.notEqual(parkedAt, -1, 'a waiter must be parked for the load window');
  assert.ok(parkedAt > imageAt && parkedAt < decodeAt,
    'parked before the decode that gates displayFn');

  // And handed over, not left in the set, or the real display would be
  // cancellable twice and resolve(false) after it had already shown.
  const handoverAt = display.indexOf('virtueState.dismissWaiters.delete(cancelDuringLoad)', parkedAt);
  const speechAt = display.indexOf('_showVirtueSpeech(line, duration, isPriority)');
  assert.ok(handoverAt !== -1 && handoverAt < speechAt,
    'the stand-in must be removed before the beat actually speaks');

  // Idempotent, because dismissVirtue() walks a copy of the set and the sprite
  // handlers all funnel into displayFn.
  assert.match(display, /if \(cancelled\) return;\s*\n\s*cancelled = true;/);
  assert.match(display, /if \(cancelled \|\| displayed\) return;/);
});

test('a superseded display resolves instead of stranding the queue', async () => {
  // `if (displaySequence !== virtueState.displaySequence) return;` left the run
  // promise pending forever. The queue runs one event at a time and pump()
  // returns early while activeEvent is set, so reaching it once would have
  // killed every later modal, notice and beat -- the same failure as a modal
  // closed without releaseQueuedModal, in the other half of the same queue.
  const source = await read('public/assets/js/virtue_controller.js');
  const display = source.slice(
    source.indexOf('function _displayVirtue'),
    source.indexOf('export function triggerVirtue'),
  );
  const guardAt = display.indexOf('if (displaySequence !== virtueState.displaySequence) {');
  assert.notEqual(guardAt, -1, 'the guard must still exist');
  const block = display.slice(guardAt, guardAt + 200);
  assert.match(block, /cancelDuringLoad\(\);/, 'and must settle the promise on the way out');
});

test('every exit from a companion beat settles its run promise', async () => {
  // Structural backstop for the class rather than the instance: no bare
  // `return;` may sit inside _displayVirtue's promise executor.
  const source = (await read('public/assets/js/virtue_controller.js')).replace(/\r\n/g, '\n');
  const start = source.indexOf('function _displayVirtue');
  const end = source.indexOf('export function triggerVirtue');
  const body = source.slice(start, end);
  const bare = [...body.matchAll(/^[ \t]+return;[ \t]*$/gm)];
  for (const match of bare) {
    const before = body.slice(Math.max(0, match.index - 260), match.index);
    assert.match(before, /(resolve|cancelDuringLoad)\s*\(/,
      'a bare return inside the executor must be preceded by something that settles it');
  }
});

// ── The service worker's unversioned branch ─────────────────────────────────

test('an unversioned asset falls back to cache on a stall, not only a failure', async () => {
  // engine_utils.js (a blocking module script, and the voice catalog's home)
  // and motion_lite.js ship without a ?v=, so they take the network-first
  // branch. That branch reached the cache only when the fetch REJECTED -- and a
  // stalled fetch never rejects, so a weak connection held up the boot on two
  // modules that were already cached while every versioned module beside them
  // was served instantly.
  const sw = await read('public/sw.js');
  const branch = sw.slice(
    sw.indexOf('// Unversioned assets stay network-first'),
    sw.indexOf('// Cache-first strategy for large visual assets.'),
  );
  assert.ok(branch.length > 400, 'the branch must be locatable');
  assert.match(branch, /UNVERSIONED_NETWORK_DEADLINE_MS/);
  assert.match(branch, /Promise\.race\(\[/);
  assert.match(sw, /var UNVERSIONED_NETWORK_DEADLINE_MS = 1800;/);

  // A deadline must never turn a slow FIRST load into a 503: with nothing
  // cached there is nothing to fall back to, so those requests still wait.
  const noCache = branch.indexOf('if (!cachedResponse) {');
  const race = branch.indexOf('Promise.race([');
  assert.ok(noCache !== -1 && noCache < race,
    'the no-cache case must be handled before the deadline applies');
  assert.match(branch.slice(noCache, race), /updatePromise\.catch/,
    'and must wait on the network rather than race it');

  // ES5 only: this file is annotated `esversion: 5` and runs as a worker.
  assert.doesNotMatch(branch, /=>|\bconst\b|\blet\b/, 'the service worker stays ES5');
});

test('the two unversioned modules are the only ones on that branch', async () => {
  // If a third appears, the deadline above is what it inherits -- worth
  // knowing, because the versioned path is strictly better (immutable, cached,
  // no launch fetch at all).
  const html = await read('public/index.html');
  const unversioned = [...html.matchAll(/assets\/js\/([a-z_0-9]+\.js)(?!\?v=)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(unversioned)].sort(), ['engine_utils.js', 'motion_lite.js']);
});

// ── Queue ordering ──────────────────────────────────────────────────────────

test('a full queue drops its least important event, not its most', async () => {
  // pendingEvents is sorted DESCENDING by priority, so findIndex(p < priority)
  // returned the BEST of the droppable events. The queue shed the most
  // important thing it was allowed to shed and kept the least.
  const source = await read('public/assets/js/experience_coordinator.js');
  const enqueue = source.slice(
    source.indexOf('export function enqueueExperience'),
    source.indexOf('window.enqueueExperience = enqueueExperience'),
  );
  assert.doesNotMatch(enqueue, /findIndex\(\(event\) => event\.priority < priority\)/,
    'the first match is the wrong victim in a descending list');
  assert.match(enqueue, /for \(let index = pendingEvents\.length - 1; index >= 0; index -= 1\)/);
});

test('preemption does not fire for an event the queue then refuses', async () => {
  const source = await read('public/assets/js/experience_coordinator.js');
  const enqueue = source.slice(
    source.indexOf('export function enqueueExperience'),
    source.indexOf('window.enqueueExperience = enqueueExperience'),
  );
  const decided = enqueue.indexOf('const preemptsCompanion =');
  const overflow = enqueue.indexOf('if (pendingEvents.length >= MAX_PENDING_EVENTS)');
  const acted = enqueue.indexOf('window.dismissVirtue?.()');
  assert.ok(decided !== -1 && overflow !== -1 && acted !== -1);
  assert.ok(decided < overflow, 'decided against the state before the queue changes');
  assert.ok(acted > overflow, 'but acted on only once the event is definitely queued');
});

// ── One blocking-overlay list, not two ──────────────────────────────────────

test('the tip sequencer and the experience queue agree on what is blocking', async () => {
  // They each kept their own hardcoded id list, and the two had drifted in
  // three places: device-setup-modal and profile-edit-modal were in neither,
  // feature-dialog was missing from the tip sequencer. Observed on a fresh
  // first run with the device-setup dialog on screen (fixed, inset 0, z-index
  // 99998, aria-modal): getExperienceQueueState() reported blocked:false and a
  // queued notice ran straight over it, while the tip layer rendered
  // underneath at z-index 11000 and waited for a button nobody could reach.
  const coordinator = await read('public/assets/js/experience_coordinator.js');
  const ui = await read('public/assets/js/ui_controller.js');

  assert.match(coordinator, /export const BLOCKING_OVERLAY_IDS = Object\.freeze\(\[/,
    'the list must be exported, not private');
  assert.match(ui, /import \{ BLOCKING_OVERLAY_IDS \} from '\.\/experience_coordinator\.js\?v=/,
    'the sequencer must import it rather than keep a copy');
  assert.match(ui, /return BLOCKING_OVERLAY_IDS\.some\(\(id\) => _isElemVisible\(document\.getElementById\(id\)\)\);/);

  // No second literal list may reappear.
  const seq = ui.slice(ui.indexOf('function _isBlockingOverlayOpen'), ui.indexOf('function _isBlockingOverlayOpen') + 700);
  assert.doesNotMatch(seq, /'global-loading-overlay'/, 'the copy is gone for good');
});

test('every full-screen dialog in the shell is on that list', async () => {
  // The list is only as good as its completeness, and the omissions were
  // invisible because nothing compared it to the markup. pr-layout-001 and
  // pr-layout-027 are the shell's two full-screen modal boxes
  // (position:fixed, inset 0, z-index 99998).
  const html = await read('public/index.html');
  const coordinator = await read('public/assets/js/experience_coordinator.js');
  const listed = new Set(
    [...coordinator.slice(
      coordinator.indexOf('export const BLOCKING_OVERLAY_IDS'),
      coordinator.indexOf(']);', coordinator.indexOf('export const BLOCKING_OVERLAY_IDS')),
    ).matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]),
  );
  const fullScreen = [...html.matchAll(/<div class="pr-layout-(?:001|027)[^"]*" id="([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(fullScreen.length >= 3, 'the markup scan must find the modals');
  for (const id of fullScreen) {
    assert.ok(listed.has(id), `${id} is a full-screen modal and must block the queue`);
  }
});

// ── Focus must leave a subtree before it is hidden from AT ──────────────────

test('a muted sibling is blurred before it is marked aria-hidden', async () => {
  // The reported warning -- "Blocked aria-hidden on an element because its
  // descendant retained focus", naming #virtue-container -- rests on an
  // assumption about `inert` that does not hold. Measured in Chrome:
  //
  //   inner.focus(); box.setAttribute('inert', '');
  //   // activeElement === inner, synchronously AND after a task
  //
  // So the subtree was marked aria-hidden while it still held focus: a screen
  // reader parked on a node no longer in the accessibility tree, and
  // document.activeElement outside the modal that just claimed to trap it.
  const source = await read('public/assets/js/device_setup.js');
  const isolate = source.slice(
    source.indexOf('function isolateModalSiblings'),
    source.indexOf('function trapPocketModalFocus'),
  );
  const blurAt = isolate.indexOf('document.activeElement.blur()');
  const inertAt = isolate.indexOf("sibling.setAttribute('inert', '')");
  const ariaAt = isolate.indexOf("sibling.setAttribute('aria-hidden', 'true')");
  assert.notEqual(blurAt, -1, 'focus must be moved out explicitly');
  assert.ok(blurAt < inertAt && blurAt < ariaAt, 'and before either attribute is set');
  assert.match(isolate, /sibling\.contains\(document\.activeElement\)/,
    'only the sibling that actually holds focus');
  assert.match(isolate, /document\.activeElement !== document\.body/,
    'body is not a focus victim worth blurring');
});
