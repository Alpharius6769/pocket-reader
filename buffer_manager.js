// buffer_manager.js - Updated with auto worker detection and concurrency control
import { saveAudioChunk, getAudioChunk } from './storage_core.js?v=storage-v6';
import {
  evaluateCpuThermalRest,
  POCKET_THERMAL_HISTORY_LIMIT,
  writePocketExpressiveChoice,
} from './pocket_backend_policy.js?v=backend-v20';

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

function _persistCacheJob(manager) {
  const activeTask = manager.queue?.[0];
  const storyTitle = activeTask?.storyTitle || window.currentStory?.title;
  const storyRef = activeTask?.storyRef || window.currentStory?.storyKey || window.getStoryStableKey?.(window.currentStory) || storyTitle;
  if (!storyTitle) return;
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
    const platform = /iPhone|iPad|iPod/i.test(ua) ? 'ios'
      : (/Android/i.test(ua) ? 'android' : 'other');
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

function _requestFastNarrationReload(mode) {
  if (!_supportsFastNarrationSession() || _isolationReady()) return false;
  // Mobile relies on cross-origin isolation just as much as desktop: multi-thread
  // WASM needs SharedArrayBuffer, and field data shows 4-thread narration is ~5x
  // faster than the single-thread fallback on a Pixel 6 Pro.
  if (!window.currentStory?.title) return false;

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
      mode: mode || 'Normal',
      requestedAt: Date.now(),
    }));
  } else {
    // Keep an existing Away Mode queue payload; only refresh the timestamp/mode.
    try {
      const existing = JSON.parse(sessionStorage.getItem(FAST_NARRATION_RESUME_KEY) || 'null') || {};
      existing.mode = mode || existing.mode || 'Normal';
      existing.requestedAt = Date.now();
      if (!existing.title) existing.title = window.currentStory.title;
      sessionStorage.setItem(FAST_NARRATION_RESUME_KEY, JSON.stringify(existing));
    } catch (_) {
      sessionStorage.setItem(FAST_NARRATION_RESUME_KEY, JSON.stringify({
        title: window.currentStory.title,
        mode: mode || 'Normal',
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
  window.showLoadingOverlay?.('Resuming narration', 'Re-opening your story in fast multi-threaded mode…');

  const startedAt = Date.now();
  while (Date.now() - startedAt < 60000) {
    const storyReady = window.userProfile?.library?.some((story) => story.title === resume.title);
    if (storyReady && typeof window.loadStory === 'function') {
      // Isolation still missing after first reload — try one hard retry.
      if (!_isolationReady() && sessionStorage.getItem(FAST_NARRATION_RETRY_KEY) !== '1') {
        window.currentStory = window.currentStory || { title: resume.title };
        if (!window.currentStory.title) window.currentStory.title = resume.title;
        if (_requestFastNarrationReload(resume.mode || 'Normal')) return;
      }
      sessionStorage.removeItem(FAST_NARRATION_RESUME_KEY);
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
        await window.loadStory(resume.title, { preventNavigate: isPermanent });
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
        && window.currentStory.title === resume.title
        && Array.isArray(window.currentStory.chapters)
        && window.currentStory.chapters.length > 0;
      if (storyLoaded) {
        if (resume.mode === 'Permanent' && Array.isArray(window.precacheQueue) && window.precacheQueue.length) {
          await BufferManager.startPrecacheQueue();
        } else {
          BufferManager.start(resume.mode || 'Normal');
        }
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  window.hideLoadingOverlay?.();
  sessionStorage.removeItem(FAST_NARRATION_RESUME_KEY);
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
  mode: 'Normal',
  queue: [],
  totalToCache: 0,
  cachedCount: 0,
  consecutiveErrors: 0,
  containerEl: null,
  fillEl: null,
  textEl: null,
  etaEl: null,
  pauseBtnEl: null,
  settingsPanelEl: null,
  // Concurrency control
  activeWorkers: 0,
  maxWorkers: DEFAULT_MAX_WORKERS,
  DEFAULT_MAX_WORKERS: DEFAULT_MAX_WORKERS,
  HARD_CAP_WORKERS: HARD_CAP_WORKERS,    // auto-detect ceiling (50% cores, max 4)
  MANUAL_CAP_WORKERS: MANUAL_CAP_WORKERS,  // ceiling when the user manually overrides (75% cores, max 8)
  _generation: 0,         // bumped on each (re)start so stale worker loops retire themselves
  _resumeAttempted: false,

  initUI() {
    this.containerEl = document.getElementById('reader-buffer-container');
    this.fillEl = document.getElementById('reader-buffer-fill');
    this.textEl = document.getElementById('reader-buffer-text');
    this.etaEl = document.getElementById('reader-buffer-eta');
    this.pauseBtnEl = document.getElementById('cache-pause-btn');
    this.resumeBtnEl = document.getElementById('cache-resume-btn');
    this.settingsPanelEl = document.getElementById('bg-cache-panel');
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
    if (typeof window.refreshBgCachePanel === 'function') window.refreshBgCachePanel();
    if (typeof window.renderAwayModeUI === 'function') window.renderAwayModeUI();
    if (typeof window.updatePlayButtons === 'function') window.updatePlayButtons();
    // Away Mode playback guard lives in audio_core.js togglePlayState() directly

    const pct = this.totalToCache > 0 ? Math.floor((this.cachedCount / this.totalToCache) * 100) : 0;
    if (this.fillEl) this.fillEl.style.width = `${pct}%`;
    window.updateReaderDrawerStatus?.(this);

    // ── Away Mode bar status ─────────────────────────────────────────
    const awayBar = document.getElementById('away-mode-bar');
    let statusText;
    if (this.isActive && !this.paused) {
      statusText = `Caching: ${pct}% (${this.cachedCount}/${this.totalToCache} paragraphs)`;
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
      _persistCacheJob(this);
    } else if (this.paused) {
      statusText = `Paused - ${pct}% cached`;
      if (awayBar) awayBar.classList.remove('caching');
      _releaseCacheWakeLock();
    } else if (this.cachedCount >= this.totalToCache && this.totalToCache > 0) {
      statusText = `✅ Cache complete! (${this.totalToCache} paragraphs)`;
      if (awayBar) awayBar.classList.remove('caching');
      _releaseCacheWakeLock();
      _clearPersistedCacheJob();
    } else {
      statusText = `Offline caching is idle.`;
      if (awayBar) awayBar.classList.remove('caching');
      _releaseCacheWakeLock();
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
        const lastMs = Number(this._lastSynthMs || 0);
        const pace = lastMs > 0 ? `${Math.round(lastMs / 1000)}s last paragraph · ` : '';
        const tel = this._lastSynthTelemetry || {};
        const chunkHint = Number(tel.textChunks || 0) > 0
          ? `${tel.textChunks} chunk${tel.textChunks === 1 ? '' : 's'}${tel.punctuationSplitCount ? ` · ${tel.punctuationSplitCount} punct splits` : ''}${tel.realTimeFactor != null ? ` · RTF ${tel.realTimeFactor}` : ''}${Number(tel.frameBudgetStops || 0) > 0 ? ` · ${tel.frameBudgetStops} budget stop${tel.frameBudgetStops === 1 ? '' : 's'}` : ''} · `
          : '';
        this.cachingModalStats.innerHTML = `<strong>${this.cachedCount}/${this.totalToCache}</strong> paragraphs (${pct}%)${this._liveRenderHint()}<br><div style="margin-top:6px;font-size:0.85rem">${pace}${chunkHint}${etaText}</div><div style="margin-top:8px;font-size:0.78rem;color:var(--text-muted)">${_narrationRuntimeLabel()}</div>`;
      }

      // ISSUE 19 FIX: Away Mode Unique Layout and Layout Overrides
      if (this.queue.length > 0 && this.queue[0]) {
        if (this.mode === 'Permanent') {
          if (this.cachingModalText) {
            this.cachingModalText.innerHTML = `<div style="background:rgba(255,165,0,0.1); border:1px solid rgba(255,165,0,0.35); padding:10px; border-radius:8px; margin-bottom:15px; text-align:center;"><strong style="color:var(--accent-gold); font-size:1.1rem;">Away Mode is preparing offline audio</strong><br><span style="font-size:0.85rem;color:var(--text-muted)">Hide this panel to keep Pocket Reader working. Pause or stop from Settings when needed.</span></div>Caching: <strong style="color:var(--accent-color)">${_escapeCacheStatus(currentStory)}</strong><br><span style="font-size:0.85rem;color:var(--text-muted)">Ch ${this.queue[0].chapIdx + 1}, Para ${this.queue[0].paraIdx + 1}...</span>`;
          }
        } else {
          if (this.cachingModalText) this.cachingModalText.innerHTML = `Caching: <strong style="color:var(--accent-color)">${_escapeCacheStatus(currentStory)}</strong><br><span style="font-size:0.85rem;color:var(--text-muted)">Ch ${this.queue[0].chapIdx + 1}, Para ${this.queue[0].paraIdx + 1}...</span>`;
        }
      } else if (this.cachedCount >= this.totalToCache && this.totalToCache > 0) {
        if (this.cachingModalText) this.cachingModalText.innerText = `Caching complete!`;
        if (this.cachingModalEl && this.cachingModalEl.style.display !== 'none') {
          setTimeout(() => {
            this.cachingModalEl.classList.remove('active');
            setTimeout(() => this.cachingModalEl.style.display = 'none', 300);
          }, 800);
        }
      }

      // ISSUE 19 FIX: Clean Modal Dismiss States
      const minReady = Math.min(30, this.totalToCache);
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
          if (this.cachedCount >= minReady || this.cachedCount >= this.totalToCache || !this.isActive) {
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
          } else {
            this.cachingModalDismiss.disabled = true;
            this.cachingModalDismiss.style.cursor = 'not-allowed';
            this.cachingModalDismiss.style.borderColor = 'var(--text-muted)';
            this.cachingModalDismiss.style.color = 'var(--text-muted)';
            this.cachingModalDismiss.innerText = `Playback unlocks at ${minReady} paragraphs (${this.cachedCount}/${minReady}) - or minimize below to keep caching`;
            this.cachingModalDismiss.onclick = null;
          }
        }
      }
    }
    if (this.settingsPanelEl) {
      this.settingsPanelEl.innerHTML = `<div style="margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;margin-bottom:5px;font-size:0.85rem;">
                    <span>Progress</span><span>${pct}%</span>
                </div>
                <div style="height:6px;background:var(--app-bg);border-radius:3px;overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:var(--accent-green);transition:width 0.3s;"></div>
                </div>
            </div>
            <p style="font-size:0.8rem;color:var(--text-muted);margin:0;">
                Items:${this.cachedCount}/${this.totalToCache}<br>
                Status:${this.paused ? 'Paused' : (this.isActive ? 'Active' : 'Idle')}<br>
                Mode:${this.mode}Cache
            </p>`;
    }
  },

  buildQueue() {
    if (!window.currentStory || !window.currentStory.chapters) return;
    this.queue = [];
    this.totalToCache = 0;
    this.cachedCount = 0;
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
        if (text && !this._isMetaParagraph(text, window.currentStory.title, chap.title)) {
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
      const selectedVoice = document.getElementById('voice-selector')?.value || POCKET_DEFAULT_VOICE;
      const earlyModal = document.getElementById('caching-progress-modal');
      if (earlyModal) {
        this.cachingModalEl = earlyModal;
        earlyModal.style.display = 'flex';
        earlyModal.classList.add('active');
      }
      const runtime = window._pocketBackendRuntime;
      const backendHint = runtime?.selectedBackend === 'webgpu'
        ? 'Loading WebGPU FP16 narration...'
        : (_isolationReady()
          ? 'Preparing threaded WASM narration...'
          : 'Preparing narration (unlocking multi-thread mode)...');
      this._showModalStatus(backendHint);
      try {
        await window.ensurePocketBackendOptimized?.(selectedVoice);
        const after = window._pocketBackendRuntime;
        if (after?.selectedBackend === 'webgpu') {
          this._showModalStatus(after.calibration?.optimistic
            ? 'Starting WebGPU FP16 caching...'
            : 'WebGPU narration ready...');
        } else {
          this._showModalStatus(`Starting caching — ${_narrationRuntimeLabel()}`);
        }
      } catch (error) {
        console.warn('[Cache] Backend optimization retained WASM:', error?.message || error);
        this._showModalStatus(`Starting caching — ${_narrationRuntimeLabel()}`);
      }
      try {
        this.maxWorkers = Math.max(1, Number(await window.preparePocketCacheWorkerPool?.()) || 1);
      } catch (error) {
        this.maxWorkers = 1;
        console.warn('[Cache] Parallel worker preparation retained one worker:', error?.message || error);
      }
    }

    this.buildQueue();
    if (this.queue.length === 0) {
      // The early "Preparing narration..." modal is already showing; without
      // this it sat on "0/0" forever when the story text had not loaded yet.
      this._showModalStatus(window.currentStory?.chapters?.length
        ? 'Everything here is already cached.'
        : 'The story text is still loading — try caching again in a moment.');
      if (this.cachingModalDismiss) this.cachingModalDismiss.style.display = 'block';
      setTimeout(() => window.dismissCachingModal?.(), 3500);
      return;
    }
    this._prefetchQueueVoices();
    this.isActive = true;
    this.consecutiveErrors = 0;
    this.activeWorkers = 0;
    // Re-query DOM refs — Anvil may have re-rendered the page since initUI ran
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
    for (let i = 0; i < this.maxWorkers; i++) {
      setTimeout(() => this._loop(gen), i * 250);
    }
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
    if (!window.precacheQueue || window.precacheQueue.length === 0) {
      if (typeof window.virtueSpeak === 'function') window.virtueSpeak('First, open each story menu and choose Queue Away. Then start Away Mode from Library.', 5000);
      return;
    }
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (window.userProfile?.settings?.lowMemoryMode || conn?.saveData) {
      if (typeof window.virtueSpeak === 'function') window.virtueSpeak('Away Mode is disabled in Low Memory Mode or Data Saver.', 5000);
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
      if (_requestFastNarrationReload('Permanent')) return;
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
    const selectedEngine = document.getElementById('voice-engine-select')?.value || 'pocket';
    if (selectedEngine !== 'pocket') {
      if (btn) {
        btn.innerHTML = 'Away Mode &nbsp;<span id="precache-count" class="away-mode-badge">0 queued</span>';
        btn.disabled = false;
        btn.classList.toggle('active', window.precacheQueue.length > 0);
      }
      if (typeof window.virtueSpeak === 'function') window.virtueSpeak('Away Mode caching requires Pocket TTS. Switch to Pocket TTS and try again.', 5000);
      return;
    }
    const defaultVoice = POCKET_DEFAULT_VOICE;
    const selectedVoice = document.getElementById('voice-selector')?.value || defaultVoice;
    const cleanVoice = typeof window.canonicalPocketVoice === 'function'
      ? window.canonicalPocketVoice(selectedVoice)
      : String(selectedVoice || defaultVoice).toLowerCase().trim();
    const voice = POCKET_VOICES.includes(cleanVoice) ? cleanVoice : defaultVoice;
    try {
      await window.ensurePocketBackendOptimized?.(voice);
    } catch (error) {
      console.warn('[Away Mode] Backend optimization retained WASM:', error?.message || error);
    }
    try {
      this.maxWorkers = Math.max(1, Number(await window.preparePocketCacheWorkerPool?.()) || 1);
    } catch (error) {
      this.maxWorkers = 1;
      console.warn('[Away Mode] Parallel worker preparation retained one worker:', error?.message || error);
    }
    for (let i = 0; i < window.precacheQueue.length; i++) {
      const storyRef = window.precacheQueue[i];
      if (!window.userProfile || !window.userProfile.library) continue;
      const story = window.findLibraryStoryByRef?.(storyRef);
      if (!story) continue;
      const stableRef = story.storyKey || window.getStoryStableKey?.(story) || storyRef;
      const storyTitle = story.title;
      let chapters = story.chapters;
      if (!chapters && typeof window._loadStoryChapters === 'function') {
        chapters = await window._loadStoryChapters(stableRef);
        if (!chapters && stableRef !== storyTitle) {
          chapters = await window._loadStoryChapters(storyTitle);
          if (chapters) window._saveStoryChapters?.(stableRef, chapters).catch(() => {});
        }
      }
      if (!chapters && typeof window._silentFetchStoryChapters === 'function' && story.url) {
        if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_thinking');
        if (typeof window.showLoadingOverlay === 'function') window.showLoadingOverlay('Downloading...', `Fetching ${storyTitle} for Away Mode`);
        try {
          chapters = await window._silentFetchStoryChapters(story.url);
          if (chapters && typeof window._saveStoryChapters === 'function') {
            await window._saveStoryChapters(stableRef, chapters);
          }
        } catch (e) {
          console.error("Silent fetch failed", e);
        }
        if (typeof window.hideLoadingOverlay === 'function') window.hideLoadingOverlay();
      }
      if (!chapters) continue;

      for (let c = 0; c < chapters.length; c++) {
        const chap = chapters[c];
        if (!chap.paragraphs) continue;
        for (let p = 0; p < chap.paragraphs.length; p++) {
          const text = chap.paragraphs[p].trim();
          if (text && !this._isMetaParagraph(text, story.title, chap.title)) {
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
    }
    window.precacheQueue = [];
    if (btn) {
      btn.innerHTML = 'Away Mode &nbsp;<span id="precache-count" class="away-mode-badge">0 queued</span>';
      btn.disabled = false;
      btn.classList.remove('active');
    }
    if (typeof window.refreshBgCachePanel === 'function') window.refreshBgCachePanel();
    if (this.queue.length === 0) {
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
    this.activeWorkers = 0;
    const _freshModal = document.getElementById('caching-progress-modal');
    if (_freshModal) this.cachingModalEl = _freshModal;
    if (this.cachingModalEl) {
      this.cachingModalEl.style.display = 'flex';
      this.cachingModalEl.classList.add('active');
    }
    this.updateUI();
    for (let i = 0; i < this.maxWorkers; i++) {
      setTimeout(() => this._loop(gen), i * 250);
    }
  },

  stop() {
    this.isActive = false;
    this.paused = false;
    this.queue = [];
    this.totalToCache = 0;
    this.cachedCount = 0;
    window._pocketThroughputCache = false;
    window.trimPocketCacheWorkerPool?.();
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
        await window.loadStory(jobRef, { preventNavigate: job.mode === 'Permanent' });
        window.closeCacheModal?.();
      }
      const loadedRef = window.currentStory?.storyKey || window.getStoryStableKey?.(window.currentStory) || window.currentStory?.title;
      if (loadedRef !== jobRef) return;
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
    if (document.hidden) {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => this._loop(gen);
      channel.port2.postMessage(0);
      return;
    }
    setTimeout(() => this._loop(gen), delay);
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
        existingBlob = await getAudioChunk(task.storyRef || task.storyTitle, task.chapIdx, task.paraIdx, task.engine, routedVoice + tag);
        if (existingBlob) break;
      }
      if (!existingBlob) {
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
          this._currentSynthStartedAt = null;
          this._lastSynthMs = Math.round(performance.now() - synthStartedAt);
          const diag = window._lastPocketSynthTelemetry || null;
          if (diag) {
            this._lastSynthTelemetry = diag;
            this._recordThermalSample(diag);
          }
        } catch (err) {
          this._currentSynthStartedAt = null;
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
          await saveAudioChunk(task.storyRef || task.storyTitle, task.chapIdx, task.paraIdx, task.engine, cacheVoice, audioBlob, this.mode === 'Permanent');
          window.Diagnostics?.log('INFO', 'Pocket background cache write', {
            indexedDbWriteMs: Math.round(performance.now() - writeStartedAt),
            bytes: audioBlob.size,
            storyTitle: task.storyTitle,
            chapIdx: task.chapIdx,
            paraIdx: task.paraIdx,
          });
        } else {
          this.consecutiveErrors++;
          this.queue.unshift(task);
          if (this.consecutiveErrors >= 5) {
            this.isActive = false;
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
          setTimeout(() => this._loop(gen), 1500);
          this.activeWorkers = Math.max(0, this.activeWorkers - 1);
          return;
        }
      }
      this.cachedCount++;
      this.itemsSynthesizedThisSession++;
      this._lastChunkCompletedAt = Date.now();
      this.consecutiveErrors = 0;
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
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

  _isMetaParagraph(text, storyTitle = null, chapterTitle = null) {
    // Delegates to the canonical detector (ui_controller -> window) so the
    // background cache skips exactly the paragraphs playback skips.
    if (typeof window.isMetaParagraph === 'function') {
      return window.isMetaParagraph(text, storyTitle, chapterTitle);
    }
    return !text || !text.trim();
  }
};

window.BufferManager = BufferManager;

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
  if (!story || !Array.isArray(story.chapters) || story.chapters.length === 0) return;
  if (typeof window._saveStoryChapters !== 'function') return;
  const ref = story.storyKey || window.getStoryStableKey?.(story) || story.title;
  try {
    await window._saveStoryChapters(ref, story.chapters);
  } catch (e) {
    console.warn('[PocketTTS] Could not persist chapters before fast-narration reload:', e);
  }
}

async function _continueCaching(mode) {
  // Record (and persist) the decision BEFORE any reload so it is never lost.
  _markCacheDecisionMade();
  // Persist chapters BEFORE the isolation reload so resume restores from cache
  // instead of re-fetching over the network (see _persistCurrentStoryChapters).
  await _persistCurrentStoryChapters();
  if (_requestFastNarrationReload(mode)) {
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
  const mode = _pendingConstrainedCacheMode || 'Normal';
  const choice = enableExpressive ? 'enabled' : 'disabled';
  writePocketExpressiveChoice(localStorage, choice);
  window.setPocketExpressiveProsodyChoice?.(enableExpressive === true);
  window.closeFeatureDialog?.();
  _pendingConstrainedCacheMode = null;
  _continueCaching(mode);
};

window.startCaching = async function(mode, storyRef = null) {
  if (!await _ensureCachingStory(storyRef)) {
    window.virtueSpeak?.('That story could not be opened for offline caching.', 5000);
    return;
  }
  if (_resolveActiveEngine() === 'pocket') {
    try { await window.refreshPocketDeviceCapability?.(); } catch (_) {}
    if (isPocketDeviceConstrained() && !window.getPocketExpressiveProsodyChoice?.()) {
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
        <button class="pr-btn-outline" style="padding:4px 8px; font-size:0.8rem; margin:0;" onclick="window.removeStoryFromAwayQueue('${encodeURIComponent(ref)}')">Remove</button>
      </div>`;
    }).join('');
  }

  // Render Quick Add list
  const notInQueue = library.filter(s => {
    const ref = s.storyKey || window.getStoryStableKey?.(s) || s.title;
    return !queue.includes(ref);
  });

  if (notInQueue.length === 0) {
    quickAddList.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.9rem;">All library stories are in the queue.</div>`;
  } else {
    quickAddList.innerHTML = notInQueue.map(s => {
      const ref = s.storyKey || window.getStoryStableKey?.(s) || s.title;
      const title = _escapeCacheStatus(s.title);
      return `<div style="display:flex; justify-content:space-between; align-items:center; background:var(--panel-bg); padding:8px 12px; border-radius:4px; border:1px solid var(--border-color);">
        <span style="font-size:0.9rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:70%;" title="${title}">${title}</span>
        <button class="pr-btn-primary" style="padding:4px 8px; font-size:0.8rem; margin:0;" onclick="window.addStoryToAwayQueue('${encodeURIComponent(ref)}')">Add</button>
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
