// Guards for the 2026-11-26 audit (AUDIT_FINDINGS.md). The bridge and UI side is
// covered in web/src (vitest); the backend side in
// tests/backend_text_extraction_regressions.py. These cover the cores, the
// Worker, and the class of bug that produced several of the findings: a module
// was deleted and the code that called into it kept running, silently doing
// less.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const audio = await read('public/assets/js/audio_core.js');

// ── Item 4: the non-story paragraph filter ──────────────────────────────────

function loadMetaDetector() {
  const start = audio.indexOf('export function isMetaParagraph(');
  const end = audio.indexOf('\nwindow.isMetaParagraph = isMetaParagraph;');
  assert.ok(start > 0 && end > start, 'audio_core.js must define and publish isMetaParagraph');
  const source = audio.slice(start, end).replace('export function', 'return function');
  return new Function(source)();
}

test('the non-story paragraph filter exists in the narration core', () => {
  // It lived in ui_controller.js, was deleted with it, and both callers fell
  // back to "skip only empty paragraphs" without anything failing.
  assert.match(audio, /window\.isMetaParagraph = isMetaParagraph;/);
  assert.match(audio, /return isMetaParagraph\(text, story \? story\.title : null, chapTitle, story \? story\.author : null\);/);
});

test('the filter skips metadata and keeps story text', () => {
  const isMeta = loadMetaDetector();
  for (const line of [
    'https://archiveofourown.org/works/123',
    '---',
    '* * *'.replace(/ /g, ''),
    "Author's Note: thanks for reading!",
    'A/N: sorry this took so long',
    'Words: 2,104',
    'Summary: a fox and a ferry',
    'Disclaimer: I own nothing.',
    '',
    '   ',
  ]) assert.equal(isMeta(line), true, `should skip: ${JSON.stringify(line)}`);

  for (const line of [
    'The whistle sounded twice, and the carriage lurched forward into the dark.',
    '"Are we late?" she asked. Nobody answered.',
    'No.',
    'Thank you for reading the letter, she wrote, and nothing more.',
  ]) assert.equal(isMeta(line), false, `should keep: ${JSON.stringify(line)}`);
});

test('the filter recognises an echo of the story, chapter or author name', () => {
  const isMeta = loadMetaDetector();
  assert.equal(isMeta('Night Train', 'Night Train', 'Chapter 1', 'Ilse'), true);
  assert.equal(isMeta('Chapter 1', 'Night Train', 'Chapter 1: Departure', 'Ilse'), true);
  assert.equal(isMeta('Ilse', 'Night Train', 'Chapter 1', 'Ilse'), true);
  assert.equal(isMeta('The night train was late again.', 'Night Train', 'Chapter 1', 'Ilse'), false);
});

// ── Items 15-20: locked-screen playback ─────────────────────────────────────

test('Play from the lock screen starts on its own once the runway is ready (15)', () => {
  // The gate returns without playing; with no screen to tap, nothing else would.
  assert.match(audio, /bind\('play', \(\) => \{[\s\S]*?_autoStartWhenReady = true;\s*window\.togglePlayState\?\.\(\);/);
  assert.match(audio, /const autoStart = _autoStartWhenReady;\s*_autoStartWhenReady = false;/);
  assert.match(audio, /if \(autoStart\) \{[\s\S]*?Promise\.resolve\(preparing\)\.then\(\(runway\) => \{\s*if \(runway\?\.ok && !window\.isPlaying && window\.currentStory && isNarrationRunwayReady\(\)\)/);
});

test('a lock-screen Play while the app believes it is playing recovers a stall (15, 18)', () => {
  assert.match(audio, /if \(window\.isPlaying\) \{ _recoverStalledPlayback\('media-session'\); return; \}/);
});

test('the next paragraph is staged again on the audio clock and after each render (16)', () => {
  const pump = audio.slice(audio.indexOf('export function _onAudioClockPump()'), audio.indexOf('window._onAudioClockPump = _onAudioClockPump;'));
  assert.match(pump, /_preloadNextParagraphAudio\(\);\s*_ensurePlaybackLookahead\(\);/);
  const lookahead = audio.slice(audio.indexOf('async function _ensurePlaybackLookahead()'), audio.indexOf('window._ensurePlaybackLookahead = _ensurePlaybackLookahead;'));
  assert.match(lookahead, /await saveAudioChunk\([^\n]+\n[\s\S]*?_preloadNextParagraphAudio\(\);/);
});

test('the boundary still calls play() synchronously: no await before the staged clip starts', () => {
  // playCurrentParagraph gained in-flight bookkeeping. It must stay a thin
  // wrapper that calls the real work synchronously.
  assert.match(audio, /export async function playCurrentParagraph\(\) \{\s*if \(!window\.isPlaying\) return;\s*_playInFlight \+= 1;\s*_playInFlightSince = Date\.now\(\);\s*try \{\s*await _playCurrentParagraphNow\(\);/);
  const handler = audio.slice(audio.indexOf('function _handleParagraphEnd()'), audio.indexOf('function _advanceIndices()'));
  assert.ok(handler.indexOf('playCurrentParagraph();') < handler.indexOf('_checkpointPlaybackProgress();'),
    'audio must be requested before the bookkeeping');
});

test('returning to the app restarts narration that stalled while hidden (18)', () => {
  assert.match(audio, /if \(document\.visibilityState === 'visible'\) \{[\s\S]*?_recoverStalledPlayback\('visible'\);/);
  const recover = audio.slice(audio.indexOf('function _recoverStalledPlayback(reason)'), audio.indexOf('window._recoverStalledPlayback = _recoverStalledPlayback;'));
  // Healthy playback and a start that is under way are left alone.
  assert.match(recover, /if \(narrating && !audio\.paused && !audio\.ended\) return false;/);
  assert.match(recover, /if \(_playInFlight > 0 && Date\.now\(\) - _playInFlightSince < PLAY_IN_FLIGHT_STALE_MS\) return false;/);
  // A clip that ended with no successor is the case the old handler missed.
  assert.match(recover, /playCurrentParagraph\(\);\s*return true;\s*\}\s*$/);
});

test('phones render ahead by listening time, desktop keeps eight paragraphs (19)', () => {
  assert.match(audio, /const POCKET_PLAYBACK_LOOKAHEAD = 8;/);
  assert.match(audio, /const POCKET_LOCKSAFE_LOOKAHEAD_WORDS = \d{4};/);
  assert.match(audio, /return _preferDirectMobileMediaPlayback\(\)\s*\? \{ paragraphs: POCKET_LOCKSAFE_LOOKAHEAD_PARAGRAPHS, words: POCKET_LOCKSAFE_LOOKAHEAD_WORDS \}\s*: \{ paragraphs: POCKET_PLAYBACK_LOOKAHEAD, words: Infinity \};/);
  assert.match(audio, /if \(aheadWords >= budget\.words\) break;/);
  // A satisfied pass must not re-read every slot from storage every 2 s.
  assert.match(audio, /if \(_lookaheadSatisfiedFor === passKey\) return;/);
});

test('what happens while the page is hidden is recorded and survives the page (20)', () => {
  assert.match(audio, /window\.getLockScreenReport = \(\) => _readLockSessions\(\);/);
  assert.match(audio, /else if \(document\.visibilityState === 'hidden'\) \{[\s\S]*?_openLockSession\(\);/);
  assert.match(audio, /_recoverStalledPlayback\('visible'\);\s*_closeLockSession\(\);/);
  // Written through, so a page the system killed still leaves its record.
  assert.match(audio, /ended: 'page-closed-while-hidden'/);
  for (const field of ['played', 'staged', 'fromStorage', 'synthesized', 'rendered', 'recovered', 'playRefused']) {
    assert.match(audio, new RegExp(`_lockNote\\('${field}'\\)|'${field}'`), `the record needs ${field}`);
  }
});

// ── Item 11 ─────────────────────────────────────────────────────────────────

test('turning expressive narration off for offline saving is announced (11)', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  const block = buffer.slice(buffer.indexOf('function _showConstrainedCacheNotice(mode)'), buffer.indexOf("window.showFeatureDialog('Safer narration for this device'"));
  assert.match(block, /window\.setPocketExpressiveProsodyChoice\?\.\(false\);\s*ui\.notify\(/);
  assert.match(block, /ui\.engineControlsChanged\(\);/);
});

// ── Item 23 ─────────────────────────────────────────────────────────────────

test('the Worker proxy does not decode its target twice (23)', async () => {
  const worker = await read('worker/cloudflare_worker.js');
  assert.doesNotMatch(worker, /decodeURIComponent\(targetUrlString\)/);
  assert.match(worker, /targetUrl = new URL\(targetUrlString\);/);
});

// ── Item 24: nothing may call into a module that is gone ────────────────────
//
// Every finding in the "deleted module" family had the same shape: a core kept
// calling window.something that only a removed file defined. Optional calls
// (`window.x?.()`, `typeof window.x === 'function'`) made that silent. This
// test knows every such name that is left. A new one fails here, so whoever
// removes a module has to decide what its callers should do instead.

const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const BROWSER = new Set(`location document navigator localStorage sessionStorage indexedDB caches fetch setTimeout clearTimeout
setInterval clearInterval requestAnimationFrame cancelAnimationFrame addEventListener removeEventListener dispatchEvent matchMedia
innerWidth innerHeight scrollTo scrollY scrollX performance crypto URL Blob File Worker AudioContext webkitAudioContext
OfflineAudioContext speechSynthesis SpeechSynthesisUtterance MediaMetadata Notification confirm alert prompt open close history
screen devicePixelRatio crossOriginIsolated isSecureContext SharedArrayBuffer WebAssembly getComputedStyle requestIdleCallback
cancelIdleCallback structuredClone queueMicrotask postMessage parent top self origin name length console visualViewport Capacitor
CustomEvent Event MessageChannel BroadcastChannel AbortController TextDecoder TextEncoder atob btoa PushManager CSS GPUBufferUsage
innerHTML toString hasOwnProperty`.split(/\s+/));

// Names with no definition anywhere, and why each is allowed to stay that way.
const KNOWN_UNDEFINED = new Map(Object.entries({
  // Read-only probes and injected values: absence is a valid answer.
  POCKET_READER_DEVICE_MODEL: 'optional injected value',
  PR_ADMIN_SECRET: 'optional injected value',
  __pocketMobileAudioContext: 'optional hand-over slot',
  __prLegacyShell: 'old-shell marker, read only',
  __prServiceWorkerError: 'optional diagnostic slot',
  currentActiveView: 'old-shell state, read only in diagnostics',
  currentLibraryFilter: 'old-shell state, read only',
  _isLowBattery: 'optional probe; absence means "not low"',
  collectDeviceProfile: 'optional diagnostic helper, guarded',
  // Old-shell rendering and dialogs. Their callers are old-shell code that
  // returns early when its elements are missing, or guard the call.
  _handleHmofaStoryBatch: 'old-shell masterlist cards; v2 opens catalog stories through the bridge',
  _handleHmofaStoryIntercept: 'old-shell masterlist cards; v2 opens catalog stories through the bridge',
  _buildReaderProgressIndex: 'old-shell rendering, guarded',
  _setControlsLocked: 'old-shell control lock, guarded',
  applySettings: 'old-shell settings form, guarded',
  buildSyncPayloadV3: 'cloud sync was retired, guarded',
  closeFeatureDialog: 'old-shell dialog, optional call',
  editBookmarkDetails: 'old-shell inline handler in generated HTML',
  initSettingsUI: 'old-shell settings form, guarded',
  jumpToBookmark: 'old-shell bookmarks tab, guarded',
  openStoryCollectionDialog: 'old-shell inline handler in generated HTML',
  openStoryNarrationByKey: 'old-shell inline handler in generated HTML',
  prIcon: 'old-shell icon helper, optional call',
  recordStoryHistory: 'history list was an old-shell feature; lastRead carries recency',
  refreshPerfPanel: 'old-shell diagnostics panel, guarded',
  releaseQueuedModal: 'old-shell modal queue, optional call',
  renderChaptersTab: 'old-shell rendering, guarded',
  renderNarrationEngineControls: 'old-shell rendering, optional call',
  renderProfileExtras: 'old-shell rendering, optional call',
  restoreSetupDraft: 'old-shell setup form, optional call',
  setCinematicSynthesisSuppressed: 'cinematic mode was removed, optional call',
  setExperienceSuppressed: 'experience coordinator was removed, optional call',
  showFeatureDialog: 'old-shell dialog with its own buttons; every caller has a no-dialog path',
  showView: 'old-shell navigation, reached only from old-shell deck code',
  toggleReadingQueue: 'old-shell inline handler in generated HTML',
  updateDisplayName: 'old-shell profile header, guarded',
  updatePocketBackendControl: 'old-shell control, optional call',
  updateReaderUIText: 'old-shell rendering, guarded',
}));

async function collect() {
  const coreDir = new URL('../public/assets/js/', import.meta.url);
  const cores = {};
  for (const file of (await readdir(coreDir)).filter((f) => f.endsWith('.js'))) cores[file] = strip(await readFile(new URL(file, coreDir), 'utf8'));

  const webFiles = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const next = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) await walk(next);
      else if (/\.(ts|svelte)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) webFiles.push(strip(await readFile(next, 'utf8')));
    }
  }
  await walk(new URL('../web/src/', import.meta.url));

  const defined = new Set();
  for (const source of Object.values(cores)) {
    for (const m of source.matchAll(/\b(?:window|globalThis|self)\.([A-Za-z_$][\w$]*)\s*(?:=(?!=)|\|\|=|\?\?=)/g)) defined.add(m[1]);
    for (const m of source.matchAll(/\b(?:window|globalThis)\[['"]([A-Za-z_$][\w$]*)['"]\]\s*=(?!=)/g)) defined.add(m[1]);
    for (const m of source.matchAll(/\[\s*((?:'[A-Za-z_$][\w$]*'\s*,?\s*)+)\]\s*\.forEach/g)) {
      for (const k of m[1].matchAll(/'([A-Za-z_$][\w$]*)'/g)) defined.add(k[1]);
    }
  }
  for (const source of webFiles) {
    for (const m of source.matchAll(/\b(?:window|w)\.([A-Za-z_$][\w$]*)\s*(?:=(?!=)|\|\|=|\?\?=)/g)) defined.add(m[1]);
  }

  const used = new Set();
  for (const source of Object.values(cores)) {
    for (const m of source.matchAll(/\b(?:window|globalThis)\.([A-Za-z_$][\w$]*)/g)) if (!BROWSER.has(m[1])) used.add(m[1]);
  }
  const bridge = strip(await read('web/src/lib/core/bridge.real.ts'));
  const bridgeUsed = new Set();
  for (const m of bridge.matchAll(/\bw\.([A-Za-z_$][\w$]*)/g)) if (!BROWSER.has(m[1])) bridgeUsed.add(m[1]);
  return { defined, used, bridgeUsed };
}

test('the bridge reaches for nothing the cores do not define', async () => {
  const { defined, bridgeUsed } = await collect();
  const missing = [...bridgeUsed].filter((name) => !defined.has(name)).sort();
  assert.deepEqual(missing, [], `bridge.real.ts uses globals nothing defines: ${missing.join(', ')}`);
});

test('no core calls into a module that no longer exists, beyond the known list', async () => {
  const { defined, used } = await collect();
  const missing = [...used].filter((name) => !defined.has(name)).sort();
  const unexpected = missing.filter((name) => !KNOWN_UNDEFINED.has(name));
  assert.deepEqual(unexpected, [],
    `a core uses window.${unexpected[0]}, which nothing defines. Define it, route it through core_events.js, or remove the call.`);
  // And the list may not rot: an entry that is defined again, or no longer
  // used, has to be taken out.
  const stale = [...KNOWN_UNDEFINED.keys()].filter((name) => !missing.includes(name)).sort();
  assert.deepEqual(stale, [], `no longer undefined or no longer used: ${stale.join(', ')}`);
});

test('the names whose loss caused audit findings are defined again', async () => {
  const { defined } = await collect();
  for (const name of ['isMetaParagraph', 'queueAchievementUnlock', 'syncPushProfileIfEnabled', 'virtueSpeak', 'triggerVirtue', 'pocketNotify', 'showSettingsModal']) {
    assert.ok(defined.has(name), `${name} must be defined by a core or by the bridge`);
  }
});
