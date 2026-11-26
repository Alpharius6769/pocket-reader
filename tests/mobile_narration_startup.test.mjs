import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('playback requests an isolated narration session before model startup', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const toggle = audio.match(/export function togglePlayState\(\)[\s\S]*?window\.togglePlayState =/)?.[0] || '';

  assert.match(toggle, /preparePocketMobileMediaSession\(\)/);
  assert.match(toggle, /requestPocketNarrationIsolation\?\.\('playback'/);
  assert.ok(
    toggle.indexOf("requestPocketNarrationIsolation?.('playback'") < toggle.indexOf('window.isPlaying = !window.isPlaying'),
    'isolation must be requested before playback state flips or model work begins',
  );
});

test('post-isolation mobile resume requires a fresh user gesture', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  const resumeStart = buffer.indexOf('async function _resumeFastNarrationCache()');
  const resume = resumeStart >= 0 ? buffer.slice(resumeStart, resumeStart + 10000) : '';

  assert.match(buffer, /action:\s*action\s*\|\|\s*'cache'/);
  assert.match(buffer, /continuePocketNarrationAfterReload/);
  assert.match(resume, /window\.togglePlayState\?\.\(\)/);
  assert.match(resume, /_requestFastNarrationReload\(resume\.mode \|\| 'Normal', resume\.action \|\| 'cache'\)/);
  assert.match(buffer, /preparePocketMobileMediaSession\?\.\(\)/);
  const readyBranch = resume.slice(resume.indexOf('if (storyLoaded)'));
  const gestureAt = readyBranch.indexOf('window.togglePlayState?.()');
  const removeAt = readyBranch.indexOf('prSession.removeItem(FAST_NARRATION_RESUME_KEY)', gestureAt);
  assert.ok(
    gestureAt >= 0 && removeAt > gestureAt,
    'resume intent must survive until the post-reload user gesture completes',
  );
});

test('failed narration resume cannot leave the loading overlay stuck', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  const resumeStart = buffer.indexOf('async function _resumeFastNarrationCache()');
  const resume = resumeStart >= 0 ? buffer.slice(resumeStart, resumeStart + 10000) : '';
  assert.match(resume, /Promise\.race\(/, 'story restore needs a bounded timeout');
  assert.match(resume, /catch \(error\)/, 'story restore errors must be handled');
  assert.match(resume, /ui\.closeCachePanel\(\)/, 'failed restore must close cache UI');
  assert.match(resume, /ui\.loaded\(\)/, 'failed restore must hide the resume overlay');
});

test('post-reload narration restore can fall back to the original story URL before library hydration', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  const resumeStart = buffer.indexOf('async function _resumeFastNarrationCache()');
  const resume = resumeStart >= 0 ? buffer.slice(resumeStart, resumeStart + 10000) : '';
  assert.match(buffer, /loadRef[,:]/, 'handoff record must retain a loadable story reference');
  assert.match(resume, /const loadRef = /, 'resume must derive a fallback load reference');
  assert.match(resume, /window\.loadStory\(loadRef/, 'resume must not require the in-memory library entry');
  assert.match(resume, /Library hydration was slow/, 'fallback must leave useful diagnostic evidence');
});

test('first requested paragraph supplies calibration telemetry without a throwaway synthesis', async () => {
  const audio = await read('public/assets/js/audio_core.js');

  assert.doesNotMatch(audio, /Pocket Reader is ready\./);
  assert.doesNotMatch(audio, /await _ensurePocketTtsCalibration\(\)/);
  assert.match(audio, /_recordPocketTtsCalibrationFromTelemetry/);
  assert.match(audio, /realTimeFactor:\s*telemetry\?\.realTimeFactor/);
});

test('caching requires a measured runway (twenty when slow or unknown) or story completion before playback', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  const audio = await read('public/assets/js/audio_core.js');

  // v2: the runway follows measured speed; 20 remains the ceiling and the default (voice_reliability_v2).
  assert.match(buffer, /function _minimumPlaybackReadyCount[\s\S]*?Math\.min\(playbackRunwayForRtf\(_medianRtf\(\)\),/);
  assert.match(buffer, /const PLAYBACK_RUNWAY_MAX = 20;/);
  assert.match(audio, /getPocketPlaybackReadyCount\?\.\(total\)/);
  assert.match(audio, /Math\.min\(20,\s*total\)/);

  const startCaching = buffer.match(/window\.startCaching = async function[\s\S]*?\n};/)?.[0] || '';
  assert.match(startCaching, /preparePocketMobileMediaSession\?\.\(\)/);
  assert.ok(
    startCaching.indexOf('preparePocketMobileMediaSession?.()') < startCaching.indexOf('await _ensureCachingStory'),
    'media activation must happen synchronously before the first await',
  );
});

test('fast narration handoff restores URL-less library stories from IndexedDB', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  const resumeStart = buffer.indexOf('async function _resumeFastNarrationCache()');
  const resume = resumeStart >= 0 ? buffer.slice(resumeStart, resumeStart + 10000) : '';

  assert.match(buffer, /storySnapshot/, 'handoff must retain minimal story metadata');
  assert.match(resume, /_loadStoryChapters/, 'resume must query persisted chapters directly');
  assert.match(resume, /restoredFromStorage/, 'direct storage restore needs an explicit branch');
  assert.match(resume, /_isLoadableHandoffRef/, 'opaque story keys must not be sent to URL validation');
});

test('periodic worker recycle is serialized and never begins during active synthesis', async () => {
  const audio = await read('public/assets/js/audio_core.js');

  assert.match(audio, /let _pocketRecyclePromise = null/);
  assert.match(audio, /async function _maybeRecyclePocketEngine/);
  assert.match(audio, /if \(\(window\._pocketActiveSynthesis \|\| 0\) > 0\) return false/);
  assert.doesNotMatch(audio, /if \(window\._pocketParagraphCount >= _recycleEvery\) \{[\s\S]*?await _resetPocketEngineForBackend\(\)/);
});

test('quality recovery never resets the shared engine while another synthesis is active', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const generate = audio.match(/window\.generateChunk = async function[\s\S]*?\n};/)?.[0] || '';

  assert.match(generate, /const canResetSharedEngine = \(\) => \(window\._pocketActiveSynthesis \|\| 0\) <= 1/);
  assert.match(generate, /allowQualityRetry[\s\S]*?canResetSharedEngine\(\)/);
  assert.match(generate, /catch \(e\)[\s\S]*?if \(canResetSharedEngine\(\)\)\s*\{[\s\S]*?_resetPocketEngineForBackend/);
});

test('a failed cache render gets varied quality retries, never identical reruns', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const buffer = await read('public/assets/js/buffer_manager.js');
  const generate = audio.match(/window\.generateChunk = async function[\s\S]*?\n};/)?.[0] || '';

  assert.match(generate, /throughputRetry/);
  // The retry takes a RE-RESOLVED route: the reload between the two attempts
  // starts whatever engine is active now, and replaying the first attempt's
  // route sent a Kitten voice to a freshly built Pocket worker.
  assert.match(generate, /_generatePocketAttempt\(null,\s*text,\s*retryRoute,\s*level\)/);
  assert.match(generate, /const retryEngine = _resolveActiveEngine\(\);/);
  assert.match(generate, /_lastPocketQualityFailure/);
  assert.match(buffer, /qualityFailure\?\.text === task\.text/);
  assert.match(buffer, /task\.failCount = 3/);
});

