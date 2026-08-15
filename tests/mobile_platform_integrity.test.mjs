// Guards for the 2026-08-14 mobile audit fixes.
//
// The theme running through this file: mobile mitigations in this codebase are
// not missing, they are *keyed on platform detection*. So the detection itself
// is the thing worth pinning, along with the cache-version machinery that
// decides whether a fix ever reaches a device.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  detectMobilePlatform,
  isIosLikePlatform,
  isMobileLikePlatform,
  classifyPocketDeviceCapability,
} from '../public/assets/js/pocket_backend_policy.js';

const read = (p) => readFile(p, 'utf8');

// iPadOS 13+ Safari sends this exact shape: a Macintosh UA with no iPad token.
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const IPAD_SIGNALS = { platform: 'MacIntel', maxTouchPoints: 5 };
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAC_SIGNALS = { platform: 'MacIntel', maxTouchPoints: 0 };
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const WIN_TOUCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

test('a stock iPad resolves to ios, not desktop', () => {
  // The whole finding in one assertion. 'desktop' unlocks WebGPU, the fifth
  // decode-block model, and full voice prefetch on a device with iPhone-class
  // WebKit memory limits — the configuration that OOM-killed an iPhone 13.
  assert.equal(detectMobilePlatform(IPAD_UA, IPAD_SIGNALS), 'ios');
  assert.equal(isIosLikePlatform(IPAD_UA, IPAD_SIGNALS), true);
  assert.equal(isMobileLikePlatform(IPAD_UA, IPAD_SIGNALS), true);
});

test('a real Mac is not misread as iOS by the touch heuristic', () => {
  assert.equal(detectMobilePlatform(MAC_UA, MAC_SIGNALS), 'desktop');
  assert.equal(isMobileLikePlatform(MAC_UA, MAC_SIGNALS), false);
  // A Windows touchscreen laptop must also stay desktop — the heuristic is
  // scoped to Mac-family platforms precisely so touch alone never demotes a PC.
  assert.equal(detectMobilePlatform(WIN_TOUCH_UA, { platform: 'Win32', maxTouchPoints: 10 }), 'desktop');
});

test('iPad inherits the full iOS memory profile', () => {
  // Safari does not implement navigator.deviceMemory, so it arrives as 0. The
  // desktop branch treats 0 as *positive* high-memory evidence, which is what
  // made this misclassification compound instead of merely degrade.
  const cap = classifyPocketDeviceCapability({
    userAgent: IPAD_UA,
    platform: detectMobilePlatform(IPAD_UA, IPAD_SIGNALS),
    deviceMemory: 0,
    hardwareConcurrency: 4,
  });
  assert.equal(cap.platform, 'ios');
  assert.equal(cap.constrained, true);
  assert.equal(cap.memorySafeInference, true);
  assert.equal(cap.fullStoryVoicePrefetch, false);
});

test('iPhone and Android classification is unchanged', () => {
  assert.equal(detectMobilePlatform(IPHONE_UA), 'ios');
  assert.equal(detectMobilePlatform('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'), 'android');
  assert.equal(detectMobilePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36'), 'desktop');
});

test('no module hand-rolls an iPad-blind iOS regex', async () => {
  // The fix is only durable if new code cannot quietly reintroduce the bug.
  // A bare /iPhone|iPad|iPod/ test is the exact shape that misses iPadOS.
  const dir = 'public/assets/js';
  const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const file of files) {
    // pocket_backend_policy owns the canonical implementation.
    if (file === 'pocket_backend_policy.js') continue;
    const source = await read(path.join(dir, file));
    source.split(/\r?\n/).forEach((line, i) => {
      if (!/\/[^/\n]*iP(hone|ad|od)[^/\n]*\/[a-z]*\.test\(/.test(line)) return;
      // Allowed when paired with the desktop-UA fallback, or when explicitly
      // marked as the pre-init fallback inside the worker.
      const context = source.split(/\r?\n/).slice(Math.max(0, i - 3), i + 3).join('\n');
      if (/maxTouchPoints|MacIntel|clientPlatform/.test(context)) return;
      offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    `these sites sniff iOS without the iPadOS desktop-UA fallback: ${offenders.join(', ')}`);
});

test('the inference worker never self-sniffs its platform', async () => {
  // WorkerNavigator exposes no maxTouchPoints, so a worker-side check cannot
  // tell an iPad from a Mac. The main thread must resolve and hand it over.
  const worker = await read('public/assets/js/pocket_worker.js');
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(worker, /let clientPlatform/);
  assert.match(worker, /data\.clientPlatform/);
  assert.match(audio, /clientPlatform: detectMobilePlatform\(/);
  // The memory-critical gates must read the delivered platform, not a regex.
  assert.match(worker, /const iosWebKit = isIosClient\(\)/);
  assert.match(worker, /constrainedMemoryMode = data\.constrainedMemoryMode === true \|\| isIosClient\(\)/);
});

test('worker-count caps route through the shared platform helper', async () => {
  // engine_utils decides HARD_CAP_WORKERS. Getting iPad wrong here spawns up to
  // 4 concurrent TTS workers, each holding model weights, on a WebKit device.
  const source = await read('public/assets/js/engine_utils.js');
  assert.match(source, /isMobileLikePlatform/);
  assert.doesNotMatch(source, /\/Mobi\|Android\|iPhone\|iPad\|Fennec/);
});

test('subscription sweeps are throttled across foreground transitions', async () => {
  const source = await read('public/assets/js/ui_controller.js');
  assert.match(source, /SUBSCRIPTION_SWEEP_MIN_INTERVAL_MS/);
  assert.match(source, /_lastSubscriptionSweepAt/);
  const floor = source.match(/SUBSCRIPTION_SWEEP_MIN_INTERVAL_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/)?.[1];
  assert.ok(Number(floor) >= 5,
    'a sub-5-minute floor still lets app-switching churn backend scrapes');
  // The visibility handler must go through the throttled path.
  assert.match(source, /visibilitychange[\s\S]{0,160}_scheduleSubscribedStoryChecks\(\)/);
});

test('the diagnostics heap sampler pauses while hidden and drops beforeunload', async () => {
  const source = await read('public/assets/js/diagnostics.js');
  assert.match(source, /_memTimer/);
  assert.match(source, /clearInterval\(this\._memTimer\)/);
  assert.match(source, /visibilitychange/);
  // beforeunload does not fire reliably on mobile and costs bfcache eligibility.
  assert.doesNotMatch(source, /addEventListener\('beforeunload'/);
  assert.match(source, /addEventListener\('pagehide'/);
});

test('the AudioContext is suspended when idle but never closed', async () => {
  const source = await read('public/assets/js/audio_core.js');
  assert.match(source, /_suspendIdleAudioContext/);
  assert.match(source, /_audioCtx\.suspend\(\)/);
  // Closing is unrecoverable — a closed context cannot be resumed, which would
  // permanently break the desktop streaming path.
  assert.doesNotMatch(source, /_audioCtx\.close\(\)/);
});

test('every module version is consistent across sw.js, the shell, and importers', async () => {
  // This is the guard that catches a half-applied bump: a module edited and
  // re-versioned in sw.js but still imported at the old ?v= elsewhere means the
  // browser fetches two copies, and the fix silently does not ship.
  const dir = 'public/assets/js';
  const sources = { 'sw.js': await read('public/sw.js'), 'index.html': await read('public/index.html') };
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.js'))) {
    sources[file] = await read(path.join(dir, file));
  }
  const seen = new Map();
  for (const [origin, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/assets\/js\/([a-z_0-9]+\.js)\?v=([A-Za-z0-9._-]+)/g)) {
      if (!seen.has(m[1])) seen.set(m[1], new Map());
      if (!seen.get(m[1]).has(m[2])) seen.get(m[1]).set(m[2], []);
      seen.get(m[1]).get(m[2]).push(origin);
    }
  }
  const drifted = [...seen]
    .filter(([, versions]) => versions.size > 1)
    .map(([mod, versions]) => `${mod}: ${[...versions].map(([v, files]) => `${v} (${files.join(', ')})`).join(' vs ')}`);
  assert.deepEqual(drifted, [], `module version drift:\n  ${drifted.join('\n  ')}`);
  assert.ok(seen.size >= 20, 'expected the full module graph to be scanned');
});

test('the service-worker revision agrees everywhere it is written down', async () => {
  // Four files independently record this number. The invariant is agreement.
  const sw = await read('public/sw.js');
  const revision = sw.match(/pocket-reader-core-v(\d+)/)?.[1];
  assert.ok(revision, 'sw.js must declare a versioned cache name');
  const others = {
    'index.html': await read('public/index.html'),
    'ui_controller.js': await read('public/assets/js/ui_controller.js'),
    'settings_manager.js': await read('public/assets/js/settings_manager.js'),
    'tools/smoke_pocket_worker_runtime.mjs': await read('tools/smoke_pocket_worker_runtime.mjs'),
  };
  for (const [name, text] of Object.entries(others)) {
    const found = new Set([
      ...[...text.matchAll(/sw\.js\?v=(\d+)/g)].map((m) => m[1]),
      ...[...text.matchAll(/NARRATION_SERVICE_WORKER_VERSION\s*=\s*'(\d+)'/g)].map((m) => m[1]),
    ]);
    assert.ok(found.size > 0, `${name} records no service-worker revision`);
    for (const v of found) {
      assert.equal(v, revision, `${name} records SW revision ${v} but sw.js ships ${revision}`);
    }
  }
});
