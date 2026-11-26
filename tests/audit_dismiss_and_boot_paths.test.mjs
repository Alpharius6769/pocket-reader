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

// ── Queue ordering ──────────────────────────────────────────────────────────

// ── One blocking-overlay list, not two ──────────────────────────────────────

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

// ── The quota fallback shed the wrong things ────────────────────────────────

test('the graduated ladder keeps achievements and the streak', async () => {
  // Functional, not structural: run the real ladder against an oversized
  // profile and check what survives. Only DERIVED data may go.
  const { shrinkProfileToFit, MAX_PROFILE_BYTES } = await import('../public/assets/js/library_core.js');
  const profile = {
    displayName: 'Reader',
    achievements: [{ id: 'first_book', at: 1 }, { id: 'night_owl', at: 2 }],
    activityDays: Array.from({ length: 800 }, (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, '0')}`),
    readingQueue: ['story-a', 'story-b'],
    goals: { weeklyMinutes: 120 },
    history: Array.from({ length: 250 }, (_, i) => ({ storyKey: `s${i}`, title: 'x'.repeat(4000), lastAt: i })),
    // Unique day keys, or the object collapses to a couple of hundred entries
    // and the fixture is not actually oversized.
    dailyStatsByDevice: Object.fromEntries(
      ['dev1', 'dev2'].map((d) => [d, Object.fromEntries(
        Array.from({ length: 1500 }, (_, i) => [
          `${2015 + Math.floor(i / 360)}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}-${i}`,
          { minutes: i, words: i * 50 },
        ]),
      )]),
    ),
    library: Array.from({ length: 40 }, (_, i) => ({ storyKey: `lib${i}`, title: 'A story', author: 'Someone' })),
    settings: { theme: 'slate' },
  };
  const before = new TextEncoder().encode(JSON.stringify(profile)).length;
  assert.ok(before > MAX_PROFILE_BYTES, 'the fixture must actually be oversized');

  const { value, pruned } = shrinkProfileToFit(profile);
  assert.ok(new TextEncoder().encode(JSON.stringify(value)).length <= MAX_PROFILE_BYTES);
  assert.ok(pruned.length > 0, 'something must have been shed');

  // The point of the fix: none of these are why a profile overflows, and none
  // of them can be regenerated.
  assert.equal(value.achievements.length, 2, 'achievements are user-authored');
  assert.ok(value.activityDays.length > 0, 'the reading streak survives');
  assert.deepEqual(value.readingQueue, ['story-a', 'story-b']);
  assert.deepEqual(value.goals, { weeklyMinutes: 120 });
  assert.equal(value.library.length, 40, 'the library is never trimmed to make room');
  assert.deepEqual(value.settings, { theme: 'slate' });
});

test('the local quota fallback uses that ladder before amputating', async () => {
  const source = await read('public/assets/js/library_manager.js');
  assert.match(source, /import \{ profileHash, storyKeyFor, mergeClockedMap, shrinkProfileToFit \}/);

  const flush = source.slice(
    source.indexOf('function _flushLocalData'),
    source.indexOf('// ── Coalesced profile-commit batch'),
  );
  const shrinkAt = flush.indexOf('shrinkProfileToFit(liteProfile)');
  const slimAt = flush.indexOf('const slim = {');
  assert.notEqual(shrinkAt, -1, 'the ladder must be tried');
  assert.ok(shrinkAt < slimAt, 'before the one-step fallback');

  // The payload that failed is the one that gets shrunk -- not a different,
  // smaller object rebuilt from scratch.
  assert.match(flush, /let liteProfile = null;/);

  // And the last resort carries the small irreplaceable fields it used to drop.
  const slim = flush.slice(slimAt, flush.indexOf('localStorage.setItem', slimAt));
  for (const field of ['achievements', 'activityDays', 'readingQueue', 'goals']) {
    assert.match(slim, new RegExp(`${field}:`), `${field} must survive the last resort`);
  }
});
