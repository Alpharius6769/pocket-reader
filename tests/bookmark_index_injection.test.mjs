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
// profile. The payload runs in the app origin with full access to the reader's
// library and settings. normalizeProfileV3 (library_core) runs on every load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const core = await import('../public/assets/js/library_core.js');

const PAYLOAD = '0);window.__PR_XSS_FIRED=true;//';

test('normalisation coerces bookmark indices to numbers', () => {
  const profile = core.normalizeProfileV3({
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
  const profile = core.normalizeProfileV3({
    library: [{ title: 'x', bookmarks: [{ c: PAYLOAD, p: PAYLOAD, ts: 1 }] }],
  });
  const { id } = profile.library[0].bookmarks[0];
  assert.doesNotMatch(id, /[();]/, `a generated id must not contain JS punctuation: ${id}`);
  assert.match(id, /^b_\d+_\d+_\d+$/);
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
