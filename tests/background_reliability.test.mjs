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

test('anvil-app assets mirror background reliability updates', async () => {
  const anvilAudio = await read('anvil-app/theme/assets/audio_core.js');
  const anvilBuffer = await read('anvil-app/theme/assets/buffer_manager.js');
  assert.match(anvilAudio, /const audio = _ensureBgKeepAlive\(\);/);
  assert.match(anvilAudio, /function _preferDirectMobileMediaPlayback\(\)[\s\S]*?return true;/);
  assert.match(anvilBuffer, /const isCachingActive = BufferManager\.isActive && !BufferManager\.paused;/);
});
