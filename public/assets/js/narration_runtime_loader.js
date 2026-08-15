// Loads the two largest narration modules only when a user requests narration
// or caching. This keeps their parsing, initialization, and listeners out of the
// first-use setup path while preserving the existing window API.
let narrationRuntimePromise = null;

export function ensureNarrationRuntime() {
  if (window.__pocketNarrationRuntimeLoaded === true) return Promise.resolve(true);
  if (narrationRuntimePromise) return narrationRuntimePromise;

  window.__pocketNarrationRuntimeLoading = true;
  narrationRuntimePromise = import('./audio_core.js?v=audio-v66')
    .then(() => import('./buffer_manager.js?v=buffer-v51'))
    .then(() => {
      window.__pocketNarrationRuntimeLoaded = true;
      window.__pocketNarrationRuntimeLoading = false;
      return true;
    })
    .catch((error) => {
      narrationRuntimePromise = null;
      window.__pocketNarrationRuntimeLoading = false;
      console.error('Narration runtime failed to load:', error);
      window.showSettingsModal?.(
        'Narration could not start',
        '<p>The narration modules could not be loaded. Check your connection and try again.</p>',
      );
      throw error;
    });
  return narrationRuntimePromise;
}
window.ensureNarrationRuntime = ensureNarrationRuntime;

const POCKET_DEFERRED_SILENCE =
  'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

function preparePocketDeferredMediaGesture() {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
    || (navigator.maxTouchPoints || 0) > 0;
  if (!mobile) return false;

  // Dynamic import resolves after the original click task, which is too late
  // for iOS media authorization. Create and play the eventual narration
  // element now; audio_core adopts this exact element after it loads.
  let audio = window.__pocketMobileMediaElement;
  if (!(audio instanceof HTMLAudioElement)) {
    audio = new Audio();
    audio.preload = 'auto';
    audio.playsInline = true;
    audio.setAttribute?.('playsinline', '');
    audio.setAttribute?.('webkit-playsinline', '');
    window.__pocketMobileMediaElement = audio;
  }
  window.currentAudio = audio;
  if (!audio.src || audio.dataset?.pocketUnlock !== '1') {
    audio.src = POCKET_DEFERRED_SILENCE;
    audio.loop = true;
    audio.volume = 0.001;
    if (audio.dataset) audio.dataset.pocketUnlock = '1';
    audio.play().catch(() => {});
  }
  return true;
}
window.preparePocketMobileMediaSession =
  window.preparePocketMobileMediaSession || preparePocketDeferredMediaGesture;

const MEDIA_GESTURE_ACTIONS = new Set([
  'togglePlayState',
  'startCaching',
  'startPrecacheQueue',
]);

const DEFERRED_NARRATION_ACTIONS = [
  'switchReaderVoiceEngine',
  'startCaching',
  'startPrecacheQueue',
  '_toggleCachePause',
  '_stopCaching',
  'togglePlayState',
  'playCurrentParagraph',
  'pausePlayback',
  'skipParagraph',
  'skipChapter',
  'seekToParagraph',
  'seekToChapter',
  'saveBookmark',
  'applyPlaybackSpeed',
  'onVoiceSelectionChange',
  'preparePocketCacheWorkerPool',
  'rerunPocketBackendOptimization',
  'applyPocketBackendPreference',
  'clearPocketGpuAssets',
];

DEFERRED_NARRATION_ACTIONS.forEach((name) => {
  const deferredAction = (...args) => {
    if (MEDIA_GESTURE_ACTIONS.has(name)) preparePocketDeferredMediaGesture();
    return ensureNarrationRuntime().then(() => {
      const implementation = window[name];
      if (typeof implementation !== 'function' || implementation === deferredAction) {
        throw new Error(`Narration action ${name} did not initialize.`);
      }
      return implementation(...args);
    });
  };
  if (typeof window[name] !== 'function') window[name] = deferredAction;
});

// After a fast-narration isolation reload (?tts_fast=1), the page lands on Home
// with a pending resume record in sessionStorage. buffer_manager.js owns the
// auto-resume (_resumeFastNarrationCache, which runs at its module-load and
// re-opens the story + restarts caching) — but it is now lazy-loaded, so
// without this it would never run until the user manually triggered narration
// again, stranding them on Home. When a resume is actually pending, eagerly
// load the runtime so its module-load resume fires. Idempotent; the narrow
// gate (isolated reload param + a live resume record) keeps ordinary startups
// lazy. Keep the sessionStorage key in sync with FAST_NARRATION_RESUME_KEY in
// buffer_manager.js.
try {
  const _fastNarrationReload = new URLSearchParams(window.location.search).get('tts_fast') === '1';
  const _resumePending = !!sessionStorage.getItem('pr_fast_narration_resume_v1');
  if (_fastNarrationReload && _resumePending) {
    ensureNarrationRuntime().catch(() => {});
  }
} catch (_) { /* URL/sessionStorage unavailable — nothing to resume */ }
