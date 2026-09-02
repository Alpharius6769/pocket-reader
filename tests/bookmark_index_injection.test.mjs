// Bookmark chapter/paragraph indices reach inline click handlers in an
// UNQUOTED position, which makes them JavaScript source rather than data.
//
//   onclick="window.openLibraryBookmark(decodeURIComponent('...'), ${bm.c}, ${bm.p})"
//
// Every string in that markup is carefully escaped -- the story ref goes through
// encodeURIComponent(...).replace(/'/g,'%27'), which even closes the apostrophe
// that encodeURIComponent leaves alone. None of that reaches these two, because
// escaping applies to data and these are code.
//
// Proven before the fix: c = "0);window.__PR_XSS_FIRED=true;//" rendered
//   window.openLibraryBookmark(decodeURIComponent('poison-key'), 0);window.__PR_XSS_FIRED=true;//, 0)
// and executed on tap.
//
// Reachable because import restores localStorage under a DENYLIST and
// pocketReaderData is not on it, so a backup file from anyone becomes the
// profile. The payload runs in the app origin, where pr_supabase_session_v1
// holds the access and refresh tokens -- account takeover, not defacement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const merge = await import('../public/assets/js/profile_merge.js');

const PAYLOAD = '0);window.__PR_XSS_FIRED=true;//';

test('normalisation coerces bookmark indices to numbers', () => {
  const profile = merge.normalizeProfile({
    library: [{
      title: 'x',
      bookmarks: [
        { id: 'a', c: PAYLOAD, p: PAYLOAD, ts: 1 },
        { id: 'b', c: '7', p: '8', ts: 1 },
        { id: 'c', c: 3, p: 4, ts: 1 },
        { id: 'd', ts: 1 },
        { id: 'e', c: null, p: undefined, ts: 1 },
        { id: 'f', c: {}, p: [], ts: 1 },
      ],
    }],
  });
  for (const bm of profile.library[0].bookmarks) {
    assert.equal(typeof bm.c, 'number', `c must be a number, got ${JSON.stringify(bm.c)}`);
    assert.equal(typeof bm.p, 'number', `p must be a number, got ${JSON.stringify(bm.p)}`);
    assert.ok(Number.isFinite(bm.c) && Number.isFinite(bm.p), 'and finite');
  }
  const [poisoned, stringy, numeric] = profile.library[0].bookmarks;
  assert.equal(poisoned.c, 0, 'a payload string carries no numeric value and falls to 0');
  assert.equal(stringy.c, 7, 'a legitimate numeric string still parses');
  assert.equal(numeric.c, 3);
});

test('the generated id cannot carry a payload either', () => {
  // The id is built from c and p and is itself interpolated into markup.
  const profile = merge.normalizeProfile({
    library: [{ title: 'x', bookmarks: [{ c: PAYLOAD, p: PAYLOAD, ts: 1 }] }],
  });
  const { id } = profile.library[0].bookmarks[0];
  assert.doesNotMatch(id, /[();]/, `a generated id must not contain JS punctuation: ${id}`);
  assert.match(id, /^b_\d+_\d+_\d+$/);
});

test('no bookmark index reaches an inline handler uncoerced', async () => {
  // The sink-side half. Both files build the handler string themselves, so the
  // guarantee has to hold at the point of interpolation as well as upstream --
  // normalisation runs on load, and a render can be reached with an object that
  // never went through it.
  for (const rel of ['public/assets/js/library_manager.js', 'public/assets/js/ui_controller.js']) {
    const source = await read(rel);
    assert.doesNotMatch(source, /\$\{bm\.c\}/, `${rel} interpolates bm.c raw`);
    assert.doesNotMatch(source, /\$\{bm\.p\}/, `${rel} interpolates bm.p raw`);
    assert.doesNotMatch(source, /\$\{bm\.c \+ 1\}/, `${rel} interpolates bm.c raw in the label`);
    assert.match(source, /const chapIdx = Number\(bm\.c\) \|\| 0;/, `${rel} must coerce the chapter index`);
    assert.match(source, /const paraIdx = Number\(bm\.p\) \|\| 0;/, `${rel} must coerce the paragraph index`);
  }
});

test('the escaped string arguments beside them stay escaped', async () => {
  // The fix must not have disturbed the neighbouring defence: encodeURIComponent
  // leaves the apostrophe alone, and an apostrophe terminates the single-quoted
  // JS string these sit in. Every such site has to add the %27 replacement.
  const library = await read('public/assets/js/library_manager.js');
  for (const name of ['safeStoryRef', 'bookmarkId', 'storyKey']) {
    const definition = library.match(new RegExp(`const ${name} = encodeURIComponent\\([^;]*;`));
    assert.ok(definition, `${name} must be encoded`);
    assert.match(definition[0], /replace\(\/'\/g, ?["']%27["']\)/,
      `${name} must also escape the apostrophe encodeURIComponent leaves`);
  }
});
