// Guards for playback and caching continuing with the screen off.
//
// The constraint everything here follows from: a backgrounded mobile tab gets
// almost no JS time. The one dependable window is the short burst after a media
// event, and iOS will reject play() outside it. So anything required to keep
// audio flowing across a paragraph boundary has to be ready *before* the
// boundary arrives, and the boundary handler must spend its window on playback
// rather than bookkeeping.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(p, 'utf8');

test('the next paragraph is resolved before the boundary, not inside it', async () => {
  const source = await read('public/assets/js/audio_core.js');
  assert.match(source, /async function _preloadNextParagraphAudio/);
  // Kicked off once the current paragraph is actually playing, when the tab
  // still has normal execution time.
  assert.match(source, /await window\.currentAudio\.play\(\);[\s\S]{0,400}?_preloadNextParagraphAudio\(\)/);
  // Claimed synchronously — no storage round-trip on the hot path.
  assert.match(source, /let audioBlob = _takePreloadedParagraph\(/);
});

test('a preloaded paragraph is only used for the paragraph it was fetched for', async () => {
  // Indices can move while the preload is awaiting (a skip, or an early end).
  // A stale entry must be ignored rather than played out of order.
  const source = await read('public/assets/js/audio_core.js');
  assert.match(source, /_preloadKey = \(storyRef, chapIdx, paraIdx, voice\)/);
  assert.match(source, /_paragraphPreload\.key !== _preloadKey\(/);
  assert.match(source, /_discardParagraphPreload\(\);[\s\S]{0,200}_activePocketStream\?\.stop/,
    'a manual jump must drop the preloaded blob');
});

test('the paragraph-end handler starts audio before bookkeeping', async () => {
  // Stats, streak tracking and the achievement sweep used to run first, burning
  // the post-`ended` window before the next paragraph was even requested.
  const source = await read('public/assets/js/audio_core.js');
  const handler = source.match(/function _handleParagraphEnd\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(handler, '_handleParagraphEnd must exist');
  const playAt = handler.indexOf('playCurrentParagraph()');
  const statsAt = handler.indexOf('recordDailyActivity');
  assert.ok(playAt > 0 && statsAt > 0, 'handler must both play and record');
  assert.ok(playAt < statsAt,
    'playback must be started before daily/achievement bookkeeping runs');
});

test('background caching escapes hidden-tab timer throttling', async () => {
  // Chrome clamps chained setTimeout to 1s on a hidden page, and to once per
  // MINUTE after five minutes hidden. A MessageChannel hop is never throttled.
  const source = await read('public/assets/js/buffer_manager.js');
  assert.match(source, /_messageChannelHop/);
  assert.match(source, /if \(document\.hidden\)[\s\S]{0,300}_messageChannelHop/);
  assert.match(source, /new MessageChannel\(\)/);
});

test('the silent keep-alive is armed inside the user gesture, not on hide', async () => {
  // startBgKeepAlive() calls play(). Deferring it until visibilitychange means
  // calling play() on an already-hidden page, which iOS can refuse — leaving
  // nothing to stop the process being suspended.
  const buffer = await read('public/assets/js/buffer_manager.js');
  const startCaching = (buffer.match(/window\.startCaching = async function[\s\S]*?\n};/)?.[0] || '')
    // Strip line comments first — this function's own comment explains the
    // await boundary, and matching that word would compare against prose.
    .split(/\r?\n/).filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.match(startCaching, /startBgKeepAlive/);
  const keepAliveAt = startCaching.indexOf('startBgKeepAlive');
  const firstAwaitAt = startCaching.search(/\bawait\s+\w/);
  assert.ok(firstAwaitAt > 0, 'startCaching should contain an await to guard against');
  assert.ok(keepAliveAt < firstAwaitAt,
    'the keep-alive must be armed before the first await surrenders the gesture');

  const audio = await read('public/assets/js/audio_core.js');
  const toggle = audio.match(/export function togglePlayState\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(toggle, /startBgKeepAlive\(\)/);
});

test('the playback lookahead keeps running while the screen is off', async () => {
  // Partially cached and live listening depend on it staying ahead of the
  // cursor while hidden; a document.hidden bail here would stall narration at
  // the first uncached paragraph after a lock.
  const source = await read('public/assets/js/audio_core.js');
  const yieldFn = source.match(/function _lookaheadShouldYield\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(yieldFn, '_lookaheadShouldYield must exist');
  assert.doesNotMatch(yieldFn, /document\.hidden|visibilityState/,
    'the lookahead must not stand down just because the page is hidden');
});

test('narration plays through a media element, never a Web Audio graph, on mobile', async () => {
  // iOS suspends an AudioContext on screen lock while a bare media element
  // stays eligible for OS-controlled playback — this is the whole reason mobile
  // does not use the streaming path.
  const source = await read('public/assets/js/audio_core.js');
  assert.match(source, /_preferDirectMobileMediaPlayback/);
  // The gate now also requires Pocket: Kokoro returns a whole utterance in one
  // pass, so a segment stream would collect nothing and be torn down again.
  assert.match(source, /if \(engine === 'pocket' && !_preferDirectMobileMediaPlayback\(\)\)[\s\S]{0,400}_createPocketPcmStream/);
});
