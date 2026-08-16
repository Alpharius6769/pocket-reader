// buffer_manager.js - Updated with auto worker detection and concurrency control
import { saveAudioChunk, getAudioChunk } from './storage_core.js?v=storage-v14';
import {
  evaluateCpuThermalRest,
  POCKET_THERMAL_HISTORY_LIMIT,
  writePocketExpressiveChoice,
  detectMobilePlatform,
  isMobileLikePlatform,
} from './pocket_backend_policy.js?v=backend-v22';

const HARD_CAP_WORKERS   = window.HARD_CAP_WORKERS;
const MANUAL_CAP_WORKERS = window.MANUAL_CAP_WORKERS;
const DEFAULT_MAX_WORKERS = window.DEFAULT_MAX_WORKERS;
const POCKET_VOICES = window.POCKET_VOICES || [];
const POCKET_DEFAULT_VOICE = window.POCKET_DEFAULT_VOICE || 'rayne';
const _resolveActiveEngine = window._resolveActiveEngine;

const FAST_NARRATION_PARAM = 'tts_fast';
const FAST_NARRATION_RESUME_KEY = 'pr_fast_narration_resume_v1';
const FAST_NARRATION_RETRY_KEY = 'pr_fast_narration_retry_v1';
const CACHE_JOB_RESUME_KEY = 'pr_cache_job_resume_v1';
const CACHE_JOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

try {
  const savedQueue = localStorage.getItem('pocketPrecacheQueue');
  window.precacheQueue = savedQueue ? JSON.parse(savedQueue) : [];
} catch (_) {
  window.precacheQueue = [];
}

function _isolationReady() {
  return window.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
}

function _narrationRuntimeLabel() {
  const runtime = window._pocketBackendRuntime || {};
  if (runtime.selectedBackend === 'webgpu') {
    return 'WebGPU FP16 — GPU narration (auto-falls back to WASM if it lags)';
  }
  const threads = Number(runtime.threadCount || 0);
  const isolated = _isolationReady();
  if (!isolated || threads <= 1) {
    return 'Slow 1-thread mode (isolation off) — expect ~30–60s per paragraph';
  }
  return `Threaded WASM ×${threads}`;
}

function _minimumPlaybackReadyCount(total) {
  return Math.min(20, Math.max(0, Number(total) || 0));
}
window.getPocketPlaybackReadyCount = _minimumPlaybackReadyCount;

export function formatAudioRunway(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
window.formatAudioRunway = formatAudioRunway;

export function estimateBankedRunwaySec(paragraphCount, avgSecPerPara = 18) {
  return Math.max(0, Number(paragraphCount) || 0) * avgSecPerPara;
}
window.estimateBankedRunwaySec = estimateBankedRunwaySec;

// updateUI() runs on a 1s ticker for the whole job, and it used to persist the
// resume record on every tick — a synchronous JSON write to localStorage once a
// second for hours. The record only has to survive a crash or a background kill,
// so a periodic write plus the explicit pagehide/visibilitychange/pause flushes
// is equivalent in practice at a fraction of the main-thread cost.
const CACHE_JOB_PERSIST_INTERVAL_MS = 15000;
let _lastCacheJobPersistAt = 0;

function _persistCacheJob(manager, { force = true } = {}) {
  const now = Date.now();
  if (!force && now - _lastCacheJobPersistAt < CACHE_JOB_PERSIST_INTERVAL_MS) return;
  const activeTask = manager.queue?.[0];
  const storyTitle = activeTask?.storyTitle || window.currentStory?.title;
  const storyRef = activeTask?.storyRef || window.currentStory?.storyKey || window.getStoryStableKey?.(window.currentStory) || storyTitle;
  if (!storyTitle) return;
  _lastCacheJobPersistAt = now;
  try {
    localStorage.setItem(CACHE_JOB_RESUME_KEY, JSON.stringify({
      active: Boolean(manager.isActive && !manager.paused),
      paused: Boolean(manager.paused),
      mode: manager.mode || 'Normal',
      storyTitle,
      storyRef,
      storyTitles: [...new Set((manager.queue || []).map((task) => task.storyTitle).filter(Boolean))],
      storyRefs: [...new Set((manager.queue || []).map((task) => task.storyRef || task.storyTitle).filter(Boolean))],
      savedAt: Date.now(),
    }));
  } catch (_) {}
}

function _escapeCacheStatus(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Encode a value for use inside a single-quoted JS string in an inline onclick.
// encodeURIComponent deliberately leaves ' unescaped, and HTML entity decoding
// runs BEFORE the JS parser, so &#39; would still close the string — the apostrophe
// has to become %27 before it ever reaches the attribute. Matches the guard used
// at every other inline-handler call site (library_manager, storage_core, api_core).
function _encodeForInlineHandler(value) {
  return encodeURIComponent(String(value ?? '')).replace(/'/g, '%27');
}

function _clearPersistedCacheJob() {
  try { localStorage.removeItem(CACHE_JOB_RESUME_KEY); } catch (_) {}
  try { localStorage.removeItem(CACHE_RESUME_GUARD_KEY); } catch (_) {}
}

// Crash-loop breaker. On iPhones, WebKit can OOM-kill the page mid-cache;
// unconditional auto-resume then relaunched the same job into the same OOM,
// and after ~3 rapid kills iOS blacklists the URL entirely ("A problem
// repeatedly occurred"). Allow at most two automatic resumes per 10 minutes;
// beyond that the user must restart caching deliberately.
const CACHE_RESUME_GUARD_KEY = 'pr_cache_resume_guard_v1';
function _autoResumeAllowed() {
  try {
    const now = Date.now();
    const attempts = (JSON.parse(localStorage.getItem(CACHE_RESUME_GUARD_KEY) || '[]'))
      .filter((t) => Number.isFinite(t) && now - t < 10 * 60 * 1000);
    if (attempts.length >= 2) return false;
    attempts.push(now);
    localStorage.setItem(CACHE_RESUME_GUARD_KEY, JSON.stringify(attempts));
    return true;
  } catch (_) {
    return true;
  }
}

function _supportsFastNarrationSession() {
  return window.isSecureContext === true && 'serviceWorker' in navigator;
}

// Field telemetry: how often does the ?tts_fast=1 service-worker isolation
// handoff actually yield an isolated context, per platform? Sizes the planned
// iOS WebGPU-without-isolation escape hatch from real data instead of guesses.
// Device-local; surfaced through the diagnostics device profile.
const ISOLATION_STATS_KEY = 'pr_isolation_stats_v1';
(function recordIsolationOutcome() {
  if (!_fastNarrationRequested()) return;
  try {
    const ua = navigator.userAgent || '';
    const detected = detectMobilePlatform(ua);
    const platform = detected === 'ios' ? 'ios' : (detected === 'android' ? 'android' : 'other');
    const stats = JSON.parse(localStorage.getItem(ISOLATION_STATS_KEY) || '{}');
    const bucket = stats[platform] || { attempts: 0, isolated: 0 };
    bucket.attempts += 1;
    if (window.crossOriginIsolated === true) bucket.isolated += 1;
    stats[platform] = bucket;
    stats.updatedAt = Date.now();
    localStorage.setItem(ISOLATION_STATS_KEY, JSON.stringify(stats));
    window.Diagnostics?.log(window.crossOriginIsolated === true ? 'INFO' : 'WARN',
      'Isolation handoff outcome', {
        platform,
        isolated: window.crossOriginIsolated === true,
        attempts: bucket.attempts,
        isolatedCount: bucket.isolated,
      });
  } catch (_) {}
})();

function _fastNarrationRequested() {
  return new URL(window.location.href).searchParams.get(FAST_NARRATION_PARAM) === '1';
}

function _snapshotNarrationStory(story, storyRef) {
  if (!story) return null;
  return {
    title: story.title || '',
    author: story.author || '',
    storyKey: story.storyKey || storyRef || '',
    url: story.url || '',
    sourceUrl: story.sourceUrl || story.source_url || '',
    progressChapter: Number(story.progressChapter) || 0,
    progressParagraph: Number(story.progressParagraph) || 0,
    narrationPreset: story.narrationPreset || null,
  };
}

function _isLoadableHandoffRef(ref) {
  const value = String(ref || '').trim();
  if (/^(\/api\/|\/local-upload\/|local:\/\/)/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function _requestFastNarrationReload(mode, action = 'cache') {
  if (!_supportsFastNarrationSession() || _isolationReady()) return false;
  // Mobile relies on cross-origin isolation just as much as desktop: multi-thread
  // WASM needs SharedArrayBuffer, and field data shows 4-thread narration is ~5x
  // faster than the single-thread fallback on a Pixel 6 Pro.
  if (!window.currentStory?.title) return false;
  const storyRef = window.currentStory.storyKey
    || window.getStoryStableKey?.(window.currentStory)
    || window.currentStory.title;
  const loadRef = window.currentStory.url || window.currentStory.sourceUrl || storyRef;
  const storySnapshot = _snapshotNarrationStory(window.currentStory, storyRef);

  // If ?tts_fast=1 is already present but isolation still failed, retry once
  // with a cache-busting query so the service worker re-applies COOP/COEP.
  if (_fastNarrationRequested()) {
    if (sessionStorage.getItem(FAST_NARRATION_RETRY_KEY) === '1') return false;
    sessionStorage.setItem(FAST_NARRATION_RETRY_KEY, '1');
  } else {
    sessionStorage.removeItem(FAST_NARRATION_RETRY_KEY);
  }

  if (!sessionStorage.getItem(FAST_NARRATION_RESUME_KEY)) {
    sessionStorage.setItem(FAST_NARRATION_RESUME_KEY, JSON.stringify({
      title: window.currentStory.title,
      storyRef,
      loadRef,
      storySnapshot,
      mode: mode || 'Normal',
      action: action || 'cache',
      requestedAt: Date.now(),
    }));
  } else {
    // Keep an existing Away Mode queue payload; only refresh the timestamp/mode.
    try {
      const existing = JSON.parse(sessionStorage.getItem(FAST_NARRATION_RESUME_KEY) || 'null') || {};
      existing.mode = mode || existing.mode || 'Normal';
      existing.action = action || existing.action || 'cache';
      existing.requestedAt = Date.now();
      if (!existing.title) existing.title = window.currentStory.title;
      if (!existing.storyRef) existing.storyRef = storyRef;
      if (!existing.loadRef) existing.loadRef = loadRef;
      if (!existing.storySnapshot) existing.storySnapshot = storySnapshot;
      sessionStorage.setItem(FAST_NARRATION_RESUME_KEY, JSON.stringify(existing));
    } catch (_) {
        sessionStorage.setItem(FAST_NARRATION_RESUME_KEY, JSON.stringify({
          title: window.currentStory.title,
          storyRef,
          loadRef,
          storySnapshot,
          mode: mode || 'Normal',
          action: action || 'cache',
          requestedAt: Date.now(),
        }));
    }
  }
  // Preserve the view the user was actually on when the FIRST reload was
  // requested. showView marks the active view with '.active-view' (not
  // '.active'); the old '.view.active' selector matched nothing and always
  // saved the 'home-view' fallback, so restore yanked the user to Home. Also,
  // an isolation-retry re-enters this function AFTER the reload has landed on
  // Home, so only record the view if one is not already stashed for this
  // reload chain — otherwise the retry would overwrite the real view with Home.
  if (!sessionStorage.getItem('POCKET_PRE-RELOAD_VIEW')) {
    const activeView = document.querySelector('.view.active-view')?.id || 'home-view';
    sessionStorage.setItem('POCKET_PRE-RELOAD_VIEW', activeView);
  }
  const target = new URL(window.location.href);
  target.searchParams.set(FAST_NARRATION_PARAM, '1');
  target.searchParams.set('tts_iso', String(Date.now()));
  // Cover the reboot with an overlay so the reload does not look like the app
  // randomly jumping to Home. The overlay is re-shown by _resumeFastNarrationCache
  // after the reload until the reader is restored.
  window.showLoadingOverlay?.('Preparing fast narration', 'Unlocking multi-threaded narration — one moment…');
  const go = () => window.location.replace(target.href);
  // Prefer an active controller so the navigate handler can stamp isolation headers.
  const regPromise = window.__prServiceWorkerRegistration || navigator.serviceWorker?.ready;
  Promise.resolve(regPromise)
    .then((reg) => reg?.active?.postMessage?.({ type: 'claim-clients' }))
    .catch(() => null)
    .finally(() => {
      if (navigator.serviceWorker?.controller || sessionStorage.getItem(FAST_NARRATION_RETRY_KEY) === '1') {
        go();
        return;
      }
      // First install: wait briefly for the worker to control this client.
      navigator.serviceWorker?.ready
        ?.then(() => setTimeout(go, 50))
        ?.catch(go) || go();
    });
  return true;
}

window.requestPocketNarrationIsolation = function requestPocketNarrationIsolation(action = 'playback', mode = 'Normal') {
  return _requestFastNarrationReload(mode, action);
};

function _isMobileNarrationPlatform() {
  return isMobileLikePlatform(navigator.userAgent || '')
    || (navigator.maxTouchPoints || 0) > 0;
}

function _awaitMobileNarrationGesture(action = 'cache') {
  if (!_isMobileNarrationPlatform()) {
    window.preparePocketMobileMediaSession?.();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      // This function is invoked directly by the user's button tap. Keep media
      // creation and play()/resume() calls synchronous so iOS grants playback.
      window.preparePocketMobileMediaSession?.();
      window.startBgKeepAlive?.();
      window.closeFeatureDialog?.();
      delete window.continuePocketNarrationAfterReload;
      resolve();
    };
    window.continuePocketNarrationAfterReload = finish;

    const verb = action === 'playback' ? 'Start narration' : 'Start caching';
    if (typeof window.showFeatureDialog === 'function') {
      window.showFeatureDialog(
        'Narration is ready',
        '<p>Pocket Reader prepared the faster, memory-safe narration session for this device.</p><p>Tap below once so your browser can authorize audio and background work.</p>',
        `<button class="pr-btn-primary" onclick="window.continuePocketNarrationAfterReload()">${verb}</button>`,
      );
      return;
    }

    // Minimal fallback for an unusually early resume before shared modal helpers
    // load. It still preserves the required direct user gesture.
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);padding:24px';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pr-btn-primary';
    button.textContent = verb;
    button.addEventListener('click', () => {
      overlay.remove();
      finish();
    }, { once: true });
    overlay.appendChild(button);
    document.body.appendChild(overlay);
  });
}

async function _resumeFastNarrationCache() {
  if (!_fastNarrationRequested()) return;
  const raw = sessionStorage.getItem(FAST_NARRATION_RESUME_KEY);
  if (!raw) return;

  let resume;
  try { resume = JSON.parse(raw); } catch (_) { resume = null; }
  if (!resume?.title || Date.now() - Number(resume.requestedAt || 0) > 120000) {
    sessionStorage.removeItem(FAST_NARRATION_RESUME_KEY);
    return;
  }

  // The reload reboots the app and briefly lands on Home before the reader is
  // restored. Keep an overlay up across that gap so it does not look like the
  // app is jumping around. (Issue: forced to homescreen when caching starts.)
  window.showLoadingOverlay?.('Preparing narration', 'Opening your story in fast multi-threaded mode…');

  const targetRef = resume.storyRef || resume.title;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    const library = window.userProfile?.library;
    const storyEntry = Array.isArray(library)
      ? (window.findLibraryStoryByRef?.(targetRef, library)
        || library.find((story) => story.storyKey === targetRef || story.title === resume.title))
      : null;
    const loadRef = storyEntry?.storyKey || storyEntry?.url || resume.loadRef || targetRef;
    // A reload can finish before the guest profile has hydrated. The previous
    // implementation waited only for that in-memory library entry, then gave
    // up and returned Home even though the original story URL was available.
    // Give hydration a brief head start, then restore directly from the
    // handoff URL/reference instead of treating a slow profile as a failure.
    if (!storyEntry && Date.now() - startedAt < 2500) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    let restoredFromStorage = false;
    if (!storyEntry && typeof window._loadStoryChapters === 'function') {
      try {
        const snapshot = resume.storySnapshot || {};
        let storedChapters = await window._loadStoryChapters(targetRef, snapshot);
        if ((!storedChapters || !storedChapters.length) && targetRef !== resume.title) {
          storedChapters = await window._loadStoryChapters(resume.title, snapshot);
        }
        if (storedChapters?.length) {
          window.currentStory = {
            ...snapshot,
            title: snapshot.title || resume.title,
            storyKey: snapshot.storyKey || targetRef,
            chapters: storedChapters,
          };
          window.currentChapterIndex = Number(snapshot.progressChapter) || 0;
          window.currentParagraphIndex = Number(snapshot.progressParagraph) || 0;
          restoredFromStorage = true;
          window.Diagnostics?.log('INFO', 'Restored narration handoff directly from local story storage', {
            title: resume.title,
            storyRef: targetRef,
            chapters: storedChapters.length,
          });
        }
      } catch (error) {
        window.Diagnostics?.log('WARN', 'Direct story-storage restore was unavailable', {
          title: resume.title,
          reason: error?.message || String(error),
        });
      }
    }
    const canLoadHandoff = _isLoadableHandoffRef(loadRef);
    if (restoredFromStorage || (typeof window.loadStory === 'function' && canLoadHandoff)) {
      if (!storyEntry) {
        window.Diagnostics?.log('WARN', 'Library hydration was slow; restoring from handoff reference', {
          title: resume.title,
          hasLoadRef: Boolean(resume.loadRef),
          hasStoryRef: Boolean(resume.storyRef),
        });
      }
      // Isolation still missing after first reload — try one hard retry.
      if (!_isolationReady() && sessionStorage.getItem(FAST_NARRATION_RETRY_KEY) !== '1') {
        window.currentStory = window.currentStory || { title: resume.title, storyKey: targetRef };
        if (!window.currentStory.title) window.currentStory.title = resume.title;
        if (_requestFastNarrationReload(resume.mode || 'Normal', resume.action || 'cache')) return;
      }
      if (Array.isArray(resume.awayQueue) && resume.awayQueue.length) {
        window.precacheQueue = [...resume.awayQueue];
        localStorage.setItem('pocketPrecacheQueue', JSON.stringify(window.precacheQueue));
      }
      // The user already made the cache decision (that is why we reloaded into
      // the isolated session). Suppress the cache-decision modal during this
      // restore so loadStory cannot re-prompt, then start caching exactly once
      // below. (Issue: a second cache popup reappeared after caching finished.)
      const isPermanent = resume.mode === 'Permanent';
      window._pocketSuppressCacheDecision = true;
      try {
        if (restoredFromStorage) {
          if (!isPermanent) {
            window.populateReaderUI?.(window.currentStory, window.currentStory.author || 'Unknown');
            window.recordStoryHistory?.(window.currentStory);
            window.showView?.('reading-view');
          }
        } else {
          await Promise.race([
            window.loadStory(loadRef, { preventNavigate: isPermanent }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Story restore timed out')), 20000)),
          ]);
        }
      } catch (error) {
        console.error('[PocketTTS] Story restore failed:', error);
        sessionStorage.removeItem(FAST_NARRATION_RESUME_KEY);
        sessionStorage.removeItem(FAST_NARRATION_RETRY_KEY);
        window._pocketSuppressCacheDecision = false;
        window.closeCacheModal?.();
        window.hideLoadingOverlay?.();
        window.virtueSpeak?.('Narration could not resume. Please start playback or caching again.', 6000);
        return;
      } finally {
        window._pocketSuppressCacheDecision = false;
      }
      window.closeCacheModal?.();
      window.hideLoadingOverlay?.();
      const savedView = sessionStorage.getItem('POCKET_PRE-RELOAD_VIEW');
      if (savedView) {
        sessionStorage.removeItem('POCKET_PRE-RELOAD_VIEW');
        window._pocketViewRestored = true;
        for (let i = 0; i < 20; i++) {
          if (typeof window.showView === 'function') break;
          await new Promise(r => setTimeout(r, 50));
        }
        if (typeof window.showView === 'function') {
          window.showView(savedView);
        }
      }
      if (!_isolationReady()) {
        const reason = 'Fast narration was requested, but cross-origin isolation was not established. SharedArrayBuffer is unavailable, so Pocket TTS is limited to one WASM thread.';
        console.warn(`[PocketTTS] ${reason}`);
        window.Diagnostics?.log('WARN', 'Pocket isolation failed', {
          reason,
          crossOriginIsolated: window.crossOriginIsolated === true,
          sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
          userAgent: navigator.userAgent,
          controller: !!navigator.serviceWorker?.controller,
        });
      } else {
        sessionStorage.removeItem(FAST_NARRATION_RETRY_KEY);
      }
      // Only start caching if loadStory actually restored the story. If it
      // failed (e.g. an uploaded story whose chapters could not be found, which
      // alerts "Invalid story URL"), starting a cache job would spin on a story
      // that never really loaded.
      const storyLoaded = window.currentStory
        && (window.currentStory.storyKey === targetRef
          || window.getStoryStableKey?.(window.currentStory) === targetRef
          || window.currentStory.title === resume.title)
        && Array.isArray(window.currentStory.chapters)
        && window.currentStory.chapters.length > 0;
      if (storyLoaded) {
        sessionStorage.removeItem(FAST_NARRATION_RESUME_KEY);
        if (resume.action === 'playback') {
          window.togglePlayState?.();
        } else if (resume.mode === 'Permanent' && Array.isArray(window.precacheQueue) && window.precacheQueue.length) {
          await BufferManager.startPrecacheQueue();
        } else {
          BufferManager.start(resume.mode || 'Normal');
        }
      } else {
        sessionStorage.removeItem(FAST_NARRATION_RESUME_KEY);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  window.closeCacheModal?.();
  window.hideLoadingOverlay?.();
  sessionStorage.removeItem(FAST_NARRATION_RESUME_KEY);
  sessionStorage.removeItem(FAST_NARRATION_RETRY_KEY);
  window.virtueSpeak?.('Story preparation timed out. Open the story and try caching again.', 6000);
}

// ── Screen Wake Lock (keep the screen awake during active caching) ───────────
// On mobile (esp. iOS) the screen sleeping suspends the synthesis Web Worker,
// which freezes caching. Holding a screen wake lock while caching keeps the
// display on. The browser auto-releases the lock whenever the tab is hidden, so
// we re-acquire it on visibilitychange if caching is still running. It is
// released the moment caching stops/completes/pauses, so listening-only sessions
// still let the screen sleep normally.
let _cacheWakeLock = null;
async function _requestCacheWakeLock() {
  if (_cacheWakeLock) return;                  // already held
  if (!('wakeLock' in navigator)) return;      // unsupported (e.g. iOS < 16.4)
  try {
    _cacheWakeLock = await navigator.wakeLock.request('screen');
    _cacheWakeLock.addEventListener('release', () => { _cacheWakeLock = null; });
  } catch (e) {
    _cacheWakeLock = null;                    // e.g. denied because tab not visible
  }
}
function _releaseCacheWakeLock() {
  if (!_cacheWakeLock) return;
  try { _cacheWakeLock.release(); } catch (e) {}
  _cacheWakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  const isCachingActive = BufferManager.isActive && !BufferManager.paused;
  if (document.visibilityState === 'visible') {
    if (isCachingActive) {
      _requestCacheWakeLock();
    }
    if (typeof window.stopBgKeepAlive === 'function' && !window.isPlaying && !isCachingActive) {
      window.stopBgKeepAlive();
    }
  } else if (document.visibilityState === 'hidden') {
    if (isCachingActive || window.isPlaying) {
      if (typeof window.startBgKeepAlive === 'function') {
        window.startBgKeepAlive();
      }
    }
  }
});

export const BufferManager = {
  isActive: false,
  paused: false,
  isReverifying: false,
  mode: 'Normal',
  queue: [],
  totalToCache: 0,
  cachedCount: 0,
  skippedCount: 0,
  consecutiveErrors: 0,
  containerEl: null,
  fillEl: null,
  textEl: null,
  etaEl: null,
  pauseBtnEl: null,
  // Concurrency control
  activeWorkers: 0,
  maxWorkers: DEFAULT_MAX_WORKERS,
  DEFAULT_MAX_WORKERS: DEFAULT_MAX_WORKERS,
  HARD_CAP_WORKERS: HARD_CAP_WORKERS,    // auto-detect ceiling (50% cores, max 4)
  MANUAL_CAP_WORKERS: MANUAL_CAP_WORKERS,  // ceiling when the user manually overrides (75% cores, max 8)
  _generation: 0,         // bumped on each (re)start so stale worker loops retire themselves
  _resumeAttempted: false,
  sessionStoryRefs: new Set(),
  _backendPreparationPromise: null,
  _backendParallelStarted: false,

  getReadyCount() {
    return Math.max(0, Number(this.cachedCount || 0) - Number(this.skippedCount || 0));
  },

  getBankedRunwaySec() {
    return estimateBankedRunwaySec(this.getReadyCount());
  },

  getBankedRunwayTime() {
    return formatAudioRunway(this.getBankedRunwaySec());
  },

  isPlaybackReadyForStory(story) {
    if (!story || this.mode === 'Permanent' || this.totalToCache <= 0) return true;
    const ref = story.storyKey || window.getStoryStableKey?.(story) || story.title;
    if (!ref || !this.sessionStoryRefs?.has(ref)) return true;
    const complete = this.cachedCount >= this.totalToCache;
    return complete || this.getReadyCount() >= _minimumPlaybackReadyCount(this.totalToCache);
  },

  initUI() {
    this.containerEl = document.getElementById('reader-buffer-container');
    this.fillEl = document.getElementById('reader-buffer-fill');
    this.textEl = document.getElementById('reader-buffer-text');
    this.etaEl = document.getElementById('reader-buffer-eta');
    this.pauseBtnEl = document.getElementById('cache-pause-btn');
    this.resumeBtnEl = document.getElementById('cache-resume-btn');
    this.cachingModalEl = document.getElementById('caching-progress-modal');
    this.cachingModalText = document.getElementById('caching-progress-text');
    this.cachingModalFill = document.getElementById('caching-progress-fill');
    this.cachingModalStats = document.getElementById('caching-progress-stats');
    this.cachingModalDismiss = document.getElementById('caching-progress-dismiss-btn');
    window.dismissCachingModal = () => {
      const el = document.getElementById('caching-progress-modal') || this.cachingModalEl;
      if (el) {
        el.style.display = 'none';
        el.classList.remove('active');
      }
    };
  },

  // The modal used to update only when a paragraph FINISHED — during an
  // 80-second render nothing moved and progress appeared frozen, then jumped.
  // While a job is active and the page is visible, re-render every second so
  // the live render hint (elapsed time / frames) visibly ticks.
  _syncUiTicker() {
    const shouldTick = this.isActive && !this.paused;
    if (shouldTick && !this._uiTicker) {
      this._uiTicker = setInterval(() => {
        if (!document.hidden) this.updateUI();
      }, 1000);
    } else if (!shouldTick && this._uiTicker) {
      clearInterval(this._uiTicker);
      this._uiTicker = null;
    }
  },

  _liveRenderHint() {
    if (!this._currentSynthStartedAt) return '';
    const progress = window._pocketGenerationProgress;
    const elapsedSec = Math.max(0, Math.round((Date.now() - this._currentSynthStartedAt) / 1000));
    if (progress && Date.now() - progress.at < 4000 && progress.frames > 0) {
      const audioSec = (progress.frames / 12.5).toFixed(0);
      return ` — rendering: ${elapsedSec}s (${audioSec}s of audio so far)`;
    }
    return ` — rendering: ${elapsedSec}s`;
  },

  updateUI() {
    if (!this.containerEl) this.initUI();
    this._syncUiTicker();
    if (typeof window.renderAwayModeUI === 'function') window.renderAwayModeUI();
    if (typeof window.updatePlayButtons === 'function') window.updatePlayButtons();
    // Away Mode playback guard lives in audio_core.js togglePlayState() directly

    const pct = this.totalToCache > 0 ? Math.floor((this.cachedCount / this.totalToCache) * 100) : 0;
    if (this.fillEl) this.fillEl.style.width = `${pct}%`;
    window.updateReaderDrawerStatus?.(this);

    // ── Away Mode bar status ─────────────────────────────────────────
    const awayBar = document.getElementById('away-mode-bar');
    const runway = this.getBankedRunwayTime();
    const runwayText = this.cachedCount > 0 ? ` · ~${runway} ready` : '';
    let statusText;
    if (this.isActive && !this.paused) {
      statusText = `Caching: ${pct}% (${this.cachedCount}/${this.totalToCache} paragraphs${runwayText})`;
      statusText += this._liveRenderHint();
      if (this._coolingUntil && this._coolingUntil > Date.now()) {
        statusText += ` - cooling pause (${Math.ceil((this._coolingUntil - Date.now()) / 1000)}s) to protect your device`;
      }
      if (this._lastSynthMs) {
        const runtime = typeof window.getPocketTtsRuntimeConfig === 'function' ? window.getPocketTtsRuntimeConfig() : null;
        const backendLabel = runtime?.selectedBackend === 'webgpu'
          ? 'WebGPU'
          : `WASM x${Math.max(1, Number(runtime?.wasmThreadCount || 1))}`;
        statusText += ` - last paragraph ${(this._lastSynthMs / 1000).toFixed(1)}s (${backendLabel})`;
      }
      if (awayBar) awayBar.classList.add('caching');
      _requestCacheWakeLock();
      if (typeof document !== 'undefined' && document.hidden && typeof window.startBgKeepAlive === 'function') {
        window.startBgKeepAlive();
      }
      // Rate-limited: this is the 1s UI ticker. The pagehide, visibilitychange
      // and pause() paths still force an immediate write.
      _persistCacheJob(this, { force: false });
    } else if (this.paused) {
      statusText = `Paused - ${pct}% cached${runwayText}`;
      if (awayBar) awayBar.classList.remove('caching');
      _releaseCacheWakeLock();
      if (!window.isPlaying) window.stopBgKeepAlive?.();
    } else if (this.cachedCount >= this.totalToCache && this.totalToCache > 0) {
      statusText = this.skippedCount > 0
        ? `✅ Cache complete! (${this.totalToCache - this.skippedCount}/${this.totalToCache}; ${this.skippedCount} skipped${runwayText})`
        : `✅ Cache complete! (${this.totalToCache} paragraphs${runwayText})`;
      if (window.currentStory) {
        window.currentStory.isCached = true;
        window.currentStory.audioCached = true;
        if (window.userProfile?.library) {
          const ref = window.currentStory.storyKey || window.getStoryStableKey?.(window.currentStory) || window.currentStory.title;
          const entry = window.findLibraryStoryByRef?.(ref);
          if (entry) {
            entry.isCached = true;
            entry.audioCached = true;
          }
        }
        if (typeof window.saveLocalData === 'function') window.saveLocalData();
      }
      if (awayBar) awayBar.classList.remove('caching');
      _releaseCacheWakeLock();
      _clearPersistedCacheJob();
      if (!window.isPlaying) window.stopBgKeepAlive?.();
    } else {
      statusText = `Offline caching is idle.`;
      if (awayBar) awayBar.classList.remove('caching');
      _releaseCacheWakeLock();
      if (!window.isPlaying) window.stopBgKeepAlive?.();
    }
    if (this.textEl) this.textEl.innerText = statusText;
    if (this.pauseBtnEl) {
      this.pauseBtnEl.style.display = this.isActive || this.paused ? 'flex' : 'none';
      this.pauseBtnEl.classList.toggle('is-paused', this.paused);
      this.pauseBtnEl.innerText = this.paused ? 'Resume' : 'Pause';
    }
    if (this.resumeBtnEl) {
      const isIdleButIncomplete = !this.isActive && !this.paused && this.cachedCount > 0 && this.cachedCount < this.totalToCache;
      this.resumeBtnEl.style.display = isIdleButIncomplete ? 'flex' : 'none';
    }

    // ISSUE 12 FIX: Global ETA Calculation decoupled from modal visibility
    let currentStory = "Unknown";
    let storyItemsRemaining = 0;
    if (this.queue.length > 0) {
      currentStory = this.queue[0].storyTitle;
      let i = 0;
      while(i < this.queue.length && this.queue[i].storyTitle === currentStory) i++;
      storyItemsRemaining = i;
    }

    let etaText = 'Calculating ETA...';
    let compactEta = 'ETA: Calc...';

    if (this.itemsSynthesizedThisSession > 0 && this.startTime) {
      const elapsedMs = Date.now() - this.startTime;
      if (elapsedMs < 10000) {
        etaText = 'Calculating ETA... (gathering speed data)';
        compactEta = 'ETA: Calc...';
      } else {
        const msPerItem = elapsedMs / this.itemsSynthesizedThisSession;
        const itemsRemaining = this.totalToCache - this.cachedCount;
        const overallMins = Math.max(1, Math.ceil((itemsRemaining * msPerItem) / 60000));
        const storyMins = Math.max(1, Math.ceil((storyItemsRemaining * msPerItem) / 60000));
        etaText = `<span style="color:var(--text-muted)">Current Story:</span> ~${storyMins}m &nbsp;|&nbsp; <span style="color:var(--text-muted)">Overall:</span> ~${overallMins}m`;
        compactEta = `ETA: ~${overallMins}m`;
      }
    }

    // Apply compact ETA to the minimized reader bar
    if (this.etaEl) {
      if (this.isActive && !this.paused && this.cachedCount < this.totalToCache) {
        this.etaEl.innerText = compactEta;
      } else {
        this.etaEl.innerText = '';
      }
    }

    // Modal Specific Updates
    if (this.cachingModalEl && this.cachingModalEl.style.display === 'flex') {
      if (this.cachingModalFill) this.cachingModalFill.style.width = `${pct}%`;

      if (this.cachingModalStats) {
        if (this.isReverifying) {
          const runwayHint = this.cachedCount > 0
            ? ` · <span style="color:var(--accent-green)">~${runway} audio verified</span>`
            : '';
          this.cachingModalStats.innerHTML = `<strong>${this.cachedCount}/${this.totalToCache}</strong> paragraphs verified (${pct}%)${runwayHint}<br><div style="margin-top:6px;font-size:0.85rem;color:var(--accent-green)">✓ Offline audio intact — quickly verifying storage</div><div style="margin-top:8px;font-size:0.78rem;color:var(--text-muted)">${_narrationRuntimeLabel()}</div>`;
        } else {
          const lastMs = Number(this._lastSynthMs || 0);
          const pace = lastMs > 0 ? `${Math.round(lastMs / 1000)}s last paragraph · ` : '';
          const tel = this._lastSynthTelemetry || {};
          const chunkHint = Number(tel.textChunks || 0) > 0
            ? `${tel.textChunks} chunk${tel.textChunks === 1 ? '' : 's'}${tel.punctuationSplitCount ? ` · ${tel.punctuationSplitCount} punct splits` : ''}${tel.realTimeFactor != null ? ` · RTF ${tel.realTimeFactor}` : ''}${Number(tel.frameBudgetStops || 0) > 0 ? ` · ${tel.frameBudgetStops} budget stop${tel.frameBudgetStops === 1 ? '' : 's'}` : ''} · `
            : '';
          const runwayHint = this.cachedCount > 0
            ? ` · <span style="color:var(--accent-green)">~${runway} audio ready</span>`
            : '';
          this.cachingModalStats.innerHTML = `<strong>${this.cachedCount}/${this.totalToCache}</strong> paragraphs (${pct}%)${runwayHint}${this._liveRenderHint()}<br><div style="margin-top:6px;font-size:0.85rem">${pace}${chunkHint}${etaText}</div><div style="margin-top:8px;font-size:0.78rem;color:var(--text-muted)">${_narrationRuntimeLabel()}</div>`;
        }
      }

      // ISSUE 19 FIX: Away Mode Unique Layout and Layout Overrides
      if (this.queue.length > 0 && this.queue[0]) {
        if (this.isReverifying) {
          if (this.cachingModalText) {
            this.cachingModalText.innerHTML = `<div style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.35); padding:10px; border-radius:8px; margin-bottom:15px; text-align:center;"><strong style="color:var(--accent-green); font-size:1.05rem;">100% Cached Audio Found</strong><br><span style="font-size:0.85rem;color:var(--text-muted)">Verifying previous offline cache for instant playback...</span></div>Verifying: <strong style="color:var(--accent-green)">${_escapeCacheStatus(currentStory)}</strong><br><span style="font-size:0.85rem;color:var(--text-muted)">Ch ${this.queue[0].chapIdx + 1}, Para ${this.queue[0].paraIdx + 1}...</span>`;
          }
        } else if (this.mode === 'Permanent') {
          if (this.cachingModalText) {
            this.cachingModalText.innerHTML = `<div style="background:rgba(255,165,0,0.1); border:1px solid rgba(255,165,0,0.35); padding:10px; border-radius:8px; margin-bottom:15px; text-align:center;"><strong style="color:var(--accent-gold); font-size:1.1rem;">Away Mode is preparing offline audio</strong><br><span style="font-size:0.85rem;color:var(--text-muted)">Hide this panel to keep Pocket Reader working. Pause or stop from Settings when needed.</span></div>Caching: <strong style="color:var(--accent-color)">${_escapeCacheStatus(currentStory)}</strong><br><span style="font-size:0.85rem;color:var(--text-muted)">Ch ${this.queue[0].chapIdx + 1}, Para ${this.queue[0].paraIdx + 1}...</span>`;
          }
        } else {
          if (this.cachingModalText) this.cachingModalText.innerHTML = `Caching: <strong style="color:var(--accent-color)">${_escapeCacheStatus(currentStory)}</strong><br><span style="font-size:0.85rem;color:var(--text-muted)">Ch ${this.queue[0].chapIdx + 1}, Para ${this.queue[0].paraIdx + 1}...</span>`;
        }
      } else if (this.cachedCount >= this.totalToCache && this.totalToCache > 0) {
        if (this.cachingModalText) this.cachingModalText.innerText = this.isReverifying ? `Cache verified! Playback ready.` : `Caching complete!`;
        if (this.cachingModalEl && this.cachingModalEl.style.display !== 'none') {
          setTimeout(() => {
            this.cachingModalEl.classList.remove('active');
            setTimeout(() => this.cachingModalEl.style.display = 'none', 300);
          }, 800);
        }
      }

      // ISSUE 19 FIX: Clean Modal Dismiss States
      const minReady = _minimumPlaybackReadyCount(this.totalToCache);
      const readyCount = this.getReadyCount();
      if (this.cachingModalDismiss) {
        this.cachingModalDismiss.style.display = 'block';
        if (this.mode === 'Permanent') {
          this.cachingModalDismiss.disabled = false;
          this.cachingModalDismiss.style.cursor = 'pointer';
          this.cachingModalDismiss.style.borderColor = 'var(--accent-blue)';
          this.cachingModalDismiss.style.color = 'var(--accent-blue)';
          this.cachingModalDismiss.innerText = 'Hide Cache Panel';
          this.cachingModalDismiss.onclick = window.dismissCachingModal;
        } else {
          if (readyCount >= minReady || this.cachedCount >= this.totalToCache) {
            this.cachingModalDismiss.disabled = false;
            this.cachingModalDismiss.style.cursor = 'pointer';
            this.cachingModalDismiss.style.borderColor = 'var(--accent-green)';
            this.cachingModalDismiss.style.color = 'var(--accent-green)';
            this.cachingModalDismiss.innerText = 'Begin Playback';
            this.cachingModalDismiss.onclick = () => {
              window.dismissCachingModal();
              if (!window.isPlaying && typeof window.togglePlayState === 'function') {
                window.togglePlayState();
              }
            };
          } else if (this.isReverifying) {
            this.cachingModalDismiss.disabled = true;
            this.cachingModalDismiss.style.cursor = 'not-allowed';
            this.cachingModalDismiss.style.borderColor = 'var(--accent-green)';
            this.cachingModalDismiss.style.color = 'var(--accent-green)';
            this.cachingModalDismiss.innerText = `Verifying cached audio (${this.cachedCount}/${this.totalToCache})...`;
            this.cachingModalDismiss.onclick = null;
          } else if (!this.isActive || this.paused) {
            this.cachingModalDismiss.disabled = false;
            this.cachingModalDismiss.style.cursor = 'pointer';
            this.cachingModalDismiss.style.borderColor = 'var(--accent-blue)';
            this.cachingModalDismiss.style.color = 'var(--accent-blue)';
            this.cachingModalDismiss.innerText = `Resume Caching (${readyCount}/${minReady} ready)`;
            this.cachingModalDismiss.onclick = () => {
              if (this.paused) this.resume();
              else this.start(this.mode || 'Normal');
            };
          } else {
            this.cachingModalDismiss.disabled = true;
            this.cachingModalDismiss.style.cursor = 'not-allowed';
            this.cachingModalDismiss.style.borderColor = 'var(--text-muted)';
            this.cachingModalDismiss.style.color = 'var(--text-muted)';
            this.cachingModalDismiss.innerText = `Playback unlocks at ${minReady} paragraphs (${readyCount}/${minReady} ready) - or minimize below to keep caching`;
            this.cachingModalDismiss.onclick = null;
          }
        }
      }
    }
  },

  buildQueue() {
    if (!window.currentStory || !window.currentStory.chapters) return;
    this.queue = [];
    this.totalToCache = 0;
    this.cachedCount = 0;
    this.skippedCount = 0;
    this.sessionStoryRefs = new Set();
    this.isReverifying = !!(window.currentStory?.isCached || window.currentStory?.audioCached);
    const engine = _resolveActiveEngine();
    if (engine !== 'pocket') {
      if (this.containerEl) this.containerEl.style.display = 'none';
      return;
    }
    const defaultVoice = POCKET_DEFAULT_VOICE;
    let voice = document.getElementById('voice-selector')?.value || defaultVoice;
    const cleanVoice = typeof window.canonicalPocketVoice === 'function'
      ? window.canonicalPocketVoice(voice)
      : String(voice || defaultVoice).toLowerCase().trim();
    voice = POCKET_VOICES.includes(cleanVoice) ? cleanVoice : defaultVoice;
    for (let c = 0; c < window.currentStory.chapters.length; c++) {
      const chap = window.currentStory.chapters[c];
      if (!chap.paragraphs) continue;
      for (let p = 0; p < chap.paragraphs.length; p++) {
        const text = chap.paragraphs[p].trim();
        if (text && !this._isMetaParagraph(text, window.currentStory.title, chap.title, window.currentStory.author)) {
          this.queue.push({
            storyTitle: window.currentStory.title,
            storyRef: window.currentStory.storyKey || window.getStoryStableKey?.(window.currentStory) || window.currentStory.title,
            chapIdx: c,
            paraIdx: p,
            text: text,
            engine: engine,
            voice: voice
          });
          this.totalToCache++;
          this.sessionStoryRefs.add(
            window.currentStory.storyKey || window.getStoryStableKey?.(window.currentStory) || window.currentStory.title,
          );
        }
      }
    }
    if (this.containerEl) this.containerEl.style.display = 'flex';
    this.updateUI();
  },

  async start(mode = 'Normal') {
    this.mode = mode;
    this.paused = false;
    this.itemsSynthesizedThisSession = 0;
    this.startTime = Date.now();
    this._thermalHistory = [];
    this._coolingUntil = 0;
    // Prefer fewer, larger synthesis chunks while background-caching.
    window._pocketThroughputCache = true;
    // Retire any worker loops still running from a previous run (e.g. the
    // user switched voice mid-cache) so this run re-queues cleanly instead
    // of no-opping on a stale active flag or leaving zombie loops behind.
    const gen = ++this._generation;
    this.isActive = false;
    this._backendPreparationPromise = null;
    this._backendParallelStarted = false;
    // Load worker settings from user profile (auto‑detected or manual)
    const settings = window.userProfile?.settings || {};
    this.maxWorkers = Number(settings.maxWorkers) || this.DEFAULT_MAX_WORKERS;
    const cap = settings.enableManualWorkers ? this.MANUAL_CAP_WORKERS : this.HARD_CAP_WORKERS;
    if (this.maxWorkers > cap) this.maxWorkers = cap;
    if (this.maxWorkers < 1) this.maxWorkers = 1;

    // Pocket TTS is strictly capped to 1 worker to ensure memory safety and prevent race conditions
    let activeEngine = settings.voiceEngine;
    if (!activeEngine) {
      try {
        const raw = localStorage.getItem('pocketReaderData');
        if (raw) {
          const parsed = JSON.parse(raw);
          activeEngine = parsed?.settings?.voiceEngine;
        }
      } catch (e) {}
    }
    if (activeEngine === 'pocket') {
      this.maxWorkers = 1;
      const earlyModal = document.getElementById('caching-progress-modal');
      if (earlyModal) {
        this.cachingModalEl = earlyModal;
        earlyModal.style.display = 'flex';
        earlyModal.classList.add('active');
      }
      const isCachedStory = !!(window.currentStory?.isCached || window.currentStory?.audioCached);
      const runtime = window._pocketBackendRuntime;
      const backendHint = isCachedStory
        ? '100% Cached Audio Found — verifying offline cache...'
        : (runtime?.selectedBackend === 'webgpu'
          ? 'Checking cached WebGPU narration...'
          : (_isolationReady()
            ? 'Checking cached narration...'
            : 'Preparing narration session...'));
      this._showModalStatus(backendHint);
    }

    this.buildQueue();
    if (this.queue.length === 0) {
      // The early "Preparing narration..." modal is already showing; without
      // this it sat on "0/0" forever when the story text had not loaded yet.
      this._showModalStatus(window.currentStory?.chapters?.length
        ? 'Everything here is already cached.'
        : 'The story text is still loading — try caching again in a moment.');
      if (this.cachingModalDismiss) this.cachingModalDismiss.style.display = 'block';
      window._pocketThroughputCache = false;
      window.trimPocketCacheWorkerPool?.();
      if (!window.isPlaying) window.stopBgKeepAlive?.();
      setTimeout(() => window.dismissCachingModal?.(), 3500);
      return;
    }
    this._prefetchQueueVoices();
    this.isActive = true;
    this.consecutiveErrors = 0;
    this.activeWorkers = 0;
    // Re-query DOM refs because responsive view transitions can replace panels.
    const _freshModal = document.getElementById('caching-progress-modal');
    if (_freshModal) this.cachingModalEl = _freshModal;
    const _freshText = document.getElementById('caching-progress-text');
    if (_freshText) this.cachingModalText = _freshText;
    const _freshFill = document.getElementById('caching-progress-fill');
    if (_freshFill) this.cachingModalFill = _freshFill;
    const _freshStats = document.getElementById('caching-progress-stats');
    if (_freshStats) this.cachingModalStats = _freshStats;
    const _freshDismiss = document.getElementById('caching-progress-dismiss-btn');
    if (_freshDismiss) this.cachingModalDismiss = _freshDismiss;
    if (this.cachingModalEl) {
      this.cachingModalEl.style.display = 'flex';
      this.cachingModalEl.classList.add('active');
    }
    // Away Mode (Permanent) shows only the Minimize button. Other modes show
    // BOTH "Begin Playback" (gated until 30 paragraphs) and a Minimize button,
    // so the user is never locked into this screen while caching runs.
    const _isAway = (mode === 'Permanent');
    const _dismissBtn  = document.getElementById('caching-progress-dismiss-btn');
    const _minimizeBtn = document.getElementById('away-queue-minimize-btn');
    const _awayHint    = document.getElementById('away-queue-hint');
    if (_dismissBtn)  _dismissBtn.style.display  = _isAway ? 'none' : '';
    if (_minimizeBtn) {
      _minimizeBtn.style.display = '';   // available in every mode — escape hatch
      _minimizeBtn.disabled = false;
      _minimizeBtn.innerHTML = _isAway
        ? 'Hide Cache Panel'
        : 'Hide Cache Panel';
    }
    if (_awayHint)    _awayHint.style.display    = _isAway ? 'block' : 'none';
    this.updateUI();
    // Start with one lightweight cache reader. The full model and any parallel
    // worker are initialized only when this reader finds a real cache miss.
    setTimeout(() => this._loop(gen), 0);
  },

  pause() {
    this.paused = true;
    _persistCacheJob(this);
    this.updateUI();
  },

  addToPrecacheQueue(storyRef) {
    if (!window.precacheQueue) window.precacheQueue = [];
    const story = window.findLibraryStoryByRef?.(storyRef);
    if (!story) return;
    const stableRef = story.storyKey || window.getStoryStableKey?.(story) || storyRef;
    if (window.precacheQueue.length >= 5) {
      if (typeof window.triggerVirtue === 'function') {
        window.triggerVirtue('virtue_annoyed_bubble');
        window.virtueSpeak('You can only queue up to 5 stories for Away Mode!', 4000);
      }
      return;
    }
    if (!window.precacheQueue.includes(stableRef)) {
      window.precacheQueue.push(stableRef);
      localStorage.setItem('pocketPrecacheQueue', JSON.stringify(window.precacheQueue));
      if (typeof window.triggerVirtue === 'function') {
        window.triggerVirtue('virtue_holding_bubble_happy_no_paws');
        window.virtueSpeak(`${story.title} is queued. Start Away Mode from the Library button when you are ready.`, 3500);
      }
    }
    const badge = document.getElementById('precache-count');
    if (badge) badge.innerText = `${window.precacheQueue.length} queued`;
    const btn = document.getElementById('start-precache-btn');
    if (btn) {
      btn.classList.toggle('active', window.precacheQueue.length > 0);
    }
  },

  async startPrecacheQueue() {
    // Must run in the initiating tap before the first await. iOS will reject a
    // media play() first attempted after async setup or after the tab hides.
    window.preparePocketMobileMediaSession?.();
    window.startBgKeepAlive?.();
    if (!window.precacheQueue || window.precacheQueue.length === 0) {
      if (!window.isPlaying) window.stopBgKeepAlive?.();
      if (typeof window.virtueSpeak === 'function') window.virtueSpeak('First, open each story menu and choose Queue Away. Then start Away Mode from Library.', 5000);
      return;
    }
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (window.userProfile?.settings?.lowMemoryMode || conn?.saveData) {
      if (typeof window.virtueSpeak === 'function') window.virtueSpeak('Away Mode is disabled in Low Memory Mode or Data Saver.', 5000);
      if (!window.isPlaying) window.stopBgKeepAlive?.();
      return;
    }
    if (this.isActive) {
      if (typeof window.virtueSpeak === 'function') window.virtueSpeak('Away Mode is already running. Stop it first to restart.', 4000);
      return;
    }
    window._pocketThroughputCache = true;
    // Away Mode needs the same isolated multi-thread session as normal caching.
    if (!_isolationReady()) {
      const firstRef = window.precacheQueue[0];
      const firstStory = window.findLibraryStoryByRef?.(firstRef);
      window.currentStory = window.currentStory || firstStory || { title: 'Queued story', storyKey: firstRef };
      if (!window.currentStory.title) window.currentStory.title = firstStory?.title || 'Queued story';
      sessionStorage.setItem(FAST_NARRATION_RESUME_KEY, JSON.stringify({
        title: window.currentStory.title,
        mode: 'Permanent',
        awayQueue: [...window.precacheQueue],
        requestedAt: Date.now(),
      }));
      if (_requestFastNarrationReload('Permanent', 'cache')) return;
    }
    const btn = document.getElementById('start-precache-btn');
    if (btn) {
      btn.innerHTML = 'Preparing Away Mode...';
      btn.disabled = true;
    }
    this.mode = 'Permanent';
    this.paused = false;
    this.itemsSynthesizedThisSession = 0;
    this.startTime = Date.now();
    this._thermalHistory = [];
    this._coolingUntil = 0;
    this.queue = [];
    this.totalToCache = 0;
    this._backendPreparationPromise = null;
    this._backendParallelStarted = false;
    const selectedEngine = document.getElementById('voice-engine-select')?.value || 'pocket';
    if (selectedEngine !== 'pocket') {
      if (btn) {
        btn.innerHTML = `Away Mode &nbsp;<span id="precache-count" class="away-mode-badge">${window.precacheQueue.length} queued</span>`;
        btn.disabled = false;
        btn.classList.toggle('active', window.precacheQueue.length > 0);
      }
      if (!window.isPlaying) window.stopBgKeepAlive?.();
      if (typeof window.virtueSpeak === 'function') window.virtueSpeak('Away Mode caching requires Pocket TTS. Switch to Pocket TTS and try again.', 5000);
      return;
    }
    const defaultVoice = POCKET_DEFAULT_VOICE;
    const selectedVoice = document.getElementById('voice-selector')?.value || defaultVoice;
    const cleanVoice = typeof window.canonicalPocketVoice === 'function'
      ? window.canonicalPocketVoice(selectedVoice)
      : String(selectedVoice || defaultVoice).toLowerCase().trim();
    const voice = POCKET_VOICES.includes(cleanVoice) ? cleanVoice : defaultVoice;
    this.maxWorkers = 1;
    const requestedQueue = [...window.precacheQueue];
    const consumedRefs = new Set();
    this.sessionStoryRefs = new Set();
    for (let i = 0; i < requestedQueue.length; i++) {
      const storyRef = requestedQueue[i];
      if (!window.userProfile || !window.userProfile.library) continue;
      const story = window.findLibraryStoryByRef?.(storyRef);
      if (!story) continue;
      const stableRef = story.storyKey || window.getStoryStableKey?.(story) || storyRef;
      const storyTitle = story.title;
      let chapters = story.chapters;
      if (!chapters && typeof window._loadStoryChapters === 'function') {
        chapters = await window._loadStoryChapters(stableRef, story);
        if (!chapters && stableRef !== storyTitle) {
          chapters = await window._loadStoryChapters(storyTitle, story);
          if (chapters) window._saveStoryChapters?.(stableRef, chapters, story).catch(() => {});
        }
      }
      if (!chapters && typeof window._silentFetchStoryChapters === 'function' && story.url) {
        if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_thinking');
        if (typeof window.showLoadingOverlay === 'function') window.showLoadingOverlay('Downloading...', `Fetching ${storyTitle} for Away Mode`);
        try {
          chapters = await window._silentFetchStoryChapters(story.url);
          if (chapters && typeof window._saveStoryChapters === 'function') {
            await window._saveStoryChapters(stableRef, chapters, story);
          }
        } catch (e) {
          console.error("Silent fetch failed", e);
        }
        if (typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
      }
      if (!chapters) continue;

      const queueStart = this.queue.length;
      for (let c = 0; c < chapters.length; c++) {
        const chap = chapters[c];
        if (!chap.paragraphs) continue;
        for (let p = 0; p < chap.paragraphs.length; p++) {
          const text = chap.paragraphs[p].trim();
          if (text && !this._isMetaParagraph(text, story.title, chap.title, story.author)) {
            this.queue.push({
              storyTitle: story.title,
              storyRef: stableRef,
              chapIdx: c,
              paraIdx: p,
              text: text,
              engine: selectedEngine,
              voice: voice
            });
            this.totalToCache++;
          }
        }
      }
      if (this.queue.length > queueStart) {
        consumedRefs.add(storyRef);
        this.sessionStoryRefs.add(stableRef);
      }
    }
    window.precacheQueue = requestedQueue.filter((ref) => !consumedRefs.has(ref));
    try { localStorage.setItem('pocketPrecacheQueue', JSON.stringify(window.precacheQueue)); } catch (_) {}
    if (btn) {
      btn.innerHTML = `Away Mode &nbsp;<span id="precache-count" class="away-mode-badge">${window.precacheQueue.length} queued</span>`;
      btn.disabled = false;
      btn.classList.toggle('active', window.precacheQueue.length > 0);
    }
    if (this.queue.length === 0) {
      window._pocketThroughputCache = false;
      if (!window.isPlaying) window.stopBgKeepAlive?.();
      if (typeof window.triggerVirtue === 'function') {
        window.triggerVirtue('virtue_thinking');
        window.virtueSpeak('Those stories appear to be empty or already cached.');
      }
      return;
    }
    this._prefetchQueueVoices();
    const gen = ++this._generation;
    this.isActive = true;
    this.mode = 'Permanent';
    this.startTime = Date.now();
    this.consecutiveErrors = 0;
    this.cachedCount = 0;
    this.skippedCount = 0;
    this.activeWorkers = 0;
    const _freshModal = document.getElementById('caching-progress-modal');
    if (_freshModal) this.cachingModalEl = _freshModal;
    if (this.cachingModalEl) {
      this.cachingModalEl.style.display = 'flex';
      this.cachingModalEl.classList.add('active');
    }
    this.updateUI();
    setTimeout(() => this._loop(gen), 0);
  },

  stop() {
    // Invalidate every in-flight loop. A synthesis promise cannot always be
    // cancelled in the browser, but its eventual result must not write audio
    // or increment the counters of a later story/run.
    this._generation++;
    this.isActive = false;
    this.paused = false;
    this.queue = [];
    this.activeWorkers = 0;
    // Retain the session totals and story guard. "Stop caching" must not turn
    // an incomplete 14/20 runway into an accidental playback unlock. A new
    // buildQueue() replaces these values when another story starts caching.
    this._backendPreparationPromise = null;
    this._backendParallelStarted = false;
    window._pocketThroughputCache = false;
    window.trimPocketCacheWorkerPool?.();
    if (!window.isPlaying) window.stopBgKeepAlive?.();
    this.updateUI();
    _releaseCacheWakeLock();
    _clearPersistedCacheJob();
    if (typeof window.triggerVirtue === 'function') {
      window.triggerVirtue('virtue_smile');
      window.virtueSpeak('Caching stopped.', 2500);
    }
  },

  resume() {
    if (!this.paused) return;
    window.preparePocketMobileMediaSession?.();
    window.startBgKeepAlive?.();
    this.paused = false;
    this.updateUI();
    if (!this.isActive) {
      const gen = ++this._generation;
      this.isActive = true;
      for (let i = 0; i < this.maxWorkers; i++) {
        setTimeout(() => this._loop(gen), i * 250);
      }
    }
  },

  async restorePersistedJob() {
    if (this._resumeAttempted || document.visibilityState !== 'visible') return;
    this._resumeAttempted = true;

    let job;
    try { job = JSON.parse(localStorage.getItem(CACHE_JOB_RESUME_KEY) || 'null'); } catch (_) { job = null; }
    if (!job || !job.active || job.paused || !job.storyTitle) return;
    if (Date.now() - Number(job.savedAt || 0) > CACHE_JOB_MAX_AGE_MS) {
      _clearPersistedCacheJob();
      return;
    }
    if (this.isActive || this.paused) return;
    if (!window.userProfile?.library || typeof window.loadStory !== 'function') {
      this._resumeAttempted = false;
      return;
    }

    if (!_autoResumeAllowed()) {
      _clearPersistedCacheJob();
      window.Diagnostics?.log('WARN', 'Cache auto-resume suppressed after repeated interruptions', {
        storyTitle: job.storyTitle,
      });
      window.queueNotice?.({
        id: 'cache-resume-suppressed',
        title: 'Caching stopped',
        message: 'Caching was interrupted repeatedly (this can happen when the device runs low on memory). Start it again from the story menu when ready.',
        tone: 'error',
        duration: 8000,
      });
      return;
    }

    try {
      const jobRefs = Array.isArray(job.storyRefs) && job.storyRefs.length ? job.storyRefs : job.storyTitles;
      if (job.mode === 'Permanent' && Array.isArray(jobRefs)) {
        window.precacheQueue = [...jobRefs];
        await this.startPrecacheQueue();
        return;
      }
      const jobRef = job.storyRef || job.storyTitle;
      const currentRef = window.currentStory?.storyKey || window.getStoryStableKey?.(window.currentStory) || window.currentStory?.title;
      if (currentRef !== jobRef) {
        await window.loadStory(jobRef, { preventNavigate: true });
        window.closeCacheModal?.();
      }
      const loadedRef = window.currentStory?.storyKey || window.getStoryStableKey?.(window.currentStory) || window.currentStory?.title;
      if (loadedRef !== jobRef) return;
      await _awaitMobileNarrationGesture('cache');
      // Must go through the isolation handoff — direct start() is 1-thread slow mode.
      if (typeof window.startCaching === 'function') {
        window.startCaching(job.mode || 'Normal');
      } else {
        await this.start(job.mode || 'Normal');
      }
      window.Diagnostics?.log('INFO', 'Restored interrupted cache job', {
        storyTitle: job.storyTitle,
        mode: job.mode || 'Normal',
        isolated: _isolationReady(),
      });
    } catch (error) {
      console.warn('[PocketTTS] Cache job restoration deferred:', error);
      this._resumeAttempted = false;
    }
  },

  _cacheThrottleDelay() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (window._pocketLiveSynthActive) return 750;
    if (document.hidden || conn?.saveData || window.userProfile?.settings?.lowMemoryMode || (window._isLowBattery && window._isLowBattery())) return 750;
    return window.isPlaying ? 350 : 80;
  },

  // Chrome throttles hidden-page timers: chained setTimeouts clamp to 1s, and
  // after 5 minutes hidden they fire once per MINUTE (intensive throttling;
  // silent caching pages are not exempt — only audible ones are). Chaining the
  // next paragraph through setTimeout added up to 60s of dead time per
  // paragraph whenever the app was backgrounded during a cache job. A
  // MessageChannel hop is never throttled, so hidden sessions continue at full
  // synthesis speed; visible sessions keep the polite delay.
  _scheduleLoop(gen, delay = 0) {
    // Only a HIDDEN page suffers timer throttling. The old condition also took
    // the zero-delay path whenever the window merely lost focus, which silently
    // cancelled every deliberate backoff — most importantly the 1500ms pause
    // after a failed paragraph, turning it into an immediate retry storm on any
    // unfocused-but-visible window.
    if (delay === 0) {
      this._messageChannelHop(gen);
      return;
    }
    if (document.hidden) {
      // Hidden pages clamp chained setTimeout to 1s, and to once per MINUTE
      // after five minutes hidden. Wait out the intended delay on a timer that
      // is allowed to be slow, then resume on an unthrottled MessageChannel hop.
      setTimeout(() => this._messageChannelHop(gen), delay);
      return;
    }
    setTimeout(() => this._loop(gen), delay);
  },

  _messageChannelHop(gen) {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      this._loop(gen);
    };
    channel.port2.postMessage(0);
  },

  // Feed the CPU thermal guard. Only WASM synthesis counts: the WebGPU path
  // has its own sustained-latency watchdog, and mixing the two would corrupt
  // the baseline. Entries reflect pure pipeline speed (rests are excluded), so
  // a rising real-time factor means the SoC itself is slowing down.
  _recordThermalSample(telemetry) {
    if (!telemetry || telemetry.backend === 'webgpu') return;
    if (!Number.isFinite(telemetry.realTimeFactor) || telemetry.realTimeFactor <= 0) return;
    if (!this._thermalHistory) this._thermalHistory = [];
    this._thermalHistory.push({
      realTimeFactor: telemetry.realTimeFactor,
      audioDurationSec: Number(telemetry.audioDurationSec) || 0,
    });
    if (this._thermalHistory.length > POCKET_THERMAL_HISTORY_LIMIT) this._thermalHistory.shift();
  },

  // Resolve every queued paragraph through the same emotion router the cache
  // loop uses, then warm the Cache Storage copies of the distinct voice assets
  // up front. Fire-and-forget: downloads run alongside synthesis instead of
  // serializing into the first paragraph that needs each emotion.
  _prefetchQueueVoices() {
    if (typeof window.prefetchPocketVoiceAssets !== 'function') return;
    if (!this.queue.length || this.queue[0].engine !== 'pocket') return;
    // Constrained devices must never overlap whole-story voice downloads with
    // model startup. They use the bounded current/next path below instead.
    if (window.shouldPocketPrefetchFullStoryVoices?.() !== true) return;
    const routed = new Set();
    for (const task of this.queue) {
      const voiceId = window.resolveVoiceWithSentiment
        ? window.resolveVoiceWithSentiment(task.engine, task.voice, task.text,
            { storyTitle: task.storyTitle, chapIdx: task.chapIdx, paraIdx: task.paraIdx })
        : task.voice;
      if (voiceId) routed.add(voiceId);
    }
    if (!routed.size) return;
    window.prefetchPocketVoiceAssets([...routed]).catch((error) => {
      console.warn('[Cache] Voice prefetch skipped:', error?.message || error);
    });
  },

  async _prefetchNextVoice() {
    if (window.isPocketDeviceMemorySafeMode?.() === false) return;
    if (typeof window.prefetchPocketVoiceAssets !== 'function') return;
    const task = this.queue[0];
    if (!task || task.engine !== 'pocket') return;
    const voiceId = window.resolveVoiceWithSentiment
      ? window.resolveVoiceWithSentiment(task.engine, task.voice, task.text,
          { storyTitle: task.storyTitle, chapIdx: task.chapIdx, paraIdx: task.paraIdx })
      : task.voice;
    if (!voiceId) return;
    try {
      // Await the single download so it cannot overlap the following synthesis.
      await window.prefetchPocketVoiceAssets([voiceId]);
    } catch (error) {
      console.warn('[Cache] Next voice prefetch skipped:', error?.message || error);
    }
  },

  async _ensureCacheBackendReady(gen, voice) {
    if (!this._backendPreparationPromise) {
      this._backendPreparationPromise = (async () => {
        this._showModalStatus('Loading the narration engine for uncached audio...');
        await window.ensurePocketBackendOptimized?.(voice);
        let workers = 1;
        try {
          workers = Math.max(1, Number(await window.preparePocketCacheWorkerPool?.()) || 1);
        } catch (error) {
          console.warn('[Cache] Parallel worker preparation retained one worker:', error?.message || error);
        }
        this.maxWorkers = workers;
        this._showModalStatus(`Caching narration — ${_narrationRuntimeLabel()}`);
        if (workers > 1 && !this._backendParallelStarted && gen === this._generation) {
          this._backendParallelStarted = true;
          for (let i = 1; i < workers; i++) {
            setTimeout(() => this._loop(gen), i * 250);
          }
        }
      })();
    }
    try {
      await this._backendPreparationPromise;
    } catch (error) {
      this._backendPreparationPromise = null;
      throw error;
    }
  },

  async _loop(gen) {
    if (gen !== this._generation) return;   // a newer run has superseded this loop
    if (this.queue.length === 0 && this.activeWorkers > 0 && !this.paused && this.isActive) {
      this.updateUI();
      return;
    }
    if (this.paused || !this.isActive || this.queue.length === 0) {
      this.isActive = false;
      if (!this.paused) {
        window._pocketThroughputCache = false;
        window.trimPocketCacheWorkerPool?.();
      }
      this.updateUI();
      return;
    }
    if (window._pocketLiveSynthActive) {
      setTimeout(() => this._loop(gen), this._cacheThrottleDelay());
      return;
    }
    // Respect max worker limit
    if (this.activeWorkers >= this.maxWorkers) {
      if (this._lastChunkCompletedAt && (Date.now() - this._lastChunkCompletedAt > 60000)) {
        console.warn('[Cache] Active workers stagnated for >60s. Auto-recovering worker pool state.');
        this.activeWorkers = 0;
        this._lastChunkCompletedAt = Date.now();
        if (typeof window._resetPocketEngineForBackend === 'function') {
          try { window._resetPocketEngineForBackend().catch(() => {}); } catch (_) {}
        }
      } else {
        setTimeout(() => this._loop(gen), 200);
        return;
      }
    }
    const task = this.queue.shift();
    this.activeWorkers++;
    try {
      // Resolve the final synthesizable voice asset for this chunk. When
      // expressive narration is enabled, the cache key includes both the
      // detected emotion asset and the prosody settings tag. The position ctx
      // routes through the deterministic chapter emotion plan in audio_core so
      // prefetch order can never change which emotion a paragraph gets.
      const routedVoice = window.resolveVoiceWithSentiment
        ? window.resolveVoiceWithSentiment(task.engine, task.voice, task.text,
            { storyTitle: task.storyTitle, chapIdx: task.chapIdx, paraIdx: task.paraIdx })
        : task.voice;
      // Cache key carries the prosody tag so expressive renders don't collide
      // with plain ones; synthesis itself still uses the untagged routedVoice.
      const cacheVoice = routedVoice + (window._prosodyCacheTag ? window._prosodyCacheTag(task.engine) : '');

      // A paragraph rendered by EITHER mode (throughput cacher or live player)
      // counts as cached — the tags differ but both are valid audio.
      let existingBlob = null;
      const tagVariants = window._prosodyCacheTagVariants
        ? window._prosodyCacheTagVariants(task.engine)
        : [window._prosodyCacheTag ? window._prosodyCacheTag(task.engine) : ''];
      for (const tag of tagVariants) {
        existingBlob = await getAudioChunk(task.storyRef || task.storyTitle, task.chapIdx, task.paraIdx, task.engine, routedVoice + tag, task.text);
        if (existingBlob) break;
      }
      if (gen !== this._generation || !this.isActive) {
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
        return;
      }
      if (existingBlob) {
        this.cachedCount++;
        this.consecutiveErrors = 0;
        this._consecutiveErrorRecoveryAttempted = false;
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
        if (this.queue.length === 0 && this.cachedCount >= this.totalToCache && this.totalToCache > 0) {
          this.isReverifying = false;
          if (window.currentStory) {
            window.currentStory.isCached = true;
            window.currentStory.audioCached = true;
            if (window.userProfile?.library) {
              const ref = window.currentStory.storyKey || window.getStoryStableKey?.(window.currentStory) || window.currentStory.title;
              const entry = window.findLibraryStoryByRef?.(ref);
              if (entry) {
                entry.isCached = true;
                entry.audioCached = true;
              }
            }
            if (typeof window.saveLocalData === 'function') window.saveLocalData();
            if (typeof window.renderLibrary === 'function') window.renderLibrary(true);
            if (typeof window.updateContinueReading === 'function') window.updateContinueReading();
          }
        }
        this.updateUI();
        this._scheduleLoop(gen, 0);
        return;
      }
      this.isReverifying = false;
      await this._ensureCacheBackendReady(gen, routedVoice);
      if (gen !== this._generation || !this.isActive) {
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
        return;
      }
        if (window._pocketLiveSynthActive) {
          this.queue.unshift(task);
          this.activeWorkers = Math.max(0, this.activeWorkers - 1);
          setTimeout(() => this._loop(gen), this._cacheThrottleDelay());
          return;
        }
        if (typeof window.generateChunk !== 'function') {
          console.warn('audio_core.js generator not available yet.');
          this.queue.unshift(task);
          this.paused = true;
          this.updateUI();
          this.activeWorkers = Math.max(0, this.activeWorkers - 1);
          return;
        }
        if (typeof window._neuralState === 'function') {
          const state = window._neuralState();
          // Poll-wait only while visible. Hidden pages throttle this 1s timer
          // to as slow as once per minute, so in the background we fall through
          // to generateChunk, which awaits engine readiness via a promise
          // (promise resolution is never throttled).
          if (state === 'loading' && !document.hidden) {
            this.queue.unshift(task);
            this._showModalStatus('Loading AI engine into memory...');
            setTimeout(() => this._loop(gen), 1000);
            this.activeWorkers = Math.max(0, this.activeWorkers - 1);
            return;
          }
          if (state === 'failed') {
            this.isActive = false;
            this._showModalStatus('AI engine failed to load. Try Device voice instead.');
            if (this.cachingModalDismiss) this.cachingModalDismiss.style.display = 'block';
            if (typeof window.triggerVirtue === 'function') {
              window.triggerVirtue('virtue_annoyed_bubble');
              window.virtueSpeak('The neural engine failed to load. You can switch to Device voice in Settings.', 7000);
            }
            this._maybeAmdHint();
            this.updateUI();
            this.activeWorkers = Math.max(0, this.activeWorkers - 1);
            return;
          }
        }
        let audioBlob = null;
        const synthStartedAt = performance.now();
        this._currentSynthStartedAt = Date.now();
        try {
          audioBlob = await window.generateChunk(task.text, routedVoice);
          if (gen !== this._generation || !this.isActive) {
            this.activeWorkers = Math.max(0, this.activeWorkers - 1);
            return;
          }
          this._currentSynthStartedAt = null;
          this._lastSynthMs = Math.round(performance.now() - synthStartedAt);
          const diag = window._lastPocketSynthTelemetry || null;
          if (diag) {
            this._lastSynthTelemetry = diag;
            this._recordThermalSample(diag);
          }
        } catch (err) {
          this._currentSynthStartedAt = null;
          if (err?.message === 'Pocket backend reset' || err?.message === 'Pocket memory-safe cache session released') {
            // Interrupted by a worker recycle mid-generation — normally just
            // retry. But bound it: if the SAME paragraph keeps getting
            // interrupted (a reset loop, e.g. the periodic recycle repeatedly
            // landing on this one, or a worker that can't stay alive), don't
            // re-queue forever. After a cap, skip it like the quality circuit
            // breaker so caching moves on instead of wedging on one paragraph.
            task.resetRetries = (task.resetRetries || 0) + 1;
            this.activeWorkers = Math.max(0, this.activeWorkers - 1);
            if (task.resetRetries > 6) {
              console.warn(`[BufferManager] Paragraph ${task.chapIdx}:${task.paraIdx} interrupted by worker recycling ${task.resetRetries} times. Skipping to avoid a reset loop.`);
              window.Diagnostics?.log('WARN', 'Skipped paragraph stuck in worker-recycle retry loop', {
                storyTitle: task.storyTitle, chapIdx: task.chapIdx, paraIdx: task.paraIdx, resetRetries: task.resetRetries,
              });
              // Count the skip as processed so the job can still reach 100% /
              // "complete" instead of sitting one short forever per skipped para.
              this.cachedCount++;
              this.skippedCount++;
              this._scheduleLoop(gen, 100);
              return;
            }
            console.log("[BufferManager] Chunk generation interrupted by worker recycling. Retrying paragraph...");
            this.queue.unshift(task);
            this._scheduleLoop(gen, 100);
            return;
          }
          console.error("generateChunk failed:", err);
          this.isActive = false;
          this._showModalStatus('Neural engine failed: ' + err.message);
          if (this.cachingModalDismiss) this.cachingModalDismiss.style.display = 'block';
          this._maybeAmdHint();
          this.updateUI();
          this.activeWorkers = Math.max(0, this.activeWorkers - 1);
          return;
        }
        if (audioBlob) {
          const writeStartedAt = performance.now();
          await saveAudioChunk(task.storyRef || task.storyTitle, task.chapIdx, task.paraIdx, task.engine, cacheVoice, audioBlob, this.mode === 'Permanent', task.text);
          if (gen !== this._generation || !this.isActive) {
            this.activeWorkers = Math.max(0, this.activeWorkers - 1);
            return;
          }
          window.Diagnostics?.log('INFO', 'Pocket background cache write', {
            indexedDbWriteMs: Math.round(performance.now() - writeStartedAt),
            bytes: audioBlob.size,
            storyTitle: task.storyTitle,
            chapIdx: task.chapIdx,
            paraIdx: task.paraIdx,
          });
        } else {
          this.consecutiveErrors++;
          task.failCount = (task.failCount || 0) + 1;
          // generateChunk already made its one lower-temperature quality retry.
          // Re-running the same deterministic paragraph two more times only
          // wastes cache time and produces the same rejected audio.
          const qualityFailure = window._lastPocketQualityFailure;
          if (qualityFailure?.text === task.text && qualityFailure?.voice === routedVoice) {
            task.failCount = 3;
          }

          if (task.failCount >= 3) {
            console.warn(`[BufferManager] Paragraph ${task.chapIdx}:${task.paraIdx} failed 3 times. Circuit breaker skipping paragraph to prevent infinite loop.`);
            window.Diagnostics?.log('WARN', 'Skipped un-synthesizable paragraph during caching', {
              storyTitle: task.storyTitle,
              chapIdx: task.chapIdx,
              paraIdx: task.paraIdx,
              failCount: task.failCount,
            });
            this.consecutiveErrors = 0;
            this.activeWorkers = Math.max(0, this.activeWorkers - 1);
            // Count the skip as processed so a story with a few un-synthesizable
            // paragraphs still reaches "complete" instead of stalling one short
            // per skip (the "stuck at 2098/2106" symptom).
            this.cachedCount++;
            this.skippedCount++;
            this._scheduleLoop(gen, 100);
            return;
          }

          if (this.consecutiveErrors >= 2 && typeof window._resetPocketEngineForBackend === 'function') {
            try { await window._resetPocketEngineForBackend(); } catch (_) {}
          }

          this.queue.unshift(task);
          if (this.consecutiveErrors >= 5) {
            if (!this._consecutiveErrorRecoveryAttempted && typeof window._resetPocketEngineForBackend === 'function') {
              this._consecutiveErrorRecoveryAttempted = true;
              console.warn('[BufferManager] 5 consecutive errors encountered. Attempting full engine reset before pause.');
              try { await window._resetPocketEngineForBackend(); } catch (_) {}
              this.activeWorkers = Math.max(0, this.activeWorkers - 1);
              this._scheduleLoop(gen, 3000);
              return;
            }
            this.isActive = false;
            this._consecutiveErrorRecoveryAttempted = false;
            if (this.cachingModalEl) {
              this.cachingModalEl.style.display = 'flex';
              this.cachingModalEl.classList.add('active');
            }
            this._showModalStatus('Could not synthesize audio. Neural engine unavailable.');
            if (this.cachingModalDismiss) this.cachingModalDismiss.style.display = 'block';
            this._maybeAmdHint();
            this.updateUI();
            this.activeWorkers = Math.max(0, this.activeWorkers - 1);
            return;
          }
          this._scheduleLoop(gen, 1500);
          this.activeWorkers = Math.max(0, this.activeWorkers - 1);
          return;
        }
      this.cachedCount++;
      this.itemsSynthesizedThisSession++;
      this._lastChunkCompletedAt = Date.now();
      this.consecutiveErrors = 0;
      this._consecutiveErrorRecoveryAttempted = false;
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      if (this.queue.length === 0 && this.cachedCount >= this.totalToCache && this.totalToCache > 0) {
        this.isReverifying = false;
        if (window.currentStory) {
          window.currentStory.isCached = true;
          window.currentStory.audioCached = true;
          if (window.userProfile?.library) {
            const ref = window.currentStory.storyKey || window.getStoryStableKey?.(window.currentStory) || window.currentStory.title;
            const entry = window.findLibraryStoryByRef?.(ref);
            if (entry) {
              entry.isCached = true;
              entry.audioCached = true;
            }
          }
          if (typeof window.saveLocalData === 'function') window.saveLocalData();
          if (typeof window.renderLibrary === 'function') window.renderLibrary(true);
          if (typeof window.updateContinueReading === 'function') window.updateContinueReading();
        }
      }
      await this._prefetchNextVoice();
      const thermal = evaluateCpuThermalRest(this._thermalHistory || []);
      if (thermal.rest) {
        // The chip is running hot enough to throttle itself: give it a real
        // rest. Plain setTimeout on purpose — background timer throttling can
        // only stretch the pause, and extra cooling time is harmless.
        this._coolingUntil = Date.now() + thermal.restMs;
        window.Diagnostics?.log('WARN', 'Cache thermal guard resting', {
          restMs: thermal.restMs,
          ratio: Number(thermal.ratio.toFixed(2)),
          baselineRtf: Number(thermal.baselineRtf.toFixed(3)),
          recentRtf: Number(thermal.recentRtf.toFixed(3)),
        });
        this.updateUI();
        setTimeout(() => this._loop(gen), thermal.restMs);
        return;
      }
      this._coolingUntil = 0;
      this.updateUI();
      this._scheduleLoop(gen, this._cacheThrottleDelay());
    } catch (e) {
      console.error('Cache loop error:', e);
      this.consecutiveErrors++;
      if (this.consecutiveErrors >= 3) {
        console.error('Too many background caching errors. Pausing cache.');
        this.queue.unshift(task);
        this.pause();
        if (this.cachingModalEl) {
          this.cachingModalEl.style.display = 'flex';
          this.cachingModalEl.classList.add('active');
        }
        this._showModalStatus('Caching paused - too many errors.');
        if (this.cachingModalDismiss) this.cachingModalDismiss.style.display = 'block';
        if (typeof window.triggerVirtue === 'function') {
          window.triggerVirtue('virtue_annoyed_bubble');
          window.virtueSpeak('I had to pause background caching. The neural engine might be overloaded.', 5000);
        }
        this._maybeAmdHint();
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
        return;
      }
      this.queue.unshift(task);
      setTimeout(() => this._loop(gen), 2000);
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    }
  },

  _showModalStatus(msg) {
    if (this.cachingModalText) this.cachingModalText.innerText = msg;
  },

  // When caching fails while the AMD GPU workaround is enabled, that toggle is
  // by far the most likely culprit (its WebGPU fp32 path is flaky on some
  // setups). Point the user straight at it. No-op when the toggle is off.
  _maybeAmdHint() {
    if (!window.userProfile?.settings?.enableAMDWorkarounds) return false;
    this._showModalStatus('Caching failed - the AMD GPU workaround is the likely cause. Turn it OFF in Settings > Advanced GPU / Worker settings, then load a new story or restart the app.');
    if (typeof window.triggerVirtue === 'function') {
      window.triggerVirtue('virtue_annoyed_bubble');
      if (typeof window.virtueSpeak === 'function')
        window.virtueSpeak('Caching failed with the AMD GPU workaround on. Try turning it off in Settings, then load a new story or restart the app.', 9000);
    }
    return true;
  },

  _isMetaParagraph(text, storyTitle = null, chapterTitle = null, storyAuthor = null) {
    // Delegates to the canonical detector (ui_controller -> window) so the
    // background cache skips exactly the paragraphs playback skips.
    if (typeof window.isMetaParagraph === 'function') {
      return window.isMetaParagraph(text, storyTitle, chapterTitle, storyAuthor);
    }
    return !text || !text.trim();
  }
};

window.BufferManager = BufferManager;
window.startPrecacheQueue = (...args) => BufferManager.startPrecacheQueue(...args);

window.addEventListener('pagehide', () => {
  if (BufferManager.isActive || BufferManager.paused) _persistCacheJob(BufferManager);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && (BufferManager.isActive || BufferManager.paused)) {
    _persistCacheJob(BufferManager);
    return;
  }
  if (document.visibilityState === 'visible') {
    setTimeout(() => BufferManager.restorePersistedJob(), 250);
  }
});

window.addEventListener('pageshow', () => {
  setTimeout(() => BufferManager.restorePersistedJob(), 1500);
});

function isPocketDeviceConstrained() {
  return window.isPocketDeviceConstrained?.() !== false;
}

let _pendingConstrainedCacheMode = null;

// Persist the cache decision on the LIBRARY entry (the object that survives a
// reload through localStorage) as well as the in-memory currentStory. Without
// this the fast-narration reload path returned before the flag was ever saved,
// so the post-reload story load re-ran showCacheDecisionModal and re-prompted.
function _markCacheDecisionMade() {
  const title = window.currentStory?.title;
  if (!title) return;
  const storyRef = window.currentStory?.storyKey || window.getStoryStableKey?.(window.currentStory) || title;
  if (window.currentStory) window.currentStory.cacheDecisionMade = true;
  const library = window.userProfile?.library;
  if (Array.isArray(library)) {
    const entry = window.findLibraryStoryByRef?.(storyRef, library);
    if (entry) entry.cacheDecisionMade = true;
  }
  // Force a synchronous write: a fast-narration reload may fire immediately
  // after this, and the coalesced (microtask) save could otherwise be dropped.
  if (typeof window.saveLocalData === 'function') window.saveLocalData({ immediate: true });
}

// Persist the currently-loaded story's chapters to IndexedDB so a fast-narration
// isolation reload can restore them instantly on resume. Without this, the
// post-reload resume (_resumeFastNarrationCache -> loadStory) finds the library
// entry but no cached chapters and falls through to a full network re-fetch of
// the story; if that re-fetch is slow or fails, the user is dumped on Home with
// no caching started (the reported "modal pops up, reloads to homescreen, does
// nothing" on the first cache attempt). Persisting here makes resume a local,
// instant, offline-safe restore.
async function _persistCurrentStoryChapters() {
  const story = window.currentStory;
  if (!story || !Array.isArray(story.chapters) || story.chapters.length === 0) return false;
  if (typeof window._saveStoryChapters !== 'function') return false;
  const ref = story.storyKey || window.getStoryStableKey?.(story) || story.title;
  try {
    await window._saveStoryChapters(ref, story.chapters, story);
    return true;
  } catch (e) {
    console.warn('[PocketTTS] Could not persist chapters before fast-narration reload:', e);
    return false;
  }
}

async function _continueCaching(mode) {
  // Record (and persist) the decision BEFORE any reload so it is never lost.
  _markCacheDecisionMade();
  // Persist chapters BEFORE the isolation reload so resume restores from cache
  // instead of re-fetching over the network (see _persistCurrentStoryChapters).
  const chaptersPersisted = await _persistCurrentStoryChapters();
  const loadRef = window.currentStory?.url || window.currentStory?.sourceUrl;
  if ((chaptersPersisted || _isLoadableHandoffRef(loadRef))
      && _requestFastNarrationReload(mode, 'cache')) {
    if (typeof window.closeCacheModal === 'function') window.closeCacheModal();
    return;
  }
  if (typeof window.closeCacheModal === 'function') window.closeCacheModal();
  BufferManager.start(mode);
  if (typeof window.triggerVirtue === 'function') {
    window.triggerVirtue('virtue_explaining');
    window.virtueSpeak(`Caching started in ${mode} mode. I'll prepare the audio in the background!`, 5000);
  }
}

async function _ensureCachingStory(storyRef) {
  if (!storyRef) return true;
  const requested = window.findLibraryStoryByRef?.(storyRef);
  if (!requested) return false;
  const requestedRef = requested.storyKey || window.getStoryStableKey?.(requested) || requested.title;
  const currentRef = window.currentStory?.storyKey
    || window.getStoryStableKey?.(window.currentStory)
    || window.currentStory?.title;
  if (currentRef !== requestedRef || !Array.isArray(window.currentStory?.chapters)) {
    if (typeof window.loadStory !== 'function') return false;
    window._pocketSuppressCacheDecision = true;
    try {
      await window.loadStory(requestedRef, { preventNavigate: true });
    } finally {
      window._pocketSuppressCacheDecision = false;
    }
  }
  const loadedRef = window.currentStory?.storyKey
    || window.getStoryStableKey?.(window.currentStory)
    || window.currentStory?.title;
  return loadedRef === requestedRef && Array.isArray(window.currentStory?.chapters);
}

function _showConstrainedCacheNotice(mode) {
  _pendingConstrainedCacheMode = mode || 'Normal';
  if (typeof window.showFeatureDialog !== 'function') {
    writePocketExpressiveChoice(localStorage, 'disabled');
    window.setPocketExpressiveProsodyChoice?.(false);
    _continueCaching(_pendingConstrainedCacheMode);
    _pendingConstrainedCacheMode = null;
    return;
  }
  window.showFeatureDialog('Safer narration for this device', `
    <div class="info-callout"><p><strong>Expressive narration was disabled by default to prevent iOS and low-memory browser crashes while caching.</strong></p></div>
    <p>Pocket Reader detected a constrained memory/data mode or could not positively confirm more than 4 GB of device memory. Safe mode loads voices only as they are needed and never prefetches every emotion for the full story.</p>
    <p>You can still enable expressive narration. On this device it will keep the same lazy current/next voice loading to avoid the startup memory spike.</p>`,
  '<button class="pr-btn-primary" onclick="window.chooseConstrainedCaching(false)">Continue safely</button><button class="pr-btn-sub" onclick="window.chooseConstrainedCaching(true)">Enable expressive anyway</button>');
}

window.chooseConstrainedCaching = function chooseConstrainedCaching(enableExpressive) {
  window.preparePocketMobileMediaSession?.();
  window.startBgKeepAlive?.();
  const mode = _pendingConstrainedCacheMode || 'Normal';
  const choice = enableExpressive ? 'enabled' : 'disabled';
  writePocketExpressiveChoice(localStorage, choice);
  window.setPocketExpressiveProsodyChoice?.(enableExpressive === true);
  window.closeFeatureDialog?.();
  _pendingConstrainedCacheMode = null;
  _continueCaching(mode);
};

window.startCaching = async function(mode, storyRef = null) {
  // Preserve the user activation before story lookup, capability refresh, or an
  // isolation handoff introduces an await boundary.
  window.preparePocketMobileMediaSession?.();
  window.startBgKeepAlive?.();
  if (!await _ensureCachingStory(storyRef)) {
    if (!window.isPlaying) window.stopBgKeepAlive?.();
    window.virtueSpeak?.('That story could not be opened for offline caching.', 5000);
    return;
  }
  if (_resolveActiveEngine() === 'pocket') {
    try { await window.refreshPocketDeviceCapability?.(); } catch (_) {}
    if (isPocketDeviceConstrained() && !window.getPocketExpressiveProsodyChoice?.()) {
      if (!window.isPlaying) window.stopBgKeepAlive?.();
      if (typeof window.closeCacheModal === 'function') window.closeCacheModal();
      _showConstrainedCacheNotice(mode);
      return;
    }
  }
  _continueCaching(mode);
};

setTimeout(() => { _resumeFastNarrationCache().catch((error) => console.error('[PocketTTS] Could not resume fast narration:', error)); }, 0);

window._toggleCachePause = function() {
  if (BufferManager.isActive) {
    BufferManager.pause();
  } else if (BufferManager.paused) {
    BufferManager.resume();
  }
};

window._stopCaching = function() {
  BufferManager.stop();
  if (typeof window.dismissCachingModal === 'function') window.dismissCachingModal();
};

window.showCacheDecisionModal = function() {
  if (!window.currentStory) return;
  if (window._pocketSuppressCacheDecision) return;
  
  const engine = _resolveActiveEngine();
  if (engine === 'pocket') {
    window.startCaching('Normal');
  }
};

window._resumeCaching = function() {
  if (BufferManager.cachedCount < BufferManager.totalToCache) {
    BufferManager.start(BufferManager.mode || 'Normal');
  }
};

window.renderAwayModeUI = function() {
  const queueList = document.getElementById('away-queue-list');
  const quickAddList = document.getElementById('away-quick-add-list');
  if (!queueList || !quickAddList) return;

  const library = window.userProfile?.library || [];
  const queue = window.precacheQueue || [];

  // Update Stats
  const queuedCount = BufferManager.queue ? BufferManager.queue.length : 0;
  const cachedCount = BufferManager.cachedCount || 0;
  const isActive = BufferManager.isActive && BufferManager.mode === 'Permanent';
  const isPaused = BufferManager.paused && BufferManager.mode === 'Permanent';
  const statusText = isActive ? "Running" : (isPaused ? "Paused" : "Idle");
  
  const statusEl = document.getElementById('away-status-text');
  if (statusEl) {
    statusEl.innerText = statusText;
    statusEl.style.color = isActive ? 'var(--accent-green)' : (isPaused ? 'var(--accent-yellow)' : 'var(--text-muted)');
  }
  
  const depthEl = document.getElementById('away-queue-depth');
  if (depthEl) depthEl.innerText = `${queuedCount} paragraphs`;
  
  const cachedEl = document.getElementById('away-session-cached');
  if (cachedEl) cachedEl.innerText = `${cachedCount} paragraphs`;
  
  let etaStr = "N/A";
  if (isActive && BufferManager.startTime && cachedCount > 0 && queuedCount > 0) {
    const elapsed = Date.now() - BufferManager.startTime;
    const msPerItem = elapsed / cachedCount;
    const remainingMs = msPerItem * queuedCount;
    const remainingMin = Math.ceil(remainingMs / 60000);
    etaStr = `~${remainingMin} min`;
  }
  const etaEl = document.getElementById('away-eta');
  if (etaEl) etaEl.innerText = etaStr;

  const workersSelect = document.getElementById('away-workers-select');
  if (workersSelect) {
    workersSelect.value = BufferManager.maxWorkers || 1;
  }

  const startBtn = document.getElementById('away-start-btn');
  const stopBtn = document.getElementById('away-stop-btn');
  if (startBtn) startBtn.disabled = (isActive || isPaused || queue.length === 0);
  if (stopBtn) stopBtn.disabled = (!isActive && !isPaused);

  // Render Queue list
  if (queue.length === 0) {
    queueList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.9rem;">No stories in caching queue. Add some from the list below.</div>`;
  } else {
    queueList.innerHTML = queue.map((ref, idx) => {
      const story = window.findLibraryStoryByRef?.(ref);
      const title = _escapeCacheStatus(story ? story.title : ref);
      return `<div style="display:flex; justify-content:space-between; align-items:center; background:var(--panel-bg); padding:8px 12px; border-radius:4px; border:1px solid var(--border-color);">
        <span style="font-size:0.9rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:70%;" title="${title}">${title}</span>
        <button class="pr-btn-outline" style="padding:4px 8px; font-size:0.8rem; margin:0;" onclick="window.removeStoryFromAwayQueue('${_encodeForInlineHandler(ref)}')">Remove</button>
      </div>`;
    }).join('');
  }

  // Render Quick Add list
  const notInQueue = library.filter(s => {
    const ref = s.storyKey || window.getStoryStableKey?.(s) || s.title;
    return !queue.includes(ref);
  });

  if (library.length === 0) {
    // An empty library and a fully-queued library are different situations, and
    // the old copy claimed the second while showing the first. On a cold start
    // this view can render before the profile and curated list have hydrated,
    // so a reader saw "All library stories are in the queue" above an empty
    // shelf. renderLibrary() re-runs this once the library lands.
    quickAddList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.9rem;">Your library is still loading. Stories will appear here once it does.</div>`;
  } else if (notInQueue.length === 0) {
    quickAddList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.9rem;">All library stories are in the queue.</div>`;
  } else {
    quickAddList.innerHTML = notInQueue.map(s => {
      const ref = s.storyKey || window.getStoryStableKey?.(s) || s.title;
      const title = _escapeCacheStatus(s.title);
      return `<div style="display:flex; justify-content:space-between; align-items:center; background:var(--panel-bg); padding:8px 12px; border-radius:4px; border:1px solid var(--border-color);">
        <span style="font-size:0.9rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:70%;" title="${title}">${title}</span>
        <button class="pr-btn-primary" style="padding:4px 8px; font-size:0.8rem; margin:0;" onclick="window.addStoryToAwayQueue('${_encodeForInlineHandler(ref)}')">Add</button>
      </div>`;
    }).join('');
  }
};

window.startAwayModeFromSubpage = function() {
  if (window.BufferManager) {
    window.BufferManager.startPrecacheQueue();
  }
};

window.stopAwayModeFromSubpage = function() {
  if (window.BufferManager) {
    window.BufferManager.stop();
  }
  if (typeof window.renderAwayModeUI === 'function') window.renderAwayModeUI();
};

window.saveAwayWorkersSetting = function(val) {
  const num = parseInt(val, 10);
  if (!isNaN(num) && num >= 1 && num <= 4) {
    if (window.BufferManager) {
      window.BufferManager.maxWorkers = num;
    }
    if (window.userProfile && window.userProfile.settings) {
      window.userProfile.settings.enableManualWorkers = true;
      window.userProfile.settings.maxWorkers = num;
      if (typeof window.saveLocalData === 'function') window.saveLocalData();
    }
    if (typeof window.renderAwayModeUI === 'function') window.renderAwayModeUI();
  }
};

window.addStoryToAwayQueue = function(refEncoded) {
  const ref = decodeURIComponent(refEncoded);
  if (window.BufferManager) {
    window.BufferManager.addToPrecacheQueue(ref);
  }
  if (typeof window.renderAwayModeUI === 'function') window.renderAwayModeUI();
};

window.removeStoryFromAwayQueue = function(refEncoded) {
  const ref = decodeURIComponent(refEncoded);
  if (!Array.isArray(window.precacheQueue)) window.precacheQueue = [];
  window.precacheQueue = window.precacheQueue.filter(item => item !== ref);
  localStorage.setItem('pocketPrecacheQueue', JSON.stringify(window.precacheQueue));
  const badge = document.getElementById('precache-count');
  if (badge) badge.innerText = `${window.precacheQueue.length} queued`;
  const btn = document.getElementById('start-precache-btn');
  if (btn) {
    btn.classList.toggle('active', window.precacheQueue.length > 0);
  }
  if (typeof window.saveLocalData === 'function') window.saveLocalData();
  if (typeof window.renderAwayModeUI === 'function') window.renderAwayModeUI();
};
