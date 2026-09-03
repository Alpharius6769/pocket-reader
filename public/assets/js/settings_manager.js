// settings_manager.js — Worker detection, GPU-aware advanced settings, diagnostics
import {
  normalizePronunciationOverrides as normalizeTtsPronunciationOverrides,
} from './tts_pronunciation_core.js?v=pron-v26';
import {
  POCKET_MAX_CACHE_WORKERS,
  readPocketDeviceBackendPreference,
  writePocketDeviceBackendPreference,
  selectNarrationEngine,
  readNarrationEngineOverride,
  writeNarrationEngineOverride,
  KOKORO_VOICES,
  KITTEN_ENGINE,
  NARRATION_ENGINE_TIERS,
  voicesForEngine,
  coerceVoiceForEngine,
} from './pocket_backend_policy.js?v=backend-v48';

export const NARRATION_SERVICE_WORKER_VERSION = '288';

export const SERVICE_WORKER_PATH = 'sw.js';
const NARRATION_SERVICE_WORKER_URL = `${SERVICE_WORKER_PATH}?v=${NARRATION_SERVICE_WORKER_VERSION}`;

function narrationServiceWorkerControlsPage() {
  const scriptUrl = navigator.serviceWorker?.controller?.scriptURL || '';
  try {
    const parsed = new URL(scriptUrl, document.baseURI);
    return parsed.pathname.endsWith('/sw.js')
      && parsed.searchParams.get('v') === NARRATION_SERVICE_WORKER_VERSION;
  } catch (_) {
    return false;
  }
}

function narrationRegistrationIsCurrent(reg) {
  const scriptUrl = reg?.active?.scriptURL || reg?.waiting?.scriptURL || reg?.installing?.scriptURL || '';
  try {
    const parsed = new URL(scriptUrl, document.baseURI);
    return parsed.pathname.endsWith('/sw.js')
      && parsed.searchParams.get('v') === NARRATION_SERVICE_WORKER_VERSION;
  } catch (_) {
    return false;
  }
}

async function ensureNarrationServiceWorkerControl() {
  if (!('serviceWorker' in navigator)) return false;
  if (narrationServiceWorkerControlsPage()) return true;
  setPocketBackendStatus('Updating the narration service worker...', 'progress');
  const swUrl = new URL(NARRATION_SERVICE_WORKER_URL, document.baseURI).href;
  const swFallbackUrl = new URL(SERVICE_WORKER_PATH, document.baseURI).href;
  try {
    await navigator.serviceWorker.register(swUrl);
  } catch (_) {
    await navigator.serviceWorker.register(swFallbackUrl);
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    if (narrationServiceWorkerControlsPage()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

if (!window.userProfile) {
  window.userProfile = { displayName: "Guest Reader", library: [], settings: {}, avatar: null };
}

// ── Constants ────────────────────────────────────────────────────────────────
const HARD_CAP_WORKERS   = window.HARD_CAP_WORKERS;
// The narration pool's real ceiling, not the generic worker cap. The control
// used to advertise 1-MANUAL_CAP (up to 8) against a policy that can only ever
// return 1 or 2, so six of its values were indistinguishable.
const NARRATION_WORKER_CEILING = POCKET_MAX_CACHE_WORKERS;
const DEFAULT_MAX_WORKERS = window.DEFAULT_MAX_WORKERS;

// Safe defaults that are guaranteed stable on any device.
// These are applied automatically when a crash is detected on boot.
const _ADV_SAFE_DEFAULTS = {
  lowMemoryMode:       false,
  enableManualWorkers: false,
  maxWorkers:          null,   // null = auto-detected
};

// Fully CPU-safe defaults applied after repeated crashes (all GPU acceleration off).
const _ADV_FULL_CPU_DEFAULTS = {
  ..._ADV_SAFE_DEFAULTS,
  lowMemoryMode:        true,
};

const _VALID_COMPANIONS = new Set(['virtue', 'none', 'jade']);

function _normalizeCompanionValue(value) {
  const normalized = String(value || 'virtue').toLowerCase().trim();
  return _VALID_COMPANIONS.has(normalized) ? normalized : 'virtue';
}

function _escapeSettingsHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _normalizePronunciationOverrides(input) {
  return normalizeTtsPronunciationOverrides(input);
}

function renderPronunciationOverrides() {
  const settings = window.userProfile?.settings;
  const list = document.getElementById('pronunciation-overrides-list');
  if (!settings || !list) return;
  settings.pronunciationOverrides = _normalizePronunciationOverrides(settings.pronunciationOverrides);
  const rows = settings.pronunciationOverrides;
  if (!rows.length) {
    list.innerHTML = '<p style="margin:0; color:var(--text-muted); font-size:0.8em;">No custom overrides yet.</p>';
    return;
  }
  list.innerHTML = rows.map((entry, index) => {
    const checked = entry.enabled !== false ? 'checked' : '';
    return `
      <div style="display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:8px; align-items:center; border:1px solid var(--border-color); border-radius:6px; padding:6px;">
        <input type="checkbox" ${checked} aria-label="Enable pronunciation override" onchange="togglePronunciationOverride(${index}, this.checked)">
        <span style="min-width:0; overflow-wrap:anywhere;"><b>${_escapeSettingsHtml(entry.term)}</b> = ${_escapeSettingsHtml(entry.soundsLike)}</span>
        <button class="pr-btn-sub" type="button" onclick="removePronunciationOverride(${index})">Remove</button>
      </div>`;
  }).join('');
}
window.renderPronunciationOverrides = renderPronunciationOverrides;

function updatePocketBackendControl() {
  const select = document.getElementById('pocket-backend-select');
  if (!select) return;
  const webgpuOption = [...select.options].find((option) => option.value === 'webgpu');
  if (!webgpuOption) return;
  const runtime = window._pocketBackendRuntime;
  const passed = runtime?.calibration?.selectedBackend === 'webgpu';
  webgpuOption.disabled = !passed;
  webgpuOption.title = passed ? '' : 'Run backend optimization before selecting WebGPU manually.';
}
window.updatePocketBackendControl = updatePocketBackendControl;

function setPocketBackendStatus(message, tone = 'muted') {
  const status = document.getElementById('pocket-backend-status');
  if (!status) return;
  status.textContent = String(message || '');
  status.dataset.tone = tone;
  status.style.color = {
    progress: 'var(--accent-blue)',
    success: 'var(--accent-green)',
    warning: '#c9a75c',
    error: '#ff6b6b',
  }[tone] || 'var(--text-muted)';
}

function describePocketBackendResult(runtime) {
  const selected = runtime?.selectedBackend === 'webgpu' ? 'WebGPU FP16' : 'Threaded WASM';
  const threads = runtime?.selectedBackend === 'wasm' ? Math.max(1, Number(runtime?.threadCount || 1)) : 0;
  const reason = String(runtime?.rejectionReason || runtime?.calibration?.rejectionReason || '').trim();
  if (runtime?.selectedBackend === 'webgpu') {
    const speedup = Number(runtime?.calibration?.speedup);
    return `Optimization complete. ${selected} selected${Number.isFinite(speedup) ? ` (${(speedup * 100).toFixed(1)}% faster)` : ''}.`;
  }
  return `Optimization complete. ${selected} retained (${threads} thread${threads === 1 ? '' : 's'})${reason ? `: ${reason}` : '.'}`;
}

window.runPocketBackendOptimizationFromSettings = async function runPocketBackendOptimizationFromSettings(button) {
  const originalLabel = button?.textContent || 'Re-run backend optimization';
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Checking device...';
  }
  setPocketBackendStatus('Checking WebGPU support and model availability...', 'progress');
  try {
    const url = new URL(window.location.href);
    if (!window.crossOriginIsolated && url.searchParams.get('tts_fast') !== '1' && 'serviceWorker' in navigator) {
      const controlled = await ensureNarrationServiceWorkerControl();
      if (!controlled) throw new Error('The narration service worker did not become ready. Reload the app and try again.');
      sessionStorage.setItem('pr_backend_optimization_resume_v1', String(Date.now()));
      setPocketBackendStatus('Reloading into the isolated narration session. Optimization will resume automatically...', 'progress');
      if (button) button.textContent = 'Preparing narration session...';
      url.searchParams.set('tts_fast', '1');
      window.location.replace(url.href);
      return null;
    }
    const result = await window.rerunPocketBackendOptimization();
    const runtime = window._pocketBackendRuntime || result || {};
    const message = describePocketBackendResult(runtime);
    setPocketBackendStatus(message, runtime.selectedBackend === 'webgpu' ? 'success' : 'warning');
    window.updatePocketBackendControl?.();
    window.refreshPerfPanel?.();
    return runtime;
  } catch (error) {
    const message = `Optimization failed. Threaded WASM remains active: ${error?.message || error}`;
    setPocketBackendStatus(message, 'error');
    window.Diagnostics?.log('ERROR', 'Pocket backend optimization failed', { error: error?.message || String(error) });
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = originalLabel;
    }
  }
};

window.addEventListener('pocket-backend-progress', (event) => {
  const detail = event.detail || {};
  const runProgress = detail.run && detail.total ? ` ${detail.run}/${detail.total}` : '';
  setPocketBackendStatus(detail.text || `Testing ${detail.backend || detail.stage || 'narration backend'}${runProgress}...`, 'progress');
});

async function resumePocketBackendOptimization() {
  const requestedAt = Number(sessionStorage.getItem('pr_backend_optimization_resume_v1') || 0);
  if (!requestedAt) return;
  sessionStorage.removeItem('pr_backend_optimization_resume_v1');
  if (Date.now() - requestedAt > 120000) return;

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    const button = document.getElementById('pocket-backend-optimize-btn');
    if (button && typeof window.rerunPocketBackendOptimization === 'function') {
      window.showView?.('settings-view');
      if (!window.crossOriginIsolated) {
        setPocketBackendStatus('Optimization could not start because the isolated narration session was not established. Threaded WASM remains active.', 'error');
        return;
      }
      await window.runPocketBackendOptimizationFromSettings(button);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  setPocketBackendStatus('Optimization could not start because the narration controls did not finish loading.', 'error');
}
setTimeout(resumePocketBackendOptimization, 0);

window.addPronunciationOverride = function() {
  const settings = window.userProfile?.settings;
  if (!settings) return;
  const termInput = document.getElementById('pronunciation-term-input');
  const soundsInput = document.getElementById('pronunciation-sounds-input');
  const term = String(termInput?.value || '').trim();
  const soundsLike = String(soundsInput?.value || '').trim();
  if (!term || !soundsLike) return;
  const existing = _normalizePronunciationOverrides(settings.pronunciationOverrides)
    .filter((entry) => entry.term.toLowerCase() !== term.toLowerCase());
  existing.push({ term, soundsLike, enabled: true });
  settings.pronunciationOverrides = _normalizePronunciationOverrides(existing);
  window.stampSyncedSetting?.('pronunciationOverrides');
  if (termInput) termInput.value = '';
  if (soundsInput) soundsInput.value = '';
  renderPronunciationOverrides();
  applySettings();
};

window.removePronunciationOverride = function(index) {
  const settings = window.userProfile?.settings;
  if (!settings) return;
  const rows = _normalizePronunciationOverrides(settings.pronunciationOverrides);
  rows.splice(index, 1);
  settings.pronunciationOverrides = rows;
  window.stampSyncedSetting?.('pronunciationOverrides');
  renderPronunciationOverrides();
  applySettings();
};

window.togglePronunciationOverride = function(index, checked) {
  const settings = window.userProfile?.settings;
  if (!settings) return;
  const rows = _normalizePronunciationOverrides(settings.pronunciationOverrides);
  if (rows[index]) rows[index].enabled = !!checked;
  settings.pronunciationOverrides = rows;
  window.stampSyncedSetting?.('pronunciationOverrides');
  renderPronunciationOverrides();
  applySettings();
};

// ── Crash recovery ────────────────────────────────────────────────────────────
// When advanced settings are non-default, we set a "launching" flag before the
// app fully boots.  If the flag is still present on the NEXT startup it means
// the previous session crashed before clearing it → reset to safe defaults.
(function _checkAdvancedCrashRecovery() {
  if (localStorage.getItem('pr_adv_launching') !== 'true') return;

  // Previous launch never cleared the flag → likely crashed.
  localStorage.removeItem('pr_adv_launching');

  const crashCount = parseInt(localStorage.getItem('pr_adv_crash_count') || '0', 10) + 1;
  localStorage.setItem('pr_adv_crash_count', String(crashCount));
  console.warn(`[CrashRecovery] Crash #${crashCount} detected - resetting advanced settings.`);

  // After 2+ consecutive crashes, apply fully CPU-safe defaults to handle hardware GPU crashes.
  const defaults = crashCount >= 2 ? _ADV_FULL_CPU_DEFAULTS : _ADV_SAFE_DEFAULTS;

  try {
    const raw = localStorage.getItem('pocketReaderData');
    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (parseErr) {
      // Corrupted storage would otherwise fall through with no defaults applied,
      // so the app relaunches straight back into the crashing configuration and
      // increments the crash counter forever. Rebuild it with safe defaults.
      console.warn('[CrashRecovery] pocketReaderData is corrupted - rebuilding with safe defaults.', parseErr);
      data = null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) data.settings = {};
    Object.assign(data.settings, defaults);
    localStorage.setItem('pocketReaderData', JSON.stringify(data));
    if (window.userProfile?.settings) Object.assign(window.userProfile.settings, defaults);
  } catch(e) {
    // Even if localStorage is unavailable, still force safe defaults onto the
    // live profile (when it exists) so this session doesn't crash the same way.
    try {
      if (window.userProfile?.settings) Object.assign(window.userProfile.settings, defaults);
    } catch (_) {}
  }

  // Show the crash notice on settings page once it loads
  localStorage.setItem('pr_adv_crash_notice', 'true');
})();

// Call this after advanced settings are confirmed stable (app survived 15 s).
function _clearAdvancedLaunchFlag() {
  localStorage.removeItem('pr_adv_launching');
  localStorage.removeItem('pr_adv_crash_count');
}

// Call this whenever non-default advanced settings are active.
function _setAdvancedLaunchFlag() {
  const s = window.userProfile?.settings || {};
  const nonDefault =
    s.lowMemoryMode ||
    s.enableManualWorkers;

  if (nonDefault) {
    localStorage.setItem('pr_adv_launching', 'true');
    // Auto-clear after 15 s of stable operation
    setTimeout(_clearAdvancedLaunchFlag, 15000);
  } else {
    _clearAdvancedLaunchFlag();
  }
}

// ── Worker count auto-detection ──────────────────────────────────────────────
function detectWorkerCount() {
  const cores = navigator.hardwareConcurrency || 2;
  return Math.max(2, Math.min(HARD_CAP_WORKERS, cores));
}

// Stored voiceEngine is 'pocket' for EVERY neural engine (Kitten, Kokoro, and
// Pocket TTS) and 'webspeech' for the device voice. The dropdown value is a
// different namespace: auto / kitten / kokoro / pocket / webspeech. Treating
// the stored flag as a dropdown value is what made an iPhone 13 on Kitten
// open Settings already sitting on "Pocket TTS", then wrote a Pocket override
// through switchReaderVoiceEngine and left the reader playbar behind.
function _voiceEngineControlValue(settings = window.userProfile?.settings) {
  if (settings?.voiceEngine === 'webspeech') return 'webspeech';
  return readNarrationEngineOverride(localStorage) || 'auto';
}

// ── initSettingsUI — populate all controls from saved settings ───────────────
export function initSettingsUI() {
  if (!window.userProfile || !window.userProfile.settings) return;
  const settings = window.userProfile.settings;
  const el = (id) => document.getElementById(id);


  // Default missing/invalid engines to the neural path. Explicit saved choices,
  // including Web Speech, are still respected here. 'kitten' / 'kokoro' are
  // not stored in this field — they live in the device-local override.
  if (!settings.voiceEngine || !['pocket', 'webspeech'].includes(settings.voiceEngine)) {
    settings.voiceEngine = 'pocket';
    if (typeof window.saveLocalData === 'function') window.saveLocalData();
  }

  // Standard settings
  settings.companion = _normalizeCompanionValue(settings.companion);
  if (el('companion-select'))                               el('companion-select').value = settings.companion;
  _syncEngineSelects(_voiceEngineControlValue(settings));
  try { renderNarrationEngineControls(); } catch (_) {}
  // The engine selects alone are not the whole picture: without this the
  // controls read "Kitten" while the voice picker still lists Pocket voices
  // with a Pocket id selected, which is exactly the cross-engine mismatch the
  // voice contract exists to prevent.
  try { window.syncNarrationControls?.(); } catch (_) {}
  // Backend choice is hardware-specific and must never follow an account to a
  // different phone or computer. Remove the legacy synced field and render the
  // device-local override instead.
  delete settings.pocketBackend;
  if (el('pocket-backend-select')) el('pocket-backend-select').value = readPocketDeviceBackendPreference(localStorage);
  updatePocketBackendControl();
  if (el('haptics-toggle') && settings.haptics !== undefined) el('haptics-toggle').checked = settings.haptics;

  // ── Expressive Narration (Pocket TTS) ──────────────────────────────────────
  if (el('expressive-prosody-toggle')) {
    const expressiveToggle = el('expressive-prosody-toggle');
    expressiveToggle.checked = window.isPocketExpressiveProsodyEnabled?.() ?? (settings.expressiveProsody !== false);
    expressiveToggle.dataset.prInitialized = '1';
    expressiveToggle.dataset.prLast = String(expressiveToggle.checked);
  }
  if (el('voice-emotion-mode-select')) el('voice-emotion-mode-select').value = ['neutral', 'balanced', 'expressive'].includes(settings.voiceEmotionMode) ? settings.voiceEmotionMode : 'balanced';
  // Opt-in: comma/semicolon splitting creates many tiny synthesis chunks and is
  // the dominant cause of slow mobile caching when left on by default.
  if (el('punct-pause-toggle'))        el('punct-pause-toggle').checked        = settings.pausePunctuation === true;
  if (el('pause-tags-toggle'))         el('pause-tags-toggle').checked         = settings.pauseTags !== false; // default on
  if (el('chunk-mode-select'))         el('chunk-mode-select').value           = settings.chunkMode === 'words' ? 'words' : 'sentence';
  if (el('chunk-min-words')) {
    el('chunk-min-words').value = settings.chunkMinWords || 8;
    if (el('chunk-min-label')) el('chunk-min-label').innerText = el('chunk-min-words').value;
  }
  if (el('chunk-max-words')) {
    el('chunk-max-words').value = settings.chunkMaxWords || 40;
    if (el('chunk-max-label')) el('chunk-max-label').innerText = el('chunk-max-words').value;
  }
  if (el('chunk-words-container')) {
    el('chunk-words-container').style.display = (settings.chunkMode === 'words') ? 'block' : 'none';
  }
  settings.pronunciationOverrides = _normalizePronunciationOverrides(settings.pronunciationOverrides);
  renderPronunciationOverrides();

  if (el('low-mem-toggle') && settings.lowMemoryMode !== undefined) {
    el('low-mem-toggle').checked = settings.lowMemoryMode;
    const vc = document.getElementById('virtue-container');
    if (vc) vc.style.display = settings.lowMemoryMode ? 'none' : '';
  }
  if (el('push-updates-toggle') && settings.pushUpdates !== undefined) el('push-updates-toggle').checked = settings.pushUpdates;
  if (el('ui-hints-toggle')) el('ui-hints-toggle').checked = settings.showHints !== undefined ? settings.showHints : true;
  // Always apply theme — default to 'slate' if nothing is saved yet
  const _theme = settings.theme || 'slate';
  if (!settings.theme) settings.theme = _theme;
  if (el('app-theme-select')) el('app-theme-select').value = _theme;
  document.body.classList.remove('theme-light', 'theme-slate', 'theme-high-contrast', 'theme-colorblind');
  document.documentElement.classList.remove('theme-light', 'theme-slate', 'theme-high-contrast', 'theme-colorblind');
  if (_theme !== 'dark') {
    document.body.classList.add(`theme-${_theme}`);
    document.documentElement.classList.add(`theme-${_theme}`);
  }

  // Accessibility settings. Large controls are an opt-in accommodation: their
  // previous touch-device default made compact layouts overflow on phones.
  if (settings.touchTargetSize === undefined) {
    settings.touchTargetSize = false;
    if (typeof window.saveLocalData === 'function') window.saveLocalData();
  }
  if (el('touch-target-size-toggle') && settings.touchTargetSize !== undefined) {
    el('touch-target-size-toggle').checked = !!settings.touchTargetSize;
  }
  if (settings.touchTargetSize) {
    document.body.classList.add('touch-large');
  } else {
    document.body.classList.remove('touch-large');
  }

  if (el('scroll-behavior-select') && settings.scrollBehavior) {
    el('scroll-behavior-select').value = settings.scrollBehavior;
  }

  // Global narration speed. Read on every paragraph by audio_core's
  // getEffectivePlaybackRate(); a story's own narrationPreset.speed still wins.
  if (el('playback-speed-slider')) {
    const rate = Math.min(2, Math.max(0.5, Number(settings.speed) || 1));
    el('playback-speed-slider').value = String(rate);
    window.onNarrationSpeedChange?.(rate, false);
  }

  if (el('app-font-slider') && settings.appFontSize) {
    el('app-font-slider').value = settings.appFontSize;
    if (el('app-font-label')) el('app-font-label').innerText = `${settings.appFontSize}pt`;
    document.documentElement.style.setProperty('--app-font-size', `${settings.appFontSize}pt`);
  }
  if (el('reader-font-slider') && settings.readerFontSize) {
    el('reader-font-slider').value = settings.readerFontSize;
    if (el('reader-font-label')) el('reader-font-label').innerText = `${settings.readerFontSize}pt`;
    document.documentElement.style.setProperty('--reader-font-size', `${settings.readerFontSize}pt`);
  }
  if (el('reading-font-select') && settings.readerFontFamily) {
    el('reading-font-select').value = settings.readerFontFamily;
    document.documentElement.style.setProperty('--reader-font-family', settings.readerFontFamily);
  }

  // ── Worker auto-detection ──────────────────────────────────────────────────
  const cores = navigator.hardwareConcurrency || 2;
  if (!settings.enableManualWorkers) {
    settings.maxWorkers = detectWorkerCount();
  }
  if (window.Diagnostics) {
    window.Diagnostics.log('INFO', 'Worker init', {
      cores,
      maxWorkers: settings.maxWorkers,
      manual: !!settings.enableManualWorkers,
      gpuVendor: window._gpuVendor || 'detecting...',
    });
  }

  // ── Advanced Performance card ──────────────────────────────────────────────
  const isStrongDevice = cores >= 8;

  // Detected info row
  const detectedCoresEl   = el('detected-cores');
  const detectedWorkersEl = el('detected-workers');
  const detectedGpuEl     = el('detected-gpu');
  const detectedSimdEl    = el('detected-simd');
  if (detectedCoresEl)   detectedCoresEl.textContent   = cores;
  if (detectedWorkersEl) detectedWorkersEl.textContent = settings.maxWorkers;
  if (detectedGpuEl)     detectedGpuEl.textContent     = window._gpuVendor || 'detecting...';
  // SIMD: browsers that expose wasm SIMD will have it; no direct JS API, but we note SAB as proxy
  if (detectedSimdEl)    detectedSimdEl.textContent    = (typeof SharedArrayBuffer !== 'undefined') ? 'Supported' : 'Limited';

  // Manual override checkbox
  const manualToggle    = el('manual-workers-toggle');
  const manualContainer = el('manual-workers-container');
  const maxInput        = el('max-workers-input');
  const detailsEl       = el('advanced-worker-details');

  if (manualToggle) {
    manualToggle.checked  = !!settings.enableManualWorkers;
    manualToggle.disabled = !isStrongDevice && !settings.enableManualWorkers;
    manualToggle.title    = (!isStrongDevice && !settings.enableManualWorkers)
      ? 'Manual control is unavailable on devices with fewer than 8 CPU cores.'
      : '';
  }
  if (manualContainer) manualContainer.style.display = settings.enableManualWorkers ? 'block' : 'none';
  if (maxInput) {
    maxInput.max = NARRATION_WORKER_CEILING;
    maxInput.value = Math.min(NARRATION_WORKER_CEILING, Number(settings.maxWorkers) || DEFAULT_MAX_WORKERS);
    const label = document.querySelector('label[for="max-workers-input"]');
    if (label) label.textContent = `Max narration workers (1-${NARRATION_WORKER_CEILING})`;
  }
  if (detailsEl && isStrongDevice) detailsEl.open = true;

  // ── Cache button states ────────────────────────────────────────────────────
  setTimeout(() => {
    caches.keys().then(keys => {
      const hasNeural = keys.some(k => k.includes('pocket') || k.includes('onnx'));
      const neuralBtn = document.querySelector('button[onclick*="clearNeuralEngineCache"]');
      if (neuralBtn) {
        neuralBtn.disabled    = !hasNeural;
        neuralBtn.style.opacity = hasNeural ? '1' : '0.5';
        neuralBtn.innerText   = hasNeural ? 'Clear ONNX Neural Engine (80MB Model)' : 'Neural Engine (Not Cached)';
      }
    });
    try {
      // Use the canonical audio DB via storage_core's initDB so we read the
      // same database name/version that actually stores audio chunks
      // ('PocketReaderDB'), instead of opening an unrelated empty DB.
      (window.initAudioDB ? window.initAudioDB() : Promise.reject()).then((db) => {
        if (!db.objectStoreNames.contains('audio_chunks')) return;
        const tx       = db.transaction('audio_chunks', 'readonly');
        const countReq = tx.objectStore('audio_chunks').count();
        countReq.onsuccess = () => {
          const hasAudio = countReq.result > 0;
          const audioBtn = document.querySelector('button[onclick*="clearAudioCache"]');
          if (audioBtn) {
            audioBtn.disabled     = !hasAudio;
            audioBtn.style.opacity = hasAudio ? '1' : '0.5';
            audioBtn.innerText    = hasAudio ? 'Clear generated audio cache' : 'Generated Audio (Empty)';
          }
        };
      }).catch(() => {});
    } catch(e) {}
  }, 100);

  // Re-populate GPU info once async detection completes (may finish after init)
  if (!window._gpuVendor || window._gpuVendor === 'unknown' || window._gpuVendor === 'detecting...') {
    _collectDeviceProfile().then(p => {
      if (p.gpu && p.gpu !== 'Unknown' && (!window._gpuVendor || window._gpuVendor === 'unknown' || window._gpuVendor === 'detecting...')) {
        window._gpuVendor = p.gpu;
      }
      if (detectedGpuEl && window._gpuVendor) detectedGpuEl.textContent = window._gpuVendor;
      // A call to updateGpuToggles() sat here behind a typeof guard. No such
      // function exists anywhere -- the per-vendor GPU toggles it refreshed were
      // replaced by the backend selection policy, and the call outlived them.
    }).catch(() => {});
  }

  // Crash recovery notice
  if (localStorage.getItem('pr_adv_crash_notice') === 'true') {
    localStorage.removeItem('pr_adv_crash_notice');
    const notice = document.getElementById('adv-crash-notice');
    if (notice) {
      notice.style.display = 'block';
      notice.textContent = 'Advanced settings were automatically reset to safe defaults because the app crashed or failed to start on the previous launch.';
    }
    // Auto-open the advanced section so the user sees it
    const adv = document.getElementById('advanced-settings-section');
    if (adv) adv.setAttribute('open', '');
  }

  // Set launch flag for crash recovery monitoring
  _setAdvancedLaunchFlag();
}
window.initSettingsUI = initSettingsUI;

// ── applySettings — read controls and persist ────────────────────────────────
export function applySettings() {
  if (!window.userProfile) return;
  if (!window.userProfile.settings) window.userProfile.settings = {};
  const settings = window.userProfile.settings;
  const el = (id) => document.getElementById(id);

  try {
    if (el('companion-select')) settings.companion = _normalizeCompanionValue(el('companion-select').value);
    else settings.companion = _normalizeCompanionValue(settings.companion);

    // NOTE: voiceEngine is NOT read from the dropdown here.
    // The dropdown's onchange handler calls switchReaderVoiceEngine() directly,
    // which is the single source of truth for engine changes.
    // Reading the dropdown here caused a startup race condition where the HTML
    // default ('pocket') overwrote the user's saved setting.

    if (el('haptics-toggle'))     settings.haptics       = el('haptics-toggle').checked;
    if (el('low-mem-toggle')) {
      settings.lowMemoryMode = el('low-mem-toggle').checked;
      const vc = document.getElementById('virtue-container');
      if (vc) vc.style.display = settings.lowMemoryMode ? 'none' : '';
      if (window.BufferManager) {
        window.BufferManager.maxWorkers = settings.lowMemoryMode ? 1 : (settings.maxWorkers || 2);
      }
    }
    if (el('push-updates-toggle')) settings.pushUpdates  = el('push-updates-toggle').checked;
    if (el('ui-hints-toggle'))     settings.showHints    = el('ui-hints-toggle').checked;
    if (el('pocket-backend-select')) {
      const previousBackend = readPocketDeviceBackendPreference(localStorage);
      const nextBackend = writePocketDeviceBackendPreference(localStorage, el('pocket-backend-select').value);
      delete settings.pocketBackend;
      if (nextBackend !== previousBackend) {
        window.applyPocketBackendPreference?.().catch((error) => console.warn('Pocket backend reset failed:', error));
      }
    }

    // ── Expressive Narration (Pocket TTS) ──────────────────────────────────
    if (el('expressive-prosody-toggle')) {
      const expressiveToggle = el('expressive-prosody-toggle');
      const enabled = expressiveToggle.checked;
      settings.expressiveProsody = enabled;
      if (expressiveToggle.dataset.prInitialized === '1'
          && expressiveToggle.dataset.prLast !== String(enabled)) {
        window.setPocketExpressiveProsodyChoice?.(enabled);
      }
      expressiveToggle.dataset.prInitialized = '1';
      expressiveToggle.dataset.prLast = String(enabled);
    }
    if (el('voice-emotion-mode-select')) {
      const mode = el('voice-emotion-mode-select').value;
      settings.voiceEmotionMode = ['neutral', 'balanced', 'expressive'].includes(mode) ? mode : 'balanced';
    }
    if (el('punct-pause-toggle'))        settings.pausePunctuation   = el('punct-pause-toggle').checked;
    if (el('pause-tags-toggle'))         settings.pauseTags          = el('pause-tags-toggle').checked;
    if (el('chunk-mode-select'))         settings.chunkMode          = el('chunk-mode-select').value;
    if (el('chunk-min-words')) {
      settings.chunkMinWords = parseInt(el('chunk-min-words').value, 10) || 8;
      if (el('chunk-min-label')) el('chunk-min-label').innerText = settings.chunkMinWords;
    }
    if (el('chunk-max-words')) {
      settings.chunkMaxWords = parseInt(el('chunk-max-words').value, 10) || 40;
      if (el('chunk-max-label')) el('chunk-max-label').innerText = settings.chunkMaxWords;
    }
    // Keep max >= min so the worker never receives an inverted range.
    if (settings.chunkMaxWords && settings.chunkMinWords && settings.chunkMaxWords < settings.chunkMinWords) {
      settings.chunkMaxWords = settings.chunkMinWords;
      if (el('chunk-max-words')) el('chunk-max-words').value = settings.chunkMaxWords;
      if (el('chunk-max-label')) el('chunk-max-label').innerText = settings.chunkMaxWords;
    }
    settings.pronunciationOverrides = _normalizePronunciationOverrides(settings.pronunciationOverrides);
    if (el('app-theme-select')) {
      settings.theme = el('app-theme-select').value;
      document.body.classList.remove('theme-light', 'theme-slate', 'theme-high-contrast', 'theme-colorblind');
      document.documentElement.classList.remove('theme-light', 'theme-slate', 'theme-high-contrast', 'theme-colorblind');
      if (settings.theme !== 'dark') {
        document.body.classList.add(`theme-${settings.theme}`);
        document.documentElement.classList.add(`theme-${settings.theme}`);
      }
    }

    if (el('touch-target-size-toggle')) {
      settings.touchTargetSize = el('touch-target-size-toggle').checked;
      if (settings.touchTargetSize) {
        document.body.classList.add('touch-large');
      } else {
        document.body.classList.remove('touch-large');
      }
    }

    if (el('scroll-behavior-select')) {
      settings.scrollBehavior = el('scroll-behavior-select').value;
    }

    if (el('app-font-slider')) {
      settings.appFontSize = el('app-font-slider').value;
      if (el('app-font-label')) el('app-font-label').innerText = `${settings.appFontSize}pt`;
      document.documentElement.style.setProperty('--app-font-size', `${settings.appFontSize}pt`);
    }
    if (el('reading-font-select')) {
      settings.readerFontFamily = el('reading-font-select').value;
      document.documentElement.style.setProperty('--reader-font-family', settings.readerFontFamily);
    }
    if (el('reader-font-slider')) {
      settings.readerFontSize = el('reader-font-slider').value;
      if (el('reader-font-label')) el('reader-font-label').innerText = `${settings.readerFontSize}pt`;
      document.documentElement.style.setProperty('--reader-font-size', `${settings.readerFontSize}pt`);
    }

    // ── Advanced GPU / Worker settings ─────────────────────────────────────
    const manualToggle = el('manual-workers-toggle');
    const maxInput     = el('max-workers-input');

    if (manualToggle) settings.enableManualWorkers  = manualToggle.checked;

    if (maxInput && settings.enableManualWorkers) {
      let val = parseInt(maxInput.value, 10);
      if (isNaN(val) || val < 1)      val = DEFAULT_MAX_WORKERS;
      if (val > NARRATION_WORKER_CEILING) val = NARRATION_WORKER_CEILING;
      maxInput.value       = val;
      settings.maxWorkers  = val;
    } else if (!settings.enableManualWorkers) {
      settings.maxWorkers = detectWorkerCount();
    }

    // Update detected workers display
    const detectedWorkersEl = el('detected-workers');
    if (detectedWorkersEl) detectedWorkersEl.textContent = settings.maxWorkers;

  } catch (err) {
    console.error("Error applying settings:", err);
  }

  if (typeof window.saveLocalData === 'function') window.saveLocalData();

  if (settings.showHints === false) {
    document.body.classList.add('hide-hints');
  } else {
    document.body.classList.remove('hide-hints');
  }

  // Update crash-guard flag whenever advanced settings change
  _setAdvancedLaunchFlag();

  if (typeof window.triggerVirtue === 'function') {
    window.triggerVirtue('virtue_changed_settings');
  }
}
window.applySettings = applySettings;

// ── Settings-edit timestamp (cloud conflict resolution) ──────────────────────
// Stamp userProfile.settingsUpdatedAt whenever the user actually changes a
// settings control, so cloud merges can keep the most-recently-edited settings
// instead of letting one side blindly win (Issue 9). We listen for real DOM
// change/input events inside the settings surfaces only, so boot-time
// programmatic applySettings()/initSettingsUI() calls never trip it.
function _markSettingsEdited(field = 'settings') {
  if (window.userProfile) window.userProfile.settingsUpdatedAt = Date.now();
  if (typeof window.stampSyncedSetting === 'function') window.stampSyncedSetting(field);
}
window.markSettingsEdited = _markSettingsEdited;
const _SETTING_FIELD_BY_CONTROL = Object.freeze({
  'companion-select': 'companion',
  'voice-engine-select': 'voiceEngine',
  'haptics-toggle': 'haptics',
  'push-updates-toggle': 'pushUpdates',
  'ui-hints-toggle': 'showHints',
  'expressive-prosody-toggle': 'expressiveProsody',
  'voice-emotion-mode-select': 'voiceEmotionMode',
  'punct-pause-toggle': 'pausePunctuation',
  'pause-tags-toggle': 'pauseTags',
  'pronunciation-term-input': 'pronunciationOverrides',
  'pronunciation-sounds-input': 'pronunciationOverrides',
  'chunk-mode-select': 'chunkMode',
  'chunk-min-words': 'chunkMinWords',
  'chunk-max-words': 'chunkMaxWords',
  'app-theme-select': 'theme',
  'app-font-slider': 'appFontSize',
  'reading-font-select': 'readerFontFamily',
  'reader-font-slider': 'readerFontSize',
  'scroll-behavior-select': 'scrollBehavior',
  // These three named elements that do not exist -- touch-target-select,
  // low-memory-toggle and worker-count-slider were renamed in the markup and
  // never here. The lookup falls through to t.name || t.id, so editing them
  // stamped a raw element id as a sync field name. Harmless for the two
  // device-local settings, but touchTargetSize IS synced, so an accessibility
  // change went unstamped and could lose a merge against another device.
  'touch-target-size-toggle': 'touchTargetSize',
  'low-mem-toggle': 'lowMemoryMode',
  'max-workers-input': 'maxWorkers',
  'manual-workers-toggle': 'enableManualWorkers',
  'playback-speed-slider': 'speed',
});
['change', 'input'].forEach((evt) => {
  document.addEventListener(evt, (e) => {
    const t = e.target;
    if (t && typeof t.closest === 'function' &&
        t.closest('#settings-view, #settings-modal-overlay')) {
      _markSettingsEdited(_SETTING_FIELD_BY_CONTROL[t.id] || t.name || t.id || 'settings');
    }
  }, true);
});

// ── onNarrationSpeedChange — the global playback rate ───────────────────────
// settings.speed was stored, defaulted, cloud-synced, merged, and read on every
// paragraph by getEffectivePlaybackRate() -- and no control anywhere could set
// it. audio_core exported an applyPlaybackSpeed() for exactly this job, but it
// had no callers and was itself a deferred narration action, so wiring a slider
// to it would have pulled the whole narration runtime in on a drag.
//
// Lives in the shell instead, like onNarrationEngineSelect: writing a number
// and nudging the element that is already playing needs no engine.
window.onNarrationSpeedChange = function onNarrationSpeedChange(value, commit = true) {
  const requested = Number(value);
  const next = Number.isFinite(requested) ? Math.min(2, Math.max(0.5, requested)) : 1;
  const label = document.getElementById('playback-speed-label');
  if (label) label.textContent = `${next.toFixed(2)}x`;
  if (!commit) return next;

  if (window.userProfile?.settings) window.userProfile.settings.speed = next;
  _markSettingsEdited('speed');
  if (typeof window.saveLocalData === 'function') window.saveLocalData();

  // Apply in place where that is possible. A media element takes a new rate
  // mid-paragraph; a Web Speech utterance bakes its rate in at speak() time, so
  // it picks the change up on the next paragraph instead.
  if (window.currentAudio instanceof HTMLAudioElement) window.currentAudio.playbackRate = next;
  if (typeof window.updateTimeRemaining === 'function') window.updateTimeRemaining();
  return next;
};

// ── onChunkModeChange — reveal word-count sliders only in words mode ─────────
window.onChunkModeChange = function() {
  const sel = document.getElementById('chunk-mode-select');
  const container = document.getElementById('chunk-words-container');
  if (container && sel) container.style.display = (sel.value === 'words') ? 'block' : 'none';
  applySettings();
};

// ── onManualWorkersToggle — called from HTML checkbox onchange ───────────────
window.onManualWorkersToggle = function() {
  const settings      = window.userProfile?.settings;
  if (!settings) return;
  const manualToggle  = document.getElementById('manual-workers-toggle');
  const manualContainer = document.getElementById('manual-workers-container');
  if (!manualToggle) return;
  settings.enableManualWorkers = manualToggle.checked;
  if (manualContainer) manualContainer.style.display = manualToggle.checked ? 'block' : 'none';
  applySettings();
};

// ── resetWorkerSettings — revert to auto-detection ──────────────────────────
window.resetWorkerSettings = function() {
  const settings = window.userProfile?.settings;
  if (!settings) return;
  settings.enableManualWorkers = false;
  settings.maxWorkers          = detectWorkerCount();

  const manualToggle    = document.getElementById('manual-workers-toggle');
  const manualContainer = document.getElementById('manual-workers-container');
  const maxInput        = document.getElementById('max-workers-input');
  const detectedEl      = document.getElementById('detected-workers');
  if (manualToggle)    manualToggle.checked             = false;
  if (manualContainer) manualContainer.style.display    = 'none';
  if (maxInput)        maxInput.value                   = settings.maxWorkers;
  if (detectedEl)      detectedEl.textContent           = settings.maxWorkers;

  if (typeof window.saveLocalData === 'function') window.saveLocalData();
  if (typeof window.virtueSpeak === 'function') {
    window.virtueSpeak(`Worker count reset to ${settings.maxWorkers} (auto-detected).`, 4000);
  }
};

// ── updateDisplayName ────────────────────────────────────────────────────────
export function updateDisplayName(name) {
  const cleanName = name.trim() || "Guest Reader";
  window.userProfile.displayName = cleanName;
  if (typeof window.stampProfileField === 'function') window.stampProfileField('displayName');
  ['user-display-name', 'profile-name', 'settings-display-name'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === 'INPUT') { if (document.activeElement !== el) el.value = cleanName; }
    else el.innerText = cleanName;
  });
  if (typeof window.saveLocalData === 'function') window.saveLocalData();
}
window.updateDisplayName = updateDisplayName;

// ── handleAvatarUpload ───────────────────────────────────────────────────────
export async function handleAvatarUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  try {
    const base64Str = typeof window.prepareAvatarForStorage === 'function'
      ? await window.prepareAvatarForStorage(file)
      : await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error('Could not read avatar image.'));
          reader.readAsDataURL(file);
        });
    window.userProfile.avatar = base64Str;
    ['topbar-avatar-img', 'profile-avatar-img', 'settings-avatar-img'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.src = base64Str;
    });
    if (typeof window.saveLocalData === 'function') {
      const settings = window.userProfile.settings || {};
      window.userProfile.settings = settings;
      window.saveLocalData();
    }
    if (window._cloudPushAllowed && typeof window.pocketCloud?.saveAvatar === 'function') {
      try { await window.pocketCloud.saveAvatar(base64Str); } catch (cloudError) { console.warn('[CloudSync] Avatar upload failed:', cloudError); }
    }
    if (typeof window.triggerVirtue === 'function') {
      window.triggerVirtue('virtue_holding_bubble_happy_no_paws');
      window.virtueSpeak("Looking good! I've updated your profile picture.", 5000);
    }
  } catch (error) {
    console.error('Failed to prepare avatar:', error);
    if (typeof window.showSettingsModal === 'function') {
      window.showSettingsModal('Avatar Error', '<p>The selected image could not be prepared. Try a JPG, PNG, or WebP image.</p>');
    }
  }
}
window.handleAvatarUpload = handleAvatarUpload;

// ── clearNeuralEngineCache ───────────────────────────────────────────────────
export async function clearNeuralEngineCache() {
  if (confirm("This will delete the 80MB Neural Engine from your browser's hidden cache. You will need to redownload it next time you press Play. Continue?")) {
    // Deleting the ONNX CacheStorage entries can take a beat; show working
    // feedback so the button does not feel dead after the user confirms. The
    // overlay self-suppresses for sub-300ms clears, so a fast delete won't flash.
    window.showLoadingOverlay?.('Clearing Neural Engine cache…', 'Removing cached model files');
    try {
      const cacheNames = await caches.keys();
      let deleted = false;
      for (const name of cacheNames) {
        if (name.includes('pocket') || name.includes('onnx')) {
          await caches.delete(name);
          deleted = true;
        }
      }
      window.hideLoadingOverlay?.();
      if (deleted) {
        window.pocketNotify?.('Neural engine cache cleared. Press Play to download a fresh copy.', 6000);
        if (window.Diagnostics) window.Diagnostics.log('INFO', 'User cleared Pocket/ONNX cache.');
      } else {
        window.pocketNotify?.('No neural engine files are cached on this device.', 6000);
      }
    } catch (e) {
      window.hideLoadingOverlay?.();
      console.error("Failed to clear Neural Engine cache:", e);
      window.pocketNotify?.(`The cache could not be cleared: ${e.message}`, 7000);
    }
  }
}
window.clearNeuralEngineCache = clearNeuralEngineCache;

// Give the audio-cache clear working feedback around its async delete for BOTH
// entry points (the Settings button and the reader's storage panel / "delete all
// audio" dialog) — all of which call window.clearAudioCache. We decorate the
// global that storage_core defines (it loads earlier in module order) rather than
// editing storage_core, which would force a version cascade across its importers.
// Interactive calls (skipConfirm falsy) own the confirm here so the overlay
// reveals only AFTER the user commits — never behind the native dialog; the
// overlay self-suppresses for sub-300ms clears. Programmatic calls (skipConfirm
// true) pass straight through unchanged. The flag guards against double-wrapping.
if (typeof window.clearAudioCache === 'function' && !window._clearAudioCacheWrapped) {
  const _rawClearAudioCache = window.clearAudioCache;
  window._clearAudioCacheWrapped = true;
  window.clearAudioCache = async function clearAudioCache(includePermanent = false, skipConfirm = false) {
    if (skipConfirm) return _rawClearAudioCache(includePermanent, true);
    const msg = includePermanent
      ? "This will delete ALL audio caches, including permanently saved stories. Are you sure?"
      : 'This will clear your temporary audio cache to free up space. Permanent caches will be kept. Proceed?';
    if (!confirm(msg)) return;
    window.showLoadingOverlay?.('Clearing audio cache…', 'Freeing up storage');
    try {
      return await _rawClearAudioCache(includePermanent, true);
    } finally {
      window.hideLoadingOverlay?.();
    }
  };
}

// ── resetAllCacheDecisions ───────────────────────────────────────────────────
export function resetAllCacheDecisions() {
  if (!window.userProfile.library) return;
  window.userProfile.library.forEach(story => { delete story.cacheDecisionMade; });
  if (typeof window.saveLocalData === 'function') window.saveLocalData();
  if (typeof window.triggerVirtue === 'function') {
    // See buffer_manager.stop(): virtue_smile is the 3-star rating beat.
    window.triggerVirtue('virtue_explaining');
    window.virtueSpeak("Cache prompts reset. I'll ask you how to handle audio the next time you open a story.", 6000);
  }
}
window.resetAllCacheDecisions = resetAllCacheDecisions;

// ── Sleep timer ──────────────────────────────────────────────────────────────
window._sleepTimerInterval = null;
window._sleepTimerEndTime  = null;

export function applySleepTimer() {
  const el       = document.getElementById('sleep-timer-select');
  const statusEl = document.getElementById('sleep-timer-status');
  if (!el) return;
  const minutes = parseInt(el.value, 10);
  if (window._sleepTimerInterval) { clearInterval(window._sleepTimerInterval); window._sleepTimerInterval = null; }
  if (minutes === 0) {
    if (statusEl) statusEl.innerText = "Timer disabled.";
    window._sleepTimerEndTime = null;
    return;
  }
  if (window.userProfile?.stats) {
    if (typeof window.setDeviceStatFlag === 'function') window.setDeviceStatFlag('firstSleepTimer');
    else window.userProfile.stats.firstSleepTimer = 1;
    if (window.checkForNewAchievements) window.checkForNewAchievements();
  }
  window._sleepTimerEndTime = Date.now() + (minutes * 60 * 1000);
  window._sleepTimerInterval = setInterval(() => {
    const remaining = window._sleepTimerEndTime - Date.now();
    if (remaining <= 0) {
      clearInterval(window._sleepTimerInterval);
      window._sleepTimerInterval = null;
      if (statusEl) statusEl.innerText = "Timer finished.";
      if (el) el.value = "0";
      if (window.isPlaying && typeof window.togglePlayState === 'function') window.togglePlayState();
    } else {
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      if (statusEl) statusEl.innerText = `Pausing in ${m}m ${s}s...`;
    }
  }, 1000);
  if (typeof window.triggerVirtue === 'function') {
    window.triggerVirtue('virtue_explaining');
    window.virtueSpeak(`I'll stop the narration in ${minutes} minutes. Sleep well!`, 5000);
  }
}
window.applySleepTimer = applySleepTimer;

// ── Push notifications ───────────────────────────────────────────────────────
const PUSH_USER_ID_KEY = 'pocketReaderPushUserId';
const PUSH_AUTH_TOKEN_KEY = 'pocketReaderPushAuthToken';
let _volatilePushUserId = '';
let _volatilePushAuthToken = '';

function _storePushAuthToken(token) {
  _volatilePushAuthToken = String(token || '');
  try {
    if (_volatilePushAuthToken) localStorage.setItem(PUSH_AUTH_TOKEN_KEY, _volatilePushAuthToken);
    else localStorage.removeItem(PUSH_AUTH_TOKEN_KEY);
  } catch (_) {}
}

function _getPushAuthToken() {
  try { return localStorage.getItem(PUSH_AUTH_TOKEN_KEY) || _volatilePushAuthToken; }
  catch (_) { return _volatilePushAuthToken; }
}

async function _registerPushSubscription(subscription) {
  const res = await fetch(`${window.HF_API_BASE}/api/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: getPersistentPushUserId(),
      subscription: subscription.toJSON(),
      profile: buildPushProfileSnapshot(),
      auth_token: _getPushAuthToken() || null,
    }),
  });
  if (!res.ok) throw new Error(`Subscribe failed: HTTP ${res.status}`);
  const data = await res.json();
  if (data.auth_token) _storePushAuthToken(data.auth_token);
  // Stash push metadata where the service worker can read it, so a browser-
  // rotated subscription (pushsubscriptionchange) can re-subscribe and
  // re-register with the backend without any page open. Kept out of the
  // versioned app cache (see the SW activate keep-list) and cleared on disable.
  try {
    const meta = {
      user_id: getPersistentPushUserId(),
      auth_token: _getPushAuthToken() || null,
      vapidKey: window.VAPID_PUBLIC_KEY || '',
      apiBase: window.HF_API_BASE || '',
    };
    const metaCache = await caches.open('pr-push-meta');
    await metaCache.put('/pr-push-meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  } catch (_) {}
  return data;
}

function setPushUpdatesEnabled(enabled) {
  if (!window.userProfile) return;
  if (!window.userProfile.settings) window.userProfile.settings = {};
  window.userProfile.settings.pushUpdates = !!enabled;
  const toggle = document.getElementById('push-updates-toggle');
  if (toggle) toggle.checked = !!enabled;
  if (typeof window.saveLocalData === 'function') window.saveLocalData();
}

export function initPushNotifications(checkbox) {
  if (checkbox.checked) {
    if (!confirm("We will ask for your browser's permission to send push notifications. We only send alerts for AO3 stories you explicitly subscribe to. Proceed?")) {
      setPushUpdatesEnabled(false); return;
    }
    if (!('Notification' in window) || !navigator.serviceWorker || !window.PushManager) {
      setPushUpdatesEnabled(false);
      window.pocketNotify?.('This browser cannot deliver push notifications. Installing Pocket Reader to your home screen may enable them.', 7000); return;
    }
    if (window.location.pathname.startsWith('/debug/')) {
      setPushUpdatesEnabled(false);
      // The service worker is not registered under /debug/, and push needs one.
      window.pocketNotify?.('Push needs the service worker, which does not run on debug pages. Open the app at its normal address, then enable this.', 8000);
      return;
    }
    Notification.requestPermission().then(async (permission) => {
      if (permission !== 'granted') { setPushUpdatesEnabled(false); window.pocketNotify?.('Your browser refused notification permission.', 6000); return; }
      let vapidKey = window.VAPID_PUBLIC_KEY || window.VAPID_PUBLIC || '';
      if (!vapidKey && window.HF_API_BASE) {
        try {
          const resp = await fetch(`${window.HF_API_BASE}/api/vapid-public-key`);
          if (resp.ok) { const data = await window._safeParseJson(resp, 'API'); vapidKey = data.public_key; window.VAPID_PUBLIC_KEY = vapidKey; }
        } catch(e) { console.error(e); }
      }
      if (!vapidKey) {
        setPushUpdatesEnabled(false);
        if (typeof window.virtueSpeak === 'function') {
          window.virtueSpeak("Push updates require a VAPID key configured on your backend server.", 5000);
        } else {
          window.pocketNotify?.('Push updates need a VAPID public key on the backend. None is configured.', 7000);
        }
        return;
      }
      let swReg = await navigator.serviceWorker.getRegistration();
      if (!narrationRegistrationIsCurrent(swReg)) {
        const swUrl = new URL(NARRATION_SERVICE_WORKER_URL, document.baseURI).href;
        const swFallbackUrl = new URL(SERVICE_WORKER_PATH, document.baseURI).href;
        try { swReg = await navigator.serviceWorker.register(swUrl); }
        catch(e) { swReg = await navigator.serviceWorker.register(swFallbackUrl); }
      }
      const existing     = await swReg.pushManager.getSubscription();
      const subscription = existing || (await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) }));
      await _registerPushSubscription(subscription);
      setPushUpdatesEnabled(true);
      if (typeof window.triggerVirtue === 'function') {
        window.triggerVirtue('virtue_bubble_wink');
        window.virtueSpeak("I'll always find my way to you. New chapters won't slip past me.", 4000);
      }
    }).catch((err) => { console.error('Push subscription failed:', err); setPushUpdatesEnabled(false); window.pocketNotify?.(`Push notifications could not be enabled: ${err.message}`, 7000); });
  } else {
    setPushUpdatesEnabled(false);
    // Drop the SW push-meta stash so a later rotation does not silently
    // re-subscribe a user who turned notifications off.
    try { caches.delete('pr-push-meta'); } catch (_) {}
    const authToken = _getPushAuthToken();
    if (authToken) {
      fetch(`${window.HF_API_BASE}/api/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: getPersistentPushUserId(), auth_token: authToken }),
      }).then((response) => {
        if (response.ok) _storePushAuthToken('');
      }).catch(e => console.error("Failed to unsubscribe", e));
    }
    if (typeof window.triggerVirtue === 'function') {
      // See buffer_manager.stop(): virtue_smile is the 3-star rating beat.
      window.triggerVirtue('virtue_explaining');
      window.virtueSpeak("Push notifications disabled.", 3000);
    }
  }
}
window.initPushNotifications = initPushNotifications;

function urlBase64ToUint8Array(base64String) {
  const padding  = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64   = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData  = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function getPersistentPushUserId() {
  let id = '';
  try {
    id = localStorage.getItem(PUSH_USER_ID_KEY) || '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      id = _createPushUuid();
      localStorage.setItem(PUSH_USER_ID_KEY, id);
      _storePushAuthToken('');
    }
  } catch(e) {
    if (!_volatilePushUserId) _volatilePushUserId = _createPushUuid();
    id = _volatilePushUserId;
  }
  return id;
}

function _createPushUuid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildPushProfileSnapshot() {
  const library = Array.isArray(window.userProfile?.library) ? window.userProfile.library : [];
  return {
    library: library
      .filter((story) => story?.updateSubscribed && /archiveofourown\.org/i.test(story?.sourceUrl || story?.url || ''))
      .map((story) => ({
        title: story.title || 'your story',
        url: story.sourceUrl || story.url || '',
        storyKey: story.storyKey || '',
        publishedChapters: Number(story.publishedChapters || story.totalChapters) || 0,
        updateSubscribed: true,
      })),
  };
}

export async function syncPushProfileIfEnabled() {
  const settings = window.userProfile?.settings || {};
  if (!settings.pushUpdates || !navigator.serviceWorker || !window.PushManager) return;
  try {
    const swReg = await navigator.serviceWorker.getRegistration();
    const subscription = await swReg?.pushManager?.getSubscription();
    if (!subscription) return;
    await _registerPushSubscription(subscription);
  } catch (e) {
    console.warn('Push profile sync failed:', e);
  }
}
window.syncPushProfileIfEnabled = syncPushProfileIfEnabled;

// ── refreshSiteHealth ────────────────────────────────────────────────────────
let _siteHealthInFlight = null;
let _lastSiteHealthLatencyMs = null;

function _loadSiteHealth() {
  if (_siteHealthInFlight) return _siteHealthInFlight;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  const startedAt = performance.now();
  _siteHealthInFlight = window._rateLimitedFetch('health', () => fetch(
    `${window.HF_API_BASE}/api/health/sites`,
    { method: 'GET', cache: 'no-store', signal: controller.signal },
  ))
    .then((res) => window._safeParseJson(res, 'API'))
    .then((data) => {
      _lastSiteHealthLatencyMs = Math.round(performance.now() - startedAt);
      return data;
    })
    .finally(() => {
      clearTimeout(timeoutId);
      _siteHealthInFlight = null;
    });
  return _siteHealthInFlight;
}

export async function refreshSiteHealth() {
  refreshDeviceProfile();
  const grid = document.getElementById('site-health-grid');
  if (!grid) return;
  grid.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;">Pinging sources...</p>`;
  try {
    const data = await _loadSiteHealth();
    const statusColor = (s) => s === 'ok' ? 'var(--accent-green)' : s === 'login_required' ? '#c9a75c' : '#ff6b6b';
    let html = `<ul style="font-size:0.85rem;padding-left:20px;color:var(--text-main);line-height:1.6;">`;
    (data.sites || []).forEach(site => {
      html += `<li style="color:${statusColor(site.status)};"><b>${_escapeDeviceValue(site.site || 'Unknown')}:</b> ${_escapeDeviceValue(site.status || 'unknown')}${site.note ? ` - ${_escapeDeviceValue(site.note)}` : ''}</li>`;
    });
    if (!(data.sites || []).length) html += `<li style="color:#ff6b6b;"><b>Backend:</b> No site results returned.</li>`;
    html += `</ul>`;
    grid.innerHTML = html;
  } catch(e) {
    grid.innerHTML = `<p style="color:#ff6b6b;font-size:0.85rem;">Failed to fetch health status: ${_escapeDeviceValue(e.message)}</p>`;
  }
}
window.refreshSiteHealth = refreshSiteHealth;

// ── refreshDeviceProfile — also populates GPU vendor from audio_core ─────────
function _escapeDeviceValue(value) {
  return String(value ?? 'Unknown').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function _collectDeviceProfile() {
  const ua = navigator.userAgent;
  const uaData = navigator.userAgentData || null;
  const platform = uaData?.platform || navigator.platform || '';
  const brands = (uaData?.brands || []).map(b => `${b.brand} ${b.version}`).join(', ');
  const os = uaData?.platform
    || (/iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iOS/iPadOS'
        : /Android/i.test(ua + ' ' + platform) ? 'Android'
        : /Windows|Win32|Win64/i.test(ua + ' ' + platform) ? 'Windows'
        : /Mac OS X|MacIntel|macOS/i.test(ua + ' ' + platform) ? 'macOS'
        : /Linux/i.test(ua + ' ' + platform) ? 'Linux' : 'Other');
  let browser = /Firefox/i.test(ua) ? 'Firefox'
    : /SamsungBrowser/i.test(ua) ? 'Samsung Internet'
    : /OPR|Opera/i.test(ua) ? 'Opera'
    : /Edg/i.test(ua) ? 'Edge'
    : /Chrome|Chromium|CriOS/i.test(ua) ? 'Chrome'
    : /Safari/i.test(ua) ? 'Safari' : 'Other';
  if (brands) browser += ` (${brands})`;

  let gpu = window._gpuVendor ? `${window._gpuVendor} (resolved)` : 'Unknown';
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      let info = adapter?.info || {};
      if (adapter?.requestAdapterInfo) {
        try { info = await adapter.requestAdapterInfo(); } catch(e) {}
      }
      const parts = [info.vendor, info.architecture, info.device, info.description].filter(Boolean);
      if (parts.length) gpu = parts.join(' / ');
    } catch(e) {}
  }
  if (gpu === 'Unknown') {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        let renderer = gl.getParameter(gl.RENDERER) || '';
        let vendor = gl.getParameter(gl.VENDOR) || '';
        try {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          if (ext) {
            renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || renderer;
            vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || vendor;
          }
        } catch(e) {}
        gpu = [vendor, renderer].filter(Boolean).join(' / ') || 'WebGL available';
      }
    } catch(e) {}
  }

  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const connection = conn ? [conn.effectiveType, conn.downlink ? `${conn.downlink} Mbps` : '', conn.saveData ? 'Data saver' : ''].filter(Boolean).join(' / ') : 'Unavailable';
  const heap = performance.memory ? `${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB used / ${Math.round(performance.memory.jsHeapSizeLimit / 1048576)} MB limit` : 'Unavailable';
  return {
    os, browser, platform: platform || 'Unavailable',
    cpu: navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} logical cores` : 'Unavailable',
    ram: navigator.deviceMemory ? `${navigator.deviceMemory} GB approximate` : 'Unavailable',
    heap, gpu, webgpu: navigator.gpu ? 'Available' : 'Unavailable',
    sab: typeof SharedArrayBuffer !== 'undefined' ? 'Available' : 'Unavailable',
    isolation: window.crossOriginIsolated ? 'Enabled' : 'Disabled',
    isolationHistory: (() => {
      try {
        const stats = JSON.parse(localStorage.getItem('pr_isolation_stats_v1') || 'null');
        if (!stats) return 'No isolated sessions recorded yet';
        return ['ios', 'android', 'other']
          .filter((key) => stats[key]?.attempts)
          .map((key) => `${key}: ${stats[key].isolated}/${stats[key].attempts} isolated`)
          .join(', ') || 'No isolated sessions recorded yet';
      } catch (_) { return 'Unavailable'; }
    })(),
    screen: `${screen.width}x${screen.height} CSS px, DPR ${window.devicePixelRatio || 1}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    touch: `${navigator.maxTouchPoints || 0} touch points`,
    connection,
    mode: window.matchMedia('(display-mode:standalone)').matches ? 'Standalone PWA' : 'Browser tab',
    workers: `${window.userProfile?.settings?.maxWorkers || detectWorkerCount()} (${window.userProfile?.settings?.enableManualWorkers ? 'manual' : 'auto'})`,
    userAgent: ua,
  };
}
window.collectDeviceProfile = _collectDeviceProfile;

async function _refreshDeviceProfileEnhanced(grid) {
  grid.innerHTML = `<div class="device-profile-loading">Reading browser hardware signals...</div>`;
  const p = await _collectDeviceProfile();
  const rows = [
    ['OS', p.os], ['Browser', p.browser], ['CPU', p.cpu],
    ['GPU', p.gpu], ['WebGPU', p.webgpu],
    ['SharedArrayBuffer', p.sab], ['Cross-origin isolation', p.isolation],
    ['Screen', p.screen], ['Viewport', p.viewport],
    ['Mode', p.mode], ['Workers', p.workers],
    ['Accuracy', 'Browser-reported signals. Thermal telemetry and hardware acceleration are auto-tuned.'],
  ];
  grid.innerHTML = rows.map(([k, v]) => `<span class="device-profile-key">${_escapeDeviceValue(k)}</span><span>${_escapeDeviceValue(v)}</span>`).join('');
}

export function refreshDeviceProfile() {
  const grid = document.getElementById('device-profile-grid');
  if (!grid) return;
  return _refreshDeviceProfileEnhanced(grid);
}
window.refreshDeviceProfile = refreshDeviceProfile;

// ── refreshPerfPanel ─────────────────────────────────────────────────────────
// Startup memory and speed both hinge on which WASM runtime the worker resolved,
// and until now nothing showed it. The lean path is the minimal relaxed-SIMD
// build reading .ort models, which skips protobuf parsing at session creation;
// the fallback is stock ORT reading .onnx, which costs materially more peak
// memory on a constrained iPhone. Purely descriptive -- no behaviour depends on
// this, it only turns an invisible difference into a readable one.
function _describeWasmRuntimeFlavor(cfg) {
  const flavor = String(cfg?.ortWasmRuntimeFlavor || 'unreported');
  if (cfg?.selectedBackend === 'webgpu') {
    return `${_escapeSettingsHtml(flavor)} <span style="color:var(--text-muted)">(WebGPU active)</span>`;
  }
  const lean = flavor === 'relaxed-simd-minimal-ort';
  const colour = lean ? 'var(--accent-green)' : (flavor === 'unreported' ? 'var(--text-muted)' : 'var(--accent-yellow)');
  const note = lean
    ? 'lean path — .ort, no protobuf parse'
    : (flavor === 'unreported' ? 'not reported yet — start narration once' : 'fallback path — larger startup memory');
  return `<span style="color:${colour};">${_escapeSettingsHtml(flavor)}</span>`
    + ` <span style="color:var(--text-muted);font-size:0.9em;">${_escapeSettingsHtml(note)}</span>`;
}

// Two engines now exist and which one runs is a device decision, so the panel
// has to say which is active and why -- otherwise a reader on a constrained
// phone has no way to tell Kokoro from Pocket except by ear.
function _resolveEngineChoice() {
  // Imported directly rather than read off window: pocket_backend_policy is in
  // the app shell, audio_core is not. Depending on audio_core meant Settings
  // showed Pocket and an empty voice list for anyone who had not started
  // narration yet in that session.
  return selectNarrationEngine({
    capability: window._pocketDeviceCapability,
    userAgent: navigator.userAgent || '',
    deviceMemory: Number(navigator.deviceMemory || 0),
    screenWidth: Number(window.screen?.width || 0),
    screenHeight: Number(window.screen?.height || 0),
    lowMemoryMode: window.userProfile?.settings?.lowMemoryMode === true,
    storage: localStorage,
  });
}

function _describeNarrationEngine() {
  const choice = _resolveEngineChoice();
  if (!choice) return '<span style="color:var(--text-muted)">not resolved yet</span>';
  const ENGINE_DISPLAY = {
    kokoro: 'Kokoro-82M (light)',
    kitten: 'KittenTTS Nano (lightest)',
    pocket: 'Pocket TTS',
  };
  const name = ENGINE_DISPLAY[choice.engine] || 'Pocket TTS';
  const how = choice.automatic
    ? `<span style="color:var(--text-muted);font-size:0.9em;">auto — ${_escapeSettingsHtml(choice.reason || 'device default')}</span>`
    : '<span style="color:var(--accent-blue-text);font-size:0.9em;">chosen in Settings</span>';
  return `${_escapeSettingsHtml(name)} ${how}`;
}

// Engine + voice controls. Rendered into an existing settings container rather
// than a new panel so it inherits the section's styling and scroll behaviour.
// Changing the engine is a preference write, not narration. Routing it through
// switchReaderVoiceEngine -- a DEFERRED action -- pulled in audio_core and
// buffer_manager just to record a choice, which is why switching popped a
// "preparing narration" overlay with no story open. Handle it in the shell and
// only touch the runtime if it is ALREADY loaded and therefore has a live
// worker to tear down.
// The Settings and reader-playbar selects are two views of ONE preference, so
// both must land here. The reader select used to call switchReaderVoiceEngine
// directly, which is a DEFERRED action: changing the engine there imported
// audio_core and buffer_manager purely to record a choice, which is where the
// looping "preparing narration" modal came from with no story open — and
// because the two selects ran different code, neither reflected the other.
function _syncEngineSelects(controlValue) {
  for (const id of ['voice-engine-select', 'reader-engine-select']) {
    const el = document.getElementById(id);
    // Always assign. Skipping when el.value already matches leaves iOS Safari
    // showing the previous label on a select that was hidden (the reader
    // playbar while Settings is open). Assigning .value does not fire change,
    // so this cannot re-enter the handler.
    if (el) el.value = controlValue;
  }
}

window.onNarrationEngineSelect = function onNarrationEngineSelect(value) {
  const choice = String(value || 'auto');
  if (!window.userProfile) window.userProfile = {};
  if (!window.userProfile.settings) window.userProfile.settings = {};

  if (choice === 'webspeech') {
    window.userProfile.settings.voiceEngine = 'webspeech';
  } else {
    window.userProfile.settings.voiceEngine = 'pocket';
    writeNarrationEngineOverride(localStorage, choice === 'auto' ? null : choice);
  }
  window.saveLocalData?.();
  _syncEngineSelects(choice);

  // Only if the runtime is already up: a loaded engine holds a model set for
  // the engine being switched away from.
  if (window.__pocketNarrationRuntimeLoaded === true) {
    try { window.switchReaderVoiceEngine?.(choice, true); } catch (_) {}
  }
  // Re-apply after the runtime path: switchReaderVoiceEngine used to collapse
  // the UI value to stored 'pocket' and leave the reader playbar on Pocket TTS
  // after the reader picked Kitten in Settings.
  _syncEngineSelects(choice);
  // Rebuild the reader playbar list in the shell. Waiting for the deferred
  // switchReaderVoiceEngine path left Pocket/Kokoro voices empty until the
  // runtime happened to load and the reader was left and re-entered.
  try { window.syncNarrationControls(); } catch (_) {}
  if (typeof window.refreshPerfPanel === 'function') {
    try { window.refreshPerfPanel(); } catch (_) {}
  }
  window.pocketNotify?.('Narration engine updated. The next paragraph uses it.');
};

function _fillWebSpeechVoiceSelector(selector) {
  if (!selector || !('speechSynthesis' in window)) return;
  const voices = window.speechSynthesis.getVoices();
  const english = voices.filter((voice) => String(voice.lang || '').startsWith('en'));
  const list = english.length ? english : voices;
  const saved = window.userProfile?.settings?.webVoice || '';
  selector.innerHTML = '';
  list.forEach((voice) => {
    const opt = document.createElement('option');
    opt.value = voice.name;
    opt.textContent = `${voice.name} (${voice.lang})`;
    selector.appendChild(opt);
  });
  if (saved && Array.from(selector.options).some((option) => option.value === saved)) {
    selector.value = saved;
  } else if (selector.options.length && window.userProfile?.settings) {
    window.userProfile.settings.webVoice = selector.value;
  }
}

// Called on reader entry. Everything here is shell-only on purpose: the old
// hook called refreshVoiceSelectorForEngine, a DEFERRED action, so simply
// OPENING a story imported audio_core and buffer_manager to fill a dropdown —
// pulling up the narration runtime (and its modal) with no story playing.
//
// Kokoro and Kitten lists live in the shell policy. Pocket's catalog lives on
// engine_utils (renderPocketVoiceOptions). Device voices come from
// speechSynthesis. None of those need the narration runtime.
window.syncNarrationControls = function syncNarrationControls() {
  try { renderNarrationEngineControls(); } catch (_) {}

  const usingWebSpeech = window.userProfile?.settings?.voiceEngine === 'webspeech';
  const engine = usingWebSpeech ? 'webspeech' : _resolveEngineChoice().engine;
  const selector = document.getElementById('voice-selector');
  if (!selector) return;

  const voices = voicesForEngine(engine);
  if (voices.length) {
    const savedKey = engine === KITTEN_ENGINE ? 'kittenVoice' : 'kokoroVoice';
    const chosen = coerceVoiceForEngine(engine, window.userProfile?.settings?.[savedKey]);
    const group = (gender) => voices
      .filter((voice) => voice.gender === gender)
      .map((voice) => `<option value="${_escapeSettingsHtml(voice.id)}"${voice.id === chosen ? ' selected' : ''}>`
        + `${_escapeSettingsHtml(voice.label)}${voice.grade ? ` (${_escapeSettingsHtml(voice.grade)})` : ''}</option>`)
      .join('');
    const markup = `<optgroup label="Female voices">${group('female')}</optgroup>`
      + `<optgroup label="Male voices">${group('male')}</optgroup>`;
    // Rebuild when the list is not already THIS engine's. Checking only for the
    // chosen id was enough with two engines and is not with three: two engines
    // can both be missing an id while the list on screen belongs to neither.
    const listIsCurrent = voices.every((v) => selector.querySelector(`option[value="${v.id}"]`))
      && selector.querySelectorAll('option').length === voices.length;
    if (!listIsCurrent) selector.innerHTML = markup;
    selector.value = chosen;
    if (window.userProfile?.settings) window.userProfile.settings[savedKey] = chosen;
    return;
  }

  if (engine === 'pocket' && typeof window.renderPocketVoiceOptions === 'function') {
    const saved = window.userProfile?.settings?.pocketVoice || window.POCKET_DEFAULT_VOICE;
    const chosen = window.renderPocketVoiceOptions(selector, saved);
    if (window.userProfile?.settings) window.userProfile.settings.pocketVoice = chosen;
    return;
  }

  if (engine === 'webspeech' && 'speechSynthesis' in window) {
    const fill = () => _fillWebSpeechVoiceSelector(selector);
    if (!window.speechSynthesis.getVoices().length) {
      window.speechSynthesis.addEventListener('voiceschanged', fill, { once: true });
    }
    fill();
    return;
  }

  if (window.__pocketNarrationRuntimeLoaded === true
      && typeof window.refreshVoiceSelectorForEngine === 'function') {
    try { window.refreshVoiceSelectorForEngine(); } catch (_) {}
  }
};

// Pocket-only settings, hidden when Pocket is not what will actually speak.
//
// Both cards were shown unconditionally. On Kokoro -- which is every iPhone and
// every device reporting 4 GB or less -- the emotion controls have no per-emotion
// voices to select between, and the backend card is inert because
// _loadPocketEngine hardcodes Kokoro's plan. Worse, "Re-run backend
// optimization" checks isolation FIRST, so on an un-isolated device it stored a
// resume token, rewrote the URL with ?tts_fast=1 and reloaded the whole app --
// to reach a call that returns immediately.
export function syncPocketOnlySettings() {
  const engine = _resolveEngineChoice()?.engine;
  const usingWebSpeech = window.userProfile?.settings?.voiceEngine === 'webspeech';
  const pocketActive = !usingWebSpeech && engine === 'pocket';
  for (const id of ['expressive-narration-card', 'narration-backend-card']) {
    const card = document.getElementById(id);
    if (!card) continue;
    card.hidden = !pocketActive;
    // hidden alone loses to `display` from a class in this stylesheet, and
    // `details` carries its own default display, so set it explicitly too.
    card.style.display = pocketActive ? '' : 'none';
  }
}
window.syncPocketOnlySettings = syncPocketOnlySettings;

export function renderNarrationEngineControls() {
  const host = document.getElementById('narration-engine-controls');
  if (!host) return;
  const choice = _resolveEngineChoice();
  const override = readNarrationEngineOverride(localStorage) || '';
  const usingWebSpeech = window.userProfile?.settings?.voiceEngine === 'webspeech';
  // Voices come from the engine ACTUALLY resolved, never a fixed list. Reading
  // KOKORO_VOICES unconditionally is how a Kitten device would be offered
  // af_heart, which its worker cannot load.
  const voices = voicesForEngine(choice.engine);
  const savedKey = choice.engine === KITTEN_ENGINE ? 'kittenVoice' : 'kokoroVoice';
  const savedVoice = coerceVoiceForEngine(choice.engine, window.userProfile?.settings?.[savedKey]);

  // Keep the single Voice Engine select in step, including labelling which
  // engine "Automatic" actually resolves to on THIS device -- the previous
  // wording said "Pocket on this device" everywhere because it was reading a
  // default rather than the real decision. The label must use the AUTOMATIC
  // pick, not `choice.engine`: once a reader overrides to Pocket, `choice`
  // is Pocket and the Automatic option would then claim Pocket is the default.
  // ignoreOverride, not storage: null. The old form suppressed the manual
  // choice by taking storage away, which also hid the measured headroom -- so
  // on a phone that had measured 1024 MB and really resolves to Pocket, this
  // fell through to the reported-RAM rule with no RAM figure either and
  // labelled Automatic as Kokoro. The "Detected: ..." line two lines below read
  // the measurement correctly, so the panel contradicted itself.
  const autoPick = selectNarrationEngine({
    ignoreOverride: true,
    storage: localStorage,
    capability: window._pocketDeviceCapability || {},
    userAgent: navigator.userAgent || '',
    deviceMemory: Number(navigator.deviceMemory || 0),
    hardwareConcurrency: Number(navigator.hardwareConcurrency || 0),
    lowMemoryMode: window.userProfile?.settings?.lowMemoryMode === true,
    screenWidth: Number(window.screen?.width || 0),
    screenHeight: Number(window.screen?.height || 0),
  });
  const select = document.getElementById('voice-engine-select');
  if (select) {
    const autoOption = select.querySelector('option[value="auto"]');
    if (autoOption) {
      const ENGINE_LABELS = { kokoro: 'Kokoro', kitten: 'Kitten', pocket: 'Pocket TTS' };
      autoOption.textContent = `Automatic - ${ENGINE_LABELS[autoPick.engine] || ENGINE_LABELS[choice.engine] || 'Pocket TTS'} on this device`;
    }
    const desired = _voiceEngineControlValue();
    // The reader playbar shows the same preference and is a different element,
    // so it has to be reconciled from the same source of truth.
    _syncEngineSelects(desired);
  }

  // Only the voice picker and the reason line live here now. The engine choice
  // itself moved into the Voice Engine select above.
  const voicePickerActive = !usingWebSpeech && voices.length > 0;
  const voiceOptions = voices.map((voice) =>
    `<option value="${_escapeSettingsHtml(voice.id)}"${voice.id === savedVoice ? ' selected' : ''}>`
    + `${_escapeSettingsHtml(voice.label)}${voice.grade ? ` (${_escapeSettingsHtml(voice.grade)})` : ''}</option>`
  ).join('');

  const why = usingWebSpeech
    ? ''
    : `<p style="font-size:0.78rem;color:var(--text-muted);margin:2px 0 8px;">${
        choice.automatic
          ? `Detected: ${_escapeSettingsHtml(choice.reason || 'using the device default')}`
          : 'Engine chosen manually.'
      }</p>`;

  // Override warning. Shown only when the reader has moved UP the ladder --
  // choosing a LIGHTER engine than detected is always safe and must not be nagged.
  let warning = '';
  if (!usingWebSpeech && override && !choice.automatic) {
    const auto = autoPick;
    const rank = (e) => NARRATION_ENGINE_TIERS.indexOf(e);
    if (rank(override) > rank(auto.engine)) {
      const heavier = { kokoro: 'Kokoro', pocket: 'Pocket TTS' }[override] || override;
      warning = '<p role="status" style="font-size:0.78rem;line-height:1.45;margin:2px 0 10px;'
        + 'padding:8px 10px;border:1px solid var(--accent-amber,#c9a75c);border-radius:8px;'
        + 'color:var(--text-main);"><b>Heads up:</b> ' + _escapeSettingsHtml(heavier)
        + ' needs more memory than this device was measured to have spare. Narration'
        + ' may stall or the tab may reload mid-story. Switch back to Automatic if that happens.</p>';
    }
  }

  const engineName = { kokoro: 'Kokoro', kitten: 'Kitten' }[choice.engine] || '';
  const voiceNote = choice.engine === 'kokoro'
    ? "Letter grades are Kokoro's own quality ratings. Male voices top out at C+."
    : 'KittenTTS publishes no quality grades, so none are shown.';
  host.innerHTML = `${why}${warning}
    <div id="kokoro-voice-row" style="display:${voicePickerActive ? 'block' : 'none'};">
      <label for="kokoro-voice-select" style="display:block;font-size:0.85rem;color:var(--text-muted);margin-bottom:4px;">${_escapeSettingsHtml(engineName)} voice</label>
      <select id="kokoro-voice-select" class="settings-control" style="width:100%;">${voiceOptions}</select>
      <p style="font-size:0.78rem;color:var(--text-muted);margin:6px 0 0;">${_escapeSettingsHtml(voiceNote)}</p>
    </div>`;

  syncPocketOnlySettings();

  document.getElementById('kokoro-voice-select')?.addEventListener('change', (event) => {
    if (!window.userProfile?.settings) return;
    // Store under the ENGINE OWN key. One shared key would mean switching
    // engines silently carried a voice id the other engine cannot load.
    window.userProfile.settings[savedKey] = event.target.value;
    window.saveLocalData?.();
    window.pocketNotify?.(`${engineName} voice updated.`);
  });
}
window.renderNarrationEngineControls = renderNarrationEngineControls;

export async function refreshPerfPanel() {
  const p = document.getElementById('perf-panel');
  if (!p) return;
  const engineVal = window.userProfile?.settings?.voiceEngine || 'pocket';
  const isNeural  = engineVal === 'pocket';
  const settings  = window.userProfile?.settings || {};
  const gpuVendor = window._gpuVendor || 'detecting...';
  const pocketCfg = typeof window.getPocketTtsRuntimeConfig === 'function'
    ? window.getPocketTtsRuntimeConfig()
    : null;
  const pocketRows = pocketCfg ? `
    <li><b>Pocket Speed:</b> ${Number(pocketCfg.speed || 1).toFixed(2)}x</li>
    <li><b>Pocket Temp:</b> ${_escapeSettingsHtml(pocketCfg.temperaturePreset)} (${Number(pocketCfg.temperature).toFixed(2)})</li>
    <li><b>Pocket Quality:</b> ${_escapeSettingsHtml(pocketCfg.qualityMode)} / LSD ${pocketCfg.lsdSteps}</li>
    <li><b>Pronunciation:</b> ${_escapeSettingsHtml(pocketCfg.pronunciationRulesetVersion)} (${pocketCfg.builtInPronunciationRuleCount || '?'} built-in, ${pocketCfg.pronunciationOverrideCount || 0} custom)</li>
    <li><b>Pocket Cache:</b> ${_escapeSettingsHtml(pocketCfg.cacheVersion)} / ${_escapeSettingsHtml(pocketCfg.chunkingVersion)}</li>
    <li><b>Narration Backend:</b> ${_escapeSettingsHtml(pocketCfg.selectedBackend)} (${_escapeSettingsHtml(pocketCfg.modelPrecision)})</li>
    <li><b>Runtime / Model:</b> ORT ${_escapeSettingsHtml(pocketCfg.ortVersion)} / ${_escapeSettingsHtml(pocketCfg.modelRevision)}</li>
    <li><b>Narration Engine:</b> ${_describeNarrationEngine()}</li>
    <li><b>WASM Runtime:</b> ${_describeWasmRuntimeFlavor(pocketCfg)}</li>
    <li><b>Relaxed SIMD / .ort:</b> ${pocketCfg.relaxedSimdSupported === null
      ? '<span style="color:var(--text-muted)">not reported yet</span>'
      : `${pocketCfg.relaxedSimdSupported
          ? '<span style="color:var(--accent-green);">supported</span>'
          : '<span style="color:var(--accent-yellow);">unsupported</span>'} / ${pocketCfg.ortFormatModels
          ? '<span style="color:var(--accent-green);">.ort</span>'
          : '<span style="color:var(--accent-yellow);">.onnx protobuf</span>'}`}</li>
    <li><b>Isolation:</b> ${pocketCfg.crossOriginIsolated
      ? `<span style="color:var(--accent-green);">on</span> — threaded (×${pocketCfg.wasmThreadCount})`
      : `<span style="color:var(--accent-yellow);">off</span> — single-thread fallback`}</li>
    <li><b>GPU-resident State:</b> ${pocketCfg.gpuResidentStateBytes ? `${(pocketCfg.gpuResidentStateBytes / 1048576).toFixed(1)} MiB` : 'N/A'}</li>
    <li><b>Operator Fallbacks:</b> ${Number.isFinite(pocketCfg.operatorFallbackCount) ? pocketCfg.operatorFallbackCount : 'Not reported by ORT Web'}</li>
    <li><b>Calibration:</b> median ${pocketCfg.medianMs ? `${Math.round(pocketCfg.medianMs)}ms` : 'N/A'}, p95 ${pocketCfg.p95Ms ? `${Math.round(pocketCfg.p95Ms)}ms` : 'N/A'}</li>
    ${pocketCfg.backendRejectionReason ? `<li><b>Backend Note:</b> ${_escapeSettingsHtml(pocketCfg.backendRejectionReason)}</li>` : ''}
  ` : '';
  if (typeof window._neuralState !== 'function' && typeof window.ensureNarrationRuntime === 'function') {
    window.ensureNarrationRuntime().then(() => {
      const perfEl = document.getElementById('perf-panel');
      if (perfEl && typeof refreshPerfPanel === 'function') refreshPerfPanel();
    }).catch(() => {});
  }
  p.innerHTML = `<ul style="font-size:0.85rem;padding-left:20px;color:var(--text-main);line-height:1.6;">
    <li><b>Neural Engine:</b> ${isNeural
      ? `<span style="color:var(--accent-green);">Active (${_escapeSettingsHtml({ kokoro: 'Kokoro-82M', kitten: 'KittenTTS Nano', pocket: 'Pocket TTS' }[_resolveEngineChoice()?.engine] || 'Pocket TTS')})</span>`
      : 'Inactive'}</li>
    <li><b>Engine State:</b> ${typeof window._neuralState === 'function' ? window._neuralState() : 'idle (loading...)'}</li>
    ${pocketRows}
    <li><b>GPU Vendor:</b> ${gpuVendor}</li>
    <li><b>Workers:</b> ${settings.maxWorkers || detectWorkerCount()} (${settings.enableManualWorkers ? 'manual' : 'auto'})</li>
    <li><b>Backend Latency:</b> <span id="perf-latency-val">Measuring...</span></li>
    <li><b>DOM Nodes:</b> ${document.getElementsByTagName('*').length}</li>
  </ul>`;
  try {
    await _loadSiteHealth();
    const valEl   = document.getElementById('perf-latency-val');
    if (valEl) valEl.innerText = Number.isFinite(_lastSiteHealthLatencyMs)
      ? `${_lastSiteHealthLatencyMs}ms`
      : 'Not measured';
  } catch(e) {
    const valEl = document.getElementById('perf-latency-val');
    if (valEl) valEl.innerText = 'Offline/Error';
  }
}
window.refreshPerfPanel = refreshPerfPanel;

// ── Global Away Workers Setting Fallback ──────────────────────────────────
if (typeof window.saveAwayWorkersSetting !== 'function') {
  window.saveAwayWorkersSetting = function(val) {
    const num = parseInt(val, 10);
    // Same ceiling as buffer_manager's real implementation, which replaces this
    // once the narration runtime loads.
    if (!isNaN(num) && num >= 1 && num <= NARRATION_WORKER_CEILING) {
      if (window.userProfile && window.userProfile.settings) {
        window.userProfile.settings.enableManualWorkers = true;
        window.userProfile.settings.maxWorkers = num;
        if (typeof window.saveLocalData === 'function') window.saveLocalData();
      }
    }
  };
}


// Boot catch-up. MUST be the last thing in this module.
//
// loadLocalData() renders the settings UI when it finishes hydrating, but it
// runs from library_manager's module body, and that module is loaded BEFORE
// this one. When hydration wins the race, its
// `typeof window.initSettingsUI === 'function'` guard is false and the render
// is skipped in silence -- which is how a stored Kitten choice showed as
// "Automatic" on every launch while the policy correctly resolved 'kitten'.
//
// Position matters as much as existence. Placed next to the
// `window.initSettingsUI =` export this ran BEFORE
// `window.syncNarrationControls` was assigned further down, so the optional
// call inside initSettingsUI no-opped and the engine selects came back correct
// while the voice picker still listed the previous engine's voices. Same
// load-order trap, one module lower. At the very end every export exists.
//
// Idempotent: if hydration has not finished yet this does nothing, and
// loadLocalData still owns the call.
if (window.__pocketProfileHydrated === true && window.userProfile?.settings) {
  try { initSettingsUI(); } catch (_) {}
  try { window.applySettings?.(); } catch (_) {}
  try { window.syncNarrationControls?.(); } catch (_) {}
}
