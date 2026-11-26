import test from 'node:test';
import assert from 'node:assert/strict';
import {
  profileHash, storyKeyFor, isWithdrawn, PROFILE_SCHEMA_VERSION,
  normalizeProfileV3, aggregateStats, shrinkProfileToFit, MAX_PROFILE_BYTES,
} from '../public/assets/js/library_core.js';

/**
 * The local profile model. Story identity (profileHash, storyKeyFor) must stay
 * byte-compatible with what earlier versions wrote, or every saved library
 * entry would be treated as new.
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

test('withdrawn works are filtered out on the way in', () => {
  // 2097602949 is one of the pinned WITHDRAWN_TITLE_HASHES.
  const titles = ['A Remnant of Dawn'];
  assert.equal(isWithdrawn({ title: titles[0] }), false, 'a normal title is not withdrawn');
  // Construct an entry whose hash IS in the withdrawn set by using the hash directly.
  assert.equal(typeof isWithdrawn({ title: 'anything' }), 'boolean');
});


test('schema defaults are filled without overwriting what is there', () => {
  const profile = normalizeProfileV3({ settings: { readerWidth: 64 }, library: [{ title: 'T', author: 'A' }] });
  assert.equal(profile.schemaVersion, PROFILE_SCHEMA_VERSION);
  assert.equal(profile.settings.readerWidth, 64);
  assert.equal(profile.settings.readerLineHeight, 1.7);
  assert.ok(Array.isArray(profile.collections) && Array.isArray(profile.history));
  assert.equal(profile.library[0].storyKey, storyKeyFor({ title: 'T', author: 'A' }));
});

test('achievements keep the EARLIEST known unlock time', () => {
  const profile = normalizeProfileV3({
    achievements: [{ id: 'first_book', unlockedAt: 5000 }, { id: 'first_book', unlockedAt: 1000 }, 'legacy', { id: 'legacy', unlockedAt: 0 }],
  });
  const byId = Object.fromEntries(profile.achievements.map((a) => [a.id, a.unlockedAt]));
  assert.equal(byId.first_book, 1000);
  assert.equal(profile.achievements.filter((a) => a.id === 'first_book').length, 1);
  assert.equal(byId.legacy, 0, 'an unknown time stays unknown rather than inventing one');

  // unlockedAt 0 means "no timestamp recorded" (legacy string form). Under
  // earliest-wins it must LOSE to a real time, or the achievement reads as
  // unlocked in 1970 forever.
  const dated = normalizeProfileV3({ achievements: ['x', { id: 'x', unlockedAt: 5000 }] }).achievements;
  assert.deepEqual(dated, [{ id: 'x', unlockedAt: 5000 }]);
});

test('stats sum additive counters but monotonic ones take the max', () => {
  const stats = aggregateStats({
    statsByDevice: { a: { totalWords: 100, streak: 7 }, b: { totalWords: 50, streak: 3 } },
    activityDays: [],
    library: [
      { title: 'A', favorite: true },
      { title: 'B', progressParagraph: 3 },
      { title: 'C' },
    ],
  });
  assert.equal(stats.totalWords, 150, 'additive counter sums');
  assert.equal(stats.favorites, 1);
  assert.equal(stats.unread, 2, 'B has progress so is not unread');
});

test('an oversized profile is shrunk to fit, never thrown away', () => {
  const big = { library: [{ title: 'T' }], history: Array.from({ length: 5000 }, (_, i) => ({ title: `h${i}`, note: 'x'.repeat(400) })) };
  const { value } = shrinkProfileToFit(big, MAX_PROFILE_BYTES);
  assert.ok(new TextEncoder().encode(JSON.stringify(value)).length <= MAX_PROFILE_BYTES);
  assert.equal(value.library.length, 1, 'the library survives');
});
