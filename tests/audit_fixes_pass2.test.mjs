// Regression guards for the second-pass audit fixes.
//
// The theme of this pass is "an operation that never settles": a worker job with
// no terminal message, a token refresh that races itself into a sign-out, a
// sync that runs twice. Each test pins the specific shape that caused it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFile(path.join(ROOT, relative), 'utf8');

// Ordering assertions must look at code, not prose. These fixes are heavily
// commented and the comments quote the very constructs being asserted about, so
// a raw indexOf finds the explanation instead of the statement.
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

test('every accepted narration job is settled exactly once', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const start = worker.indexOf('async function startGeneration(');
  const body = worker.slice(start, worker.indexOf('async function runGenerationPipeline('));
  assert.ok(start > 0, 'startGeneration not found');

  // A single settle helper pair, guarded by a one-shot flag.
  assert.match(body, /let jobSettled = false;/);
  assert.match(body, /const settleWithAudio =/);
  assert.match(body, /const settleWithError =/);

  // The no-audio path must NOT be silent. Previously `if (isGenerating &&
  // allChunks.length > 0)` was the only thing that could post 'complete', so a
  // paragraph whose chunks all tokenized to nothing posted nothing at all and
  // stranded the caller on its 60s/600s timeout.
  assert.doesNotMatch(body, /if \(isGenerating && allChunks\.length > 0\)/);
  assert.match(body, /\} else \{[\s\S]*settleWithError\('This paragraph produced no speakable audio\.'\)/);

  // ...and a backstop in the finally covers any path not enumerated above.
  const finallyBlock = body.slice(body.indexOf('} finally {'));
  assert.match(finallyBlock, /settleWithError\('Generation ended without producing audio\.'\)/);
});

test('a streamed generation failure settles the job rather than posting a bare error', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  // Anchored on a single-line marker: the file is CRLF, so a multi-line needle
  // written with \n would silently miss and slice from -1.
  const handler = worker.slice(worker.indexOf('console.error("Worker error:", err);'));
  assert.match(handler, /data\?\.type === "stream_generate"/,
    'stream_generate must map to generate_error so the id reaches the waiting promise');
  assert.match(handler, /const errorType = data\?\.type === "init" \? "init_error" : \(isGenerateJob \? "generate_error" : "error"\)/);
});

test('cancellation is cooperative and never drops the generation mutex', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /let cancelRequested = false;/);
  assert.match(worker, /function generationShouldContinue\(\)/);

  // isGenerating is the mutual-exclusion flag for the shared ONNX sessions, so
  // only startGeneration may write it. Clearing it from a cancel/stop handler
  // let processGenerationQueue start a second concurrent generation.
  const writes = worker.match(/^\s*isGenerating = (?:true|false);/gm) || [];
  assert.equal(writes.length, 3,
    'isGenerating should only be written by startGeneration (set + finally) and the calibration save/restore');

  for (const handler of ['cancel_generation', 'stop', 'dispose_backend']) {
    const start = worker.indexOf(`type === '${handler}'`) >= 0
      ? worker.indexOf(`type === '${handler}'`)
      : worker.indexOf(`type === "${handler}"`);
    assert.ok(start > 0, `${handler} handler not found`);
    const block = worker.slice(start, start + 900);
    assert.doesNotMatch(block, /isGenerating = false/, `${handler} must not clear the generation mutex`);
    // Queued jobs the handler discards must still be settled.
    assert.match(block, /generate_error/, `${handler} must settle the jobs it drops`);
  }

  // Every generation loop polls the cooperative check.
  assert.ok((worker.match(/generationShouldContinue\(\)/g) || []).length >= 5);
});

test('Supabase token refresh is single-flight', async () => {
  const bridge = await read('public/assets/js/supabase_bridge.js');
  const code = stripComments(bridge);
  assert.match(code, /let refreshInFlight = null;/);
  assert.match(code, /async function refreshSession\(refreshToken\)/);
  assert.equal((code.match(/grant_type=refresh_token/g) || []).length, 1,
    'exactly one place may exchange a refresh token');

  // Both entry points must yield to an exchange already in progress. Asserting
  // the guard exists somewhere in the file is not enough -- refreshSession has
  // its own copy, so a missing guard in accessToken still matched.
  const refresher = code.slice(code.indexOf('async function refreshSession'), code.indexOf('async function accessToken'));
  const getter = code.slice(code.indexOf('async function accessToken'), code.indexOf('async function rest('));
  assert.match(refresher, /if \(refreshInFlight\) return refreshInFlight;/,
    'refreshSession must not start a second exchange');
  assert.match(getter, /if \(refreshInFlight\) return refreshInFlight;/,
    'accessToken must await an in-flight refresh instead of reading a token about to be replaced');
  assert.match(refresher, /refreshInFlight = null;/, 'the in-flight slot must be released in a finally');
});

test('the login modal detaches its Escape handler on every exit path', async () => {
  const bridge = await read('public/assets/js/supabase_bridge.js');
  const form = bridge.slice(bridge.indexOf('function showLoginForm()'), bridge.indexOf('function consumeOAuthFragment'));
  assert.match(form, /const close = \(value\) => \{[\s\S]*document\.removeEventListener\('keydown', onKeyDown\)/);
  // The old handler removed itself only when Escape was the thing pressed, so
  // Cancel / backdrop / success each leaked one live document listener.
  assert.doesNotMatch(form, /function esc\(e\)/);
});

test('consumeOAuthFragment handles OAuth error parameters from hash or search query string', async () => {
  const bridge = await read('public/assets/js/supabase_bridge.js');
  const fn = bridge.slice(bridge.indexOf('function consumeOAuthFragment'), bridge.indexOf('consumeOAuthFragment();'));
  assert.match(fn, /const hasHash = window\.location\.hash && window\.location\.hash\.length >= 2;/);
  assert.match(fn, /const hasSearch = window\.location\.search && window\.location\.search\.length >= 2;/);
  assert.match(fn, /params\.get\('error_description'\) \|\| params\.get\('error'\)/);
  assert.match(fn, /history\.replaceState/);
});

test('cloud sync claims its in-flight slot before the first await', async () => {
  const sync = await read('public/assets/js/sync_core.js');
  const code = stripComments(sync);
  const flush = code.slice(code.indexOf('export async function flushCloudSync'), code.indexOf('window.flushCloudSync'));
  const guardIndex = flush.indexOf('SYNC_STATE.inFlight = (async () => {');
  const outboxRead = flush.indexOf('await loadOutbox()');
  assert.ok(guardIndex > 0, 'flushCloudSync should assign inFlight');
  assert.ok(outboxRead > 0, 'flushCloudSync should read the outbox');
  assert.ok(guardIndex < outboxRead,
    'inFlight must be claimed synchronously; assigning it after an await lets two triggers both start a sync');
});

test('update checks are dispatched by story key, never by title', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  // checkStoryUpdate(storyRef, ...) resolves through findLibraryStoryByRef, which
  // only matches a title when it is unique in the library. Both notification
  // entry points used to pass story.title and silently no-op on a duplicate.
  const calls = ui.match(/checkStoryUpdate\??\.?\(([^,]+),/g) || [];
  assert.ok(calls.length >= 2, 'expected the notification and service-worker call sites');
  for (const call of calls) {
    const firstArg = call.slice(call.indexOf('(') + 1, -1).trim();
    // A trailing `|| story.title` fallback is fine — what matters is that the
    // stable key is tried first rather than the title being the whole argument.
    assert.match(firstArg, /^story\.storyKey\b/, `dispatch by key, not title: ${firstArg}`);
  }
});

test('backups exclude the auth session and per-device identity', async () => {
  const transfer = await read('public/assets/js/data_transfer.js');
  assert.match(transfer, /const EXCLUDED_LOCAL_KEYS = new Set\(/);
  for (const key of [
    'pr_supabase_session_v1',
    'pr_device_id',
    'pr_profile_owner',
    'pr_sync_outbox',
    'pocketReaderPushAuthToken',
    'pocketReaderPushUserId',
    'pocketReaderCookies',
  ]) {
    assert.ok(transfer.includes(`'${key}'`), `${key} must be excluded from backups`);
  }
  // A .prbackup is a file users copy between machines; the session entry holds a
  // live refresh token, so exporting it hands over the account.
  assert.match(transfer, /if \(!isExportableLocalKey\(key\)\) \{ excludedKeys \+= 1; continue; \}/);
  // Enforced on import too, so an older backup cannot re-inject a stale session.
  assert.match(transfer, /if \(!isExportableLocalKey\(key\)\) continue;/);
});

// ── Third pass: the modules that had not been read line-by-line ──────────────

test('bookmarks always union across devices instead of losing the older side', async () => {
  const merge = await read('public/assets/js/profile_merge.js');
  // Indices must be computed on the SAME string that is sliced — stripping
  // comments shifts every offset.
  const code = stripComments(merge);
  const body = code.slice(
    code.indexOf('function mergeStory('),
    code.indexOf('export function mergeProfile('),
  );
  // The bookmarks group must merge unconditionally. Gating it behind the
  // group-stamp comparison discarded the losing device's bookmarks outright,
  // and applyCanonicalProfile then overwrote that device's local copy.
  assert.match(body, /if \(group === 'bookmarks'\) \{[\s\S]*mergeBookmarks\([\s\S]*continue;/);
  assert.doesNotMatch(body, /if \(incomingStamp >= asInt\(cloudSync\[group\], 0, 0\)\) \{\s*if \(group === 'bookmarks'\)/);

  // Behavioural check: two devices, each with a bookmark the other lacks.
  const { mergeProfile } = await import('../public/assets/js/profile_merge.js');
  const story = (bookmarkId, stamp) => ({
    storyKey: 's_1', title: 'T', author: 'A',
    sync: { bookmarks: stamp },
    bookmarks: [{ id: bookmarkId, c: 0, p: 1, updatedAt: stamp }],
  });
  // The incoming side deliberately carries the OLDER stamp — the losing case.
  const merged = mergeProfile(
    { library: [story('cloud-bm', 2000)] },
    { library: [story('local-bm', 1000)] },
    'device-a',
  );
  const ids = merged.library[0].bookmarks.map((b) => b.id).sort();
  assert.deepEqual(ids, ['cloud-bm', 'local-bm'], 'both devices\' bookmarks must survive the merge');
});

test('a disabled companion does not hold the experience queue', async () => {
  const virtue = await read('public/assets/js/virtue_controller.js');
  const speak = virtue.slice(virtue.indexOf('export function virtueSpeak('), virtue.indexOf('export function dismissVirtue('));
  // _showVirtueSpeech no-ops when disabled, but the enqueued run() still parked
  // _waitForVirtueDismiss for the full duration, serialising the whole queue
  // behind narration that was never shown.
  assert.match(speak, /if \(!_isVirtueEnabled\(\)\) return Promise\.resolve\(false\);/);
  const guardIndex = speak.indexOf('_isVirtueEnabled()');
  const enqueueIndex = speak.indexOf('enqueueExperience');
  assert.ok(guardIndex > 0 && guardIndex < enqueueIndex, 'the guard must run before anything is enqueued');
});

test('per-caller rate limits key on the forwarded client, not the proxy', async () => {
  const app = await read('backend/app.py');
  assert.match(app, /def _client_ip\(request: Request\) -> str:/);
  assert.match(app, /cf-connecting-ip/);
  // Behind the Worker every request shares a Cloudflare edge address, so
  // request.client.host turned a per-caller budget into a global one.
  assert.doesNotMatch(app, /client_ip = request\.client\.host if request\.client else "unknown"/);
  assert.match(app, /_check_subscribe_rate\(_client_ip\(request\)\)/);
  // /api/search spends Zyte credit on every cache miss and had no limiter.
  assert.match(app, /_require_scrape_budget\(\s*http_request/);
  const search = app.slice(app.indexOf('@app.post("/api/search")'), app.indexOf('def _withdrawn_hash'));
  const cacheHit = search.indexOf('if cached is not None:');
  const limiter = search.indexOf('_require_scrape_budget');
  assert.ok(cacheHit > 0 && limiter > cacheHit, 'the limiter must run after the cache, so repeats cost no budget');
});

test('an oversized profile prunes derived data instead of failing sync forever', async () => {
  const { normalizeProfile, MAX_PROFILE_BYTES } = await import('../public/assets/js/profile_merge.js');
  const bytes = (o) => new TextEncoder().encode(JSON.stringify(o)).length;
  const pad = 'x'.repeat(200);

  // Oversized purely because of regenerable data. mergeProfile ends by calling
  // normalizeProfile, so throwing here used to mean a library that grew past
  // 1 MB could never sync again -- flushCloudSync just retried the same throw
  // on exponential backoff with no way for the user to recover.
  const bulky = {
    library: [{ storyKey: 's_1', title: 'Keep me', author: 'A', bookmarks: [{ id: 'b1', c: 0, p: 1, updatedAt: 5 }] }],
    collections: [{ id: 'c1', name: 'Favourites' }],
    history: Array.from({ length: 6000 }, (_, i) => ({ id: `h${i}`, title: `T${i}${pad}`, lastAt: 1700000000000 + i })),
    dailyStatsByDevice: {
      dev: Object.fromEntries(Array.from({ length: 900 }, (_, d) => [`2024-${String(d).padStart(4, '0')}`, { totalWords: d, pad }])),
    },
    activityDays: Array.from({ length: 800 }, (_, i) => `2024-01-${i}`),
  };
  assert.ok(bytes(bulky) > MAX_PROFILE_BYTES, 'fixture should start over the cap');

  const out = normalizeProfile(bulky, 'dev');
  assert.ok(bytes(out) <= MAX_PROFILE_BYTES, 'pruning must bring the profile under the cap');
  // User-authored data is never sacrificed to make room.
  assert.equal(out.library.length, 1);
  assert.equal(out.library[0].bookmarks.length, 1);
  assert.equal(out.collections.length, 1);
  // ...but regenerable data is.
  assert.ok(out.history.length < 6000, 'reading history should be trimmed');

  // When the irreducible core alone exceeds the cap, fail loudly and actionably
  // rather than silently deleting bookmarks or library entries.
  const hugeLibrary = {
    library: Array.from({ length: 3000 }, (_, i) => ({
      storyKey: `s_${i}`, title: `Story ${i}${pad}`, author: `Author ${i}`, summary: pad + pad,
    })),
    history: [],
  };
  assert.throws(
    () => normalizeProfile(hugeLibrary, 'dev'),
    /stories still exceed the .* sync limit after pruning/,
    'an irreducible oversized profile must throw with guidance',
  );
});

test('the companion cooldown timer is restarted, not stacked', async () => {
  const virtue = await read('public/assets/js/virtue_controller.js');
  assert.match(virtue, /virtueCooldownTimeout: null,/);
  const show = virtue.slice(virtue.indexOf('function _showVirtueSpeech('), virtue.indexOf('function _waitForVirtueDismiss('));
  // An untracked setTimeout let the FIRST of several overlapping speeches clear
  // the flag, ending the idle cooldown early.
  assert.match(show, /if \(virtueState\.virtueCooldownTimeout\) clearTimeout\(virtueState\.virtueCooldownTimeout\)/);
  assert.match(show, /virtueState\.virtueCooldownTimeout = setTimeout\(/);
});

test('a voice loaded into a retired worker pool is not memoised', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /let _pocketVoiceRegistryGeneration = 0;/);
  // Every teardown invalidates in-flight loads.
  const reset = audio.slice(audio.indexOf('function _resetPocketVoiceRegistry()'), audio.indexOf('function _sameBaseFallbackVoiceIds'));
  assert.match(reset, /_pocketVoiceRegistryGeneration \+= 1;/);
  // The load captures the generation up front and checks it before recording.
  const loader = audio.slice(audio.indexOf('async function ensurePocketVoiceLoaded('), audio.indexOf('async function prefetchPocketVoiceAssets'));
  assert.match(loader, /const registryGeneration = _pocketVoiceRegistryGeneration;/);
  assert.match(loader, /if \(registryGeneration !== _pocketVoiceRegistryGeneration\) \{/);
  const guardIndex = loader.indexOf('registryGeneration !== _pocketVoiceRegistryGeneration');
  const memoIndex = loader.indexOf('_encodedPocketVoices.add(loadedVoice)');
  assert.ok(guardIndex > 0 && guardIndex < memoIndex, 'the staleness check must run before the memo write');
});

test('an unknown achievement time loses to a real one instead of pinning the epoch', async () => {
  const { mergeProfile, normalizeProfile, earlierUnlock } = await import('../public/assets/js/profile_merge.js');

  // unlockedAt 0 means "no timestamp recorded" (legacy string-form
  // achievements). Treating it as a real time made it the earliest possible
  // value under "earliest wins", so once any device contributed a string form
  // the achievement showed as unlocked in 1970 everywhere, permanently.
  assert.equal(earlierUnlock(0, 1700000000000), 1700000000000);
  assert.equal(earlierUnlock(1700000000000, 0), 1700000000000);
  assert.equal(earlierUnlock(2000, 1000), 1000, 'among known times the earliest still wins');
  assert.equal(earlierUnlock(0, 0), 0);

  const legacy = { achievements: ['first_story'] };
  const stamped = { achievements: [{ id: 'first_story', unlockedAt: 1700000000000 }] };
  for (const [a, b, label] of [[legacy, stamped, 'string-first'], [stamped, legacy, 'stamped-first']]) {
    const merged = mergeProfile(a, b, 'dev');
    assert.equal(merged.achievements.length, 1, `${label}: no duplicate`);
    assert.equal(merged.achievements[0].unlockedAt, 1700000000000, `${label}: real time survives`);
  }

  // Both forms inside ONE profile collapse to a single dated entry.
  const deduped = normalizeProfile({ achievements: ['x', { id: 'x', unlockedAt: 5000 }] }, 'dev').achievements;
  assert.deepEqual(deduped, [{ id: 'x', unlockedAt: 5000 }]);

  // sync_core must agree — it maps but previously never deduped.
  const sync = await read('public/assets/js/sync_core.js');
  assert.match(sync, /function dedupeAchievements\(items\)/);
  assert.match(sync, /profile\.achievements = dedupeAchievements\(/);
});

test('skipping backwards survives a chapter with no paragraphs array', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const skip = audio.slice(audio.indexOf('export function skipParagraph('), audio.indexOf('window.skipParagraph ='));
  // The forward branch already guarded; the backward branch dereferenced
  // .paragraphs.length directly and threw. Curated .json stories are returned
  // verbatim by the backend and never pass through normalizeStoryChapters, so
  // the shape is not guaranteed.
  assert.match(skip, /p \+= story\.chapters\[c\]\?\.paragraphs\?\.length \|\| 0;/);
  assert.doesNotMatch(skip, /p \+= story\.chapters\[c\]\.paragraphs\.length;/);
});

test('a blocked IndexedDB open gives up instead of hanging every storage call', async () => {
  const storage = await read('public/assets/js/storage_core.js');
  assert.match(storage, /const DB_BLOCKED_TIMEOUT_MS = \d+;/);
  const init = storage.slice(storage.indexOf('export function initDB()'), storage.indexOf('window.initAudioDB'));
  // initDB's promise is awaited by EVERY storage call, so an onblocked that
  // never settled hung playback and caching rather than degrading to a miss.
  assert.match(init, /request\.onblocked = \(\) => \{[\s\S]*blockedTimerId = setTimeout\(/);
  assert.match(init, /reject\(new Error\('IndexedDB is blocked by another open tab\.'\)\)/);
  // Cleared on both settle paths so a resolved open cannot be rejected later.
  assert.equal((init.match(/clearTimeout\(blockedTimerId\)/g) || []).length, 2);
  // Dropping the cached promise lets the next call retry once the block clears.
  assert.match(init, /blockedTimerId = setTimeout\(\(\) => \{\s*queueMicrotask\(\(\) => \{ dbPromise = null; \}\);/);
});
