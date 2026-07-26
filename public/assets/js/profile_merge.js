/**
 * Schema-v3 profile normalisation and merge.
 *
 * A faithful port of Server_code.py's _normalize_profile / _merge_profile and
 * their helpers, which ran inside an Anvil serializable transaction. See
 * MIGRATION_PLAN.md Phase 4.
 *
 * WHY THIS RUNS CLIENT-SIDE NOW
 * Anvil executed the merge on the server. Here it runs in the browser and the
 * result is committed through commit_user_profile(), a Postgres compare-and-swap
 * keyed on `revision`: if another device wrote first, the commit returns nothing
 * and the caller re-reads and re-merges. That reproduces the property that
 * mattered (concurrent devices cannot silently clobber each other) without
 * needing a deployed Edge Function.
 *
 * The trade-off, stated plainly: the merge is no longer server-enforced, so a
 * buggy or stale client could write a poorly merged profile into its OWN row.
 * Row Level Security still makes it impossible to touch anyone else's data, and
 * a user could always write nonsense to their own profile anyway, so this costs
 * integrity-against-own-bugs, not security.
 *
 * Kept dependency-free and side-effect-free so it can be unit-tested in Node.
 */

export const PROFILE_SCHEMA_VERSION = 3;
export const MAX_PROFILE_BYTES = 1024 * 1024;
const MAX_HISTORY_ITEMS = 250;

const DEVICE_ONLY_SETTINGS = new Set([
  'maxWorkers', 'enableManualWorkers', 'enableNvidiaWebGPU', 'enableAMDWorkarounds', '_engineManuallySet',
  'lowMemoryMode', 'cacheLimitMb', 'storageBudgetMb', 'pocketQualityMode',
  'dataSaver', 'lastDeviceProfile', 'diagnosticLevel',
]);

const STORY_FIELD_GROUPS = {
  metadata: ['title', 'author', 'url', 'sourceUrl', 'source_url', 'tags', 'fandoms', 'summary', 'wordCount',
    'chapterCount', 'cover', 'publishedChapters', 'declaredChapters', 'updateSubscribed', 'workComplete'],
  progress: ['progressChapter', 'progressParagraph', 'isFinished', 'lastRead'],
  favorite: ['favorite', 'isFavorite'],
  rating: ['userRating'],
  bookmarks: ['bookmarks'],
  narration: ['narrationPreset'],
  collections: ['collectionIds', 'queueIndex'],
};

const WITHDRAWN_TITLE_HASHES = new Set([2097602949, 4010063105, 498652239, 3528427211]);
const WITHDRAWN_AUTHOR_HASHES = new Set([1741912528]);
const WITHDRAWN_FILE_HASHES = new Set([586215127, 4227966908]);

const PROFILE_FIELDS = ['displayName', 'userCategory', 'favoriteGenre', 'favoriteFandom', 'favoriteCharacter',
  'preferredLength', 'readingMood', 'currentlyReading', 'favoriteStories', 'companion'];

const MAX_SAFE = 9007199254740991;
const nowMs = () => Date.now();
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

function normalizeBookmarks(bookmarks) {
  const out = [];
  for (const item of Array.isArray(bookmarks) ? bookmarks : []) {
    if (!isPlainObject(item)) continue;
    const stamp = asInt(item.updatedAt ?? item.ts, nowMs(), 0);
    out.push({ ...item, id: String(item.id ?? `b_${item.c ?? 0}_${item.p ?? 0}_${stamp}`), updatedAt: stamp });
  }
  return out.slice(-100);
}

function normalizeAchievements(value) {
  const result = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item === 'string') {
      result.set(item, { id: item, unlockedAt: 0 });
    } else if (isPlainObject(item) && item.id) {
      const key = String(item.id);
      const stamp = asInt(item.unlockedAt, 0, 0);
      const current = result.get(key);
      // Earliest unlock wins, matching the Anvil merge.
      if (!current || stamp < asInt(current.unlockedAt, stamp, 0)) result.set(key, { id: key, unlockedAt: stamp });
    }
  }
  return [...result.values()];
}

function parseProfile(profileData) {
  let parsed = profileData;
  for (let i = 0; i < 2; i += 1) {
    if (typeof parsed !== 'string') break;
    const raw = parsed.trim();
    if (!raw) return {};
    if (new TextEncoder().encode(raw).length > MAX_PROFILE_BYTES) throw new Error('Profile payload is too large');
    try { parsed = JSON.parse(raw); } catch (_) { throw new Error('profile_data must be valid JSON'); }
  }
  if (parsed == null) return {};
  if (!isPlainObject(parsed)) throw new Error('profile_data must be a JSON object');
  return structuredClone(parsed);
}

export function normalizeProfile(profile, deviceId = null) {
  const value = parseProfile(profile);
  value.schemaVersion = PROFILE_SCHEMA_VERSION;
  value.revision = asInt(value.revision, 0, 0, MAX_SAFE);
  value.updatedAt = asInt(value.updatedAt, nowMs(), 0);
  value.deviceId = String(deviceId || value.deviceId || 'legacy').slice(0, 128);
  delete value.avatar;
  delete value.cloudEmail;
  delete value.isLoggedIn;

  const settings = isPlainObject(value.settings) ? { ...value.settings } : {};
  for (const key of DEVICE_ONLY_SETTINGS) delete settings[key];
  delete settings.siteCookies;
  value.settings = settings;
  value.settingsFieldUpdatedAt = isPlainObject(value.settingsFieldUpdatedAt) ? value.settingsFieldUpdatedAt : {};
  value.profileFieldUpdatedAt = isPlainObject(value.profileFieldUpdatedAt) ? value.profileFieldUpdatedAt : {};
  value.deletedStoryKeys = isPlainObject(value.deletedStoryKeys) ? value.deletedStoryKeys : {};

  const library = [];
  for (const rawStory of Array.isArray(value.library) ? value.library : []) {
    if (!isPlainObject(rawStory) || isWithdrawn(rawStory)) continue;
    const story = { ...rawStory };
    // Bulk content never belongs in the synced profile.
    for (const forbidden of ['chapters', 'chapterText', 'audio', 'audioCache', 'cacheDecision']) delete story[forbidden];
    story.storyKey = storyKeyFor(story);
    const baseStamp = asInt(story.updatedAt ?? story.lastRead ?? story.addedAt, value.updatedAt, 0);
    const sync = isPlainObject(story.sync) ? { ...story.sync } : {};
    for (const group of Object.keys(STORY_FIELD_GROUPS)) sync[group] = asInt(sync[group], baseStamp, 0);
    story.sync = sync;
    story.bookmarks = normalizeBookmarks(story.bookmarks);
    const stamps = Object.values(sync);
    story.updatedAt = stamps.length ? Math.max(...stamps) : baseStamp;
    library.push(story);
  }
  value.library = library;
  value.achievements = normalizeAchievements(value.achievements);
  value.statsByDevice = isPlainObject(value.statsByDevice) ? value.statsByDevice : {};
  value.dailyStatsByDevice = isPlainObject(value.dailyStatsByDevice) ? value.dailyStatsByDevice : {};
  if (!Object.keys(value.statsByDevice).length && isPlainObject(value.stats)) {
    value.statsByDevice[value.deviceId] = { ...value.stats };
  }
  value.activityDays = [...new Set((value.activityDays || []).filter(Boolean).map(String))].sort().slice(-800);
  value.collections = Array.isArray(value.collections) ? value.collections : [];
  value.history = Array.isArray(value.history) ? value.history : [];
  value.readingQueue = Array.isArray(value.readingQueue) ? value.readingQueue : [];
  value.readingQueueUpdatedAt = asInt(value.readingQueueUpdatedAt, value.updatedAt, 0);
  value.goals = isPlainObject(value.goals) ? value.goals : {};
  if (compactSize(value) > MAX_PROFILE_BYTES) throw new Error('Profile payload is too large');
  return value;
}

function mergeClockedMap(cloudValues, incomingValues, cloudClocks, incomingClocks) {
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

function mergeBookmarks(cloudItems, incomingItems) {
  const merged = new Map(normalizeBookmarks(cloudItems).map((i) => [i.id, { ...i }]));
  for (const item of normalizeBookmarks(incomingItems)) {
    const current = merged.get(item.id);
    if (!current || asInt(item.updatedAt, 0, 0) >= asInt(current.updatedAt, 0, 0)) merged.set(item.id, { ...item });
  }
  return [...merged.values()].sort((a, b) => asInt(a.updatedAt, 0, 0) - asInt(b.updatedAt, 0, 0)).slice(-100);
}

function mergeStory(cloudStory, incomingStory) {
  const result = { ...(cloudStory || {}) };
  const cloudSync = { ...((cloudStory || {}).sync || {}) };
  const incomingSync = { ...((incomingStory || {}).sync || {}) };
  for (const [group, fields] of Object.entries(STORY_FIELD_GROUPS)) {
    const incomingStamp = asInt(incomingSync[group], 0, 0);
    if (incomingStamp >= asInt(cloudSync[group], 0, 0)) {
      if (group === 'bookmarks') {
        result.bookmarks = mergeBookmarks(result.bookmarks, incomingStory.bookmarks);
      } else {
        for (const field of fields) {
          if (Object.prototype.hasOwnProperty.call(incomingStory, field)) result[field] = incomingStory[field];
        }
      }
      cloudSync[group] = incomingStamp;
    }
  }
  result.storyKey = incomingStory.storyKey || (cloudStory || {}).storyKey;
  result.sync = cloudSync;
  const stamps = Object.values(cloudSync);
  result.updatedAt = stamps.length ? Math.max(...stamps) : nowMs();
  return result;
}

export function mergeProfile(cloudProfile, incomingProfile, deviceId) {
  const cloud = normalizeProfile(cloudProfile || {}, deviceId);
  const incoming = normalizeProfile(incomingProfile || {}, deviceId);
  const result = { ...cloud };

  const pick = (src) => Object.fromEntries(PROFILE_FIELDS.filter((k) => k in src).map((k) => [k, src[k]]));
  const [mergedValues, profileClocks] = mergeClockedMap(
    pick(cloud), pick(incoming), cloud.profileFieldUpdatedAt, incoming.profileFieldUpdatedAt,
  );
  Object.assign(result, mergedValues);
  result.profileFieldUpdatedAt = profileClocks;
  [result.settings, result.settingsFieldUpdatedAt] = mergeClockedMap(
    cloud.settings, incoming.settings, cloud.settingsFieldUpdatedAt, incoming.settingsFieldUpdatedAt,
  );

  const deleted = { ...(cloud.deletedStoryKeys || {}) };
  for (const [key, stamp] of Object.entries(incoming.deletedStoryKeys || {})) {
    deleted[key] = Math.max(asInt(stamp, 0, 0), asInt(deleted[key], 0, 0));
  }
  result.deletedStoryKeys = deleted;

  const stories = new Map(cloud.library.map((s) => [s.storyKey, s]));
  for (const story of incoming.library) {
    const key = story.storyKey;
    // A deletion tombstone newer than the incoming edit wins: the story stays deleted.
    if (asInt(deleted[key], 0, 0) >= asInt(story.updatedAt, 0, 0)) { stories.delete(key); continue; }
    stories.set(key, mergeStory(stories.get(key) || {}, story));
  }
  result.library = [...stories.entries()]
    .filter(([key, story]) => asInt(deleted[key], 0, 0) < asInt(story.updatedAt, 0, 0) && !isWithdrawn(story))
    .map(([, story]) => story);

  const achievements = new Map();
  for (const item of [...cloud.achievements, ...incoming.achievements]) {
    const key = item.id;
    const stamp = asInt(item.unlockedAt, 0, 0);
    const current = achievements.get(key);
    if (!current || stamp < asInt(current.unlockedAt, stamp, 0)) achievements.set(key, { ...item });
  }
  result.achievements = [...achievements.values()];

  const statsByDevice = {};
  for (const source of [cloud.statsByDevice, incoming.statsByDevice]) {
    for (const [device, counters] of Object.entries(source || {})) {
      const target = (statsByDevice[String(device)] ||= {});
      if (!isPlainObject(counters)) continue;
      for (const [key, val] of Object.entries(counters)) {
        if (typeof val === 'number') target[key] = Math.max(val, target[key] ?? 0);
      }
    }
  }
  result.statsByDevice = statsByDevice;

  const dailyByDevice = {};
  for (const source of [cloud.dailyStatsByDevice, incoming.dailyStatsByDevice]) {
    if (!isPlainObject(source)) continue;
    for (const [device, days] of Object.entries(source)) {
      if (!isPlainObject(days)) continue;
      const targetDays = (dailyByDevice[String(device)] ||= {});
      for (const [day, counters] of Object.entries(days)) {
        if (!isPlainObject(counters)) continue;
        const target = (targetDays[String(day).slice(0, 10)] ||= {});
        for (const [key, val] of Object.entries(counters)) {
          if (typeof val === 'number') target[key] = Math.max(val, target[key] ?? 0);
        }
      }
      for (const oldDay of Object.keys(targetDays).sort().slice(0, -400)) delete targetDays[oldDay];
    }
  }
  result.dailyStatsByDevice = dailyByDevice;
  result.activityDays = [...new Set([...cloud.activityDays, ...incoming.activityDays])].sort().slice(-800);

  const aggregate = {};
  const maxKeys = ['streak', 'speedadjusted', 'first', 'curatedauthor', 'dayssincefirst'];
  for (const counters of Object.values(statsByDevice)) {
    for (const [key, val] of Object.entries(counters)) {
      if (typeof val !== 'number') continue;
      // Monotonic counters take the max across devices; everything else sums.
      if (maxKeys.some((m) => key.toLowerCase().startsWith(m))) aggregate[key] = Math.max(val, aggregate[key] ?? 0);
      else aggregate[key] = (aggregate[key] ?? 0) + val;
    }
  }
  aggregate.favorites = result.library.filter((s) => s.favorite || s.isFavorite).length;
  aggregate.unread = result.library.filter((s) => !s.progressChapter && !s.progressParagraph && !s.isFinished).length;
  aggregate.hoursListened = Number(aggregate.totalWords ?? 0) / 9000;
  aggregate.distinctDays = result.activityDays.length;
  result.stats = aggregate;

  for (const [listName, identity] of [['collections', 'id'], ['history', 'id']]) {
    const merged = new Map();
    for (const item of [...(cloud[listName] || []), ...(incoming[listName] || [])]) {
      if (!isPlainObject(item)) continue;
      const id = String(item[identity] ?? '');
      if (!id) continue;
      const current = merged.get(id);
      const stampOf = (o) => asInt(o.updatedAt ?? o.lastAt, 0, 0);
      if (!current || stampOf(item) >= stampOf(current)) merged.set(id, { ...item });
    }
    const values = [...merged.values()].filter((item) => !item.deletedAt);
    result[listName] = listName === 'history' ? values.slice(-MAX_HISTORY_ITEMS) : values;
  }

  if (asInt(incoming.readingQueueUpdatedAt, 0, 0) >= asInt(cloud.readingQueueUpdatedAt, 0, 0)) {
    result.readingQueue = [...new Set((incoming.readingQueue || []).filter(Boolean).map(String))].slice(0, 500);
    result.readingQueueUpdatedAt = asInt(incoming.readingQueueUpdatedAt, 0, 0);
  } else {
    result.readingQueue = cloud.readingQueue || [];
    result.readingQueueUpdatedAt = asInt(cloud.readingQueueUpdatedAt, 0, 0);
  }

  result.goals = asInt((incoming.goals || {}).updatedAt, 0, 0) >= asInt((cloud.goals || {}).updatedAt, 0, 0)
    ? (incoming.goals || {}) : (cloud.goals || {});
  result.schemaVersion = PROFILE_SCHEMA_VERSION;
  result.deviceId = String(deviceId || incoming.deviceId || 'legacy').slice(0, 128);
  result.updatedAt = nowMs();
  return normalizeProfile(result, result.deviceId);
}
