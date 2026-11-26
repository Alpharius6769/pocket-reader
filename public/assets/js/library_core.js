/**
 * The local profile model: schema-v3 normalisation, story identity, stats.
 *
 * Pocket Reader v2 keeps everything on the device (accounts and cloud sync
 * were retired). This module is what remains of profile_merge.js and the
 * local half of sync_core.js:
 *
 *   - story identity (storyKeyFor, profileHash) and the withdrawn-story filter
 *   - shrinkProfileToFit, which keeps a saved profile under its size cap
 *   - mergeClockedMap, the per-field newest-wins merge used for backups
 *   - normalizeProfileV3, the schema defaults every saved profile goes through
 *   - per-device stats, streaks and day buckets (incrementDeviceStat, ...)
 *
 * Pure functions first, so the identity and size code can be tested in Node;
 * the few window globals at the bottom are published only in a browser.
 */
import { isMobileLikePlatform } from './pocket_backend_policy.js?v=backend-v64';
import { prLocal } from './safe_storage.js?v=safe-storage-v1';

export const PROFILE_SCHEMA_VERSION = 3;
export const MAX_PROFILE_BYTES = 1024 * 1024;

const WITHDRAWN_TITLE_HASHES = new Set([2097602949, 4010063105, 498652239, 3528427211]);
const WITHDRAWN_AUTHOR_HASHES = new Set([1741912528]);
const WITHDRAWN_FILE_HASHES = new Set([586215127, 4227966908]);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Mirrors Python _as_int: coerce, then clamp. Non-numeric falls back to default. */
function asInt(value, fallback = 0, minimum = null, maximum = null) {
  let n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) n = Number.parseInt(fallback, 10);
  if (!Number.isFinite(n)) n = 0;
  if (minimum !== null) n = Math.max(minimum, n);
  if (maximum !== null) n = Math.min(maximum, n);
  return n;
}

/**
 * djb2-xor over alphanumeric-lowercased input, masked to 32 bits.
 * Must match Server_code.py _profile_hash exactly or story keys change and
 * every library entry would be treated as new.
 */
export function profileHash(value) {
  // \p{L}\p{N} (not [a-z0-9]) because Python's str.isalnum() is Unicode-aware:
  // it keeps letters like "Ω"/"ω" and non-ASCII digits. Stripping them here
  // produced a DIFFERENT hash for any title containing accented, Greek,
  // Cyrillic or CJK characters -- which would mean different storyKeys and
  // silently non-matching WITHDRAWN_*_HASHES. Verified against Python for
  // ASCII and non-ASCII inputs.
  const normalized = String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let result = 5381;
  for (const ch of normalized) {
    // >>> 0 keeps this an unsigned 32-bit value, matching Python's & 0xFFFFFFFF.
    result = (((result << 5) + result) ^ ch.codePointAt(0)) >>> 0;
  }
  return result;
}

const storyFilename = (value) => String(value ?? '').split('?')[0].replace(/\\/g, '/').split('/').pop();

export function isWithdrawn(story) {
  if (!isPlainObject(story)) return false;
  if (WITHDRAWN_TITLE_HASHES.has(profileHash(story.title))) return true;
  if (WITHDRAWN_AUTHOR_HASHES.has(profileHash(story.author ?? story.creator))) return true;
  for (const key of ['url', 'id', 'sourceUrl', 'source_url', 'filename', 'file']) {
    if (WITHDRAWN_FILE_HASHES.has(profileHash(storyFilename(story[key])))) return true;
  }
  return false;
}

const compactSize = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

export function storyKeyFor(story) {
  const existing = String(story.storyKey ?? '').trim();
  if (existing) return existing.slice(0, 200);
  const source = story.sourceUrl || story.source_url || story.url || story.id
    || `${story.title ?? ''}|${story.author ?? ''}`;
  return `s_${profileHash(source)}`;
}

// Absolute refusal point for a payload we have not parsed yet. This is a
// sanity bound against a pathological input, NOT the storage target: a profile
// between MAX_PROFILE_BYTES and this is parsed and then pruned down to fit by
// shrinkProfileToFit(). Rejecting at the storage target meant a library that
// simply grew past 1 MB could never be read or written again.

/**
 * Bring an oversized profile under MAX_PROFILE_BYTES by shedding regenerable
 * data, heaviest and least valuable first.
 *
 * Previously normalizeProfile simply threw once a profile passed 1 MB. Because
 * mergeProfile ends by calling it, a user whose library grew past the cap got a
 * permanent sync failure: syncProfile threw, flushCloudSync went to its
 * exponential backoff, and every later attempt failed identically with a
 * message offering no way out. Nothing pruned, so it could never recover.
 *
 * Only DERIVED data is dropped -- reading history, day buckets and activity
 * stamps, all of which regenerate as the user reads. Library entries,
 * bookmarks, collections and settings are user-authored and are never trimmed
 * to make room; if the irreducible core alone still exceeds the cap we throw,
 * because silently deleting someone's bookmarks would be far worse than a
 * loud failure.
 */
export function shrinkProfileToFit(value, maxBytes = MAX_PROFILE_BYTES) {
  if (compactSize(value) <= maxBytes) return { value, pruned: [] };
  const pruned = [];

  const trimDailyStats = (keepDays) => {
    for (const days of Object.values(value.dailyStatsByDevice || {})) {
      if (!isPlainObject(days)) continue;
      for (const day of Object.keys(days).sort().slice(0, -keepDays)) delete days[day];
    }
  };

  const steps = [
    ['history', () => { value.history = (value.history || []).slice(-100); }],
    ['dailyStats', () => trimDailyStats(120)],
    ['activityDays', () => { value.activityDays = (value.activityDays || []).slice(-400); }],
    ['history', () => { value.history = (value.history || []).slice(-25); }],
    ['dailyStats', () => trimDailyStats(30)],
    ['activityDays', () => { value.activityDays = (value.activityDays || []).slice(-180); }],
    ['history', () => { value.history = []; }],
    ['dailyStats', () => { value.dailyStatsByDevice = {}; }],
  ];

  for (const [label, apply] of steps) {
    apply();
    if (!pruned.includes(label)) pruned.push(label);
    if (compactSize(value) <= maxBytes) return { value, pruned };
  }

  throw new Error(
    `Profile payload is too large: ${value.library.length} stories still exceed the `
    + `${Math.round(maxBytes / 1024)} KB sync limit after pruning reading history and stats. `
    + 'Remove some stories from your library to resume syncing.',
  );
}

export function mergeClockedMap(cloudValues, incomingValues, cloudClocks, incomingClocks) {
  const values = { ...(cloudValues || {}) };
  const clocks = { ...(cloudClocks || {}) };
  for (const [key, incomingValue] of Object.entries(incomingValues || {})) {
    const incomingStamp = asInt((incomingClocks || {})[key], 0, 0);
    if (incomingStamp >= asInt(clocks[key], 0, 0)) {
      values[key] = incomingValue;
      clocks[key] = incomingStamp;
    }
  }
  return [values, clocks];
}

// ── Local profile model (from sync_core.js) ─────────────────────────────────
//
// The schema defaults, device identity and per-device counters that the
// library, achievements, streaks and weekly goals all read. Field clocks
// (story.sync, settingsFieldUpdatedAt) are still stamped: mergeClockedMap
// resolves a restored backup against the live profile with them.

const STORY_GROUP_FIELDS = Object.freeze({
  metadata: ['title', 'author', 'url', 'sourceUrl', 'source_url', 'tags', 'fandoms', 'summary', 'wordCount', 'chapterCount', 'cover', 'publishedChapters', 'declaredChapters', 'updateSubscribed', 'workComplete'],
  progress: ['progressChapter', 'progressParagraph', 'isFinished', 'lastRead'],
  favorite: ['favorite', 'isFavorite'],
  rating: ['userRating'],
  bookmarks: ['bookmarks'],
  narration: ['narrationPreset'],
  collections: ['collectionIds', 'queueIndex'],
});

function now() { return Date.now(); }

// LOCAL calendar-day key (YYYY-MM-DD). All day-bucketed data -- activityDays
// (streak), dailyStatsByDevice (weekly goals / recap) -- must key on the same
// local basis; mixing this with toISOString() (UTC) silently mis-buckets days
// for users at non-zero UTC offsets. See recordDailyActivity in library_manager.
export function localDayKey(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function randomId(prefix) {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function getDeviceId() {
  let id = prLocal.getItem('pr_device_id');
  if (!id) {
    id = randomId('device');
    prLocal.setItem('pr_device_id', id);
  }
  return id;
}

function defaultMotionPreset() {
  // iPad must land on 'standard', not 'cinematic': it reports a desktop UA but
  // runs mobile-class thermals, and cinematic motion is a real heat/battery cost.
  const mobile = isMobileLikePlatform(globalThis.navigator?.userAgent || '');
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return reduced ? 'reduced' : (mobile ? 'standard' : 'cinematic');
}

function normalizeAchievement(item) {
  if (typeof item === 'string') return { id: item, unlockedAt: 0 };
  if (!item || typeof item !== 'object' || !item.id) return null;
  return { ...item, id: String(item.id), unlockedAt: Number(item.unlockedAt) || 0 };
}

// Collapse duplicate ids, keeping the earliest KNOWN unlock time. unlockedAt 0
// means "no timestamp recorded" (legacy string-form achievements), so it must
// lose to any real time rather than pinning the achievement to the epoch.
function dedupeAchievements(items) {
  const byId = new Map();
  for (const entry of items) {
    const current = byId.get(entry.id);
    if (!current) { byId.set(entry.id, entry); continue; }
    const a = Number(current.unlockedAt) || 0;
    const b = Number(entry.unlockedAt) || 0;
    const unlockedAt = !a ? b : (!b ? a : Math.min(a, b));
    byId.set(entry.id, { ...current, ...entry, unlockedAt });
  }
  return [...byId.values()];
}

// Bookmark indices are interpolated into inline click handlers in an UNQUOTED
// position, so they are code, not data: c = "0);evil();//" would execute on
// tap. A restored backup file is untrusted input, and this runs on every load,
// so they are forced to finite non-negative integers here as well as at each
// render site (see tests/bookmark_index_injection.test.mjs).
function bookmarkIndex(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeLocalBookmarks(items = []) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && typeof item === 'object').map((item) => {
    const stamp = Math.trunc(Number(item.updatedAt || item.ts)) || now();
    const c = bookmarkIndex(item.c);
    const p = bookmarkIndex(item.p);
    return {
      ...item,
      c,
      p,
      id: item.id ? String(item.id) : `b_${c}_${p}_${stamp}`,
      updatedAt: stamp,
    };
  }).slice(-100);
}

export function normalizeProfileV3(input) {
  let profile = input;
  for (let i = 0; i < 2 && typeof profile === 'string'; i += 1) {
    try { profile = JSON.parse(profile); } catch (_) { profile = {}; }
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) profile = {};
  profile.schemaVersion = PROFILE_SCHEMA_VERSION;
  profile.revision = Math.max(0, Number(profile.revision) || 0);
  profile.deviceId = getDeviceId();
  profile.updatedAt = Number(profile.updatedAt) || now();
  profile.settings = profile.settings && typeof profile.settings === 'object' ? profile.settings : {};
  profile.settings.motionPreset = ['off', 'reduced', 'standard', 'cinematic'].includes(profile.settings.motionPreset)
    ? profile.settings.motionPreset : defaultMotionPreset();
  profile.settings.companionFrequency = ['quiet', 'contextual', 'expressive'].includes(profile.settings.companionFrequency)
    ? profile.settings.companionFrequency : 'contextual';

  profile.settings.readerWidth = Number(profile.settings.readerWidth) || 78;
  profile.settings.readerLineHeight = Number(profile.settings.readerLineHeight) || 1.7;
  profile.settings.paragraphSpacing = Number(profile.settings.paragraphSpacing) || 1.15;
  profile.settingsFieldUpdatedAt = profile.settingsFieldUpdatedAt && typeof profile.settingsFieldUpdatedAt === 'object' ? profile.settingsFieldUpdatedAt : {};
  profile.profileFieldUpdatedAt = profile.profileFieldUpdatedAt && typeof profile.profileFieldUpdatedAt === 'object' ? profile.profileFieldUpdatedAt : {};
  profile.deletedStoryKeys = profile.deletedStoryKeys && typeof profile.deletedStoryKeys === 'object' ? profile.deletedStoryKeys : {};
  profile.collections = Array.isArray(profile.collections) ? profile.collections : [];
  profile.history = Array.isArray(profile.history) ? profile.history.slice(-250) : [];
  profile.readingQueue = Array.isArray(profile.readingQueue) ? profile.readingQueue : [];
  profile.readingQueueUpdatedAt = Number(profile.readingQueueUpdatedAt) || profile.updatedAt;
  profile.goals = profile.goals && typeof profile.goals === 'object' ? profile.goals : { weeklyMinutes: 120, weeklyChapters: 0, streakEnabled: true, updatedAt: now() };
  profile.activityDays = Array.isArray(profile.activityDays) ? [...new Set(profile.activityDays)].sort().slice(-800) : [];
  profile.statsByDevice = profile.statsByDevice && typeof profile.statsByDevice === 'object' ? profile.statsByDevice : {};
  profile.dailyStatsByDevice = profile.dailyStatsByDevice && typeof profile.dailyStatsByDevice === 'object' ? profile.dailyStatsByDevice : {};
  if (!Object.keys(profile.statsByDevice).length && profile.stats && typeof profile.stats === 'object') {
    profile.statsByDevice[getDeviceId()] = { ...profile.stats };
  }
  profile.achievements = dedupeAchievements(
    (Array.isArray(profile.achievements) ? profile.achievements : []).map(normalizeAchievement).filter(Boolean),
  );
  profile.library = (Array.isArray(profile.library) ? profile.library : []).filter((story) => story && typeof story === 'object').map((story) => {
    const base = Number(story.updatedAt || story.lastRead || story.addedAt) || now();
    const sync = story.sync && typeof story.sync === 'object' ? story.sync : {};
    Object.keys(STORY_GROUP_FIELDS).forEach((group) => { sync[group] = Number(sync[group]) || base; });
    return { ...story, storyKey: storyKeyFor(story), bookmarks: normalizeLocalBookmarks(story.bookmarks), sync, updatedAt: Math.max(...Object.values(sync)) };
  });
  return profile;
}

export function stampProfileField(field) {
  const profile = normalizeProfileV3(globalThis.userProfile);
  profile.profileFieldUpdatedAt[field] = now();
  profile.updatedAt = now();
}

export function stampSetting(field) {
  const profile = normalizeProfileV3(globalThis.userProfile);
  profile.settingsFieldUpdatedAt[field] = now();
  profile.updatedAt = now();
}

export function stampStory(story, group) {
  if (!story) return;
  story.storyKey = storyKeyFor(story);
  story.sync = story.sync && typeof story.sync === 'object' ? story.sync : {};
  story.sync[group] = now();
  story.updatedAt = story.sync[group];
}

export function aggregateStats(profile) {
  const total = {};
  Object.values(profile.statsByDevice || {}).forEach((counters) => {
    Object.entries(counters || {}).forEach(([key, value]) => {
      if (typeof value !== 'number') return;
      if (/^(streak|speedAdjusted|first|curatedAuthor|daysSinceFirst)/i.test(key)) total[key] = Math.max(total[key] || 0, value);
      else total[key] = (total[key] || 0) + value;
    });
  });
  const library = Array.isArray(profile.library) ? profile.library : [];
  total.favorites = library.filter((story) => story.favorite || story.isFavorite).length;
  total.unread = library.filter((story) => !story.progressChapter && !story.progressParagraph && !story.isFinished).length;
  total.genres = new Set(library.flatMap((story) => Array.isArray(story.tags) ? story.tags : [])).size;
  total.hoursListened = Number(total.totalWords || 0) / 9000;
  total.distinctDays = (profile.activityDays || []).length;
  let streak = 0;
  const daySet = new Set(profile.activityDays || []);
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  // activityDays are stored as LOCAL calendar dates (see recordDailyActivity),
  // so the streak cursor must be formatted the same way (localDayKey). Using
  // toISOString() here compared local-midnight against its UTC date, which for
  // any positive UTC offset (most of Europe/Asia/Australia) is the PREVIOUS
  // day -- zeroing the streak for the majority of users outside the Americas.
  while (daySet.has(localDayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  total.streak = streak;
  return total;
}

export function incrementDeviceStat(key, amount = 1) {
  const profile = normalizeProfileV3(globalThis.userProfile || {});
  const deviceId = getDeviceId();
  const counters = profile.statsByDevice[deviceId] ||= {};
  counters[key] = Math.max(0, Number(counters[key]) || 0) + Number(amount || 0);
  if (key === 'totalWords' || key === 'chaptersCompleted') {
    const today = localDayKey(new Date());
    const daily = profile.dailyStatsByDevice[deviceId] ||= {};
    const day = daily[today] ||= {};
    day[key] = Math.max(0, Number(day[key]) || 0) + Number(amount || 0);
  }
  profile.stats = aggregateStats(profile);
  profile.updatedAt = now();
  return counters[key];
}

export function setDeviceStatFlag(key, value = 1) {
  const profile = normalizeProfileV3(globalThis.userProfile || {});
  const deviceId = getDeviceId();
  const counters = profile.statsByDevice[deviceId] ||= {};
  counters[key] = Math.max(Number(counters[key]) || 0, Number(value) || 0);
  profile.stats = aggregateStats(profile);
  profile.updatedAt = now();
  return counters[key];
}

// Existing callers (library_manager, audio_core, reader_features, ...) reach
// these through window; the v2 bridge imports them directly.
if (typeof window !== 'undefined') {
  // Accounts and cloud sync were retired. Their device-local keys (the sign-in
  // session tokens, the account that owned this profile, the pending upload)
  // have no reader any more; leaving a token at rest would be the only trace.
  for (const key of ['pr_supabase_session_v1', 'pr_profile_owner', 'pr_sync_outbox']) {
    prLocal.removeItem(key);
  }
  window.getPocketReaderDeviceId = getDeviceId;
  window.normalizeProfileV3 = normalizeProfileV3;
  window.stampProfileField = stampProfileField;
  window.stampSyncedSetting = stampSetting;
  window.stampStorySyncField = stampStory;
  window.aggregateSyncedStats = aggregateStats;
  window.incrementDeviceStat = incrementDeviceStat;
  window.setDeviceStatFlag = setDeviceStatFlag;
}
