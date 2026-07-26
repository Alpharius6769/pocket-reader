const DB_NAME = 'PocketReaderDB';
const DB_VERSION = 3;
let dbPromise = null;
let _saveCount = 0;
const MAX_AVATAR_BYTES = 256 * 1024;
const MAX_AVATAR_DIMENSION = 512;
let _lastSavedAvatarFingerprint = null;
let _avatarSaveInFlight = null;
let _avatarInFlightFingerprint = null;

function avatarByteLength(dataUrl) {
  const raw = String(dataUrl || '');
  const comma = raw.indexOf(',');
  const payload = comma >= 0 ? raw.slice(comma + 1) : raw;
  return Math.ceil(payload.length * 3 / 4);
}

function avatarFingerprint(dataUrl) {
  const text = String(dataUrl || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read avatar image.'));
    reader.readAsDataURL(file);
  });
}

function loadAvatarImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The selected avatar is not a readable image.'));
    image.src = src;
  });
}

export async function prepareAvatarForStorage(input) {
  if (!input) return null;
  const isFile = typeof Blob !== 'undefined' && input instanceof Blob;
  if (isFile && input.type && !input.type.startsWith('image/')) {
    throw new Error('Please select an image file for your avatar.');
  }

  const source = isFile ? await fileToDataUrl(input) : String(input);
  if (!isFile && avatarByteLength(source) <= MAX_AVATAR_BYTES) return source;

  const image = await loadAvatarImage(source);
  let width = image.naturalWidth || image.width;
  let height = image.naturalHeight || image.height;
  const initialScale = Math.min(1, MAX_AVATAR_DIMENSION / Math.max(width, height));
  width = Math.max(1, Math.round(width * initialScale));
  height = Math.max(1, Math.round(height * initialScale));

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('This browser cannot resize avatar images.');

  let quality = 0.86;
  let output = source;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    output = canvas.toDataURL('image/webp', quality);
    if (avatarByteLength(output) <= MAX_AVATAR_BYTES) return output;
    quality = Math.max(0.58, quality - 0.06);
    width = Math.max(128, Math.round(width * 0.85));
    height = Math.max(128, Math.round(height * 0.85));
  }
  throw new Error('Avatar image could not be compressed below the storage limit.');
}
window.prepareAvatarForStorage = prepareAvatarForStorage;

export function initDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains('audio_chunks')) {
            db.createObjectStore('audio_chunks');
          }
          if (!db.objectStoreNames.contains('story_chapters')) {
            db.createObjectStore('story_chapters');
          }
          if (!db.objectStoreNames.contains('user_profile')) {
            db.createObjectStore('user_profile');
          }
          if (!db.objectStoreNames.contains('sync_outbox')) {
            db.createObjectStore('sync_outbox');
          }
        };

        request.onsuccess = (event) => {
          const db = event.target.result;
          // If another tab later opens this DB at a higher version, close this
          // connection so its upgrade is not blocked. Without this, the other
          // tab's open() fires onblocked and its initDB() promise never settles
          // (it hangs all storage ops in that tab). Drop the cached promise so
          // this tab transparently reopens on its next storage call.
          db.onversionchange = () => {
            try { db.close(); } catch (_) {}
            dbPromise = null;
          };
          resolve(db);
        };

        request.onblocked = () => {
          // A pre-existing connection in another tab is holding the old version
          // open. Its onversionchange handler (above) closes it, after which our
          // onsuccess fires. Log only — never reject, so the normal short wait
          // still resolves rather than degrading every storage op to a miss.
          console.warn("[Storage] IndexedDB upgrade waiting on another open tab to close.");
        };

        request.onerror = (event) => {
          console.error("IndexedDB initialization error:", event.target.error);
          reject(event.target.error);
        };
      } catch (err) {
        console.error("IndexedDB blocked or unavailable:", err);
        reject(err);
      }
    });
  }
  return dbPromise;
}
window.initAudioDB = initDB;

function _chapterTextKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function _chapterFingerprint(paragraphs) {
  const text = (paragraphs || []).map(_chapterTextKey).join('\n');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function _isRepeatedChapterHeading(paragraph, title) {
  const text = _chapterTextKey(paragraph);
  const heading = _chapterTextKey(title);
  if (!text || !heading) return false;
  if (text === heading) return true;
  // A parser may emit the chapter title once as metadata and again as the first
  // narratable paragraph. Only discard a short exact heading echo.
  return text.length <= heading.length + 12 && text.startsWith(heading);
}

export function normalizeStoryChapters(chapters) {
  if (!Array.isArray(chapters)) return [];
  const fingerprints = new Set();
  const chapterTextByTitle = new Map();
  const normalized = [];

  for (const source of chapters) {
    if (!source || typeof source !== 'object') continue;
    const title = String(source.title || '').trim();
    const paragraphs = Array.isArray(source.paragraphs) ? source.paragraphs : [];
    const cleaned = [];
    let previousKey = '';
    for (const raw of paragraphs) {
      const text = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const key = _chapterTextKey(text);
      if (!cleaned.length && _isRepeatedChapterHeading(text, title)) continue;
      // Consecutive exact paragraphs are parser duplication, not intentional
      // repeated prose, and otherwise make narration repeat itself.
      if (key && key === previousKey) continue;
      cleaned.push(text);
      previousKey = key;
    }
    const fingerprint = _chapterFingerprint(cleaned);
    const titleKey = _chapterTextKey(title);
    const contentKey = cleaned.map(_chapterTextKey).join(' ');
    if (cleaned.length && fingerprints.has(fingerprint)) continue;
    // Some importers emit the same chapter twice, with the second record
    // containing only its opening paragraph. Treat it as a duplicate only when
    // the title matches and that non-trivial content already exists in full.
    const priorText = chapterTextByTitle.get(titleKey) || '';
    if (contentKey.length >= 16 && priorText.includes(contentKey)) continue;
    if (cleaned.length) fingerprints.add(fingerprint);
    if (contentKey.length) chapterTextByTitle.set(titleKey, `${priorText} ${contentKey}`.trim());
    normalized.push({ ...source, title, paragraphs: cleaned });
  }
  return normalized;
}
window.normalizeStoryChapters = normalizeStoryChapters;

export function mergeStoryChapters(existing, incoming) {
  const base = normalizeStoryChapters(existing);
  const fresh = normalizeStoryChapters(incoming);
  return normalizeStoryChapters(base.concat(fresh));
}
window.mergeStoryChapters = mergeStoryChapters;

export async function saveStoryChapters(title, chapters) {
  if (!title || !chapters) return;
  const canonical = normalizeStoryChapters(chapters);
  let db;
  try {
    db = await initDB();
  } catch (e) {
    return;
  }
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('story_chapters', 'readwrite');
      const store = tx.objectStore('story_chapters');
      store.put(canonical, title);
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        if (tx.error && tx.error.name === 'QuotaExceededError') {
          document.dispatchEvent(new CustomEvent('pr:quota-exceeded', { detail: { source: 'story_chapters' } }));
        }
        reject(tx.error);
      };
    } catch (err) {
      reject(err);
    }
  });
}
window._saveStoryChapters = saveStoryChapters;

export async function loadStoryChapters(title) {
  if (!title) return null;
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('story_chapters', 'readonly');
    const store = tx.objectStore('story_chapters');
    const req = store.get(title);
    req.onsuccess = () => {
      const stored = req.result || null;
      if (!stored) { resolve(null); return; }
      const canonical = normalizeStoryChapters(stored);
      if (JSON.stringify(canonical) !== JSON.stringify(stored)) {
        // Repair old local chapter data in the background. The current read
        // proceeds immediately, so this never delays opening a story.
        saveStoryChapters(title, canonical).catch(() => {});
      }
      resolve(canonical);
    };
    req.onerror = () => reject(req.error);
  });
}
window._loadStoryChapters = loadStoryChapters;

export async function deleteStoryChapters(title) {
  if (!title) return;
  let db;
  try {
    db = await initDB();
  } catch (e) {
    return;
  }
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('story_chapters', 'readwrite');
      const store = tx.objectStore('story_chapters');
      store.delete(title);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    } catch (err) {
      reject(err);
    }
  });
}
window._deleteStoryChapters = deleteStoryChapters;

function getAudioKey(storyTitle, chapIdx, paraIdx, engine, voice) {
  return `${storyTitle}_${chapIdx}_${paraIdx}_${engine}_${voice}`;
}

// Byte-aware eviction budgets. WAV chunks average ~0.5-1 MB, so the old
// count-only cap (800 chunks) could exceed half a GB — enough to hit iOS
// Safari quota limits on long stories. Both a count cap and a byte budget now
// apply to non-permanent chunks, and the budget tightens when the browser
// reports quota pressure or the user enabled Low Memory Mode.
const _IS_MOBILE_STORAGE = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

function _tempCacheBudgetBytes(aggressive = false) {
  const lowMem = !!window.userProfile?.settings?.lowMemoryMode;
  let budget = (_IS_MOBILE_STORAGE ? 250 : 600) * 1024 * 1024;
  if (lowMem) budget /= 2;
  if (aggressive) budget /= 2;
  return budget;
}

export async function evictOldAudioChunks(db, options = {}) {
  const MAX_TEMP_CHUNKS = 800;
  let aggressive = !!options.aggressive;

  // If the browser reports we are near quota, evict as if aggressive.
  if (!aggressive && navigator.storage?.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      if (quota && usage / quota > 0.85) aggressive = true;
    } catch (e) { /* estimate unsupported — budgets still apply */ }
  }
  const budgetBytes = _tempCacheBudgetBytes(aggressive);

  return new Promise((resolve) => {
    try {
      const tx = db.transaction('audio_chunks', 'readwrite');
      const store = tx.objectStore('audio_chunks');
      const tempChunks = [];
      let tempBytes = 0;
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          if (!cursor.value.isPermanent) {
            const bytes = cursor.value.blob?.size || 0;
            tempBytes += bytes;
            tempChunks.push({ key: cursor.key, timestamp: cursor.value.timestamp || 0, bytes });
          }
          cursor.continue();
        } else {
          if (tempChunks.length > MAX_TEMP_CHUNKS || tempBytes > budgetBytes) {
            tempChunks.sort((a, b) => a.timestamp - b.timestamp); // oldest first
            let count = tempChunks.length;
            let deleted = 0;
            for (const chunk of tempChunks) {
              if (count <= MAX_TEMP_CHUNKS && tempBytes <= budgetBytes) break;
              store.delete(chunk.key);
              tempBytes -= chunk.bytes;
              count--;
              deleted++;
            }
            console.log(`[Storage] Evicted ${deleted} temp audio chunks (${aggressive ? 'aggressive, ' : ''}now ~${Math.round(tempBytes / 1048576)}MB)`);
          }
          resolve();
        }
      };
      req.onerror = () => resolve();
      tx.onerror = () => resolve();
    } catch (err) {
      console.warn("[Storage] Eviction check failed:", err);
      resolve();
    }
  });
}
window.evictOldAudioChunks = evictOldAudioChunks;

function _putAudioChunk(db, key, record) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('audio_chunks', 'readwrite');
      const store = tx.objectStore('audio_chunks');
      store.put(record, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    } catch (err) {
      reject(err);
    }
  });
}

export async function saveAudioChunk(storyTitle, chapIdx, paraIdx, engine, voice, audioBlob, isPermanent = false) {
  let db;
  try {
    db = await initDB();
  } catch (e) {
    return;
  }

  _saveCount++;
  if (_saveCount % 20 === 0) {
    evictOldAudioChunks(db).catch(() => {});
  }

  const key = getAudioKey(storyTitle, chapIdx, paraIdx, engine, voice);
  const record = { blob: audioBlob, isPermanent: isPermanent, timestamp: Date.now(), storyRef: storyTitle };
  try {
    return await _putAudioChunk(db, key, record);
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      // Free space and retry once before surfacing the quota event — on iOS a
      // long story can hit quota mid-cache, and one aggressive eviction pass
      // usually recovers without interrupting playback.
      try {
        await evictOldAudioChunks(db, { aggressive: true });
        return await _putAudioChunk(db, key, record);
      } catch (retryErr) {
        document.dispatchEvent(new CustomEvent('pr:quota-exceeded', { detail: { source: 'audio_chunks' } }));
        throw retryErr;
      }
    }
    throw err;
  }
}

export async function getAudioChunk(storyTitle, chapIdx, paraIdx, engine, voice) {
  // Never reject: any storage failure (e.g. iOS private mode, DB blocked) is
  // treated as a cache miss so playback falls through to live synthesis instead
  // of pausing on every paragraph.
  let db;
  try {
    db = await initDB();
  } catch (e) {
    return null;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('audio_chunks', 'readonly');
      const store = tx.objectStore('audio_chunks');
      const key = getAudioKey(storyTitle, chapIdx, paraIdx, engine, voice);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

export async function clearAudioCache(includePermanent = false, skipConfirm = false) {
  if (!skipConfirm) {
    const msg = includePermanent
      ? "This will delete ALL audio caches, including permanently saved stories. Are you sure?"
      : 'This will clear your temporary audio cache to free up space. Permanent caches will be kept. Proceed?';
    if (!confirm(msg)) return;
  }

  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio_chunks', 'readwrite');
    const store = tx.objectStore('audio_chunks');

    if (includePermanent) {
      store.clear();
    } else {
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          if (!cursor.value.isPermanent) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
    }

    tx.oncomplete = () => {
      if (typeof window.virtueSpeak === 'function') {
        window.virtueSpeak("Audio cache cleared! Your browser feels much lighter now.", 4000);
        if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_changed_settings_and_saved');
      }
      resolve();
    };

    tx.onerror = () => reject(tx.error);
  });
}
window.clearAudioCache = clearAudioCache;

export async function getOfflineStoryUsage() {
  const db = await initDB();
  return new Promise((resolve) => {
    const totals = new Map();
    const tx = db.transaction('audio_chunks', 'readonly');
    const request = tx.objectStore('audio_chunks').openCursor();
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve([...totals.entries()].map(([story, value]) => ({ story, ...value })).sort((a, b) => b.bytes - a.bytes));
        return;
      }
      const record = cursor.value || {};
      const story = record.storyRef || 'Unknown story';
      const item = totals.get(story) || { bytes: 0, chunks: 0, permanentChunks: 0 };
      item.bytes += Number(record.blob?.size) || 0;
      item.chunks += 1;
      if (record.isPermanent) item.permanentChunks += 1;
      totals.set(story, item);
      cursor.continue();
    };
    request.onerror = () => resolve([]);
  });
}
window.getOfflineStoryUsage = getOfflineStoryUsage;

export async function setStoryAudioPinned(storyTitle, pinned) {
  const db = await initDB();
  return new Promise((resolve) => {
    const tx = db.transaction('audio_chunks', 'readwrite');
    const store = tx.objectStore('audio_chunks');
    const request = store.openCursor();
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      if (cursor.value?.storyRef === storyTitle) cursor.update({ ...cursor.value, isPermanent: !!pinned, timestamp: Date.now() });
      cursor.continue();
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}
window.setStoryAudioPinned = setStoryAudioPinned;

export async function deleteStoryAudio(storyTitle) {
  const db = await initDB();
  return new Promise((resolve) => {
    const tx = db.transaction('audio_chunks', 'readwrite');
    const store = tx.objectStore('audio_chunks');
    const request = store.openCursor();
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      if (cursor.value?.storyRef === storyTitle) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}
window.deleteStoryAudio = deleteStoryAudio;

export async function refreshOfflineStorageDialog() {
  const target = document.getElementById('offline-story-usage-list');
  if (!target) return;
  const rows = await getOfflineStoryUsage();
  const escape = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  target.innerHTML = rows.length ? rows.map((item) => {
    const encoded = encodeURIComponent(item.story).replace(/'/g, '%27');
    const pinned = item.permanentChunks === item.chunks;
    // Audio chunks are keyed by the stable story ref (a hash for most stories),
    // so item.story is that ref. Show the human title when the story is still in
    // the library; fall back to the raw ref otherwise. The pin/delete actions
    // keep using the ref (encoded), which is what the chunk records match on.
    const displayName = window.findLibraryStoryByRef?.(item.story)?.title || item.story;
    return `<article class="workflow-row"><div class="row-main"><strong>${escape(displayName)}</strong><span>${(item.bytes / 1048576).toFixed(1)} MB | ${item.chunks} audio chunks</span></div><div class="row-actions"><button class="pr-btn-sub" onclick="setStoryAudioPinned(decodeURIComponent('${encoded}'), ${!pinned}).then(refreshOfflineStorageDialog)">${pinned ? 'Unpin' : 'Pin'}</button><button class="icon-btn" title="Delete story audio" aria-label="Delete story audio" onclick="deleteStoryAudio(decodeURIComponent('${encoded}')).then(refreshOfflineStorageDialog)">${window.prIcon?.('trash-2') || 'X'}</button></div></article>`;
  }).join('') : '<div class="empty-state"><strong>No generated audio stored.</strong><span>Cached stories will appear here.</span></div>';
}
window.refreshOfflineStorageDialog = refreshOfflineStorageDialog;

export function openManagePermanentCaches() {
  window.showFeatureDialog?.(
    'Offline Story Audio',
    '<div id="offline-story-usage-list"><div class="empty-state"><span>Reading device storage...</span></div></div>',
    '<button class="pr-btn-danger" onclick="window.clearAudioCache(true)">Delete all audio</button><button class="pr-btn-sub" onclick="closeFeatureDialog()">Close</button>',
    refreshOfflineStorageDialog
  );
}
window.openManagePermanentCaches = openManagePermanentCaches;

export async function saveUserAvatar(avatarBase64) {
  if (!avatarBase64) return;
  let raw = String(avatarBase64);
  if (avatarByteLength(raw) > MAX_AVATAR_BYTES) {
    raw = await prepareAvatarForStorage(raw);
    if (window.userProfile?.avatar === avatarBase64) window.userProfile.avatar = raw;
  }
  const fingerprint = avatarFingerprint(raw);
  if (fingerprint === _lastSavedAvatarFingerprint) return false;
  if (fingerprint === _avatarInFlightFingerprint && _avatarSaveInFlight) return _avatarSaveInFlight;

  let db;
  try {
    db = await initDB();
  } catch (e) {
    return;
  }
  _avatarInFlightFingerprint = fingerprint;
  _avatarSaveInFlight = new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('user_profile', 'readwrite');
      const store = tx.objectStore('user_profile');
      store.put(raw, 'avatar');
      tx.oncomplete = () => {
        _lastSavedAvatarFingerprint = fingerprint;
        resolve(true);
      };
      tx.onerror = () => reject(tx.error);
    } catch (err) {
      reject(err);
    }
  });
  try {
    return await _avatarSaveInFlight;
  } finally {
    if (_avatarInFlightFingerprint === fingerprint) {
      _avatarInFlightFingerprint = null;
      _avatarSaveInFlight = null;
    }
  }
}
window._saveUserAvatar = saveUserAvatar;

// Best-effort wipe of ALL per-user data in IndexedDB (audio, story text,
// avatar). Used when the local profile is reset for an account switch/logout
// so the next reader never inherits the previous user's content.
export async function wipeLocalUserData() {
  let db;
  try {
    db = await initDB();
  } catch (e) {
    return;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(['audio_chunks', 'story_chapters', 'user_profile'], 'readwrite');
      tx.objectStore('audio_chunks').clear();
      tx.objectStore('story_chapters').clear();
      tx.objectStore('user_profile').clear();
      tx.oncomplete = () => {
        _lastSavedAvatarFingerprint = null;
        _avatarInFlightFingerprint = null;
        _avatarSaveInFlight = null;
        resolve();
      };
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch (err) {
      resolve();
    }
  });
}
window._wipeLocalUserData = wipeLocalUserData;

export async function loadUserAvatar() {
  let db;
  try {
    db = await initDB();
  } catch (e) {
    return null;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('user_profile', 'readonly');
      const store = tx.objectStore('user_profile');
      const req = store.get('avatar');
      req.onsuccess = () => {
        const avatar = req.result || null;
        if (avatar) _lastSavedAvatarFingerprint = avatarFingerprint(avatar);
        resolve(avatar);
      };
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

export async function saveSyncOutbox(payload) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sync_outbox', 'readwrite');
    tx.objectStore('sync_outbox').put(payload, 'pending');
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
window._saveSyncOutbox = saveSyncOutbox;

export async function loadSyncOutbox() {
  const db = await initDB();
  return new Promise((resolve) => {
    const tx = db.transaction('sync_outbox', 'readonly');
    const request = tx.objectStore('sync_outbox').get('pending');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}
window._loadSyncOutbox = loadSyncOutbox;

export async function clearSyncOutbox() {
  const db = await initDB();
  return new Promise((resolve) => {
    const tx = db.transaction('sync_outbox', 'readwrite');
    tx.objectStore('sync_outbox').delete('pending');
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}
window._clearSyncOutbox = clearSyncOutbox;
window._loadUserAvatar = loadUserAvatar;

if ('requestIdleCallback' in window) {
  requestIdleCallback(() => initDB());
} else {
  setTimeout(() => initDB(), 1000);
}
