// pocket_worker.js — Pocket TTS WASM/ONNX worker with B2 streaming and chunk buffering
import {
  DEFAULT_POCKET_TEMPERATURE_PRESET,
  DEFAULT_POCKET_QUALITY_MODE,
  getPocketTuningPreset,
  normalizeForPocketTts,
} from './tts_pronunciation_core.js?v=pron-v11';
import {
  POCKET_ORT_VERSION,
  POCKET_CALIBRATION_VERSION,
  POCKET_ACCELERATION_VERSION,
  POCKET_WASM_MODEL_REVISION,
  POCKET_WEBGPU_MODEL_REVISION,
  POCKET_WEBGPU_BUNDLE,
  POCKET_GPU_RESIDENT_STATE_BYTES,
  normalizePocketBackend,
  recommendedWasmThreadCount,
  percentile,
  selectCalibratedBackend,
  selectWebGpuVariant,
  shouldDemoteWebGpuSustained,
  POCKET_WEBGPU_WASM_PARITY_RATIO,
} from './pocket_backend_policy.js?v=backend-v20';
import {
  POCKET_PERFORMANCE_POLICY_VERSION,
  computePocketFrameBudget,
} from './pocket_performance_policy.js?v=performance-v2';

console.log("Pocket TTS Worker Starting...");
self.postMessage({ type: "status", status: "Worker Thread Started", state: "idle" });

let ort = null;
let ortRuntimeFlavor = null;
let ortWasmRuntimeFlavor = 'unloaded';
let ortWasmModelFormat = 'onnx';
let runtimeThreadCount = 1;
let requestedWasmThreadCount = 0;
let wasmReferenceRtf = 0;
let measureWasmRtfSamples = 0;
let ortModuleSupportsWebGpu = false;
let currentBackend = 'wasm';
let requestedBackend = 'auto';
let currentModelPrecision = 'int8';
let currentModelRevision = POCKET_WASM_MODEL_REVISION;
let lastBackendTelemetry = null;
let gpuDeviceLost = false;
let gpuFailureCount = 0;
let webGpuSustainedHistory = [];
let activeGpuDevice = null;
let currentModelAssetBytes = {};
let currentModelDownloadTotalBytes = 1;

const DEFAULT_LANGUAGE = "english_2026-04";
const LANGUAGE_BUNDLES = ["english_2026-04", "german", "italian", "portuguese", "spanish"];
const MODEL_STEMS = {
  text_conditioner: "text_conditioner_int8.onnx",
  flow_lm_main: "flow_lm_main_int8.onnx",
  flow_lm_flow: "flow_lm_flow_int8.onnx",
  mimi_decoder: "mimi_decoder_int8.onnx",
};
const ORT_FORMAT_MODEL_STEMS = {
  text_conditioner: "text_conditioner_int8.ort",
  flow_lm_main: "flow_lm_main_int8.ort",
  flow_lm_flow: "flow_lm_flow_int8.ort",
  mimi_decoder: "mimi_decoder_int8.ort",
};
const WEBGPU_BLOCK_ROLE = 'flow_lm_decode_block4';
const WEBGPU_BLOCK_FRAMES = 4;
const WEBGPU_STEADY_SYNC_BLOCKS = 4;
const WEBGPU_GRAPH_CAPTURE_SUPPORTED = false;
const WEBGPU_MIMI_ROLE = 'mimi_decoder_fp16';
const MODEL_ASSET_BYTES = {
  text_conditioner: 16388384,
  flow_lm_main: 76341079,
  flow_lm_flow: 9962530,
  mimi_decoder: 22684077,
  flow_lm_unified_block4: 87264376,
};
const ORT_FORMAT_MODEL_ASSET_BYTES = {
  text_conditioner: 16389816,
  flow_lm_main: 76425184,
  flow_lm_flow: 9998008,
  mimi_decoder: 22713584,
  flow_lm_decode_block4: 87522240,
  flow_lm_unified_block4: 87264376,
};
const MODEL_DOWNLOAD_TOTAL_BYTES = Object.values(MODEL_ASSET_BYTES).reduce((sum, size) => sum + size, 0);
const METADATA_TIMEOUT_MS = 30000;
const MODULE_TIMEOUT_MS = 45000;
const MODEL_STALL_TIMEOUT_MS = 60000;
const SESSION_CREATE_TIMEOUT_MS = 5 * 60 * 1000;
const DEBUG_LOGS = false;
const LOAD_BUNDLED_VOICE_BIN = false;
const CHUNK_GAP_SEC = 0.25;
// Per-chunk generation ceiling. Pocket emits 80 ms/frame, so 600 frames = 48 s.
// Raised from 500 (40 s) 2026-07-17: long/dense chunks near the token cap were
// hitting the 40 s ceiling before EOS, clipping the last word or two. Only the
// LONGEST chunks are affected (short clauses get a small budget from
// computePocketFrameBudget); legitimate chunks would generate these frames
// anyway, so peak memory rises only on a genuine missed-EOS runaway.
const MAX_FRAMES = 600;
// The autoregressive KV cache grows every frame, so the per-chunk ceiling is
// the dominant driver of peak WASM heap. On memory-safe/constrained devices
// (iPhone 13 etc., where the jetsam limit is low) the 600-frame ceiling pushed
// long cache jobs into OOM crashes, so cap those devices back at 500 (40 s) —
// still comfortably above a typical chunk's real length. Full-memory desktops
// keep the higher ceiling for the rare very-long chunk.
const CONSTRAINED_MAX_FRAMES = 500;
const DEFAULT_LSD_STEPS = 1;
const BENCHMARK_QUALITY_LSD_STEPS = 4;
const RESET_FLOW_STATE_EACH_CHUNK = true;
const RESET_MIMI_STATE_EACH_CHUNK = true;
const MIN_FRAMES_AFTER_EOS = 3;
const SHORT_TEXT_FRAMES_AFTER_EOS = 4;

// ── Expressive narration (Pocket-only, opt-in) ───────────────────────────────
// Baseline sampling temperature used when expressive steering is OFF. Keeping it
// as a named constant lets the per-chunk prosody path fall back to exact current
// behaviour. std for the latent noise is sqrt(temp), as in the original loop.
const BASE_TEMP = getPocketTuningPreset(DEFAULT_POCKET_TEMPERATURE_PRESET).temperature;

// Heuristic emotion → generation-parameter map. Mirrors the EmoTTS prosody-steering
// idea (kyutai-labs/pocket-tts#194) but uses only the two knobs this engine already
// exposes with zero structural/perf change: sampling `temp` and an optional
// `noiseClamp` on the gaussian latent (in units of std).
// TAMED 2026-07-17: the old wide temp band ([0.56, 0.90]) plus per-emotion
// noiseClamp swings shifted the perceived pitch/voice-character sentence to
// sentence ("a much higher or lower pitched voice"). Narrowed to a gentle
// [0.66, 0.76] band around neutral (0.70) and dropped ALL noiseClamp (the latent
// clamp was the main character-shifter). Expression now comes from small temp
// nudges + the EOS tail (eosBonus), not from pitch/character jumps.
// eosBonus: frames added to (or subtracted from) the post-EOS tail when
// expressive mode is on. Negative = snap off sooner (high-energy emotions);
// positive = let it settle (quiet/fearful emotions). Applied in pushChunk.
const EMOTION_PROSODY = {
  neutral:  { temp: 0.60, noiseClamp: null, eosBonus:  0 },
  joy:      { temp: 0.62, noiseClamp: null, eosBonus: -1 },
  anger:    { temp: 0.63, noiseClamp: null, eosBonus: -1 },
  sadness:  { temp: 0.58, noiseClamp: null, eosBonus:  1 },
  fear:     { temp: 0.61, noiseClamp: null, eosBonus:  1 },
  surprise: { temp: 0.62, noiseClamp: null, eosBonus: -1 },
};

let currentSeed = 42;
function seedRandom(seedStr) {
  let h = 0xdeadbeef;
  for(let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 2654435761);
  }
  currentSeed = ((h ^ h >>> 16) >>> 0);
  if (currentSeed === 0) currentSeed = 42;
}
function seededRandom() {
  currentSeed = (currentSeed * 1664525 + 1013904223) >>> 0;
  return currentSeed / 4294967296;
}

// Per-punctuation pause lengths (seconds) used when punctuation pauses are ON.
// When OFF, inter-chunk spacing stays at CHUNK_GAP_SEC to preserve current output.
const PUNCT_PAUSE_SEC = {
  '.': 0.38, '!': 0.42, '?': 0.42, '\u2026': 0.60,
  ',': 0.18, ';': 0.26, ':': 0.26, '\u2014': 0.28,
};

function clampPocketTemperature(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return BASE_TEMP;
  return Math.max(0.5, Math.min(0.95, n));
}

function resolveWorkerTuning(opts = {}) {
  const emotionMode = typeof opts.emotionMode === "string" ? opts.emotionMode : "balanced";
  const presetName = typeof opts.temperaturePreset === "string" ? opts.temperaturePreset : DEFAULT_POCKET_TEMPERATURE_PRESET;
  const preset = getPocketTuningPreset(presetName, emotionMode);
  const qualityMode = opts.qualityMode === "quality" ? "quality" : DEFAULT_POCKET_QUALITY_MODE;
  const allowQualityLsd = qualityMode === "quality" && opts.allowBenchmarkQuality === true;
  return {
    temperaturePreset: preset.name,
    qualityMode,
    temperature: clampPocketTemperature(opts.temperature != null ? opts.temperature : preset.temperature),
    lsdSteps: allowQualityLsd ? BENCHMARK_QUALITY_LSD_STEPS : DEFAULT_LSD_STEPS,
  };
}

// Inline pause tag: [1.2s] / [10s] / [0.5s]. Clamped to [0.05, 30] seconds so a
// stray bracketed token can never inject a minutes-long silence.
const PAUSE_TAG_RE = /\[(\d+(?:\.\d+)?)\s*s\]/gi;
const PAUSE_TAG_MIN = 0.05;
const PAUSE_TAG_MAX = 30;

// Soft ceiling on tokens per Pocket chunk. The ONNX model accepts up to
// currentMaxTokenPerChunk (200). Older 75-token soft caps over-split story
// prose and made phones pay a full prefill tax per fragment. Bumped to 120
// (from 110) 2026-07-17 so long paragraphs form fewer, more natural chunks;
// kept modest on purpose — the cap also bounds continuous latent drift within a
// chunk (raising it too far trades voice stability for fewer splits).
// Throughput/cache mode may raise it further.
const POCKET_TOKEN_SOFT_CAP = 120;
const POCKET_THROUGHPUT_TOKEN_SOFT_CAP = 176;

// Lexicon for the zero-dependency emotion heuristic. Small, prose-oriented word
// sets; matched on word boundaries and combined with punctuation/caps signals.
const EMOTION_LEXICON = {
  joy:      ['happy', 'happi', 'joy', 'laugh', 'smil', 'grin', 'delight', 'glad', 'cheer', 'love', 'wonderful', 'excit', 'thrill', 'beam', 'giggl', 'hug', 'warm', 'bright'],
  anger:    ['angry', 'anger', 'furious', 'rage', 'snarl', 'growl', 'shout', 'yell', 'hate', 'scream', 'snap', 'glare', 'seeth', 'roar', 'damn', 'curs', 'slam', 'fist', 'spat'],
  sadness:  ['sad', 'cry', 'cried', 'tear', 'weep', 'wept', 'sob', 'sorrow', 'grief', 'lonely', 'alone', 'ache', 'mourn', 'despair', 'empty', 'hollow', 'broken', 'sigh', 'quiet'],
  fear:     ['afraid', 'fear', 'terror', 'scared', 'scream', 'panic', 'tremble', 'shiver', 'dread', 'horror', 'frighten', 'shudder', 'froze', 'nervous', 'anxious', 'gasp'],
  surprise: ['suddenly', 'gasp', 'startl', 'shock', 'surprise', 'wide-eyed', 'whirl', 'stunned', 'abrupt', 'jolt', 'flinch'],
};

const PROXY_BASE_URL = self.PR_PROXY_BASE || 'https://pocket-reader-proxy.christopher-gotham67.workers.dev';
const MODEL_BASE_URL = `${PROXY_BASE_URL}/models/`;
const B2_DIRECT_BASE_URL = 'https://f005.backblazeb2.com/file/pocket-reader-assets';
const SENTENCEPIECE_MODULE_VERSION = "sp-1371cb5e";
const POCKET_ORT_WASM_RUNTIME_VERSION = '1.27.0-wasm';
const POCKET_ORT_RELAXED_RUNTIME_VERSION = '1.27.0-relaxed';
const POCKET_ORT_MINIMAL_RUNTIME_VERSION = '1.27.0-relaxed-minimal';
const POCKET_ORT_FORMAT_BUNDLE = 'english_2026-04-ort-r1';
const PINNED_MODULE_SHA256 = Object.freeze({
  sentencepiece: '1371cb5e2ee08c7faca8ad53f7cad5a5c41759530f6ade52156dbd8c13059860',
  ortCustomWasm: '9608e98a3fba9716f0cbd0bca0c94808b71dae2e9265ca3fe742ddc393a53ebc',
  ortStandard: 'a4c72a154c44d09c71996c7c5a3c4bd6fe3dfe27095dc766cdb6726775161931',
  ortWebGpu: '46988a5a025f49449850f39f95eb0d21e40e67b3beb13a0b54efd3ab5d83f60e',
});
const RELAXED_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
  10, 19, 1, 17, 0, 65, 1, 253, 15, 65, 2, 253, 15, 65, 3, 253, 15,
  253, 147, 2, 11,
]);

function proxifyUrl(url) {
  if (url && url.includes('f005.backblazeb2.com/file/pocket-reader-assets')) {
    return url.replace('https://f005.backblazeb2.com/file/pocket-reader-assets', `${PROXY_BASE_URL}/models`);
  }
  return url;
}

function pinnedModuleDigest(url) {
  const value = String(url);
  if (value.includes('sentencepiece.js')) return PINNED_MODULE_SHA256.sentencepiece;
  if (value.includes('ort.webgpu.min.mjs')) return PINNED_MODULE_SHA256.ortWebGpu;
  if (
    value.includes(`/${POCKET_ORT_WASM_RUNTIME_VERSION}/`)
    || value.includes(`/${POCKET_ORT_RELAXED_RUNTIME_VERSION}/`)
    || value.includes(`/${POCKET_ORT_MINIMAL_RUNTIME_VERSION}/`)
  ) {
    return PINNED_MODULE_SHA256.ortCustomWasm;
  }
  if (value.includes('onnxruntime-web@1.27.0/dist/ort.min.mjs')
      || value.includes('/onnxruntime/1.27.0/ort.min.mjs')) {
    return PINNED_MODULE_SHA256.ortStandard;
  }
  throw new Error(`No pinned module digest is registered for ${value}`);
}

async function importVerifiedModule(url, label = 'runtime module') {
  const response = await fetchWithTimeout(url, { cache: 'force-cache' }, MODULE_TIMEOUT_MS);
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  const source = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const expected = pinnedModuleDigest(url);
  if (actual !== expected) {
    throw new Error(`${label} failed its pinned SHA-256 integrity check`);
  }
  const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    return await withTimeout(import(objectUrl), MODULE_TIMEOUT_MS, `${label} evaluation`);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

let currentLanguage = DEFAULT_LANGUAGE;
let currentBundleDir = null;
let bundleMetadata = null;
let tokenizerProcessor = null;
let tokenizerModelB64 = null;
let bosBeforeVoice = null;

// Base64-encode a byte buffer without spreading it as function arguments.
// `String.fromCharCode(...bytes)` / `.apply(null, bytes)` pass every byte as a
// separate argument; once the buffer exceeds the engine's argument limit this
// overflows the call stack on Safari/JavaScriptCore (RangeError: Maximum call
// stack size exceeded) while surviving on V8 — the exact failure seen loading
// the tokenizer during Pocket worker init on iPhone. Chunked conversion keeps
// the per-call argument count bounded on every engine.
function uint8ArrayToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000; // 32 KiB per call — safely under every engine's arg limit
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}
let webGpuBosSequence = null;
let webGpuBundleMetadata = null;
let webGpuGraphCaptureEnabled = false;
let gpuSyncGroupBlocks = WEBGPU_STEADY_SYNC_BLOCKS;
let currentMimiProvider = 'wasm-threaded';
let useOrtFormatWasm = false;

let textConditionerSession = null;
let flowLmMainSession = null;
let flowLmFlowSession = null;
let flowLmDecodeBlockSession = null;
let flowLmUnifiedSession = null;
let mimiDecoderSession = null;
// Optional WASM/INT8 four-frame decode block (flow_lm_decode_block4_int8).
// When present it replaces the per-frame AR loop, quartering the ~47MB
// JS<->WASM state round-trip per frame. Missing/failed loads fall back to the
// per-frame path silently, so the runtime works before/without the B2 upload.
let flowLmWasmBlockSession = null;
let wasmBlockBosSequence = null;
const WASM_BLOCK_FILE = 'flow_lm_decode_block4_int8.onnx';
const WASM_BLOCK_ORT_FILE = 'flow_lm_decode_block4_int8.ort';
const WASM_UNIFIED_BLOCK_FILE = 'flow_lm_unified_block4_int8.onnx';
const WASM_UNIFIED_BLOCK_ORT_FILE = 'flow_lm_unified_block4_int8.ort';
const WASM_BLOCK_BOS_FILE = 'flow_lm_bos.npy';
const WASM_BLOCK_FRAMES = 4;
let wasmUnifiedPrefillMode = null;
let wasmUnifiedDecodeMode = null;
let wasmUnifiedZeroRandom = null;
let wasmUnifiedBosTensor = null;

let currentSampleRate = 24000;
let currentSamplesPerFrame = 1920;
let currentLatentDim = 32;
let currentConditioningDim = 1024;
let currentMaxTokenPerChunk = 200;

let predefinedVoiceRecords = {};
let customVoiceStates = new Map();
let currentVoiceName = null;
let voiceConditioningCache = new Map();
const MAX_CONSTRAINED_CUSTOM_VOICES = 2;
let constrainedMemoryMode = false;

let stTensors = [];
let stTensorCache = new Map();
// Mutual-exclusion flag: true from the moment startGeneration begins until its
// finally. The ONNX sessions and Mimi state are module-level singletons, so two
// generations must never overlap. Cancellation therefore sets cancelRequested
// (below) instead of clearing this — clearing it mid-run let
// processGenerationQueue start a second generation on top of the first.
let isGenerating = false;
// Cooperative stop signal. The chunk/frame loops poll it and unwind cleanly.
let cancelRequested = false;
let isReady = false;

function generationShouldContinue() {
  return isGenerating && !cancelRequested;
}

function activeBundleName(language, backend = currentBackend) {
  return backend === 'webgpu' && language === DEFAULT_LANGUAGE ? POCKET_WEBGPU_BUNDLE : language;
}

function bundleDir(language, backend = currentBackend) {
  return `${MODEL_BASE_URL}Pocket%20TTS%20Onnx/${activeBundleName(language, backend)}`;
}

function bundlePath(language, filename, backend = currentBackend) {
  return `${bundleDir(language, backend)}/${filename}`;
}

function directBundlePath(language, filename, backend = currentBackend) {
  return `${B2_DIRECT_BASE_URL}/onnx/${activeBundleName(language, backend)}/${filename}`;
}

function wasmModelFilename(role) {
  return useOrtFormatWasm ? ORT_FORMAT_MODEL_STEMS[role] : MODEL_STEMS[role];
}

function wasmBlockFilename(unified = false) {
  if (unified) return useOrtFormatWasm ? WASM_UNIFIED_BLOCK_ORT_FILE : WASM_UNIFIED_BLOCK_FILE;
  return useOrtFormatWasm ? WASM_BLOCK_ORT_FILE : WASM_BLOCK_FILE;
}

function wasmModelPaths(language, filename) {
  const bundle = useOrtFormatWasm && filename.endsWith('.ort')
    ? POCKET_ORT_FORMAT_BUNDLE
    : language;
  return [
    `${MODEL_BASE_URL}Pocket%20TTS%20Onnx/${bundle}/${filename}`,
    `${B2_DIRECT_BASE_URL}/onnx/${bundle}/${filename}`,
  ];
}

// Mobile networks fail transiently far more often than they fail persistently: a
// tunnel, a cell handoff or a lift drops a few seconds of connectivity. Host
// failover alone does not survive that, because both hosts are unreachable
// through the same gap -- one blip used to fail the whole model load and surface
// as "narration won't start". So each pass tries every host, and a pass whose
// failures were all transient is retried after a short backoff.
//
// A 404/403 is not transient: the asset is genuinely absent from that host, so
// failing over is right and retrying only wastes time on a slow connection.
const MODEL_FETCH_PASSES = 3;
const MODEL_FETCH_BACKOFF_MS = [400, 1200];

function isTransientFetchFailure(status) {
  // No status means a network error or timeout, which is the common mobile case.
  if (!status) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function fetchFirstAvailable(urls, options = {}, timeoutMs = METADATA_TIMEOUT_MS) {
  let lastError = null;

  for (let pass = 0; pass < MODEL_FETCH_PASSES; pass += 1) {
    let sawTransientFailure = false;

    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index];
      let status = 0;
      try {
        const response = await fetchWithTimeout(url, options, timeoutMs);
        if (response.ok) return response;
        status = response.status;
        lastError = new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
      } catch (error) {
        lastError = error;
      }
      if (isTransientFetchFailure(status)) sawTransientFailure = true;
      if (index < urls.length - 1) {
        postMessage({
          type: "diagnostic",
          level: "WARN",
          message: `Model host unavailable; trying fallback (${lastError?.message || lastError})`,
        });
      }
    }

    // Every host answered definitively (404/403). Another pass cannot help.
    if (!sawTransientFailure) break;
    if (pass < MODEL_FETCH_PASSES - 1) {
      const backoff = MODEL_FETCH_BACKOFF_MS[pass] ?? MODEL_FETCH_BACKOFF_MS[MODEL_FETCH_BACKOFF_MS.length - 1];
      postMessage({
        type: "diagnostic",
        level: "WARN",
        message: `All model hosts failed transiently; retrying in ${backoff}ms (${lastError?.message || lastError})`,
      });
      await delay(backoff);
    }
  }

  throw lastError || new Error("No model asset host was available");
}

function debugLog(...args) {
  if (DEBUG_LOGS) {
    console.log(...args);
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = METADATA_TIMEOUT_MS) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timerId);
  }
}

// ── Durable model cache (groundwork) ─────────────────────────────────────────
// Voices already get a CacheStorage layer (audio_core's 'pocket-voices'), but
// the ONNX bundles and the ORT WASM runtime -- the ~80 MB the settings screen
// warns about -- currently rely only on the HTTP cache plus the proxy's
// `max-age=31536000, immutable`. iOS Safari evicts its HTTP cache far more
// aggressively than Chrome or Firefox, so an iPhone can be made to re-download
// the whole engine over cellular repeatedly. CacheStorage is not evicted on the
// same terms and is the durable home for these bytes.
//
// The name deliberately contains BOTH substrings that the rest of the app keys
// on, and `tests/mobile_engine_reliability.test.mjs` pins that contract:
//   * 'onnx'   -> sw.js `activate` preserves it across every shell upgrade,
//                 so a version bump never re-downloads the engine.
//   * 'pocket' -> settings_manager's clearNeuralEngineCache still deletes it,
//                 so the user-facing "free up space" button keeps working.
const POCKET_MODEL_CACHE = 'pocket-onnx-models-v1';

let modelCachePromise;

// Returns null rather than throwing when CacheStorage is unavailable: iOS
// private browsing rejects caches.open() with a SecurityError, and a durable
// cache is an optimization -- never a prerequisite for narration working.
function openModelCache() {
  if (modelCachePromise !== undefined) return modelCachePromise;
  modelCachePromise = (async () => {
    try {
      if (typeof caches === 'undefined') return null;
      return await caches.open(POCKET_MODEL_CACHE);
    } catch (error) {
      postMessage({
        type: 'diagnostic',
        level: 'INFO',
        message: `Model CacheStorage unavailable; using HTTP cache instead (${error?.name || error})`,
      });
      return null;
    }
  })();
  return modelCachePromise;
}

async function readCachedModelBuffer(url) {
  try {
    const cache = await openModelCache();
    if (!cache) return null;
    const hit = await cache.match(url);
    if (!hit?.ok) return null;
    return await hit.arrayBuffer();
  } catch (error) {
    postMessage({
      type: 'diagnostic',
      level: 'WARN',
      message: `Model cache read failed; refetching (${error?.message || error})`,
    });
    return null;
  }
}

// Never fatal. A full device (QuotaExceededError) must not turn a model that
// downloaded successfully into a failed narration start.
async function writeCachedModelBuffer(url, buffer, contentType = 'application/octet-stream') {
  try {
    const cache = await openModelCache();
    if (!cache) return false;
    await cache.put(url, new Response(buffer, { headers: { 'Content-Type': contentType } }));
    return true;
  } catch (error) {
    postMessage({
      type: 'diagnostic',
      level: 'WARN',
      message: `Model cache write skipped (${error?.name || error?.message || error})`,
    });
    return false;
  }
}

// The same asset is reachable through two hosts -- the Cloudflare proxy and B2
// direct -- and which one answers is a network accident. Keying the cache on the
// raw URL would store the engine twice and miss on the alternate host, so both
// forms collapse onto the canonical B2 URL. This is the exact inverse of
// proxifyUrl().
const B2_ASSET_PREFIX = 'https://f005.backblazeb2.com/file/pocket-reader-assets';

function canonicalModelCacheKey(url) {
  const value = String(url);
  const proxyPrefix = `${PROXY_BASE_URL}/models`;
  if (value.startsWith(proxyPrefix)) return value.replace(proxyPrefix, B2_ASSET_PREFIX);
  return value;
}

// NOTE ON INTEGRITY: model weights carry no pinned digest and never have --
// pinnedModuleDigest() throws for them by design. The SHA-256 pinning covers
// only executable JS (the ORT runtime and sentencepiece) loaded through
// importVerifiedModule, which is a completely separate path. So caching weights
// bypasses no integrity check. CacheStorage is origin-scoped and only this
// worker writes it, meaning the realistic risk is corruption rather than
// tampering; that is addressed by refusing to store a short read below, not by
// re-hashing 80 MB on every cold start (which would cost mobile users the very
// startup time this cache exists to save).
async function fetchSingleModelWithProgress(url, asset, completedBytes) {
  const cacheKey = canonicalModelCacheKey(url);
  const controller = new AbortController();
  let stallTimerId;
  const resetStallTimer = () => {
    clearTimeout(stallTimerId);
    stallTimerId = setTimeout(() => controller.abort(), MODEL_STALL_TIMEOUT_MS);
  };

  resetStallTimer();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to download ${asset}: HTTP ${response.status}`);
    }

    const expectedAssetBytes = Number(response.headers.get("Content-Length")) || currentModelAssetBytes[asset] || MODEL_ASSET_BYTES[asset] || 0;
    if (!response.body?.getReader) {
      const buffer = await response.arrayBuffer();
      const loadedBytes = completedBytes + buffer.byteLength;
      postMessage({
        type: "progress",
        info: {
          status: "progress",
          progress: 30 + (40 * loadedBytes / currentModelDownloadTotalBytes),
          loadedBytes,
          totalBytes: currentModelDownloadTotalBytes,
          asset,
        },
      });
      // arrayBuffer() resolves only for a fully received body, so this is safe
      // to persist without a further length check.
      await writeCachedModelBuffer(cacheKey, buffer);
      return buffer;
    }

    const reader = response.body.getReader();
    // Allocate once when the server supplies a length. The previous chunk-list
    // implementation briefly held both the chunks and a second assembled copy,
    // adding roughly 76 MiB of avoidable peak memory for the largest model.
    let output = expectedAssetBytes > 0 ? new Uint8Array(expectedAssetBytes) : null;
    const chunks = output ? null : [];
    let assetLoadedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetStallTimer();
      if (output) {
        if (assetLoadedBytes + value.byteLength > output.byteLength) {
          throw new Error(`${asset} exceeded its declared Content-Length`);
        }
        output.set(value, assetLoadedBytes);
      } else {
        chunks.push(value);
      }
      assetLoadedBytes += value.byteLength;
      const loadedBytes = completedBytes + assetLoadedBytes;
      postMessage({
        type: "progress",
        info: {
          status: "progress",
          progress: Math.min(69.9, 30 + (40 * loadedBytes / currentModelDownloadTotalBytes)),
          loadedBytes,
          totalBytes: currentModelDownloadTotalBytes,
          asset,
          assetLoadedBytes,
          assetTotalBytes: expectedAssetBytes,
        },
      });
    }

    if (output) {
      if (assetLoadedBytes === output.byteLength) {
        await writeCachedModelBuffer(cacheKey, output.buffer);
        return output.buffer;
      }
      // The server declared a Content-Length and then delivered fewer bytes.
      // The buffer is still returned (existing behaviour), but a short read must
      // never be persisted: a truncated model cached as authoritative would fail
      // on every subsequent cold start with no network involved to self-heal.
      postMessage({
        type: 'diagnostic',
        level: 'WARN',
        message: `${asset} delivered ${assetLoadedBytes} of ${output.byteLength} declared bytes; not caching`,
      });
      return output.slice(0, assetLoadedBytes).buffer;
    }

    output = new Uint8Array(assetLoadedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // No Content-Length was advertised, so "complete" means the stream ended
    // cleanly (done === true) rather than a length match. A stall aborts before
    // reaching here.
    await writeCachedModelBuffer(cacheKey, output.buffer);
    return output.buffer;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${asset} download stalled for ${Math.round(MODEL_STALL_TIMEOUT_MS / 1000)} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(stallTimerId);
  }
}

async function fetchModelWithProgress(urls, asset, completedBytes) {
  // Read once per asset, not once per host: both candidate URLs collapse to the
  // same canonical key, so a second lookup could only repeat the same answer.
  const cached = urls.length ? await readCachedModelBuffer(canonicalModelCacheKey(urls[0])) : null;
  if (cached) {
    const loadedBytes = completedBytes + cached.byteLength;
    // Advance the bar exactly as a completed download would, so a cache hit is
    // indistinguishable from a fast network rather than looking like a stall.
    postMessage({
      type: "progress",
      info: {
        status: "progress",
        progress: Math.min(69.9, 30 + (40 * loadedBytes / currentModelDownloadTotalBytes)),
        loadedBytes,
        totalBytes: currentModelDownloadTotalBytes,
        asset,
        assetLoadedBytes: cached.byteLength,
        assetTotalBytes: cached.byteLength,
        fromCache: true,
      },
    });
    postMessage({
      type: "diagnostic",
      level: "INFO",
      message: `${asset} served from the durable model cache (${cached.byteLength} bytes)`,
    });
    return cached;
  }

  let lastError = null;
  for (let index = 0; index < urls.length; index += 1) {
    try {
      return await fetchSingleModelWithProgress(urls[index], asset, completedBytes);
    } catch (error) {
      lastError = error;
      if (index < urls.length - 1) {
        postMessage({
          type: "diagnostic",
          level: "WARN",
          message: `${asset} failed on the primary host; trying direct B2 (${error?.message || error})`,
        });
      }
    }
  }
  throw lastError || new Error(`Unable to download ${asset}`);
}

function makeFilledArray(shape, dtype, fill) {
  const size = shape.reduce((a, b) => a * b, 1);
  let data;

  if (dtype === "int64") {
    data = new BigInt64Array(size);
  } else if (dtype === "bool") {
    data = new Uint8Array(size);
  } else {
    data = new Float32Array(size);
    if (fill === "nan") {
      data.fill(NaN);
    } else if (fill === "ones") {
      data.fill(1);
    }
  }

  return data;
}

function createTensor(dtype, data, dims) {
  return new ort.Tensor(dtype, data, dims);
}

function initStateFromManifest(manifest) {
  const state = {};
  for (const entry of manifest) {
    state[entry.input_name] = createTensor(
      entry.dtype,
      makeFilledArray(entry.shape, entry.dtype, entry.fill),
      entry.shape
    );
  }
  return state;
}

function cloneState(state) {
  if (!state) return state;
  const cloned = {};
  for (const key of Object.keys(state)) {
    const tensor = state[key];
    if (tensor && tensor.data && tensor.type && tensor.dims && typeof tensor.data.slice === 'function') {
      cloned[key] = new ort.Tensor(tensor.type, tensor.data.slice(), tensor.dims.slice());
    } else {
      cloned[key] = tensor;
    }
  }
  return cloned;
}

function disposeTensor(tensor) {
  if (!tensor || typeof tensor.dispose !== 'function') return;
  try { tensor.dispose(); } catch (_) {}
}

async function readTensorData(tensor) {
  if (!tensor) throw new Error('Missing inference tensor output.');
  if (typeof tensor.getData === 'function') return tensor.getData();
  return tensor.data;
}

function disposeGpuState(state, protectedTensors = null) {
  if (!state) return;
  const seen = new Set();
  for (const tensor of Object.values(state)) {
    if (!tensor || seen.has(tensor) || protectedTensors?.has(tensor)) continue;
    seen.add(tensor);
    disposeTensor(tensor);
  }
}

function touchCustomVoice(voiceName) {
  if (!customVoiceStates.has(voiceName)) return;
  const state = customVoiceStates.get(voiceName);
  customVoiceStates.delete(voiceName);
  customVoiceStates.set(voiceName, state);
}

function evictConstrainedCustomVoices(protectedVoice = null) {
  if (!constrainedMemoryMode) return;
  while (customVoiceStates.size > MAX_CONSTRAINED_CUSTOM_VOICES) {
    const voiceName = [...customVoiceStates.keys()].find((name) => name !== protectedVoice);
    if (!voiceName) return;
    disposeGpuState(voiceConditioningCache.get(voiceName));
    voiceConditioningCache.delete(voiceName);
    customVoiceStates.delete(voiceName);
    postMessage({ type: 'voice_evicted', voiceName });
  }
}

function updateStateFromManifestOutputs(state, result, manifest, protectedTensors = null) {
  for (const entry of manifest) {
    const next = result[entry.output_name];
    if (!next) continue;
    const previous = state[entry.input_name];
    if (previous && previous !== next && !protectedTensors?.has(previous)) disposeTensor(previous);
    state[entry.input_name] = next;
  }
}

function stateOutputNames(manifest) {
  return new Set((manifest || []).map((entry) => entry.output_name));
}

function disposeUnownedOutputs(result, ownedNames = new Set()) {
  for (const [name, tensor] of Object.entries(result || {})) {
    if (!ownedNames.has(name)) disposeTensor(tensor);
  }
}

function hasNonZeroShape(shape) {
  return Array.isArray(shape) && shape.length > 0 && shape.every((value) => Number(value) > 0);
}

function preferredStateOutputLocations(manifest, extraGpuOutputs = []) {
  const locations = {};
  for (const entry of manifest || []) {
    locations[entry.output_name] = entry.dtype === 'float32' && hasNonZeroShape(entry.shape)
      ? 'gpu-buffer'
      : 'cpu';
  }
  extraGpuOutputs.forEach((name) => { locations[name] = 'gpu-buffer'; });
  return locations;
}

function groupVoiceRecordByModule(record) {
  const grouped = {};
  for (const [key, value] of Object.entries(record)) {
    const slash = key.indexOf("/");
    if (slash === -1) continue;
    const moduleName = key.slice(0, slash);
    const tensorKey = key.slice(slash + 1);
    if (!grouped[moduleName]) {
      grouped[moduleName] = {};
    }
    grouped[moduleName][tensorKey] = value;
  }
  return grouped;
}

function adaptTypedArray(source, entry) {
  const targetShape = entry.shape;
  const targetSize = targetShape.reduce((a, b) => a * b, 1);
  const target = makeFilledArray(targetShape, entry.dtype, entry.fill);

  if (source.shape.length === targetShape.length) {
    const exactShape = source.shape.every((dim, idx) => dim === targetShape[idx]);
    if (exactShape) {
      if (entry.dtype === "int64") {
        return new BigInt64Array(source.data);
      }
      if (entry.dtype === "bool") {
        return new Uint8Array(source.data);
      }
      return new Float32Array(source.data);
    }
  }

  if (source.data.length === targetSize) {
    if (entry.dtype === "int64") {
      return new BigInt64Array(source.data);
    }
    if (entry.dtype === "bool") {
      return new Uint8Array(source.data);
    }
    return new Float32Array(source.data);
  }

  if (source.shape.length !== targetShape.length) {
    return target;
  }

  const strides = [];
  let stride = 1;
  for (let i = source.shape.length - 1; i >= 0; i--) {
    strides[i] = stride;
    stride *= source.shape[i];
  }

  const indices = new Array(source.shape.length).fill(0);
  const maxIndices = source.shape.map((dim, idx) => Math.min(dim, targetShape[idx]));

  function targetIndex(coords) {
    let idx = 0;
    let tStride = 1;
    for (let i = targetShape.length - 1; i >= 0; i--) {
      idx += coords[i] * tStride;
      tStride *= targetShape[i];
    }
    return idx;
  }

  let done = false;
  while (!done) {
    let sourceIdx = 0;
    for (let i = 0; i < indices.length; i++) {
      sourceIdx += indices[i] * strides[i];
    }
    target[targetIndex(indices)] = source.data[sourceIdx];

    for (let dim = indices.length - 1; dim >= 0; dim--) {
      indices[dim] += 1;
      if (indices[dim] < maxIndices[dim]) {
        break;
      }
      indices[dim] = 0;
      if (dim === 0) {
        done = true;
      }
    }
  }

  return target;
}

function deriveStep(moduleState) {
  if (moduleState.step) {
    return { data: BigInt64Array.from([BigInt(moduleState.step.data[0])]), shape: [1], dtype: "int64" };
  }
  if (moduleState.offset && !moduleState.end_offset) {
    return { data: BigInt64Array.from([BigInt(moduleState.offset.data[0])]), shape: [1], dtype: "int64" };
  }
  if (moduleState.current_end) {
    return { data: BigInt64Array.from([BigInt(moduleState.current_end.shape[0])]), shape: [1], dtype: "int64" };
  }
  return { data: BigInt64Array.from([0n]), shape: [1], dtype: "int64" };
}

function stateFromVoiceRecord(record) {
  const grouped = groupVoiceRecordByModule(record);
  const state = initStateFromManifest(bundleMetadata.flow_lm_state_manifest);

  for (const entry of bundleMetadata.flow_lm_state_manifest) {
    const moduleState = grouped[entry.module] || {};
    let source = moduleState[entry.key];
    if (!source && entry.key === "step") {
      source = deriveStep(moduleState);
    }
    if (!source) {
      continue;
    }

    const data = adaptTypedArray(source, entry);
    state[entry.input_name] = createTensor(entry.dtype, data, entry.shape);
  }

  return state;
}

async function ensurePredefinedVoiceCached(voiceName, options = {}) {
  const { force = false, statusText = "Preparing voice..." } = options;
  if (!predefinedVoiceRecords[voiceName]) {
    throw new Error(`Unknown built-in voice: ${voiceName}`);
  }

  if (!force && voiceConditioningCache.has(voiceName)) {
    return voiceConditioningCache.get(voiceName);
  }

  if (!isGenerating) {
    postMessage({ type: "status", status: statusText, state: "loading" });
  }
  const conditioned = stateFromVoiceRecord(predefinedVoiceRecords[voiceName]);
  voiceConditioningCache.set(voiceName, conditioned);
  return conditioned;
}

async function ensureCustomVoiceCached(voiceName, options = {}) {
  const { force = false, statusText = "Preparing custom voice..." } = options;
  let key = String(voiceName || "").trim();
  if (key === "custom" && customVoiceStates.size === 1) {
    key = customVoiceStates.keys().next().value;
  }
  if (!key || !customVoiceStates.has(key)) {
    throw new Error(`No custom voice loaded for '${key || "unknown"}'.`);
  }
  touchCustomVoice(key);

  if (!force && voiceConditioningCache.has(key)) {
    return voiceConditioningCache.get(key);
  }

  if (!isGenerating) {
    postMessage({ type: "status", status: statusText, state: "loading" });
  }

  const conditioned = stateFromVoiceRecord(customVoiceStates.get(key));
  voiceConditioningCache.set(key, conditioned);
  return conditioned;
}

function parseNpyFloat32(buffer) {
  const view = new DataView(buffer);
  const magic = new Uint8Array(buffer, 0, 6);
  const expected = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
  for (let i = 0; i < expected.length; i++) {
    if (magic[i] !== expected[i]) {
      throw new Error("Invalid NPY file");
    }
  }

  const major = view.getUint8(6);
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerOffset = major === 1 ? 10 : 12;
  const headerText = new TextDecoder().decode(new Uint8Array(buffer, headerOffset, headerLen));
  const shapeMatch = headerText.match(/\(\s*([0-9,\s]+)\)/);
  if (!shapeMatch) {
    throw new Error("Could not parse NPY shape");
  }
  const shape = shapeMatch[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10));
  const dataOffset = headerOffset + headerLen;
  const data = new Float32Array(buffer, dataOffset);
  return { data: new Float32Array(data), shape };
}

function parseVoiceStatesBin(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  const magic = new TextDecoder().decode(new Uint8Array(buffer, offset, 5));
  offset += 5;
  if (magic !== "PTVB1") {
    throw new Error("Invalid voices.bin header");
  }

  const voices = {};
  const voiceCount = view.getUint32(offset, true);
  offset += 4;

  for (let voiceIndex = 0; voiceIndex < voiceCount; voiceIndex++) {
    const nameLen = view.getUint16(offset, true);
    offset += 2;
    const name = new TextDecoder().decode(new Uint8Array(buffer, offset, nameLen));
    offset += nameLen;

    const tensorCount = view.getUint16(offset, true);
    offset += 2;
    const tensors = {};

    for (let tensorIndex = 0; tensorIndex < tensorCount; tensorIndex++) {
      const keyLen = view.getUint16(offset, true);
      offset += 2;
      const key = new TextDecoder().decode(new Uint8Array(buffer, offset, keyLen));
      offset += keyLen;

      const dtypeCode = view.getUint8(offset);
      offset += 1;
      const rank = view.getUint8(offset);
      offset += 1;

      const shape = [];
      for (let dimIndex = 0; dimIndex < rank; dimIndex++) {
        shape.push(view.getUint32(offset, true));
        offset += 4;
      }

      const byteLength = view.getUint32(offset, true);
      offset += 4;

      let data;
      if (dtypeCode === 0) {
        data = new Float32Array(buffer.slice(offset, offset + byteLength));
      } else if (dtypeCode === 1) {
        data = new BigInt64Array(buffer.slice(offset, offset + byteLength));
      } else if (dtypeCode === 2) {
        data = new Uint8Array(buffer.slice(offset, offset + byteLength));
      } else {
        throw new Error(`Unsupported voices.bin dtype code: ${dtypeCode}`);
      }
      offset += byteLength;

      tensors[key] = {
        data,
        shape,
        dtype: dtypeCode === 0 ? "float32" : dtypeCode === 1 ? "int64" : "bool",
      };
    }

    voices[name] = tensors;
  }

  return voices;
}

function prepareTextPrompt(text, opts = {}) {
  let prompt = text.trim();
  if (!prompt) {
    return { text: "", framesAfterEos: MIN_FRAMES_AFTER_EOS };
  }

  prompt = normalizeForPocketTts(prompt, {
    pronunciationOverrides: opts.pronunciationOverrides || [],
  });

  prompt = prompt.replace(/\r/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ");
  if (bundleMetadata.remove_semicolons) {
    prompt = prompt.replace(/;/g, ",");
  }

  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  let framesAfterEos = wordCount <= 4 ? SHORT_TEXT_FRAMES_AFTER_EOS : MIN_FRAMES_AFTER_EOS;
  if (bundleMetadata.model_recommended_frames_after_eos != null) {
    framesAfterEos = Math.max(MIN_FRAMES_AFTER_EOS, Number(bundleMetadata.model_recommended_frames_after_eos));
    if (wordCount <= 4) framesAfterEos = Math.max(framesAfterEos, SHORT_TEXT_FRAMES_AFTER_EOS);
  }

  if (prompt && !/[A-ZÀ-Þ]/.test(prompt[0])) {
    prompt = prompt[0].toUpperCase() + prompt.slice(1);
  }
  if (prompt && /[0-9A-Za-zÀ-ÿ]/.test(prompt[prompt.length - 1])) {
    prompt += ".";
  }
  if (bundleMetadata.pad_with_spaces_for_short_inputs && wordCount < 5) {
    prompt = "        " + prompt;
  }

  return { text: prompt, framesAfterEos };
}

const SENTENCE_SPLIT_RE = /[^.!?]+[.!?]+|[^.!?]+$/g;

function splitTextIntoSentences(text) {
  const matches = text.match(SENTENCE_SPLIT_RE);
  if (!matches) return [];
  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

function splitTokenIdsIntoChunks(tokenIds, maxTokens) {
  const chunks = [];
  for (let i = 0; i < tokenIds.length; i += maxTokens) {
    const chunkText = tokenizerProcessor.decodeIds(tokenIds.slice(i, i + maxTokens)).trim();
    if (chunkText) {
      chunks.push(chunkText);
    }
  }
  return chunks;
}

function splitLongTextSafely(text, maxTokens) {
  const units = String(text || "").match(/\S+\s*/g) || [];
  const chunks = [];
  let current = "";
  const flush = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = "";
  };

  for (const unit of units) {
    const candidate = current + unit;
    if (current && tokenizerProcessor.encodeIds(candidate).length > maxTokens) {
      flush();
    }
    if (tokenizerProcessor.encodeIds(unit).length > maxTokens) {
      for (const piece of splitTokenIdsIntoChunks(tokenizerProcessor.encodeIds(unit), maxTokens)) {
        if (piece) chunks.push(piece);
      }
    } else {
      current += unit;
    }
  }
  flush();
  return chunks;
}

function mergeShortTextFragments(fragments, minWords) {
  const out = [];
  let carry = "";
  const target = Math.max(2, Math.min(5, minWords || 3));
  for (const fragment of fragments) {
    const piece = String(fragment || "").trim();
    if (!piece) continue;
    if (!carry) {
      carry = piece;
    } else {
      carry = `${carry} ${piece}`;
    }
    if (_wordCount(carry) >= target) {
      out.push(carry);
      carry = "";
    }
  }
  if (carry) {
    if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${carry}`.trim();
    else out.push(carry);
  }
  return out;
}

function _wordCount(s) {
  const m = (s || "").trim().match(/\S+/g);
  return m ? m.length : 0;
}

function _trailingPunct(s) {
  const m = (s || "").trim().match(/[.!?…,;:—]\s*$/);
  return m ? m[0].trim().slice(-1) : "";
}

// Zero-dependency emotion heuristic. Scores the text against small prose lexicons
// plus punctuation/caps signals and returns the dominant emotion (or 'neutral').
// Pure string work — negligible cost, runs per chunk.
function analyzeEmotion(text) {
  const lower = (text || "").toLowerCase();
  if (!lower.trim()) return "neutral";
  const scores = { joy: 0, anger: 0, sadness: 0, fear: 0, surprise: 0 };
  for (const emo in EMOTION_LEXICON) {
    for (const stem of EMOTION_LEXICON[emo]) {
      // Count stem occurrences at word starts (handles inflections via prefix match).
      let idx = lower.indexOf(stem);
      while (idx !== -1) {
        const before = idx === 0 ? " " : lower[idx - 1];
        if (/\s|["'(\-]/.test(before)) scores[emo] += 1;
        idx = lower.indexOf(stem, idx + stem.length);
      }
    }
  }
  // Punctuation / casing signals.
  const exclaims = (text.match(/!/g) || []).length;
  if (exclaims) { scores.anger += exclaims * 0.5; scores.surprise += exclaims * 0.5; }
  if (/\?/.test(text)) scores.surprise += 0.5;
  const shouts = (text.match(/\b[A-Z]{3,}\b/g) || []).length; // ALL-CAPS words
  if (shouts) scores.anger += shouts;
  if (/\b(no|never|don't|stop|please)\b/i.test(text) && exclaims) scores.fear += 0.5;

  let best = "neutral", bestScore = 0.999; // require a clear signal to leave neutral
  for (const emo in scores) {
    if (scores[emo] > bestScore) { bestScore = scores[emo]; best = emo; }
  }
  return best;
}

// Split a paragraph into ordered runs around inline [Ns] pause tags. Returns a
// list of { kind:'text', text } and { kind:'pause', sec } in document order.
function parsePauseTags(text) {
  const runs = [];
  let last = 0, m;
  PAUSE_TAG_RE.lastIndex = 0;
  while ((m = PAUSE_TAG_RE.exec(text)) !== null) {
    const before = text.slice(last, m.index);
    if (before.trim()) runs.push({ kind: "text", text: before });
    let sec = parseFloat(m[1]);
    if (isNaN(sec)) sec = 0;
    sec = Math.max(PAUSE_TAG_MIN, Math.min(PAUSE_TAG_MAX, sec));
    runs.push({ kind: "pause", sec });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  if (tail.trim()) runs.push({ kind: "text", text: tail });
  return runs.length ? runs : [{ kind: "text", text }];
}

// Break a sentence at internal , ; : — so punctuation pauses can be honoured.
// Fragments shorter than minWords are merged forward to bound the chunk count
// (and therefore the synthesis cost) of this opt-in mode.
function _splitAtInnerPunct(sentence, minWords) {
  const parts = sentence.match(/[^,;:\u2014]+[,;:\u2014]?/g);
  if (!parts || parts.length <= 1) return [sentence.trim()];
  const out = [];
  let buf = "";
  for (const p of parts) {
    buf = buf ? `${buf} ${p.trim()}` : p.trim();
    if (_wordCount(buf) >= minWords) { out.push(buf); buf = ""; }
  }
  if (buf) {
    if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${buf}`.trim();
    else out.push(buf);
  }
  return out;
}

// Build the chunk list + parallel per-chunk metadata (framesAfterEos, trailing
// pause, emotion-derived prosody). With all options off this reproduces the
// original sentence-grouping behaviour exactly.
function splitIntoBestSentences(text, opts) {
  opts = opts || {};
  const expressive   = !!opts.expressive;
  const pauseTags    = opts.pauseTags !== false;          // default on (Pocket)
  const pausePunct   = !!opts.pausePunctuation;
  const wordsMode    = opts.chunkMode === "words";
  const minWords     = Math.max(1,  Math.min(200, opts.minWords || 8));
  const maxWords     = Math.max(minWords, Math.min(400, opts.maxWords || 40));
  const paragraphEmotion = typeof opts.paragraphEmotion === "string" ? opts.paragraphEmotion : "neutral";
  const stableProsody = opts.stableProsody !== false;
  const paragraphPauseSec = Math.max(0, Math.min(3, Number(opts.paragraphPauseSec) || 0));
  const tuning = resolveWorkerTuning(opts);

  const chunks = [];
  const chunkMeta = [];
  let punctuationSplitCount = 0;
  // Enforce the soft token cap so continuous latent drift stays bounded.
  // currentMaxTokenPerChunk is the model's hard limit (200). Throughput/cache
  // mode raises the soft cap so background caching is not destroyed by
  // prefill-per-fragment overhead.
  const requestedSoftCap = Number(opts.tokenSoftCap);
  const softCap = Number.isFinite(requestedSoftCap) && requestedSoftCap > 0
    ? requestedSoftCap
    : (opts.throughputMode ? POCKET_THROUGHPUT_TOKEN_SOFT_CAP : POCKET_TOKEN_SOFT_CAP);
  const effectiveCap = Math.min(currentMaxTokenPerChunk, Math.max(40, softCap));

  const pushChunk = (chunkText, framesAfterEos) => {
    const t = (chunkText || "").trim();
    if (!t) return;
    const emotion = expressive ? paragraphEmotion : "neutral";
    const pros = stableProsody
      ? EMOTION_PROSODY.neutral
      : (EMOTION_PROSODY[analyzeEmotion(t)] || EMOTION_PROSODY.neutral);
    const punct = _trailingPunct(t);
    const pauseAfterSec = pausePunct
      ? (PUNCT_PAUSE_SEC[punct] != null ? PUNCT_PAUSE_SEC[punct] : CHUNK_GAP_SEC)
      : CHUNK_GAP_SEC;
    // Emotion-aware EOS tail: high-energy emotions snap off sooner (eosBonus < 0),
    // quiet/fearful emotions trail longer (eosBonus > 0). Only active in expressive mode.
    const adjustedFrames = stableProsody
      ? Math.max(MIN_FRAMES_AFTER_EOS, framesAfterEos)
      : Math.max(MIN_FRAMES_AFTER_EOS, framesAfterEos + (pros.eosBonus || 0));
    chunks.push(t);
    chunkMeta.push({
      framesAfterEos: adjustedFrames,
      pauseAfterSec,
      explicit: false,
      pauseOnly: false,
      emotion,
      temp:       stableProsody ? tuning.temperature : (expressive ? pros.temp : tuning.temperature),
      noiseClamp: stableProsody ? null : (expressive ? pros.noiseClamp : null),
      temperaturePreset: tuning.temperaturePreset,
      qualityMode: tuning.qualityMode,
      lsdSteps: tuning.lsdSteps,
    });
  };

  const runs = pauseTags ? parsePauseTags(text) : [{ kind: "text", text }];

  for (const run of runs) {
    if (run.kind === "pause") {
      // Fold an explicit pause into the previous chunk, or emit a silent unit.
      if (chunkMeta.length) {
        const prev = chunkMeta[chunkMeta.length - 1];
        prev.pauseAfterSec += run.sec;
        prev.explicit = true;
      } else {
        chunks.push("");
        chunkMeta.push({ framesAfterEos: 0, pauseAfterSec: run.sec, explicit: true, pauseOnly: true, emotion: "neutral", temp: tuning.temperature, noiseClamp: null, temperaturePreset: tuning.temperaturePreset, qualityMode: tuning.qualityMode, lsdSteps: tuning.lsdSteps });
      }
      continue;
    }

    const prepared = prepareTextPrompt(run.text, opts);
    if (!prepared.text) continue;
    const framesAfterEos = prepared.framesAfterEos;

    let sentences = splitTextIntoSentences(prepared.text);
    if (!sentences.length) sentences = [prepared.text];

    // Punctuation-pause mode: pre-split sentences at inner punctuation so each
    // fragment becomes its own chunk and carries its own trailing pause.
    if (pausePunct) {
      const expanded = [];
      for (const s of sentences) {
        const punctParts = _splitAtInnerPunct(s, minWords);
        punctuationSplitCount += Math.max(0, punctParts.length - 1);
        expanded.push(...punctParts);
      }
      sentences = expanded;
    }
    sentences = mergeShortTextFragments(sentences, minWords);

    // Group fragments into chunks, bounded by the token cap (hard ceiling) and,
    // in words mode, by the [minWords, maxWords] target.
    let current = "";
    const flush = () => { if (current) { pushChunk(current, framesAfterEos); current = ""; } };

    for (const sentenceText of sentences) {
      const sTokens = tokenizerProcessor.encodeIds(sentenceText);
      if (sTokens.length > effectiveCap) {
        flush();
        for (const piece of splitLongTextSafely(sentenceText, effectiveCap)) {
          if (piece) pushChunk(piece, framesAfterEos);
        }
        continue;
      }
      if (!current) { current = sentenceText; continue; }

      const combined = `${current} ${sentenceText}`;
      const overTokens = tokenizerProcessor.encodeIds(combined).length > effectiveCap;
      const overWords  = wordsMode && _wordCount(combined) > maxWords;
      // In words mode keep accreting until we reach minWords even past a boundary.
      const underMin   = wordsMode && _wordCount(current) < minWords;
      if ((overTokens || overWords) && !underMin) {
        flush();
        current = sentenceText;
      } else if (overTokens) {
        flush();
        current = sentenceText;
      } else {
        current = combined;
      }
    }
    flush();
  }

  if (paragraphPauseSec > 0 && chunkMeta.length) {
    for (let i = chunkMeta.length - 1; i >= 0; i--) {
      if (!chunkMeta[i].pauseOnly) {
        const baseTail = (!pausePunct && !chunkMeta[i].explicit) ? 0 : (chunkMeta[i].pauseAfterSec || 0);
        chunkMeta[i].pauseAfterSec = baseTail + paragraphPauseSec;
        chunkMeta[i].explicit = true;
        chunkMeta[i].paragraphTail = true;
        break;
      }
    }
  }

  return { chunks, chunkMeta, punctuationSplitCount };
}

function precomputeFlowBuffers() {
  stTensorCache = new Map();
  stTensors = getFlowStepTensors(DEFAULT_LSD_STEPS);
}

function getFlowStepTensors(lsdSteps = DEFAULT_LSD_STEPS) {
  const steps = Math.max(1, Math.min(BENCHMARK_QUALITY_LSD_STEPS, Number(lsdSteps) || DEFAULT_LSD_STEPS));
  if (stTensorCache.has(steps)) return stTensorCache.get(steps);
  const tensors = [];
  const dt = 1.0 / steps;
  for (let step = 0; step < steps; step++) {
    const s = step / steps;
    const t = s + dt;
    tensors.push({
      s: createTensor("float32", new Float32Array([s]), [1, 1]),
      t: createTensor("float32", new Float32Array([t]), [1, 1]),
    });
  }
  stTensorCache.set(steps, tensors);
  return tensors;
}

function supportsRelaxedSimd() {
  try {
    return typeof WebAssembly?.validate === 'function' && WebAssembly.validate(RELAXED_SIMD_PROBE);
  } catch (_) {
    return false;
  }
}

async function probeOrtRuntimeFiles(base, files) {
  for (const filename of files) {
    const response = await fetchWithTimeout(`${base}${filename}`, { method: 'HEAD' }, 10000);
    if (!response.ok) throw new Error(`${filename} returned HTTP ${response.status}`);
  }
}

async function loadWasmOrtRuntime(preferMinimalOrt = false) {
  const cdnBase = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${POCKET_ORT_VERSION}/dist/`;
  const candidates = [];
  if (supportsRelaxedSimd()) {
    if (preferMinimalOrt) {
      candidates.push({
        name: 'relaxed-simd-minimal-ort',
        base: `${PROXY_BASE_URL}/models/onnxruntime/${POCKET_ORT_MINIMAL_RUNTIME_VERSION}/`,
        requiredFiles: [
          'ort.min.mjs',
          'ort-wasm-relaxedsimd-threaded.mjs',
          'ort-wasm-relaxedsimd-threaded.wasm',
        ],
        simd: 'relaxed',
        wasmPaths(base) {
          return {
            mjs: `${base}ort-wasm-relaxedsimd-threaded.mjs`,
            wasm: `${base}ort-wasm-relaxedsimd-threaded.wasm`,
          };
        },
      });
    }
    candidates.push({
      name: 'relaxed-simd',
      base: `${PROXY_BASE_URL}/models/onnxruntime/${POCKET_ORT_RELAXED_RUNTIME_VERSION}/`,
      requiredFiles: [
        'ort.min.mjs',
        'ort-wasm-relaxedsimd-threaded.mjs',
        'ort-wasm-relaxedsimd-threaded.wasm',
      ],
      simd: 'relaxed',
      wasmPaths(base) {
        return {
          mjs: `${base}ort-wasm-relaxedsimd-threaded.mjs`,
          wasm: `${base}ort-wasm-relaxedsimd-threaded.wasm`,
        };
      },
    });
  }
  candidates.push(
    {
      name: 'stock-wasm-only',
      base: `${PROXY_BASE_URL}/models/onnxruntime/${POCKET_ORT_WASM_RUNTIME_VERSION}/`,
      requiredFiles: ['ort.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'],
      simd: true,
      wasmPaths: (base) => base,
    },
    {
      name: 'legacy-jsep',
      base: `${PROXY_BASE_URL}/models/onnxruntime/${POCKET_ORT_VERSION}/`,
      requiredFiles: ['ort.min.mjs'],
      simd: true,
      wasmPaths: (base) => base,
    },
    {
      name: 'cdn-jsep',
      base: cdnBase,
      requiredFiles: null,
      simd: true,
      wasmPaths: (base) => base,
    },
  );

  let lastError = null;
  for (const candidate of candidates) {
    try {
      if (candidate.requiredFiles) await probeOrtRuntimeFiles(candidate.base, candidate.requiredFiles);
      const ortModule = await importVerifiedModule(
        `${candidate.base}ort.min.mjs`,
        `ONNX Runtime ${candidate.name} module`,
      );
      return {
        ...candidate,
        module: ortModule.default || ortModule,
        paths: candidate.wasmPaths(candidate.base),
      };
    } catch (error) {
      lastError = error;
      console.warn(`[PocketTTS] ORT ${candidate.name} unavailable:`, error?.message || error);
    }
  }
  throw lastError || new Error('No ONNX Runtime WASM candidate was available.');
}

function configureLoadedOrt({ base, loadedFlavor, runtimeName, wasmPaths, simd }) {
  ortRuntimeFlavor = loadedFlavor;
  ortWasmRuntimeFlavor = runtimeName;
  ortModuleSupportsWebGpu = loadedFlavor === 'webgpu';
  stTensors = [];
  stTensorCache.clear();
  console.log(`[PocketTTS] ONNX Runtime ${POCKET_ORT_VERSION} ${loadedFlavor}/${runtimeName} loaded from ${base}`);
  ort.env.wasm.wasmPaths = wasmPaths;
  ort.env.wasm.simd = simd;
  ort.env.wasm.proxy = false;
  runtimeThreadCount = resolveWasmThreadCount();
  ort.env.wasm.numThreads = runtimeThreadCount;
  postMessage({
    type: "diagnostic",
    level: "INFO",
    message: `Pocket runtime: ${loadedFlavor === 'webgpu' ? 'hybrid WebGPU core + WASM stages' : `WASM ${runtimeName}`}, ${runtimeThreadCount} WASM thread${runtimeThreadCount === 1 ? "" : "s"}, isolated=${self.crossOriginIsolated === true}`,
  });
  precomputeFlowBuffers();
}

async function loadOrt(backend = 'wasm', { preferMinimalOrt = false } = {}) {
  const desiredFlavor = backend === 'webgpu' ? 'webgpu' : 'wasm';
  const desiredWasmFormat = preferMinimalOrt ? 'ort' : 'onnx';
  if (
    ort
    && ortRuntimeFlavor === desiredFlavor
    && (desiredFlavor !== 'wasm' || ortWasmModelFormat === desiredWasmFormat)
  ) {
    if (desiredFlavor === 'wasm') {
      runtimeThreadCount = resolveWasmThreadCount();
      ort.env.wasm.numThreads = runtimeThreadCount;
    }
    return;
  }

  if (desiredFlavor === 'wasm') {
    postMessage({ type: "status", status: "Loading optimized ONNX Runtime...", state: "loading" });
    const runtime = await loadWasmOrtRuntime(preferMinimalOrt);
    ort = runtime.module;
    ortWasmModelFormat = desiredWasmFormat;
    configureLoadedOrt({
      base: runtime.base,
      loadedFlavor: 'wasm',
      runtimeName: runtime.name,
      wasmPaths: runtime.paths,
      simd: runtime.simd,
    });
    return;
  }

  postMessage({ type: "status", status: "Loading ONNX Runtime...", state: "loading" });
  const version = POCKET_ORT_VERSION;
  // Self-hosted copy (B2 via the Cloudflare proxy) is primary so a jsDelivr
  // outage cannot take narration down; the CDN stays as fallback so the app
  // keeps working before/without the B2 upload. A cheap probe of ort.min.mjs
  // decides the base for BOTH the module and the .wasm files — mixing bases
  // could load a module whose matching wasm is missing.
  const selfHostBase = `${PROXY_BASE_URL}/models/onnxruntime/${version}/`;
  const cdnBase = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
  const desiredModuleFile = desiredFlavor === 'webgpu' ? 'ort.webgpu.min.mjs' : 'ort.min.mjs';
  let base = cdnBase;
  try {
    const probe = await fetchWithTimeout(`${selfHostBase}${desiredModuleFile}`, { method: "HEAD" }, 10000);
    if (probe.ok) base = selfHostBase;
  } catch (e) { /* proxy unreachable — use CDN */ }

  let loadedFlavor = desiredFlavor;
  try {
    const ortModule = await importVerifiedModule(
      `${base}${desiredModuleFile}`, `ONNX Runtime ${desiredFlavor} module`);
    ort = ortModule.default || ortModule;
  } catch (importErr) {
    if (base === selfHostBase) {
      console.warn("[PocketTTS] Self-hosted ONNX Runtime failed, falling back to CDN:", importErr?.message || importErr);
      try {
        const ortModule = await importVerifiedModule(
          `${cdnBase}${desiredModuleFile}`, `ONNX Runtime ${desiredFlavor} CDN fallback`);
        ort = ortModule.default || ortModule;
        base = cdnBase;
      } catch (_) {
        if (desiredFlavor !== 'webgpu') throw importErr;
        const ortModule = await importVerifiedModule(
          `${cdnBase}ort.min.mjs`, "ONNX Runtime WASM CDN fallback");
        ort = ortModule.default || ortModule;
        loadedFlavor = 'wasm';
        base = cdnBase;
      }
    } else {
      if (desiredFlavor !== 'webgpu') throw importErr;
      const ortModule = await importVerifiedModule(
        `${cdnBase}ort.min.mjs`, "ONNX Runtime WASM CDN fallback");
      ort = ortModule.default || ortModule;
      loadedFlavor = 'wasm';
    }
  }
  configureLoadedOrt({
    base: base === selfHostBase ? selfHostBase : cdnBase,
    loadedFlavor,
    runtimeName: loadedFlavor === 'webgpu' ? 'webgpu-jsep' : 'legacy-jsep',
    wasmPaths: base,
    simd: true,
  });
}

function resolveWasmThreadCount() {
  if (self.crossOriginIsolated !== true || typeof SharedArrayBuffer === 'undefined') return 1;
  const userAgent = self.navigator?.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
  const recommended = recommendedWasmThreadCount({
    crossOriginIsolated: true,
    hardwareConcurrency: Number(self.navigator?.hardwareConcurrency || 0),
    mobile,
    userAgent,
  });
  const requested = Math.max(0, Math.min(6, Number(requestedWasmThreadCount) || 0));
  // Never honor a stale requested=1 while the session is isolated — that is what
  // produced ~40s/paragraph crawls on Pixel-class phones after a demote/reload.
  if (requested >= 2) return requested;
  return recommended;
}

async function configureWebGpuDevice() {
  if (!ortModuleSupportsWebGpu || !self.navigator?.gpu) {
    throw new Error('ONNX Runtime WebGPU support is unavailable.');
  }
  const adapter = await self.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter was returned.');
  if (!adapter.features?.has('shader-f16')) throw new Error('The WebGPU adapter does not support shader-f16.');
  releaseGpuDevice();
  // ORT requests the final device with its exact limits/features and exposes it
  // as env.webgpu.device after the first WebGPU session is created. External
  // graph-capture buffers must be allocated from that same device.
  ort.env.webgpu.adapter = adapter;
  ort.env.webgpu.powerPreference = 'high-performance';
  gpuDeviceLost = false;
}

function adoptOrtWebGpuDevice() {
  const device = ort?.env?.webgpu?.device;
  if (!device) throw new Error('ONNX Runtime did not expose its WebGPU device.');
  activeGpuDevice = device;
  device.lost.then((info) => {
    if (activeGpuDevice !== device) return;
    activeGpuDevice = null;
    gpuDeviceLost = true;
    gpuFailureCount += 1;
    postMessage({
      type: 'gpu_lost',
      reason: info?.message || info?.reason || 'WebGPU device lost',
      failures: gpuFailureCount,
    });
  });
}

function releaseGpuDevice() {
  const device = activeGpuDevice;
  activeGpuDevice = null;
  if (!device || typeof device.destroy !== 'function') return;
  try { device.destroy(); } catch (_) {}
}

// A release failure must never abort the teardown. session.release() rejects on
// a lost WebGPU device -- which is precisely when this runs -- and an unhandled
// rejection here used to skip every null-assignment and GPU-tensor disposal
// below, leaving stale session handles plus leaked voice tensors. The retry then
// released the same dead sessions and threw again, wedging the engine until the
// worker was terminated. Dropping the session reference is what matters; the
// underlying memory is reclaimed with the device or the worker either way.
async function releaseSession(session) {
  if (!session) {
    return;
  }
  if (typeof session.release === "function") {
    try {
      await session.release();
    } catch (error) {
      postMessage({
        type: 'diagnostic',
        level: 'WARN',
        message: `Session release failed; dropping the handle anyway (${error?.message || error})`,
      });
    }
  }
}

async function releaseAllSessions() {
  await Promise.all([
    releaseSession(textConditionerSession),
    releaseSession(flowLmMainSession),
    releaseSession(flowLmFlowSession),
    releaseSession(flowLmDecodeBlockSession),
    releaseSession(flowLmUnifiedSession),
    releaseSession(flowLmWasmBlockSession),
    releaseSession(mimiDecoderSession),
  ]);
  textConditionerSession = null;
  flowLmMainSession = null;
  flowLmFlowSession = null;
  flowLmDecodeBlockSession = null;
  flowLmUnifiedSession = null;
  flowLmWasmBlockSession = null;
  wasmBlockBosSequence = null;
  wasmUnifiedPrefillMode = null;
  wasmUnifiedDecodeMode = null;
  wasmUnifiedZeroRandom = null;
  wasmUnifiedBosTensor = null;
  mimiDecoderSession = null;
  webGpuBosSequence = null;
  webGpuBundleMetadata = null;
  for (const state of voiceConditioningCache.values()) disposeGpuState(state);
  voiceConditioningCache.clear();
}

// WASM session options. On memory-safe devices (iOS + low-memory/constrained)
// we disable ORT's CPU memory arena and the memory-pattern planner. Both are
// throughput optimizations that pre-size the WASM heap to the largest tensor
// shape seen and then hold that peak for the life of the session — they never
// give the memory back. Across a long background cache job the autoregressive
// KV cache grows every step, so the arena ratchets up paragraph after paragraph
// until iOS's (comparatively low) per-tab jetsam limit kills the app mid-cache
// — exactly the OOM crash seen on iPhone 13 after ~20 paragraphs, while Android
// (much higher limit) survives. Turning both off bounds peak memory and lets
// each run's transients be reclaimed, trading a little speed for not being
// OOM-killed. Full-memory desktops keep the optimizations.
function wasmSessionOptions() {
  const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  if (constrainedMemoryMode) {
    options.enableCpuMemArena = false;
    options.enableMemPattern = false;
  }
  return options;
}

function sessionOptionsFor(asset) {
  if (currentBackend !== 'webgpu') {
    return wasmSessionOptions();
  }
  if (asset === WEBGPU_MIMI_ROLE) {
    const preferredOutputLocation = preferredStateOutputLocations(bundleMetadata.mimi_state_manifest);
    preferredOutputLocation.audio_frame = 'cpu';
    return {
      // The current Mimi export has a small number of shape/scatter operators
      // without WebGPU kernels. This isolated candidate may partition those to
      // WASM, but it is retained only after a full-pipeline calibration win.
      executionProviders: ['webgpu', 'wasm'],
      graphOptimizationLevel: 'all',
      preferredOutputLocation,
    };
  }
  if (asset !== WEBGPU_BLOCK_ROLE) {
    return wasmSessionOptions();
  }
  const preferredOutputLocation = preferredStateOutputLocations(bundleMetadata.flow_lm_state_manifest, ['next_sequence']);
  preferredOutputLocation.latents = 'gpu-buffer';
  preferredOutputLocation.eos_logits = 'gpu-buffer';
  return {
    // Core R3 sessions are strict WebGPU. Unsupported operators fail session
    // certification and trigger a complete WASM retry instead of creating a
    // slow mixed-provider graph with per-step GPU/CPU synchronization.
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
    preferredOutputLocation,
    enableGraphCapture: webGpuGraphCaptureEnabled,
  };
}

async function ensureFlowLmFlowSession() {
  if (flowLmFlowSession) return flowLmFlowSession;
  if (currentBackend !== 'wasm') {
    throw new Error('The per-frame flow graph is only available on WASM.');
  }
  postMessage({ type: 'status', status: 'Preparing high-quality flow...', state: 'loading' });
  const response = await fetchFirstAvailable(
    wasmModelPaths(currentLanguage, wasmModelFilename('flow_lm_flow')),
  );
  const modelBuffer = await response.arrayBuffer();
  flowLmFlowSession = await withTimeout(
    ort.InferenceSession.create(modelBuffer, sessionOptionsFor('flow_lm_flow')),
    SESSION_CREATE_TIMEOUT_MS,
    'flow_lm_flow session initialization',
  );
  return flowLmFlowSession;
}

async function ensureFlowLmMainSession() {
  if (flowLmMainSession) return flowLmMainSession;
  if (currentBackend !== 'wasm') {
    throw new Error('The per-frame flow graph is only available on WASM.');
  }
  const response = await fetchFirstAvailable(
    wasmModelPaths(currentLanguage, wasmModelFilename('flow_lm_main')),
  );
  const modelBuffer = await response.arrayBuffer();
  flowLmMainSession = await withTimeout(
    ort.InferenceSession.create(modelBuffer, sessionOptionsFor('flow_lm_main')),
    SESSION_CREATE_TIMEOUT_MS,
    'flow_lm_main session initialization',
  );
  return flowLmMainSession;
}

async function ensurePerFrameFlowSessions() {
  await ensureFlowLmMainSession();
  await ensureFlowLmFlowSession();
}

async function loadBundle(language, {
  initialLoad = false,
  backend = currentBackend,
  graphCapture = false,
  mimiProvider = 'wasm-threaded',
  syncGroupBlocks = WEBGPU_STEADY_SYNC_BLOCKS,
} = {}) {
  if (!LANGUAGE_BUNDLES.includes(language)) {
    throw new Error(`Unsupported language bundle: ${language}`);
  }

  const selectedBackend = normalizePocketBackend(backend) === 'webgpu' ? 'webgpu' : 'wasm';
  if (selectedBackend === 'webgpu' && language !== DEFAULT_LANGUAGE) {
    throw new Error('The WebGPU FP16 bundle is currently available for English only.');
  }

  webGpuGraphCaptureEnabled = selectedBackend === 'webgpu'
    && graphCapture === true
    && WEBGPU_GRAPH_CAPTURE_SUPPORTED;
  gpuSyncGroupBlocks = selectedBackend === 'webgpu'
    ? Math.max(1, Math.min(WEBGPU_STEADY_SYNC_BLOCKS, Number(syncGroupBlocks) || WEBGPU_STEADY_SYNC_BLOCKS))
    : 1;
  currentMimiProvider = 'wasm-threaded';

  postMessage({ type: 'progress', info: { status: 'progress', progress: 2 } });
  // Keep calibration and backend changes sequential in memory. Voice source
  // records remain available and are reconditioned after the new sessions load.
  await releaseAllSessions();
  if (currentBackend === 'webgpu' && selectedBackend !== 'webgpu') releaseGpuDevice();
  useOrtFormatWasm = selectedBackend === 'wasm'
    && language === DEFAULT_LANGUAGE
    && supportsRelaxedSimd();
  await loadOrt(selectedBackend, { preferMinimalOrt: useOrtFormatWasm });

  if (selectedBackend === 'webgpu') await configureWebGpuDevice();
  currentBackend = selectedBackend;
  currentModelPrecision = currentBackend === 'webgpu' ? 'fp16' : 'int8';
  currentModelRevision = currentBackend === 'webgpu' ? POCKET_WEBGPU_MODEL_REVISION : POCKET_WASM_MODEL_REVISION;

  postMessage({ type: 'progress', info: { status: 'progress', progress: 10 } });
  postMessage({ type: "status", status: `Loading ${language} bundle...`, state: "loading" });
  currentLanguage = language;
  currentBundleDir = bundleDir(language, currentBackend);

  if (currentBackend === 'webgpu') {
    const [gpuMetadataResponse, wasmMetadataResponse] = await Promise.all([
      fetchFirstAvailable([
        proxifyUrl(bundlePath(language, "bundle.json", 'webgpu')),
        directBundlePath(language, "bundle.json", 'webgpu'),
      ]),
      fetchFirstAvailable([
        proxifyUrl(bundlePath(language, "bundle.json", 'wasm')),
        directBundlePath(language, "bundle.json", 'wasm'),
      ]),
    ]);
    webGpuBundleMetadata = await gpuMetadataResponse.json();
    bundleMetadata = await wasmMetadataResponse.json();
    const contract = webGpuBundleMetadata.execution_contract || {};
    if (
      contract.core_provider !== 'webgpu-only'
      || contract.prefill_provider !== 'wasm-threaded'
      || contract.mimi_provider !== 'benchmark-gated-webgpu'
      || contract.mimi_fallback_provider !== 'wasm-threaded'
      || contract.decode_block_frames !== WEBGPU_BLOCK_FRAMES
      || contract.steady_sync_blocks !== WEBGPU_STEADY_SYNC_BLOCKS
      || contract.recurrent_state_location !== 'gpu-buffer'
      || contract.mixed_provider_fallback !== false
    ) {
      throw new Error('The WebGPU R3 bundle execution contract is invalid.');
    }
  } else {
    const metadataResponse = await fetchFirstAvailable([
      proxifyUrl(bundlePath(language, "bundle.json", 'wasm')),
      directBundlePath(language, "bundle.json", 'wasm'),
    ]);
    bundleMetadata = await metadataResponse.json();
    webGpuBundleMetadata = null;
  }

  currentSampleRate = Number(bundleMetadata.sample_rate);
  currentSamplesPerFrame = Number(bundleMetadata.samples_per_frame);
  currentLatentDim = Number(bundleMetadata.latent_dim);
  currentConditioningDim = Number(bundleMetadata.conditioning_dim);
  currentMaxTokenPerChunk = 200;
  isReady = false;

  const gpuBlockFilename = webGpuBundleMetadata?.model_files?.[WEBGPU_BLOCK_ROLE];
  const gpuMimiFilename = webGpuBundleMetadata?.model_files?.[WEBGPU_MIMI_ROLE];
  const iosWebKit = /iPhone|iPad|iPod/i.test(self.navigator?.userAgent || '');
  const preferUnifiedWasmCore = currentBackend === 'wasm'
    && language === DEFAULT_LANGUAGE
    && (iosWebKit || constrainedMemoryMode);
  if (currentBackend === 'webgpu' && !gpuMimiFilename) {
    throw new Error('The WebGPU bundle is missing its benchmark Mimi candidate.');
  }
  const modelDescriptors = currentBackend === 'webgpu'
    ? [
        { asset: 'text_conditioner', target: 'textConditionerSession', filename: MODEL_STEMS.text_conditioner, sourceBackend: 'wasm' },
        { asset: 'flow_lm_main', target: 'flowLmMainSession', filename: MODEL_STEMS.flow_lm_main, sourceBackend: 'wasm' },
        { asset: 'mimi_decoder', target: 'mimiDecoderSession', filename: MODEL_STEMS.mimi_decoder, sourceBackend: 'wasm' },
        { asset: WEBGPU_BLOCK_ROLE, target: 'flowLmDecodeBlockSession', filename: gpuBlockFilename, sourceBackend: 'webgpu' },
      ]
    : [
        { asset: 'text_conditioner', target: 'textConditionerSession', filename: wasmModelFilename('text_conditioner'), sourceBackend: 'wasm' },
        preferUnifiedWasmCore
          ? { asset: 'flow_lm_unified_block4', target: 'flowLmUnifiedSession', filename: wasmBlockFilename(true), sourceBackend: 'wasm' }
          : { asset: 'flow_lm_main', target: 'flowLmMainSession', filename: wasmModelFilename('flow_lm_main'), sourceBackend: 'wasm' },
        { asset: 'mimi_decoder', target: 'mimiDecoderSession', filename: wasmModelFilename('mimi_decoder'), sourceBackend: 'wasm' },
      ];
  if (modelDescriptors.some((descriptor) => !descriptor.filename)) {
    throw new Error('The selected Pocket bundle is missing a required model filename.');
  }
  currentModelAssetBytes = Object.fromEntries(modelDescriptors.map((descriptor) => {
    const metadata = descriptor.sourceBackend === 'webgpu' ? webGpuBundleMetadata : bundleMetadata;
    const fallbackSizes = useOrtFormatWasm ? ORT_FORMAT_MODEL_ASSET_BYTES : MODEL_ASSET_BYTES;
    const size = Number(metadata?.artifacts?.[descriptor.filename]?.bytes || fallbackSizes[descriptor.asset] || 0);
    return [descriptor.asset, size];
  }));
  currentModelDownloadTotalBytes = Math.max(1, Object.values(currentModelAssetBytes).reduce((sum, size) => sum + size, 0));

  postMessage({ type: 'progress', info: { status: 'progress', progress: 30 } });

  let completedBytes = 0;
  let sessionCreationMs = 0;
  const loadModelDescriptor = async ({ asset, target, filename, sourceBackend }) => {
    const modelUrls = sourceBackend === 'wasm'
      ? wasmModelPaths(language, filename)
      : [
          proxifyUrl(bundlePath(language, filename, sourceBackend)),
          directBundlePath(language, filename, sourceBackend),
        ];
    let modelBuffer = await fetchModelWithProgress(modelUrls, asset, completedBytes);
    const modelBytes = modelBuffer.byteLength;
    postMessage({ type: "status", status: `Preparing ${asset}...`, state: "loading" });
    const sessionStart = performance.now();
    let session;
    try {
      session = await withTimeout(
        ort.InferenceSession.create(modelBuffer, sessionOptionsFor(asset)),
        SESSION_CREATE_TIMEOUT_MS,
        `${asset} session initialization`,
      );
    } finally {
      // ORT has copied/compiled the model by this point. Drop the network
      // ArrayBuffer before fetching the next model so constrained WebKit does
      // not retain two weight blobs across adjacent session creations.
      modelBuffer = null;
    }
    sessionCreationMs += performance.now() - sessionStart;
    if (target === 'flowLmDecodeBlockSession' && currentBackend === 'webgpu') {
      adoptOrtWebGpuDevice();
    }
    if (target === "textConditionerSession") textConditionerSession = session;
    else if (target === "flowLmMainSession") flowLmMainSession = session;
    else if (target === "flowLmFlowSession") flowLmFlowSession = session;
    else if (target === "flowLmDecodeBlockSession") flowLmDecodeBlockSession = session;
    else if (target === "flowLmUnifiedSession") flowLmUnifiedSession = session;
    else {
      mimiDecoderSession = session;
      currentMimiProvider = 'wasm-threaded';
    }
    completedBytes += modelBytes;
    if (constrainedMemoryMode) {
      // Yield a frame between large sessions. This gives WebKit a collection
      // opportunity after the model buffer becomes unreachable and keeps peak
      // startup allocation lower without changing inference results.
      await new Promise((resolve) => setTimeout(resolve, 24));
    }
  };
  for (const descriptor of modelDescriptors) {
    try {
      await loadModelDescriptor(descriptor);
    } catch (error) {
      if (descriptor.target !== 'flowLmUnifiedSession') throw error;
      flowLmUnifiedSession = null;
      postMessage({
        type: 'diagnostic',
        level: 'WARN',
        message: `Unified WASM core unavailable; using split sessions (${error?.message || error}).`,
      });
      await loadModelDescriptor({
        asset: 'flow_lm_main',
        target: 'flowLmMainSession',
        filename: wasmModelFilename('flow_lm_main'),
        sourceBackend: 'wasm',
      });
    }
  }

  // Optional WASM decode-block core. Strictly best-effort: absent on B2, on a
  // constrained device (1 thread implies isolation-off or low-memory mode), or
  // on any failure, the per-frame AR path keeps working unchanged.
  // iOS is excluded outright: instantiating a fifth model (+84MB weights on
  // top of the four required sessions) pushed an iPhone 13 past WebKit's
  // per-tab memory budget and OOM-killed the page mid-cache (2026-07-16 field
  // crash, "A problem repeatedly occurred").
  flowLmWasmBlockSession = null;
  wasmBlockBosSequence = null;
  wasmUnifiedPrefillMode = null;
  wasmUnifiedDecodeMode = null;
  wasmUnifiedZeroRandom = null;
  wasmUnifiedBosTensor = null;
  if (flowLmUnifiedSession) {
    try {
      const bosResponse = await fetchFirstAvailable([
        proxifyUrl(bundlePath(language, WASM_BLOCK_BOS_FILE, 'wasm')),
        directBundlePath(language, WASM_BLOCK_BOS_FILE, 'wasm'),
      ]);
      wasmBlockBosSequence = parseNpyFloat32(await bosResponse.arrayBuffer());
      if (wasmBlockBosSequence.shape.join(',') !== `1,1,${currentLatentDim}`) {
        throw new Error('Unified WASM BOS tensor has an incompatible shape.');
      }
      wasmUnifiedPrefillMode = createTensor('bool', new Uint8Array([0]), []);
      wasmUnifiedDecodeMode = createTensor('bool', new Uint8Array([1]), []);
      wasmUnifiedZeroRandom = createTensor(
        'float32', new Float32Array(WASM_BLOCK_FRAMES * currentLatentDim),
        [1, WASM_BLOCK_FRAMES, currentLatentDim],
      );
      wasmUnifiedBosTensor = createTensor(
        'float32', new Float32Array(wasmBlockBosSequence.data), wasmBlockBosSequence.shape,
      );
      postMessage({
        type: 'diagnostic',
        level: 'INFO',
        message: 'Unified WASM prefill/decode-block4 core active (shared weights).',
      });
    } catch (error) {
      await releaseSession(flowLmUnifiedSession);
      flowLmUnifiedSession = null;
      wasmBlockBosSequence = null;
      postMessage({
        type: 'diagnostic',
        level: 'WARN',
        message: `Unified WASM core unavailable; using split sessions (${error?.message || error}).`,
      });
      const mainStart = performance.now();
      await ensureFlowLmMainSession();
      sessionCreationMs += performance.now() - mainStart;
    }
  } else if (currentBackend === 'wasm' && !iosWebKit && resolveWasmThreadCount() >= 2) {
    try {
      const blockResponse = await fetchFirstAvailable(
        wasmModelPaths(language, wasmBlockFilename(false)),
      );
      const blockBuffer = await blockResponse.arrayBuffer();
      const bosResponse = await fetchFirstAvailable([
        proxifyUrl(bundlePath(language, WASM_BLOCK_BOS_FILE, 'wasm')),
        directBundlePath(language, WASM_BLOCK_BOS_FILE, 'wasm'),
      ]);
      const bosTensor = parseNpyFloat32(await bosResponse.arrayBuffer());
      if (bosTensor.shape.join(',') !== `1,1,${currentLatentDim}`) {
        throw new Error('WASM block BOS tensor has an incompatible shape.');
      }
      flowLmWasmBlockSession = await withTimeout(
        ort.InferenceSession.create(blockBuffer, sessionOptionsFor('flow_lm_main')),
        SESSION_CREATE_TIMEOUT_MS,
        'WASM decode-block session initialization',
      );
      wasmBlockBosSequence = bosTensor;
      postMessage({
        type: 'diagnostic',
        level: 'INFO',
        message: `WASM decode-block4 core active (${Math.round(blockBuffer.byteLength / 1048576)}MB).`,
      });
    } catch (error) {
      flowLmWasmBlockSession = null;
      wasmBlockBosSequence = null;
      postMessage({
        type: 'diagnostic',
        level: 'INFO',
        message: `WASM decode-block unavailable; using the per-frame path (${error?.message || error}).`,
      });
    }
  }

  // The decode-block graph already contains the one-step flow network. Keep
  // the separate ~10MB per-frame flow session out of memory unless block4 is
  // unavailable or the user explicitly selects the four-step quality mode.
  if (currentBackend === 'wasm' && !flowLmWasmBlockSession && !flowLmUnifiedSession) {
    const flowSessionStart = performance.now();
    await ensureFlowLmFlowSession();
    sessionCreationMs += performance.now() - flowSessionStart;
  }

  postMessage({ type: 'progress', info: { status: 'progress', progress: 70 } });

  const tokenizerResponse = await fetchFirstAvailable([
    proxifyUrl(bundlePath(language, bundleMetadata.tokenizer_file, 'wasm')),
    directBundlePath(language, bundleMetadata.tokenizer_file, 'wasm'),
  ]);
  const tokenizerBuffer = await tokenizerResponse.arrayBuffer();
  tokenizerModelB64 = uint8ArrayToBase64(new Uint8Array(tokenizerBuffer));
  let spModule;
  try {
    spModule = await importVerifiedModule(
      proxifyUrl(`${MODEL_BASE_URL}sentencepiece.js?v=${SENTENCEPIECE_MODULE_VERSION}`),
      "SentencePiece module",
    );
  } catch (error) {
    postMessage({
      type: "diagnostic",
      level: "WARN",
      message: `SentencePiece proxy load failed; trying direct B2 (${error?.message || error})`,
    });
    spModule = await importVerifiedModule(
      `${B2_DIRECT_BASE_URL}/sentencepiece.js?v=${SENTENCEPIECE_MODULE_VERSION}`,
      "SentencePiece direct B2 fallback",
    );
  }
  tokenizerProcessor = new spModule.SentencePieceProcessor();
  await tokenizerProcessor.loadFromB64StringModel(tokenizerModelB64);

  bosBeforeVoice = null;
  if (bundleMetadata.bos_before_voice_file) {
    try {
      const bosResponse = await fetchFirstAvailable([
        proxifyUrl(bundlePath(language, bundleMetadata.bos_before_voice_file, 'wasm')),
        directBundlePath(language, bundleMetadata.bos_before_voice_file, 'wasm'),
      ]);
      bosBeforeVoice = parseNpyFloat32(await bosResponse.arrayBuffer());
    } catch (error) {
      postMessage({ type: "diagnostic", level: "WARN", message: `Optional BOS state unavailable: ${error?.message || error}` });
    }
  }

  webGpuBosSequence = null;
  if (currentBackend === 'webgpu') {
    const bosFile = webGpuBundleMetadata.flow_lm_bos_file;
    const bosResponse = await fetchFirstAvailable([
      proxifyUrl(bundlePath(language, bosFile, 'webgpu')),
      directBundlePath(language, bosFile, 'webgpu'),
    ]);
    webGpuBosSequence = parseNpyFloat32(await bosResponse.arrayBuffer());
    if (webGpuBosSequence.shape.join(',') !== `1,1,${currentLatentDim}`) {
      throw new Error('The WebGPU R3 BOS tensor has an incompatible shape.');
    }
  }

  predefinedVoiceRecords = {};
  if (LOAD_BUNDLED_VOICE_BIN) {
    try {
      const voicesResponse = await fetch(proxifyUrl(bundlePath(language, "voices.bin", 'wasm')));
      if (voicesResponse.ok) {
        predefinedVoiceRecords = parseVoiceStatesBin(await voicesResponse.arrayBuffer());
      } else if (DEBUG_LOGS) {
        console.warn(`No bundled voices.bin for ${language}; custom voice assets will be used.`);
      }
    } catch (err) {
      if (DEBUG_LOGS) {
        console.warn(`Unable to load optional voices.bin for ${language}:`, err);
      }
    }
  }

  postMessage({ type: 'progress', info: { status: 'progress', progress: 90 } });

  voiceConditioningCache = new Map();
  const availablePredefinedVoices = Object.keys(predefinedVoiceRecords);
  let defaultVoice = availablePredefinedVoices.includes("alba") ? "alba" : (availablePredefinedVoices[0] || null);
  currentVoiceName = defaultVoice;

  if (defaultVoice) {
    await ensurePredefinedVoiceCached(defaultVoice, {
      force: true,
      statusText: `Preparing voice (${defaultVoice})...`,
    });
  }

  for (const voiceName of customVoiceStates.keys()) {
    voiceConditioningCache.delete(voiceName);
  }

  if (currentBackend === 'webgpu' && mimiProvider === 'webgpu-mixed') {
    await switchMimiProvider('webgpu-mixed');
  }

  isReady = true;
  lastBackendTelemetry = {
    ...(lastBackendTelemetry || {}),
    selectedBackend: currentBackend,
    precision: currentModelPrecision,
    modelRevision: currentModelRevision,
    ortVersion: POCKET_ORT_VERSION,
    ortWasmRuntimeFlavor: currentBackend === 'wasm' ? ortWasmRuntimeFlavor : null,
    threads: runtimeThreadCount,
    gpuResidentStateBytes: currentBackend === 'webgpu' ? POCKET_GPU_RESIDENT_STATE_BYTES : 0,
    operatorFallbackCount: null,
    graphCapture: currentBackend === 'webgpu' ? webGpuGraphCaptureEnabled : false,
    mimiProvider: currentMimiProvider,
    gpuSyncGroupBlocks: currentBackend === 'webgpu' ? gpuSyncGroupBlocks : 1,
    sessionCreationMs: Math.round(sessionCreationMs),
  };

  postMessage({ type: 'progress', info: { status: 'progress', progress: 100 } });

  postMessage({
    type: "voices_loaded",
    voices: availablePredefinedVoices,
    defaultVoice,
    language,
  });
  postMessage({
    type: "bundle_loaded",
    language,
    sampleRate: currentSampleRate,
    initialLoad,
  });
  postMessage({ type: "status", status: "Ready", state: "idle" });
  postMessage({ type: "model_status", status: "ready", text: `Ready (${language})` });
  postMessage({ type: 'backend_selected', telemetry: lastBackendTelemetry });
  if (initialLoad) {
    postMessage({ type: "loaded" });
  }
}

async function switchMimiProvider(provider = 'wasm-threaded') {
  const requested = provider === 'webgpu-mixed' ? 'webgpu-mixed' : 'wasm-threaded';
  if (requested === currentMimiProvider && mimiDecoderSession) return currentMimiProvider;
  if (requested === 'webgpu-mixed' && currentBackend !== 'webgpu') {
    throw new Error('The GPU Mimi candidate requires the WebGPU backend.');
  }

  const sourceBackend = requested === 'webgpu-mixed' ? 'webgpu' : 'wasm';
  const asset = requested === 'webgpu-mixed' ? WEBGPU_MIMI_ROLE : 'mimi_decoder';
  const filename = requested === 'webgpu-mixed'
    ? webGpuBundleMetadata?.model_files?.[WEBGPU_MIMI_ROLE]
    : MODEL_STEMS.mimi_decoder;
  if (!filename) throw new Error(`The ${requested} Mimi model is unavailable.`);

  const response = await fetchFirstAvailable([
    proxifyUrl(bundlePath(currentLanguage, filename, sourceBackend)),
    directBundlePath(currentLanguage, filename, sourceBackend),
  ]);
  const modelBuffer = await response.arrayBuffer();
  const nextSession = await withTimeout(
    ort.InferenceSession.create(modelBuffer, sessionOptionsFor(asset)),
    SESSION_CREATE_TIMEOUT_MS,
    `${asset} session initialization`,
  );
  const previousSession = mimiDecoderSession;
  mimiDecoderSession = nextSession;
  currentMimiProvider = requested;
  await releaseSession(previousSession);
  return currentMimiProvider;
}

function inspectCalibrationAudio(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  let finite = true;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const value = chunk[index];
      if (!Number.isFinite(value)) finite = false;
      const abs = Math.abs(Number.isFinite(value) ? value : 0);
      peak = Math.max(peak, abs);
      sumSquares += abs * abs;
      if (abs >= 0.999) clipped += 1;
    }
  }
  return {
    finite,
    durationSec: length / currentSampleRate,
    rms: length ? Math.sqrt(sumSquares / length) : 0,
    peak,
    clippingRatio: length ? clipped / length : 0,
  };
}

async function runCalibrationTrial(voiceName) {
  const chunks = [];
  const start = performance.now();
  const telemetry = await runGenerationPipeline(
    voiceName,
    ['The reader continued through the quiet evening, listening carefully as the storm passed beyond the windows and the old house settled into a calm, familiar silence.'],
    [{ temp: BASE_TEMP, noiseClamp: 2.2, lsdSteps: 1, framesAfterEos: 4 }],
    chunks,
    { noYield: true, suppressPauses: true },
  );
  return {
    elapsedMs: performance.now() - start,
    firstSegmentMs: telemetry.firstSegmentMs,
    realTimeFactor: telemetry.realTimeFactor,
    quality: inspectCalibrationAudio(chunks),
  };
}

async function benchmarkCurrentBackend(voiceName, maxTimedMs) {
  const previousGenerating = isGenerating;
  isGenerating = true;
  try {
    const benchmarkStart = performance.now();
    await runCalibrationTrial(voiceName);
    const timings = [];
    const firstSegmentTimings = [];
    const realTimeFactors = [];
    const durationSeconds = [];
    const rmsValues = [];
    const peakValues = [];
    const clippingRatios = [];
    let finite = true;
    let failures = 0;
    for (let run = 0; run < 3; run += 1) {
      if (performance.now() - benchmarkStart > maxTimedMs) throw new Error('Backend calibration exceeded its 90-second inference budget.');
      const trial = await runCalibrationTrial(voiceName);
      timings.push(trial.elapsedMs);
      firstSegmentTimings.push(trial.firstSegmentMs);
      realTimeFactors.push(trial.realTimeFactor);
      const quality = trial.quality || {};
      const trialValid = quality.finite && quality.durationSec > 0 && quality.rms >= 0.0001;
      if (!trialValid) failures += 1;
      finite = finite && quality.finite === true;
      durationSeconds.push(Number(quality.durationSec || 0));
      rmsValues.push(Number(quality.rms || 0));
      peakValues.push(Number(quality.peak || 0));
      clippingRatios.push(Number(quality.clippingRatio || 0));
      postMessage({ type: 'calibration_progress', backend: currentBackend, run: run + 1, total: 3 });
    }
    return {
      backend: currentBackend,
      timings,
      medianMs: percentile(timings, 0.5),
      p95Ms: percentile(timings, 0.95),
      medianFirstSegmentMs: percentile(firstSegmentTimings, 0.5),
      p95FirstSegmentMs: percentile(firstSegmentTimings, 0.95),
      medianRealTimeFactor: percentile(realTimeFactors, 0.5),
      failures,
      finite,
      durationSec: percentile(durationSeconds, 0.5),
      rms: percentile(rmsValues, 0.5),
      peak: Math.max(...peakValues),
      clippingRatio: percentile(clippingRatios, 0.5),
      sessionCreationMs: Number(lastBackendTelemetry?.sessionCreationMs || 0),
    };
  } finally {
    isGenerating = previousGenerating;
  }
}

async function restoreVoiceForBackend(voiceName) {
  if (customVoiceStates.has(voiceName)) {
    await ensureCustomVoiceCached(voiceName, { force: true, statusText: `Preparing custom voice (${voiceName})...` });
  } else if (predefinedVoiceRecords[voiceName]) {
    await ensurePredefinedVoiceCached(voiceName, { force: true, statusText: `Preparing voice (${voiceName})...` });
  } else {
    throw new Error(`Calibration voice '${voiceName}' is unavailable.`);
  }
  currentVoiceName = voiceName;
}

async function fallbackToWasm(reason, { sustained = false } = {}) {
  const voiceName = currentVoiceName;
  gpuFailureCount += 1;
  postMessage({
    type: 'backend_fallback',
    from: currentBackend,
    to: 'wasm',
    reason,
    failures: gpuFailureCount,
    sustained,
    statusText: 'Switching to threaded WASM...',
  });
  // Generates that arrive during the reload queue instead of erroring; the
  // cache loop otherwise burns retries on "Models are not loaded yet".
  backendReloadInFlight = true;
  try {
    // Release GPU-resident graphs before loading INT8 to avoid a mobile OOM spike.
    try { await releaseAllSessions(); } catch (_) {}
    try { releaseGpuDevice(); } catch (_) {}
    measureWasmRtfSamples = 0;
    await loadBundle(DEFAULT_LANGUAGE, { backend: 'wasm' });
    if (voiceName) await restoreVoiceForBackend(voiceName);
  } finally {
    backendReloadInFlight = false;
  }
  setTimeout(processGenerationQueue, 0);
  return currentBackend;
}

async function calibrateBackends(voiceName) {
  const result = {
    calibrationVersion: POCKET_CALIBRATION_VERSION,
    ortVersion: POCKET_ORT_VERSION,
    wasmModelRevision: POCKET_WASM_MODEL_REVISION,
    webgpuModelRevision: POCKET_WEBGPU_MODEL_REVISION,
    selectedBackend: 'wasm',
    threadCount: runtimeThreadCount,
    rejectionReason: '',
    graphCapture: false,
    mimiProvider: 'wasm-threaded',
    gpuSyncGroupBlocks: WEBGPU_STEADY_SYNC_BLOCKS,
  };
  let benchmarkElapsedMs = 0;
  try {
    postMessage({ type: 'calibration_progress', stage: 'wasm', text: 'Testing threaded WASM...' });
    if (currentBackend !== 'wasm') await loadBundle(DEFAULT_LANGUAGE, { backend: 'wasm' });
    await restoreVoiceForBackend(voiceName);
    let started = performance.now();
    result.wasm = await benchmarkCurrentBackend(voiceName, 90000 - benchmarkElapsedMs);
    benchmarkElapsedMs += performance.now() - started;

    postMessage({ type: 'calibration_progress', stage: 'webgpu', text: 'Testing WebGPU FP16...' });
    await loadBundle(DEFAULT_LANGUAGE, {
      backend: 'webgpu',
      graphCapture: false,
      mimiProvider: 'wasm-threaded',
      syncGroupBlocks: WEBGPU_STEADY_SYNC_BLOCKS,
    });
    await restoreVoiceForBackend(voiceName);
    started = performance.now();
    const webGpuBaseline = {
      ...(await benchmarkCurrentBackend(voiceName, 90000 - benchmarkElapsedMs)),
      graphCapture: false,
      mimiProvider: 'wasm-threaded',
      gpuSyncGroupBlocks: WEBGPU_STEADY_SYNC_BLOCKS,
    };
    benchmarkElapsedMs += performance.now() - started;

    const webGpuVariants = [webGpuBaseline];
    if (WEBGPU_GRAPH_CAPTURE_SUPPORTED) {
      try {
        postMessage({ type: 'calibration_progress', stage: 'webgpu-graph', text: 'Testing WebGPU graph capture...' });
        await loadBundle(DEFAULT_LANGUAGE, {
          backend: 'webgpu',
          graphCapture: true,
          mimiProvider: 'wasm-threaded',
          syncGroupBlocks: WEBGPU_STEADY_SYNC_BLOCKS,
        });
        await restoreVoiceForBackend(voiceName);
        started = performance.now();
        webGpuVariants.push({
          ...(await benchmarkCurrentBackend(voiceName, 90000 - benchmarkElapsedMs)),
          graphCapture: true,
          mimiProvider: 'wasm-threaded',
          gpuSyncGroupBlocks: WEBGPU_STEADY_SYNC_BLOCKS,
        });
        benchmarkElapsedMs += performance.now() - started;
      } catch (error) {
        postMessage({ type: 'diagnostic', level: 'INFO', message: `WebGPU graph capture was rejected: ${error?.message || error}` });
      }
    }

    let variantSelection = selectWebGpuVariant(webGpuVariants, { baselineCandidate: webGpuBaseline });
    let selectedVariant = variantSelection.variant || webGpuBaseline;
    if (
      currentBackend !== 'webgpu'
      || webGpuGraphCaptureEnabled !== selectedVariant.graphCapture
      || currentMimiProvider !== 'wasm-threaded'
    ) {
      await loadBundle(DEFAULT_LANGUAGE, {
        backend: 'webgpu',
        graphCapture: selectedVariant.graphCapture,
        mimiProvider: 'wasm-threaded',
        syncGroupBlocks: WEBGPU_STEADY_SYNC_BLOCKS,
      });
      await restoreVoiceForBackend(voiceName);
    }

    try {
      postMessage({ type: 'calibration_progress', stage: 'webgpu-mimi', text: 'Testing GPU audio decoder...' });
      await switchMimiProvider('webgpu-mixed');
      started = performance.now();
      const gpuMimiVariant = {
        ...(await benchmarkCurrentBackend(voiceName, 90000 - benchmarkElapsedMs)),
        graphCapture: selectedVariant.graphCapture,
        mimiProvider: 'webgpu-mixed',
        gpuSyncGroupBlocks: WEBGPU_STEADY_SYNC_BLOCKS,
      };
      webGpuVariants.push(gpuMimiVariant);
      benchmarkElapsedMs += performance.now() - started;
      variantSelection = selectWebGpuVariant([selectedVariant, gpuMimiVariant], {
        baselineCandidate: selectedVariant,
      });
      selectedVariant = variantSelection.variant || selectedVariant;
    } catch (error) {
      postMessage({ type: 'diagnostic', level: 'INFO', message: `GPU Mimi was rejected: ${error?.message || error}` });
    }

    if (
      webGpuGraphCaptureEnabled !== selectedVariant.graphCapture
      || currentMimiProvider !== selectedVariant.mimiProvider
    ) {
      await loadBundle(DEFAULT_LANGUAGE, {
        backend: 'webgpu',
        graphCapture: selectedVariant.graphCapture,
        mimiProvider: selectedVariant.mimiProvider,
        syncGroupBlocks: selectedVariant.gpuSyncGroupBlocks,
      });
      await restoreVoiceForBackend(voiceName);
    }

    result.webgpuVariants = webGpuVariants.map((variant) => ({
      ...variant,
      timings: undefined,
    }));
    result.webgpu = selectedVariant;
    result.graphCapture = selectedVariant.graphCapture === true;
    result.mimiProvider = selectedVariant.mimiProvider || 'wasm-threaded';
    result.gpuSyncGroupBlocks = selectedVariant.gpuSyncGroupBlocks || WEBGPU_STEADY_SYNC_BLOCKS;

    const durationDelta = Math.abs(result.webgpu.durationSec - result.wasm.durationSec) / Math.max(0.001, result.wasm.durationSec);
    const rmsDelta = Math.abs(result.webgpu.rms - result.wasm.rms) / Math.max(0.0001, result.wasm.rms);
    if (durationDelta > 0.12 || rmsDelta > 0.40 || result.webgpu.clippingRatio > Math.max(0.01, result.wasm.clippingRatio + 0.005)) {
      result.webgpu.failures += 1;
      result.webgpu.qualityRejected = true;
    }
    const sessionLoadDelta = Math.max(0, result.webgpu.sessionCreationMs - result.wasm.sessionCreationMs);
    const projectedParagraphSavings = Math.max(0.001, result.wasm.medianMs - result.webgpu.medianMs);
    result.webgpu.breakEvenParagraphs = sessionLoadDelta / projectedParagraphSavings;
    const selection = selectCalibratedBackend(result.wasm, result.webgpu);
    result.selectedBackend = selection.selectedBackend;
    result.threadCount = runtimeThreadCount;
    result.rejectionReason = selection.reason || '';
    result.speedup = selection.speedup;
    result.breakEvenParagraphs = selection.breakEvenParagraphs;
  } catch (error) {
    result.selectedBackend = 'wasm';
    result.rejectionReason = error?.message || String(error);
  }

  const needsFinalReload = result.selectedBackend !== currentBackend
    || (result.selectedBackend === 'webgpu' && (
      webGpuGraphCaptureEnabled !== result.graphCapture
      || currentMimiProvider !== result.mimiProvider
      || gpuSyncGroupBlocks !== result.gpuSyncGroupBlocks
    ));
  if (needsFinalReload) {
    await loadBundle(DEFAULT_LANGUAGE, {
      backend: result.selectedBackend,
      graphCapture: result.graphCapture,
      mimiProvider: result.mimiProvider,
      syncGroupBlocks: result.gpuSyncGroupBlocks,
    });
    await restoreVoiceForBackend(voiceName);
  }
  lastBackendTelemetry = {
    ...(lastBackendTelemetry || {}),
    ...result,
    rejectionReason: result.rejectionReason,
  };
  postMessage({ type: 'calibration_result', result: lastBackendTelemetry });
  postMessage({ type: 'backend_selected', telemetry: lastBackendTelemetry });
  return result;
}

let generationQueue = [];
let activeGenerationJobId = null;
let backendReloadInFlight = false;
async function processGenerationQueue() {
  if (isGenerating || generationQueue.length === 0) return;
  const task = generationQueue.shift();
  try {
    await startGeneration(task.text, task.voice, task.jobId, task.opts);
  } catch (e) {
    console.error("Queue generation error:", e);
  }
}

self.onmessage = async (e) => {
  const data = e.data;
  const type = data.type;

  try {
    if (type === "init") {
      const isIosDevice = /iPhone|iPad|iPod/i.test(self.navigator?.userAgent || '');
      constrainedMemoryMode = data.constrainedMemoryMode === true || isIosDevice;
      requestedBackend = normalizePocketBackend(data.backendPreference);
      requestedWasmThreadCount = Number(data.wasmThreadCount) || 0;
      wasmReferenceRtf = Number(data.wasmReferenceRtf) || 0;
      const selectedBackend = data.selectedBackend === 'webgpu' ? 'webgpu' : 'wasm';
      const selectedGraphCapture = selectedBackend === 'webgpu' && data.graphCapture === true;
      const selectedMimiProvider = selectedBackend === 'webgpu' && data.mimiProvider === 'webgpu-mixed'
        ? 'webgpu-mixed'
        : 'wasm-threaded';
      try {
        await loadBundle(DEFAULT_LANGUAGE, {
          initialLoad: true,
          backend: selectedBackend,
          graphCapture: selectedGraphCapture,
          mimiProvider: selectedMimiProvider,
          syncGroupBlocks: data.gpuSyncGroupBlocks,
        });
      } catch (error) {
        if (selectedBackend !== 'webgpu') throw error;
        postMessage({ type: 'backend_fallback', from: 'webgpu', to: 'wasm', reason: error?.message || String(error), failures: 1 });
        await loadBundle(DEFAULT_LANGUAGE, { initialLoad: true, backend: 'wasm' });
      }
      postMessage({ type: 'init_done' });
      return;
    }

    if (type === 'probe_backend' || type === 'profile_backend') {
      postMessage({ type: 'backend_status', telemetry: lastBackendTelemetry || {
        selectedBackend: currentBackend,
        precision: currentModelPrecision,
        modelRevision: currentModelRevision,
        ortVersion: POCKET_ORT_VERSION,
        gpuResidentStateBytes: currentBackend === 'webgpu' ? POCKET_GPU_RESIDENT_STATE_BYTES : 0,
      } });
      return;
    }

    if (type === 'cancel_generation') {
      const targetId = data.id;
      // Queued-but-unstarted jobs are dropped here, so settle each one — the
      // main thread is holding a promise for every id it dispatched.
      const dropped = targetId == null
        ? generationQueue.splice(0)
        : generationQueue.filter((job) => job.jobId === targetId);
      if (targetId != null) generationQueue = generationQueue.filter((job) => job.jobId !== targetId);
      dropped.forEach((job) => postMessage({ type: 'generate_error', id: job.jobId, error: 'Generation was cancelled.' }));
      // Signal the running job cooperatively. Clearing isGenerating here would
      // drop the mutual exclusion that keeps two generations off the shared
      // ONNX sessions; the loops poll cancelRequested and unwind on their own.
      if (targetId == null || targetId === activeGenerationJobId) cancelRequested = true;
      postMessage({ type: 'generation_cancelled', id: targetId ?? null });
      return;
    }

    if (type === 'dispose_backend') {
      cancelRequested = true;
      generationQueue.splice(0).forEach((job) => {
        postMessage({ type: 'generate_error', id: job.jobId, error: 'Narration backend was disposed.' });
      });
      await releaseAllSessions();
      releaseGpuDevice();
      isReady = false;
      postMessage({ type: 'backend_disposed' });
      return;
    }

    if (type === 'calibrate_backend') {
      if (isGenerating) throw new Error('Cannot calibrate while narration is running.');
      const voiceName = String(data.voiceName || currentVoiceName || '').trim();
      if (!voiceName) throw new Error('Load a narration voice before backend calibration.');
      await calibrateBackends(voiceName);
      return;
    }

    if (type === 'set_backend') {
      if (isGenerating) throw new Error('Cannot switch backend while narration is running.');
      const backend = data.backend === 'webgpu' ? 'webgpu' : 'wasm';
      const voiceName = currentVoiceName;
      await loadBundle(DEFAULT_LANGUAGE, { backend });
      if (voiceName) await restoreVoiceForBackend(voiceName);
      return;
    }

    if (type === "set_language") {
      if (isGenerating) {
        postMessage({ type: "error", error: "Cannot switch language while generation is running." });
        return;
      }
      await loadBundle(data.language, { initialLoad: false });
      return;
    }

    if (type === "stop") {
      cancelRequested = true;
      // Settle every queued job before dropping it, or the main thread waits out
      // its per-job timeout for work that will never run.
      generationQueue.splice(0).forEach((job) => {
        postMessage({ type: 'generate_error', id: job.jobId, error: 'Narration was stopped.' });
      });
      postMessage({ type: "status", status: "Stopped", state: "idle" });
      return;
    }

    if (!isReady) {
      // During a backend-fallback reload, queue generates instead of erroring —
      // the reload finishes in seconds and processGenerationQueue drains them.
      if ((type === "generate" || type === 'stream_generate') && backendReloadInFlight) {
        const firstCustomVoice = customVoiceStates.size ? customVoiceStates.keys().next().value : null;
        generationQueue.push({
          text: data.text,
          voice: data.voice || currentVoiceName || firstCustomVoice,
          jobId: data.id,
          opts: type === 'stream_generate' ? { ...(data.opts || {}), streamSegments: true } : (data.opts || null),
        });
        return;
      }
      // A generate racing ahead of readiness must reject its specific job, or
      // the main thread's ttsQueue promise hangs until the 10-minute timeout.
      if (type === "generate") {
        postMessage({ type: "generate_error", id: data.id, error: "Models are not loaded yet." });
      } else {
        postMessage({ type: "error", error: "Models are not loaded yet." });
      }
      return;
    }

    if (type === "register_precompiled_voice") {
      const voiceName = String(data.voiceName || "custom").trim();
      customVoiceStates.set(voiceName, data.voiceState);
      touchCustomVoice(voiceName);
      currentVoiceName = voiceName;
      await ensureCustomVoiceCached(voiceName, { force: true, statusText: `Preparing custom voice (${voiceName})...` });
      evictConstrainedCustomVoices(voiceName);
      postMessage({ type: "voice_encoded", voiceName });
      if (!isGenerating) {
        postMessage({ type: "status", status: "Ready", state: "idle" });
      }
      return;
    }

    if (type === "set_voice") {
      if (customVoiceStates.has(data.voiceName) || (data.voiceName === "custom" && customVoiceStates.size === 1)) {
        const voiceName = data.voiceName === "custom" ? customVoiceStates.keys().next().value : data.voiceName;
        await ensureCustomVoiceCached(voiceName, { statusText: `Preparing custom voice (${voiceName})...` });
        currentVoiceName = voiceName;
      } else {
        await ensurePredefinedVoiceCached(data.voiceName, {
          statusText: `Preparing voice (${data.voiceName})...`,
        });
        currentVoiceName = data.voiceName;
      }
      postMessage({ type: "voice_set", voiceName: currentVoiceName });
      if (!isGenerating) {
        postMessage({ type: "status", status: "Ready", state: "idle" });
      }
      return;
    }

    if (type === "generate" || type === 'stream_generate') {
      const firstCustomVoice = customVoiceStates.size ? customVoiceStates.keys().next().value : null;
      const voiceName = data.voice || currentVoiceName || firstCustomVoice;
      generationQueue.push({
        text: data.text,
        voice: voiceName,
        jobId: data.id,
        opts: type === 'stream_generate' ? { ...(data.opts || {}), streamSegments: true } : (data.opts || null),
      });
      processGenerationQueue();
    }
  } catch (err) {
    console.error("Worker error:", err);
    // stream_generate must settle as generate_error too. It used to fall through
    // to a bare 'error' with no id, which the main thread cannot match to the
    // promise it parked in ttsQueue -- so a streamed paragraph that threw here
    // hung until the generation timeout instead of failing fast.
    const isGenerateJob = data?.type === "generate" || data?.type === "stream_generate";
    const errorType = data?.type === "init" ? "init_error" : (isGenerateJob ? "generate_error" : "error");
    postMessage({ type: errorType, id: data?.id, error: err?.message || String(err) });
  }
};

async function startGeneration(text, voiceName, jobId, opts) {
  isGenerating = true;
  cancelRequested = false;
  activeGenerationJobId = jobId;
  // The main thread parks a promise in ttsQueue[jobId] and only resolves it on
  // 'complete' or 'generate_error'. Anything that returns from here without one
  // of those strands that promise until _runPocketWorkerGeneration's timeout --
  // 60s in the foreground, 600s backgrounded, after which the whole engine is
  // reset. So every exit path must settle the job exactly once.
  let jobSettled = false;
  const settleWithAudio = (audio, telemetry) => {
    if (jobSettled) return;
    jobSettled = true;
    postMessage({ type: 'complete', id: jobId, audio, sampleRate: currentSampleRate, telemetry }, [audio.buffer]);
  };
  const settleWithError = (error) => {
    if (jobSettled) return;
    jobSettled = true;
    postMessage({ type: 'generate_error', id: jobId, error: String(error) });
  };
  postMessage({ type: "status", status: "Generating...", state: "running" });
  postMessage({ type: "generation_started", data: { time: performance.now() } });

  const allChunks = [];

  try {
    const { chunks, chunkMeta, punctuationSplitCount } = splitIntoBestSentences(text, opts);
    if (!chunks.length) {
      throw new Error("No text to generate");
    }
    if (!voiceName) {
      throw new Error("No Pocket voice is loaded. Register a custom voice before generating audio.");
    }

    if (customVoiceStates.has(voiceName) || (voiceName === "custom" && customVoiceStates.size === 1)) {
      voiceName = voiceName === "custom" ? customVoiceStates.keys().next().value : voiceName;
      await ensureCustomVoiceCached(voiceName, { statusText: `Preparing custom voice (${voiceName})...` });
    } else {
      await ensurePredefinedVoiceCached(voiceName, {
        statusText: `Preparing voice (${voiceName})...`,
      });
    }
    currentVoiceName = voiceName;

    let pipelineTelemetry = null;
    try {
      if (gpuDeviceLost && currentBackend === 'webgpu') throw new Error('WebGPU device was lost.');
      pipelineTelemetry = await runGenerationPipeline(voiceName, chunks, chunkMeta, allChunks, {
        jobId,
        streamSegments: opts?.streamSegments === true,
        throughputMode: opts?.throughputMode === true,
        punctuationSplitCount,
        seedSalt: Number(opts?.retryLevel) > 0 ? ('|r' + Number(opts.retryLevel)) : '',
      });
      const quality = inspectCalibrationAudio(allChunks);
      if (currentBackend === 'webgpu' && (!quality.finite || quality.rms < 0.0001)) {
        throw new Error('WebGPU produced invalid or silent audio.');
      }
    } catch (backendError) {
      if (currentBackend !== 'webgpu') throw backendError;
      allChunks.length = 0;
      await fallbackToWasm(backendError?.message || String(backendError));
      pipelineTelemetry = await runGenerationPipeline(voiceName, chunks, chunkMeta, allChunks, {
        jobId,
        streamSegments: opts?.streamSegments === true,
        throughputMode: opts?.throughputMode === true,
        punctuationSplitCount,
        seedSalt: Number(opts?.retryLevel) > 0 ? ('|r' + Number(opts.retryLevel)) : '',
      });
    }

    if (allChunks.length > 0) {
      const totalLength = allChunks.reduce((acc, c) => acc + c.length, 0);
      const combined = new Float32Array(totalLength);
      let offset = 0;
      for (const c of allChunks) {
        combined.set(c, offset);
        offset += c.length;
      }
      settleWithAudio(combined, pipelineTelemetry);
    } else if (cancelRequested) {
      settleWithError('Generation was cancelled.');
    } else {
      // The pipeline ran to completion but every chunk was skipped -- the usual
      // cause is text that tokenizes to nothing (a scene break like "* * *", a
      // line of ellipses, an emoji-only paragraph). This used to post nothing at
      // all and strand the caller on its timeout.
      settleWithError('This paragraph produced no speakable audio.');
    }

    // Sustained-latency fallback: keep this paragraph's audio, but if WebGPU
    // repeatedly generates at or worse than the WASM reference RTF (modeled or
    // previously measured), demote the session to WASM before the next job.
    if (currentBackend === 'webgpu' && pipelineTelemetry) {
      webGpuSustainedHistory.push({
        realTimeFactor: pipelineTelemetry.realTimeFactor,
        audioDurationSec: pipelineTelemetry.audioDurationSec,
      });
      if (webGpuSustainedHistory.length > 8) webGpuSustainedHistory.shift();
      if (shouldDemoteWebGpuSustained(webGpuSustainedHistory, {
        wasmReferenceRtf,
        parityRatio: POCKET_WEBGPU_WASM_PARITY_RATIO,
      })) {
        const lastRtf = webGpuSustainedHistory[webGpuSustainedHistory.length - 1]?.realTimeFactor;
        webGpuSustainedHistory = [];
        const wasmLabel = Number.isFinite(wasmReferenceRtf) && wasmReferenceRtf > 0
          ? `WASM RTF ${wasmReferenceRtf.toFixed(2)}`
          : 'real time';
        await fallbackToWasm(`WebGPU fell behind ${wasmLabel} (RTF ${Number(lastRtf).toFixed(2)}).`, { sustained: true });
      }
    } else if (currentBackend === 'wasm' && pipelineTelemetry) {
      webGpuSustainedHistory = [];
      // After a demotion (or any WASM session), capture measured RTF so future
      // parity checks use device reality instead of the Pixel-anchored model.
      if (
        measureWasmRtfSamples < 2
        && Number.isFinite(pipelineTelemetry.realTimeFactor)
        && Number(pipelineTelemetry.audioDurationSec || 0) >= 2
      ) {
        measureWasmRtfSamples += 1;
        postMessage({
          type: 'wasm_rtf_sample',
          realTimeFactor: pipelineTelemetry.realTimeFactor,
          audioDurationSec: pipelineTelemetry.audioDurationSec,
        });
        if (Number.isFinite(pipelineTelemetry.realTimeFactor) && pipelineTelemetry.realTimeFactor > 0) {
          wasmReferenceRtf = pipelineTelemetry.realTimeFactor;
        }
      }
    } else if (currentBackend !== 'webgpu' && webGpuSustainedHistory.length) {
      webGpuSustainedHistory = [];
    }
  } catch (err) {
    console.error("Generation error:", err);
    settleWithError(err?.message || err);
  } finally {
    // Backstop: whatever happened above, this job must not be left hanging.
    settleWithError('Generation ended without producing audio.');
    isGenerating = false;
    cancelRequested = false;
    activeGenerationJobId = null;
    postMessage({ type: "status", status: "Finished", state: "idle" });
    setTimeout(processGenerationQueue, 0); // Sequentially trigger the next task
  }
}

async function runGenerationPipeline(voiceName, chunks, chunkMeta, allChunks, control = {}) {
  // Quality-guard retry salt. Normal renders (retryLevel 0) carry no salt, so
  // audio stays byte-identical across renders/cache rebuilds. On a retry the
  // salt shifts the deterministic latent noise so a paragraph the guard just
  // fatal-rejected can render *differently* and recover, instead of the
  // identical seed reproducing the exact same rejected take forever.
  const seedSalt = control && control.seedSalt ? String(control.seedSalt) : '';
  if (
    currentBackend === 'wasm'
    && chunkMeta.some((meta) => Number(meta?.lsdSteps || DEFAULT_LSD_STEPS) > 1)
  ) {
    await ensurePerFrameFlowSessions();
  }
  let mimiState = initStateFromManifest(bundleMetadata.mimi_state_manifest);
  const emptySeq = createTensor("float32", new Float32Array(0), [1, 0, currentLatentDim]);
  const emptyTextEmb = createTensor("float32", new Float32Array(0), [1, 0, currentConditioningDim]);
  const baseFlowState = voiceConditioningCache.get(voiceName);
  if (!baseFlowState) {
    throw new Error(`Voice conditioning cache missing for '${voiceName}'.`);
  }
  const protectedBaseFlowTensors = new Set(Object.values(baseFlowState));
  let flowLmState = cloneState(baseFlowState);

  // Cache jobs on the WASM path decode Mimi in 48-frame batches instead of 12:
  // every decoder call round-trips ~16MB of conv state across the JS/WASM
  // boundary, so 4x fewer calls is a direct win, and first-audio latency is
  // irrelevant while background-caching. Verified equivalent on fp32
  // (tools/verify_mimi_batch.py); int8 output differs only at dynamic-quant
  // noise level, which decode-size variation already introduces today.
  const throughputBatch = control.throughputMode === true
    && currentBackend !== 'webgpu' && !control.streamSegments;
  const firstChunkFrames = throughputBatch ? 48 : (currentBackend === 'webgpu' ? 1 : 3);
  const normalChunkFrames = throughputBatch ? 48 : 12;
  let isFirstAudioChunk = true;
  let totalTokenizationTime = 0;
  let totalTextConditioningTime = 0;
  let totalPrefillTime = 0;
  let totalArTime = 0;
  let totalFlowMatchingTime = 0;
  let totalGpuCoreTime = 0;
  let totalDecodeTime = 0;
  let totalFrames = 0;
  let frameBudgetStops = 0;
  let firstSegmentMs = null;
  let segmentIndex = 0;
  let usedWasmBlock = false;
  let usedWasmUnified = false;
  let gpuReadbacks = 0;
  let gpuSynchronizationPoints = 0;
  let textConditioningRuns = 0;
  let prefillRuns = 0;
  const punctuationSplitCount = Math.max(0, Number(control.punctuationSplitCount) || 0);
  const generationStart = performance.now();
  // Throttled intra-paragraph progress so the caching UI can tick during long
  // renders instead of freezing until the paragraph completes.
  let lastProgressPostAt = 0;
  const postGenerationProgress = () => {
    const now = performance.now();
    if (now - lastProgressPostAt < 1000) return;
    lastProgressPostAt = now;
    postMessage({
      type: 'generation_progress',
      id: control.jobId,
      frames: totalFrames,
      elapsedMs: Math.round(now - generationStart),
      backend: currentBackend,
    });
  };
  const appendOutputChunk = (chunk, audible = true) => {
    allChunks.push(chunk);
    if (audible && firstSegmentMs == null) firstSegmentMs = performance.now() - generationStart;
    if (!control.streamSegments) return;
    const segment = chunk.slice();
    postMessage({
      type: 'audio_segment',
      id: control.jobId,
      segmentIndex,
      audio: segment,
      sampleRate: currentSampleRate,
      firstSegmentMs: firstSegmentMs == null ? null : Math.round(firstSegmentMs),
      audible,
    }, [segment.buffer]);
    segmentIndex += 1;
  };
  const mimiInputTensors = new Map();
  const getMimiInputTensor = (latents, firstFrame, frameCount) => {
    let tensor = mimiInputTensors.get(frameCount);
    if (!tensor) {
      tensor = createTensor(
        'float32',
        new Float32Array(frameCount * currentLatentDim),
        [1, frameCount, currentLatentDim],
      );
      mimiInputTensors.set(frameCount, tensor);
    }
    for (let frame = 0; frame < frameCount; frame++) {
      tensor.data.set(latents[firstFrame + frame], frame * currentLatentDim);
    }
    return tensor;
  };

  try {
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    if (!generationShouldContinue()) break;

    const meta = (chunkMeta && chunkMeta[chunkIdx]) || {};
    const framesAfterEos = meta.framesAfterEos != null ? meta.framesAfterEos : 0;
    const chunkTemp = meta.temp != null ? meta.temp : BASE_TEMP;
    const chunkNoiseClamp = meta.noiseClamp != null ? meta.noiseClamp : null;
    const chunkLsdSteps = Math.max(1, Math.min(BENCHMARK_QUALITY_LSD_STEPS, Number(meta.lsdSteps) || DEFAULT_LSD_STEPS));
    const flowStepTensors = getFlowStepTensors(chunkLsdSteps);

    // Pause-only unit (explicit [Ns] tag with no surrounding text): emit silence.
    if (meta.pauseOnly) {
      const ps = Math.max(1, Math.floor((meta.pauseAfterSec || 0) * currentSampleRate));
      appendOutputChunk(new Float32Array(ps), false);
      continue;
    }

    if (RESET_FLOW_STATE_EACH_CHUNK && chunkIdx > 0) {
      disposeGpuState(flowLmState, protectedBaseFlowTensors);
      flowLmState = cloneState(baseFlowState);
    }
    if (RESET_MIMI_STATE_EACH_CHUNK && chunkIdx > 0) {
      disposeGpuState(mimiState);
      mimiState = initStateFromManifest(bundleMetadata.mimi_state_manifest);
    }

    const chunkText = chunks[chunkIdx];
    // Deterministic per-chunk seed for the flow-model latent noise. Keying it on
    // (voice, emotion, text) makes identical content always render identical
    // audio — the same line never varies in tone between renders or between
    // paragraphs — so variation comes only from real emotion/punctuation/text
    // differences, and re-renders / cache rebuilds match exactly. All three
    // generation paths (WebGPU block, WASM block, per-frame streaming) seed from
    // this, so behaviour is uniform across devices and quality modes.
    const chunkNoiseSeed = voiceName + '|' + (meta.emotion || 'neutral') + '|' + chunkText + seedSalt;
    let isFirstAudioChunkOfTextChunk = true;
    const tokenizationStart = performance.now();
    const tokenIds = tokenizerProcessor.encodeIds(chunkText);
    totalTokenizationTime += performance.now() - tokenizationStart;
    if (tokenIds.length === 0) continue;

    const textInput = createTensor(
      "int64",
      BigInt64Array.from(tokenIds.map((token) => BigInt(token))),
      [1, tokenIds.length]
    );

    const textConditioningStart = performance.now();
    textConditioningRuns += 1;
    let textEmb = (await textConditionerSession.run({ token_ids: textInput }))[textConditionerSession.outputNames[0]];
    totalTextConditioningTime += performance.now() - textConditioningStart;
    if (textEmb.dims.length === 2) {
      textEmb = textEmb.reshape([1, textEmb.dims[0], textEmb.dims[1]]);
    }

    const prefillStart = performance.now();
    prefillRuns += 1;
    const condResult = flowLmUnifiedSession
      ? await flowLmUnifiedSession.run({
          decode_mode: wasmUnifiedPrefillMode,
          sequence: wasmUnifiedBosTensor,
          random_latents: wasmUnifiedZeroRandom,
          text_embeddings: textEmb,
          ...flowLmState,
        })
      : await flowLmMainSession.run({
          sequence: emptySeq,
          text_embeddings: textEmb,
          ...flowLmState,
        });
    totalPrefillTime += performance.now() - prefillStart;
    updateStateFromManifestOutputs(
      flowLmState,
      condResult,
      bundleMetadata.flow_lm_state_manifest,
      protectedBaseFlowTensors,
    );
    disposeTensor(textEmb);
    disposeUnownedOutputs(condResult, stateOutputNames(bundleMetadata.flow_lm_state_manifest));

    const chunkLatents = [];
    let chunkDecodedFrames = 0;
    let eosStep = null;
    let chunkEnded = false;
    let chunkGenTimeMs = 0;

    const chunkMaxFrames = constrainedMemoryMode ? CONSTRAINED_MAX_FRAMES : MAX_FRAMES;
    const frameLimit = control.frameLimit
      ? Math.max(1, Math.min(chunkMaxFrames, Number(control.frameLimit) || chunkMaxFrames))
      : computePocketFrameBudget({
          wordCount: _wordCount(chunkText),
          tokenCount: tokenIds.length,
          tailFrames: framesAfterEos,
          maxFrames: chunkMaxFrames,
        });
    if (currentBackend === 'webgpu') {
      if (!flowLmDecodeBlockSession || !webGpuBosSequence) throw new Error('WebGPU R3 core is not initialized.');
      if (chunkLsdSteps !== 1) throw new Error('WebGPU R3 supports the standard one-step quality path only.');
      let currentSequence = createTensor('float32', new Float32Array(webGpuBosSequence.data), webGpuBosSequence.shape);
      const webGpuRandomTensor = createTensor(
        'float32',
        new Float32Array(WEBGPU_BLOCK_FRAMES * currentLatentDim),
        [1, WEBGPU_BLOCK_FRAMES, currentLatentDim],
      );
      const ownedBlockOutputs = new Set([...stateOutputNames(bundleMetadata.flow_lm_state_manifest), 'next_sequence']);
      seedRandom(chunkNoiseSeed);
      try {
        let blockCursor = 0;
        while (blockCursor < frameLimit && !chunkEnded && generationShouldContinue()) {
          // First audio synchronizes after one block. Once playback can start,
          // queue several fixed-shape blocks before one grouped GPU download.
          const targetBlocks = isFirstAudioChunk ? 1 : gpuSyncGroupBlocks;
          const pendingBlocks = [];
          for (let groupIndex = 0; groupIndex < targetBlocks && blockCursor < frameLimit; groupIndex += 1) {
            const blockStart = blockCursor;
            const std = Math.sqrt(chunkTemp);
            const clampAbs = chunkNoiseClamp != null ? chunkNoiseClamp * std : null;
            const randomLatents = webGpuRandomTensor.data;
            for (let index = 0; index < randomLatents.length; index++) {
              let u = 0;
              let v = 0;
              while (u === 0) u = seededRandom();
              while (v === 0) v = seededRandom();
              let sample = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * std;
              if (clampAbs != null) sample = Math.max(-clampAbs, Math.min(clampAbs, sample));
              randomLatents[index] = sample;
            }

            const coreStart = performance.now();
            const blockResult = await flowLmDecodeBlockSession.run({
              sequence: currentSequence,
              random_latents: webGpuRandomTensor,
              ...flowLmState,
            });
            const coreElapsed = performance.now() - coreStart;
            totalGpuCoreTime += coreElapsed;
            chunkGenTimeMs += coreElapsed;

            const previousSequence = currentSequence;
            currentSequence = blockResult.next_sequence;
            disposeTensor(previousSequence);
            updateStateFromManifestOutputs(
              flowLmState,
              blockResult,
              bundleMetadata.flow_lm_state_manifest,
              protectedBaseFlowTensors,
            );
            disposeUnownedOutputs(blockResult, new Set([...ownedBlockOutputs, 'latents', 'eos_logits']));
            pendingBlocks.push({
              blockStart,
              latents: blockResult.latents,
              eosLogits: blockResult.eos_logits,
            });
            blockCursor += WEBGPU_BLOCK_FRAMES;
          }

          const downloaded = await Promise.all(pendingBlocks.map(async (pending) => {
            const [latentData, eosData] = await Promise.all([
              readTensorData(pending.latents),
              readTensorData(pending.eosLogits),
            ]);
            return { ...pending, latentData, eosData };
          }));
          gpuSynchronizationPoints += 1;
          gpuReadbacks += pendingBlocks.length * 2;

          for (const block of downloaded) {
            let acceptedFrames = Math.min(WEBGPU_BLOCK_FRAMES, frameLimit - block.blockStart);
            for (let index = 0; index < acceptedFrames; index++) {
              if (eosStep == null && block.eosData[index] > -4.0) eosStep = block.blockStart + index;
            }
            if (eosStep != null) {
              acceptedFrames = Math.min(
                acceptedFrames,
                Math.max(0, eosStep + framesAfterEos - block.blockStart + 1),
              );
            }
            for (let index = 0; index < acceptedFrames; index++) {
              const offset = index * currentLatentDim;
              chunkLatents.push(new Float32Array(block.latentData.slice(offset, offset + currentLatentDim)));
            }
            totalFrames += acceptedFrames;
            postGenerationProgress();
            disposeTensor(block.latents);
            disposeTensor(block.eosLogits);

            const reachedFrameBudget = block.blockStart + acceptedFrames >= frameLimit;
            const eosTailComplete = eosStep != null
              && block.blockStart + acceptedFrames - 1 >= eosStep + framesAfterEos;
            const shouldStop = reachedFrameBudget || eosTailComplete;
            if (!control.frameLimit && reachedFrameBudget && !eosTailComplete) frameBudgetStops += 1;

            const pending = chunkLatents.length - chunkDecodedFrames;
            let decodeSize = 0;
            if (shouldStop) decodeSize = pending;
            else if (isFirstAudioChunk && pending >= firstChunkFrames) decodeSize = firstChunkFrames;
            else if (pending >= normalChunkFrames) decodeSize = normalChunkFrames;

            if (decodeSize > 0) {
              const latentTensor = getMimiInputTensor(chunkLatents, chunkDecodedFrames, decodeSize);
              const decoderStart = performance.now();
              const decodeResult = await mimiDecoderSession.run({ latent: latentTensor, ...mimiState });
              const decoderElapsed = performance.now() - decoderStart;
              totalDecodeTime += decoderElapsed;
              if (currentMimiProvider === 'webgpu-mixed') {
                gpuReadbacks += 1;
                gpuSynchronizationPoints += 1;
              }
              updateStateFromManifestOutputs(mimiState, decodeResult, bundleMetadata.mimi_state_manifest);
              chunkDecodedFrames += decodeSize;
              const audioFloat32 = new Float32Array(decodeResult[mimiDecoderSession.outputNames[0]].data);
              disposeUnownedOutputs(decodeResult, stateOutputNames(bundleMetadata.mimi_state_manifest));

              const fadeSamples = Math.min(Math.floor((10 * currentSampleRate) / 1000), Math.floor(audioFloat32.length / 2));
              if (fadeSamples > 0) {
                if (isFirstAudioChunkOfTextChunk) {
                  for (let index = 0; index < fadeSamples; index++) audioFloat32[index] *= index / fadeSamples;
                }
                if (shouldStop) {
                  for (let index = 0; index < fadeSamples; index++) audioFloat32[audioFloat32.length - 1 - index] *= index / fadeSamples;
                }
              }
              appendOutputChunk(audioFloat32, true);
              isFirstAudioChunk = false;
              isFirstAudioChunkOfTextChunk = false;
            }

            if (shouldStop) {
              chunkEnded = true;
              break;
            }
          }

          // A grouped run can contain work past EOS. Those outputs were never
          // accepted, but must still be released before leaving the chunk.
          for (const block of downloaded) {
            disposeTensor(block.latents);
            disposeTensor(block.eosLogits);
          }
        }
      } finally {
        disposeTensor(currentSequence);
        disposeTensor(webGpuRandomTensor);
      }
    } else if ((flowLmUnifiedSession || flowLmWasmBlockSession) && wasmBlockBosSequence && chunkLsdSteps === 1) {
      // WASM decode-block path: four AR frames per session.run(). The flow-LM
      // state (~47MB fp32) crosses the JS/WASM boundary once per block instead
      // of once per frame. Falls through to the per-frame path only for
      // benchmark-quality LSD>1 requests or when the block asset is absent.
      usedWasmBlock = true;
      usedWasmUnified = Boolean(flowLmUnifiedSession);
      const wasmBlockSession = flowLmUnifiedSession || flowLmWasmBlockSession;
      const std = Math.sqrt(chunkTemp);
      const clampAbs = chunkNoiseClamp != null ? chunkNoiseClamp * std : null;
      let currentSequence = createTensor('float32', new Float32Array(wasmBlockBosSequence.data), [1, 1, currentLatentDim]);
      const wasmRandomTensor = createTensor(
        'float32',
        new Float32Array(WASM_BLOCK_FRAMES * currentLatentDim),
        [1, WASM_BLOCK_FRAMES, currentLatentDim],
      );
      const ownedBlockOutputs = new Set([...stateOutputNames(bundleMetadata.flow_lm_state_manifest), 'next_sequence']);
      seedRandom(chunkNoiseSeed);
      try {
        let blockCursor = 0;
        while (blockCursor < frameLimit && !chunkEnded && generationShouldContinue()) {
          const randomLatents = wasmRandomTensor.data;
          for (let index = 0; index < randomLatents.length; index++) {
            let u = 0;
            let v = 0;
            while (u === 0) u = seededRandom();
            while (v === 0) v = seededRandom();
            let sample = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * std;
            if (clampAbs != null) sample = Math.max(-clampAbs, Math.min(clampAbs, sample));
            randomLatents[index] = sample;
          }
          const stepStart = performance.now();
          const blockFeeds = {
            sequence: currentSequence,
            random_latents: wasmRandomTensor,
            ...flowLmState,
          };
          if (flowLmUnifiedSession) {
            blockFeeds.decode_mode = wasmUnifiedDecodeMode;
            blockFeeds.text_embeddings = emptyTextEmb;
          }
          const blockResult = flowLmUnifiedSession
            ? await flowLmUnifiedSession.run(blockFeeds)
            : await wasmBlockSession.run(blockFeeds);
          const stepElapsed = performance.now() - stepStart;
          totalArTime += stepElapsed;
          chunkGenTimeMs += stepElapsed;

          const previousSequence = currentSequence;
          currentSequence = blockResult.next_sequence;
          disposeTensor(previousSequence);
          updateStateFromManifestOutputs(
            flowLmState,
            blockResult,
            bundleMetadata.flow_lm_state_manifest,
            protectedBaseFlowTensors,
          );
          const latentData = blockResult.latents.data;
          const eosData = blockResult.eos_logits.data;
          disposeUnownedOutputs(blockResult, new Set([...ownedBlockOutputs, 'latents', 'eos_logits']));

          let acceptedFrames = Math.min(WASM_BLOCK_FRAMES, frameLimit - blockCursor);
          for (let index = 0; index < acceptedFrames; index++) {
            if (eosStep == null && eosData[index] > -4.0) eosStep = blockCursor + index;
          }
          if (eosStep != null) {
            acceptedFrames = Math.min(
              acceptedFrames,
              Math.max(0, eosStep + framesAfterEos - blockCursor + 1),
            );
          }
          for (let index = 0; index < acceptedFrames; index++) {
            const offset = index * currentLatentDim;
            chunkLatents.push(latentData.slice(offset, offset + currentLatentDim));
          }
          totalFrames += acceptedFrames;
          postGenerationProgress();
          disposeTensor(blockResult.latents);
          disposeTensor(blockResult.eos_logits);

          const reachedFrameBudget = blockCursor + acceptedFrames >= frameLimit;
          const eosTailComplete = eosStep != null
            && blockCursor + acceptedFrames - 1 >= eosStep + framesAfterEos;
          const shouldStop = reachedFrameBudget || eosTailComplete;
          if (!control.frameLimit && reachedFrameBudget && !eosTailComplete) frameBudgetStops += 1;
          blockCursor += WASM_BLOCK_FRAMES;

          const pending = chunkLatents.length - chunkDecodedFrames;
          let decodeSize = 0;
          if (shouldStop) decodeSize = pending;
          else if (isFirstAudioChunk && pending >= firstChunkFrames) decodeSize = firstChunkFrames;
          else if (pending >= normalChunkFrames) decodeSize = normalChunkFrames;

          if (decodeSize > 0) {
            const decoderStart = performance.now();
            const decodeResult = await mimiDecoderSession.run({
              latent: getMimiInputTensor(chunkLatents, chunkDecodedFrames, decodeSize),
              ...mimiState,
            });
            const decoderElapsed = performance.now() - decoderStart;
            chunkGenTimeMs += decoderElapsed;
            totalDecodeTime += decoderElapsed;
            updateStateFromManifestOutputs(mimiState, decodeResult, bundleMetadata.mimi_state_manifest);
            chunkDecodedFrames += decodeSize;
            const audioFloat32 = new Float32Array(decodeResult[mimiDecoderSession.outputNames[0]].data);
            disposeUnownedOutputs(decodeResult, stateOutputNames(bundleMetadata.mimi_state_manifest));

            const fadeSamples = Math.min(Math.floor((10 * currentSampleRate) / 1000), Math.floor(audioFloat32.length / 2));
            if (fadeSamples > 0) {
              if (isFirstAudioChunkOfTextChunk) {
                for (let index = 0; index < fadeSamples; index++) audioFloat32[index] *= index / fadeSamples;
              }
              if (shouldStop) {
                for (let index = 0; index < fadeSamples; index++) audioFloat32[audioFloat32.length - 1 - index] *= index / fadeSamples;
              }
            }
            appendOutputChunk(audioFloat32, true);
            isFirstAudioChunk = false;
            isFirstAudioChunkOfTextChunk = false;
            chunkGenTimeMs = 0;
          }

          if (shouldStop) {
            chunkEnded = true;
          }
        }
      } finally {
        disposeTensor(currentSequence);
        disposeTensor(wasmRandomTensor);
      }
    } else {
      const currentLatentData = new Float32Array(currentLatentDim);
      currentLatentData.fill(NaN);
      const currentLatent = createTensor('float32', currentLatentData, [1, 1, currentLatentDim]);
      const flowLatentInput = createTensor('float32', currentLatentData, [1, currentLatentDim]);
      // Seed the per-frame latent noise the same way the block paths do, so this
      // path is deterministic too (it previously drew from Math.random(), which
      // made the same text render with a different tone every time).
      seedRandom(chunkNoiseSeed);
      for (let step = 0; step < frameLimit; step++) {
      if (!generationShouldContinue()) break;
      const stepStart = performance.now();
      const arResult = await flowLmMainSession.run({
        sequence: currentLatent,
        text_embeddings: emptyTextEmb,
        ...flowLmState,
      });
      const stepElapsed = performance.now() - stepStart;
      chunkGenTimeMs += stepElapsed;
      totalArTime += stepElapsed;

      const conditioning = arResult.conditioning;
      const eosLogit = arResult.eos_logit.data[0];
      if (currentBackend === 'webgpu') gpuReadbacks += 1;
      const isEos = eosLogit > -4.0;
      if (isEos && eosStep == null) {
        eosStep = step;
      }
      const reachedFrameBudget = step + 1 >= frameLimit;
      const shouldStop = reachedFrameBudget || (eosStep != null && step >= eosStep + framesAfterEos);
      totalFrames++;
      postGenerationProgress();
      const eosTailComplete = eosStep != null && step >= eosStep + framesAfterEos;
      if (!control.frameLimit && reachedFrameBudget && !eosTailComplete) frameBudgetStops++;

      // Per-chunk expressive steering: emotion sets the sampling temperature
      // (latent variance) and an optional clamp on the gaussian noise. With
      // steering off these are BASE_TEMP / unclamped — identical to before.
      const std = Math.sqrt(chunkTemp);
      const clampAbs = chunkNoiseClamp != null ? chunkNoiseClamp * std : null;
      for (let i = 0; i < currentLatentDim; i++) {
        let u = 0;
        let v = 0;
        while (u === 0) u = seededRandom();
        while (v === 0) v = seededRandom();
        let sample = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * std;
        if (clampAbs != null) sample = Math.max(-clampAbs, Math.min(clampAbs, sample));
        currentLatentData[i] = sample;
      }

      const dt = 1.0 / chunkLsdSteps;
      for (let lsdIndex = 0; lsdIndex < chunkLsdSteps; lsdIndex++) {
        const flowStart = performance.now();
        const flowResult = await flowLmFlowSession.run({
          c: conditioning,
          s: flowStepTensors[lsdIndex].s,
          t: flowStepTensors[lsdIndex].t,
          x: flowLatentInput,
        });
        const flowDir = flowResult.flow_dir.data;
        totalFlowMatchingTime += performance.now() - flowStart;
        if (currentBackend === 'webgpu') gpuReadbacks += 1;
        for (let i = 0; i < currentLatentDim; i++) {
          currentLatentData[i] += flowDir[i] * dt;
        }
      }

      chunkLatents.push(new Float32Array(currentLatentData));
      updateStateFromManifestOutputs(
        flowLmState,
        arResult,
        bundleMetadata.flow_lm_state_manifest,
        protectedBaseFlowTensors,
      );
      disposeTensor(conditioning);
      disposeUnownedOutputs(arResult, stateOutputNames(bundleMetadata.flow_lm_state_manifest));

      const pending = chunkLatents.length - chunkDecodedFrames;
      let decodeSize = 0;
      if (shouldStop) {
        decodeSize = pending;
      } else if (isFirstAudioChunk && pending >= firstChunkFrames) {
        decodeSize = firstChunkFrames;
      } else if (pending >= normalChunkFrames) {
        decodeSize = normalChunkFrames;
      }

      if (decodeSize > 0) {
        const decoderStart = performance.now();
        const decodeResult = await mimiDecoderSession.run({
          latent: getMimiInputTensor(chunkLatents, chunkDecodedFrames, decodeSize),
          ...mimiState,
        });
        const decoderElapsed = performance.now() - decoderStart;
        chunkGenTimeMs += decoderElapsed;
        totalDecodeTime += decoderElapsed;

        updateStateFromManifestOutputs(mimiState, decodeResult, bundleMetadata.mimi_state_manifest);

        chunkDecodedFrames += decodeSize;
        const audioFloat32 = new Float32Array(decodeResult[mimiDecoderSession.outputNames[0]].data);
        disposeUnownedOutputs(decodeResult, stateOutputNames(bundleMetadata.mimi_state_manifest));

        // Apply a subtle fade-in / fade-out to prevent transient boundary clicks/pops
        const fadeMs = 10;
        const fadeSamples = Math.min(Math.floor((fadeMs * currentSampleRate) / 1000), Math.floor(audioFloat32.length / 2));
        if (fadeSamples > 0) {
          if (isFirstAudioChunkOfTextChunk) {
            for (let i = 0; i < fadeSamples; i++) {
              audioFloat32[i] *= (i / fadeSamples);
            }
          }
          if (shouldStop) {
            for (let i = 0; i < fadeSamples; i++) {
              audioFloat32[audioFloat32.length - 1 - i] *= (i / fadeSamples);
            }
          }
        }

        appendOutputChunk(audioFloat32, true);

        isFirstAudioChunk = false;
        isFirstAudioChunkOfTextChunk = false;
        chunkGenTimeMs = 0;
      }

      if (shouldStop) {
        chunkEnded = true;
        break;
      }
      }
    }

    // Inter-chunk silence: punctuation/emotion-aware when enabled, else the
    // original fixed gap. Skipped after the final chunk unless the pause was
    // explicitly requested via an inline [Ns] tag.
    if (chunkEnded && generationShouldContinue()) {
      const isLast = chunkIdx >= chunks.length - 1;
      const gapSec = meta.pauseAfterSec != null ? meta.pauseAfterSec : CHUNK_GAP_SEC;
      if (!control.suppressPauses && (!isLast || meta.explicit) && gapSec > 0) {
        const gapSamples = Math.max(1, Math.floor(gapSec * currentSampleRate));
        appendOutputChunk(new Float32Array(gapSamples), false);
      }
    }
  }
  } finally {
    disposeGpuState(flowLmState, protectedBaseFlowTensors);
    disposeGpuState(mimiState);
  }

  const totalMs = performance.now() - generationStart;
  const audioSamples = allChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const audioDurationSec = audioSamples / currentSampleRate;
  const realTimeFactor = audioDurationSec > 0 ? totalMs / (audioDurationSec * 1000) : null;
  postMessage({
    type: "diagnostic",
    level: "INFO",
    message: `Pocket pipeline: ${Math.round(totalMs)}ms total, ${Math.round(firstSegmentMs || totalMs)}ms first audio, RTF=${realTimeFactor == null ? 'n/a' : realTimeFactor.toFixed(2)}, ${Math.round(totalArTime)}ms AR, ${Math.round(totalFlowMatchingTime)}ms flow, ${Math.round(totalGpuCoreTime)}ms GPU core, ${Math.round(totalDecodeTime)}ms decoder, ${totalFrames} frames, text=${textConditioningRuns}, prefill=${prefillRuns}, punctSplits=${punctuationSplitCount}, GPU sync=${gpuSynchronizationPoints}, backend=${currentBackend}, ${runtimeThreadCount} WASM thread${runtimeThreadCount === 1 ? "" : "s"}`,
  });
  return {
    pipelineMs: Math.round(totalMs),
    tokenizationMs: Math.round(totalTokenizationTime),
    textConditioningMs: Math.round(totalTextConditioningTime),
    prefillMs: Math.round(totalPrefillTime),
    autoregressiveMs: Math.round(totalArTime),
    flowMs: Math.round(totalFlowMatchingTime),
    gpuCoreMs: Math.round(totalGpuCoreTime),
    decoderMs: Math.round(totalDecodeTime),
    firstSegmentMs: Math.round(firstSegmentMs || totalMs),
    audioDurationSec: Number(audioDurationSec.toFixed(3)),
    realTimeFactor: realTimeFactor == null ? null : Number(realTimeFactor.toFixed(3)),
    framesPerSecond: totalMs > 0 ? Number((totalFrames / (totalMs / 1000)).toFixed(2)) : null,
    gpuReadbacks,
    gpuSynchronizationPoints,
    textConditioningRuns,
    prefillRuns,
    punctuationSplitCount,
    operatorFallbackCount: currentMimiProvider === 'webgpu-mixed' ? null : 0,
    frames: totalFrames,
    textChunks: chunks.length,
    frameBudgetStops,
    backend: currentBackend,
    arMode: currentBackend === 'webgpu'
      ? 'gpu-block4'
      : (usedWasmUnified ? 'wasm-unified-block4' : (usedWasmBlock ? 'wasm-block4' : 'frame')),
    wasmThreads: runtimeThreadCount,
    performancePolicyVersion: POCKET_PERFORMANCE_POLICY_VERSION,
    accelerationVersion: POCKET_ACCELERATION_VERSION,
    graphCapture: webGpuGraphCaptureEnabled,
    mimiProvider: currentMimiProvider,
    gpuSyncGroupBlocks,
  };
}
