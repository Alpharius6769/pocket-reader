import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFile(path.join(root, name), 'utf8');

test('library card mutations and playback use stable story references', async () => {
  const source = await read('public/assets/js/library_manager.js');
  assert.match(source, /function findLibraryStoryByRef/);
  assert.match(source, /titleMatches\.length === 1 \? titleMatches\[0\] : null/);
  assert.doesNotMatch(source, /incomingKey \|\| s\.title === storyData\.title/);
  assert.match(source, /window\.removeStory\(decodeURIComponent\('\$\{storyKeyEncoded\}'\)\)/);
  assert.match(source, /window\.loadStory\(decodeURIComponent\('\$\{storyKeyEncoded\}'\)\)/);
});

test('cache status escapes story titles and audio keys use stable references', async () => {
  const source = await read('public/assets/js/buffer_manager.js');
  assert.match(source, /function _escapeCacheStatus/);
  assert.match(source, /\$\{_escapeCacheStatus\(currentStory\)\}/);
  assert.match(source, /getAudioChunk\(task\.storyRef \|\| task\.storyTitle/);
  assert.match(source, /saveAudioChunk\(task\.storyRef \|\| task\.storyTitle/);
});

test('push writes and deletes require a server-issued ownership token', async () => {
  const client = await read('public/assets/js/settings_manager.js');
  const server = await read(path.join('backend', 'app.py'));
  assert.match(client, /pocketReaderPushAuthToken/);
  assert.match(client, /crypto\.getRandomValues\(bytes\)/);
  assert.doesNotMatch(client, /Math\.random\(\).*pr-/);
  assert.match(server, /auth_token_hash/);
  assert.match(server, /secrets\.token_urlsafe\(32\)/);
  assert.match(server, /hmac\.compare_digest/);
  assert.match(server, /Push subscription ownership check failed/);
});

test('service-worker install failures reject and smoke targets the active revision', async () => {
  const worker = await read('public/sw.js');
  const smoke = await read(path.join('tools', 'smoke_pocket_worker_runtime.mjs'));
  assert.match(worker, /pocket-reader-core-v141/);
  assert.match(worker, /Install failed:[\s\S]{0,100}throw err;/);
  assert.match(smoke, /\/sw\.js\?v=136/);
  assert.doesNotMatch(smoke, /serviceworker\.js|_\/theme\//);
});

test('permanent cache resolves and loads the selected library story', async () => {
  const library = await read('public/assets/js/library_manager.js');
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(library, /window\.startCaching\('Permanent', storyRef\)/);
  assert.match(buffer, /async function _ensureCachingStory\(storyRef\)/);
  assert.match(buffer, /window\.startCaching = async function\(mode, storyRef = null\)/);
});

test('Cloudflare fallback dialog does not interpolate URL into inline JavaScript', async () => {
  const source = await read('public/assets/js/api_core.js');
  assert.match(source, /id="cloudflare-open-story"/);
  assert.match(source, /addEventListener\('click'/);
  assert.doesNotMatch(source, /onclick="window\.open\('\$\{urlSafe\}/);
});

test('push targets and subscribed AO3 stories use parsed hostname allowlists', async () => {
  const source = await read(path.join('backend', 'app.py'));
  assert.match(source, /def _is_allowed_push_endpoint/);
  assert.match(source, /PUSH_ENDPOINT_HOSTS/);
  assert.match(source, /def _canonical_ao3_work_url/);
  assert.doesNotMatch(source, /if "archiveofourown\.org" not in url/);
});

test('push deletion also removes the owned state snapshot', async () => {
  const source = await read(path.join('backend', 'app.py'));
  assert.match(source, /DELETE FROM user_state WHERE user_id = \?/);
  assert.match(source, /_delete_push_owner_data/);
});

test('upload parsers enforce global PDF, ZIP, EPUB, DOCX/HTML/TXT, and output limits', async () => {
  const core = await read(path.join('backend', 'parsers_core.py'));
  const pdf = await read(path.join('backend', 'parsers_pdf.py'));
  const epub = await read(path.join('backend', 'parsers_epub.py'));
  const doc = await read(path.join('backend', 'parsers_document.py'));
  assert.match(core, /MAX_ZIP_MEMBERS/);
  assert.match(core, /MAX_PARSED_TEXT_CHARS/);
  assert.match(pdf, /MAX_PDF_PAGES/);
  assert.match(pdf, /remaining_chars/);
  assert.match(epub, /MAX_EPUB_SPINE_ITEMS/);
  assert.match(epub, /seen_documents/);
  // DOCX/HTML/TXT must bound extracted text like EPUB/PDF (Finding 5).
  assert.match(doc, /MAX_PARSED_TEXT_CHARS/);
  assert.match(doc, /total_chars > MAX_PARSED_TEXT_CHARS/);
  assert.match(doc, /f\.read\(MAX_PARSED_TEXT_CHARS\)/);
});

test('all remote scraper response paths enforce byte limits and scrape admission control', async () => {
  const scraper = await read(path.join('backend', 'scrapers_core.py'));
  const app = await read(path.join('backend', 'app.py'));
  assert.match(scraper, /_read_limited_response/);
  assert.match(scraper, /MAX_ZYTE_RESPONSE_BYTES/);
  assert.match(scraper, /_assert_public_connected_peer/);
  assert.match(app, /_SCRAPE_CONCURRENCY/);
  assert.match(app, /_check_scrape_rate/);
  assert.match(app, /async def _bounded_httpx_request/);
  assert.match(app, /MAX_ZYTE_FICHUB_RESPONSE_BYTES/);
});

test('generic proxy is read-only, authenticated for non-browser callers, and strips headers', async () => {
  const source = await read(path.join('worker', 'cloudflare_worker.js'));
  assert.match(source, /PROXY_AUTH_TOKEN/);
  assert.match(source, /Only GET and HEAD are supported/);
  assert.match(source, /buildUpstreamHeaders/);
  assert.match(source, /redirect: "manual"/);
  assert.match(source, /isRedirectStatus/);
});

test('dynamic runtime modules are checked against pinned SHA-256 digests', async () => {
  const source = await read('public/assets/js/pocket_worker.js');
  assert.match(source, /PINNED_MODULE_SHA256/);
  assert.match(source, /async function importVerifiedModule/);
  assert.match(source, /crypto\.subtle\.digest\('SHA-256'/);
});

test('release checks validate deploy parity, config entrypoints, and non-writing tool modes', async () => {
  const parity = await read(path.join('tools', 'verify_release_parity.mjs'));
  const cacheTool = await read(path.join('tools', 'pocket_caching_expectations.mjs'));
  const smokeTool = await read(path.join('tools', 'smoke_pocket_worker_runtime.mjs'));
  const webkitPackage = JSON.parse(await read(path.join('tests', 'webkit-smoke', 'package.json')));
  // The anvil-app leg is deleted with Anvil (Phase 5). What the parity tool must
  // still cover is the one place content genuinely exists twice -- backend/
  // versus the Hugging Face checkout -- plus the worker entrypoint.
  assert.match(parity, /'Hugging Face Space'/);
  assert.doesNotMatch(parity, /anvil-app/);
  assert.doesNotMatch(parity, /Anvil Pocket Reader Sync/);
  assert.match(parity, /wrangler\.toml/);
  assert.match(cacheTool, /--check/);
  assert.match(smokeTool, /--no-write/);
  assert.equal(webkitPackage.scripts.test, 'node smoke.mjs');
});
