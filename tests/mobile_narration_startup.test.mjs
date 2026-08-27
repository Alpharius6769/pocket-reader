import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('heavy narration modules remain deferred until narration is requested', async () => {
  const html = await read('public/index.html');
  const loader = await read('public/assets/js/narration_runtime_loader.js');

  assert.doesNotMatch(html, /<script[^>]+audio_core\.js/);
  assert.doesNotMatch(html, /<script[^>]+buffer_manager\.js/);
  assert.match(loader, /import\('\.\/audio_core\.js\?v=audio-v97'\)/);
  assert.match(loader, /import\('\.\/buffer_manager\.js\?v=buffer-v63'\)/);
});

test('the deferred loader preserves the original mobile user activation', async () => {
  const html = await read('public/index.html');
  const loader = await read('public/assets/js/narration_runtime_loader.js');
  const audio = await read('public/assets/js/audio_core.js');
  const buffer = await read('public/assets/js/buffer_manager.js');

  assert.match(loader, /function preparePocketDeferredMediaGesture/);
  assert.match(loader, /MEDIA_GESTURE_ACTIONS/);
  assert.ok(
    loader.indexOf('preparePocketDeferredMediaGesture()') < loader.indexOf('ensureNarrationRuntime().then'),
    'media must be unlocked before the dynamic import promise',
  );
  assert.match(audio, /window\.__pocketMobileMediaElement \|\| null/);
  assert.match(audio, /window\.__pocketMobileAudioContext \|\| null/);
  assert.match(loader, /audio\.loop = true/);
  assert.match(audio, /_premiumAudio\.loop = true/);
  assert.match(audio, /_premiumAudio\?\.dataset\?\.pocketUnlock === '1'[\s\S]*?_premiumAudio\.pause\(\)/);
  assert.match(audio, /window\.currentAudio\.loop = false/);
  assert.match(buffer, /window\.startPrecacheQueue\s*=/);
  assert.match(html, /onclick="window\.startPrecacheQueue\(\)"/);
  assert.doesNotMatch(html, /if\(window\.BufferManager\) window\.BufferManager\.startPrecacheQueue/);
});

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
  const removeAt = readyBranch.indexOf('sessionStorage.removeItem(FAST_NARRATION_RESUME_KEY)', gestureAt);
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
  assert.match(resume, /closeCacheModal\?\.\(\)/, 'failed restore must close cache UI');
  assert.match(resume, /hideLoadingOverlay\?\.\(\)/, 'failed restore must hide the resume overlay');
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

test('a narration-resume fix advances the immutable module and service-worker revisions', async () => {
  const [buffer, loader, worker, shell] = await Promise.all([
    read('public/assets/js/buffer_manager.js'),
    read('public/assets/js/narration_runtime_loader.js'),
    read('public/sw.js'),
    read('public/index.html'),
  ]);
  assert.match(loader, /buffer_manager\.js\?v=buffer-v63/);
  assert.match(worker, /buffer_manager\.js\?v=buffer-v63/);
  assert.match(worker, /pocket-reader-core-v\d+/);
  // Derived, not pinned: the shell must register whatever revision the service
  // worker actually ships. Hardcoding the number here only forced a mechanical
  // edit on every bump without ever checking the thing that matters.
  const swRevision = worker.match(/pocket-reader-core-v(\d+)/)?.[1];
  assert.ok(swRevision, 'sw.js must declare a versioned cache name');
  assert.match(shell, new RegExp(`sw\\.js\\?v=${swRevision}\\b`));
  assert.match(buffer, /storyRef/);
});

test('first requested paragraph supplies calibration telemetry without a throwaway synthesis', async () => {
  const audio = await read('public/assets/js/audio_core.js');

  assert.doesNotMatch(audio, /Pocket Reader is ready\./);
  assert.doesNotMatch(audio, /await _ensurePocketTtsCalibration\(\)/);
  assert.match(audio, /_recordPocketTtsCalibrationFromTelemetry/);
  assert.match(audio, /realTimeFactor:\s*telemetry\?\.realTimeFactor/);
});

test('caching requires a twenty-paragraph runway or story completion before playback', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  const audio = await read('public/assets/js/audio_core.js');

  assert.match(buffer, /function _minimumPlaybackReadyCount[\s\S]*?Math\.min\(20,/);
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

test('a failed cache render gets one varied quality retry instead of three identical reruns', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const buffer = await read('public/assets/js/buffer_manager.js');
  const generate = audio.match(/window\.generateChunk = async function[\s\S]*?\n};/)?.[0] || '';

  assert.match(generate, /throughputRetry/);
  assert.match(generate, /_generatePocketAttempt\(null,\s*text,\s*route,\s*1\)/);
  assert.match(generate, /_lastPocketQualityFailure/);
  assert.match(buffer, /qualityFailure\?\.text === task\.text/);
  assert.match(buffer, /task\.failCount = 3/);
});

test('every pronunciation consumer uses the current ruleset URL', async () => {
  for (const file of ['public/assets/js/audio_core.js', 'public/assets/js/settings_manager.js', 'public/assets/js/library_manager.js', 'public/assets/js/pocket_worker.js']) {
    const source = await read(file);
    assert.doesNotMatch(source, /tts_pronunciation_core\.js\?v=pron-v9/, `${file} still imports pron-v9`);
    assert.match(source, /tts_pronunciation_core\.js\?v=pron-v14/, `${file} must import pron-v14`);
  }
});
