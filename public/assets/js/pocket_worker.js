// pocket_worker.js — Pocket TTS WASM/ONNX worker with B2 streaming and chunk buffering
import {
  DEFAULT_POCKET_TEMPERATURE_PRESET,
  DEFAULT_LSD_STEPS,
  getPocketTuningPreset,
  normalizeForPocketTts,
} from './tts_pronunciation_core.js?v=pron-v32';
import {
  FUSED_BLOCK_MIN_HEADROOM_MB,
  POCKET_ORT_VERSION,
  POCKET_CALIBRATION_VERSION,
  POCKET_ACCELERATION_VERSION,
  POCKET_WASM_MODEL_REVISION,
  POCKET_WEBGPU_MODEL_REVISION,
  POCKET_WEBGPU_BUNDLE,
  POCKET_GPU_RESIDENT_STATE_BYTES,
  normalizePocketBackend,
  detectMobilePlatform,
  recommendedWasmThreadCount,
  percentile,
  selectCalibratedBackend,
  selectWebGpuVariant,
  shouldDemoteWebGpuSustained,
  POCKET_WEBGPU_WASM_PARITY_RATIO,
} from './pocket_backend_policy.js?v=backend-v51';
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
// Mimi is the vocoder: it turns flow-LM latents into the actual waveform, so its
// quantization error is heard directly as grain rather than as a subtle change
// in wording or timing. Measured against the FP16 build on identical inputs, the
// INT8 decoder lands at 16.6-25.9 dB SNR -- error at roughly a tenth of signal
// amplitude, where 16-bit PCM is ~96 dB.
//
// The FP16 file costs nothing to prefer: it is SMALLER (20.9 MB vs 22.7 MB) and
// loads faster (147 ms vs 253 ms measured in ORT Web WASM, cross-origin
// isolated, 2 threads). It runs 19.6 ms/frame against 16.05, and a frame is
// 80 ms of audio, so the vocoder stage moves from 0.20 to 0.245 RTF and the
// flow-LM continues to dominate the paragraph.
//
// Devices that have not MEASURED real headroom stay on INT8. ORT WASM has no
// native FP16 kernels, so the weights are widened to FP32 in the heap; the file
// is smaller but the resident session is larger, and that is the wrong trade on
// a phone whose jetsam limit is already the binding constraint. See
// preferFp16Mimi: memory-safe mode alone no longer disqualifies a device, a
// missing or too-small measurement does.
const WASM_MIMI_FP16_FILE = 'mimi_decoder_fp16.onnx';
// Byte sizes for the files that are not the per-tensor originals, keyed by
// filename so download progress reports what is actually being fetched.
const KNOWN_MODEL_FILE_BYTES = Object.freeze({
  'mimi_decoder_fp16.onnx': 20943707,
  'mimi_decoder_int8_pc.onnx': 16673300,
  'flow_lm_main_int8_pc.onnx': 76622780,
  'flow_lm_flow_int8_pc.onnx': 10059081,
  'flow_lm_decode_block4_int8_pc.onnx': 86421636,
});
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
// No MODEL_DOWNLOAD_TOTAL_BYTES: the summed total had no reader. The per-asset
// map above is still used to report download progress.
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
// 2026-07-17 tamed the band to [0.66, 0.76] AND dropped noiseClamp after the
// clamp (not the temp) shifted perceived pitch sentence to sentence. 2026-08-30
// opened the temp band back up — [0.80, 0.95] — because the tamed values plus
// a 0.70 preset ceiling left even Expressive narration flat. noiseClamp stays
// off; identity still comes from the voice reference, energy from temperature.
// eosBonus: frames added to (or subtracted from) the post-EOS tail when
// expressive mode is on. Negative = snap off sooner (high-energy emotions);
// positive = let it settle (quiet/fearful emotions). Applied in pushChunk.
const EMOTION_PROSODY = {
  neutral:  { temp: 0.80, noiseClamp: null, eosBonus:  0 },
  sadness:  { temp: 0.86, noiseClamp: null, eosBonus:  1 },
  fear:     { temp: 0.90, noiseClamp: null, eosBonus:  1 },
  joy:      { temp: 0.93, noiseClamp: null, eosBonus: -1 },
  surprise: { temp: 0.94, noiseClamp: null, eosBonus: -1 },
  anger:    { temp: 0.95, noiseClamp: null, eosBonus: -1 },
};

// ── PRNG & Gaussian Latent Generator (Mulberry32 + Box-Muller) ───────────────
// Hashes the string seed with FNV-1a plus a MurmurHash3 finalizer (the avalanche
// step is murmur's; the accumulation loop is not), then runs Mulberry32 for
// uniform pseudorandom generation. Paired Box-Muller generation generates true
// uncorrelated isotropic Gaussian samples N(0, std^2) across all 32 latent
// dimensions, eliminating 2D hyperplane lattice artifacts that cause voice
// timbre and pitch shifts between lines.
let _prngState = 42;
let _hasSpareGaussian = false;
let _spareGaussian = 0;

function _hashSeedString(str) {
  let h = 0x811c9dc5;                                  // FNV-1a offset basis
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);  // FNV-1a prime
    h = (h ^ (h >>> 13)) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);           // MurmurHash3 finalizer
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function seedRandom(seedInput) {
  _hasSpareGaussian = false;
  _spareGaussian = 0;
  if (typeof seedInput === 'number' && Number.isFinite(seedInput)) {
    let s = (seedInput | 0) >>> 0;
    if (s === 0) s = 42;
    _prngState = s;
  } else {
    const s = _hashSeedString(String(seedInput || '42'));
    _prngState = s === 0 ? 42 : s;
  }
}

function seededRandom() {
  let z = (_prngState = (_prngState + 0x6d2b79f5) >>> 0);
  z = Math.imul(z ^ (z >>> 15), z | 1);
  z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
  return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
}

function seededGaussian(std = 1.0, clampAbs = null) {
  let val;
  if (_hasSpareGaussian) {
    _hasSpareGaussian = false;
    val = _spareGaussian * std;
  } else {
    let u = 0;
    let v = 0;
    while (u === 0) u = seededRandom();
    while (v === 0) v = seededRandom();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    const angle = 2.0 * Math.PI * v;
    val = mag * Math.cos(angle) * std;
    _spareGaussian = mag * Math.sin(angle);
    _hasSpareGaussian = true;
  }
  if (clampAbs != null) {
    return Math.max(-clampAbs, Math.min(clampAbs, val));
  }
  return val;
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
  // The caller does not get a vote on the step count. The fused decode block and
  // the WebGPU R3 pipeline both refuse to run above one step (see the
  // chunkLsdSteps gates in runGenerationPipeline), so a higher number does not
  // buy quality — it silently drops the render onto the unaccelerated per-frame
  // path and costs ~3x RTF on a phone. opts.lsdSteps is accepted and ignored so
  // an older cached job message cannot resurrect the multi-step path.
  return {
    temperaturePreset: preset.name,
    temperature: clampPocketTemperature(opts.temperature != null ? opts.temperature : preset.temperature),
    lsdSteps: DEFAULT_LSD_STEPS,
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
// Cache used to raise this to 176, which re-chunked the paragraph and made
// each chunk's deterministic seed a different take of the same line. The
// constant stays named so it cannot silently return as a magic number.
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

const PROXY_BASE_URL = self.PR_PROXY_BASE || 'https://pocket-reader-proxy.alpharius67.workers.dev';
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
// Plain fixed-width SIMD build, for devices whose browser validates SIMD but
// NOT relaxed SIMD -- which is every iPhone tested so far, and the reason they
// were falling all the way through to stock ORT reading .onnx protobuf.
const POCKET_ORT_SIMD_RUNTIME_VERSION = '1.27.0-simd-minimal';
// (module (func (result v128) i32.const 1  i32x4.splat))
const FIXED_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
  10, 10, 1, 8, 0, 65, 1, 253, 15, 11,
]);
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
// Re-quantized decode block, PER-CHANNEL rather than per-tensor.
//
// The original export gives every weight matrix a single scalar scale, which on
// this graph scores 9.89 dB latent SNR against the FP16 build of the same model.
// The latents drive the vocoder, so that error is upstream of everything -- it
// is the largest single quality loss in the pipeline. Rebuilt from the FP16
// master with per-channel weight scales it scores 23.31 dB, a 4.7x reduction in
// noise power, and the EOS logits go from 21.46 to 30.42 dB.
//
// It costs nothing anywhere. Measured in ORT Web WASM, cross-origin isolated,
// 4 threads: loads in 465 ms against 848 ms, runs 46.30 ms/block against 47.16,
// and the file is 86.4 MB against 88.2 MB.
//
// (Per-channel scales are also why the earlier attempts failed to load: ORT's
// quantizer rewrites Gemm to MatMul itself and gets it wrong on this graph, so
// the 92 Gemm nodes are folded to MatMul + Add before quantizing. See the
// maintainer tool for the exact recipe.)
const WASM_BLOCK_FILE = 'flow_lm_decode_block4_int8_pc.onnx';
// The pre-rebuild asset. Kept as a fetch fallback so a bundle that does not
// carry the new file (any non-English language bundle) still finds a block.
const WASM_BLOCK_LEGACY_FILE = 'flow_lm_decode_block4_int8.onnx';
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
// Conditioned voice states are by far the largest live allocation in this
// worker. Measured against the shipped english_2026-04 manifest, ONE of them is
// 46.9 MB -- eighteen flow-LM state tensors, six of which are
// [2,1,1000,16,64] float32 at 7.81 MB apiece.
//
// Nothing bounded them unless constrainedMemoryMode was on. Every emotion is a
// separate voice asset (donald_malone_happy, donald_malone_sad, ...), so a
// story narrated in balanced mode cycles eight of them and retained 375 MB;
// expressive mode reaches thirteen and 609 MB. That sat on top of the ~126 MB
// of ONNX sessions and was the ceiling every other memory measure in this file
// -- the disabled ORT arena, the worker teardown after caching, the idle
// release -- was compensating for after the fact.
//
// Evicting a conditioned state does NOT unregister the voice: the ~5 MB raw
// record stays in customVoiceStates, so re-use costs one local re-conditioning
// rather than a refetch and a round trip through the main thread.
const MAX_CONDITIONED_VOICES = 4;
// Set for the whole of a generation. currentVoiceName cannot serve this: a
// register_precompiled_voice for the NEXT paragraph arrives while this one is
// still rendering and reassigns it, which would drop protection from the state
// runGenerationPipeline is actively reading.
let generatingVoiceName = null;
let constrainedMemoryMode = false;
// The memory probe's measured figure, forwarded by the main thread. 0 means the
// probe never ran, which is treated as "unknown", not as "plenty".
let measuredHeadroomMb = 0;
// Platform resolved by the main thread and delivered in the init message.
// The worker must NOT re-sniff this: WorkerNavigator exposes no maxTouchPoints,
// so a worker-side check cannot tell a stock iPad (desktop "Macintosh" UA) from
// a real Mac, and would silently hand an iPad the desktop memory profile.
let clientPlatform = '';
const isIosClient = () => clientPlatform === 'ios';
const isMobileClient = () => clientPlatform !== '' && clientPlatform !== 'desktop';

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
// Recognised by buffer_manager's cache loop, which requeues the paragraph and
// carries on. Keep the two spellings in step.
const POCKET_YIELDED_TO_PLAYBACK = 'Pocket cache yielded to playback';
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

// Enough MEASURED working memory to afford the heavy, higher-fidelity path.
//
// This exists because "is this iOS" was doing the job and had stopped being the
// right question. The iOS exclusions were written when 4 GB iPhones still ran
// Pocket; they no longer do -- the RAM ladder sends 4 GB to Kitten and 6 GB to
// Kokoro, so every iPhone that reaches this worker is 8 GB or better. The gate
// was excluding precisely the phones that can afford the good path.
//
// constrainedMemoryMode stays on for iOS regardless: the yields between session
// creations and the largest-session-first ordering are cheap insurance and are
// not what this decides.
function hasMeasuredHeadroom() {
  return measuredHeadroomMb >= FUSED_BLOCK_MIN_HEADROOM_MB;
}

// Whether this session should fetch the higher-fidelity Mimi decoder. There is
// no FP16 build in the .ort bundle, so that path keeps INT8 regardless.
function preferFp16Mimi() {
  if (currentBackend !== 'wasm' || useOrtFormatWasm) return false;
  // A measured-roomy device gets the better vocoder even in constrained mode:
  // ORT WASM widens FP16 weights to FP32 in the heap, ~19 MB more resident than
  // INT8, which is noise against a device that measured 704 MB.
  return !constrainedMemoryMode || hasMeasuredHeadroom();
}

function mimiWasmFilename() {
  return preferFp16Mimi() ? WASM_MIMI_FP16_FILE : wasmModelFilename('mimi_decoder');
}

function wasmBlockFilename(unified = false) {
  if (unified) return useOrtFormatWasm ? WASM_UNIFIED_BLOCK_ORT_FILE : WASM_UNIFIED_BLOCK_FILE;
  return useOrtFormatWasm ? WASM_BLOCK_ORT_FILE : WASM_BLOCK_FILE;
}

// Per-channel rebuilds, mapped from the per-tensor file each one replaces.
//
// The originals quantize every weight matrix with a SINGLE scalar scale. Scored
// against the real FP32 masters (published beside the exports these were made
// from -- the deployed flow_lm_main_int8 is byte-identical to the one in that
// repo, so the FP32 there is literally its source):
//
//                     per-tensor    per-channel
//   flow_lm_main        15.66 dB      26.06 dB     (prefill / conditioning)
//   flow_lm_flow        24.14 dB      33.15 dB     (per-frame flow network)
//   mimi_decoder        20.49 dB      22.72 dB     (vocoder, INT8 fallback path)
//
// Sizes barely move -- per-channel adds one scale per output channel -- and the
// rebuilt Mimi is 6 MB SMALLER. FP16 Mimi still beats every INT8 build of it by
// a mile (64.20 dB), so this only matters where FP16 is not affordable.
const PER_CHANNEL_MODEL_STEMS = Object.freeze({
  'flow_lm_main_int8.onnx': 'flow_lm_main_int8_pc.onnx',
  'flow_lm_flow_int8.onnx': 'flow_lm_flow_int8_pc.onnx',
  'mimi_decoder_int8.onnx': 'mimi_decoder_int8_pc.onnx',
});

function wasmModelPaths(language, filename) {
  const bundle = useOrtFormatWasm && filename.endsWith('.ort')
    ? POCKET_ORT_FORMAT_BUNDLE
    : language;
  // Prefer the rebuild, then fall back to the file it replaces. Doing this here
  // rather than at each call site means every loader -- the descriptor list,
  // ensureFlowLmMainSession, ensureFlowLmFlowSession -- gets both for free.
  //
  // Only english_2026-04 carries the rebuilds. Offering them for a bundle that
  // does not have them is not free: fetchFirstAvailable would spend two 404
  // round-trips per model AND post a "Model host unavailable" WARN for each
  // before reaching the file that was always going to serve it.
  const upgraded = (useOrtFormatWasm || bundle !== DEFAULT_LANGUAGE)
    ? null
    : PER_CHANNEL_MODEL_STEMS[filename];
  const names = upgraded ? [upgraded, filename] : [filename];
  return names.flatMap((name) => [
    `${MODEL_BASE_URL}Pocket%20TTS%20Onnx/${bundle}/${name}`,
    `${B2_DIRECT_BASE_URL}/onnx/${bundle}/${name}`,
  ]);
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

// Field-confirmed on an iPhone 13 (4 GB), 2026-08-22: caching survived
// noticeably longer with the model cache EMPTY than with it populated, on
// identical code. An empty cache streams each model from the network into one
// preallocated buffer -- the allocation shape a previous pass deliberately
// engineered to avoid a double copy. A populated cache went through
// Response.arrayBuffer(), which asks WebKit to materialise an 87 MB blob off
// disk in one step and gives it no size to work with, so the cheap path was
// only ever taken on first run and every later launch paid more.
//
// Reading the stored body through the same preallocate-and-fill loop as the
// network path puts both on equal footing. Falls back to arrayBuffer() only
// when the size is genuinely unknown, which is no worse than before.
async function readCachedModelBuffer(url, expectedBytes = 0) {
  try {
    const cache = await openModelCache();
    if (!cache) return null;
    const hit = await cache.match(url);
    if (!hit?.ok) return null;
    const declared = Number(hit.headers.get('Content-Length')) || Number(expectedBytes) || 0;
    if (!declared || !hit.body?.getReader) return await hit.arrayBuffer();
    const output = new Uint8Array(declared);
    const reader = hit.body.getReader();
    let filled = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (filled + value.byteLength > output.byteLength) {
        // Stored entry disagrees with its own length header: treat as a miss
        // rather than returning a truncated model.
        await reader.cancel().catch(() => {});
        return null;
      }
      output.set(value, filled);
      filled += value.byteLength;
    }
    if (filled !== output.byteLength) return null;
    return output.buffer;
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
    // Content-Length is what lets readCachedModelBuffer preallocate instead of
    // falling back to arrayBuffer(); a Response built from an ArrayBuffer does
    // not reliably carry one on its own.
    const byteLength = buffer?.byteLength ?? buffer?.length ?? 0;
    await cache.put(url, new Response(buffer, {
      headers: { 'Content-Type': contentType, 'Content-Length': String(byteLength) },
    }));
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
  // Must follow the ACTIVE format. Using the .onnx table while .ort is in play
  // hands readCachedModelBuffer a length that cannot match, so the entry fails
  // its own size check and reports a miss -- silently defeating the durable
  // cache and re-downloading every model on every launch.
  const expectedSizes = useOrtFormatWasm ? ORT_FORMAT_MODEL_ASSET_BYTES : MODEL_ASSET_BYTES;
  const expectedBytes = Number(currentModelAssetBytes?.[asset] || expectedSizes[asset] || 0);
  const cached = urls.length
    ? await readCachedModelBuffer(canonicalModelCacheKey(urls[0]), expectedBytes)
    : null;
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

// Map preserves insertion order, so re-inserting on every hit turns it into an
// LRU. Without this, eviction would drop whichever voice was conditioned first
// regardless of how recently the narration used it.
function touchConditionedVoice(key) {
  if (!voiceConditioningCache.has(key)) return;
  const state = voiceConditioningCache.get(key);
  voiceConditioningCache.delete(key);
  voiceConditioningCache.set(key, state);
}

// Replacing an entry without disposing the old one leaked a full 46.9 MB state
// per re-conditioning -- and on WebGPU that is GPU-resident, which the JS GC
// cannot reclaim at all. force:true re-conditions on every backend switch and
// on every register_precompiled_voice, so this ran often.
function setConditionedVoice(key, state) {
  const previous = voiceConditioningCache.get(key);
  if (previous && previous !== state) disposeGpuState(previous);
  voiceConditioningCache.delete(key);
  voiceConditioningCache.set(key, state);
}

function conditionedVoiceLimit() {
  return constrainedMemoryMode ? MAX_CONSTRAINED_CUSTOM_VOICES : MAX_CONDITIONED_VOICES;
}

// Bound the conditioned states on EVERY device. The raw records are left alone,
// so nothing is unregistered and the main thread's voice memo stays truthful.
function evictExcessConditionedVoices(protectedVoice = null) {
  const limit = conditionedVoiceLimit();
  const keep = new Set([protectedVoice, generatingVoiceName, currentVoiceName].filter(Boolean));
  while (voiceConditioningCache.size > limit) {
    const victim = [...voiceConditioningCache.keys()].find((name) => !keep.has(name));
    if (!victim) return;
    disposeGpuState(voiceConditioningCache.get(victim));
    voiceConditioningCache.delete(victim);
  }
}

function evictConstrainedCustomVoices(protectedVoice = null) {
  if (!constrainedMemoryMode) return;
  const keep = new Set([protectedVoice, generatingVoiceName, currentVoiceName].filter(Boolean));
  while (customVoiceStates.size > MAX_CONSTRAINED_CUSTOM_VOICES) {
    const voiceName = [...customVoiceStates.keys()].find((name) => !keep.has(name));
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
    touchConditionedVoice(voiceName);
    return voiceConditioningCache.get(voiceName);
  }

  if (!isGenerating) {
    postMessage({ type: "status", status: statusText, state: "loading" });
  }
  const conditioned = stateFromVoiceRecord(predefinedVoiceRecords[voiceName]);
  setConditionedVoice(voiceName, conditioned);
  evictExcessConditionedVoices(voiceName);
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
    touchConditionedVoice(key);
    return voiceConditioningCache.get(key);
  }

  if (!isGenerating) {
    postMessage({ type: "status", status: statusText, state: "loading" });
  }

  const conditioned = stateFromVoiceRecord(customVoiceStates.get(key));
  setConditionedVoice(key, conditioned);
  evictExcessConditionedVoices(key);
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

const SENTENCE_TERMINATORS = new Set([".", "!", "?"]);
// Closing marks belong to the sentence they close. `...in?”` used to leave the
// quotation mark behind as its own fragment.
const SENTENCE_CLOSERS = new Set(['"', "'", "”", "’", ")", "]", "»"]);
// A period here ends a title, not a sentence. Splitting on it put a chunk
// boundary inside "Mr. Vale said" and inside initials like "J. R. R.".
const SENTENCE_ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "mx", "dr", "prof", "st", "sr", "jr", "rev", "hon", "capt",
  "lt", "sgt", "col", "gen", "cmdr", "fr", "gov", "sen", "rep", "pres", "supt",
  "vs", "etc", "inc", "ltd", "co", "approx", "est", "dept", "univ",
]);
// Deliberately NOT here: "no". "He said no." ends a sentence far more often in
// prose than "No. 5" appears, and the numbered-abbreviation case is already
// rewritten to "number 5" by normalizeForPocketTts before this runs.

// The old implementation was /[^.!?]+[.!?]+|[^.!?]+$/g, which treated every run
// of .!? as a sentence end. Two consequences the reader heard directly:
//
//  - Ellipses split sentences. normalizeForPocketTts rewrites "…" to "...", so
//    every ellipsis in dialogue became a hard chunk boundary — a 0.25s gap AND
//    a fresh flow-LM state (RESET_FLOW_STATE_EACH_CHUNK) mid-line. That is the
//    "paragraphs cut in half, causing a pause" report.
//  - A closing quote after the terminator became its own fragment, so a chunk
//    could be nothing but `”` — a degenerate prompt for a zero-shot flow-LM,
//    which is exactly when it produces a short distorted squeal.
//
// Sentence-ending punctuation now has to be followed by whitespace or the end
// of the text, ellipses are treated as intra-sentence pauses, closers stay
// attached, and abbreviations/decimals/initials do not split at all.
function splitTextIntoSentences(text) {
  const s = String(text || "");
  const out = [];
  let start = 0;

  for (let i = 0; i < s.length; i++) {
    if (!SENTENCE_TERMINATORS.has(s[i])) continue;

    // Consume the whole run: "...", "?!", "!!" are one terminator.
    let end = i;
    while (end + 1 < s.length && SENTENCE_TERMINATORS.has(s[end + 1])) end++;
    const run = s.slice(i, end + 1);

    // An ellipsis is a pause inside a sentence, not the end of one.
    if (run.length >= 3 && /^\.+$/.test(run)) { i = end; continue; }

    let j = end + 1;
    while (j < s.length && SENTENCE_CLOSERS.has(s[j])) j++;

    // Mid-token periods (3.5, e.g.) are not boundaries.
    if (j < s.length && !/\s/.test(s[j])) { i = end; continue; }

    if (run === ".") {
      const word = (s.slice(start, i).match(/([A-Za-z.]+)$/) || [, ""])[1].replace(/\./g, "").toLowerCase();
      // A single letter is an initial ("J. R. R. Tolkien").
      if (word.length === 1 || SENTENCE_ABBREVIATIONS.has(word)) { i = end; continue; }
    }

    const piece = s.slice(start, j).trim();
    if (piece) out.push(piece);
    start = j;
    i = j - 1;
  }

  const tail = s.slice(start).trim();
  if (tail) out.push(tail);
  return out;
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

// True when `unit` ends on a clause mark, i.e. a place a reader would breathe.
const CLAUSE_BOUNDARY_RE = /[,;:—–][\s"'”’)\]]*\s*$/;

// Splits a sentence that is over the token cap.
//
// This used to break at whatever word happened to cross the cap, which is how a
// long line of dialogue got cut mid-clause. Each piece is a separate render with
// its own flow-LM state, so a piece that starts mid-clause gives the model no
// prosodic footing: it re-anchors pitch on a fragment, which is the "high
// pitched and/or distorted, often ending in a word being pronounced incorrectly"
// the reader heard on long quotes. Breaking on a comma or semicolon instead
// gives every piece a phrase a narrator could plausibly have started on.
function splitLongTextSafely(text, maxTokens) {
  const units = String(text || "").match(/\S+\s*/g) || [];
  const chunks = [];
  let current = "";
  // Length of `current` at the most recent clause boundary, and how many units
  // we have accreted since — so we can rewind to it when the cap is hit.
  let clauseCut = 0;
  let unitsSinceClause = 0;

  const push = (value) => {
    const t = String(value || "").trim();
    if (t) chunks.push(t);
  };
  const flush = () => {
    push(current);
    current = "";
    clauseCut = 0;
    unitsSinceClause = 0;
  };

  for (const unit of units) {
    const candidate = current + unit;
    if (current && tokenizerProcessor.encodeIds(candidate).length > maxTokens) {
      // Rewind to the last clause mark when there is one, and when it is not so
      // early in the piece that the rewind would itself produce a stub. Below
      // that, an arbitrary word break is still the least-bad option.
      const rewindable = clauseCut > 0
        && unitsSinceClause > 0
        && clauseCut >= Math.floor(current.length * 0.4);
      if (rewindable) {
        const head = current.slice(0, clauseCut);
        const tail = current.slice(clauseCut);
        push(head);
        current = tail;
        clauseCut = 0;
        unitsSinceClause = 0;
      } else {
        flush();
      }
    }
    if (tokenizerProcessor.encodeIds(unit).length > maxTokens) {
      flush();
      for (const piece of splitTokenIdsIntoChunks(tokenizerProcessor.encodeIds(unit), maxTokens)) {
        push(piece);
      }
    } else {
      current += unit;
      unitsSinceClause += 1;
      if (CLAUSE_BOUNDARY_RE.test(unit)) {
        clauseCut = current.length;
        unitsSinceClause = 0;
      }
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
    : POCKET_TOKEN_SOFT_CAP;
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
        chunkMeta.push({ framesAfterEos: 0, pauseAfterSec: run.sec, explicit: true, pauseOnly: true, emotion: "neutral", temp: tuning.temperature, noiseClamp: null, temperaturePreset: tuning.temperaturePreset, lsdSteps: tuning.lsdSteps });
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
  const steps = Math.max(1, Number(lsdSteps) || DEFAULT_LSD_STEPS);
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

function supportsFixedSimd() {
  try {
    return typeof WebAssembly?.validate === 'function' && WebAssembly.validate(FIXED_SIMD_PROBE);
  } catch (_) {
    return false;
  }
}

// Which resolved runtimes may read .ort models.
//
// Stock ORT was briefly allowed here on the strength of static analysis -- its
// wasm carries the ORTM identifier, "ORT format model", the "Invalid ORT format
// model" parser error and fbs:: symbols, so the loader looks compiled in. That
// was never tested end to end, and the iPhone 13 regressed from ~27 paragraphs
// to ~11 in the window that change was live. Strings prove a code path exists,
// not that it is enabled at runtime or that it costs less memory than the
// protobuf path it replaced.
//
// So: back to the two runtimes .ort was built and measured against. Restoring
// the last configuration known to reach paragraph 27 is worth more than an
// unverified optimisation, and the device this was meant to help is moving to
// Kokoro regardless. Re-enable stock only with a real on-device measurement,
// not another binary grep.
function flavorSupportsOrtFormat(flavor) {
  return flavor === 'relaxed-simd-minimal-ort' || flavor === 'simd-minimal-ort';
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
  // Between the relaxed candidates and stock: same custom-build advantages
  // (WASM-only API, .ort models, no protobuf parse at session creation) without
  // requiring relaxed SIMD. If it has not been built and uploaded yet the HEAD
  // probe fails and this falls through to stock exactly as before.
  if (preferMinimalOrt && supportsFixedSimd()) {
    candidates.push({
      name: 'simd-minimal-ort',
      base: `${PROXY_BASE_URL}/models/onnxruntime/${POCKET_ORT_SIMD_RUNTIME_VERSION}/`,
      requiredFiles: [
        'ort.min.mjs',
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.wasm',
      ],
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
    postMessage({ type: "status", status: "Loading optimized ONNX Runtime...", state: "loading",
      phase: "blocking", budgetMs: MODULE_TIMEOUT_MS });
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

  postMessage({ type: "status", status: "Loading ONNX Runtime...", state: "loading",
    phase: "blocking", budgetMs: MODULE_TIMEOUT_MS });
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
  // clientPlatform covers iPad, whose UA claims Macintosh; fall back to the UA
  // only before init has landed.
  const mobile = clientPlatform ? isMobileClient() : /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
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
  postMessage({ type: 'status', status: 'Preparing high-quality flow...', state: 'loading',
    phase: 'blocking', budgetMs: SESSION_CREATE_TIMEOUT_MS });
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
  // Ask for .ort whenever a custom runtime could plausibly serve it. Fixed SIMD
  // is the wider gate: relaxed SIMD implies it, and a device with only fixed
  // SIMD previously lost .ort for no reason other than the probe it failed.
  useOrtFormatWasm = selectedBackend === 'wasm'
    && language === DEFAULT_LANGUAGE
    && (supportsRelaxedSimd() || supportsFixedSimd());
  await loadOrt(selectedBackend, { preferMinimalOrt: useOrtFormatWasm });
  // Which runtime actually won is only known now. Stock ORT is not published
  // with the .ort loader, so asking it for .ort models would turn a memory
  // optimisation into a total load failure. Model filenames are resolved below
  // this line, so correcting the flag here is enough to stay consistent.
  if (selectedBackend === 'wasm' && useOrtFormatWasm && !flavorSupportsOrtFormat(ortWasmRuntimeFlavor)) {
    useOrtFormatWasm = false;
    postMessage({
      type: 'diagnostic',
      level: 'INFO',
      message: `Runtime resolved to ${ortWasmRuntimeFlavor}; using .onnx models (.ort loader unverified in that build).`,
    });
  }

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
  const iosWebKit = isIosClient();
  // Memory-first core selection on constrained devices.
  //
  // The unified block4 graph folds the AR core, the one-step flow network and
  // four-frame batching into a single 87 MB model -- and 87 MB is exactly the
  // allocation that OOM-kills a 4 GB iPhone at session creation, because the
  // worst instant holds the JS buffer AND ORT's copy of it in the WASM heap
  // (~174 MB). The split core's largest single model is flow_lm_main at 76 MB
  // (~152 MB at that same instant), and flow_lm_flow's 10 MB is created after
  // the peak has passed. Total resident memory is effectively unchanged:
  // 16+76+10+23 = 125 MB split against 16+87+23 = 126 MB unified. The whole
  // gain is ~22 MB off the single worst moment in startup.
  //
  // The cost is real and worth naming rather than burying: without the unified
  // graph there is no four-frame batching, so the ~47 MB fp32 flow-LM state
  // crosses the JS/WASM boundary once per frame instead of once per four.
  // Generation gets slower. It does not get hungrier -- the transient cost of
  // one crossing is identical, it simply happens more often -- so this trades
  // throughput for startup headroom and nothing else. On a device that cannot
  // currently finish startup at all, a slower render that completes beats a
  // faster one that is killed.
  //
  // iOS is always classified constrained (memorySafeInference), so in practice
  // this retires the unified core on iPhone. It stays wired for any device that
  // reaches the WASM path without the constrained flag.
  // Scoped to iOS deliberately. A constrained ANDROID device must keep the
  // unified core: it is not excluded from the optional decode-block below, so
  // sending it down the split path would load flow_lm_main (76) AND
  // flow_lm_decode_block4 (87) AND mimi (23) AND the conditioner (16) -- 202 MB
  // resident, far worse than the 126 MB it has today. iOS is the only platform
  // barred from that extra block, which is what makes the split path a genuine
  // reduction there and a regression anywhere else.
  const preferUnifiedWasmCore = currentBackend === 'wasm'
    && language === DEFAULT_LANGUAGE
    && constrainedMemoryMode
    && !iosWebKit;
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
        {
          asset: 'mimi_decoder',
          target: 'mimiDecoderSession',
          filename: mimiWasmFilename(),
          // If the FP16 decoder cannot be fetched or built on this device, fall
          // back to the INT8 one rather than failing narration outright. The
          // fidelity gain is worth having; it is not worth a silent engine.
          fallbackFilename: preferFp16Mimi() ? wasmModelFilename('mimi_decoder') : null,
          sourceBackend: 'wasm',
        },
      ];
  if (modelDescriptors.some((descriptor) => !descriptor.filename)) {
    throw new Error('The selected Pocket bundle is missing a required model filename.');
  }
  currentModelAssetBytes = Object.fromEntries(modelDescriptors.map((descriptor) => {
    const metadata = descriptor.sourceBackend === 'webgpu' ? webGpuBundleMetadata : bundleMetadata;
    const fallbackSizes = useOrtFormatWasm ? ORT_FORMAT_MODEL_ASSET_BYTES : MODEL_ASSET_BYTES;
    const declared = metadata?.artifacts?.[descriptor.filename]?.bytes;
    // Size the FILE, not the role. Both the FP16 vocoder and the per-channel
    // rebuilds differ from the per-tensor sizes in the fallback map -- the
    // rebuilt Mimi by 6 MB -- so keying on the role alone made the download
    // progress bar claim bytes that were never going to arrive.
    const size = Number(declared || KNOWN_MODEL_FILE_BYTES[descriptor.filename]
      || fallbackSizes[descriptor.asset] || 0);
    return [descriptor.asset, size];
  }));
  currentModelDownloadTotalBytes = Math.max(1, Object.values(currentModelAssetBytes).reduce((sum, size) => sum + size, 0));

  postMessage({ type: 'progress', info: { status: 'progress', progress: 30 } });

  let completedBytes = 0;
  let sessionCreationMs = 0;
  const loadModelDescriptor = async (descriptor) => {
    const { asset, target, filename, sourceBackend, fallbackFilename } = descriptor;
    if (fallbackFilename) {
      try {
        return await loadModelDescriptor({ asset, target, filename, sourceBackend });
      } catch (error) {
        postMessage({ type: 'log', level: 'warn',
          message: `${asset}: ${filename} unavailable (${error?.message || error}); falling back to ${fallbackFilename}.` });
        return await loadModelDescriptor({ asset, target, filename: fallbackFilename, sourceBackend });
      }
    }
    const modelUrls = sourceBackend === 'wasm'
      ? wasmModelPaths(language, filename)
      : [
          proxifyUrl(bundlePath(language, filename, sourceBackend)),
          directBundlePath(language, filename, sourceBackend),
        ];
    let modelBuffer = await fetchModelWithProgress(modelUrls, asset, completedBytes);
    const modelBytes = modelBuffer.byteLength;
    // ort.InferenceSession.create() below is a single blocking call that posts
    // nothing for its whole duration -- minutes for an 87 MB graph on a phone,
    // which is why SESSION_CREATE_TIMEOUT_MS allows five. The main-thread
    // silence watchdog would otherwise treat that as a dead worker and
    // terminate a perfectly healthy one, so declare the budget with the status.
    postMessage({ type: "status", status: `Preparing ${asset}...`, state: "loading",
      phase: "blocking", budgetMs: SESSION_CREATE_TIMEOUT_MS });
    if (constrainedMemoryMode) {
      // fetchModelWithProgress has just written this asset to the durable cache,
      // and cache.put() has to serialise the body -- a second full-size copy of
      // a model that can be 87 MB. That copy is unreachable by now but WebKit
      // has had no chance to collect it, and the very next statement allocates
      // another full copy inside the WASM heap. Yielding a macrotask puts a
      // collection opportunity between the two largest allocations in startup
      // rather than letting them stack.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
  // Constrained WebKit: create the LARGEST session first.
  //
  // Peak allocation is not the sum of the weights, it is the worst single
  // moment: the JS ArrayBuffer for the model being created, plus ORT's copy of
  // it in the WASM heap, plus every session already resident. The unified core
  // is 87 MB against 16 MB for the text conditioner and 23 MB for Mimi, so its
  // creation IS the peak. Doing it first means nothing else is resident yet and
  // the two small sessions land afterwards in a heap that has already grown.
  // Loading order has no effect on results -- each descriptor just assigns a
  // different global -- so this is free on every other platform too, but it is
  // gated to keep desktop behaviour byte-identical.
  const orderedDescriptors = constrainedMemoryMode
    ? [...modelDescriptors].sort((a, b) => {
        const sizeOf = (d) => Number(currentModelAssetBytes[d.asset] || 0);
        return sizeOf(b) - sizeOf(a);
      })
    : modelDescriptors;
  for (const descriptor of orderedDescriptors) {
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
  } else if (currentBackend === 'wasm' && resolveWasmThreadCount() >= 2
             && (!iosWebKit || hasMeasuredHeadroom())) {
    try {
      const blockResponse = await fetchFirstAvailable([
        ...wasmModelPaths(language, wasmBlockFilename(false)),
        // Fall back to the pre-rebuild asset rather than dropping to the
        // per-frame path, which is far slower than either block.
        ...(useOrtFormatWasm ? [] : wasmModelPaths(language, WASM_BLOCK_LEGACY_FILE)),
      ]);
      const blockBuffer = await blockResponse.arrayBuffer();
      const bosResponse = await fetchFirstAvailable([
        proxifyUrl(bundlePath(language, WASM_BLOCK_BOS_FILE, 'wasm')),
        directBundlePath(language, WASM_BLOCK_BOS_FILE, 'wasm'),
      ]);
      const bosTensor = parseNpyFloat32(await bosResponse.arrayBuffer());
      if (bosTensor.shape.join(',') !== `1,1,${currentLatentDim}`) {
        throw new Error('WASM block BOS tensor has an incompatible shape.');
      }
      if (constrainedMemoryMode) {
        // Same protection loadModelDescriptor gives the other sessions, which
        // this branch sits outside of. It matters more here than anywhere else:
        // the fetch above has just written ~86 MB to the durable cache (a second
        // copy WebKit has had no chance to collect), and the next statement asks
        // ORT for a third inside the WASM heap. A macrotask between them is the
        // difference between a collection opportunity and three live copies.
        await new Promise((resolve) => setTimeout(resolve, 0));
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
    // The device reported stock-wasm-only on iOS 26.6, which should have had
    // relaxed SIMD. Landing on stock means EITHER the probe failed OR both
    // relaxed candidates were reachable-but-rejected, and the flavor name alone
    // cannot tell those apart. Report the probe itself so the next diagnostic
    // answers it outright instead of costing another round trip.
    relaxedSimdSupported: supportsRelaxedSimd(),
    ortFormatModels: useOrtFormatWasm,
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
// True while the running job is a live playback render rather than a
// cache-ahead one. See enqueueGeneration for why the distinction matters.
let activeGenerationIsPriority = false;
// Set when a cache render is being stood down for a playback render, so its
// settle path reports the yield instead of pretending the paragraph failed.
let preemptedJobId = null;
let backendReloadInFlight = false;
async function processGenerationQueue() {
  if (isGenerating || generationQueue.length === 0) return;
  // Playback first. Ordering only decides between jobs that have not started;
  // enqueueGeneration handles the one already running.
  const next = generationQueue.findIndex((job) => job.isPriority);
  const task = generationQueue.splice(next === -1 ? 0 : next, 1)[0];
  try {
    await startGeneration(task.text, task.voice, task.jobId, task.opts, task.isPriority);
  } catch (e) {
    console.error("Queue generation error:", e);
  }
}

// The main thread marks a generate isPriority when a listener is waiting on it
// RIGHT NOW -- the paragraph currently being played -- as opposed to a
// cache-ahead render, which nobody is waiting for. That flag was being sent on
// every generate and read by nothing, so the queue was strictly first-in and
// playback simply inherited whatever the background cache job had already
// started. A cache render of a long paragraph holds the sessions for several
// seconds on a phone, and narration cannot begin until it lets go -- which is
// heard as the reader pausing every few lines while the cache counter climbs.
//
// So: a playback job goes to the front of the queue, and if a CACHE job is
// mid-render it is stood down (cooperatively -- the loops poll cancelRequested)
// and reported with a message the buffer manager already knows how to requeue.
// The abandoned work is redone later, at no cost to the listener. A playback
// job is never preempted, and a cache job never preempts anything.
function enqueueGeneration(job) {
  generationQueue.push(job);
  if (job.isPriority && isGenerating && !activeGenerationIsPriority && !cancelRequested) {
    preemptedJobId = activeGenerationJobId;
    cancelRequested = true;
  }
  processGenerationQueue();
}

self.onmessage = async (e) => {
  const data = e.data;
  const type = data.type;

  try {
    if (type === "init") {
      // Trust the main thread's resolved platform; fall back to a worker-side
      // UA sniff only if it was not supplied (older client, replayed message).
      clientPlatform = typeof data.clientPlatform === 'string' && data.clientPlatform
        ? data.clientPlatform
        : detectMobilePlatform(self.navigator?.userAgent || '');
      constrainedMemoryMode = data.constrainedMemoryMode === true || isIosClient();
      measuredHeadroomMb = Number(data.measuredHeadroomMb) || 0;
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
          isPriority: data.isPriority === true,
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
      enqueueGeneration({
        text: data.text,
        voice: voiceName,
        jobId: data.id,
        isPriority: data.isPriority === true,
        opts: type === 'stream_generate' ? { ...(data.opts || {}), streamSegments: true } : (data.opts || null),
      });
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

async function startGeneration(text, voiceName, jobId, opts, isPriority = false) {
  isGenerating = true;
  cancelRequested = false;
  activeGenerationJobId = jobId;
  activeGenerationIsPriority = isPriority === true;
  // Pin this voice's conditioned state for the whole render. A voice
  // registration for the next paragraph arrives mid-generation and moves
  // currentVoiceName, so that variable alone cannot protect it.
  generatingVoiceName = voiceName;
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
        seed: opts?.seed,
        voiceSeed: opts?.voiceSeed,
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
        seed: opts?.seed,
        voiceSeed: opts?.voiceSeed,
        seedSalt: Number(opts?.retryLevel) > 0 ? ('|r' + Number(opts.retryLevel)) : '',
      });
    }

    if (preemptedJobId != null && preemptedJobId === activeGenerationJobId) {
      // Whatever this render produced is a fragment of the paragraph, and the
      // buffer manager would store it as the whole thing. Throw it away and ask
      // for the paragraph again later.
      settleWithError(POCKET_YIELDED_TO_PLAYBACK);
    } else if (allChunks.length > 0) {
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
    activeGenerationIsPriority = false;
    preemptedJobId = null;
    generatingVoiceName = null;
    // The render is over, so the states it pinned can go. Doing this here rather
    // than only on the next conditioning means an idle worker settles back to
    // the cap instead of sitting on every emotion the paragraph happened to use.
    evictExcessConditionedVoices(currentVoiceName);
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
  const explicitSeed = control && (control.voiceSeed != null ? control.voiceSeed : control.seed);
  const voiceSeedSuffix = explicitSeed != null ? ('|s' + explicitSeed) : '';
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

  // Cache jobs used to decode Mimi in 48-frame batches. INT8 dynamic-quant
  // noise depends on decode size, so those takes were a different grain than
  // live 12-frame decodes of the same paragraph. Cache and live now share the
  // live batch size; throughputMode must not change audio.
  const firstChunkFrames = currentBackend === 'webgpu' ? 1 : 3;
  const normalChunkFrames = 12;
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
    const chunkLsdSteps = Math.max(1, Number(meta.lsdSteps) || DEFAULT_LSD_STEPS);
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
    const chunkNoiseSeed = voiceName + '|' + (meta.emotion || 'neutral') + '|' + chunkText + seedSalt + voiceSeedSuffix;
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
              randomLatents[index] = seededGaussian(std, clampAbs);
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
            randomLatents[index] = seededGaussian(std, clampAbs);
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
        currentLatentData[i] = seededGaussian(std, clampAbs);
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
