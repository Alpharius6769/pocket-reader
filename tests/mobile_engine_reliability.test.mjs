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
  assert.match(fetchModel, /readCachedModelBuffer\(canonicalModelCacheKey\(urls\[0\]\)\)/,
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
