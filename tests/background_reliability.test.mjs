import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('audio_core.js plays silent audio keep-alive during active narration', async () => {
  const audio = await read('audio_core.js');
  // startBgKeepAlive must invoke audio.play() on the silent loop element
  assert.match(audio, /function _ensureBgKeepAlive\(\)/);
  assert.match(audio, /export function startBgKeepAlive\(\)/);
  assert.match(audio, /const audio = _ensureBgKeepAlive\(\);/);
  assert.match(audio, /if \(audio && audio\.paused\) \{\s*audio\.play\(\)\.catch\(\(\) => \{\}\);/);
});

test('stopBgKeepAlive respects active background caching before pausing keep-alive', async () => {
  const audio = await read('audio_core.js');
  assert.match(audio, /const isCachingActive = Boolean\(window\.BufferManager\?\.isActive && !window\.BufferManager\?\.paused\);/);
  assert.match(audio, /if \(_bgKeepAlive && !_bgKeepAlive\.paused && !window\.isPlaying && !isCachingActive\)/);
});

test('_preferDirectMobileMediaPlayback returns true for OS background entitlement', async () => {
  const audio = await read('audio_core.js');
  assert.match(audio, /function _preferDirectMobileMediaPlayback\(\)[\s\S]*?return true;/);
});

test('visibilitychange in audio_core.js triggers keep-alive on hidden state', async () => {
  const audio = await read('audio_core.js');
  assert.match(audio, /else if \(document\.visibilityState === 'hidden'\)[\s\S]*?if \(window\.isPlaying \|\| isCachingActive\)[\s\S]*?startBgKeepAlive\(\)/);
});

test('buffer_manager.js triggers background keep-alive when hidden during active caching', async () => {
  const buffer = await read('buffer_manager.js');
  assert.match(buffer, /document\.addEventListener\('visibilitychange', \(\) => \{\s*const isCachingActive = BufferManager\.isActive && !BufferManager\.paused;/);
  assert.match(buffer, /else if \(document\.visibilityState === 'hidden'\)[\s\S]*?if \(typeof window\.startBgKeepAlive === 'function'\)/);
  assert.match(buffer, /if \(typeof document !== 'undefined' && document\.hidden && typeof window\.startBgKeepAlive === 'function'\) \{\s*window\.startBgKeepAlive\(\);/);
});

test('window._resetPocketEngineForBackend is reachable from buffer_manager.js', async () => {
  // buffer_manager's caching circuit breaker (2+ consecutive errors) recovers by
  // calling window._resetPocketEngineForBackend() — it runs in a different module
  // scope than audio_core.js, so the reset function MUST be attached to window or
  // the `typeof window._resetPocketEngineForBackend === 'function'` guard is
  // always false and the recovery path silently never fires, letting background
  // caching stall on a bad worker instead of resetting it.
  const audio = await read('audio_core.js');
  const buffer = await read('buffer_manager.js');
  assert.match(audio, /window\._resetPocketEngineForBackend = _resetPocketEngineForBackend;/);
  assert.match(buffer, /typeof window\._resetPocketEngineForBackend === 'function'/);
});

test('TTS worker generation timeout is patient while backgrounded, fast while foregrounded', async () => {
  // A fixed 60s timeout (regardless of tab visibility) rejects real, still-
  // progressing synthesis once the OS deprioritizes a backgrounded/locked tab —
  // and the reject path resets the ENTIRE Pocket engine, which was killing
  // background playback and caching mid-session. The budget must be re-read
  // live (document.hidden) on every poll, not fixed at call start, so a session
  // that backgrounds mid-generation still gets the patient budget.
  const audio = await read('audio_core.js');
  assert.match(audio, /const FOREGROUND_TIMEOUT_MS = 60000;/);
  assert.match(audio, /const BACKGROUND_TIMEOUT_MS = 600000;/);
  assert.match(audio, /const currentTimeoutMs = \(\) => \(typeof document !== 'undefined' && document\.hidden\)\s*\n\s*\? BACKGROUND_TIMEOUT_MS : FOREGROUND_TIMEOUT_MS;/);
  // The deadline check must call currentTimeoutMs() live inside the poll tick,
  // not capture a fixed value once before the wait begins.
  const checkFn = audio.slice(audio.indexOf('const check = () => {'), audio.indexOf('timerObj = setTimeout(check, Math.min(POLL_MS, currentTimeoutMs()));'));
  assert.match(checkFn, /const timeoutMs = currentTimeoutMs\(\);/);
});

test('local-file-path intercept in loadStory does not swallow the app\'s own internal reference URLs', async () => {
  // loadStory's "user pasted a local filesystem path" heuristic used a bare
  // leading-"/" regex alternative that ALSO matched this app's own internal
  // reference schemes (/api/library/curated/... for curated stories,
  // /local-upload/... for re-opened uploads) — exactly the fetchUrl values
  // step 1 legitimately produces once a library entry's cached chapters are
  // missing. Live-verified: every not-yet-cached curated story hit a blocking
  // alert() in the foreground and a silent no-op return in background/silent
  // calls (preventNavigate) — i.e. it never loaded, foreground OR background.
  const api = await read('api_core.js');
  assert.match(api, /const _isAppInternalRef = \/\^\(\\\/api\\\/\|\\\/local-upload\\\/\|local:\\\/\\\/\)\/i\.test\(_trimmedUrl\);/);
  assert.match(api, /if \(!_isAppInternalRef && \(_trimmedUrl\.match/);
});

test('anvil-app assets mirror background reliability updates', async () => {
  const anvilAudio = await read('anvil-app/theme/assets/audio_core.js');
  const anvilBuffer = await read('anvil-app/theme/assets/buffer_manager.js');
  const anvilApi = await read('anvil-app/theme/assets/api_core.js');
  assert.match(anvilApi, /const _isAppInternalRef = \/\^\(\\\/api\\\/\|\\\/local-upload\\\/\|local:\\\/\\\/\)\/i\.test\(_trimmedUrl\);/);
  assert.match(anvilAudio, /const audio = _ensureBgKeepAlive\(\);/);
  assert.match(anvilAudio, /function _preferDirectMobileMediaPlayback\(\)[\s\S]*?return true;/);
  assert.match(anvilAudio, /window\._resetPocketEngineForBackend = _resetPocketEngineForBackend;/);
  assert.match(anvilAudio, /const BACKGROUND_TIMEOUT_MS = 600000;/);
  assert.match(anvilBuffer, /const isCachingActive = BufferManager\.isActive && !BufferManager\.paused;/);
});
