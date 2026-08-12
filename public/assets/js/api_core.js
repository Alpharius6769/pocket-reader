
const DEFAULT_API_BASE = 'https://pocket-reader-proxy.christopher-gotham67.workers.dev';
const DEFAULT_PROXY_BASE = 'https://pocket-reader-proxy.christopher-gotham67.workers.dev';
const AO3_SEARCH_TIMEOUT_MS = 120000;

const PR_CONFIG = {
  apiBase: DEFAULT_API_BASE,
  proxyBase: DEFAULT_PROXY_BASE,
  ...(window.POCKET_READER_CONFIG || {})
};

window.POCKET_READER_CONFIG = PR_CONFIG;
window.PR_PROXY_BASE = PR_CONFIG.proxyBase;

// showCacheDecisionModal lives in the lazily-loaded buffer_manager.js. Opening a
// story always needs the narration runtime eventually (Play/Cache are core to
// the reading view), so trigger the load here rather than leave the
// typeof-guarded call below silently no-op on a user's first story open in a
// session (before any narration button had been clicked to load it).
async function _ensureCacheDecisionModal() {
  if (typeof window.ensureNarrationRuntime === 'function') {
    try { await window.ensureNarrationRuntime(); } catch (_) { /* already surfaced its own error UI */ }
  }
  if (typeof window.showCacheDecisionModal === 'function') window.showCacheDecisionModal();
}

window._safeParseJson = async function(response, apiName = 'General') {
  try {
    return await response.json();
  } catch (e) {
    let text = '';
    try {
      text = await response.text();
    } catch (te) {}
    console.error(`[${apiName}] JSON Parse Failed. Raw Response:`, text.substring(0, 500));
    throw new Error(`The ${apiName} server returned an invalid response (not JSON). It may be down or blocking requests.`);
  }
};
export const _safeParseJson = window._safeParseJson;

export const HF_API_BASE = PR_CONFIG.apiBase;
export const PR_PROXY_BASE = PR_CONFIG.proxyBase;
window.HF_API_BASE = HF_API_BASE;
window.VAPID_PUBLIC_KEY = window.VAPID_PUBLIC_KEY || null;

export function normalizeStoryUrl(inputUrl) {
  if (!inputUrl) return '';
  let url = String(inputUrl).trim();
  if (url.startsWith('/api/') || url.startsWith('/local-upload/') || url.startsWith('local://')) return url;
  if (!/^[a-z]+:\/\//i.test(url)) {
    // If it starts with a domain name like furaffinity.net, ao3.org, sofurry.com, etc., prepend https://
    if (/^([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(url)) {
      url = 'https://' + url;
    }
  }
  return url;
}
window.normalizeStoryUrl = normalizeStoryUrl;

export function isValidStoryUrl(url) {
  if (!url) return false;
  const normalized = normalizeStoryUrl(url);
  if (normalized.startsWith('/api/') || normalized.startsWith('/local-upload/') || normalized.startsWith('local://')) return true;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local') || host.endsWith('.internal')) {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}
window.isValidStoryUrl = isValidStoryUrl;

window._rateLimit = {
  scrape: {
    lastAt: 0,
    minIntervalMs: 1500,
    queue: [],
    retryAfterUntil: 0,
    running: false,
  },
  search: {
    lastAt: 0,
    minIntervalMs: 1200,
    queue: [],
    retryAfterUntil: 0,
    running: false,
  },
  masterlist: {
    lastAt: 0,
    minIntervalMs: 5000,
    queue: [],
    retryAfterUntil: 0,
    running: false,
  },
  health: {
    lastAt: 0,
    minIntervalMs: 5000,
    queue: [],
    retryAfterUntil: 0,
    running: false,
  },
};

export function rateLimitedFetch(category, fetchFn) {
  const bucket = window._rateLimit[category];
  if (!bucket) return fetchFn();
  return new Promise((resolve, reject) => {
    const drain = async () => {
      bucket.running = true;
      const now = Date.now();
      const need = Math.max(bucket.retryAfterUntil, bucket.lastAt + bucket.minIntervalMs) - now;
      if (need > 0) {
        setTimeout(drain, need);
        return;
      }
      bucket.lastAt = Date.now();
      try {
        const resp = await fetchFn();
        if (resp && resp.status === 429) {
          const ra = parseInt(resp.headers.get('retry-after') || '5', 10);
          bucket.retryAfterUntil = Date.now() + (isNaN(ra) ? 5000 : ra * 1000);
          console.warn(`Rate limited on ${category}, backing off ${ra}s.`);
        }
        resolve(resp);
      } catch (err) {
        reject(err);
      } finally {
        bucket.running = false;
        const next = bucket.queue.shift();
        if (next) next();
      }
    };
    bucket.queue.push(drain);
    if (!bucket.running) {
      const next = bucket.queue.shift();
      if (next) next();
    }
  });
}
window._rateLimitedFetch = rateLimitedFetch;

function _normalizeHostname(url) {
  try {
    return new URL(url || '').hostname.toLowerCase().replace(/\.$/, '');
  } catch (e) {
    return '';
  }
}

function _hostnameMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function cookiesForUrl(url) {
  let cks = {};
  try {
    const raw = sessionStorage.getItem('pocketReaderCookies');
    if (raw) cks = JSON.parse(raw);
  } catch (e) {}
  const host = _normalizeHostname(url);
  const out = {};
  if (_hostnameMatches(host, 'furaffinity.net') && cks.fa && (cks.fa.a || cks.fa.b)) out.fa = cks.fa;
  if (_hostnameMatches(host, 'sofurry.com') && cks.sofurry && Object.keys(cks.sofurry).length) out.sofurry = cks.sofurry;
  return Object.keys(out).length ? out : null;
}
window.cookiesForUrl = cookiesForUrl;
window._cookiesForUrl = cookiesForUrl;

export function saveSiteCookies() {
  const fa_a = (document.getElementById('fa-cookie-a') || {}).value || '';
  const fa_b = (document.getElementById('fa-cookie-b') || {}).value || '';
  const sf_session = (document.getElementById('sofurry-cookie-session') || {}).value || '';

  const cookies = {
    fa: { a: fa_a.trim(), b: fa_b.trim() },
    sofurry: sf_session.trim() ? { sf_session: sf_session.trim() } : {},
  };
  try {
    sessionStorage.setItem('pocketReaderCookies', JSON.stringify(cookies));
  } catch (e) {}

  if (window.userProfile && window.userProfile.settings) {
    delete window.userProfile.settings.siteCookies;
  }

  if (typeof window.saveLocalData === 'function') window.saveLocalData();
  if (typeof window.virtueSpeak === 'function') {
    window.virtueSpeak("Account cookies saved. I'll use them when you load FA or SoFurry stories.", 5000);
  }
}
window.saveSiteCookies = saveSiteCookies;

export function showCloudflareDownloadHelp() {
  if (typeof window.showSettingsModal === 'function') {
    window.showSettingsModal(
      'Save & load a blocked story',
      `<p style="font-size:0.9rem;line-height:1.5;">If the story page works in your browser but our backend gets blocked, save the story to your device and upload it here.</p>
       <h4 style="color:#c9a75c;margin:16px 0 6px 0;">Archive of Our Own (AO3)</h4>
       <ol style="font-size:0.85rem;line-height:1.6;padding-left:20px;">
         <li>Open the story's main page (not a single chapter)</li>
         <li>Click <b>Entire Work</b> (top right) so all chapters are on one page</li>
         <li>Scroll to <b>Download</b> in the work header, then pick <b>EPUB</b> (or PDF if you prefer)</li>
         <li>Save the file</li>
         <li>Come back here and click <b>Open File</b> in the top bar; pick the file you saved</li>
       </ol>
       <h4 style="color:#c9a75c;margin:16px 0 6px 0;">Royal Road</h4>
       <ol style="font-size:0.85rem;line-height:1.6;padding-left:20px;">
         <li>Open the fiction's main page (not a single chapter)</li>
         <li>Look for the <b>Download</b> button - usually offers EPUB</li>
         <li>Save and upload here via Open File</li>
       </ol>
       <h4 style="color:#c9a75c;margin:16px 0 6px 0;">FurAffinity/SoFurry/other sites</h4>
       <ol style="font-size:0.85rem;line-height:1.6;padding-left:20px;">
         <li>If the site doesn't offer EPUB download, save the page itself: browser menu, <b>Save Page As...</b>, then <b>HTML</b></li>
         <li>Upload the saved <code>.html</code> via Open File</li>
       </ol>
       <p style="margin-top:16px;font-size:0.8rem;color:var(--text-muted);">Tip: for FurAffinity and SoFurry, pasting your account cookies in Settings > Connect Accounts often gets past the login wall without needing to download anything.</p>`
    );
  }
}
window.showCloudflareDownloadHelp = showCloudflareDownloadHelp;

export function triggerFileUpload() {
  const el = document.getElementById('local-file-upload');
  if (el) el.click();
}
window.triggerFileUpload = triggerFileUpload;

export async function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const MAX_SIZE = 50 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    alert('File too large. Maximum size is 50MB.');
    event.target.value = '';
    return;
  }
  const ALLOWED = [
    'application/pdf',
    'application/epub+zip',
    'text/html',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];
  if (!ALLOWED.includes(file.type) && !file.name.match(/\.(pdf|epub|html|htm|txt|docx)$/i)) {
    alert('Unsupported file type.');
    event.target.value = '';
    return;
  }
  try {
    await processUploadedFile(file);
  } finally {
    event.target.value = '';
  }
}
window.handleFileSelect = handleFileSelect;

async function _extractTextFromLocalFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const name = file?.name || '';
    const isPdf = name.match(/\.pdf$/i) || file?.type === 'application/pdf';

    if (isPdf) {
      reader.readAsArrayBuffer(file);
      reader.onload = () => {
        try {
          const buffer = new Uint8Array(reader.result);
          const raw = new TextDecoder('latin1').decode(buffer);
          const matches = [];
          const regex = /\(([^)]+)\)\s*(?:Tj|TJ|\')/g;
          let match;
          while ((match = regex.exec(raw)) !== null) {
            let str = match[1].replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
                             .replace(/\\(.)/g, '$1');
            if (str.trim().length > 0) matches.push(str);
          }

          if (matches.length < 5) {
            const textRegex = /[\x20-\x7E]{4,}/g;
            let m;
            while ((m = textRegex.exec(raw)) !== null) {
              const s = m[0].trim();
              if (s.length > 5 && !s.startsWith('/Font') && !s.startsWith('/Type') && !s.includes('obj') && !s.includes('endobj')) {
                matches.push(s);
              }
            }
          }

          const fullText = matches.join(' ');
          resolve(fullText);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
    } else {
      reader.readAsText(file);
      reader.onload = () => resolve(reader.result || '');
      reader.onerror = () => reject(reader.error);
    }
  });
}

export async function processUploadedFile(file, fichubMeta, options = {}) {
  // silent: a background caching path (Away Mode / cache-job resume) fed this
  // file via loadStory({preventNavigate}). Never navigate, show overlays, pop
  // companion reactions, or alert — just parse, add to library, and persist
  // chapters so the caller can cache them.
  const silent = options.silent === true;
  if (!silent && typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_thinking');
  if (!silent && typeof window.showLoadingOverlay === 'function')
    window.showLoadingOverlay('Parsing document...', 'Extracting text and chapters');
  const formData = new FormData();
  formData.append('file', file);
  const uploadTimeoutMs = Math.min(
    240000,
    Math.max(60000, 60000 + Math.ceil(Number(file?.size || 0) / 1048576) * 3000),
  );
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), uploadTimeoutMs);
  try {
    let parsedData = null;
    try {
      const response = await fetch(`${window.HF_API_BASE}/api/upload`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
      if (response.ok) {
        parsedData = await _safeParseJson(response, 'General');
      }
    } catch (netErr) {
      console.warn('[Upload] Remote backend upload failed, trying local client-side extraction:', netErr);
    }

  if (!parsedData) {
    try {
      const text = await _extractTextFromLocalFile(file);
      if (text && text.trim().length > 5) {
        const rawParas = text
          .split(/\n\s*\n|\r\n\s*\r\n/)
          .map((p) => p.replace(/\s+/g, ' ').trim())
          .filter((p) => p.length > 2);
        const fileNameClean = (file.name || 'Local Document')
          .replace(/\.[^/.]+$/, '')
          .replace(/[_\-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        parsedData = {
          filename: file.name,
          title: fileNameClean,
          author: 'Local File',
          chapters: [{ title: fileNameClean, paragraphs: rawParas.length ? rawParas : [text.trim()] }],
        };
      }
    } catch (fallbackErr) {
      console.warn('[Upload] Local extraction fallback error:', fallbackErr);
    }
  }

  if (!parsedData) {
    throw new Error('Document parsing failed. Check your connection or try a different file format.');
  }
    const cleanFilename = (parsedData.filename || 'Unknown')
      .replace(/\.[^/.]+$/, '')
      .replace(/[_\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    let words = parsedData.words;
    if (!words && parsedData.chapters) {
      let n = 0;
      parsedData.chapters.forEach((ch) => (ch.paragraphs || []).forEach((p) => (n += p.split(/\s+/).filter(Boolean).length)));
      words = n ? n.toLocaleString() : '-';
    }
    // FicHub's .meta is authoritative — prefer it over EPUB-parsed values, which are
    // often messy (e.g. "Word Document"). Strip HTML from the description for synopsis.
    const _m = fichubMeta || {};
    const _metaSynopsis = _m.description
      ? _m.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    const _metaWords = (typeof _m.words === 'number' && _m.words > 0)
      ? _m.words.toLocaleString() : '';
    const newStory = {
      title: (_m.title && _m.title.trim()) || (parsedData.title && parsedData.title.trim()) || cleanFilename || 'Untitled',
      author: (_m.author && _m.author.trim()) || (parsedData.author && parsedData.author.trim()) || 'Unknown',
      synopsis: _metaSynopsis || parsedData.synopsis || 'Uploaded from your device.',
      words: _metaWords || words || '-',
      chapters: window.normalizeStoryChapters?.(parsedData.chapters)
        || parsedData.chapters
        || [{ title: 'Document', paragraphs: ['No readable text found.'] }],
    };
    if (_m.source) newStory.url = _m.source;
    if (_m.status) newStory.status = _m.status;
    if (_m.extraMeta) newStory.extraMeta = _m.extraMeta;
    newStory.storyKey = window.getStoryStableKey?.(newStory) || `${newStory.title}|${newStory.author}`;
    if (!newStory.url) newStory.url = `/local-upload/${encodeURIComponent(newStory.storyKey)}`;

    // Manual-upload update: reconcile against an existing library entry for the
    // SAME story so a re-uploaded / newer file updates it in place instead of
    // spawning a duplicate. Match first by stable key, then fall back to
    // title+author: a story first FETCHED from AO3 keys off its work URL, while
    // the same story UPLOADED as a file keys off title|author (or a /local-upload/
    // ref), so their stable keys never match and the two would otherwise coexist.
    let _existing = window.findLibraryStoryByRef?.(newStory.storyKey) || null;
    if (!_existing) {
      // The title+author fallback requires a real, non-"unknown" author. Matching
      // on title alone — or collapsing two "Unknown"-authored uploads together —
      // is too loose: a false match here adopts the other entry's identity and
      // could append unrelated chapters to (or hide the upload behind) the wrong
      // story. Two distinct works sharing an exact title AND a real author is rare
      // enough to treat as the same story for update-by-upload.
      const _norm = (v) => String(v || '').trim().toLowerCase();
      const _t = _norm(newStory.title), _a = _norm(newStory.author);
      if (_t && _a && _a !== 'unknown') {
        _existing = (window.userProfile?.library || []).find(
          (s) => _norm(s.title) === _t && _norm(s.author) === _a) || null;
      }
    }
    if (_existing) {
      // Adopt the existing identity so cached chapters/audio (keyed by storyKey)
      // and the addToLibrary dedupe (keyed via getStoryStableKey, which prefers
      // sourceUrl → url) both resolve to this entry rather than creating a new one.
      newStory.storyKey = _existing.storyKey || window.getStoryStableKey?.(_existing) || newStory.storyKey;
      if (_existing.sourceUrl) newStory.sourceUrl = _existing.sourceUrl;
      else if (_existing.source_url) newStory.source_url = _existing.source_url;
      if (_existing.url) newStory.url = _existing.url;
      if (typeof window._loadStoryChapters === 'function') {
        try {
          const _stored = (await window._loadStoryChapters(newStory.storyKey, newStory))
            || (await window._loadStoryChapters(_existing.title, newStory)) || [];
          const _flatten = (chs) => (chs || [])
            .map((c) => (c.paragraphs || []).join('\n')).join('\n\n');
          if (!_stored.length) {
            // Nothing cached (evicted / never cached) — keep the uploaded set as-is.
          } else if (newStory.chapters.length > _stored.length) {
            // Newer upload: keep existing chapters + their audio, append only the
            // newly-added ones.
            const _added = newStory.chapters.length - _stored.length;
            newStory.chapters = window.mergeStoryChapters?.(_stored, newStory.chapters, newStory)
              || _stored.concat(newStory.chapters.slice(_stored.length));
            if (!silent && typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_holding_bubble_happy_no_paws');
            if (!silent && window.virtueSpeak) window.virtueSpeak(`Added ${_added} new chapter${_added > 1 ? 's' : ''} from your upload - your existing audio is kept.`, 6000);
          } else if (newStory.chapters.length === _stored.length
                     && _flatten(newStory.chapters) !== _flatten(_stored)) {
            // Same chapter count but the text changed = a corrected re-upload. Take
            // the new text so the fix actually applies (previously this was ignored
            // and the stale stored chapters were kept). Audio is position-keyed, so
            // changed paragraphs re-render on next play while unchanged ones keep
            // their cached audio. newStory.chapters already holds the upload.
            if (!silent && typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_holding_bubble_happy_no_paws');
            if (!silent && window.virtueSpeak) window.virtueSpeak('Updated this story from your re-upload.', 5000);
          } else {
            // Upload is older, or equal and byte-identical — keep the existing
            // chapters (and their index-keyed audio) untouched.
            newStory.chapters = _stored;
          }
          // Reflect the resulting chapter set on the existing entry so its library
          // card count matches what the reader now holds.
          _existing.totalChapters = newStory.chapters.length;
          _existing.publishedChapters = Math.max(Number(_existing.publishedChapters || 0), newStory.chapters.length);
          _existing.isFinished = false;
          if (typeof window._saveStoryChapters === 'function') await window._saveStoryChapters(newStory.storyKey, newStory.chapters, newStory);
        } catch (e) { console.warn('Upload merge check failed:', e); }
      }
    }

    window.currentStory = newStory;
    window.currentChapterIndex = 0;
    window.currentParagraphIndex = 0;
    if (typeof window.addToLibrary === 'function') window.addToLibrary(window.currentStory);
    // Persist the uploaded chapters to IndexedDB under storyKey, title, and url.
    if (typeof window._saveStoryChapters === 'function' && Array.isArray(newStory.chapters)) {
      try {
        await window._saveStoryChapters(newStory.storyKey, newStory.chapters, newStory);
        await window._saveStoryChapters(newStory.title, newStory.chapters, newStory);
        if (newStory.url) await window._saveStoryChapters(newStory.url, newStory.chapters, newStory);
      } catch (e) { console.warn('Failed to persist uploaded story chapters:', e); }
    }
    if (!silent && typeof window.populateReaderUI === 'function') window.populateReaderUI(window.currentStory, newStory.author);
    if (!silent && typeof window.updateReaderUIText === 'function') window.updateReaderUIText();
    if (!silent && typeof window.showView === 'function') window.showView('reading-view');
    if (!silent) await _ensureCacheDecisionModal();
  } catch (error) {
    if (silent) {
      // Background caching path: never alert or pop a companion reaction. Let
      // the caller observe the unset currentStory and skip the cache job.
      console.warn('[Upload] Silent background parse failed:', error?.message || error);
      throw error;
    }
    const msg = error?.name === 'AbortError'
      ? `The upload took longer than ${Math.round(uploadTimeoutMs / 1000)} seconds. Check your connection and try again.`
      : error.message && error.message !== 'Upload failed'
      ? error.message
      : 'Error parsing document. Please try a different file.';
    alert(msg);
    if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_network_error');
  } finally {
    clearTimeout(timeoutId);
    if (!silent && typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
  }
}
window.processUploadedFile = processUploadedFile;

export function handleTopBarSearch() {
  const el = document.getElementById('global-search');
  if (el) window.handleSearchSubmit(el.value.trim());
}
window.handleTopBarSearch = handleTopBarSearch;

export function handlePageSearch() {
  const inputEl = document.getElementById('ao3-page-search');
  const topBar = document.getElementById('global-search');
  const input = inputEl ? inputEl.value.trim() : '';
  if (topBar) topBar.value = input;
  window.handleSearchSubmit(input);
}
window.handlePageSearch = handlePageSearch;

function _escapeSearchHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// "Open exact AO3 search" as a real link rather than onclick="window.open('…')".
// The search term reaches this URL, and neither encodeURIComponent nor HTML
// escaping makes a value safe inside a single-quoted JS string in an attribute:
// encodeURIComponent leaves ' alone, and &#39; is decoded back to ' before the
// JS parser runs. An href needs only attribute escaping, so there is no JS
// context to break out of. Same reasoning as the Cloudflare fallback dialog.
function _externalSearchLink(rawUrl, label = 'Open exact AO3 search') {
  let href;
  try {
    href = new URL(String(rawUrl), window.location.href);
  } catch (_) {
    return '';
  }
  if (href.protocol !== 'http:' && href.protocol !== 'https:') return '';
  return `<a class="pr-btn-outline" href="${_escapeSearchHtml(href.href)}" target="_blank" rel="noopener noreferrer">${_escapeSearchHtml(label)}</a>`;
}

function _readAo3SearchPayloadFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!/archiveofourown\.org$/i.test(parsed.hostname) && !/\.archiveofourown\.org$/i.test(parsed.hostname)) return null;
    if (!/^\/works\/search\/?$/i.test(parsed.pathname)) return null;
    const q = parsed.searchParams;
    const payload = {
      query: q.get('work_search[query]') || '',
      title: q.get('work_search[title]') || '',
      author: q.get('work_search[creators]') || '',
      fandom: q.get('work_search[fandom_names]') || '',
      rating: q.get('work_search[rating_ids]') || 'Any',
      category: q.get('work_search[category_ids][]') || 'Any',
      language: q.get('work_search[language_id]') || 'Any',
      sort_column: q.get('work_search[sort_column]') || 'revised_at',
      sort_direction: q.get('work_search[sort_direction]') || 'desc',
      complete: q.get('work_search[complete]') === '1' ? '1' : '',
      page: Math.max(1, parseInt(q.get('page') || '1', 10) || 1),
      limit: 15,
    };
    const wordsMin = parseInt(q.get('work_search[words_from]') || '', 10);
    const wordsMax = parseInt(q.get('work_search[words_to]') || '', 10);
    if (!Number.isNaN(wordsMin)) payload.words_min = wordsMin;
    if (!Number.isNaN(wordsMax)) payload.words_max = wordsMax;
    return payload;
  } catch (_) {
    return null;
  }
}

function _syncAo3SearchInputs(payload) {
  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (el && value != null && value !== '') el.value = value;
  };
  setValue('ao3-page-search', payload.query || '');
  setValue('global-search', payload.query || '');
  setValue('ao3-search-title', payload.title || '');
  setValue('ao3-search-author', payload.author || '');
  setValue('ao3-search-fandom', payload.fandom || '');
  setValue('ao3-search-rating', payload.rating || 'Any');
  setValue('ao3-search-category', payload.category || 'Any');
  setValue('ao3-search-language', payload.language || 'Any');
  setValue('ao3-search-sort', payload.sort_column || 'revised_at');
  const completeEl = document.getElementById('ao3-search-complete');
  if (completeEl) completeEl.checked = payload.complete === '1';
  setValue('ao3-search-words-min', payload.words_min || '');
  setValue('ao3-search-words-max', payload.words_max || '');
}

function _buildAo3SearchPayload(query, options = {}) {
  const pastedPayload = query ? _readAo3SearchPayloadFromUrl(query) : null;
  if (pastedPayload) {
    _syncAo3SearchInputs(pastedPayload);
    return pastedPayload;
  }

  const titleEl = document.getElementById('ao3-search-title');
  const authorEl = document.getElementById('ao3-search-author');
  const fandomEl = document.getElementById('ao3-search-fandom');
  const ratingEl = document.getElementById('ao3-search-rating');
  const categoryEl = document.getElementById('ao3-search-category');
  const languageEl = document.getElementById('ao3-search-language');
  const sortEl = document.getElementById('ao3-search-sort');
  const completeEl = document.getElementById('ao3-search-complete');
  const wordsMinEl = document.getElementById('ao3-search-words-min');
  const wordsMaxEl = document.getElementById('ao3-search-words-max');
  const exactTitle = /^".+"$/.test(query || '') ? query.slice(1, -1).trim() : '';

  const payload = {
    query: exactTitle ? '' : (query || ''),
    title: exactTitle || titleEl?.value.trim() || '',
    author: authorEl?.value.trim() || '',
    fandom: fandomEl?.value.trim() || '',
    rating: ratingEl?.value || 'Any',
    category: categoryEl?.value || 'Any',
    language: languageEl?.value || 'Any',
    sort_column: sortEl?.value || 'revised_at',
    sort_direction: options.sort_direction || 'desc',
    complete: completeEl?.checked ? '1' : '',
    page: options.page || 1,
    limit: 15,
  };
  const minVal = parseInt(wordsMinEl?.value || '', 10);
  const maxVal = parseInt(wordsMaxEl?.value || '', 10);
  if (!Number.isNaN(minVal)) payload.words_min = minVal;
  if (!Number.isNaN(maxVal)) payload.words_max = maxVal;
  return payload;
}

function _ao3DisplayTerm(payload) {
  return payload.title || payload.author || payload.fandom || payload.query || 'specified filters';
}

function _renderAo3Results(data, append = false) {
  const resultsPanel = document.getElementById('search-results-panel');
  if (!resultsPanel) return;
  const state = window._ao3SearchState || {};
  const results = state.results || [];
  if (!append && results.length === 0 && (!data || data.status === 'ok')) {
    resultsPanel.innerHTML = `<p style="color:var(--text-muted);">No results found. Try a different title, author, tag, or paste a story URL directly.</p>`;
    return;
  }
  const headerMeta = data?.elapsed_ms ? `Search completed in ${(data.elapsed_ms / 1000).toFixed(1)}s.` : '';
  let html = `<div class="search-results-header"><span>Showing ${results.length} result${results.length === 1 ? '' : 's'}</span><span>${_escapeSearchHtml(headerMeta)}</span></div>`;
  html += `<div class="search-results-scroll">`;
  results.forEach((r) => {
    const title = _escapeSearchHtml(r.title || 'Untitled');
    const author = _escapeSearchHtml(r.author || 'Unknown');
    const fandoms = _escapeSearchHtml(Array.isArray(r.fandoms) ? r.fandoms.join(', ') : (r.fandoms || ''));
    const meta = [
      r.words ? `Words: ${r.words}` : '',
      r.chapters ? `Chapters: ${r.chapters}` : '',
      r.updated ? `Updated: ${r.updated}` : '',
    ].filter(Boolean).join(' | ');
    const tags = Array.isArray(r.tags) ? r.tags.slice(0, 6) : [];
    const urlEncoded = encodeURIComponent(r.url || '').replace(/'/g, '%27');
    html += `<article class="search-result-card">`;
    html += `<h3>${title}</h3>`;
    html += `<p class="search-result-author">by ${author}</p>`;
    if (fandoms) html += `<p class="search-result-fandoms">${fandoms}</p>`;
    if (meta) html += `<p class="search-result-meta">${_escapeSearchHtml(meta)}</p>`;
    if (tags.length) {
      html += `<div class="search-result-tags">${tags.map((tag) => `<span>${_escapeSearchHtml(tag)}</span>`).join('')}</div>`;
    }
    html += `<button class="pr-btn-primary" onclick="window.loadStory(decodeURIComponent('${urlEncoded}'))">Load this story</button>`;
    html += `</article>`;
  });
  html += `</div>`;
  if (state.hasMore) {
    html += `<button class="pr-btn-outline search-load-more" onclick="window.loadMoreAo3Results()">Load 15 more</button>`;
  }
  resultsPanel.innerHTML = html;
}

export async function handleSearchSubmit(query, options = {}) {
  const topBar = document.getElementById('global-search');
  const inputEl = document.getElementById('ao3-page-search');
  const rawQuery = (query || inputEl?.value || topBar?.value || '').trim();

  if (rawQuery && /^https?:\/\//i.test(rawQuery)) {
    const parsedSearch = _readAo3SearchPayloadFromUrl(rawQuery);
    const isWorkUrl = /archiveofourown\.org\/works\/\d+/i.test(rawQuery);
    if (!parsedSearch && isWorkUrl) {
      const resultsPanel = document.getElementById('search-results-panel');
      if (resultsPanel) resultsPanel.innerHTML = `<p style="color:var(--text-muted);">Extracting story...</p>`;
      window.loadStory(rawQuery);
      return;
    }
  }

  if (typeof window.showView === 'function') window.showView('search-view');
  const resultsPanel = document.getElementById('search-results-panel');
  const append = !!options.append;
  let payload;
  if (append && window._ao3SearchState?.payload) {
    payload = { ...window._ao3SearchState.payload, page: window._ao3SearchState.nextPage || ((window._ao3SearchState.page || 1) + 1), limit: 15 };
  } else {
    payload = _buildAo3SearchPayload(rawQuery, { page: options.page || 1 });
  }

  if (!payload.query && !payload.title && !payload.author && !payload.fandom && payload.rating === 'Any' && payload.category === 'Any' && payload.language === 'Any' && !payload.complete && !payload.words_min && !payload.words_max) {
    return;
  }

  const displayTerm = _ao3DisplayTerm(payload);
  if (!append) {
    if (topBar && topBar.value !== (payload.query || rawQuery)) topBar.value = payload.query || rawQuery;
    if (inputEl && inputEl.value !== (payload.query || rawQuery)) inputEl.value = payload.query || rawQuery;
    window._ao3SearchState = { payload, results: [], page: payload.page || 1, hasMore: false, nextPage: null, displayTerm };
    if (resultsPanel) resultsPanel.innerHTML = `<p style="color:var(--text-muted);">Searching AO3 for "${_escapeSearchHtml(displayTerm)}"...</p><p style="color:var(--text-muted);font-size:0.82rem;opacity:0.8;margin-top:6px;">AO3 blocks automated traffic, so results are fetched through a proxy — this can take up to a minute. Hang tight.</p>`;
  }
  if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_bubble_point');

  const started = performance.now();
  let data = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AO3_SEARCH_TIMEOUT_MS);
    try {
      const res = await window._rateLimitedFetch('search', () =>
        fetch(`${window.HF_API_BASE}/api/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
                                                );
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`search returned ${res.status}`);
      data = await res.json();
      lastErr = null;
      if (window.Diagnostics) window.Diagnostics.log('INFO', `AO3 search ${Math.round(performance.now() - started)}ms`, {
        attempt,
        status: data.status,
        results: Array.isArray(data.results) ? data.results.length : 0,
        page: data.page,
      });
      break;
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  if (lastErr) {
    const externalUrl = `https://archiveofourown.org/works/search?work_search%5Bquery%5D=${encodeURIComponent(displayTerm)}`;
    if (resultsPanel) {
      resultsPanel.innerHTML = `<div class="pr-card search-state-card"><p>AO3 search timed out or failed.</p><p>Open the exact AO3 search, try again, or paste a story URL directly.</p>${_externalSearchLink(externalUrl)}</div>`;
    }
    return;
  }

  if (!data || data.status !== 'ok') {
    const externalUrl = data?.url || `https://archiveofourown.org/works/search?work_search%5Bquery%5D=${encodeURIComponent(displayTerm)}`;
    if (resultsPanel) {
      resultsPanel.innerHTML = `<div class="pr-card search-state-card"><p>${_escapeSearchHtml(data?.reason || 'AO3 search is temporarily unavailable.')}</p><p>Try again in a minute, open the exact AO3 search, or paste a story URL directly.</p>${_externalSearchLink(externalUrl)}</div>`;
    }
    return;
  }

  const incoming = Array.isArray(data.results) ? data.results : [];
  const prior = append ? (window._ao3SearchState?.results || []) : [];
  window._ao3SearchState = {
    payload: { ...payload, page: data.page || payload.page || 1 },
    results: prior.concat(incoming).slice(0, 200),
    page: data.page || payload.page || 1,
    hasMore: !!data.has_more,
    nextPage: data.next_page,
    displayTerm,
  };
  _renderAo3Results(data, append);
}

window.loadMoreAo3Results = function() {
  if (!window._ao3SearchState?.hasMore) return;
  return handleSearchSubmit('', { append: true });
};
window.handleSearchSubmit = handleSearchSubmit;

// ── FicHub via Backend Proxy ────────────────────────────────────────────────
// Story fetches route through our own backend, which uses the Zyte API to
// bypass Cloudflare and datacenter-IP blocks (no public CORS proxies).

function _fichubApiUrl(storyUrl) {
  const clean = storyUrl.replace(/^https?:\/\//i, '').split('?')[0].split('#')[0].replace(/\/chapters\/\d+.*$/, '');
  return `https://fichub.net/api/v0/epub?q=${clean}`;
}

async function _fichubResolve(fichubApiUrl, sig, onPass) {
  const maxMs = 90000;
  const deadline = Date.now() + maxMs;
  let round = 0;
  while (Date.now() < deadline && !(sig && sig.aborted)) {
    round++;
    if (round > 1 && typeof onPass === 'function') onPass(round);
    try {
      const backendUrl = `${window.HF_API_BASE || ''}/api/fichub-proxy?url=${encodeURIComponent(fichubApiUrl)}`;
      // Use AbortController for internal 50s timeout so we don't hit HF's 60s hard limit silently
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 50000);
      const onAbort = () => c.abort();
      if (sig) sig.addEventListener('abort', onAbort, { once: true });
      let r;
      try {
        r = await fetch(backendUrl, { signal: c.signal });
      } finally {
        clearTimeout(t);
        if (sig) sig.removeEventListener('abort', onAbort);
      }

      if (r.status === 429) {
        let ra = parseFloat(r.headers.get('retry-after') || '5');
        await new Promise(res => setTimeout(res, Math.min(Math.max(ra, 1), 30) * 1000));
        continue;
      }
      // Non-retryable upstream errors — abort immediately instead of spinning.
      // 502 = upstream service failed (Cloudflare block, FicHub error, etc.)
      // 500 = our proxy crashed (shouldn't happen, but treat as fatal)
      if (r.status === 500 || r.status === 502 || r.status === 400 || r.status === 403 || r.status === 404) {
        console.warn(`FicHub proxy returned fatal status ${r.status} — aborting retries`);
        return null;
      }
      if (r.ok) {
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('json')) {
          console.warn('FicHub proxy returned non-JSON content-type:', ct, '— aborting retries');
          return null;
        }
        const data = await r.json();
        if (data) {
          if (data.err === 0) return { data };
          if (typeof data.err === 'number' && data.err < 0) {
            console.warn('FicHub returned fatal error code:', data.err, data.msg || '');
            return null;
          }
        }
      } else {
        console.warn(`FicHub proxy returned error status: ${r.status}`);
        return null;
      }
    } catch (e) { console.warn('FicHub resolve attempt failed:', e); }

    // Abort-aware retry gap
    if (sig && sig.aborted) break;
    await new Promise(res => {
      const t = setTimeout(res, 2000);
      if (sig) sig.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
    });
  }
  return null;
}

async function _fichubDownloadEpub(epubUrl, dummyPreferredProxy, sig) {
  const maxMs = 120000;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline && !(sig && sig.aborted)) {
    try {
      const backendUrl = `${window.HF_API_BASE || ''}/api/fetch-epub?url=${encodeURIComponent(epubUrl)}`;
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 50000);
      const onAbort = () => c.abort();
      if (sig) sig.addEventListener('abort', onAbort, { once: true });
      let r;
      try {
        r = await fetch(backendUrl, { signal: c.signal });
      } finally {
        clearTimeout(t);
        if (sig) sig.removeEventListener('abort', onAbort);
      }
      if (r.ok) {
        const b = await r.blob();
        if (b.size > 1000) return b;
      }
    } catch (e) { console.warn('FicHub EPUB download attempt failed:', e); }
    if (sig && sig.aborted) break;
    await new Promise(res => {
      const t = setTimeout(res, 2000);
      if (sig) sig.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
    });
  }
  return null;
}

// Controller for the in-flight story load (AO3/FicHub path) so a new load can
// abort a previous one instead of letting two run concurrently and fight over
// currentStory / the overlay's Cancel handler.
let _activeLoadAbort = null;

export async function loadStory(url, options = {}) {
  const preventNavigate = options.preventNavigate || false;
  // Start each load clean: a stale cancel flag from a prior fetch must not make
  // this load's real error look like a user-initiated cancel.
  window._storyFetchCancelled = false;
  // Re-entrancy guard: abort any still-in-flight previous load (quietly).
  if (_activeLoadAbort) {
    try {
      _activeLoadAbort._superseded = true;
      // If a background (silent) load supersedes a foreground one, the new load
      // shows no overlay of its own, so the superseded load must clear the
      // "Loading Story…" overlay it left up — otherwise it is orphaned forever.
      // A foreground supersede shows its own overlay, so it must NOT be cleared.
      _activeLoadAbort._supersededBySilent = preventNavigate;
      _activeLoadAbort.abort();
    } catch (e) {}
  }
  _activeLoadAbort = null;
  if (!preventNavigate && typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_story_loading');

  const showCloudflareFallback = (msg) => {
    if (typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
    if (typeof window.showSettingsModal === 'function') {
      const safeMessage = String(msg || "The site's bot shield is blocking our backend from downloading this story.")
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      window.showSettingsModal(
        'Cloudflare Shield Active',
        `<div class="cloudflare-warning" style="text-align:left;background:transparent;border:none;padding:0;">
           <p>${safeMessage}</p>
           <p style="font-size:0.85rem;opacity:0.85;margin-bottom:10px;">Two ways to read this story anyway:</p>
           <button id="cloudflare-open-story" class="pr-btn-outline" style="width:100%;border-color:#c9a75c;color:#c9a75c;margin-bottom:15px;">Open Story in New Tab</button>
           <p style="font-size:0.85rem;opacity:0.85;margin-bottom:10px;">Or save the page and reload it here:</p>
           <button class="pr-btn-outline" style="width:100%;" onclick="window.showCloudflareDownloadHelp()">How to save &amp; load locally</button>
           <p style="font-size:0.8rem;color:var(--text-muted);margin:12px 0 0 0;text-align:center;">Or try a different story, or wait a few minutes and try again.</p>
         </div>`
      );
      queueMicrotask(() => {
        document.getElementById('cloudflare-open-story')?.addEventListener('click', () => {
          let target;
          try {
            target = new URL(String(url), window.location.href);
          } catch (_) {
            return;
          }
          if (target.protocol === 'http:' || target.protocol === 'https:') {
            window.open(target.href, '_blank', 'noopener,noreferrer');
          }
        }, { once: true });
      });
    }
    if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_network_error');
  };

  let fetchUrl = url;
  let existingLibEntry = null;
  // This call's own abort controller, once one is created. Compared against the
  // module-level _activeLoadAbort in the finally block so a slow unwind cannot
  // clear a newer load's registration.
  let ownAbort = null;

  // 1. Try to load from local IndexedDB cache first (checking both URL and Title)
  if (window.userProfile && window.userProfile.library && typeof window._loadStoryChapters === 'function') {
    const _norm = (u) => u ? String(u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase() : null;
    existingLibEntry = window.findLibraryStoryByRef?.(url) || null;
    if (!existingLibEntry) {
      existingLibEntry = window.userProfile.library.find((story) => {
        const targetNorm = _norm(url);
        const storyUrlNorm = _norm(story.url);
        const storySourceNorm = _norm(story.sourceUrl);
        return (targetNorm && ((storyUrlNorm && storyUrlNorm === targetNorm) || (storySourceNorm && storySourceNorm === targetNorm)))
          || story.title === url
          || story.storyKey === url
          || (window.getStoryStableKey?.(story) === url);
      });
    }
    if (existingLibEntry) {
      try {
        const storyRef = existingLibEntry.storyKey
          || window.getStoryStableKey?.(existingLibEntry)
          || existingLibEntry.title;
        let cachedChapters = await window._loadStoryChapters(storyRef, existingLibEntry);
        if ((!cachedChapters || !cachedChapters.length) && storyRef !== existingLibEntry.title) {
          cachedChapters = await window._loadStoryChapters(existingLibEntry.title, existingLibEntry);
          if (cachedChapters?.length) {
            window._saveStoryChapters?.(storyRef, cachedChapters, existingLibEntry).catch(() => {});
          }
        }
        if (cachedChapters && cachedChapters.length > 0) {
          console.log("Loading story chapters from local storage:", existingLibEntry.title);
          window.currentStory = existingLibEntry;
          window.currentStory.chapters = cachedChapters;
          window.currentChapterIndex = Math.max(
            0,
            Math.min(Number(existingLibEntry.progressChapter) || 0, cachedChapters.length - 1),
          );
          const activeParagraphs = cachedChapters[window.currentChapterIndex]?.paragraphs || [];
          window.currentParagraphIndex = Math.max(
            0,
            Math.min(Number(existingLibEntry.progressParagraph) || 0, Math.max(0, activeParagraphs.length - 1)),
          );

          // Backfill word count dynamically if missing
          if (!window.currentStory.words || window.currentStory.words === '-' || window.currentStory.words === '0') {
            let n = 0;
            cachedChapters.forEach((ch) => (ch.paragraphs || []).forEach((p) => (n += p.split(/\s+/).filter(Boolean).length)));
            if (n > 0) {
              window.currentStory.words = n.toLocaleString();
              if (typeof window.saveLocalData === 'function') {
                window.saveLocalData();
              }
            }
          }

          if (!preventNavigate && typeof window.populateReaderUI === 'function')
            window.populateReaderUI(window.currentStory, window.currentStory.author || 'Unknown');
          if (!preventNavigate && typeof window.recordStoryHistory === 'function') window.recordStoryHistory(window.currentStory);
          if (!preventNavigate && typeof window.showView === 'function') window.showView('reading-view');
          if (!preventNavigate && typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
          if (!preventNavigate && typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_holding_bubble_happy');
          if (!preventNavigate) await _ensureCacheDecisionModal();
          return;
        }
      } catch(e) {
        console.warn("Failed to load chapters from cache, falling back to fetch", e);
      }
      // If found in library but not cached: for uploaded documents (no valid URL), notify gracefully
      const rawEntryUrl = existingLibEntry.url || existingLibEntry.sourceUrl || existingLibEntry.link || '';
      const validEntryUrl = normalizeStoryUrl(rawEntryUrl);
      if (validEntryUrl && isValidStoryUrl(validEntryUrl)) {
        fetchUrl = validEntryUrl;
      } else {
        if (!preventNavigate) {
          alert(`Could not load stored chapters for "${existingLibEntry.title || 'Uploaded Document'}". Please re-upload the file.`);
          if (typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
        }
        return;
      }
    }
  }

  fetchUrl = normalizeStoryUrl(fetchUrl);



  // 3. Intercept local file paths or filenames entered into URL input. Must
  // never catch this app's OWN internal reference schemes — /api/... (curated
  // stories) and /local-upload/... (re-opened uploads) are exactly the
  // fetchUrl values step 1 above legitimately produces once a library entry's
  // cached chapters are missing. The bare leading-"/" alternative below used to
  // match those too, so re-opening ANY not-yet-cached curated story, or ANY
  // uploaded document whose cache was evicted, hit this alert and never loaded.
  const _trimmedUrl = (fetchUrl || '').trim();
  const _isAppInternalRef = /^(\/api\/|\/local-upload\/|local:\/\/)/i.test(_trimmedUrl);
  if (!_isAppInternalRef && (_trimmedUrl.match(/\.(pdf|epub|docx|txt|html|htm)$/i) || _trimmedUrl.match(/^(file:\/\/|[a-z]:[\\\/]|\/)/i))) {
    if (!preventNavigate) {
      if (typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
      alert("To import a local PDF, EPUB, or document file, please click the 'Choose File' button or drop the file onto the upload area.");
    }
    return;
  }

  // 4. Validate URL before network fetch
  if (!isValidStoryUrl(fetchUrl)) {
    // In background caching mode there is no user to see an alert, and the
    // caller detects the unopened story from the unchanged currentStory. A
    // URL-less uploaded story whose chapters were evicted reaches here on
    // resume; alerting would be a spurious "Invalid story URL" popup.
    if (!preventNavigate) {
      alert("Invalid story URL or address range. Please enter a valid public http(s) URL.");
      if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_network_error');
      if (typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
    }
    return;
  }

  const _isAo3 = fetchUrl.includes('archiveofourown.org/works/');

  try {
    let data;

    // Uploaded documents (/local-upload/… or local://…) have no network source.
    // Reaching here means step 1's cache lookup missed (chapters evicted), so the
    // only recovery is a re-upload — never a backend scrape, which would just 400
    // on the non-http ref and pop a spurious Cloudflare dialog.
    if (/^(\/local-upload\/|local:\/\/)/i.test(fetchUrl)) {
      if (!preventNavigate) {
        if (typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
        alert(`Could not load stored chapters for "${(existingLibEntry && existingLibEntry.title) || 'this uploaded document'}". Please re-upload the file.`);
      }
      return;
    }

    if (fetchUrl.startsWith('/api/library/curated/')) {
      // ── Curated library stories — simple direct fetch ──
      const response = await fetch(`${window.HF_API_BASE}${fetchUrl}`);
      if (!response.ok) throw new Error('CURATED_FETCH_FAILED');
      data = await _safeParseJson(response, 'General');

    } else if (_isAo3) {
      // ── AO3 stories: FicHub EPUB first, backend scrape fallback ──
      const ao3Controller = new AbortController();
      ownAbort = ao3Controller;
      _activeLoadAbort = ao3Controller;
      const ao3Timeout = setTimeout(() => ao3Controller.abort(), 120000);
      const _cancelFetch = () => { window._storyFetchCancelled = true; try { ao3Controller.abort(); } catch (e) {} };

      if (!preventNavigate && typeof window.showLoadingOverlay === 'function')
        window.showLoadingOverlay('Loading Story...', 'Fetching from FicHub archive...', _cancelFetch);

      let fichubSuccess = false;
      try {
        // Step 1 — resolve metadata + epub_url via our backend proxy
        const resolved = await _fichubResolve(
          _fichubApiUrl(fetchUrl),
          ao3Controller.signal,
          (pass) => { if (!preventNavigate && typeof window.showLoadingOverlay === 'function')
            window.showLoadingOverlay(
              'Preparing this story...',
              'FicHub is generating this EPUB for the first time — this can take up to a minute. Hang tight...',
              _cancelFetch
            ); }
        );
        if (!resolved) throw new Error('FICHUB_RESOLVE_FAILED');
        const fhData = resolved.data;
        const epubPath = fhData.epub_url || fhData.html_url;
        if (!epubPath) throw new Error('FICHUB_NO_URL');

        // Step 2 — download the EPUB binary
        if (!preventNavigate && typeof window.showLoadingOverlay === 'function')
          window.showLoadingOverlay('Downloading...', 'Getting EPUB from FicHub archive', _cancelFetch);
        const epubUrl = 'https://fichub.net' + epubPath;
        const blob = await _fichubDownloadEpub(epubUrl, resolved.proxy, ao3Controller.signal);
        if (!blob) throw new Error('FICHUB_DL_FAILED');

        clearTimeout(ao3Timeout);
        if (!preventNavigate && typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();

        // Step 3 — hand off to the existing upload parser
        const title = fhData.meta?.title;
        const file  = new File([blob], title ? `${title}.epub` : 'story.epub', { type: 'application/epub+zip' });
        if (typeof window.processUploadedFile === 'function') {
          // Await so a background (preventNavigate) caller does not run its
          // post-load "did the story open?" check before parsing finishes, and
          // so silent mode is propagated (no navigation/overlay/alert).
          await window.processUploadedFile(file, fhData.meta, { silent: preventNavigate });
          fichubSuccess = true;
        }
      } catch(fichubErr) {
        clearTimeout(ao3Timeout);
        if (ao3Controller._superseded) {
          if (ao3Controller._supersededBySilent && typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
          return;
        }
        if (window._storyFetchCancelled) {
          window._storyFetchCancelled = false;
          if (typeof window.virtueSpeak === 'function') window.virtueSpeak("Okay - I stopped loading that story.", 3500);
          if (typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
          return;
        }
        console.warn('FicHub primary path failed, falling back to backend scrape:', fichubErr.message);
      }

      if (fichubSuccess) return;

      // ── Fallback: try backend scrape (Zyte → CF Worker → direct) ──
      if (!preventNavigate && typeof window.showLoadingOverlay === 'function')
        window.showLoadingOverlay('Retrying...', 'FicHub unavailable — trying direct scrape via Zyte proxy...', _cancelFetch);

      const cookies = window._cookiesForUrl(fetchUrl);
      const body = cookies ? { url: fetchUrl, cookies } : { url: fetchUrl };
      let response = null, lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (window._storyFetchCancelled || ao3Controller.signal.aborted) break;
        const controller = new AbortController();
        // The backend Zyte browser-render tier for a Cloudflare-blocked AO3 work
        // legitimately takes up to ~35s (nearer ~55s worst case across both Zyte
        // tiers), all under HF's 60s route ceiling. A 15s client abort guaranteed
        // this fallback died before it could ever succeed — exactly the blocked
        // case it exists for. Allow 45s, and keep it cancellable via the overlay
        // (propagate the outer AO3 abort so Cancel actually stops the request).
        const timeoutId = setTimeout(() => controller.abort(), 45000);
        const _propagateAbort = () => { try { controller.abort(); } catch (_) {} };
        ao3Controller.signal.addEventListener('abort', _propagateAbort, { once: true });
        try {
          response = await window._rateLimitedFetch('scrape', () =>
            fetch(`${window.HF_API_BASE}/api/scrape`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            })
                                                   );
          clearTimeout(timeoutId);
          ao3Controller.signal.removeEventListener('abort', _propagateAbort);
          if (response.ok) break;
          lastErr = new Error('SCRAPE_FAILED');
        } catch (e) {
          clearTimeout(timeoutId);
          ao3Controller.signal.removeEventListener('abort', _propagateAbort);
          lastErr = e;
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
      }
      // A superseding load or a user Cancel aborted us: exit quietly instead of
      // surfacing a spurious Cloudflare dialog for a request the user abandoned.
      if (ao3Controller._superseded) {
        if (ao3Controller._supersededBySilent && typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
        return;
      }
      if (window._storyFetchCancelled) {
        window._storyFetchCancelled = false;
        if (typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
        if (typeof window.virtueSpeak === 'function') window.virtueSpeak("Okay - I stopped loading that story.", 3500);
        return;
      }
      if (!response || !response.ok) throw (lastErr || new Error('SCRAPE_FAILED'));

      data = await _safeParseJson(response, 'General');
      if (data.cloudflare_blocked) {
        showCloudflareFallback();
        return;
      }

    } else {
      // ── Non-AO3 URLs: backend scrape directly ──
      // Registered as the active load so a newer loadStory() can supersede this
      // one. Previously only the AO3 branch published a controller, so a
      // non-AO3 fetch ran to completion in the background and could clobber
      // currentStory after the user had already opened something else.
      const scrapeController = new AbortController();
      ownAbort = scrapeController;
      _activeLoadAbort = scrapeController;
      const cookies = window._cookiesForUrl(fetchUrl);
      const body = cookies ? { url: fetchUrl, cookies } : { url: fetchUrl };
      let response = null, lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (window._storyFetchCancelled || scrapeController.signal.aborted) break;
        const controller = new AbortController();
        // Match the AO3 fallback budget: a full Zyte browser render can take
        // ~35s+, and the old 15s abort killed legitimate slow scrapes early.
        const timeoutId = setTimeout(() => controller.abort(), 45000);
        const _propagateAbort = () => { try { controller.abort(); } catch (_) {} };
        scrapeController.signal.addEventListener('abort', _propagateAbort, { once: true });
        try {
          response = await window._rateLimitedFetch('scrape', () =>
            fetch(`${window.HF_API_BASE}/api/scrape`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            })
                                                   );
          clearTimeout(timeoutId);
          scrapeController.signal.removeEventListener('abort', _propagateAbort);
          if (response.ok) break;
          lastErr = new Error('SCRAPE_FAILED');
        } catch (e) {
          clearTimeout(timeoutId);
          scrapeController.signal.removeEventListener('abort', _propagateAbort);
          lastErr = e;
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
      }
      if (scrapeController._superseded) {
        if (scrapeController._supersededBySilent && typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
        return;
      }
      if (!response || !response.ok) throw (lastErr || new Error('SCRAPE_FAILED'));

      data = await _safeParseJson(response, 'General');
      if (data.cloudflare_blocked) {
        showCloudflareFallback();
        return;
      }
    }

    if (!preventNavigate && typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
    window.currentStory = data;
    window.currentChapterIndex = 0;
    window.currentParagraphIndex = 0;
    if (typeof window.addToLibrary === 'function') window.addToLibrary(window.currentStory);
    if (!preventNavigate && typeof window.populateReaderUI === 'function')
      window.populateReaderUI(window.currentStory, window.currentStory.author || 'Unknown');
    if (!preventNavigate && typeof window.recordStoryHistory === 'function') window.recordStoryHistory(window.currentStory);
    if (!preventNavigate && typeof window.showView === 'function') window.showView('reading-view');
    const suppressCache = window._pocketSuppressCacheDecision;
    if (!preventNavigate && !suppressCache) await _ensureCacheDecisionModal();
  } catch (error) {
    if (!preventNavigate && typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
    if (!preventNavigate) showCloudflareFallback();
  } finally {
    // Only clear the slot if it is still OURS. A newer loadStory() may have
    // already installed its own controller while this one was unwinding;
    // blanking it unconditionally left that newer load unabortable, so the load
    // after it could not supersede anything.
    if (_activeLoadAbort === ownAbort) _activeLoadAbort = null;
  }
}
window.loadStory = loadStory;

export async function _silentFetchStoryChapters(url, forceScrape = false) {
  if (!isValidStoryUrl(url)) {
    throw new Error('Invalid story URL');
  }
  let data;
  const _isAo3 = url.includes('archiveofourown.org/works/');

  // Uploaded documents have no network source — nothing to fetch or cache in the
  // background. Signal a clean skip instead of POSTing a doomed scrape (400).
  if (/^(\/local-upload\/|local:\/\/)/i.test(url)) {
    throw new Error('LOCAL_UPLOAD_NO_SOURCE');
  }

  if (url.startsWith('/api/library/curated/')) {
    const response = await fetch(`${window.HF_API_BASE}${url}`);
    if (!response.ok) throw new Error('CURATED_FETCH_FAILED');
    data = await _safeParseJson(response, 'General');
    return window.normalizeStoryChapters?.(data.chapters) || data.chapters || null;
  }

  // ── AO3: FicHub first, backend scrape fallback ──
  if (_isAo3 && !forceScrape) {
    try {
      const resolved = await _fichubResolve(_fichubApiUrl(url));
      if (resolved) {
        const epubPath = resolved.data.epub_url || resolved.data.html_url;
        if (epubPath) {
          const blob = await _fichubDownloadEpub('https://fichub.net' + epubPath, resolved.proxy);
          if (blob && blob.size > 1000) {
            const file = new File([blob], 'story.epub', { type: 'application/epub+zip' });
            const formData = new FormData();
            formData.append('file', file);
            const parseRes = await fetch(`${window.HF_API_BASE}/api/upload`, { method: 'POST', body: formData });
            if (parseRes.ok) {
              const parseData = await _safeParseJson(parseRes, 'General');
              return window.normalizeStoryChapters?.(parseData.chapters) || parseData.chapters || null;
            }
          }
        }
      }
    } catch (e) {
      console.warn('Silent FicHub fetch failed, trying backend scrape:', e.message);
    }
  }

  // ── Backend scrape (fallback for AO3, primary for everything else) ──
  const cookies = typeof window._cookiesForUrl === 'function' ? window._cookiesForUrl(url) : null;
  const body = cookies ? { url, cookies } : { url };
  const _scrapeCtrl = new AbortController();
  // Align with the interactive scrape budget so a slow Zyte browser render
  // (up to ~35s) is not cut off early during Away-Mode silent fetches.
  const _scrapeTimer = setTimeout(() => _scrapeCtrl.abort(), 45000);
  try {
    const response = await fetch(`${window.HF_API_BASE}/api/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: _scrapeCtrl.signal
    });
    if (!response.ok) throw new Error('SCRAPE_FAILED');
    data = await _safeParseJson(response, 'General');
    if (data.cloudflare_blocked) throw new Error('CLOUDFLARE_BLOCKED');
    return window.normalizeStoryChapters?.(data.chapters) || data.chapters || null;
  } finally {
    clearTimeout(_scrapeTimer);
  }
}
window._silentFetchStoryChapters = _silentFetchStoryChapters;
