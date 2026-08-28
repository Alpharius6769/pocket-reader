// Shape guards for the Pocket Reader runtime audit (23 findings).
// Each assertion pins the defect it replaced so a later refactor cannot
// silently restore the old behavior.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');

test('logout clears site cookies from both storages (H1)', async () => {
  const library = await read('public/assets/js/library_manager.js');
  const reset = library.slice(
    library.indexOf('export async function resetLocalProfile'),
    library.indexOf('window.resetLocalProfile = resetLocalProfile;'),
  );
  assert.match(reset, /sessionStorage\.removeItem\('pocketReaderCookies'\)/);
  assert.match(reset, /localStorage\.removeItem\('pocketReaderCookies'\)/);
  const clearPush = library.slice(
    library.indexOf('async function _clearLocalPushIdentity'),
    library.indexOf('export async function loadLocalData'),
  );
  assert.match(clearPush, /localStorage\.removeItem\('pocketReaderPushAuthToken'\)/);
  assert.match(clearPush, /localStorage\.removeItem\('pocketReaderPushUserId'\)/);
});

test('backups exclude the push token and site cookies (H2)', async () => {
  const transfer = await read('public/assets/js/data_transfer.js');
  assert.match(transfer, /'pocketReaderPushAuthToken'/);
  assert.match(transfer, /'pocketReaderPushUserId'/);
  assert.match(transfer, /'pocketReaderCookies'/);
});

test('Worker /api hop stamps CF-Connecting-IP from the edge header (H3)', async () => {
  const worker = await read('worker/cloudflare_worker.js');
  const apiBlock = worker.slice(
    worker.indexOf('if (url.pathname.startsWith("/api/"))'),
    worker.indexOf('if (request.method !== "GET" && request.method !== "HEAD")'),
  );
  assert.match(apiBlock, /request\.headers\.get\("CF-Connecting-IP"\)/);
  assert.match(apiBlock, /buildUpstreamHeaders\(request, \{ visitorIp \}\)/);
  assert.doesNotMatch(apiBlock, /request\.headers\.get\("X-Forwarded-For"\)/);
});

test('loadStory registers abort before the cache path and restores progress (H4/H5/H6/M1)', async () => {
  const api = await read('public/assets/js/api_core.js');
  const load = api.slice(api.indexOf('export async function loadStory'), api.indexOf('window.loadStory = loadStory;'));
  const abortAt = load.indexOf('const ownAbort = new AbortController()');
  const cacheAt = load.indexOf('_loadStoryChapters');
  assert.ok(abortAt >= 0 && cacheAt > abortAt, 'abort controller must exist before IndexedDB lookup');
  assert.match(load, /if \(ownAbort\._superseded\) return;/);
  assert.match(load, /_restoreProgressFromLibrary\(existingLibEntry\)/);
  assert.match(load, /_adoptExistingLibraryIdentity\(window\.currentStory, existingLibEntry\)/);
  assert.match(load, /await _persistOpenedStory\(\)/);
  assert.match(load, /fetch\(`\$\{window\.HF_API_BASE\}\$\{fetchUrl\}`, \{ signal: ownAbort\.signal \}\)/);
  assert.doesNotMatch(load, /if \(!preventNavigate\) showCloudflareFallback\(\);/);
  assert.match(load, /error\?\.name === 'AbortError'/);
  assert.match(load, /pocketNotify\?/);
  // FicHub's 120s budget must abort the nested controller, not ownAbort, or
  // scrape fallback starts already-aborted and the open fails silently.
  assert.match(load, /const fichubAbort = new AbortController\(\)/);
  assert.match(load, /setTimeout\(\(\) => \{ try \{ fichubAbort\.abort\(\); \} catch \(e\) \{\} \}, 120000\)/);
  assert.doesNotMatch(load, /setTimeout\(\(\) => ownAbort\.abort\(\), 120000\)/);
  assert.match(load, /_fichubDownloadEpub\(epubUrl, resolved\.proxy, fichubAbort\.signal\)/);
});

test('audio ended-with-error pauses playback (H7)', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const ended = audio.slice(audio.indexOf('window.currentAudio.onended'), audio.indexOf('window.currentAudio.onerror'));
  assert.match(ended, /pausePlayback\(\)/);
});

test('library hashes and login merge share profile_merge (M2/M3)', async () => {
  const library = await read('public/assets/js/library_manager.js');
  assert.match(library, /import \{ profileHash, storyKeyFor, mergeClockedMap \} from '\.\/profile_merge\.js\?v=merge-v7'/);
  assert.doesNotMatch(library, /replace\(\/\[\^a-z0-9\]\+\/g/);
  assert.match(library, /function getStoryStableKey\(story\) \{\s*return storyKeyFor\(/);
  const merge = library.slice(
    library.indexOf('if (incoming.settings)'),
    library.indexOf('if (incoming.stats)'),
  );
  assert.match(merge, /mergeClockedMap\(/);
  assert.match(merge, /options\.localSettingsWin/);
});

test('OAuth expiry uses Date.now, not now() (M4)', async () => {
  const bridge = await read('public/assets/js/supabase_bridge.js');
  assert.match(bridge, /Math\.floor\(Date\.now\(\) \/ 1000\) \+ parseInt\(params\.get\('expires_in'/);
  assert.doesNotMatch(bridge, /expires_at: Number\(params\.get\('expires_at'\) \|\| \(now\(\)/);
});

test('diagnostics failure HTML-escapes the error (M5)', async () => {
  const setup = await read('public/assets/js/device_setup.js');
  assert.match(setup, /escapeHtml\(String\(error\?\.message \|\| error\)\)/);
});

test('library bookmarks await loadStory then jump (M6)', async () => {
  const library = await read('public/assets/js/library_manager.js');
  assert.match(library, /export async function openLibraryBookmark/);
  assert.match(library, /window\.openLibraryBookmark\(decodeURIComponent\('/);
  assert.doesNotMatch(library, /setTimeout\(\(\) => \{ if \(typeof window\.jumpToBookmark/);
});

test('history and queue open by storyKey (M7)', async () => {
  const features = await read('public/assets/js/reader_features.js');
  assert.match(features, /loadStory\(\$\{inlineArg\(item\.storyKey \|\| item\.title\)\}\)/);
  assert.match(features, /loadStory\(\$\{inlineArg\(stableKey\(story\) \|\| story\.title \|\| story\.url \|\| ''\)\}\)/);
  assert.doesNotMatch(features, /loadStory\(\$\{inlineArg\(story\.title \|\| story\.url \|\| ''\)\}\)/);
});

test('interrupted cache restore never navigates the reader (M8)', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(buffer, /loadStory\(jobRef, \{ preventNavigate: true \}\)/);
  assert.doesNotMatch(buffer, /preventNavigate: job\.mode === 'Permanent'/);
});

test('expensive backend ingest routes share the scrape budget (M9)', async () => {
  const app = await read('backend/app.py');
  for (const marker of [
    '@app.get("/api/ao3/chapter_count")',
    '@app.get("/api/ao3")',
    '@app.post("/api/upload")',
    '@app.get("/api/fetch-epub")',
    '@app.get("/api/fichub-proxy")',
    '@app.get("/api/library/curated/{filename}")',
    '@app.get("/api/library/curated/{filename}/download")',
  ]) {
    const start = app.indexOf(marker);
    assert.ok(start > 0, `${marker} missing`);
    const next = app.indexOf('\n@app.', start + marker.length);
    const body = app.slice(start, next > start ? next : start + 8000);
    assert.match(body, /_require_scrape_budget\(request\)/, `${marker} must consume scrape budget`);
  }
});

test('push enablement registers the versioned service worker (M10)', async () => {
  const settings = await read('public/assets/js/settings_manager.js');
  assert.match(settings, /NARRATION_SERVICE_WORKER_URL/);
  assert.match(settings, /function narrationRegistrationIsCurrent/);
  const push = settings.slice(settings.indexOf('let swReg = await navigator.serviceWorker.getRegistration()'));
  assert.match(push, /!narrationRegistrationIsCurrent\(swReg\)/);
  assert.match(push, /navigator\.serviceWorker\.register\(swUrl\)/);
});

// Production is a SUBPATH (alpharius6769.github.io/pocket-reader/), so a
// root-absolute '/' addresses the account root, not the app. The precached shell
// is './'; looking it up as '/' missed every time and the offline launch fell
// through to the 503 instead of the cached shell — silently, because the miss is
// swallowed by a `||` fallback.
test('service worker addresses the shell relative to its own scope', async () => {
  const sw = await read('public/sw.js');
  assert.match(sw, /var SHELL_URL = new URL\('\.\/', self\.location\.href\)\.href;/);
  assert.match(sw, /caches\.match\(SHELL_URL\)/, 'offline fallback must look up the precached shell');
  assert.match(sw, /var target = SHELL_URL;/, 'notification clicks must open the app, not the origin root');
  assert.match(
    sw,
    /var NOTIFICATION_ICON = new URL\('assets\/img\/reader%20192\.png', self\.location\.href\)\.href;/,
  );
  assert.doesNotMatch(sw, /caches\.match\('\/'\)/);
  assert.doesNotMatch(sw, /icon: '\/assets\//);
  assert.doesNotMatch(sw, /badge: '\/assets\//);
});

test('reader and library covers only accept http(s) URLs (L1)', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(ui, /function _safeHttpCoverUrl/);
  assert.match(ui, /parsed\.protocol === 'http:' \|\| parsed\.protocol === 'https:'/);
  assert.match(ui, /const coverSrc = _safeHttpCoverUrl\(storyObj\.coverImage\)/);
  const library = await read('public/assets/js/library_manager.js');
  assert.match(library, /function _safeHttpCoverUrl/);
  assert.match(library, /const coverSrc = _safeHttpCoverUrl\(story\.coverImage \|\| story\.coverUrl \|\| ''\)/);
  assert.doesNotMatch(library, /const cover = story\.coverImage \|\| story\.coverUrl \|\| ''/);
  for (const source of [ui, library]) {
    const helper = source.slice(
      source.indexOf('function _safeHttpCoverUrl'),
      source.indexOf('function _safeHttpCoverUrl') + 450,
    );
    assert.match(helper, /if \(!raw\) return '';/);
    assert.doesNotMatch(helper, /new URL\(String\(value \|\| ''\), window\.location\.href\)/);
  }
});

test('admin secrets compare in constant time and health omits paths (L2/L3)', async () => {
  const app = await read('backend/app.py');
  assert.match(app, /def _admin_authorized\(provided: Optional\[str\]\) -> bool:/);
  assert.match(app, /hmac\.compare_digest\(token, secret\)/);
  assert.doesNotMatch(app, /x_admin_secret != ADMIN_PUSH_SECRET/);
  const health = app.slice(app.indexOf('@app.get("/api/health")'), app.indexOf('@app.get("/api/diag/logs")'));
  assert.doesNotMatch(health, /database_path/);
  assert.doesNotMatch(health, /allowed_origins/);
  assert.match(health, /database_durable/);
});

test('backend deploy ships curated PDFs and accepts either proxy token name (L4/L5)', async () => {
  const workflow = await read('.github/workflows/deploy-backend.yml');
  assert.match(workflow, /lfs: true/);
  assert.doesNotMatch(workflow, /--exclude='curated_library\/'/);
  assert.doesNotMatch(workflow, /--exclude='README.md'/);
  const spaceReadme = await read('backend/README.md');
  assert.match(spaceReadme, /^---\r?\n[\s\S]*^sdk: docker\r?\n[\s\S]*^---/m);
  assert.match(spaceReadme, /app_port: 7860/);
  assert.doesNotMatch(spaceReadme, /^sdk: gradio/m);
  const scraper = await read('backend/scrapers_core.py');
  assert.match(scraper, /os\.environ\.get\("WORKER_PROXY_TOKEN"\) or os\.environ\.get\("PROXY_AUTH_TOKEN"\)/);
  const worker = await read('worker/cloudflare_worker.js');
  assert.match(worker, /env\.PROXY_AUTH_TOKEN \|\| env\.WORKER_PROXY_TOKEN/);
});
