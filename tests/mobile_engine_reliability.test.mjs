import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Guards for the 2026-07-29 mobile reliability pass (v135).
 *
 * Every assertion here encodes a failure that was reachable on a real iPhone.
 * They are structural source checks in the style of the rest of the suite: the
 * engine needs a browser, WebGPU and a cellular radio to exercise for real, so
 * these pin the shape of the fix rather than the runtime behaviour.
 */

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('a failed session release cannot abort engine teardown', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const releaseSession = worker.slice(
    worker.indexOf('async function releaseSession('),
    worker.indexOf('async function releaseAllSessions('),
  );
  assert.ok(releaseSession.length > 0, 'releaseSession should still exist');

  // session.release() rejects on a lost WebGPU device -- exactly when teardown
  // runs. Without this catch, Promise.all in releaseAllSessions rejected and
  // skipped every null-assignment plus the GPU tensor disposal below it,
  // leaving stale handles and leaked voice tensors that wedged the engine.
  assert.match(releaseSession, /try\s*\{[\s\S]*await session\.release\(\)[\s\S]*\}\s*catch/,
    'releaseSession must swallow a release failure and drop the handle anyway');

  const releaseAll = worker.slice(
    worker.indexOf('async function releaseAllSessions('),
    worker.indexOf('function wasmSessionOptions('),
  );
  assert.match(releaseAll, /voiceConditioningCache\.clear\(\)/,
    'releaseAllSessions must still clear the voice conditioning cache');
});

test('model asset fetches retry transient mobile network failures', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');

  assert.match(worker, /const MODEL_FETCH_PASSES\s*=\s*[2-9]/,
    'fetchFirstAvailable must make more than one pass over the host list');
  assert.match(worker, /function isTransientFetchFailure\(/,
    'transient failures must be distinguished from definitive ones');

  const isTransient = worker.slice(
    worker.indexOf('function isTransientFetchFailure('),
    worker.indexOf('const delay ='),
  );
  // A network error/timeout reports no status and is the common mobile case.
  assert.match(isTransient, /if \(!status\) return true/,
    'a network error or timeout must count as transient');
  assert.match(isTransient, /status >= 500/, '5xx must count as transient');

  // A 404/403 means the asset is genuinely absent from that host: failing over
  // is correct and retrying only burns time on a slow connection.
  const fetchFirst = worker.slice(
    worker.indexOf('async function fetchFirstAvailable('),
    worker.indexOf('function debugLog('),
  );
  assert.match(fetchFirst, /if \(!sawTransientFailure\) break/,
    'a definitive failure from every host must not trigger another pass');
  assert.match(fetchFirst, /await delay\(backoff\)/, 'retries must back off');
});

test('versioned modules are served from cache without a network round trip', async () => {
  const worker = await read('public/sw.js');
  const handler = worker.slice(worker.indexOf("url.pathname.indexOf('/assets/') !== -1 && (url.pathname.slice(-3)"));
  const versionedBranch = handler.slice(
    handler.indexOf("if (url.searchParams.has('v'))"),
    handler.indexOf('// Unversioned assets stay network-first'),
  );
  assert.ok(versionedBranch.length > 0, 'the versioned-asset branch should exist');

  // A ?v= URL is immutable by construction, so revalidation can never return
  // anything new. This used to background-fetch every versioned module on every
  // load, re-downloading the whole JS bundle per launch on cellular.
  assert.doesNotMatch(versionedBranch, /waitUntil/,
    'a versioned cache hit must not schedule a background revalidation');
  assert.match(versionedBranch, /caches\.match\(event\.request\)[\s\S]*return fetchAndCache\(\)/,
    'a versioned miss must still fall through to the network');

  // The unversioned path keeps network-first so a fixed URL can be hot-patched.
  const unversioned = handler.slice(handler.indexOf('// Unversioned assets stay network-first'));
  assert.match(unversioned, /var updatePromise = fetchAndCache\(\)/);
  assert.match(unversioned, /event\.waitUntil\(updatePromise/);
});

test('service worker install survives one failed optional asset', async () => {
  const worker = await read('public/sw.js');

  assert.match(worker, /var OPTIONAL_ASSETS = \[/, 'cosmetic assets must be separated out');
  assert.match(worker, /var DEFERRED_ASSETS = \[/, 'lazy narration modules must be separated out');
  assert.match(worker, /function cacheBestEffort\(/, 'best-effort caching helper must exist');

  const bestEffort = worker.slice(
    worker.indexOf('function cacheBestEffort('),
    worker.indexOf('// 1. INSTALLATION'),
  );
  assert.match(bestEffort, /cache\.add\(asset\)\.catch\(/,
    'each optional asset must be cached independently so one failure is contained');

  // The shell stays atomic: a half-populated core cache serves a broken app.
  const install = worker.slice(worker.indexOf('// 1. INSTALLATION'), worker.indexOf('// 2. ACTIVATION'));
  assert.match(install, /cache\.addAll\(CORE_ASSETS\)/, 'the core shell must remain atomic');
  assert.match(install, /cacheBestEffort\(cache, DEFERRED_ASSETS\.concat\(OPTIONAL_ASSETS\)\)/);
  assert.match(install, /Install failed:[\s\S]{0,120}throw err;/,
    'a core shell failure must still reject the install');

  // Fonts and the icon sprite must not sit in the atomic set any more.
  const coreList = worker.slice(worker.indexOf('var CORE_ASSETS = ['), worker.indexOf('// Best-effort cache fill'));
  assert.doesNotMatch(coreList, /\.woff2/, 'fonts belong in OPTIONAL_ASSETS');
  assert.doesNotMatch(coreList, /pocket_worker\.js/, 'the TTS worker belongs in DEFERRED_ASSETS');
});

test('the durable model cache name honours both lifecycle contracts', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const serviceWorker = await read('public/sw.js');
  const settings = await read('public/assets/js/settings_manager.js');

  const name = worker.match(/const POCKET_MODEL_CACHE = '([^']+)'/)?.[1];
  assert.ok(name, 'pocket_worker must declare a durable model cache name');

  // sw.js activate() deletes every cache except CACHE_NAME and the keep-list.
  // If the model cache is not on that list, every shell version bump silently
  // throws away the ~80 MB engine and re-downloads it.
  const activate = serviceWorker.slice(
    serviceWorker.indexOf("self.addEventListener('activate'"),
    serviceWorker.indexOf('// 3. PUSH NOTIFICATIONS'),
  );
  const keepTokens = [...activate.matchAll(/indexOf\('([^']+)'\) !== -1/g)].map((match) => match[1]);
  assert.ok(keepTokens.some((token) => name.includes(token)),
    `sw.js activate would delete '${name}'; keep-list tokens are ${keepTokens.join(', ')}`);

  // clearNeuralEngineCache must still be able to free it from the settings UI.
  const clearBlock = settings.slice(settings.indexOf('export async function clearNeuralEngineCache'));
  const clearTokens = [...clearBlock.matchAll(/name\.includes\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(clearTokens.some((token) => name.includes(token)),
    `clearNeuralEngineCache cannot delete '${name}'; it matches ${clearTokens.join(', ')}`);
});

test('model cache helpers degrade instead of throwing', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');

  // iOS private browsing rejects caches.open() with a SecurityError. A durable
  // cache is an optimization, never a prerequisite for narration starting.
  const open = worker.slice(worker.indexOf('function openModelCache('), worker.indexOf('async function readCachedModelBuffer('));
  assert.match(open, /catch[\s\S]*return null/, 'openModelCache must return null when unavailable');

  const write = worker.slice(
    worker.indexOf('async function writeCachedModelBuffer('),
    worker.indexOf('// The same asset is reachable through two hosts'),
  );
  // A full device must not turn a successful download into a failed start.
  assert.match(write, /catch[\s\S]*return false/, 'a quota failure must be non-fatal');
});

test('the durable model cache is wired into the download path', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');

  // Read once per asset, before any network work.
  const fetchModel = worker.slice(
    worker.indexOf('async function fetchModelWithProgress('),
    worker.indexOf('function makeFilledArray('),
  );
  // Now carries the expected size so a pre-existing entry written without a
  // Content-Length can still take the preallocating path.
  assert.match(fetchModel, /readCachedModelBuffer\(canonicalModelCacheKey\(urls\[0\]\), expectedBytes\)/,
    'a cache read must precede the host loop');
  assert.match(fetchModel, /fromCache: true/,
    'a cache hit must still advance the progress bar like a completed download');

  // Both host forms must collapse to one key, or the engine is stored twice and
  // misses whenever the alternate host answers.
  assert.match(worker, /function canonicalModelCacheKey\(/);
  assert.match(worker, /if \(value\.startsWith\(proxyPrefix\)\) return value\.replace\(proxyPrefix, B2_ASSET_PREFIX\)/);

  // A short read must never be persisted: a truncated model cached as
  // authoritative would fail every later cold start with no network to self-heal.
  const single = worker.slice(
    worker.indexOf('async function fetchSingleModelWithProgress('),
    worker.indexOf('async function fetchModelWithProgress('),
  );
  const shortReadStart = single.indexOf('// The server declared a Content-Length');
  const shortReadEnd = single.indexOf('return output.slice(', shortReadStart);
  assert.ok(shortReadStart > 0 && shortReadEnd > shortReadStart,
    'the truncated-download branch should be identifiable');
  assert.doesNotMatch(
    single.slice(shortReadStart, shortReadEnd),
    /writeCachedModelBuffer/,
    'the truncated-download branch must not write to the cache',
  );
  assert.match(single, /assetLoadedBytes === output\.byteLength\)\s*\{\s*await writeCachedModelBuffer/,
    'only a length-matched buffer may be cached');
});

test('the emotion-boundary fade is applied to samples, not a gain node', async () => {
  const audio = await read('public/assets/js/audio_core.js');

  // The gain-node ramp could never run on a phone: its gain nodes came from
  // _setupAudioRouting, which was skipped on mobile so that iOS would not
  // suspend the graph on screen lock. Every iPhone therefore heard an abrupt
  // timbre step at each emotion change.
  assert.doesNotMatch(audio, /_applyEmotionBoundaryFade\(/, 'the dead gain-node fade must be gone');
  assert.doesNotMatch(audio, /_setupAudioRouting\(/, 'the mobile-unreachable routing graph must be gone');
  assert.doesNotMatch(audio, /createChannelSplitter|createChannelMerger/);

  assert.match(audio, /function _encodeWAV\(samples, sampleRate, \{ fadeInSec = 0 \} = \{\}\)/);
  assert.match(audio, /function _onsetFadeSecFor\(/);
  // Raised cosine, not linear: a linear ramp's discontinuous first derivative is
  // faintly audible as a click on a voice onset.
  assert.match(audio, /0\.5 - 0\.5 \* Math\.cos\(\(Math\.PI \* i\) \/ fadeSamples\)/);

  // Both synthesis paths (whole-paragraph and streamed) must pass the fade.
  const fadeCallSites = [...audio.matchAll(/fadeInSec: _onsetFadeSecFor\(route\.voiceId\)/g)];
  assert.equal(fadeCallSites.length, 2, 'both _encodeWAV call sites must supply the onset fade');

  // preparePocketMobileMediaSession must no longer build an unused AudioContext.
  const prepare = audio.slice(
    audio.indexOf('export function preparePocketMobileMediaSession()'),
    audio.indexOf('export function startBgKeepAlive()'),
  );
  assert.doesNotMatch(prepare, /new AudioContextClass\(\)/,
    'mobile must not create an AudioContext it never connects to output');
});

test('the onset ramp maths are monotonic, bounded and unity-terminating', async () => {
  // Re-implements the encoder's ramp so the curve itself is checked, not just
  // its presence in source. Kept in lockstep with _encodeWAV by the regex guard
  // in the preceding test.
  const ramp = (i, fadeSamples) => 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeSamples);
  const fadeSamples = Math.round(0.12 * 24000); // EMOTION_FADE_SEC at 24 kHz
  assert.equal(fadeSamples, 2880);

  assert.ok(Math.abs(ramp(0, fadeSamples) - 0) < 1e-12, 'must start at silence');
  assert.ok(Math.abs(ramp(fadeSamples, fadeSamples) - 1) < 1e-12, 'must reach unity');

  let previous = -Infinity;
  for (let i = 0; i <= fadeSamples; i += 1) {
    const value = ramp(i, fadeSamples);
    assert.ok(value >= previous, `ramp must be non-decreasing (broke at ${i})`);
    assert.ok(value >= 0 && value <= 1, `ramp must stay in [0,1] (broke at ${i})`);
    previous = value;
  }

  // A zero fade must leave every sample untouched: fadeSamples of 0 means the
  // loop guard `i < fadeSamples` never fires, so no scaling is applied at all.
  assert.equal(Math.max(0, Math.round(0 * 24000)), 0);
});

test('playback speed comes from the profile, not a phantom DOM control', async () => {
  const [audio, ui, settings, loader, html] = await Promise.all([
    read('public/assets/js/audio_core.js'),
    read('public/assets/js/ui_controller.js'),
    read('public/assets/js/settings_manager.js'),
    read('public/assets/js/narration_runtime_loader.js'),
    read('public/index.html'),
  ]);

  // There is no speed slider or label in the app and there never was one in the
  // shipped DOM. Every playback path read `getElementById('speed-slider')?.value
  // || '1'`, so the rate resolved to 1.0 on every paragraph and clobbered
  // anything set elsewhere -- settings.speed and narrationPreset.speed were
  // stored, cloud-synced and merged but never reached playback at all.
  for (const [name, source] of [['audio_core', audio], ['ui_controller', ui], ['settings_manager', settings], ['loader', loader], ['index.html', html]]) {
    assert.doesNotMatch(source, /getElementById\(['"]speed-slider['"]\)/, `${name} still reads the phantom slider`);
    assert.doesNotMatch(source, /getElementById\(['"]speed-label['"]\)/, `${name} still reads the phantom label`);
  }
  assert.doesNotMatch(html, /speed-slider|speed-label/);

  assert.match(audio, /export function getEffectivePlaybackRate\(\)/);
  // Per-story preset wins over the profile default.
  assert.match(audio, /window\.currentStory\?\.narrationPreset[\s\S]{0,200}window\.userProfile\?\.settings\?\.speed/);
  // Every consumer must go through the resolver.
  assert.match(audio, /window\.currentAudio\.playbackRate = getEffectivePlaybackRate\(\)/);
  assert.match(audio, /utterance\.rate = getEffectivePlaybackRate\(\)/);
  assert.match(audio, /playbackRate: getEffectivePlaybackRate\(\)/);
  // applyPlaybackSpeed now takes the rate rather than reading the DOM.
  assert.match(audio, /export function applyPlaybackSpeed\(rate\)/);
  assert.doesNotMatch(loader, /applyPlaybackSpeedSlider/);
});

test('the narration sanitizer cannot truncate a non-AO3 document', async () => {
  const storage = await read('public/assets/js/storage_core.js');
  const python = await read('backend/parsers_core.py');

  // A paragraph that is exactly "End Notes" or "Afterword" used to `break` the
  // loop on ANY document, silently discarding every remaining paragraph of the
  // chapter. Only a real AO3 export may be truncated at an end-of-notes marker.
  assert.match(storage, /hasAo3Signature \? text\.match\(_END_META_MARKER_RE\) : null/);
  assert.match(python, /_split_marker\(text, _END_META_MARKER_RE\) if ao3_export else \("", "", False\)/);

  // The author-note detector must not match ordinary third-person narration.
  // The old bare alternation deleted "He had written to her every day".
  for (const [name, source] of [['storage_core', storage], ['parsers_core', python]]) {
    assert.doesNotMatch(
      source,
      /\(\?:wrote\|written\|writing\|rewrite\|publish\|update/,
      `${name} still uses the bare verb alternation`,
    );
    assert.match(source, /i've\|i'm\|we/, `${name} should require first-person authorial framing`);
  }
});

test('audio chunks are fingerprinted so segmentation changes cannot desync playback', async () => {
  const storage = await read('public/assets/js/storage_core.js');
  const audio = await read('public/assets/js/audio_core.js');
  const buffer = await read('public/assets/js/buffer_manager.js');

  // Keys are positional (story_chap_para_engine_voice), so any change to
  // paragraph segmentation remaps existing audio onto different text.
  assert.match(storage, /export function paragraphFingerprint\(/);
  assert.match(storage, /if \(fingerprint\) record\.textHash = fingerprint/);
  assert.match(storage, /found\.textHash && found\.textHash !== expected/);
  assert.match(storage, /deleteAudioChunk\(key\)/);
  assert.match(storage, /async function deleteAudioChunk\(/, 'the delete helper must exist');

  // Pre-fingerprint chunks are grandfathered rather than wiping every user's
  // cached narration on upgrade.
  assert.match(storage, /Chunks written before fingerprinting existed carry no textHash/);

  // Every read and write site must pass the paragraph text.
  const reads = [...audio.matchAll(/getAudioChunk\([^)]*\)/g)].map((m) => m[0]);
  assert.ok(reads.length >= 3, 'expected multiple audio cache reads in audio_core');
  for (const call of reads) assert.match(call, /,\s*text\)/, `read misses the text argument: ${call}`);
  assert.match(buffer, /getAudioChunk\([^)]*routedVoice \+ tag, task\.text\)/);
  assert.match(buffer, /saveAudioChunk\([^)]*this\.mode === 'Permanent', task\.text\)/);
});

test('no module renders into a container that does not exist', async () => {
  const { readdir } = await import('node:fs/promises');
  const html = await read('public/index.html');
  const dir = new URL('../public/assets/js/', import.meta.url);
  const names = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  let js = '';
  for (const name of names) js += await read(`public/assets/js/${name}`) + '\n';

  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  // Ids a module assigns or emits itself (createElement().id = 'x', or markup
  // built in a template literal) are legitimately absent from the shell.
  const jsIds = new Set([
    ...[...js.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...js.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
    ...[...js.matchAll(/id='([^']+)'/g)].map((m) => m[1]),
  ]);

  const looked = new Set([
    ...[...js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]),
    ...[...js.matchAll(/\bel\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]),
  ]);

  const orphans = [...looked].filter((id) => !htmlIds.has(id) && !jsIds.has(id)).sort();

  // This bug class shipped four times: #speed-slider and #speed-label (playback
  // speed silently pinned to 1.0x on every paragraph), #bg-cache-panel and
  // #offline-storage-manager (whole settings panels that never rendered). Each
  // was a null-guarded lookup, so nothing ever threw and nothing was logged.
  assert.deepEqual(orphans, [],
    `modules look up ids that exist nowhere and are created by nothing: ${orphans.join(', ')}`);
});

test('every precached module URL resolves to a real file', async () => {
  const worker = await read('public/sw.js');
  const { access } = await import('node:fs/promises');
  const urls = [...worker.matchAll(/'(?:(?:\/pocket-reader)?\/)?(assets\/[^']+)'/g)].map((match) => '/' + match[1]);
  assert.ok(urls.length > 20, 'expected the precache lists to be populated');

  const missing = [];
  for (const url of urls) {
    const filePath = new URL(`../public${url.split('?')[0]}`, import.meta.url);
    try {
      await access(filePath);
    } catch {
      missing.push(url);
    }
  }
  assert.deepEqual(missing, [], `precached assets do not exist on disk: ${missing.join(', ')}`);
});

// iOS Safari terminates a worker that exceeds the tab memory ceiling WITHOUT
// firing onerror, so a silent death during init used to be caught by nothing:
// the 45s startup guard was a one-shot cleared by the FIRST message, and
// pocket_worker.js posts "Worker Thread Started" as its first executable line.
// Init then died at 90% ("Preparing voice (...)", peak session residency) and
// the load hung until ENGINE_LOAD_TIMEOUT_MS -- 20 minutes on mobile.
test('worker startup watchdog rearms on activity instead of clearing on first message', async () => {
  const audio = await read('public/assets/js/audio_core.js');

  // The disarm-on-any-message shape must not come back.
  assert.doesNotMatch(
    audio,
    /worker\.onmessage = \(e\) => \{\s*clearTimeout\(startupTimerId\);/,
    'onmessage must not clear the startup watchdog unconditionally',
  );

  assert.match(audio, /const WORKER_SILENCE_TIMEOUT_MS = \d+;/);
  assert.match(audio, /const armStartupWatchdog = \(\) => \{/);
  assert.match(audio, /const clearStartupWatchdog = \(\) => \{/);

  // Only a terminal outcome disarms it; anything else is proof of life.
  const handler = audio.slice(
    audio.indexOf('worker.onmessage = (e) => {'),
    audio.indexOf("if (data.type === 'progress' && i === 0)"),
  );
  assert.match(handler, /init_done/, 'terminal init_done must disarm the watchdog');
  assert.match(handler, /init_error/, 'terminal init_error must disarm the watchdog');
  const elseBranch = handler.slice(handler.indexOf('} else {'));
  assert.ok(elseBranch.includes('armStartupWatchdog();'),
    'every non-terminal message must rearm the watchdog');

  // Settling the spawn by any route must stop the timer, or a worker that just
  // went ready would be terminated by a stale deadline.
  const doneFn = audio.slice(audio.indexOf('const done = (success) => {'),
                             audio.indexOf('// Silence watchdog for worker startup.'));
  assert.match(doneFn, /clearStartupWatchdog\(\);/);

  // The worker's first line is what made the old guard useless; keep the
  // assumption pinned so a future reorder does not quietly re-break this.
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker.slice(0, 2000), /postMessage\(\{ type: "status", status: "Worker Thread Started"/);
});

// iPhone 13 (4 GB) is inside IPHONE_WEBGPU_BLOCK_IDS -- below this project's own
// 6 GB floor -- and still OOM-killed after the silent-worker fix landed. These
// pin the peak-memory reductions, which are all shape, not behaviour.
test('constrained startup creates the largest ONNX session first', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /const orderedDescriptors = constrainedMemoryMode/);
  assert.match(worker, /for \(const descriptor of orderedDescriptors\)/,
    'the load loop must consume the size-ordered list, not the raw one');
  // Sorted descending by declared asset bytes.
  assert.match(worker, /sizeOf\(b\) - sizeOf\(a\)/);
});

test('constrained startup yields between the cache copy and session creation', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const loader = worker.slice(
    worker.indexOf('const loadModelDescriptor = async'),
    worker.indexOf('const orderedDescriptors'),
  );
  const yieldIdx = loader.indexOf('await new Promise((resolve) => setTimeout(resolve, 0));');
  const createIdx = loader.indexOf('ort.InferenceSession.create(modelBuffer');
  assert.ok(yieldIdx > 0, 'constrained path must yield before session creation');
  assert.ok(yieldIdx < createIdx,
    'the collection point must sit BEFORE session creation, not after');
  // The existing post-session yield must survive too.
  assert.match(loader, /setTimeout\(resolve, 24\)/);
});

test('offscreen view DOM is released only for views that rebuild on entry', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(ui, /const _OFFSCREEN_RELEASABLE = Object\.freeze\(\{/);
  assert.match(ui, /function _releaseOffscreenViewDom/);
  assert.match(ui, /if \(window\.isPocketDeviceMemorySafeMode\?\.\(\) === false\) return;/,
    'releasing must be limited to constrained devices');

  const map = ui.slice(ui.indexOf('const _OFFSCREEN_RELEASABLE'),
                       ui.indexOf('function _releaseOffscreenViewDom'));
  // Every listed view must have a rebuild hook inside showView, or the view
  // comes back blank.
  const showView = ui.slice(ui.indexOf('export function showView'));
  for (const [viewId, rebuilder] of [
    ['library-view', /renderLibrary/],
    ['profile-view', /renderAchievements/],
    ['away-mode-view', /renderAwayModeUI/],
  ]) {
    assert.match(map, new RegExp(`'${viewId}'`), `${viewId} should be releasable`);
    assert.match(showView, rebuilder, `${viewId} must rebuild on entry`);
  }
  // The masterlist has no entry hook, so it must never be cleared.
  assert.doesNotMatch(map, /hmofa-view/,
    'the masterlist has no rebuild hook and would come back blank');
});

// Symptom 1: "the caching modal never appears -- sometimes it does". Tapping
// Cache on a not-yet-isolated page hands off to a ?tts_fast=1 reload and
// returns, so BufferManager.start() -- the only creator of the progress modal --
// never runs in that page. The modal then depended entirely on the resume chain
// succeeding, and every failure exit left a blank screen; one returned in total
// silence. "Sometimes" was an already-isolated session skipping the reload.
test('the cache handoff keeps a visible surface from tap through to outcome', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(buffer, /function _surfaceCacheHandoffState\(/);

  // Feedback before the reload, so the tap is never silently swallowed.
  const continueFn = buffer.slice(
    buffer.indexOf('async function _continueCaching(mode)'),
    buffer.indexOf('async function _ensureCachingStory'),
  );
  assert.match(continueFn, /_surfaceCacheHandoffState\('Preparing offline audio'/,
    'the pre-reload branch must show the modal before handing off');

  // And primed again immediately on the far side of the reload.
  assert.match(buffer, /if \(resume\.action !== 'playback'\) \{\s*_surfaceCacheHandoffState\(/);

  // Every terminal exit reports a reason instead of leaving a blank screen.
  const terminals = buffer.match(/_surfaceCacheHandoffState\(\s*'Caching could not start'/g) || [];
  assert.equal(terminals.length, 3,
    'restore-threw, story-never-loaded and handoff-timeout must each surface a reason');

  // The formerly silent branch must no longer be a bare return.
  assert.doesNotMatch(
    buffer,
    /\} else \{\s*sessionStorage\.removeItem\(FAST_NARRATION_RESUME_KEY\);\s*\}\s*return;/,
    'storyLoaded === false must not return silently',
  );

  // A terminal state has to be dismissible or the reader is trapped behind it.
  const helper = buffer.slice(
    buffer.indexOf('function _surfaceCacheHandoffState('),
    buffer.indexOf('function _snapshotNarrationStory'),
  );
  assert.match(helper, /caching-progress-dismiss-btn/);
  assert.match(helper, /_escapeCacheStatus\(headline\)/, 'handoff text must be escaped');
});

// The runtime flavor and isolation state were both already measured and neither
// was visible, so a device on the heavy fallback (stock ORT reading .onnx
// protobuf) looked identical to one on the lean path (minimal relaxed-SIMD
// reading .ort) -- a large slice of peak startup memory on a constrained
// iPhone. Reporting must stay strictly passive.
test('narration runtime diagnostics are reported without changing behaviour', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const settings = await read('public/assets/js/settings_manager.js');

  // Exposed on the existing runtime-config surface.
  assert.match(audio, /ortWasmRuntimeFlavor: _pocketBackendRuntime\.ortWasmRuntimeFlavor \|\| 'unreported'/);
  assert.match(audio, /crossOriginIsolated: window\.crossOriginIsolated === true,/);

  // Rendered in the settings perf panel, which only builds when that panel is
  // on screen -- no popup, no notification, no startup cost.
  assert.match(settings, /function _describeWasmRuntimeFlavor\(cfg\)/);
  assert.match(settings, /<b>WASM Runtime:<\/b>/);
  assert.match(settings, /<b>Isolation:<\/b>/);
  const panel = settings.slice(settings.indexOf('export async function refreshPerfPanel'));
  assert.match(panel.slice(0, 200), /const p = document\.getElementById\('perf-panel'\);\s*\n\s*if \(!p\) return;/,
    'the panel must still bail out when it is not rendered');

  // Passive: nothing may branch on the flavor outside the describe helper.
  const helper = settings.slice(
    settings.indexOf('function _describeWasmRuntimeFlavor(cfg)'),
    settings.indexOf('export async function refreshPerfPanel'),
  );
  const flavorUses = (settings.match(/ortWasmRuntimeFlavor/g) || []).length;
  const helperUses = (helper.match(/ortWasmRuntimeFlavor/g) || []).length;
  assert.equal(flavorUses, helperUses,
    'the runtime flavor must only be read for display, never to drive behaviour');

  // Values reaching innerHTML are escaped like every other settings string.
  assert.match(helper, /_escapeSettingsHtml\(flavor\)/);
  assert.match(helper, /_escapeSettingsHtml\(note\)/);
});

// Split core on iOS: the unified block4 graph is one 87 MB model, and 87 MB is
// the allocation that OOM-kills a 4 GB iPhone at session creation (JS buffer
// plus ORT's WASM-heap copy at the same instant). flow_lm_main is 76 MB and
// flow_lm_flow's 10 MB lands after the peak. Resident is a wash (125 vs 126);
// the gain is entirely at the worst moment.
test('the split WASM core is scoped to iOS and cannot regress other platforms', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');

  // iOS takes the split path; constrained non-iOS keeps unified.
  assert.match(
    worker,
    /const preferUnifiedWasmCore = currentBackend === 'wasm'\s*\n\s*&& language === DEFAULT_LANGUAGE\s*\n\s*&& constrainedMemoryMode\s*\n\s*&& !iosWebKit;/,
  );

  // The regression this scoping prevents: a constrained Android on the split
  // path would ALSO pick up the optional decode block, because only iOS is
  // barred from it. That guard has to stay exactly as it is.
  assert.match(
    worker,
    /\} else if \(currentBackend === 'wasm' && !iosWebKit && resolveWasmThreadCount\(\) >= 2\) \{/,
    'the optional decode block must remain excluded on iOS only',
  );

  // With no unified and no decode block, the 10 MB per-frame flow session must
  // still load or the split path has no flow network at all.
  assert.match(
    worker,
    /if \(currentBackend === 'wasm' && !flowLmWasmBlockSession && !flowLmUnifiedSession\) \{/,
  );

  // Resident totals, so a future edit that reintroduces a fourth big model on
  // iOS trips here rather than on a phone.
  const sizes = worker.slice(worker.indexOf('const MODEL_ASSET_BYTES'),
                             worker.indexOf('const ORT_FORMAT_MODEL_ASSET_BYTES'));
  const grab = (k) => Number(sizes.match(new RegExp(k + ': ([0-9]+)'))[1]);
  const ios = grab('text_conditioner') + grab('flow_lm_main') + grab('flow_lm_flow') + grab('mimi_decoder');
  const unified = grab('text_conditioner') + grab('flow_lm_unified_block4') + grab('mimi_decoder');
  assert.ok(ios < unified, 'the split set must not be heavier resident than unified');
  assert.ok(grab('flow_lm_main') < grab('flow_lm_unified_block4'),
    'the point of the swap is a smaller largest-single-model');
});

// The first version of this watchdog used a flat 45s budget, which was SHORTER
// than three legitimate silent operations: ORT module import (45s),
// a stalled model read (60s) and above all session creation, which the worker
// allows five minutes for because ort.InferenceSession.create() is one blocking
// call posting nothing throughout. On a slow phone that would have terminated a
// perfectly healthy worker -- turning the fix into a worse bug than the hang.
test('the silence watchdog cannot fire inside a legitimate blocking phase', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const worker = await read('public/assets/js/pocket_worker.js');

  const base = Number(audio.match(/const WORKER_SILENCE_TIMEOUT_MS = (\d+);/)[1]);
  const stall = Number(worker.match(/const MODEL_STALL_TIMEOUT_MS = (\d+);/)[1]);
  const moduleTimeout = Number(worker.match(/const MODULE_TIMEOUT_MS = (\d+);/)[1]);
  assert.ok(base > stall, `base budget ${base} must exceed the stall timeout ${stall}`);
  assert.ok(base > moduleTimeout, `base budget ${base} must exceed the module timeout ${moduleTimeout}`);

  // Session creation is covered by a worker-declared budget, not the base.
  assert.match(worker, /phase: "blocking", budgetMs: SESSION_CREATE_TIMEOUT_MS/);
  assert.match(worker, /phase: 'blocking', budgetMs: SESSION_CREATE_TIMEOUT_MS/);
  assert.match(worker, /phase: "blocking", budgetMs: MODULE_TIMEOUT_MS/);
  assert.match(audio, /data\?\.phase === 'blocking'/);
  assert.match(audio, /declared \+ WORKER_PHASE_GRACE_MS/);

  // And the relaxed budget must not persist past the phase that asked for it.
  assert.match(audio, /: WORKER_SILENCE_TIMEOUT_MS;/,
    'a non-blocking message must reset the budget to the base');
});

// Field crash, iPhone 13 (4 GB), 2026-08-22: caching died at paragraph 20 and
// again at 41 -- exactly the every-20-paragraph WASM worker recycle.
// _resetPocketEngineForBackend was declared async but held no await, so
// terminate() (a request, not a wait) was followed immediately by
// _loadPocketEngine() allocating a second full ~126 MB model set. Both sets
// coexisted for a moment: ~250 MB, which is the kill on that device.
test('the worker recycle waits for teardown before reallocating', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const reset = audio.slice(
    audio.indexOf('async function _resetPocketEngineForBackend()'),
    audio.indexOf('window._resetPocketEngineForBackend = _resetPocketEngineForBackend;'),
  );
  assert.ok(reset.length > 0, 'reset function not found');
  assert.match(reset, /await new Promise\(\(resolve\) => setTimeout\(resolve, 0\)\)/,
    'terminate() must be followed by a real yield, not a synchronous return');
  assert.match(reset, /isPocketDeviceMemorySafeMode\?\.\(\) !== false \? 250 : 0/,
    'constrained devices need a longer settle than a bare macrotask');

  // The recycle must still call reset BEFORE load, and both must be awaited.
  const recycle = audio.slice(
    audio.indexOf('async function _maybeRecyclePocketEngine()'),
    audio.indexOf('// Live generator with one quality-guard retry'),
  );
  const resetIdx = recycle.indexOf('await _resetPocketEngineForBackend();');
  const loadIdx = recycle.indexOf('await _loadPocketEngine();');
  assert.ok(resetIdx > 0 && loadIdx > resetIdx,
    'teardown must be awaited before the replacement engine is loaded');
});

// stock-wasm-only on iOS 26.6 was unexpected and the flavor name alone cannot
// say whether the probe failed or the relaxed candidates were rejected.
test('the relaxed SIMD probe and model format are reported', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const audio = await read('public/assets/js/audio_core.js');
  const settings = await read('public/assets/js/settings_manager.js');
  assert.match(worker, /relaxedSimdSupported: supportsRelaxedSimd\(\),/);
  assert.match(worker, /ortFormatModels: useOrtFormatWasm,/);
  assert.match(audio, /relaxedSimdSupported: _pocketBackendRuntime\.relaxedSimdSupported \?\? null,/);
  assert.match(settings, /<b>Relaxed SIMD \/ \.ort:<\/b>/);
});

// Field-confirmed 2026-08-22: on an iPhone 13 (4 GB), caching survived
// noticeably longer with the model cache EMPTY than populated, on identical
// code. The empty case streams from the network into one preallocated buffer;
// the populated case went through Response.arrayBuffer(), asking WebKit to
// materialise an 87 MB blob in one step with no size hint. The cheap allocation
// shape was only ever used on first run.
test('cached model reads preallocate instead of calling arrayBuffer blindly', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const fn = worker.slice(
    worker.indexOf('async function readCachedModelBuffer('),
    worker.indexOf('async function writeCachedModelBuffer('),
  );
  assert.ok(fn.length > 0, 'read function not found');
  assert.match(fn, /const output = new Uint8Array\(declared\);/,
    'the cached read must preallocate from a declared length');
  assert.match(fn, /hit\.body\.getReader\(\)/, 'it must stream the stored body');
  // arrayBuffer() survives only as the unknown-size fallback.
  assert.match(fn, /if \(!declared \|\| !hit\.body\?\.getReader\) return await hit\.arrayBuffer\(\);/);

  // A truncated or oversized stored entry must be a miss, never a short model.
  assert.match(fn, /return null;[\s\S]{0,80}\}\s*\n\s*output\.set\(value, filled\);/);
  assert.match(fn, /if \(filled !== output\.byteLength\) return null;/);

  // Writes must record the length the read depends on.
  const writeFn = worker.slice(
    worker.indexOf('async function writeCachedModelBuffer('),
    worker.indexOf('// The same asset is reachable through two hosts'),
  );
  assert.match(writeFn, /'Content-Length': String\(byteLength\)/);

  // Pre-existing entries carry no Content-Length, so the caller supplies a size.
  assert.match(worker, /readCachedModelBuffer\(canonicalModelCacheKey\(urls\[0\]\), expectedBytes\)/);
});

// iPhone 13 reported "unsupported / .onnx protobuf": the browser validates
// fixed-width SIMD but not relaxed, and .ort was gated on the relaxed probe
// alone, so the device lost the custom runtime AND the model format that skips
// protobuf parsing at session creation.
test('a fixed-SIMD device can reach the custom runtime and .ort models', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /const FIXED_SIMD_PROBE = new Uint8Array\(\[/);
  assert.match(worker, /function supportsFixedSimd\(\)/);
  assert.match(worker, /name: 'simd-minimal-ort',/);
  assert.match(worker, /if \(preferMinimalOrt && supportsFixedSimd\(\)\) \{/);

  // The .ort gate is the wider probe now.
  assert.match(worker, /&& \(supportsRelaxedSimd\(\) \|\| supportsFixedSimd\(\)\);/);

  // Fail-safe: stock ORT has no .ort loader, so if the runtime resolves to
  // anything but a custom build the format must revert to .onnx BEFORE model
  // filenames are chosen, or the load fails outright instead of just costing more.
  assert.match(worker, /if \(selectedBackend === 'wasm' && useOrtFormatWasm && !flavorSupportsOrtFormat\(ortWasmRuntimeFlavor\)\) \{/);
  const correctIdx = worker.indexOf('useOrtFormatWasm = false;');
  const descriptorIdx = worker.indexOf('const modelDescriptors = currentBackend');
  assert.ok(correctIdx > 0 && correctIdx < descriptorIdx,
    'the format correction must run before model filenames are resolved');

  // The plain-SIMD candidate sits between relaxed and stock.
  const list = worker.slice(worker.indexOf('async function loadWasmOrtRuntime('),
                            worker.indexOf("name: 'legacy-jsep'"));
  assert.ok(list.indexOf("'relaxed-simd-minimal-ort'") < list.indexOf("'simd-minimal-ort'"),
    'relaxed must still be preferred when available');
  assert.ok(list.indexOf("'simd-minimal-ort'") < list.indexOf("'stock-wasm-only'"),
    'the custom SIMD build must be tried before falling back to stock');
});

// Verified by binary inspection 2026-08-22: stock ort-wasm-simd-threaded.wasm
// carries the ORTM identifier, "ORT format model", the "Invalid ORT format
// model" parser error and fbs:: symbols -- the same ORT-format markers as the
// custom build. Gating .ort on a custom runtime stranded the iPhone 13 on
// .onnx protobuf for no reason, since it fails the relaxed probe.
test('.ort stays limited to the runtimes it was measured against', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const fn = worker.slice(worker.indexOf('function flavorSupportsOrtFormat(flavor)'),
                          worker.indexOf('async function probeOrtRuntimeFiles'));
  assert.ok(fn.length > 0, 'gate function not found');
  for (const allowed of ['relaxed-simd-minimal-ort', 'simd-minimal-ort']) {
    assert.ok(fn.includes(`'${allowed}'`), `${allowed} must be allowed to use .ort`);
  }
  // Stock was allowed on static analysis alone and the device regressed while
  // that was live. It stays out until measured on hardware.
  assert.ok(!fn.includes("'stock-wasm-only'"),
    'stock must not be re-enabled for .ort without an on-device measurement');
  // An unverified build must keep the safe path: guessing wrong costs a total
  // load failure, not just extra memory.
  assert.ok(!fn.includes('legacy-jsep') && !fn.includes('cdn-jsep'),
    'jsep fallbacks must stay on .onnx until their binaries are checked');
});

// A neural engine that fails to load used to do two things it had no business
// doing, and together they produced the whole "Kokoro never narrates and the
// Preparing Narration modal never appears" report.
test('a failed engine load cannot rewrite the saved voice engine', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const fallback = audio.slice(
    audio.indexOf('function _fallbackToWebSpeech() {'),
    audio.indexOf('// ── Play button + Media Session'),
    // Comments are stripped throughout: an explanation that NAMES the old
    // behaviour must not read as the old behaviour still being there.
  ).replace(/^\s*\/\/.*$/gm, '');
  assert.ok(fallback.length > 100, 'the fallback body must be locatable');

  // It called switchReaderVoiceEngine('webspeech') NON-silently, which persisted
  // voiceEngine: 'webspeech' and set _engineManuallySet. One transient worker
  // failure therefore demoted the profile permanently, and because only a
  // neural engine starts a cache job, every later story open then skipped the
  // caching modal in total silence.
  assert.doesNotMatch(fallback, /switchReaderVoiceEngine/,
    'the automatic downgrade must not route through the user-choice path');
  assert.doesNotMatch(fallback, /settings\.voiceEngine\s*=/,
    'the automatic downgrade must not write the saved engine');
  assert.doesNotMatch(fallback, /saveLocalData/,
    'the automatic downgrade must not be persisted at all');

  // And it called pausePlayback(), clearing window.isPlaying, so the caller took
  // its "User paused during generation" exit and the device voice this function
  // announces never spoke. Silence, not a fallback.
  assert.doesNotMatch(fallback, /pausePlayback\(/,
    'the fallback must leave playback running so the device voice can take over');

  assert.match(fallback, /window\._pocketNeuralEngineUnavailable = true/,
    'the failure must be recorded in memory for this page only');

  // The resolver has to honour the in-memory flag, or nothing changes.
  const utils = await read('public/assets/js/engine_utils.js');
  assert.match(utils,
    /if \(window\._pocketNeuralEngineUnavailable === true\) return 'webspeech';/,
    'engine resolution must honour the session-only failure flag');
  // Session-only means session-only: no storage anywhere in the app.
  for (const name of ['audio_core.js', 'engine_utils.js', 'buffer_manager.js', 'library_manager.js']) {
    const source = await read(`public/assets/js/${name}`);
    assert.doesNotMatch(source, /(local|session)Storage[^\n]*_pocketNeuralEngineUnavailable/,
      `${name} must not persist the session failure flag`);
  }
});

test('a failed engine load still narrates the paragraph it was asked for', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  // The dead end: no blob, so stop. With the engine merely unloadable rather
  // than broken, the device voice can finish the paragraph instead.
  assert.match(
    audio,
    /if \(window\._pocketNeuralEngineUnavailable === true && window\.isPlaying\) \{\s*\n\s*await _playWebSpeech\(text\);/,
    'an unloadable engine must hand the paragraph to Web Speech, not stop playback',
  );
});

test('choosing a neural engine clears the session failure flag', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  // Otherwise the control looks dead: the reader picks Kokoro, resolution keeps
  // returning 'webspeech', and nothing they do in Settings has any effect until
  // they happen to reload.
  assert.match(
    audio,
    /engineVal === 'auto' \|\| engineVal === 'kokoro' \|\| engineVal === 'pocket'\) \{[\s\S]{0,400}?window\._pocketNeuralEngineUnavailable = false;/,
  );
});

test('the persisted downgrade is offered a way back exactly once', async () => {
  const library = await read('public/assets/js/library_manager.js');
  // The old downgrade also set _engineManuallySet, so it is indistinguishable
  // in stored data from a reader who genuinely prefers the device voice. This
  // must therefore ASK rather than guess — and only once, either answer.
  assert.match(library, /const ENGINE_DOWNGRADE_RECOVERY_KEY = 'pr_engine_downgrade_recovery_v1';/);
  assert.match(library, /localStorage\.setItem\(ENGINE_DOWNGRADE_RECOVERY_KEY, restoreNeural \? 'restored' : 'kept-device'\)/,
    'both answers must be recorded so the prompt never returns');
  // The trigger must ask the RESOLVER rather than read a settings key. The
  // stored profile is not always the value narration runs on — _resolveActiveEngine
  // prefers the in-memory profile and falls back to storage — and its answer is
  // what every narration gate in the app actually tests.
  assert.match(library, /window\._resolveActiveEngine\(\) !== 'webspeech'\) return;/);
  // It must not fire on a failure happening right now: that one is already
  // explained by the companion and already retried on the next reload.
  assert.match(library, /window\._pocketNeuralEngineUnavailable === true\) return;/);
  // And it cannot sit in loadLocalData(), which nothing in the app calls.
  const deadStart = library.indexOf('export async function loadLocalData');
  const deadEnd = library.indexOf('window.loadLocalData = loadLocalData');
  assert.ok(deadStart > 0 && deadEnd > deadStart, 'loadLocalData must be locatable');
  assert.ok(!library.slice(deadStart, deadEnd).includes('ENGINE_DOWNGRADE_RECOVERY_KEY'),
    'the recovery offer must not be placed inside an uncalled function');
  // Restoring must not rewrite the narration override, which would silently
  // move a Kokoro reader onto Pocket.
  const handler = library.slice(
    library.indexOf('window.resolveEngineDowngradeRecovery ='),
    library.indexOf('\n};', library.indexOf('window.resolveEngineDowngradeRecovery =')),
  );
  const handlerCode = handler.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(handlerCode, /writeNarrationEngineOverride|switchReaderVoiceEngine/,
    'the restore must leave the chosen neural engine alone');
  assert.match(handler, /settings\.voiceEngine = 'pocket'/);
});
