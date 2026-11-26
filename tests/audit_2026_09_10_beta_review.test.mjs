import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const between = (source, from, to) => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `could not find ${from}`);
  return source.slice(start, source.indexOf(to, start + from.length));
};

// ── Settings > Download backup failed silently with a long story open ──────
//
// It serialised window.userProfile whole into a data: URL. The open story's
// library entry carries its full text and the avatar is base64, and Chrome
// will not download a data: URL much past 2 MB. Restore discards both fields.

test('the JSON backup is a Blob download without story text or avatar', async () => {
  const lib = await read('public/assets/js/library_manager.js');
  const fn = between(lib, 'export function downloadBackup()', 'window.downloadBackup = downloadBackup;');
  assert.ok(!fn.includes('data:text/json'), 'a data: URL fails past ~2 MB in Chrome');
  assert.match(fn, /URL\.createObjectURL\(new Blob\(/);
  assert.match(fn, /const \{ avatar, \.\.\.rest \} = window\.userProfile/);
  assert.match(fn, /\.map\(\(\{ chapters, \.\.\.story \}\) => story\)/);
  assert.match(fn, /URL\.revokeObjectURL\(url\)/);
});

// ── A chapter-list jump could be undone by the next sync ────────────────────

// ── Away Mode stuck on "Preparing Away Mode..." after a storage failure ────

// ── Sign-in is Google or guest, nothing else (product decision) ─────────────
//
// Email sign-up depended on a confirmation mail that never reliably arrived,
// so new accounts could be created and then never used.

// ── The iPhone 13 Pro Max is a Pocket device (product decision) ─────────────

test('an iPhone 13 Pro Max reaches Pocket, and its screen-mates do not by default', async () => {
  const policy = await import('../public/assets/js/pocket_backend_policy.js');
  const catalog = await import('../public/assets/js/device_catalog.js');
  const ios = (signals) => policy.classifyIosNarrationTier(signals);

  // Declared in the first-run picker: Pocket, unless the probe vetoes it.
  assert.equal(ios({ declaredDeviceId: 'iphone-13-pro-max' }).engine, 'pocket');
  assert.equal(ios({ declaredDeviceId: 'iphone-13-pro-max', memoryHeadroomMb: 900 }).engine, 'pocket');
  assert.equal(ios({ declaredDeviceId: 'iphone-13-pro-max', memoryHeadroomMb: 500 }).engine, 'kokoro',
    'the measurement stays a veto');

  // Undeclared: 120 Hz at 428x926 is the 13 Pro Max and nothing else.
  const models = catalog.tiersForGeometry('428x926').models;
  assert.deepEqual(catalog.refreshRateNarrows(models, 120).map((entry) => entry.id), ['iphone-13-pro-max']);
  const promotion = ios({ screenWidth: 428, screenHeight: 926, refreshHz: 120 });
  assert.equal(promotion.engine, 'pocket');
  assert.equal(promotion.confident, true);

  // Without that, the 12 Pro Max and 14 Plus keep the size Kokoro-first.
  assert.equal(ios({ screenWidth: 428, screenHeight: 926 }).engine, 'kokoro');
  assert.equal(ios({ screenWidth: 428, screenHeight: 926, refreshHz: 60 }).engine, 'kokoro');

  // An override must name a real tier.
  for (const entry of catalog.DEVICE_CATALOG) {
    if (entry.tier) assert.ok(['kitten', 'kokoro', 'pocket'].includes(entry.tier), entry.id);
  }
});
