import { isMobileLikePlatform } from './pocket_backend_policy.js?v=backend-v48';

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

// How long to wait for another tab to release a blocking connection before
// treating storage as unavailable for this attempt.
const DB_BLOCKED_TIMEOUT_MS = 10000;

export function initDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let blockedTimerId = null;
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
          // The block cleared on its own; cancel the give-up timer.
          if (blockedTimerId) { clearTimeout(blockedTimerId); blockedTimerId = null; }
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
          // onsuccess fires — so the normal case is a short wait, not an error.
          console.warn("[Storage] IndexedDB upgrade waiting on another open tab to close.");
          // But that other tab may be frozen (a backgrounded iOS tab does not
          // run onversionchange promptly), and this promise is awaited by EVERY
          // storage call. Never settling meant playback and caching hung
          // indefinitely rather than degrading to a cache miss. Bound the wait:
          // callers already treat a rejection as a miss, and clearing dbPromise
          // lets the next call reopen once the other tab lets go.
          blockedTimerId = setTimeout(() => {
            queueMicrotask(() => { dbPromise = null; });
            reject(new Error('IndexedDB is blocked by another open tab.'));
          }, DB_BLOCKED_TIMEOUT_MS);
        };

        request.onerror = (event) => {
          if (blockedTimerId) { clearTimeout(blockedTimerId); blockedTimerId = null; }
          console.error("IndexedDB initialization error:", event.target.error);
          queueMicrotask(() => { dbPromise = null; });
          reject(event.target.error);
        };
      } catch (err) {
        console.error("IndexedDB blocked or unavailable:", err);
        queueMicrotask(() => { dbPromise = null; });
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

const _NARRATION_FRONT_MATTER_TITLE_RE = /^(preface|foreword|introduction|intro|afterwords?|(?:author'?s?|authors?|translator'?s?|editor'?s?) notes?|(?:beginning|end|chapter|additional|closing|opening|further) notes?|endnotes?|footnotes?|acknowledg?ments?|dedication|epigraph|colophon|copyright(?: notice)?|title page|cover(?: page)?|(?:table of )?contents|toc|about the author|summary)$/i;
const _AO3_EXPORT_SIGNATURE_RE = /posted\s+originally\s+on\s+the\s+archive\s+of\s+our\s+own/i;
const _NUMBERED_CHAPTER_RE = /^(?:chapter|part|book)\s+(\d+|[ivxlcdm]+)\b/i;
const _OPENING_META_MARKER_RE = /(?:^|\n)\s*(?:chapter\s+)?(?:summary|notes?)\s*:?\s*(?:\n|$)/i;
const _END_META_MARKER_RE = /(?:^|\n)\s*(?:chapter\s+end\s+notes?|end\s+notes?|afterword)\s*:?\s*(?:\n|$)/i;
const _NOTES_TO_STORY_RE = /see\s+the\s+end\s+of\s+the\s+chapter\s+for\s+more\s+notes[.!:]?/i;

function _normalizeSectionTitle(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/^[\s"'“”‘’()[\]\-—–:.]+|[\s"'“”‘’()[\]\-—–:.]+$/g, '')
    .replace(/\s+/g, ' ');
}

function _isNarrationFrontMatterChapter(chapter) {
  const title = _normalizeSectionTitle(chapter?.title);
  const opening = (chapter?.paragraphs || []).slice(0, 12).join(' ').toLowerCase();
  return _NARRATION_FRONT_MATTER_TITLE_RE.test(title)
    || (_AO3_EXPORT_SIGNATURE_RE.test(opening) && /^(?:preface|summary|notes?)/i.test(title));
}

function _looksLikeAuthorNote(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!value) return true;
  return [
    /\b(?:hello|hi|hey|dear)\s+(?:readers?|everyone|all|guys|folks)\b/,
    /\bthanks?(?:\s+you)?\b.*\b(?:reading|support|comments?|kudos|beta)\b/,
    /\b(?:my|this|the)\s+(?:other\s+)?(?:work|story|chapter|writing|outline|draft)\b/,
    // First-person authorial only. This was a bare verb alternation
    // (wrote|written|writing|...), which matches ordinary third-person
    // narration -- "He had written to her every day that winter" was being
    // deleted as an author note whenever it followed a Notes:/Summary: marker.
    /\b(?:i|i've|i'm|we|we've)\s+(?:have\s+|had\s+|been\s+)?(?:wrote|written|writing|rewrote|rewritten|published|updated)\b/,
    /\bbeta(?:\s+read(?:er|ing)?s?)\b/,
    /\b(?:leave|drop)\s+(?:a\s+)?(?:comment|kudos)\b/,
    /\b(?:without\s+further\s+ado|please\s+enjoy|hope\s+you\s+enjoy)\b/,
    /\b(?:check\s+out|find\s+me|follow\s+me)\b.*\b(?:work|story|archive|ao3|tumblr|twitter)\b/,
    /^(?:story\s+outline|pass\s+(?:one|two|\d+)|beta\s+pass|publish)\b/,
    /\b(?:next|current)\s+(?:story\s+)?updates?\b/,
  ].some((pattern) => pattern.test(value));
}

function _escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _stripLeadingNarrationLabels(text, chapterTitle, context = {}) {
  let value = String(text || '').trim();
  const labels = [
    chapterTitle,
    context.title,
    context.author,
  ].filter(Boolean);

  // New parser records preserve line boundaries, so remove every leading line
  // that exactly matches a known title/byline or a numbered chapter heading.
  let lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  while (lines.length) {
    const key = _chapterTextKey(lines[0]);
    const known = labels.some((label) => key && key === _chapterTextKey(label));
    const exportMetadata = _AO3_EXPORT_SIGNATURE_RE.test(lines[0])
      || /^(?:preface|summary|(?:chapter\s+)?notes?)\s*:?\s*$/i.test(lines[0]);
    if (!known && !_NUMBERED_CHAPTER_RE.test(lines[0]) && !exportMetadata) break;
    lines.shift();
  }
  value = lines.join('\n').trim();

  // Older IndexedDB records were whitespace-collapsed. Remove the same known
  // label sequence from their prefix without guessing at arbitrary prose.
  for (let pass = 0; pass < 8 && value; pass++) {
    const before = value;
    for (const label of labels) {
      value = value.replace(new RegExp(`^${_escapeRegExp(label)}\\s+`, 'i'), '');
    }
    if (context.title) {
      value = value.replace(new RegExp(
        `^(?:chapter|part|book)\\s+(?:\\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\\s*[:\\-]\\s*${_escapeRegExp(context.title)}\\s+`,
        'i',
      ), '');
    }
    value = value.replace(/^(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\s+/i, '');
    if (value === before) break;
  }
  return value.trim();
}

function _sanitizeNarrationParagraphs(chapterTitle, paragraphs, context = {}, hasAo3Signature = false) {
  const values = (paragraphs || []).map((value) => String(value || '').trim()).filter(Boolean);
  const cleaned = [];
  let introMeta = false;
  let sawIntroMeta = false;

  for (let index = 0; index < values.length; index++) {
    let text = values[index];
    // Only an actual AO3 export may be truncated at an end-of-notes marker.
    // This used to fire on ANY document, so a story containing a line that is
    // exactly "End Notes" or "Afterword" -- an archivist reading a title aloud,
    // a chapter break -- silently discarded every remaining paragraph of that
    // chapter. In a genuine AO3 export the marker really does mean "notes from
    // here on"; in arbitrary uploaded prose it means nothing.
    const endMatch = hasAo3Signature ? text.match(_END_META_MARKER_RE) : null;
    if (endMatch) {
      const before = text.slice(0, endMatch.index).trim();
      if (before) cleaned.push(before);
      break;
    }

    const transition = text.match(_NOTES_TO_STORY_RE);
    if (transition) {
      text = text.slice(transition.index + transition[0].length).replace(/^[\s:\-]+/, '');
      introMeta = false;
      sawIntroMeta = true;
      if (!text) continue;
    }

    if ((index < 20 || !cleaned.length) && _OPENING_META_MARKER_RE.test(text)) {
      introMeta = true;
      sawIntroMeta = true;
      continue;
    }
    if (introMeta && _looksLikeAuthorNote(text)) continue;
    if (introMeta) introMeta = false;

    if (!cleaned.length) text = _stripLeadingNarrationLabels(text, chapterTitle, context);
    if (text) cleaned.push(text);
  }
  return cleaned.length || sawIntroMeta || hasAo3Signature ? cleaned : values;
}

export function normalizeStoryChapters(chapters, context = {}) {
  if (!Array.isArray(chapters)) return [];
  const narratable = chapters.filter((chapter) => !_isNarrationFrontMatterChapter(chapter));
  // Never erase a document made entirely of a legitimately named "Preface" or
  // "Introduction"; remove metadata sections only when actual story chapters
  // remain beside them.
  let sourceChapters = narratable.length ? narratable : chapters;
  const documentOpening = sourceChapters.slice(0, 2)
    .flatMap((chapter) => (chapter?.paragraphs || []).slice(0, 12))
    .join(' ');
  const hasAo3Signature = _AO3_EXPORT_SIGNATURE_RE.test(documentOpening);

  if (hasAo3Signature) {
    const expanded = [];
    for (const source of sourceChapters) {
      const values = Array.isArray(source?.paragraphs) ? source.paragraphs : [];
      const boundaries = [];
      values.forEach((paragraph, index) => {
        const raw = String(paragraph || '').trim();
        const firstLine = raw.split(/\r?\n/, 1)[0].trim();
        const match = firstLine.match(_NUMBERED_CHAPTER_RE) || raw.match(_NUMBERED_CHAPTER_RE);
        if (match) boundaries.push({ index, title: firstLine.match(_NUMBERED_CHAPTER_RE) ? firstLine : `Chapter ${match[1]}` });
      });
      if (boundaries.length && (boundaries[0].index > 0 || boundaries.length > 1)) {
        boundaries.forEach((boundary, position) => {
          const end = boundaries[position + 1]?.index ?? values.length;
          expanded.push({ ...source, title: boundary.title, paragraphs: values.slice(boundary.index, end) });
        });
      } else {
        expanded.push(source);
      }
    }
    sourceChapters = expanded;
  }

  const fingerprints = new Set();
  const chapterTextByTitle = new Map();
  const normalized = [];

  for (const source of sourceChapters) {
    if (!source || typeof source !== 'object') continue;
    const title = String(source.title || '').trim();
    const paragraphs = _sanitizeNarrationParagraphs(
      title,
      Array.isArray(source.paragraphs) ? source.paragraphs : [],
      context,
      hasAo3Signature,
    );
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

  const collapsed = [];
  for (const chapter of normalized) {
    const match = String(chapter.title || '').trim().match(_NUMBERED_CHAPTER_RE);
    const prior = collapsed[collapsed.length - 1];
    const priorMatch = String(prior?.title || '').trim().match(_NUMBERED_CHAPTER_RE);
    if (match && priorMatch && match[1].toLowerCase() === priorMatch[1].toLowerCase()) {
      if ((prior.paragraphs || []).length <= 12 && chapter.paragraphs.length > prior.paragraphs.length) {
        collapsed[collapsed.length - 1] = chapter;
      } else {
        prior.paragraphs.push(...chapter.paragraphs);
      }
    } else {
      collapsed.push(chapter);
    }
  }
  return collapsed;
}
window.normalizeStoryChapters = normalizeStoryChapters;

export function mergeStoryChapters(existing, incoming, context = {}) {
  const base = normalizeStoryChapters(existing, context);
  const fresh = normalizeStoryChapters(incoming, context);
  return normalizeStoryChapters(base.concat(fresh), context);
}
window.mergeStoryChapters = mergeStoryChapters;

export async function saveStoryChapters(title, chapters, context = {}) {
  if (!title || !chapters) return;
  const canonical = normalizeStoryChapters(chapters, context);
  const db = await initDB();
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
      tx.onabort = () => reject(tx.error || new Error('Story chapter write was aborted.'));
    } catch (err) {
      reject(err);
    }
  });
}
window._saveStoryChapters = saveStoryChapters;

// Structural comparison instead of JSON.stringify on both sides. Opening a long
// story serialised its entire text twice just to decide whether a repair write
// was needed; this walks the arrays and stops at the first difference, so the
// common "already canonical" case costs one pass over the paragraph references
// and allocates nothing.
function _chaptersDiffer(stored, canonical) {
  if (!Array.isArray(stored) || !Array.isArray(canonical)) return true;
  if (stored.length !== canonical.length) return true;
  for (let i = 0; i < stored.length; i += 1) {
    const a = stored[i];
    const b = canonical[i];
    if (!a || !b) return true;
    if ((a.title || '') !== (b.title || '')) return true;
    const pa = a.paragraphs;
    const pb = b.paragraphs;
    if (!Array.isArray(pa) || !Array.isArray(pb)) return true;
    if (pa.length !== pb.length) return true;
    for (let j = 0; j < pa.length; j += 1) {
      if (pa[j] !== pb[j]) return true;
    }
  }
  return false;
}

export async function loadStoryChapters(title, context = {}) {
  if (!title) return null;
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('story_chapters', 'readonly');
    const store = tx.objectStore('story_chapters');
    const req = store.get(title);
    req.onsuccess = () => {
      const stored = req.result || null;
      if (!stored) { resolve(null); return; }
      const canonical = normalizeStoryChapters(stored, context);
      if (_chaptersDiffer(stored, canonical)) {
        // Repair old local chapter data in the background. The current read
        // proceeds immediately, so this never delays opening a story.
        saveStoryChapters(title, canonical, context).catch(() => {});
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
const _IS_MOBILE_STORAGE = typeof navigator !== 'undefined' && isMobileLikePlatform(navigator.userAgent || '');

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
        }
      };
      req.onerror = () => {
        try { tx.abort(); } catch (_) {}
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
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
      tx.onabort = () => reject(tx.error || new Error('Audio cache write was aborted.'));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Cheap synchronous content fingerprint (FNV-1a, 32-bit).
 *
 * Audio cache keys are purely positional --
 * `${storyRef}_${chapIdx}_${paraIdx}_${engine}_${voice}` -- so any change to
 * paragraph segmentation silently remaps existing audio onto different text.
 * The narration sanitizer and the AO3 chapter re-split both change segmentation,
 * which means a story cached before one of those changes would play paragraph
 * N's audio while the reader is on N+1, with nothing to detect it. Storing the
 * fingerprint of the text a chunk was synthesized from lets a read verify the
 * chunk still belongs to the paragraph asking for it.
 *
 * Not crypto: this detects drift, not tampering, and must stay synchronous
 * because it runs on every cache lookup during playback.
 */
export function paragraphFingerprint(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}
// Not published on window: it is exported for the modules that key cache reads
// and writes on it, and the alias had no callers.

export async function saveAudioChunk(storyTitle, chapIdx, paraIdx, engine, voice, audioBlob, isPermanent = false, text = null) {
  if (!(audioBlob instanceof Blob) || audioBlob.size < 100) {
    throw new Error('Refusing to cache an invalid audio blob.');
  }
  // A best-effort render is one the quality guard rejected on every attempt and
  // we kept anyway so the reader does not lose the paragraph. It is fine to
  // play once; caching it would make the defect permanent for that paragraph on
  // every future listen. Silently skipped rather than thrown, because the
  // caller's job (play it) succeeded — only persistence is declined.
  if (audioBlob.pocketBestEffort) return null;
  const db = await initDB();

  _saveCount++;
  if (_saveCount % 20 === 0) {
    evictOldAudioChunks(db).catch(() => {});
  }

  const key = getAudioKey(storyTitle, chapIdx, paraIdx, engine, voice);
  const record = { blob: audioBlob, isPermanent: isPermanent, timestamp: Date.now(), storyRef: storyTitle };
  const fingerprint = text == null ? '' : paragraphFingerprint(text);
  if (fingerprint) record.textHash = fingerprint;
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

// Drops a single stale chunk. Best-effort: a failure here only means the stale
// entry lingers until eviction, and the caller has already treated it as a miss.
async function deleteAudioChunk(key) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('audio_chunks', 'readwrite');
      tx.objectStore('audio_chunks').delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Stale audio chunk delete was aborted.'));
    } catch (err) {
      reject(err);
    }
  });
}

export async function getAudioChunk(storyTitle, chapIdx, paraIdx, engine, voice, text = null) {
  // Never reject: any storage failure (e.g. iOS private mode, DB blocked) is
  // treated as a cache miss so playback falls through to live synthesis instead
  // of pausing on every paragraph.
  let db;
  try {
    db = await initDB();
  } catch (e) {
    return null;
  }
  const expected = text == null ? '' : paragraphFingerprint(text);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('audio_chunks', 'readonly');
      const store = tx.objectStore('audio_chunks');
      const key = getAudioKey(storyTitle, chapIdx, paraIdx, engine, voice);
      const req = store.get(key);
      req.onsuccess = () => {
        const found = req.result;
        if (!found) { resolve(null); return; }
        // Chunks written before fingerprinting existed carry no textHash. Treat
        // those as usable rather than wiping every user's cached narration on
        // upgrade; from here on every new chunk is verifiable.
        if (expected && found.textHash && found.textHash !== expected) {
          deleteAudioChunk(key).catch(() => {});
          resolve(null);
          return;
        }
        resolve(found.blob || null);
      };
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
      if (includePermanent && window.userProfile?.library) {
        window.userProfile.library.forEach((story) => {
          story.isCached = false;
          story.audioCached = false;
        });
        if (typeof window.saveLocalData === 'function') window.saveLocalData();
        if (typeof window.renderLibrary === 'function') window.renderLibrary(true);
        if (typeof window.updateContinueReading === 'function') window.updateContinueReading();
      }
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

// Chunk keys are `${storyRef}_${chap}_${para}_${engine}_${voice}`, so one
// story's chunks form a contiguous key range. Pin and delete used to walk the
// ENTIRE store — every chunk of every story, one cursor step each — and filter
// in JS, which is what made the cache manager crawl once a few stories were
// fully cached. Range-scanning touches only the story in question.
//
// The exact storyRef check stays: a ref that is a prefix of another ("abc" vs
// "abc_def") shares the key range, so the range is a speed narrowing and the
// equality test is what keeps it correct.
function _storyChunkRange(storyRef) {
  const prefix = `${storyRef}_`;
  return IDBKeyRange.bound(prefix, `${prefix}￿`, false, false);
}

export async function setStoryAudioPinned(storyTitle, pinned) {
  const db = await initDB();
  return new Promise((resolve) => {
    const tx = db.transaction('audio_chunks', 'readwrite');
    const store = tx.objectStore('audio_chunks');
    const request = store.openCursor(_storyChunkRange(storyTitle));
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
    const request = store.openCursor(_storyChunkRange(storyTitle));
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      if (cursor.value?.storyRef === storyTitle) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => {
      if (window.userProfile?.library) {
        const story = window.findLibraryStoryByRef?.(storyTitle);
        if (story) {
          story.isCached = false;
          story.audioCached = false;
        }
        if (typeof window.saveLocalData === 'function') window.saveLocalData();
        if (typeof window.renderLibrary === 'function') window.renderLibrary(true);
        if (typeof window.updateContinueReading === 'function') window.updateContinueReading();
      }
      resolve(true);
    };
    tx.onerror = () => resolve(false);
  });
}
window.deleteStoryAudio = deleteStoryAudio;

export async function refreshOfflineStorageDialog() {
  const target = document.getElementById('offline-story-usage-list');
  if (!target) return;
  // Aggregating usage has to visit every chunk in the store, which on a device
  // with several fully cached stories is thousands of cursor steps. Yield a
  // frame first so the dialog paints its "reading storage" state before that
  // starts — otherwise the tap looks like nothing happened until it finishes.
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
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
