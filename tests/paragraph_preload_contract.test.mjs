// The next-paragraph preload is the thing that keeps narration alive once the
// phone locks: with the screen off, the only JS a backgrounded tab reliably
// gets is the short window after a media event, and an IndexedDB open + read +
// blob decode does not fit inside it. So the next paragraph is resolved while
// the current one still plays and handed over synchronously at the boundary.
//
// It fails SILENTLY when it breaks. A stale key derivation just means the
// lookup always misses, the slot is never staged, and playback quietly falls
// back to the storage read it was built to avoid -- which works on a desk and
// dies in a pocket. It also spent a release looking broken for exactly this
// reason: a verification harness seeded the cache WITHOUT the prosody tag, the
// preload correctly missed, and the preload got the blame.
//
// Confirmed staging in-browser against a seeded chunk: with the tag included
// the slot fills (4096 bytes under 'key::0::1::alba_neutral'); without it, it
// does not. These guard the invariants that made the difference.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

const slice = (source, from, to) => {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `could not find ${from}`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `could not find ${to} after ${from}`);
  return source.slice(start, end);
};

test('preload and playback derive the cache key the same way', async () => {
  // The failure this prevents is total and invisible: if the two ever disagree
  // about the key, every preload lookup misses forever, the slot is never
  // staged, and locked-screen playback silently reverts to reading storage
  // inside the media-event window.
  const source = await read('public/assets/js/audio_core.js');
  const preload = slice(source, 'async function _preloadNextParagraphAudio()', 'window._preloadNextParagraphAudio =');
  const playback = slice(source, 'let audioBlob = _takePreloadedParagraph(', 'if (!(audioBlob instanceof Blob)');

  for (const [name, block] of [['preload', preload], ['playback', playback]]) {
    assert.match(block, /for \(const tag of _prosodyCacheTagVariants\(engine\)\)/,
      `${name} must iterate the prosody tag variants`);
    assert.match(block, /cleanVoice \+ tag/,
      `${name} must fold the prosody tag into the voice key`);
  }
  // Both fall back to the bare title when the stable key finds nothing, so a
  // story cached before it had a stable key still resolves.
  for (const [name, block] of [['preload', preload], ['playback', playback]]) {
    assert.match(block, /storyRef !== title/, `${name} must try the legacy title key`);
  }
});

test('the preload resolves its voice through the same sentiment router as playback', async () => {
  const source = await read('public/assets/js/audio_core.js');
  const preload = slice(source, 'async function _preloadNextParagraphAudio()', 'window._preloadNextParagraphAudio =');
  assert.match(preload, /resolveVoiceWithSentiment\(engine, selVoice, text, \{/,
    'a preload that picks a different emotion than playback stages the wrong audio');
  // Against the NEXT paragraph's indices, not the current one's -- staging the
  // current paragraph's emotion would be a guaranteed miss on every boundary.
  assert.match(preload, /chapIdx: next\.c, paraIdx: next\.p/);
});

test('the preload uses the resolved engine, never a hardcoded one', async () => {
  // Pinning 'pocket' here would rewrite every Kokoro voice into a Pocket
  // emotion asset and read a cache key nothing ever writes -- the same bug
  // that already cost the playback lookahead a release.
  const source = await read('public/assets/js/audio_core.js');
  const preload = slice(source, 'async function _preloadNextParagraphAudio()', 'window._preloadNextParagraphAudio =');
  assert.match(preload, /const engine = _resolveActiveEngine\(\);/);
  assert.doesNotMatch(preload, /'pocket'/, 'the preload must not name an engine literal');
});

test('a staged paragraph is only ever claimed for the paragraph it was staged for', async () => {
  const source = await read('public/assets/js/audio_core.js');
  const take = slice(source, 'function _takePreloadedParagraph(', 'function _discardParagraphPreload(');
  // Keyed on story, chapter, paragraph AND voice, so a skip or a voice change
  // mid-chapter cannot hand the wrong audio to the wrong paragraph.
  assert.match(take, /_paragraphPreload\.key !== _preloadKey\(storyRef, chapIdx, paraIdx, voice\)/);
  assert.match(take, /return null;/);
  // Claiming clears the slot: a blob must never be played twice.
  assert.match(take, /_paragraphPreload = null;/);
  // And a truncated or empty blob is refused rather than played as silence.
  assert.match(take, /blob\.size >= 100/);
});

test('the preload is strictly additive -- playback still works if it never stages', async () => {
  // This is what makes the preload safe to ship without a device: when the slot
  // is empty the original storage lookup runs unchanged, so the worst case is
  // that it is inert, not that it breaks playback.
  const source = await read('public/assets/js/audio_core.js');
  const playback = slice(source, 'let audioBlob = _takePreloadedParagraph(', 'if (!(audioBlob instanceof Blob)');
  assert.match(playback, /if \(!audioBlob\) \{/,
    'the storage path must remain reachable when nothing was staged');
});

test('the preload is fired while the current paragraph plays, not at the boundary', async () => {
  const source = await read('public/assets/js/audio_core.js');
  // Called AFTER play() resolves on the current paragraph -- that is the window
  // with normal execution time. Firing it from the `ended` handler instead
  // would put the storage read back inside the window it exists to avoid.
  const afterPlay = slice(source, 'await window.currentAudio.play();', 'Play-start latency telemetry');
  assert.match(afterPlay, /_preloadNextParagraphAudio\(\);/);
});

test('the preload slot is observable, because background failure is invisible', async () => {
  // The phone is in a pocket and nobody is watching a console, so "is the next
  // paragraph actually staged?" has to be answerable after the fact.
  const source = await read('public/assets/js/audio_core.js');
  assert.match(source, /window\.inspectPocketPreload = \(\) =>/);
  assert.match(source, /staged: true, key: _paragraphPreload\.key, bytes:/);
});
