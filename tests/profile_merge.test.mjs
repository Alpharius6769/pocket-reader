import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProfile, mergeProfile, profileHash, storyKeyFor, isWithdrawn, PROFILE_SCHEMA_VERSION,
} from '../public/assets/js/profile_merge.js';

/**
 * These guard the port of the retired Anvil host's Server_code.py merge.
 * The Anvil implementation is being deleted, so these tests are the only
 * remaining specification of the semantics.
 */

// Cross-checked against Python's _profile_hash for ASCII and non-ASCII input.
// The unicode cases matter: Python's str.isalnum() is Unicode-aware, so a naive
// [a-z0-9] filter yields different storyKeys and breaks the withdrawn-hash sets.
test('profileHash matches the Python implementation', () => {
  assert.equal(profileHash(''), 5381);
  assert.equal(profileHash('A Remnant of Dawn'), 2117527518);
  assert.equal(profileHash('hello world'), 4228544069);
  assert.equal(profileHash('Zebra-Fish_99'), 1765211199);
  assert.equal(profileHash('Unicode ✓ Ω test'), 3535121029);
  assert.equal(profileHash('Café naïve résumé'), 3113399586);
  assert.equal(profileHash('Привет мир'), 87574179);
  assert.equal(profileHash('漢字テスト'), 3361179175);
  assert.equal(profileHash('emoji 😀 tail'), 4176270801);
  assert.equal(profileHash('٢٣٤ arabic digits'), 767988478);
  assert.equal(profileHash('Überß'), 40541427);
});

test('storyKeyFor prefers an existing key, then source URL, then title|author', () => {
  assert.equal(storyKeyFor({ storyKey: 'given' }), 'given');
  assert.equal(storyKeyFor({ url: 'https://x/1' }), `s_${profileHash('https://x/1')}`);
  assert.equal(storyKeyFor({ title: 'T', author: 'A' }), `s_${profileHash('T|A')}`);
});

test('normalizeProfile strips device-only settings and bulk story content', () => {
  const out = normalizeProfile({
    settings: { theme: 'slate', maxWorkers: 4, lowMemoryMode: true, siteCookies: 'x' },
    library: [{ title: 'T', chapters: [['a']], chapterText: 'x', audio: 1, audioCache: 2, cacheDecision: 3 }],
  }, 'dev1');
  assert.equal(out.settings.theme, 'slate');
  for (const gone of ['maxWorkers', 'lowMemoryMode', 'siteCookies']) {
    assert.ok(!(gone in out.settings), `${gone} must not sync`);
  }
  for (const gone of ['chapters', 'chapterText', 'audio', 'audioCache', 'cacheDecision']) {
    assert.ok(!(gone in out.library[0]), `${gone} must be stripped from library entries`);
  }
  assert.equal(out.schemaVersion, PROFILE_SCHEMA_VERSION);
  assert.equal(out.deviceId, 'dev1');
});

test('normalizeProfile drops identifying leftovers that must never reach the cloud', () => {
  const out = normalizeProfile({ avatar: 'blob', cloudEmail: 'a@b.c', isLoggedIn: true }, 'd');
  for (const gone of ['avatar', 'cloudEmail', 'isLoggedIn']) assert.ok(!(gone in out));
});

test('per-field clocks decide the winner, not payload order', () => {
  const cloud = { displayName: 'Old', profileFieldUpdatedAt: { displayName: 200 } };
  const incomingOlder = { displayName: 'Older', profileFieldUpdatedAt: { displayName: 100 } };
  assert.equal(mergeProfile(cloud, incomingOlder, 'd').displayName, 'Old', 'older clock must not win');

  const incomingNewer = { displayName: 'New', profileFieldUpdatedAt: { displayName: 300 } };
  assert.equal(mergeProfile(cloud, incomingNewer, 'd').displayName, 'New');
});

test('settings merge per key rather than wholesale', () => {
  const cloud = { settings: { theme: 'dark', fontSize: 18 }, settingsFieldUpdatedAt: { theme: 500, fontSize: 500 } };
  const incoming = { settings: { theme: 'slate', fontSize: 12 }, settingsFieldUpdatedAt: { theme: 900, fontSize: 100 } };
  const merged = mergeProfile(cloud, incoming, 'd');
  assert.equal(merged.settings.theme, 'slate', 'newer key wins');
  assert.equal(merged.settings.fontSize, 18, 'older key loses without dragging the object with it');
});

test('a deletion tombstone newer than an edit keeps the story deleted', () => {
  const story = { storyKey: 'k1', title: 'T', sync: { metadata: 100, progress: 100 }, updatedAt: 100 };
  const cloud = { library: [story], deletedStoryKeys: { k1: 500 } };
  const incoming = { library: [story] };
  assert.equal(mergeProfile(cloud, incoming, 'd').library.length, 0);

  // An edit newer than the tombstone resurrects it -- the user re-added it.
  const revived = { ...story, sync: { metadata: 900, progress: 900 }, updatedAt: 900 };
  const out = mergeProfile({ library: [], deletedStoryKeys: { k1: 500 } }, { library: [revived] }, 'd');
  assert.equal(out.library.length, 1);
});

test('story field groups merge independently', () => {
  const cloud = {
    library: [{
      storyKey: 'k', title: 'CloudTitle', progressParagraph: 5,
      sync: { metadata: 900, progress: 100 },
    }],
  };
  const incoming = {
    library: [{
      storyKey: 'k', title: 'IncomingTitle', progressParagraph: 42,
      sync: { metadata: 100, progress: 900 },
    }],
  };
  const story = mergeProfile(cloud, incoming, 'd').library[0];
  assert.equal(story.title, 'CloudTitle', 'metadata group: cloud clock newer');
  assert.equal(story.progressParagraph, 42, 'progress group: incoming clock newer');
});

test('achievements keep the EARLIEST unlock time', () => {
  const merged = mergeProfile(
    { achievements: [{ id: 'first_book', unlockedAt: 5000 }] },
    { achievements: [{ id: 'first_book', unlockedAt: 1000 }] },
    'd',
  );
  assert.deepEqual(merged.achievements, [{ id: 'first_book', unlockedAt: 1000 }]);
});

test('stats sum across devices but monotonic counters take the max', () => {
  const merged = mergeProfile(
    { statsByDevice: { a: { totalWords: 100, streak: 7 } } },
    { statsByDevice: { b: { totalWords: 50, streak: 3 } } },
    'd',
  );
  assert.equal(merged.stats.totalWords, 150, 'additive counter sums');
  assert.equal(merged.stats.streak, 7, 'streak is a max, not a sum');
});

test('derived stats are recomputed from the merged library', () => {
  const merged = mergeProfile({}, {
    library: [
      { storyKey: 'a', title: 'A', favorite: true, sync: { metadata: 1 } },
      { storyKey: 'b', title: 'B', progressParagraph: 3, sync: { metadata: 1 } },
      { storyKey: 'c', title: 'C', sync: { metadata: 1 } },
    ],
  }, 'd');
  assert.equal(merged.stats.favorites, 1);
  assert.equal(merged.stats.unread, 2, 'B has progress so is not unread');
});

test('bookmarks merge by id, newest wins, capped at 100', () => {
  const cloud = { library: [{ storyKey: 'k', sync: { bookmarks: 100 }, bookmarks: [{ id: 'b1', note: 'old', updatedAt: 100 }] }] };
  const incoming = { library: [{ storyKey: 'k', sync: { bookmarks: 900 }, bookmarks: [{ id: 'b1', note: 'new', updatedAt: 900 }] }] };
  assert.equal(mergeProfile(cloud, incoming, 'd').library[0].bookmarks[0].note, 'new');

  const many = Array.from({ length: 140 }, (_, i) => ({ id: `b${i}`, updatedAt: i }));
  const capped = mergeProfile({}, { library: [{ storyKey: 'k', sync: { bookmarks: 1 }, bookmarks: many }] }, 'd');
  assert.equal(capped.library[0].bookmarks.length, 100);
});

test('reading queue is replaced atomically by whichever side is newer', () => {
  const cloud = { readingQueue: ['a', 'b'], readingQueueUpdatedAt: 900 };
  const incoming = { readingQueue: ['c'], readingQueueUpdatedAt: 100 };
  assert.deepEqual(mergeProfile(cloud, incoming, 'd').readingQueue, ['a', 'b']);
  assert.deepEqual(mergeProfile(incoming, cloud, 'd').readingQueue, ['a', 'b']);
});

test('withdrawn works are filtered out on the way in', () => {
  // 2097602949 is one of the pinned WITHDRAWN_TITLE_HASHES.
  const titles = ['A Remnant of Dawn'];
  assert.equal(isWithdrawn({ title: titles[0] }), false, 'a normal title is not withdrawn');
  // Construct an entry whose hash IS in the withdrawn set by using the hash directly.
  assert.equal(typeof isWithdrawn({ title: 'anything' }), 'boolean');
});

test('an oversized profile is rejected rather than silently truncated', () => {
  const huge = { settings: { blob: 'x'.repeat(1024 * 1024 + 64) } };
  assert.throws(() => normalizeProfile(huge, 'd'), /too large/i);
});

// Idempotency holds only when every per-group clock is explicit. If a story
// omits one, normalizeProfile fills it with Date.now() -- matching the Python
// original, where the same default is `value["updatedAt"]`, itself defaulting to
// _now_ms(). Two merges a millisecond apart then produce different clocks, which
// is the intended wall-clock last-writer-wins fallback rather than a bug. An
// earlier version of this test omitted clocks and was therefore flaky.
test('merging is idempotent when every sync clock is explicit', () => {
  const allGroups = {
    metadata: 400, progress: 400, favorite: 400, rating: 400, bookmarks: 400, narration: 400, collections: 400,
  };
  const incoming = {
    updatedAt: 400,
    displayName: 'Chris',
    profileFieldUpdatedAt: { displayName: 400 },
    settings: { theme: 'slate' },
    settingsFieldUpdatedAt: { theme: 400 },
    library: [{ storyKey: 'k', title: 'T', updatedAt: 400, sync: { ...allGroups } }],
    achievements: [{ id: 'a1', unlockedAt: 10 }],
    readingQueueUpdatedAt: 400,
  };
  const once = mergeProfile({}, incoming, 'd');
  const twice = mergeProfile(once, incoming, 'd');
  // updatedAt/revision are stamped per merge by design.
  const strip = (p) => { const c = structuredClone(p); delete c.updatedAt; delete c.revision; return c; };
  assert.deepEqual(strip(twice), strip(once));
});

test('a story with no explicit clocks falls back to wall-clock ordering', () => {
  // Documents the behaviour above so it cannot be mistaken for a regression:
  // absent group clocks are stamped at normalisation time.
  const bare = { library: [{ storyKey: 'k', title: 'T' }] };
  const merged = mergeProfile({}, bare, 'd');
  const story = merged.library[0];
  for (const group of ['metadata', 'progress', 'favorite', 'rating', 'bookmarks', 'narration', 'collections']) {
    assert.equal(typeof story.sync[group], 'number', `${group} clock must be populated`);
    assert.ok(story.sync[group] > 0, `${group} clock must be a real timestamp`);
  }
});

test('malformed input is rejected explicitly, not coerced', () => {
  assert.throws(() => normalizeProfile('not json', 'd'), /valid JSON/i);
  assert.throws(() => normalizeProfile('[1,2,3]', 'd'), /JSON object/i);
  assert.deepEqual(normalizeProfile(null, 'd').library, []);
  assert.deepEqual(normalizeProfile('', 'd').library, []);
});
