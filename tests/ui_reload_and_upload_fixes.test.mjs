import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const norm = (s) => s.replace(/\r\n/g, '\n');

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

// The anvil-app mirror assertion that lived here is deleted along with Anvil
// itself (Phase 5). tests/migration_parity.test.mjs asserts the property that
// replaced it: no module builds an Anvil asset URL.
