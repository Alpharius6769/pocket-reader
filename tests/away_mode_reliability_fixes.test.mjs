import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

// Regression guards for the 2026-07-21 Away Mode / silent-caching audit fixes.

test('Away Mode subpage escapes story titles (stored XSS)', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  // Both the queue list and quick-add list must route the title through the
  // module's HTML escaper before interpolating into innerHTML. Scraped/EPUB
  // titles are attacker-influenced, so a raw `${title}` render is a stored XSS.
  assert.match(buffer, /const title = _escapeCacheStatus\(story \? story\.title : ref\);/);
  assert.match(buffer, /const title = _escapeCacheStatus\(s\.title\);/);
  // The pre-fix raw interpolations must be gone.
  assert.doesNotMatch(buffer, /title="\$\{s\.title\}">\$\{s\.title\}/);
});

test('fast-narration reload saves the real active view, once', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  // showView marks the active view with `.active-view`; the old `.view.active`
  // selector matched nothing and always saved the home-view fallback, so the
  // post-reload restore yanked the user to Home.
  assert.match(buffer, /querySelector\('\.view\.active-view'\)/);
  assert.doesNotMatch(buffer, /querySelector\('\.view\.active'\)/);
  // The saved view must be preserved across an isolation-retry reload (which
  // re-enters after landing on Home) rather than overwritten.
  assert.match(buffer, /if \(!prSession\.getItem\('POCKET_PRE-RELOAD_VIEW'\)\)/);
});

test('retired voices migrate by alias, not by one-shot localStorage flags', async () => {
  const library = await read('public/assets/js/library_manager.js');
  // The bespoke rayne -> donald_malone migration is gone, and was deliberately
  // not replaced with donald_malone -> alba. A chain of one-shot migrations,
  // each gated on its own flag, only ever reaches a reader who happened to
  // launch the app inside that release window; anyone who did not is stranded
  // on a dead id forever. POCKET_VOICE_ALIASES runs on every load instead.
  assert.doesNotMatch(library, /pr_voice_migrated_to_donald_malone_v3/);
  assert.doesNotMatch(library, /settings\.pocketVoice = 'donald_malone'/);
  assert.match(library, /canonicalPocketVoice/,
    'the per-load alias resolver is what replaces the one-shot migration');
});

test('silent (preventNavigate) loads never navigate, overlay, or alert', async () => {
  const api = await read('public/assets/js/api_core.js');
  // processUploadedFile honors a silent option for background caching paths.
  assert.match(api, /export async function processUploadedFile\(file, fichubMeta, options = \{\}\)/);
  assert.match(api, /const silent = options\.silent === true;/);
  assert.match(api, /if \(!silent && typeof window\.showView === 'function'\) window\.showView\('reading-view'\);/);
  // The FicHub handoff is awaited and propagates silent mode.
  assert.match(api, /await window\.processUploadedFile\(file, fhData\.meta, \{ silent: preventNavigate \}\);/);
  // The invalid-URL notice is suppressed in background mode. Asserted on the
  // guard rather than the notice mechanism — blocking alert() was replaced with
  // the in-app companion notice, and pinning the delivery method here would
  // fail on a purely cosmetic change while missing the actual invariant.
  assert.match(api, /if \(!preventNavigate\) \{\s*\r?\n\s*window\.pocketNotify\?\.\(/);
  assert.doesNotMatch(api, /^\s*alert\("Invalid story URL/m,
    'background loads must not raise a blocking dialog');
});

test('a silent load superseding a foreground one clears the orphaned overlay', async () => {
  const api = await read('public/assets/js/api_core.js');
  // When a background (silent) load aborts a foreground load, the new load shows
  // no overlay of its own, so the superseded load must clear the one it left up.
  assert.match(api, /_activeLoadAbort\._supersededBySilent = preventNavigate;/);
  assert.match(api, /if \(ownAbort\._supersededBySilent && typeof window\.hideLoadingOverlay === 'function'\) window\.hideLoadingOverlay\(\);/);
});
