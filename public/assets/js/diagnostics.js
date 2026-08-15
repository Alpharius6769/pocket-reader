export function serializeDiagnosticValue(value, seen = new WeakSet()) {
  if (value instanceof Error || (typeof DOMException !== 'undefined' && value instanceof DOMException)) {
    if (seen.has(value)) return '[Circular Error]';
    seen.add(value);
    return {
      name: value.name || 'Error',
      message: value.message || String(value),
      stack: value.stack || null,
      code: value.code ?? null,
      cause: value.cause ? serializeDiagnosticValue(value.cause, seen) : null,
    };
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => serializeDiagnosticValue(item, seen));
  const output = {};
  for (const key of Object.keys(value)) {
    try { output[key] = serializeDiagnosticValue(value[key], seen); }
    catch (_) { output[key] = '[Unavailable]'; }
  }
  return output;
}

function normalizeAppVersion(value) {
  return String(value || '').trim().replace(/^v+/i, '');
}

export const Diagnostics = {
  buffer: [],
  maxSize: 500,
  _dirty: false,
  _saveTimer: null,
  _memTimer: null,
  _memSnapshot: null,
  _appVersion: null,

  _isRuntimeNoise(message = '') {
    const text = String(message || '');
    return /JQMIGRATE|jquery-migrate\.min\.map|bootstrap\.css\.map|Source map error|unreachable code after return statement|skulpt\.min\.js/i.test(text);
  },

  _flush() {
    if (!this._dirty) return;
    try { localStorage.setItem('pr_diagnostics', JSON.stringify(this.buffer)); } catch (e) {}
    this._dirty = false;
  },

  init() {
    // Load existing buffer from storage if any
    try {
      const saved = localStorage.getItem('pr_diagnostics');
      if (saved) {
        this.buffer = JSON.parse(saved);
      }
    } catch (e) {}

    // Flush on tab close / navigation. pagehide is the one that actually fires
    // on mobile — iOS in particular routinely tears a tab down without ever
    // dispatching beforeunload — and a registered beforeunload listener costs
    // bfcache eligibility in some engines, so it is deliberately not used here.
    window.addEventListener('pagehide', () => this._flush());

    // Cache performance.memory every 5s to avoid reading it on every log call.
    // Paused while the tab is hidden: a backgrounded reader has nothing to log,
    // and a 5s wake that runs for the life of the session is pure battery cost
    // on mobile. Chromium-only either way — WebKit does not expose
    // performance.memory, so iOS never starts this timer at all.
    if (performance && performance.memory) {
      const snapMem = () => {
        this._memSnapshot = {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
        };
      };
      snapMem();
      this._memTimer = setInterval(snapMem, 5000);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          clearInterval(this._memTimer);
          this._memTimer = null;
        } else if (!this._memTimer) {
          snapMem();
          this._memTimer = setInterval(snapMem, 5000);
        }
      });
    }

    this.log('INFO', 'Diagnostics initialized');

    // Intercept global errors
    window.addEventListener('error', (event) => {
      if (this._isRuntimeNoise(`${event.message || ''} ${event.filename || ''}`)) return;
      this.log('ERROR', `Uncaught Error: ${event.message}`, {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        errorObj: event.error ? event.error.stack : null
      });
    });

    window.addEventListener('unhandledrejection', (event) => {
      if (this._isRuntimeNoise(event.reason)) return;
      this.log('ERROR', `Unhandled Promise Rejection: ${event.reason?.message || event.reason}`, {
        reason: serializeDiagnosticValue(event.reason),
      });
    });

    // Intercept console functions
    const intercept = (method, level) => {
      const orig = console[method];
      if (!orig) return;
      console[method] = (...args) => {
        const normalizedArgs = args.map(a => serializeDiagnosticValue(a));
        const message = normalizedArgs.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        if (!this._isRuntimeNoise(message)) this.log(level, message, { arguments: normalizedArgs });
        orig.apply(console, args);
      };
    };
    intercept('error', 'ERROR');
    intercept('warn', 'WARN');
    intercept('info', 'INFO');
    intercept('debug', 'DEBUG');

    // Collect hardware telemetry on boot
    this._collectTelemetry();
  },

  async _collectTelemetry() {
    // SharedArrayBuffer and SIMD are independent capabilities. Pocket remains
    // functional without SAB, but isolated SAB-backed ORT threads are the
    // production fast path for iOS and other mobile devices.
    const hasSAB  = typeof SharedArrayBuffer !== 'undefined';
    const simdProbe = new Uint8Array([
      0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,8,1,6,0,65,0,253,15,11,
    ]);
    const hasWasmSimd = typeof WebAssembly !== 'undefined' && WebAssembly.validate(simdProbe);
    const cores   = navigator.hardwareConcurrency || 2;
    const autoWorkers = Math.max(2, Math.min(8, cores));
    const manualEnabled = !!(window.userProfile?.settings?.enableManualWorkers);
    const pocketSelected = (window.userProfile?.settings?.voiceEngine || 'pocket') === 'pocket';
    const maxWorkers = pocketSelected
      ? 1
      : (manualEnabled ? (window.userProfile?.settings?.maxWorkers || autoWorkers) : autoWorkers);

    this.log('INFO', 'Runtime environment', {
      cores,
      hasSAB,
      wasmSimd: hasWasmSimd,
      maxWorkers,
      manualEnabled,
      webGPU: !!navigator.gpu,
    });

    if (!navigator.gpu) {
      this.log('INFO', 'WebGPU not supported on this browser.');
      return;
    }

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        this.log('WARN', 'WebGPU supported but no adapter found.');
        return;
      }
      let info = { vendor: 'Unknown', architecture: 'Unknown' };
      if (adapter.requestAdapterInfo) {
        try { info = await adapter.requestAdapterInfo(); } catch(e){}
      } else if (adapter.info) {
        info = adapter.info;
      }

      const details = {
        vendor:       info.vendor,
        architecture: info.architecture,
        device:       info.device,
        description:  info.description,
        features:     [...adapter.features.values()],
        limits: {},
      };
      for (const key of ['maxComputeWorkgroupSizeX', 'maxStorageBufferBindingSize', 'maxBufferSize']) {
        if (adapter.limits[key] !== undefined) details.limits[key] = adapter.limits[key];
      }
      this.log('INFO', 'WebGPU Adapter Telemetry', details);

      // Cross-check with audio_core's resolved vendor (may differ from raw adapter info)
      const resolvedVendor = window._gpuVendor || 'pending';
      this.log('INFO', 'GPU vendor (audio_core resolved)', { resolvedVendor });

    } catch (e) {
      this.log('ERROR', 'Failed to collect WebGPU telemetry: ' + e.message);
    }

    // Re-run after audio_core finishes async detection if still pending
    if (!window._gpuVendor || window._gpuVendor === 'unknown') {
      setTimeout(() => {
        const v = window._gpuVendor || 'unknown';
        this.log('INFO', 'GPU vendor (delayed check)', { vendor: v });
      }, 2500);
    }
  },

  log(level, message, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: level,
      message: message,
      details: serializeDiagnosticValue(details),
      context: this.getContext()
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }

    // Debounced persist — flush immediately on beforeunload/pagehide
    this._dirty = true;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flush(), 2000);
  },

  getContext() {
    const ctx = {
      url: window.location.href,
      userAgent: navigator.userAgent,
      view: window.currentActiveView || 'unknown'
    };

    if (this._memSnapshot) {
      ctx.memory = this._memSnapshot;
    }

    return ctx;
  },

  async downloadLogs() {
    let finalLogs = {
      frontendLogs: this.buffer,
      backendLogs: []
    };
    const adminSecret = window.PR_ADMIN_SECRET || window.POCKET_READER_CONFIG?.adminSecret || '';
    if (!adminSecret) {
      finalLogs.backendLogs = ['Backend logs skipped: admin secret not configured in this browser session.'];
    } else try {
      const baseUrl = window.HF_API_BASE || window.POCKET_READER_CONFIG?.apiBase || 'https://alpharius6769-pocket-reader.hf.space';
      const res = await fetch(`${baseUrl}/api/diag/logs`, {
        headers: { 'X-Admin-Secret': adminSecret }
      });
      if (res.ok) {
        const data = await window._safeParseJson(res, 'API');
        finalLogs.backendLogs = data.logs || [];
      } else {
        finalLogs.backendLogs = [`Failed to fetch backend logs: HTTP ${res.status}`];
      }
    } catch (e) {
      finalLogs.backendLogs = [`Failed to fetch backend logs: ${e.message}`];
    }
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(finalLogs, null, 2));
    const a = document.createElement('a');
    a.setAttribute("href", dataStr);
    a.setAttribute("download", `pocket_reader_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  // Full self-diagnostic
  async runDiagnostic() {
    const statusEl = document.getElementById('diagnostic-status');
    const runBtn   = document.getElementById('run-diag-btn');
    if (runBtn) { runBtn.disabled = true; runBtn.textContent = 'Running diagnostic...'; }
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = ''; }

    const results = [];
    const log = (mark, label, status, detail = '') => {
      const line = `${mark} [${status}] ${label}${detail ? ' - ' + detail : ''}`;
      results.push({ label, status, detail });
      if (statusEl) statusEl.textContent += line + '\n';
    };
    const timedTest = async (label, fn) => {
      const t0 = Date.now();
      try {
        const result = await fn();
        log('OK', label, 'PASS', result + ` (${Date.now()-t0}ms)`);
        return true;
      } catch(e) {
        log('FAIL', label, 'FAIL', e.message);
        return false;
      }
    };
    const warn = (label, fn) => timedTest(label, fn).then(ok => !ok && log('WARN', label, 'WARN'));

    if (statusEl) statusEl.textContent = '-- Browser Capabilities --\n';

    // 1. SharedArrayBuffer
    if (typeof SharedArrayBuffer === 'undefined') {
      log('WARN', 'SharedArrayBuffer (WASM threads)', 'LIMITED', 'unavailable; Pocket TTS is limited to slower one-thread WASM');
    } else {
      log('OK', 'SharedArrayBuffer (WASM threads)', 'PASS', 'supported');
    }

    // 2. WebGPU
    await timedTest('WebGPU', async () => {
      if (!navigator.gpu) throw new Error('not supported in this browser');
      const a = await navigator.gpu.requestAdapter();
      if (!a) throw new Error('supported but no adapter available');
      return `adapter found - vendor: ${window._gpuVendor || 'detecting'}`;
    });

    // 3. WebGL fallback
    await timedTest('WebGL 2', () => {
      const c = document.createElement('canvas');
      const ctx = c.getContext('webgl2');
      if (!ctx) throw new Error('WebGL 2 not available');
      return 'available';
    });

    // 4. Web Audio API
    await timedTest('Web Audio API', () => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('not supported');
      return 'supported';
    });

    // 5. Speech Synthesis
    await timedTest('Web Speech API (Device voice fallback)', () => {
      if (!('speechSynthesis' in window)) throw new Error('not supported');
      return `${speechSynthesis.getVoices().length} voices loaded`;
    });

    // 6. MediaSession (lock screen controls)
    await timedTest('MediaSession API (lock screen)', () => {
      if (!('mediaSession' in navigator)) throw new Error('not supported - lock screen controls unavailable');
      return 'supported';
    });

    // 7. Service Worker
    await timedTest('Service Worker', async () => {
      if (!('serviceWorker' in navigator)) throw new Error('not supported');
      const regs = await navigator.serviceWorker.getRegistrations();
      if (window.__prServiceWorkerError && !regs.length) {
        throw new Error(window.__prServiceWorkerError.message || 'registration failed');
      }
      if (!regs.length) throw new Error('supported, but no active registration');
      const scripts = regs.map(reg => reg.active?.scriptURL || reg.waiting?.scriptURL || reg.installing?.scriptURL).filter(Boolean);
      return `${regs.length} active - ${scripts.join(', ') || 'script URL pending'}`;
    });

    // 8. IndexedDB
    await timedTest('IndexedDB (audio cache)', async () => {
      await new Promise((res, rej) => {
        const req = indexedDB.open('_diag_test_', 1);
        req.onerror = () => rej(new Error('IndexedDB open failed'));
        req.onsuccess = () => { req.result.close(); indexedDB.deleteDatabase('_diag_test_'); res(); };
        req.onupgradeneeded = e => e.target.result.createObjectStore('t');
      });
      return 'read/write OK';
    });

    // 9. LocalStorage
    await timedTest('LocalStorage', () => {
      localStorage.setItem('_diag_test', '1');
      if (localStorage.getItem('_diag_test') !== '1') throw new Error('write-read mismatch');
      localStorage.removeItem('_diag_test');
      return 'read/write OK';
    });

    // 10. Storage quota
    await timedTest('Storage quota', async () => {
      if (!navigator.storage?.estimate) throw new Error('Storage API not available');
      const { usage, quota } = await navigator.storage.estimate();
      const usedMB  = (usage  / 1048576).toFixed(1);
      const quotaMB = (quota  / 1048576).toFixed(0);
      return `${usedMB} MB used / ${quotaMB} MB quota`;
    });

    if (statusEl) statusEl.textContent += '\n-- Network Connectivity --\n';

    const baseUrl = window.HF_API_BASE || window.POCKET_READER_CONFIG?.apiBase || 'https://alpharius6769-pocket-reader.hf.space';
    const proxyBase = window.PR_PROXY_BASE || window.POCKET_READER_CONFIG?.proxyBase || 'https://pocket-reader-proxy.christopher-gotham67.workers.dev';
    const timeout = (ms, p) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`timeout after ${ms}ms`)), ms))]);

    // 11. HuggingFace backend API
    await timedTest('HuggingFace backend API', async () => {
      // Try the dedicated health endpoint first; if the Space is running an older
      // deployment that predates it, fall back to the root route.
      let r = await timeout(6000, fetch(`${baseUrl}/api/health`));
      if (r.status === 404) {
        r = await timeout(6000, fetch(`${baseUrl}/`));
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let detail = `HTTP ${r.status}`;
      try {
        const body = await r.json();
        if (body.version) {
          this._appVersion = normalizeAppVersion(body.version);
          detail += ` - v${this._appVersion}`;
        }
        if (body.uptime_human) detail += ` - up ${body.uptime_human}`;
        if (body.config) {
          if (!body.config.edge_proxy_configured) detail += ' - no edge proxy';
          if (!body.config.vapid_configured)      detail += ' - no VAPID';
        }
      } catch(_) {}
      return detail;
    });

    // 12. Cloudflare proxy — ping our own proxy with a known safe target (AO3 robots.txt)
    await timedTest('Cloudflare Worker proxy', async () => {
      const proxyUrl = `${proxyBase}/?url=`
        + encodeURIComponent('https://archiveofourown.org/robots.txt');
      const r = await timeout(8000, fetch(proxyUrl));
      // This probe proves our WORKER is reachable, not the upstream. AO3 sits
      // behind its own CDN and can return a transient 5xx (e.g. 525 SSL
      // handshake) that the worker faithfully passes through — an upstream
      // hiccup, not a proxy outage, so it must not read as a hard FAIL. Any
      // HTTP response means the proxy answered; only a network error/timeout
      // (thrown by fetch/timeout above) is a genuine proxy failure.
      if (r.ok) return `reachable (${r.status})`;
      if (r.status >= 500) return `reachable - upstream degraded (${r.status})`;
      throw new Error(`HTTP ${r.status}`);
    });

    // 13. FicHub API reachability (needed for AO3 story loading via CF proxy)
    await timedTest('FicHub API (via CF proxy)', async () => {
      const proxyUrl = `${proxyBase}/?url=`
        + encodeURIComponent('https://fichub.net/api/v0/epub?q=archiveofourown.org/works/1');
      const r = await timeout(8000, fetch(proxyUrl));
      // A 4xx from FicHub itself means the proxy works but the work ID doesn't exist — that's fine
      if (r.status === 0 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      return `reachable (${r.status})`;
    });

    if (statusEl) statusEl.textContent += '\n-- App State --\n';

    // 14. TTS worker state
    {
      const state = typeof window._neuralState === 'function' ? window._neuralState() : 'unknown';
      const telemetry = window._pocketLoadTelemetry || {};
      const stateAgeMs = typeof window._neuralStateAgeMs === 'function' ? window._neuralStateAgeMs() : 0;
      const lastActivityAt = Number(telemetry.lastProgressAt || 0);
      const staleMs = lastActivityAt ? Date.now() - lastActivityAt : stateAgeMs;
      const pct = Number(telemetry.progress || 0);
      const byteDetail = telemetry.loadedBytes && telemetry.totalBytes
        ? `, ${(telemetry.loadedBytes / 1048576).toFixed(1)}/${(telemetry.totalBytes / 1048576).toFixed(1)} MiB`
        : '';
      if (state === 'error' || state === 'failed') {
        log('FAIL', 'Pocket TTS worker pool', 'FAIL', `state: ${state}`);
      } else if (state === 'loading') {
        const stale = staleMs > 90000;
        log(stale ? 'WARN' : 'INFO', 'Pocket TTS worker pool', stale ? 'WARN' : 'INFO',
          `state: loading, ${Math.round(pct)}%${byteDetail}, last progress ${Math.round(staleMs / 1000)}s ago`);
      } else {
        log('OK', 'Pocket TTS worker pool', 'PASS', `state: ${state}`);
      }
    }

    // 15. Key global functions
    const fns = ['loadStory','handleSearchSubmit','seekToChapter','togglePlayState','renderAchievements'];
    await timedTest('Core app functions present', () => {
      const missing = fns.filter(f => typeof window[f] !== 'function');
      if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
      return `all ${fns.length} verified`;
    });

    // 16. Error count
    const errCount = this.buffer.filter(e => e.level === 'ERROR').length;
    const warnCount = this.buffer.filter(e => e.level === 'WARN').length;
    log(errCount > 10 ? 'WARN' : 'OK', 'Error log entries', errCount > 10 ? 'WARN' : 'INFO',
        `${errCount} errors, ${warnCount} warnings in session buffer`);

    // 17. Settings snapshot
    const s = window.userProfile?.settings || {};
    log('INFO', 'Active settings', 'INFO',
        `engine:${s.voiceEngine||'pocket'} backend:${s.pocketBackend||'auto'} workers:${s.maxWorkers} lowMem:${s.lowMemoryMode}`);

    if (statusEl) statusEl.textContent += '\n-- Done --\n';

    // ── Compose the report ──────────────────────────────────────────────
    const pass  = results.filter(r => r.status === 'PASS').length;
    const fail  = results.filter(r => r.status === 'FAIL').length;
    const total = results.length;

    const deviceProfile = typeof window.collectDeviceProfile === 'function'
      ? await window.collectDeviceProfile().catch(() => null)
      : null;
    const pocketTts = typeof window.getPocketTtsRuntimeConfig === 'function'
      ? window.getPocketTtsRuntimeConfig()
      : null;
    const report = {
      meta: {
        appVersion:  this._appVersion ? `v${normalizeAppVersion(this._appVersion)}` : 'unknown',
        generatedAt: new Date().toISOString(),
        userAgent:   navigator.userAgent,
        url:         window.location.href,
        summary:     `${pass}/${total} tests passed - ${fail} failure(s)`,
      },
      settings: { ...s },
      pocketTts,
      hardware: {
        cores:     navigator.hardwareConcurrency,
        memory:    navigator.deviceMemory || 'unknown',
        dpr:       window.devicePixelRatio,
        gpuVendor: window._gpuVendor || 'unknown',
        platform:  navigator.platform,
        sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
        crossOriginIsolated: window.crossOriginIsolated,
        deviceProfile,
      },
      tests:    results,
      errorLog: this.buffer.filter(e => e.level === 'ERROR').slice(-30),
      warnLog:  this.buffer.filter(e => e.level === 'WARN').slice(-20),
      fullLog:  this.buffer.slice(-100),
    };

    // Download the report
    const filename = `pr_diagnostic_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);

    if (runBtn) {
      runBtn.disabled = false;
      runBtn.textContent = `Run Diagnostic & Generate Report (last: ${pass}/${total} passed)`;
    }
    this.log('INFO', 'Diagnostic run complete', { pass, fail, total });
  }
};

// Initialize globally so other modules can use it
window.Diagnostics = Diagnostics;
Diagnostics.init();
