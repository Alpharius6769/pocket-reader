import { isMobileLikePlatform } from './pocket_backend_policy.js?v=backend-v21';

const PROFILE_SCHEMA_VERSION = 3;
const DEVICE_SETTING_KEYS = new Set([
  'maxWorkers', 'enableManualWorkers', '_engineManuallySet',
  'lowMemoryMode', 'cacheLimitMb', 'storageBudgetMb', 'pocketQualityMode',
  'pocketBackend', 'dataSaver', 'lastDeviceProfile', 'diagnosticLevel',
]);
const STORY_GROUP_FIELDS = Object.freeze({
  metadata: ['title', 'author', 'url', 'sourceUrl', 'source_url', 'tags', 'fandoms', 'summary', 'wordCount', 'chapterCount', 'cover', 'publishedChapters', 'declaredChapters', 'updateSubscribed', 'workComplete'],
  progress: ['progressChapter', 'progressParagraph', 'isFinished', 'lastRead'],
  favorite: ['favorite', 'isFavorite'],
  rating: ['userRating'],
  bookmarks: ['bookmarks'],
  narration: ['narrationPreset'],
  collections: ['collectionIds', 'queueIndex'],
});

const SYNC_STATE = {
  status: 'idle',
  pending: false,
  lastSyncedAt: 0,
  lastError: '',
  retryCount: 0,
  timer: null,
  inFlight: null,
};

function now() { return Date.now(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

// LOCAL calendar-day key (YYYY-MM-DD). All day-bucketed data — activityDays
// (streak), dailyStatsByDevice (weekly goals / recap) — must key on the same
// local basis; mixing this with toISOString() (UTC) silently mis-buckets days
// for users at non-zero UTC offsets. See recordDailyActivity in library_manager.
function localDayKey(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function randomId(prefix) {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function getDeviceId() {
  let id = localStorage.getItem('pr_device_id');
  if (!id) {
    id = randomId('device');
    localStorage.setItem('pr_device_id', id);
  }
  return id;
}
window.getPocketReaderDeviceId = getDeviceId;

function defaultMotionPreset() {
  // iPad must land on 'standard', not 'cinematic': it reports a desktop UA but
  // runs mobile-class thermals, and cinematic motion is a real heat/battery cost.
  const mobile = isMobileLikePlatform(navigator.userAgent || '');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
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
// Mirrors earlierUnlock/normalizeAchievements in profile_merge.js.
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

function normalizeBookmarks(items = []) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && typeof item === 'object').map((item) => {
    const stamp = Number(item.updatedAt || item.ts) || now();
    return {
      ...item,
      id: item.id || `b_${Number(item.c) || 0}_${Number(item.p) || 0}_${stamp}`,
      updatedAt: stamp,
    };
  }).slice(-100);
}

function storyStableKey(story) {
  if (story?.storyKey) return story.storyKey;
  if (typeof window.getStoryStableKey === 'function') return window.getStoryStableKey(story);
  const source = story?.sourceUrl || story?.source_url || story?.url || story?.id || `${story?.title || ''}|${story?.author || ''}`;
  let hash = 2166136261;
  for (const char of String(source).toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `s_${hash >>> 0}`;
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
    return { ...story, storyKey: storyStableKey(story), bookmarks: normalizeBookmarks(story.bookmarks), sync, updatedAt: Math.max(...Object.values(sync)) };
  });
  return profile;
}
window.normalizeProfileV3 = normalizeProfileV3;

export function stampProfileField(field) {
  const profile = normalizeProfileV3(window.userProfile);
  profile.profileFieldUpdatedAt[field] = now();
  profile.updatedAt = now();
}
window.stampProfileField = stampProfileField;

export function stampSetting(field) {
  const profile = normalizeProfileV3(window.userProfile);
  profile.settingsFieldUpdatedAt[field] = now();
  profile.updatedAt = now();
}
window.stampSyncedSetting = stampSetting;

export function stampStory(story, group) {
  if (!story) return;
  story.storyKey = storyStableKey(story);
  story.sync = story.sync && typeof story.sync === 'object' ? story.sync : {};
  story.sync[group] = now();
  story.updatedAt = story.sync[group];
}
window.stampStorySyncField = stampStory;

function aggregateStats(profile) {
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
  total.distinctDays = profile.activityDays.length;
  let streak = 0;
  const daySet = new Set(profile.activityDays || []);
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  // activityDays are stored as LOCAL calendar dates (see recordDailyActivity),
  // so the streak cursor must be formatted the same way (localDayKey). Using
  // toISOString() here compared local-midnight against its UTC date, which for
  // any positive UTC offset (most of Europe/Asia/Australia) is the PREVIOUS
  // day — zeroing the streak for the majority of users outside the Americas.
  while (daySet.has(localDayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  total.streak = streak;
  return total;
}
window.aggregateSyncedStats = aggregateStats;

export function incrementDeviceStat(key, amount = 1) {
  const profile = normalizeProfileV3(window.userProfile || {});
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
window.incrementDeviceStat = incrementDeviceStat;

export function setDeviceStatFlag(key, value = 1) {
  const profile = normalizeProfileV3(window.userProfile || {});
  const deviceId = getDeviceId();
  const counters = profile.statsByDevice[deviceId] ||= {};
  counters[key] = Math.max(Number(counters[key]) || 0, Number(value) || 0);
  profile.stats = aggregateStats(profile);
  profile.updatedAt = now();
  return counters[key];
}
window.setDeviceStatFlag = setDeviceStatFlag;

export function buildSyncPayload(profile = window.userProfile) {
  const payload = clone(normalizeProfileV3(profile));
  payload.deviceId = getDeviceId();
  payload.stats = aggregateStats(payload);
  delete payload.avatar;
  delete payload.avatarData;
  delete payload.avatarHash;
  delete payload.cloudEmail;
  delete payload.isLoggedIn;
  payload.library.forEach((story) => {
    delete story.chapters;
    delete story.chapterText;
    delete story.audio;
    delete story.cacheDecision;
  });
  DEVICE_SETTING_KEYS.forEach((key) => delete payload.settings[key]);
  delete payload.settings.siteCookies;
  return payload;
}
window.buildSyncPayloadV3 = buildSyncPayload;

function preserveDeviceState(canonical) {
  const current = normalizeProfileV3(window.userProfile || {});
  const avatar = current.avatar;
  const deviceSettings = {};
  DEVICE_SETTING_KEYS.forEach((key) => { if (key in current.settings) deviceSettings[key] = current.settings[key]; });
  const next = normalizeProfileV3(clone(canonical || {}));
  Object.assign(next.settings, deviceSettings);
  if (avatar) next.avatar = avatar;
  next.isLoggedIn = current.isLoggedIn;
  next.cloudEmail = current.cloudEmail;
  return next;
}

export function applyCanonicalProfile(profile, revision) {
  window.userProfile = preserveDeviceState(profile);
  window.userProfile.revision = Number(revision ?? profile?.revision) || 0;
  window.userProfile.stats = aggregateStats(window.userProfile);
  if (typeof window.saveLocalData === 'function') window.saveLocalData({ skipCloud: true });
  if (typeof window.renderLibrary === 'function') window.renderLibrary(true);
  if (typeof window.renderProfileExtras === 'function') window.renderProfileExtras();
  document.dispatchEvent(new CustomEvent('pr:profile-synced', { detail: { revision: window.userProfile.revision } }));
}
window.applyCanonicalProfile = applyCanonicalProfile;

async function saveOutbox(payload) {
  if (typeof window._saveSyncOutbox === 'function') return window._saveSyncOutbox(payload);
  localStorage.setItem('pr_sync_outbox', JSON.stringify(payload));
}

async function loadOutbox() {
  if (typeof window._loadSyncOutbox === 'function') return window._loadSyncOutbox();
  try { return JSON.parse(localStorage.getItem('pr_sync_outbox') || 'null'); } catch (_) { return null; }
}

async function clearOutbox() {
  if (typeof window._clearSyncOutbox === 'function') return window._clearSyncOutbox();
  localStorage.removeItem('pr_sync_outbox');
}

function publishState() {
  window.cloudSyncState = { ...SYNC_STATE };
  document.dispatchEvent(new CustomEvent('pr:sync-state', { detail: window.cloudSyncState }));
}

export async function flushCloudSync() {
  if (SYNC_STATE.inFlight) return SYNC_STATE.inFlight;
  if (!window._cloudPushAllowed || typeof window.pocketCloud?.syncProfile !== 'function' || !navigator.onLine) return false;
  // Claim the slot SYNCHRONOUSLY, before the first await. The guard above used
  // to be checked before `await loadOutbox()` but set after it, so two of the
  // five triggers (online, visibilitychange, the retry timer, the re-queue
  // timer, queueCloudSync's timer) could both slip through that gap and run two
  // syncProfile commits against the same baseRevision -- one wins the CAS and
  // the other can apply a staler canonical profile over the newer one.
  SYNC_STATE.inFlight = (async () => {
    const pending = await loadOutbox();
    if (!pending) return true;
    SYNC_STATE.status = 'syncing';
    publishState();
    try {
      const result = await window.pocketCloud.syncProfile(pending.profile, pending.baseRevision || 0, getDeviceId());
      if (!result?.profile) throw new Error('Cloud returned an invalid profile.');
      const latest = await loadOutbox();
      if (latest?.queueId && latest.queueId !== pending.queueId) {
        window.userProfile.revision = Number(result.revision) || window.userProfile.revision || 0;
        latest.baseRevision = window.userProfile.revision;
        latest.profile.revision = window.userProfile.revision;
        await saveOutbox(latest);
        SYNC_STATE.status = 'pending';
        SYNC_STATE.pending = true;
        SYNC_STATE.lastError = '';
        publishState();
        clearTimeout(SYNC_STATE.timer);
        SYNC_STATE.timer = setTimeout(flushCloudSync, 100);
        return true;
      }
      applyCanonicalProfile(result.profile, result.revision);
      await clearOutbox();
      SYNC_STATE.status = 'synced';
      SYNC_STATE.pending = false;
      SYNC_STATE.lastSyncedAt = Number(result.syncedAt) || now();
      SYNC_STATE.lastError = '';
      SYNC_STATE.retryCount = 0;
      localStorage.setItem('pr_last_synced_at', String(SYNC_STATE.lastSyncedAt));
      publishState();
      return true;
    } catch (error) {
      SYNC_STATE.status = 'error';
      SYNC_STATE.pending = true;
      SYNC_STATE.lastError = error?.message || String(error);
      SYNC_STATE.retryCount += 1;
      publishState();
      const delay = Math.min(300000, 2000 * (2 ** Math.min(SYNC_STATE.retryCount, 7)));
      clearTimeout(SYNC_STATE.timer);
      SYNC_STATE.timer = setTimeout(flushCloudSync, delay);
      return false;
    } finally {
      SYNC_STATE.inFlight = null;
    }
  })();
  return SYNC_STATE.inFlight;
}
window.flushCloudSync = flushCloudSync;

export async function queueCloudSync(reason = 'profile', options = {}) {
  if (!window._cloudPushAllowed) return false;
  const profile = buildSyncPayload();
  await saveOutbox({ profile, baseRevision: profile.revision || 0, reason, queuedAt: now(), queueId: randomId('sync') });
  SYNC_STATE.pending = true;
  SYNC_STATE.status = navigator.onLine ? 'pending' : 'offline';
  publishState();
  clearTimeout(SYNC_STATE.timer);
  SYNC_STATE.timer = setTimeout(flushCloudSync, options.immediate ? 0 : 1500);
  return true;
}
window.queueCloudSync = queueCloudSync;

export async function pullCloudProfileOnStartup() {
  if (typeof window.pocketCloud?.getCurrentUser !== 'function') return null;
  // Supabase owns the authenticated browser session. This device-local preference
  // only controls whether Pocket Reader resumes that session automatically.
  if (localStorage.getItem('pr_remember_login') === 'false') return null;
  const email = await window.pocketCloud.getCurrentUser();
  if (!email) return null;
  const owner = localStorage.getItem('pr_profile_owner') || '';
  if (owner && owner !== email && owner !== 'Guest Reader') {
    if (typeof window.resetLocalProfile === 'function') await window.resetLocalProfile({ preserveSetup: true });
    location.reload();
    return null;
  }
  localStorage.setItem('pr_profile_owner', email);
  window.userProfile = normalizeProfileV3(window.userProfile);
  window.userProfile.isLoggedIn = true;
  window.userProfile.cloudEmail = email;
  window._cloudPushAllowed = true;
  await queueCloudSync('startup', { immediate: true });
  if (typeof window.pocketCloud?.loadAvatar === 'function') {
    try {
      const avatar = await window.pocketCloud.loadAvatar();
      if (avatar) {
        window.userProfile.avatar = avatar;
        if (typeof window._saveUserAvatar === 'function') await window._saveUserAvatar(avatar);
      }
    } catch (error) { console.warn('[CloudSync] Avatar pull failed:', error); }
  }
  return email;
}
window.pullCloudProfileOnStartup = pullCloudProfileOnStartup;

window.addEventListener('online', () => { if (SYNC_STATE.pending) flushCloudSync(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && window._cloudPushAllowed) queueCloudSync('visibility-checkpoint', { immediate: true });
  else if (SYNC_STATE.pending) flushCloudSync();
});
SYNC_STATE.lastSyncedAt = Number(localStorage.getItem('pr_last_synced_at')) || 0;
publishState();
