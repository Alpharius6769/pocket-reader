import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('cached playback checks IndexedDB before initializing the narration backend', async () => {
  const source = await read('public/assets/js/audio_core.js');
  const play = source.match(/async function _playGeneratedAudio[\s\S]*?\n}\n\nasync function _playWebSpeech/)?.[0] || '';
  const cacheLookup = play.indexOf('getAudioChunk(');
  const backendInit = play.indexOf('_ensurePocketBackendOptimizedForVoice(');
  assert.ok(cacheLookup >= 0 && backendInit > cacheLookup,
    'a cache hit must play without loading the TTS model first');
});

test('playback runway counts successful audio and cannot be bypassed by a paused or final worker', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(buffer, /getReadyCount\(\)/);
  assert.match(buffer, /Number\(this\.cachedCount[\s\S]*?-\s*Number\(this\.skippedCount/);
  assert.match(buffer, /isPlaybackReadyForStory/);
  assert.match(audio, /isPlaybackReadyForStory/);
  const toggle = audio.match(/export function togglePlayState\(\)[\s\S]*?\n}\nwindow\.togglePlayState/)?.[0] || '';
  assert.doesNotMatch(toggle, /BufferManager\.isActive\)\s*\{/,
    'runway enforcement must survive a paused/failed cache worker');
  assert.doesNotMatch(toggle, /queue\s*&&\s*window\.BufferManager\.queue\[0\]/,
    'the final in-flight paragraph must not make the cache session disappear');
  const stop = buffer.match(/\n  stop\(\) \{[\s\S]*?\n  },\n\n  resume\(\)/)?.[0] || '';
  assert.doesNotMatch(stop, /this\.(?:totalToCache|cachedCount|skippedCount)\s*=\s*0/,
    'stopping an incomplete cache must retain the playback runway guard');
});

test('cache lifecycle always releases keep-alive resources and MessageChannel ports', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  const audio = await read('public/assets/js/audio_core.js');
  const finish = audio.match(/function _finishStory\(\)[\s\S]*?\n}\n\nexport function skipParagraph/)?.[0] || '';
  assert.match(finish, /stopBgKeepAlive\(\)/);
  assert.match(finish, /_scheduleWorkerIdleRelease\(\)/);
  // The unthrottled hop moved out of _scheduleLoop into _messageChannelHop when
  // the scheduler learned to keep its backoff on unfocused-but-visible pages.
  // What matters is unchanged: wherever a MessageChannel is created for the
  // cache loop, both ports are closed once it fires.
  const hop = buffer.match(/_messageChannelHop\(gen\) \{[\s\S]*?\n  },/)?.[0] || '';
  assert.match(hop, /new MessageChannel\(\)/);
  assert.match(hop, /channel\.port1\.close\(\)/);
  assert.match(hop, /channel\.port2\.close\(\)/);
  assert.equal((buffer.match(/new MessageChannel\(\)/g) || []).length, 1,
    'the cache loop should create its MessageChannel in exactly one place');
});

test('stopped or superseded cache loops cannot write into a later run', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  const stop = buffer.match(/\n  stop\(\) \{[\s\S]*?\n  },\n\n  resume\(\)/)?.[0] || '';
  const loop = buffer.match(/\n  async _loop\(gen\)[\s\S]*?\n  },\n\n  _showModalStatus/)?.[0] || '';
  assert.match(stop, /this\._generation\+\+/);
  assert.match(loop, /gen !== this\._generation \|\| !this\.isActive/g);
  assert.ok((loop.match(/gen !== this\._generation \|\| !this\.isActive/g) || []).length >= 3,
    'cache loops must re-check cancellation after async storage/model/synthesis work');
});

test('mobile playback uses the media element path and paused audio resumes in place', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const play = audio.match(/async function _playGeneratedAudio[\s\S]*?\n}\n\nasync function _playWebSpeech/)?.[0] || '';
  assert.match(play, /_preferDirectMobileMediaPlayback\(\)/);
  assert.match(audio, /_resumePausedPocketAudio/);
  const toggle = audio.match(/export function togglePlayState\(\)[\s\S]*?\n}\nwindow\.togglePlayState/)?.[0] || '';
  assert.match(toggle, /_resumePausedPocketAudio\(\)/);
});

test('storage failures are fail-visible and quota eviction waits for commit', async () => {
  const source = await read('public/assets/js/storage_core.js');
  const saveAudio = source.match(/export async function saveAudioChunk[\s\S]*?export async function getAudioChunk/)?.[0] || '';
  const saveStory = source.match(/export async function saveStoryChapters[\s\S]*?window\._saveStoryChapters/)?.[0] || '';
  const evict = source.match(/export async function evictOldAudioChunks[\s\S]*?window\.evictOldAudioChunks/)?.[0] || '';
  assert.doesNotMatch(saveAudio, /catch \(e\)\s*\{\s*return;\s*\}/);
  assert.doesNotMatch(saveStory, /catch \(e\)\s*\{\s*return;\s*\}/);
  assert.match(evict, /tx\.oncomplete\s*=\s*\(\)\s*=>\s*resolve/);
  const cursorHandler = evict.match(/req\.onsuccess[\s\S]*?req\.onerror/)?.[0] || '';
  assert.doesNotMatch(cursorHandler, /\bresolve\(\)/,
    'eviction must not report completion before deletes commit');
});

test('service-worker cache quota failures never turn a successful network response into a 503', async () => {
  const source = await read('public/sw.js');
  const update = source.match(/function updateAppCache[\s\S]*?function withNarrationIsolation/)?.[0] || '';
  assert.match(update, /\.catch\(function \(error\)/);
  assert.match(update, /return null/);
});

test('runtime code uses the Supabase cloud API without legacy Anvil globals', async () => {
  for (const file of [
    'public/assets/js/supabase_bridge.js',
    'public/assets/js/cinematic_ui.js',
    'public/assets/js/library_manager.js',
    'public/assets/js/settings_manager.js',
    'public/assets/js/sync_core.js',
    'public/assets/js/ui_controller.js',
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /window\.anvil[A-Z]/, `${file} still uses a retired Anvil global`);
  }
  const bridge = await read('public/assets/js/supabase_bridge.js');
  assert.match(bridge, /window\.pocketCloud\s*=/);
});

test('worker smoke tooling targets the current static app and creates its output directory', async () => {
  const source = await read('tools/smoke_pocket_worker_runtime.mjs');
  assert.match(source, /mkdirSync/);
  assert.match(source, /\/sw\.js\?v=/);
  assert.match(source, /\/assets\/js\/pocket_worker\.js\?v=/);
  assert.doesNotMatch(source, /_\/api\/serviceworker|_\/theme\//);
  const webkit = await read('tests/webkit-smoke/smoke.mjs');
  assert.match(webkit, /pocket-reader-f2y\.pages\.dev/);
  assert.doesNotMatch(webkit, /hot-wiry-raven/);
});

test('stored narration cleanup removes embedded AO3 notes, summaries, and end notes', async () => {
  const source = await read('public/assets/js/storage_core.js');
  assert.match(source, /_sanitizeNarrationParagraphs/);
  assert.match(source, /chapter\\s\+end\\s\+notes/i);
  assert.match(source, /see\\s\+the\\s\+end\\s\+of\\s\+the\\s\+chapter\\s\+for\\s\+more\\s\+notes/i);
  assert.match(source, /posted\\s\+originally\\s\+on\\s\+the\\s\+archive\\s\+of\\s\+our\\s\+own/i);
});
