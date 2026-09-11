import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const between = (source, from, to) => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `could not find ${from}`);
  return source.slice(start, source.indexOf(to, start + from.length));
};

// ── Settings > Download backup failed silently with a long story open ──────
//
// It serialised window.userProfile whole into a data: URL. The open story's
// library entry carries its full text and the avatar is base64, and Chrome
// will not download a data: URL much past 2 MB. Restore discards both fields.

test('the JSON backup is a Blob download without story text or avatar', async () => {
  const lib = await read('public/assets/js/library_manager.js');
  const fn = between(lib, 'export function downloadBackup()', 'window.downloadBackup = downloadBackup;');
  assert.ok(!fn.includes('data:text/json'), 'a data: URL fails past ~2 MB in Chrome');
  assert.match(fn, /URL\.createObjectURL\(new Blob\(/);
  assert.match(fn, /const \{ avatar, \.\.\.rest \} = window\.userProfile/);
  assert.match(fn, /\.map\(\(\{ chapters, \.\.\.story \}\) => story\)/);
  assert.match(fn, /URL\.revokeObjectURL\(url\)/);
});

// ── A chapter-list jump could be undone by the next sync ────────────────────

test('jumping to a chapter or bookmark stamps the progress clock', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  const fn = between(ui, 'export function jumpToBookmark(c, p)', 'window.jumpToBookmark = jumpToBookmark;');
  const stamp = fn.indexOf("window.stampStorySyncField?.(libStory, 'progress');");
  assert.ok(stamp > 0, 'the jump must advance the progress clock');
  assert.ok(stamp > fn.indexOf('libStory.progressParagraph = p;'));
  assert.ok(stamp < fn.indexOf('window.saveLocalData()'), 'stamp before the save that queues the sync');
});

// ── Away Mode stuck on "Preparing Away Mode..." after a storage failure ────

test('Away Mode treats a storage failure as a miss instead of throwing', async () => {
  const buf = await read('public/assets/js/buffer_manager.js');
  const fn = between(buf, "btn.innerHTML = 'Preparing Away Mode...';", 'window.precacheQueue = requestedQueue.filter');
  assert.match(fn, /await window\._loadStoryChapters\(stableRef, story\)\.catch\(\(\) => null\);/);
  assert.match(fn, /await window\._loadStoryChapters\(storyTitle, story\)\.catch\(\(\) => null\);/);
  assert.ok(!/await window\._loadStoryChapters\([^)]*\);/.test(fn), 'every chapter read in the loop must be caught');
});
