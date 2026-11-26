import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('service worker uses bounded navigation and lifetime-protected cache writes', async () => {
  const source = await read('public/sw.js');
  assert.match(source, /pocket-reader-core-v\d+/);
  // Navigation must stay bounded, and the bound must stay short enough that a
  // stalled mobile network never shows a long blank screen before the cached
  // shell appears. The exact value may be tuned; the ceiling is the invariant.
  const navTimeout = Number(source.match(/fetchWithTimeout\(event\.request,\s*(\d+)\)/)?.[1]);
  assert.ok(Number.isFinite(navTimeout), 'navigation fetch must carry an explicit timeout');
  assert.ok(navTimeout <= 2500, `navigation timeout ${navTimeout}ms is too long for a stalled mobile network`);
  assert.match(source, /event\.waitUntil\(updatePromise/);
  assert.match(source, /url\.searchParams\.has\('v'\)/);
});

test('uploads use a size-aware deadline and always clear timers', async () => {
  const source = await read('public/assets/js/api_core.js');
  const upload = source.match(/export async function processUploadedFile[\s\S]*?\n}\r?\nwindow\.processUploadedFile/)?.[0] || '';
  assert.match(upload, /uploadTimeoutMs/);
  assert.match(upload, /Math\.min\(\s*240000/);
  assert.match(upload, /finally\s*\{\s*clearTimeout\(timeoutId\)/);
  assert.doesNotMatch(upload, /controller\.abort\(\), 15000/);
});

test('backend database durability and health refresh are fail-visible and singleflight', async () => {
  const source = await read('backend/app.py');
  assert.match(source, /ALLOW_EPHEMERAL_DB/);
  assert.match(source, /database_durable/);
  assert.match(source, /SITE_HEALTH_REFRESH_LOCK/);
  assert.match(source, /client\.stream\("GET", url\)/);
});

// ── Audit 2026-08-28 ────────────────────────────────────────────────────────
// Each of these guards a control or hook that existed, looked wired, and did
// nothing. None of them threw, which is why they survived: a guarded call to a
// global that is not defined, or a select whose value is overwritten a moment
// later, fails silently by construction.

test('the Settings worker override reaches the pool as a ceiling', async () => {
  const policy = await read('public/assets/js/pocket_backend_policy.js');
  const audio = await read('public/assets/js/audio_core.js');
  const buffer = await read('public/assets/js/buffer_manager.js');

  // userMaxWorkers may only lower the count: the conditions in the policy are
  // memory-safety limits, not preferences.
  assert.match(policy, /Math\.max\(1, Math\.min\(value, Math\.floor\(ceiling\)\)\)/);
  assert.match(audio, /userMaxWorkers: settings\.enableManualWorkers/);

  // Nothing may re-derive a pool size from settings.maxWorkers and then have it
  // overwritten -- that is what made the control decorative.
  assert.doesNotMatch(buffer, /this\.maxWorkers = Number\(settings\.maxWorkers\)/,
    'BufferManager.start must not compute a count the policy replaces');
  assert.doesNotMatch(audio, /function _getMaxWorkers\(\)/);
});

test('the prosody drift guard resets per story and re-freezes per chapter', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  // window.resetPocketProsodyDrift had no callers, so a chapter that tripped the
  // guard carried its demotion into the next book.
  assert.match(audio, /function _syncProsodyDriftToPosition\(\)/);
  assert.match(audio, /_syncProsodyDriftToPosition\(\);/);
  // v2: a new STORY resets the guard; a new chapter keeps what it learned (so a
  // demotion takes effect there) and re-freezes the tier at the boundary.
  assert.match(audio, /if \(previousStory !== null && previousStory !== storyKey\) _prosodyDrift\.reset\(\);/);
  assert.match(audio, /_frozenProsodyTier = null;   \/\/ re-freeze at the chapter boundary/);
});

test('catalog refresh notifies through a global that exists', async () => {
  const list = await read('public/assets/js/hmofa_masterlist.js');
  assert.doesNotMatch(list, /window\.showNotice\s*\(/);
  assert.match(list, /window\.pocketNotify\?\.\(/);
});

// ── Second audit, 2026-08-28 ────────────────────────────────────────────────

