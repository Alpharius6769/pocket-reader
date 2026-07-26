import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const norm = (s) => s.replace(/\r\n/g, '\n');

// See tests/migration_parity.test.mjs: anvil-app is a bare gitlink, so it is
// absent from CI checkouts.
const anvilPresent = existsSync(new URL('../anvil-app/theme/assets', import.meta.url));

// Regression guards for the 2026-07-23 upload/dedup + narration-reload/overlay UI
// fixes and the follow-up audit hardening (author-guarded dedup, corrected
// re-upload, theme-aware mask, single decorated audio-cache clear).

test('loadStory intercepts uploaded refs before the backend scrape', async () => {
  const api = await read('public/assets/js/api_core.js');
  // /local-upload/ and local:// refs have no network source; they must be caught
  // before the AO3/scrape dispatch and routed to the re-upload prompt, never
  // POSTed to /api/scrape (which 400s "Invalid URL format" on a non-http url).
  assert.match(api, /\^\(\\\/local-upload\\\/\|local:\\\/\\\/\)\/i\.test\(fetchUrl\)/);
});

test('silent background fetch skips uploaded refs instead of scraping', async () => {
  const api = await read('public/assets/js/api_core.js');
  assert.match(api, /LOCAL_UPLOAD_NO_SOURCE/);
  assert.match(api, /\^\(\\\/local-upload\\\/\|local:\\\/\\\/\)\/i\.test\(url\)/);
});

test('upload dedup requires a real author for the title+author fallback', async () => {
  const api = await read('public/assets/js/api_core.js');
  // Guards against false-positive merges (two "Unknown"-authored, or same-title
  // works) that would adopt the wrong entry's identity and overwrite its chapters.
  assert.match(api, /_a && _a !== 'unknown'/);
});

test('upload dedup applies a corrected same-count re-upload', async () => {
  const api = await read('public/assets/js/api_core.js');
  // Same chapter count but changed text must take the new content, not silently
  // keep the stale stored chapters.
  assert.match(api, /_flatten\(newStory\.chapters\) !== _flatten\(_stored\)/);
});

test('loading overlay reveal is delayed and cancellable', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  // Fast/cached operations must not flash the full-screen modal: show schedules a
  // ~300ms reveal; hide cancels a pending reveal.
  assert.match(ui, /_loadingOverlayTimer = setTimeout\(\(\) => \{/);
  assert.match(ui, /clearTimeout\(window\._loadingOverlayTimer\)/);
});

test('fast-narration reload paints a self-removing, theme-aware anti-flash mask', async () => {
  const page = await read('public/standard-page.html');
  assert.match(page, /pr-iso-mask/);
  // Gated on an actively-pending resume so a bare ?tts_fast=1 reload is untouched.
  assert.match(page, /pr_fast_narration_resume_v1/);
  assert.match(page, /pr_backend_optimization_resume_v1/);
  // Theme-aware so light-theme users don't get a dark mask.
  assert.match(page, /background:var\(--app-bg,#111214\)/);
  // Self-removes when a non-Home view (or the JS overlay) takes over.
  assert.match(page, /__prClearIsoMask/);
});

test('audio-cache clear is wrapped once with working feedback for both callers', async () => {
  const settings = await read('public/assets/js/settings_manager.js');
  // Both the Settings button and the reader storage panel call
  // window.clearAudioCache; the decorator adds feedback for interactive calls and
  // passes programmatic (skipConfirm) calls straight through, wrapped only once.
  assert.match(settings, /_clearAudioCacheWrapped/);
  assert.match(settings, /if \(skipConfirm\) return _rawClearAudioCache/);
  // The obsolete settings-only wrapper must be gone (the button now calls the
  // decorated global directly).
  assert.doesNotMatch(settings, /clearAudioCacheFromSettings/);
});

test('anvil-app assets mirror the upload/UI audit fixes', {
  // Retired: Anvil has no users and is being deleted, and the modules now
  // target Pages asset paths that Anvil cannot serve. See
  // tests/migration_parity.test.mjs for the guard that replaced this.
  skip: 'Anvil mirror retired -- modules target Cloudflare Pages',
}, async () => {
  // Canonical source now lives under public/; anvil-app keeps a flat mirror
  // until Anvil is decommissioned (MIGRATION_PLAN.md Phase 4).
  const sources = {
    'api_core.js': 'public/assets/js/api_core.js',
    'ui_controller.js': 'public/assets/js/ui_controller.js',
    'settings_manager.js': 'public/assets/js/settings_manager.js',
    'standard-page.html': 'public/standard-page.html',
  };
  for (const [name, canonical] of Object.entries(sources)) {
    const root = norm(await read(canonical));
    const mirror = norm(await read(`anvil-app/theme/assets/${name}`));
    assert.equal(mirror, root, `${name} mirror drifted from ${canonical}`);
  }
});
