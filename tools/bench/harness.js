// In-page half of tools/longform_bench.mjs.
//
// Drives the REAL narration path in public/assets/js/audio_core.js with no app
// UI: resolveVoiceWithSentiment (the chapter emotion plan, the same call
// _playGeneratedAudio and the playback lookahead make), then generateChunk
// (prosody opts, worker dispatch, _inspectPocketAudioQuality, escalating
// retries, the prosody drift guard, the every-20-paragraph worker recycle), or
// generateChunkStream for the cold first paragraph exactly as live playback
// does on desktop. Nothing here re-implements any of that; it only sets the
// device state the app would have after first-run setup, stubs the UI
// callbacks, and records what the cores report.

const status = document.getElementById('bench-status');
const config = await (await fetch('/__bench__/config.json', { cache: 'no-store' })).json();

// ── Device state the app reads at import time ──────────────────────────────
// These are the app's own storage keys (pocket_backend_policy.js), written the
// way first-run device setup writes them, so the real backend plan resolves to
// threaded WASM at the requested thread count instead of being bypassed.
localStorage.setItem('pr_device_backend_preference_v1', 'wasm');
localStorage.setItem('pr_device_setup_v2', JSON.stringify({
  version: 2,
  completedAt: Date.now(),
  recommendedBackend: 'wasm',
  webgpuEligible: false,
  wasmThreads: config.threads,
  reason: 'longform bench: pinned threaded WASM',
}));
localStorage.setItem('pr_expressive_prosody_choice_v1', config.expressive ? 'enabled' : 'disabled');

window.userProfile = {
  settings: {
    voiceEngine: 'pocket',
    pocketVoice: config.voice,
    expressiveProsody: config.expressive,
    voiceEmotionMode: config.emotionMode,
    pronunciationOverrides: [],
    ...(config.seed ? { pocketVoiceSeed: config.seed } : {}),
  },
  library: [],
};
// In-memory engine override (engine_utils._resolveActiveEngine): forces the
// Pocket tier on this desktop instead of whatever the device policy picks.
window._pocketRuntimeEngineOverride = 'pocket';
window.currentStory = {
  title: config.storyTitle,
  storyKey: config.storyTitle,
  author: 'Pocket Reader bench',
  chapters: [{ title: config.chapterTitle, paragraphs: config.paragraphs }],
};
window.currentChapterIndex = 0;
window.currentParagraphIndex = 0;

// ── UI callbacks audio_core calls unguarded ────────────────────────────────
const noop = () => {};
window.triggerVirtue = noop;
window.virtueSpeak = noop;
window.updateReaderUIText = noop;
window.setControlsLocked = noop;
window.showSettingsModal = noop;
window.showToast = noop;

// ── Diagnostics capture ────────────────────────────────────────────────────
const logs = [];
function plain(value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, v) => {
      if (v instanceof Blob) return { blob: v.size };
      if (ArrayBuffer.isView(v)) return { typedArray: v.length };
      return v;
    }));
  } catch (_) {
    return String(value);
  }
}
window.Diagnostics = {
  log(level, message, data) {
    logs.push({ t: performance.now(), level, message: String(message), data: plain(data) });
  },
};
window.addEventListener('error', (event) => {
  logs.push({ t: performance.now(), level: 'PAGEERROR', message: String(event.message || event.error) });
});
window.addEventListener('unhandledrejection', (event) => {
  logs.push({ t: performance.now(), level: 'UNHANDLED', message: String(event.reason?.message || event.reason) });
});

// neuralState transitions, for engine-load timing.
const stateTrace = [];

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

let tokenizer = null;

window.__bench = {
  config,
  logs,
  stateTrace,
  async load() {
    const startedAt = performance.now();
    await import(config.specifiers.engineUtils);
    await import(config.specifiers.pronunciation);
    await import(config.specifiers.audioCore);
    let last = null;
    setInterval(() => {
      const state = window._neuralState?.();
      if (state !== last) {
        stateTrace.push({ t: performance.now(), state });
        last = state;
      }
    }, 50);
    status.textContent = 'cores loaded';
    return {
      importMs: Math.round(performance.now() - startedAt),
      crossOriginIsolated: window.crossOriginIsolated === true,
      hardwareConcurrency: navigator.hardwareConcurrency,
      userAgent: navigator.userAgent,
      engine: window._resolveActiveEngine?.(),
      expressiveEnabled: window.isPocketExpressiveProsodyEnabled?.(),
      deviceCapability: plain(window._pocketDeviceCapability),
    };
  },

  // One paragraph through the live path. `stream` mirrors a cold Play press on
  // desktop (_playGeneratedAudio -> generateChunkStream); everything after it is
  // what the playback lookahead does (generateChunk).
  async synth(index, { text: overrideText = null, stream = false, ctx = true } = {}) {
    const text = overrideText ?? config.paragraphs[index];
    const logStart = logs.length;
    const rawEmotion = plain(window.inspectPocketEmotion?.(text));
    const position = ctx ? { storyTitle: config.storyTitle, chapIdx: 0, paraIdx: index } : null;
    const routedVoice = window.resolveVoiceWithSentiment('pocket', config.voice, text, position);
    window.currentParagraphIndex = index;
    window._lastPocketSynthTelemetry = null;
    window._lastPocketQualityFailure = null;
    const startedAt = performance.now();
    let firstAudioAt = null;
    let segments = 0;
    let blob = null;
    let error = null;
    try {
      blob = stream
        ? await window.generateChunkStream(text, routedVoice, () => {
          segments += 1;
          if (firstAudioAt == null) firstAudioAt = performance.now();
        }, position)
        : await window.generateChunk(text, routedVoice, position);
    } catch (err) {
      error = String(err?.message || err);
    }
    const endedAt = performance.now();
    const heap = performance.memory ? performance.memory.usedJSHeapSize : null;
    return {
      index,
      text,
      routedVoice,
      rawEmotion,
      streamed: stream,
      startedAt,
      endedAt,
      wallMs: Math.round(endedAt - startedAt),
      firstAudioMs: firstAudioAt == null ? null : Math.round(firstAudioAt - startedAt),
      streamSegments: segments,
      bestEffort: blob?.pocketBestEffort === true,
      error,
      telemetry: plain(window._lastPocketSynthTelemetry),
      qualityFailure: plain(window._lastPocketQualityFailure),
      backend: plain({
        selectedBackend: window._pocketBackendRuntime?.selectedBackend,
        threadCount: window._pocketBackendRuntime?.threadCount,
        precision: window._pocketBackendRuntime?.precision,
        modelRevision: window._pocketBackendRuntime?.modelRevision,
      }),
      jsHeapBytes: heap,
      logs: logs.slice(logStart),
      wavBase64: blob ? await blobToBase64(blob) : null,
    };
  },

  normalize(text) {
    return window.normalizeForPocketTts(String(text || ''), { pronunciationOverrides: [] });
  },

  // Exact token counts with the SAME SentencePiece model and module the worker
  // loaded (URLs captured from the worker's own requests by the bench).
  async loadTokenizer(moduleUrl, modelUrl) {
    const source = await (await fetch(moduleUrl)).text();
    const moduleBlob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const sp = await import(moduleBlob);
    const model = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());
    let binary = '';
    for (let i = 0; i < model.length; i += 0x8000) binary += String.fromCharCode.apply(null, model.subarray(i, i + 0x8000));
    tokenizer = new sp.SentencePieceProcessor();
    await tokenizer.loadFromB64StringModel(btoa(binary));
    return true;
  },
  countTokens(texts) {
    if (!tokenizer) return null;
    return texts.map((text) => tokenizer.encodeIds(this.normalize(text).replace(/\s+/g, ' ').trim()).length);
  },
};

window.__benchReady = true;
status.textContent = 'ready';
