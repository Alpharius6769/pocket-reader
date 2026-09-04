import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── The sidebar showed the PREVIOUS story's chapters ─────────────────────────
// A reader tab's content is only built inside switchReaderTab, i.e. when the
// user taps the tab. Opening a second story rebuilt the reader body and left
// whichever tab was already open holding the last story's markup -- so the
// jump list offered another book's chapters, and using it moved the story
// actually being read. Switching tabs (or reloading) cleared it, which is why
// it looked intermittent.

test('loading a story re-renders whichever reader tab is on screen', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(ui, /function _refreshActiveReaderTab\(\) \{/);
  // Driven from the one funnel every story load passes through.
  const render = ui.slice(ui.indexOf('export function renderFullStory('), ui.indexOf('window.renderFullStory = renderFullStory;'));
  assert.match(render, /_refreshActiveReaderTab\(\);/);
  // Only the visible tab can be stale -- the others re-render on the way in.
  assert.match(ui, /\['chapters', 'bookmarks'\]\s*\n?\s*\.find\(\(name\) => document\.getElementById\(`tab-btn-\$\{name\}`\)\?\.classList\.contains\('active'\)\)/);
});

// ── Stop has to mean stop ────────────────────────────────────────────────────
// The MediaSession 'stop' action was bound to pausePlayback, which leaves the
// metadata published -- so the lock-screen / Control Centre entry survived
// being stopped, and pressing an entry focuses whichever app OWNS the audio
// session. Inside another app's in-app browser that is that app, so Stop
// appeared to launch it.

test("the media-session stop action releases the session, it does not pause", async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /bind\('stop', \(\) => releaseAudioSession\(\)\);/);
  assert.ok(
    !/bind\('stop', \(\) => \{ if \(window\.isPlaying\) window\.pausePlayback\?\.\(\); \}\);/.test(audio),
    'stop must no longer be an alias for pause',
  );
  // Pause is still pause: a paused session keeps its metadata so the listener
  // can resume from the lock screen.
  assert.match(audio, /bind\('pause', \(\) => \{ if \(window\.isPlaying\) window\.pausePlayback\?\.\(\); \}\);/);
});

test('releasing the session stops both silent keep-alive loops', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const fn = audio.slice(
    audio.indexOf('export function releaseAudioSession()'),
    audio.indexOf('window.releaseAudioSession = releaseAudioSession;'),
  );
  assert.ok(fn.length > 0, 'releaseAudioSession not found');
  // stopBgKeepAlive refuses to touch these while isPlaying is true, which is
  // right for a pause and wrong for every way a session can end. They are what
  // keeps iOS treating the page as an active player.
  assert.match(fn, /for \(const element of \[_bgKeepAlive, _premiumAudio\]\)/);
  assert.match(fn, /navigator\.mediaSession\.playbackState = 'none';/);
  assert.match(fn, /navigator\.mediaSession\.metadata = null;/);
  assert.match(fn, /window\.isPlaying = false;/);
});

test('a page that is really going away releases the session', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(
    audio,
    /window\.addEventListener\('pagehide', \(event\) => \{\s*\n\s*if \(event\.persisted\) return;\s*\n\s*releaseAudioSession\(\);/,
  );
});

test('a finished story takes its Now Playing entry down', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const fn = audio.slice(audio.indexOf('function _finishStory()'), audio.indexOf('export function skipParagraph('));
  assert.ok(fn.length > 0, '_finishStory not found');
  assert.match(fn, /releaseAudioSession\(\);/);
});

// A released session must stay released. stopBgKeepAlive and the
// visibilitychange handler both call _updateMediaSession(false) routinely, and
// republishing there would put the entry back seconds after Stop removed it.
test('a released session is not republished by a routine false update', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const fn = audio.slice(audio.indexOf('function _updateMediaSession(playing)'), audio.indexOf('window._updateMediaSession ='));
  assert.match(fn, /if \(!playing\) \{[\s\S]*?if \(navigator\.mediaSession\.playbackState === 'none'\) return;/);
});
