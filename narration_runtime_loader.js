// Loads the two largest narration modules only when a user requests narration
// or caching. This keeps their parsing, initialization, and listeners out of the
// first-use setup path while preserving the existing window API.
let narrationRuntimePromise = null;

export function ensureNarrationRuntime() {
  if (window.__pocketNarrationRuntimeLoaded === true) return Promise.resolve(true);
  if (narrationRuntimePromise) return narrationRuntimePromise;

  window.__pocketNarrationRuntimeLoading = true;
  narrationRuntimePromise = import('./audio_core.js?v=audio-v45')
    .then(() => import('./buffer_manager.js?v=buffer-v38'))
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

// Slider movement only updates a label. Keep that interaction lightweight so
// settings initialization and touch input do not initialize the TTS runtime.
window.onSpeedSliderInput = function onSpeedSliderInput(value) {
  const label = document.getElementById('speed-label');
  if (label) label.innerText = `${Number.parseFloat(value).toFixed(2)}x`;
};

const DEFERRED_NARRATION_ACTIONS = [
  'switchReaderVoiceEngine',
  'startCaching',
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
  'applyPlaybackSpeedSlider',
  'onVoiceSelectionChange',
  'preparePocketCacheWorkerPool',
  'rerunPocketBackendOptimization',
  'applyPocketBackendPreference',
  'clearPocketGpuAssets',
];

DEFERRED_NARRATION_ACTIONS.forEach((name) => {
  const deferredAction = (...args) => ensureNarrationRuntime().then(() => {
    const implementation = window[name];
    if (typeof implementation !== 'function' || implementation === deferredAction) {
      throw new Error(`Narration action ${name} did not initialize.`);
    }
    return implementation(...args);
  });
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
