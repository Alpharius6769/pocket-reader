import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('heavy narration modules remain deferred until narration is requested', async () => {
  const html = await read('FrontEnd_html.html');
  const loader = await read('narration_runtime_loader.js');

  assert.doesNotMatch(html, /<script[^>]+audio_core\.js/);
  assert.doesNotMatch(html, /<script[^>]+buffer_manager\.js/);
  assert.match(loader, /import\('\.\/audio_core\.js\?v=audio-v53'\)/);
  assert.match(loader, /import\('\.\/buffer_manager\.js\?v=buffer-v43'\)/);
});

test('the deferred loader preserves the original mobile user activation', async () => {
  const html = await read('FrontEnd_html.html');
  const loader = await read('narration_runtime_loader.js');
  const audio = await read('audio_core.js');
  const buffer = await read('buffer_manager.js');

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
  assert.match(html, /onclick=&quot;window\.startPrecacheQueue\(\)&quot;/);
  assert.doesNotMatch(html, /if\(window\.BufferManager\) window\.BufferManager\.startPrecacheQueue/);
});

test('playback requests an isolated narration session before model startup', async () => {
  const audio = await read('audio_core.js');
  const toggle = audio.match(/export function togglePlayState\(\)[\s\S]*?\n}\nwindow\.togglePlayState/)?.[0] || '';

  assert.match(toggle, /preparePocketMobileMediaSession\(\)/);
  assert.match(toggle, /requestPocketNarrationIsolation\?\.\('playback'/);
  assert.ok(
    toggle.indexOf("requestPocketNarrationIsolation?.('playback'") < toggle.indexOf('window.isPlaying = !window.isPlaying'),
    'isolation must be requested before playback state flips or model work begins',
  );
});

test('post-isolation mobile resume requires a fresh user gesture', async () => {
  const buffer = await read('buffer_manager.js');
  const resume = buffer.match(/async function _resumeFastNarrationCache\(\)[\s\S]*?\n}\n\n\/\/ /)?.[0] || '';

  assert.match(buffer, /action:\s*action\s*\|\|\s*'cache'/);
  assert.match(buffer, /continuePocketNarrationAfterReload/);
  assert.match(resume, /await _awaitMobileNarrationGesture\(resume\.action/);
  assert.match(resume, /_requestFastNarrationReload\(resume\.mode \|\| 'Normal', resume\.action \|\| 'cache'\)/);
  assert.match(buffer, /preparePocketMobileMediaSession\?\.\(\)/);
  const readyBranch = resume.slice(resume.indexOf('if (storyReady'));
  const gestureAt = readyBranch.indexOf('await _awaitMobileNarrationGesture(resume.action');
  const removeAt = readyBranch.indexOf('sessionStorage.removeItem(FAST_NARRATION_RESUME_KEY)');
  assert.ok(
    gestureAt >= 0 && removeAt > gestureAt,
    'resume intent must survive until the post-reload user gesture completes',
  );
});

test('first requested paragraph supplies calibration telemetry without a throwaway synthesis', async () => {
  const audio = await read('audio_core.js');

  assert.doesNotMatch(audio, /Pocket Reader is ready\./);
  assert.doesNotMatch(audio, /await _ensurePocketTtsCalibration\(\)/);
  assert.match(audio, /_recordPocketTtsCalibrationFromTelemetry/);
  assert.match(audio, /realTimeFactor:\s*telemetry\?\.realTimeFactor/);
});

test('mobile caching unlocks playback quickly and starts keep-alive from the tap', async () => {
  const buffer = await read('buffer_manager.js');
  const audio = await read('audio_core.js');

  assert.match(buffer, /function _minimumPlaybackReadyCount[\s\S]*?mobile\s*\?\s*3\s*:\s*30/);
  assert.match(audio, /getPocketPlaybackReadyCount\?\.\(total\)/);
  assert.doesNotMatch(audio, /cachedCount < 30/);

  const startCaching = buffer.match(/window\.startCaching = async function[\s\S]*?\n};/)?.[0] || '';
  assert.match(startCaching, /preparePocketMobileMediaSession\?\.\(\)/);
  assert.ok(
    startCaching.indexOf('preparePocketMobileMediaSession?.()') < startCaching.indexOf('await _ensureCachingStory'),
    'media activation must happen synchronously before the first await',
  );
});

test('periodic worker recycle is serialized and never begins during active synthesis', async () => {
  const audio = await read('audio_core.js');

  assert.match(audio, /let _pocketRecyclePromise = null/);
  assert.match(audio, /async function _maybeRecyclePocketEngine/);
  assert.match(audio, /if \(\(window\._pocketActiveSynthesis \|\| 0\) > 0\) return false/);
  assert.doesNotMatch(audio, /if \(window\._pocketParagraphCount >= _recycleEvery\) \{[\s\S]*?await _resetPocketEngineForBackend\(\)/);
});

test('quality recovery never resets the shared engine while another synthesis is active', async () => {
  const audio = await read('audio_core.js');
  const generate = audio.match(/window\.generateChunk = async function[\s\S]*?\n};/)?.[0] || '';

  assert.match(generate, /const canResetSharedEngine = \(\) => \(window\._pocketActiveSynthesis \|\| 0\) <= 1/);
  assert.match(generate, /allowQualityRetry[\s\S]*?canResetSharedEngine\(\)/);
  assert.match(generate, /catch \(e\)[\s\S]*?if \(canResetSharedEngine\(\)\)\s*\{[\s\S]*?_resetPocketEngineForBackend/);
});

test('every pronunciation consumer uses the current ruleset URL', async () => {
  for (const file of ['audio_core.js', 'settings_manager.js', 'library_manager.js', 'pocket_worker.js']) {
    const source = await read(file);
    assert.doesNotMatch(source, /tts_pronunciation_core\.js\?v=pron-v7/, `${file} still imports pron-v7`);
    assert.match(source, /tts_pronunciation_core\.js\?v=pron-v9/, `${file} must import pron-v9`);
  }
});
