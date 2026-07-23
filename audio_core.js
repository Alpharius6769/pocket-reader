import { getAudioChunk, saveAudioChunk } from './storage_core.js?v=storage-v6';
import {
  PRONUNCIATION_RULESET_VERSION,
  DEFAULT_POCKET_TEMPERATURE_PRESET,
  DEFAULT_POCKET_QUALITY_MODE,
  getPocketTuningPreset,
  normalizePronunciationOverrides as normalizeTtsPronunciationOverrides,
} from './tts_pronunciation_core.js?v=pron-v8';
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
  recommendedPocketCacheWorkerCount,
  browserMajorVersion,
  detectMobilePlatform,
  probePocketWebGpuEligibility,
  readPocketCalibration,
  writePocketCalibration,
  clearPocketCalibrations,
  calibrationStorageKey,
  buildOptimisticWebGpuCalibration,
  shouldPreferOptimisticWebGpu,
  readWebGpuDemotion,
  writeWebGpuDemotion,
  clearWebGpuDemotion,
  classifyPocketDeviceCapability,
  collectPocketDeviceCapability,
  resolvePocketExpressiveProsody,
  readPocketExpressiveChoice,
  writePocketExpressiveChoice,
  recordPocketTtsCalibration,
  readPocketDeviceBackendPreference,
  readPocketDeviceSetup,
  wasmThreadCandidates,
} from './pocket_backend_policy.js?v=backend-v20';
import {
  POCKET_PERFORMANCE_POLICY_VERSION,
  shouldRetryPocketQuality,
} from './pocket_performance_policy.js?v=performance-v2';

window.isPlaying = false;
window.currentAudio = null;
let neuralState = 'idle';
window._neuralState = () => neuralState;
let neuralStateChangedAt = Date.now();
window._neuralStateAgeMs = () => Date.now() - neuralStateChangedAt;
window._pocketLoadTelemetry = { progress: 0, lastProgressAt: 0, loadedBytes: 0, totalBytes: 0, asset: null };

let _pocketDeviceCapability = classifyPocketDeviceCapability({
  userAgent: navigator.userAgent || '',
  deviceMemory: navigator.deviceMemory,
  hardwareConcurrency: navigator.hardwareConcurrency,
  saveData: navigator.connection?.saveData,
  lowMemoryMode: window.userProfile?.settings?.lowMemoryMode === true,
});
window._pocketDeviceCapability = _pocketDeviceCapability;

window.refreshPocketDeviceCapability = async function refreshPocketDeviceCapability() {
  _pocketDeviceCapability = await collectPocketDeviceCapability({
    storage: localStorage,
    lowMemoryMode: window.userProfile?.settings?.lowMemoryMode === true,
  });
  window._pocketDeviceCapability = _pocketDeviceCapability;
  return _pocketDeviceCapability;
};
window.isPocketDeviceConstrained = () => _pocketDeviceCapability?.constrained !== false;
window.isPocketDeviceMemorySafeMode = () => _pocketDeviceCapability?.memorySafeInference !== false;
window.shouldPocketPrefetchFullStoryVoices = () => _pocketDeviceCapability?.fullStoryVoicePrefetch === true;
window.isPocketExpressiveProsodyEnabled = () => resolvePocketExpressiveProsody({
  capability: _pocketDeviceCapability,
  storage: localStorage,
});
window.setPocketExpressiveProsodyChoice = (enabled) => {
  const choice = enabled ? 'enabled' : 'disabled';
  writePocketExpressiveChoice(localStorage, choice);
  if (window.userProfile?.settings) window.userProfile.settings.expressiveProsody = enabled === true;
  const toggle = document.getElementById('expressive-prosody-toggle');
  if (toggle) {
    toggle.checked = enabled === true;
    toggle.dataset.prInitialized = '1';
    toggle.dataset.prLast = String(toggle.checked);
  }
  return choice;
};
window.getPocketExpressiveProsodyChoice = () => readPocketExpressiveChoice(localStorage);
window.refreshPocketDeviceCapability().catch(() => {});
const POCKET_TTS_INIT_PENDING_KEY = 'pr_pocket_tts_init_pending_v1';
let _pocketInitializationMs = 0;
let _pocketTtsCalibrationRecorded = false;
try {
  const priorCapability = JSON.parse(localStorage.getItem('pr_pocket_device_capability_v1') || 'null');
  _pocketTtsCalibrationRecorded = priorCapability?.ttsCalibration?.initializationSucceeded === true
    && Number.isFinite(priorCapability?.ttsCalibration?.realTimeFactor);
  if (localStorage.getItem(POCKET_TTS_INIT_PENDING_KEY)) {
    recordPocketTtsCalibration(localStorage, { initializationSucceeded: false, interrupted: true });
  }
} catch (_) {}

function _setNeuralState(nextState) {
  neuralState = nextState;
  neuralStateChangedAt = Date.now();
}

// ── Voice lists and normalization layer ──────────────────────────────────────
const POCKET_VOICES = window.POCKET_VOICES || [];
const POCKET_DEFAULT_VOICE = window.POCKET_DEFAULT_VOICE || 'rayne';
const POCKET_SAFE_EMOTIONS = ['neutral', 'calm', 'happy', 'sad', 'worried', 'surprised', 'tired', 'frustrated'];
const POCKET_GATED_EMOTIONS = ['anger', 'excited', 'enthused', 'shout'];
const POCKET_ALL_EMOTIONS = [...POCKET_SAFE_EMOTIONS, ...POCKET_GATED_EMOTIONS, 'confused'];
const POCKET_BALANCED_EMOTIONS = ['neutral', 'calm', 'happy', 'sad', 'worried', 'surprised', 'tired', 'frustrated'];
const POCKET_BALANCED_EMOTION_MAP = {
  anger: 'worried',
  excited: 'happy',
  enthused: 'happy',
  shout: 'happy',
  confused: 'worried',
};
const POCKET_EMOTION_PATTERN = new RegExp(`_(${POCKET_ALL_EMOTIONS.join('|')})$`);
// narrv16: flow-model latent noise is now deterministically seeded per chunk
// (voice+emotion+text) on all generation paths — bumped so existing position-
// keyed cached audio re-renders with the consistent engine instead of the old
// per-render variation.
const POCKET_NARRATION_CACHE_VERSION = 'narrv16';
const POCKET_BACKEND_CACHE_VERSION = 'backendv2';
// Identity-anchored voice pack subpath on B2 (see Back end/tools/build_anchored_pack_v2.py).
// Every v2 emotion state shares a neutral identity anchor, so emotion switches keep
// the same perceived speaker. Loader falls back to the legacy v1 files when a v2
// asset is missing (e.g. before/during upload).
const POCKET_VOICE_PACK_PATH = 'v2/';
// Bump when v2 files are rebuilt in place on B2: busts Cache Storage + the CF
// edge cache, which key by full URL. r2 = pitch-matched anchors.
// r3 = shorter anchor (2.4s) + longer emotion clip for more expressive states.
const POCKET_VOICE_PACK_REV = 'r3';
const POCKET_CHUNKING_VERSION = 'chunkv3';
const POCKET_ARTIFACT_GUARD_VERSION = 'agv3'; // agv3: fatal-only, single identity-preserving retry
const POCKET_PAUSE_PROFILE_VERSION = 'pausev2';
const POCKET_PARAGRAPH_PAUSE_SEC = 0.5;

const POCKET_BALANCED_TEMP_CAPS = {
  neutral: 0.82,
  calm: 0.82,
  sad: 0.82,
  happy: 0.80,
  worried: 0.80,
  tired: 0.80,
  surprised: 0.78,
  frustrated: 0.78,
};
const POCKET_FULL_TEMP_CAPS = {
  neutral: 0.88,
  calm: 0.88,
  sad: 0.88,
  happy: 0.84,
  worried: 0.84,
  tired: 0.84,
  surprised: 0.80,
  frustrated: 0.80,
  anger: 0.80,
  excited: 0.80,
  enthused: 0.80,
  shout: 0.80,
  confused: 0.80,
};
function _normalizeVoice(engine, voice) {
  if (engine !== 'pocket') return voice || '';
  const saved = window.userProfile?.settings?.pocketVoice || POCKET_DEFAULT_VOICE;
  const canonical = typeof window.canonicalPocketVoice === 'function'
    ? window.canonicalPocketVoice(voice || saved)
    : String(voice || saved || POCKET_DEFAULT_VOICE).toLowerCase().trim();
  if (POCKET_VOICES.includes(canonical) || window.POCKET_VOICE_ASSET_IDS?.includes(canonical)) {
    return canonical;
  }
  return POCKET_DEFAULT_VOICE;
}

function _baseVoiceId(voice) {
  const normalized = _normalizeVoice('pocket', voice);
  if (POCKET_VOICES.includes(normalized)) return normalized;
  const match = normalized.match(POCKET_EMOTION_PATTERN);
  const base = match ? normalized.slice(0, -match[0].length) : normalized;
  return POCKET_VOICES.includes(base) ? base : POCKET_DEFAULT_VOICE;
}

function _emotionFromAssetVoice(voice) {
  const normalized = _normalizeVoice('pocket', voice);
  const match = normalized.match(POCKET_EMOTION_PATTERN);
  return match ? match[1] : null;
}

function _emotionMode() {
  const mode = window.currentStory?.narrationPreset?.emotion || window.userProfile?.settings?.voiceEmotionMode || 'neutral';
  return ['neutral', 'balanced'].includes(mode) ? mode : 'neutral';
}

function _detectPocketEmotion(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  if (!raw.trim()) {
    return {
      emotion: 'neutral',
      rawEmotion: 'neutral',
      score: 0,
      threshold: 0,
      confidence: 0,
      evidenceCount: 0,
      highConfidence: false,
      scores: {},
    };
  }

  const words = raw.match(/[a-zA-Z]{2,}/g) || [];
  const uppercaseWords = words.filter((word) => word.length > 2 && word === word.toUpperCase());
  const emphatic = /!!|\?!|!\?/.test(raw) || (uppercaseWords.length >= 2 && uppercaseWords.length / Math.max(words.length, 1) > 0.35);
  const scores = {
    calm: 0,
    happy: 0,
    sad: 0,
    worried: 0,
    surprised: 0,
    tired: 0,
    frustrated: 0,
    anger: 0,
  };
  const add = (emotion, pattern, weight) => {
    const matches = lower.match(pattern);
    if (matches) {
      scores[emotion] += matches.length * weight;
      evidenceCount += matches.length;
    }
  };
  let evidenceCount = 0;

  add('anger', /\b(angry|anger|furious|fury|rage|raging|hate|hated|snarl|growl|murder|murdered)\b/g, 3);
  add('happy', /\b(excited|thrilled|amazing|wonderful|fantastic|delighted|laugh|laughed|laughing|grin|smile|cheer)\b/g, 2);
  add('sad', /\b(sad|sorrow|cry|cried|crying|tears|wept|death|dead|died|dying|loss|grief|lonely|heartbroken)\b/g, 2.5);
  add('worried', /\b(worry|worried|fear|feared|afraid|scared|terror|danger|threat|anxious|nervous|panic|panicked|dread)\b/g, 2.5);
  add('surprised', /\b(suddenly|gasp|gasped|startled|surprise|surprised|shocked|stunned|flinch|flinched)\b/g, 2);
  add('tired', /\b(tired|sleepy|exhausted|weary|yawn|yawned|weakly|drained)\b/g, 2.5);
  add('frustrated', /\b(frustrated|annoyed|irritated|impossible|ugh|groan|groaned|muttered)\b/g, 2);
  add('calm', /\b(softly|quietly|gently|calm|calmly|peaceful|whispered|murmured|soothing)\b/g, 2);

  if (emphatic) {
    if (scores.anger >= 3) scores.anger += 1.5;
    if (scores.happy >= 2) scores.happy += 1;
    if (scores.surprised >= 2) scores.surprised += 1;
    evidenceCount += 1;
  }

  let best = 'neutral';
  let bestScore = 0;
  Object.entries(scores).forEach(([emotion, score]) => {
    if (score > bestScore) {
      best = emotion;
      bestScore = score;
    }
  });

  const threshold = words.length < 12 ? 3.0 : 2.05;
  const confidence = threshold > 0 ? bestScore / threshold : 0;
  let emotion = bestScore < threshold ? 'neutral' : best;
  return {
    emotion,
    rawEmotion: best,
    score: Number(bestScore.toFixed(2)),
    threshold,
    confidence: Number(confidence.toFixed(2)),
    evidenceCount,
    highConfidence: confidence >= 1.35 && evidenceCount >= 2,
    scores,
  };
}

// ── Deterministic per-chapter emotion plan ───────────────────────────────────
// Per-chunk keyword voting makes narration flip conditioning files sentence to
// sentence. Each {voice}_{emotion}.safetensors is a snapshot of a *different
// reference recording*, so rapid switches read as identity drift ("the narrator
// became a different person"). The plan runs the same detector over a chapter's
// paragraphs IN ORDER exactly once, then applies hysteresis so emotion switches
// are rare, sustained, and — because the pass is deterministic — identical
// across live playback, background caching, prefetch order, and re-listens.
const EMOTION_PLAN_VERSION = 'plan-v2'; // v2: easier sustained switch-in for more expressive narration
const EMOTION_PLAN_DWELL = 2;       // paragraphs to hold an emotion after switching
const EMOTION_PLAN_QUIET_EXIT = 2;  // consecutive quiet paragraphs before neutral
const _emotionPlans = new Map();

function _lookupChapterParagraphs(storyTitle, chapIdx) {
  const stories = [];
  if (window.currentStory) stories.push(window.currentStory);
  if (Array.isArray(window.userProfile?.library)) stories.push(...window.userProfile.library);
  for (const story of stories) {
    if (!story || story.title !== storyTitle) continue;
    const chap = story.chapters?.[chapIdx];
    if (chap && Array.isArray(chap.paragraphs)) return chap.paragraphs;
  }
  return null;
}

function _buildEmotionPlan(paragraphs) {
  const plan = new Array(paragraphs.length);
  let current = 'neutral';
  let dwell = 0;        // paragraphs remaining before another switch is allowed
  let quietRun = 0;     // consecutive low-signal paragraphs while non-neutral
  let pendingEmotion = null;
  let pendingRun = 0;   // consecutive paragraphs voting for pendingEmotion

  for (let i = 0; i < paragraphs.length; i++) {
    const info = _detectPocketEmotion(paragraphs[i] || '');
    const detected = info.emotion;
    const quiet = info.score < info.threshold * 0.5;

    if (dwell > 0) dwell--;

    if (detected !== 'neutral' && detected === pendingEmotion) {
      pendingRun++;
    } else if (detected !== 'neutral') {
      pendingEmotion = detected;
      pendingRun = 1;
    } else {
      pendingEmotion = null;
      pendingRun = 0;
    }

    if (detected === current) {
      quietRun = 0;
    } else if (detected !== 'neutral') {
      // Switch only on strong single-paragraph evidence or a sustained two-
      // paragraph vote, and never inside the post-switch dwell window.
      // 0.75 (was 0.9): lets moderately-voiced scenes reach their emotion state
      // instead of staying neutral — the pitch-matched pack keeps timbre stable
      // enough that the extra switches no longer read as speaker changes.
      const sustained = pendingRun >= 2 && info.confidence >= 0.75;
      if (dwell === 0 && (info.highConfidence || sustained)) {
        current = detected;
        dwell = EMOTION_PLAN_DWELL;
        quietRun = 0;
      }
    } else if (current !== 'neutral') {
      // Return to neutral only after a sustained quiet stretch, so a single
      // signal-free paragraph mid-scene doesn't bounce the conditioning file.
      quietRun = quiet ? quietRun + 1 : 0;
      if (dwell === 0 && quietRun >= EMOTION_PLAN_QUIET_EXIT) {
        current = 'neutral';
        quietRun = 0;
      }
    }

    plan[i] = current;
  }
  return plan;
}

function _planEmotionFor(ctx) {
  if (!ctx || ctx.storyTitle == null || ctx.chapIdx == null || ctx.paraIdx == null) return null;
  const key = `${EMOTION_PLAN_VERSION}::${ctx.storyTitle}::${ctx.chapIdx}::${_emotionMode()}`;
  let plan = _emotionPlans.get(key);
  if (!plan) {
    const paragraphs = _lookupChapterParagraphs(ctx.storyTitle, ctx.chapIdx);
    if (!paragraphs) return null;
    if (_emotionPlans.size > 24) _emotionPlans.clear();
    plan = _buildEmotionPlan(paragraphs);
    _emotionPlans.set(key, plan);
  }
  const emotion = plan[ctx.paraIdx];
  return typeof emotion === 'string' ? emotion : null;
}

function _balancedLowConfidenceFallback(emotion, emotionInfo) {
  const scores = emotionInfo?.scores || {};
  if (emotion === 'surprised') {
    if ((scores.happy || 0) >= (scores.worried || 0) && (scores.happy || 0) > 0) return 'happy';
    if ((scores.worried || 0) > 0 || (scores.sad || 0) > 0) return 'worried';
    return 'calm';
  }
  if (emotion === 'frustrated') {
    if ((scores.worried || 0) > 0 || (scores.anger || 0) > 0) return 'worried';
    return 'calm';
  }
  return POCKET_BALANCED_EMOTION_MAP[emotion] || emotion;
}

function _resolveEmotionForVoice(baseVoice, requestedEmotion, emotionInfo = null) {
  const mode = _emotionMode();
  const emotion = POCKET_ALL_EMOTIONS.includes(requestedEmotion) ? requestedEmotion : 'neutral';
  if (mode === 'neutral') return 'neutral';
  const voice = window.POCKET_VOICE_PACK?.voices?.find((candidate) => candidate.id === baseVoice);
  const available = voice?.availableEmotions || POCKET_SAFE_EMOTIONS;
  const fallbacks = voice?.fallbackEmotions || {};
  let resolved;

  if (mode === 'balanced') {
    if ((emotion === 'surprised' || emotion === 'frustrated') && !emotionInfo?.highConfidence) {
      resolved = _balancedLowConfidenceFallback(emotion, emotionInfo);
    } else {
      resolved = POCKET_BALANCED_EMOTION_MAP[emotion] || emotion;
    }
  } else {
    resolved = emotion;
  }

  if (mode === 'balanced' && !POCKET_BALANCED_EMOTIONS.includes(resolved)) {
    resolved = POCKET_BALANCED_EMOTION_MAP[resolved] || fallbacks[resolved] || 'neutral';
  }
  if (POCKET_GATED_EMOTIONS.includes(resolved)) {
    resolved = fallbacks[resolved] || 'neutral';
  }
  if (!available.includes(resolved)) {
    resolved = fallbacks[resolved] || 'neutral';
  }
  if (mode === 'balanced' && !POCKET_BALANCED_EMOTIONS.includes(resolved)) {
    resolved = POCKET_BALANCED_EMOTION_MAP[resolved] || 'neutral';
  }
  if (!available.includes(resolved)) resolved = 'neutral';
  return resolved;
}

const _resolveActiveEngine = window._resolveActiveEngine;

// Auto-recovery: Clear cached neural voice assets once before engine loads
async function _clearCorruptedCacheOnce() {
  if (localStorage.getItem('pr_cache_cleared_v4')) return;
  if ('caches' in window) {
    try {
      await caches.delete('pocket-voices');
      localStorage.setItem('pr_cache_cleared_v4', 'true');
      console.log('Successfully cleared neural voice cache.');
    } catch (e) {
      console.error('Cache clear error:', e);
    }
  }
}

// Assemble per-generation prosody options for the Pocket worker from user
// settings. Returns null when every expressive feature is at its default so the
// worker stays on its exact original code path (no behaviour change unless the
// user opts in). Pause tags default ON — harmless when no [Ns] tags are present.
function _normalizePronunciationOverridesForTts() {
  const s = window.userProfile?.settings || {};
  const storyOverrides = window.currentStory?.narrationPreset?.pronunciationOverrides;
  return normalizeTtsPronunciationOverrides([
    ...(Array.isArray(storyOverrides) ? storyOverrides : []),
    ...(Array.isArray(s.pronunciationOverrides) ? s.pronunciationOverrides : []),
  ]);
}

function _hashCachePart(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function _pronunciationOverrideHash() {
  return _hashCachePart(JSON.stringify(_normalizePronunciationOverridesForTts()));
}

function _pocketTemperaturePresetName() {
  const s = window.userProfile?.settings || {};
  const mode = _emotionMode();
  const requested = ['stable', 'balanced', 'expressive'].includes(s.pocketTemperaturePreset)
    ? s.pocketTemperaturePreset
    : DEFAULT_POCKET_TEMPERATURE_PRESET;
  return getPocketTuningPreset(requested, mode).name;
}

function _pocketQualityMode() {
  const s = window.userProfile?.settings || {};
  return (s.pocketQualityMode === 'quality' && s.enablePocketBenchmarkQuality === true)
    ? 'quality'
    : DEFAULT_POCKET_QUALITY_MODE;
}

function _pocketTuningConfig() {
  const mode = _emotionMode();
  const preset = getPocketTuningPreset(_pocketTemperaturePresetName(), mode);
  const qualityMode = _pocketQualityMode();
  return {
    presetName: preset.name,
    temperature: preset.temperature,
    qualityMode,
    lsdSteps: qualityMode === 'quality' ? 4 : (preset.lsdSteps || 1),
    allowBenchmarkQuality: qualityMode === 'quality',
  };
}

function _artifactCappedTemperature(baseTemperature, emotion, retryLevel = 0) {
  const mode = _emotionMode();
  const caps = POCKET_BALANCED_TEMP_CAPS;
  const cap = caps[emotion] || caps.neutral || baseTemperature;
  const capped = Math.min(Number(baseTemperature) || cap, cap);
  return Number(Math.max(0.5, capped - (retryLevel ? 0.06 : 0)).toFixed(2));
}

function _resolvePocketRoute(engine, voice, text, ctx = null) {
  if (engine !== 'pocket') {
    return { voiceId: _normalizeVoice(engine, voice || null), baseVoice: voice || '', emotion: 'neutral', emotionInfo: null };
  }
  const baseVoice = _baseVoiceId(voice || window.userProfile?.settings?.pocketVoice || POCKET_DEFAULT_VOICE);
  const lockedEmotion = _emotionFromAssetVoice(voice);
  const expressive = window.isPocketExpressiveProsodyEnabled?.()
    ?? (window.userProfile?.settings?.expressiveProsody !== false);
  // Position-aware chapter plan wins over per-chunk detection: it applies the
  // same detector with hysteresis, so every reader of this chunk (live player,
  // background cacher, re-listen) resolves the same emotion. highConfidence is
  // set because the plan has already applied its own confidence gating.
  const plannedEmotion = (!lockedEmotion && expressive) ? _planEmotionFor(ctx) : null;
  const emotionInfo = lockedEmotion ? {
    emotion: lockedEmotion,
    rawEmotion: lockedEmotion,
    score: 0,
    threshold: 0,
    confidence: 99,
    evidenceCount: 99,
    highConfidence: true,
    scores: {},
  } : plannedEmotion != null ? {
    emotion: plannedEmotion,
    rawEmotion: plannedEmotion,
    score: 0,
    threshold: 0,
    confidence: 1.5,
    evidenceCount: 2,
    highConfidence: true,
    scores: {},
  } : (expressive
       ? _detectPocketEmotion(text)
       : {
         emotion: 'neutral',
         rawEmotion: 'neutral',
         score: 0,
         threshold: 0,
         confidence: 0,
         evidenceCount: 0,
         highConfidence: false,
         scores: {},
       });
  const requestedEmotion = lockedEmotion || emotionInfo?.emotion || 'neutral';
  const emotion = _resolveEmotionForVoice(baseVoice, requestedEmotion, emotionInfo);
  const voiceId = typeof window.resolvePocketAssetVoiceId === 'function'
    ? window.resolvePocketAssetVoiceId(baseVoice, emotion)
    : `${baseVoice}_${emotion}`;
  return { voiceId, baseVoice, emotion, emotionInfo };
}

function _isPocketThroughputCache() {
  return window._pocketThroughputCache === true;
}

function _buildPocketProsodyOpts(selectedVoice, overrides = {}) {
  const s = window.userProfile?.settings || {};
  const throughput       = _isPocketThroughputCache() || overrides.throughputMode === true;
  const expressive       = window.isPocketExpressiveProsodyEnabled?.() ?? (s.expressiveProsody !== false);
  // Punctuation-pause splitting is opt-in. The previous default-ON behavior
  // shattered paragraphs into many tiny chunks and dominated mobile cache time.
  // Background caching always disables it for throughput.
  const pausePunctuation = throughput ? false : (s.pausePunctuation === true);
  const pauseTags        = s.pauseTags !== false;
  const wordsMode        = s.chunkMode === 'words';
  const tuning           = _pocketTuningConfig();
  const paragraphEmotion = overrides.paragraphEmotion || _emotionFromAssetVoice(selectedVoice) || 'neutral';
  const retryLevel       = Number(overrides.retryLevel) || 0;
  const temperature      = overrides.temperature != null
    ? Number(overrides.temperature)
    : _artifactCappedTemperature(tuning.temperature, paragraphEmotion, retryLevel);

  return {
    expressive,
    stableProsody: true,
    paragraphEmotion,
    pausePunctuation,
    pauseTags,
    pauseProfileVersion: POCKET_PAUSE_PROFILE_VERSION,
    paragraphPauseSec: throughput ? Math.min(POCKET_PARAGRAPH_PAUSE_SEC, 0.15) : POCKET_PARAGRAPH_PAUSE_SEC,
    chunkMode: wordsMode ? 'words' : 'sentence',
    minWords: Number(s.chunkMinWords) || 8,
    maxWords: Number(s.chunkMaxWords) || 40,
    pronunciationOverrides: _normalizePronunciationOverridesForTts(),
    pronunciationRulesetVersion: PRONUNCIATION_RULESET_VERSION,
    emotionMode: _emotionMode(),
    temperaturePreset: tuning.presetName,
    temperature,
    qualityMode: tuning.qualityMode,
    lsdSteps: tuning.lsdSteps,
    allowBenchmarkQuality: tuning.allowBenchmarkQuality,
    artifactGuardVersion: POCKET_ARTIFACT_GUARD_VERSION,
    retryLevel,
    throughputMode: throughput,
    // Avoid large paragraph-wide transient tensors on iOS/constrained
    // browsers. High-memory devices retain the 176-token cache fast path.
    tokenSoftCap: window.isPocketDeviceMemorySafeMode?.() !== false ? 120 : (throughput ? 176 : 120),
  };
}

// Cache discriminator for expressive prosody. Audio rendered with different
// prosody/chunking settings must not collide in IndexedDB, so we fold a compact
// tag into the cache-key voice segment. Reuses _buildPocketProsodyOpts so the tag
// is non-empty exactly when non-default opts are sent to the worker — meaning
// existing Pocket caches with all features off keep their keys and still hit.
// The tag never reaches the worker or voice resolution; it is purely
// a storage key suffix.
function _prosodyCacheTag(engine, throughputOverride = null) {
  if (engine !== 'pocket') return '';
  const s = window.userProfile?.settings || {};
  const wordsMode = s.chunkMode === 'words';
  const throughput = throughputOverride == null ? _isPocketThroughputCache() : throughputOverride === true;
  const parts = [
    POCKET_NARRATION_CACHE_VERSION,
    POCKET_CHUNKING_VERSION,
    PRONUNCIATION_RULESET_VERSION,
    s.expressiveProsody !== false ? 'ex' : 'nex',
    `m${_emotionMode()}`,
    `tp${_pocketTemperaturePresetName()}`,
    `q${_pocketQualityMode()}`,
    (s.pausePunctuation === true ? 'pp' : 'np'),
    s.pauseTags !== false ? 'pt' : 'nt',
    throughput ? 'tt176' : 'ntt120',
    POCKET_PAUSE_PROFILE_VERSION,
    `pg${String(POCKET_PARAGRAPH_PAUSE_SEC).replace('.', '_')}`,
    POCKET_ARTIFACT_GUARD_VERSION,
    POCKET_PERFORMANCE_POLICY_VERSION,
    POCKET_BACKEND_CACHE_VERSION,
    `be${_pocketBackendRuntime.selectedBackend}`,
    `mp${_pocketBackendRuntime.precision}`,
    `ort${POCKET_ORT_VERSION}`,
    `mr${_pocketBackendRuntime.modelRevision}`,
    `gc${_pocketBackendRuntime.graphCapture ? 1 : 0}`,
    `md${_pocketBackendRuntime.mimiProvider || 'wasm-threaded'}`,
    `sg${_pocketBackendRuntime.gpuSyncGroupBlocks || 1}`,
    POCKET_CALIBRATION_VERSION,
    POCKET_ACCELERATION_VERSION,
    `wt${_pocketBackendRuntime.threadCount || 1}`,
    wordsMode ? `w${Number(s.chunkMinWords) || 8}-${Number(s.chunkMaxWords) || 40}` : 'sent',
    `pr${_pronunciationOverrideHash()}`,
  ];
  return '#' + parts.join('-');
}
window._prosodyCacheTag = _prosodyCacheTag;

// Cache-key tags for BOTH render modes, current mode first. The background
// cacher renders with the throughput tag (tt176) while live playback computes
// the non-throughput tag (ntt120); with exact-key IndexedDB lookups, each side
// was blind to audio the other had already rendered — playback re-synthesized
// paragraphs that were sitting in the cache. Readers should try every variant.
function _prosodyCacheTagVariants(engine) {
  if (engine !== 'pocket') return [''];
  const current = _prosodyCacheTag(engine);
  const flipped = _prosodyCacheTag(engine, !_isPocketThroughputCache());
  return current === flipped ? [current] : [current, flipped];
}
window._prosodyCacheTagVariants = _prosodyCacheTagVariants;

window.getPocketTtsRuntimeConfig = function getPocketTtsRuntimeConfig() {
  const s = window.userProfile?.settings || {};
  const tuning = _pocketTuningConfig();
  const selectedCalibration = _pocketBackendRuntime.calibration?.[_pocketBackendRuntime.selectedBackend];
  return {
    engine: s.voiceEngine || 'pocket',
    speed: Number(s.speed || 1),
    cacheVersion: POCKET_NARRATION_CACHE_VERSION,
    chunkingVersion: POCKET_CHUNKING_VERSION,
    pronunciationRulesetVersion: PRONUNCIATION_RULESET_VERSION,
    pronunciationOverrideCount: _normalizePronunciationOverridesForTts().length,
    builtInPronunciationRuleCount: typeof window.getBuiltInPronunciationRuleCount === 'function'
      ? window.getBuiltInPronunciationRuleCount()
      : null,
    emotionMode: _emotionMode(),
    expressiveProsody: s.expressiveProsody !== false,
    temperaturePreset: tuning.presetName,
    temperature: tuning.temperature,
    artifactGuardVersion: POCKET_ARTIFACT_GUARD_VERSION,
    performancePolicyVersion: POCKET_PERFORMANCE_POLICY_VERSION,
    pauseProfileVersion: POCKET_PAUSE_PROFILE_VERSION,
    paragraphPauseSec: POCKET_PARAGRAPH_PAUSE_SEC,
    qualityMode: tuning.qualityMode,
    lsdSteps: tuning.lsdSteps,
    pausePunctuation: s.pausePunctuation === true,
    pauseTags: s.pauseTags !== false,
    pocketVoice: _baseVoiceId(s.pocketVoice || POCKET_DEFAULT_VOICE),
    backendPreference: normalizePocketBackend(s.pocketBackend),
    selectedBackend: _pocketBackendRuntime.selectedBackend,
    modelPrecision: _pocketBackendRuntime.precision,
    modelRevision: _pocketBackendRuntime.modelRevision,
    ortVersion: POCKET_ORT_VERSION,
    calibrationVersion: POCKET_CALIBRATION_VERSION,
    accelerationVersion: POCKET_ACCELERATION_VERSION,
    wasmThreadCount: _pocketBackendRuntime.threadCount || 1,
    gpuResidentStateBytes: _pocketBackendRuntime.gpuResidentStateBytes,
    operatorFallbackCount: _pocketBackendRuntime.operatorFallbackCount ?? null,
    graphCapture: _pocketBackendRuntime.graphCapture === true,
    mimiProvider: _pocketBackendRuntime.mimiProvider || 'wasm-threaded',
    gpuSyncGroupBlocks: Number(_pocketBackendRuntime.gpuSyncGroupBlocks || 1),
    medianMs: selectedCalibration?.medianMs ?? null,
    p95Ms: selectedCalibration?.p95Ms ?? null,
    backendRejectionReason: _pocketBackendRuntime.rejectionReason || '',
  };
};

export function resolveVoiceWithSentiment(engine, voice, text, ctx = null) {
  if (engine !== 'pocket') return _normalizeVoice(engine, voice || null);
  return _resolvePocketRoute(engine, voice, text, ctx).voiceId;
}
window.resolveVoiceWithSentiment = resolveVoiceWithSentiment;


// ── Worker pool settings ─────────────────────────────────────────────────────
// maxWorkers is read dynamically from userProfile.settings at engine load time.
const HARD_CAP_WORKERS   = window.HARD_CAP_WORKERS;
const MANUAL_CAP_WORKERS = window.MANUAL_CAP_WORKERS;
const DEFAULT_MAX_WORKERS = window.DEFAULT_MAX_WORKERS;

function _getMaxWorkers() {
  const settings = window.userProfile?.settings || {};
  const cores    = navigator.hardwareConcurrency || 2;
  let n;
  if (settings.enableManualWorkers && settings.maxWorkers) {
    // Manual override: honour the user's choice up to the manual ceiling.
    n = Number(settings.maxWorkers);
    if (isNaN(n) || n < 1) n = DEFAULT_MAX_WORKERS;
    if (n > MANUAL_CAP_WORKERS) n = MANUAL_CAP_WORKERS;
  } else {
    // auto: min(cores, HARD_CAP) but never below 2
    n = Math.min(HARD_CAP_WORKERS, Math.max(2, cores));
    if (isNaN(n) || n < 1) n = DEFAULT_MAX_WORKERS;
  }
  return n;
}

// ── GPU vendor detection ─────────────────────────────────────────────────────
let _gpuVendor = 'unknown';
async function _detectGpuVendor() {
  // Fast WebGL path (works without user gesture)
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      // Try the modern RENDERER parameter first (Firefox-friendly, no deprecation warning)
      let renderer = '';
      let vendor = '';
      try {
        renderer = gl.getParameter(gl.RENDERER) || '';
        vendor = gl.getParameter(gl.VENDOR) || '';
      } catch(e) {}
      // If modern params give generic results, try the deprecated extension as fallback
      // Skip in Firefox — it logs a deprecation warning for WEBGL_debug_renderer_info
      const _isFirefox = navigator.userAgent.includes('Firefox');
      if (!_isFirefox && (!renderer || renderer === 'WebKit WebGL' || renderer.toLowerCase().includes('angle'))) {
        try {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          if (ext) {
            renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || renderer;
            vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || vendor;
          }
        } catch(e) {}
      }
      const combined = (renderer + ' ' + vendor).toLowerCase();
      if (combined.includes('nvidia'))    _gpuVendor = 'nvidia';
      else if (combined.includes('amd') || combined.includes('radeon') || combined.includes('rx ')) _gpuVendor = 'amd';
      else if (combined.includes('intel')) _gpuVendor = 'intel';
      else if (combined.includes('apple')) _gpuVendor = 'apple';
      else if (combined.includes('qualcomm') || combined.includes('adreno')) _gpuVendor = 'qualcomm';
      else if (combined.includes('arm') || combined.includes('mali'))  _gpuVendor = 'arm';
      else if (combined.includes('imagination') || combined.includes('powervr')) _gpuVendor = 'imagination';
      else _gpuVendor = combined.split(' ')[0] || 'unknown';
      if (window.Diagnostics) window.Diagnostics.log('INFO', 'GPU vendor detected via WebGL', { renderer, vendor, resolved: _gpuVendor });
    }
  } catch(e) {}

  // If WebGL gave nothing, try WebGPU adapter info
  if (_gpuVendor === 'unknown' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        let info = { vendor: '', architecture: '' };
        if (adapter.requestAdapterInfo)  { try { info = await adapter.requestAdapterInfo(); } catch(e){} }
        else if (adapter.info)            { info = adapter.info; }
        const v = (info.vendor + ' ' + info.architecture).toLowerCase();
        if (v.includes('nvidia'))   _gpuVendor = 'nvidia';
        else if (v.includes('amd')) _gpuVendor = 'amd';
        else if (v.includes('intel')) _gpuVendor = 'intel';
        else if (v.includes('apple')) _gpuVendor = 'apple';
        if (window.Diagnostics) window.Diagnostics.log('INFO', 'GPU vendor refined via WebGPU', { info, resolved: _gpuVendor });
      }
    } catch(e) {}
  }

  window._gpuVendor = _gpuVendor;
  return _gpuVendor;
}

let ttsWorkers = [];
let ttsQueue = {};
let ttsMsgId = 0;
let _engineReadyResolve = null;
let _engineReadyPromise = null;
let loadedVoiceEngine = null;
let _pocketBackendPlanPromise = null;
let _pocketBackendOptimizationPromise = null;
let _pocketBackendContext = null;
let _pocketCalibration = null;
let _pocketGpuFailureCount = 0;
const _pocketBackendRuntime = {
  preference: 'auto',
  selectedBackend: 'wasm',
  precision: 'int8',
  ortVersion: POCKET_ORT_VERSION,
  modelRevision: POCKET_WASM_MODEL_REVISION,
  calibrationVersion: POCKET_CALIBRATION_VERSION,
  gpuResidentStateBytes: 0,
  rejectionReason: '',
  calibration: null,
  threadCount: 1,
  wasmReferenceRtf: null,
  graphCapture: false,
  mimiProvider: 'wasm-threaded',
  gpuSyncGroupBlocks: 1,
  cacheWorkerCount: 1,
};
window._pocketBackendRuntime = _pocketBackendRuntime;

async function _recommendedPocketCacheWorkers(plan = _pocketBackendRuntime) {
  let battery = null;
  if (window._pocketThroughputCache === true && typeof navigator.getBattery === 'function') {
    try {
      battery = await Promise.race([
        navigator.getBattery(),
        new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
      ]);
    } catch (_) {}
  }
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return recommendedPocketCacheWorkerCount({
    throughputMode: window._pocketThroughputCache === true,
    backend: plan?.selectedBackend || _pocketBackendRuntime.selectedBackend,
    platform: _pocketDeviceCapability?.platform || detectMobilePlatform(navigator.userAgent || ''),
    userAgent: navigator.userAgent || '',
    constrained: _pocketDeviceCapability?.constrained !== false,
    crossOriginIsolated: window.crossOriginIsolated === true,
    deviceMemory: Number(navigator.deviceMemory || 0),
    hardwareConcurrency: Number(navigator.hardwareConcurrency || 0),
    wasmThreads: Number(plan?.threadCount || _pocketBackendRuntime.threadCount || 1),
    saveData: connection?.saveData === true,
    lowMemoryMode: window.userProfile?.settings?.lowMemoryMode === true,
    lowBattery: window._isLowBattery?.() === true,
    batteryLevel: battery ? Number(battery.level) : NaN,
    batteryCharging: battery?.charging,
  });
}
window.getRecommendedPocketCacheWorkerCount = _recommendedPocketCacheWorkers;

async function _preparePocketBackendPlan(force = false) {
  if (_pocketBackendPlanPromise && !force) return _pocketBackendPlanPromise;
  _pocketBackendPlanPromise = (async () => {
    const settings = window.userProfile?.settings || {};
    const preference = readPocketDeviceBackendPreference(localStorage);
    delete settings.pocketBackend;
    const deviceSetup = readPocketDeviceSetup(localStorage);
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const userAgent = navigator.userAgent || '';
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
    const platform = detectMobilePlatform(userAgent);
    const stickyContext = {
      browserMajor: browserMajorVersion(userAgent),
      isolated: window.crossOriginIsolated === true,
      platform,
      userAgent,
    };
    const stickyDemotion = readWebGpuDemotion(localStorage, stickyContext);
    const threadOptions = {
      crossOriginIsolated: window.crossOriginIsolated === true,
      hardwareConcurrency: Number(navigator.hardwareConcurrency || 0),
      mobile,
      platform,
      userAgent,
      saveData: !!connection?.saveData,
      memoryGb: Number(navigator.deviceMemory || 0),
      lowMemoryMode: !!settings.lowMemoryMode,
      demotedFromWebGpu: stickyDemotion?.demotedFromWebGpu === true,
    };
    let eligibility = await probePocketWebGpuEligibility({
      lowMemoryMode: !!settings.lowMemoryMode,
      saveData: !!connection?.saveData,
      mobile,
      platform,
      userAgent,
      hardwareConcurrency: threadOptions.hardwareConcurrency,
      memoryGb: threadOptions.memoryGb,
      crossOriginIsolated: threadOptions.crossOriginIsolated,
      demotedFromWebGpu: threadOptions.demotedFromWebGpu,
      demotionReason: stickyDemotion?.reason || '',
      // Mobile optimistic WebGPU auto-start is off; Pixel / Android auto uses
      // threaded WASM (x4 on flagships). Settings → WebGPU still opts in.
      optimisticAuto: preference === 'auto',
      // Explicit Settings choice still forces the full WebGPU path.
      allowMobileWebGpu: preference === 'webgpu',
    });
    // HEAD probe whenever WebGPU is in play so a missing bundle downgrades
    // cleanly before any download starts.
    const shouldProbeBundle = eligibility.eligible && preference !== 'wasm';
    if (shouldProbeBundle) {
      const proxyBase = window.PR_PROXY_BASE || window.POCKET_READER_CONFIG?.proxyBase || 'https://pocket-reader-proxy.christopher-gotham67.workers.dev';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`${proxyBase}/models/Pocket%20TTS%20Onnx/${encodeURIComponent(POCKET_WEBGPU_BUNDLE)}/bundle.json`, {
          method: 'HEAD', signal: controller.signal,
        });
        if (!response.ok) eligibility = { ...eligibility, eligible: false, reason: `WebGPU model assets are unavailable (HTTP ${response.status}).` };
      } catch (error) {
        eligibility = { ...eligibility, eligible: false, reason: `WebGPU model assets could not be verified: ${error?.message || error}` };
      } finally {
        clearTimeout(timer);
      }
    }
    _pocketBackendContext = {
      adapterIdentity: eligibility.adapterIdentity || 'unknown-adapter',
      browserMajor: stickyContext.browserMajor,
      isolated: stickyContext.isolated,
      platform,
      userAgent,
    };
    _pocketCalibration = readPocketCalibration(localStorage, _pocketBackendContext);
    // Retire records the retired never-WebGPU-on-mobile policy force-wrote:
    // they were policy artifacts, not measurements, and would otherwise pin
    // existing devices to WASM forever under the new default.
    if (_pocketCalibration?.rejectionReason === 'Mobile auto defaults to threaded WASM.') {
      _pocketCalibration = null;
      try { localStorage.removeItem(calibrationStorageKey(_pocketBackendContext)); } catch (_) {}
    }
    if (stickyDemotion?.demotedFromWebGpu && _pocketCalibration?.selectedBackend === 'webgpu') {
      _pocketCalibration = {
        ..._pocketCalibration,
        selectedBackend: 'wasm',
        optimistic: false,
        demotedFromWebGpu: true,
        rejectionReason: stickyDemotion.reason || _pocketCalibration.rejectionReason || '',
      };
      writePocketCalibration(localStorage, _pocketBackendContext, _pocketCalibration);
    }
    // On mobile, always take the isolation-aware recommendation. Stale
    // calibration records with threadCount:1 previously forced single-thread
    // WASM even inside a healthy ?tts_fast=1 session.
    const recommendedThreads = recommendedWasmThreadCount(threadOptions);
    const calibratedThreads = Number(_pocketCalibration?.threadCount) || 0;
    const setupThreads = Number(deviceSetup?.wasmThreads) || 0;
    const allowedThreads = wasmThreadCandidates(threadOptions);
    const setupApplies = allowedThreads.includes(setupThreads);
    const threadCount = setupApplies
      ? setupThreads
      : (mobile ? recommendedThreads : (calibratedThreads >= 2 ? calibratedThreads : recommendedThreads));
    // Parity demotion must compare WebGPU against this device's REAL WASM
    // speed, never the modeled estimate: field data (2026-07-16) showed the
    // Pixel-anchored model runs 2.7x optimistic on mid-range phones, which
    // would demote a genuinely faster GPU backend. With no measurement the
    // worker falls back to the absolute real-time limit instead.
    const measuredWasmRtf = Number(_pocketCalibration?.measuredWasmRtf);
    const wasmReferenceRtf = Number.isFinite(measuredWasmRtf) && measuredWasmRtf > 0
      ? measuredWasmRtf
      : null;
    const calibratedGpu = _pocketCalibration?.selectedBackend === 'webgpu';
    let selectedBackend = 'wasm';
    let rejectionReason = eligibility.reason || '';
    if (stickyDemotion?.demotedFromWebGpu) {
      selectedBackend = 'wasm';
      rejectionReason = stickyDemotion.reason || rejectionReason || 'WebGPU was demoted on this device.';
    } else if (preference === 'webgpu' && eligibility.eligible && calibratedGpu) {
      selectedBackend = 'webgpu';
    } else if (preference === 'auto' && eligibility.eligible && _pocketCalibration) {
      selectedBackend = _pocketCalibration.selectedBackend;
    } else if (preference === 'auto' && deviceSetup) {
      selectedBackend = deviceSetup.recommendedBackend === 'webgpu' && eligibility.eligible ? 'webgpu' : 'wasm';
      if (selectedBackend === 'webgpu') {
        _pocketCalibration = buildOptimisticWebGpuCalibration({ threadCount });
        _pocketCalibration.setupQualified = true;
        writePocketCalibration(localStorage, _pocketBackendContext, _pocketCalibration);
        rejectionReason = '';
      } else if (!rejectionReason) {
        rejectionReason = deviceSetup.reason || 'This device setup selected threaded WASM.';
      }
    } else if (shouldPreferOptimisticWebGpu({
      preference,
      eligible: eligibility.eligible,
      calibration: _pocketCalibration,
      demotedFromWebGpu: false,
      ...threadOptions,
    })) {
      selectedBackend = 'webgpu';
      _pocketCalibration = buildOptimisticWebGpuCalibration({ threadCount });
      writePocketCalibration(localStorage, _pocketBackendContext, _pocketCalibration);
      rejectionReason = '';
    } else if (preference === 'webgpu' && !calibratedGpu && !rejectionReason) {
      rejectionReason = 'WebGPU must pass optimization on this device before manual selection.';
    }
    Object.assign(_pocketBackendRuntime, {
      preference,
      selectedBackend,
      precision: selectedBackend === 'webgpu' ? 'fp16' : 'int8',
      modelRevision: selectedBackend === 'webgpu' ? POCKET_WEBGPU_MODEL_REVISION : POCKET_WASM_MODEL_REVISION,
      gpuResidentStateBytes: selectedBackend === 'webgpu' ? POCKET_GPU_RESIDENT_STATE_BYTES : 0,
      rejectionReason,
      eligibility: { ...eligibility, adapter: undefined },
      calibration: _pocketCalibration,
      threadCount,
      wasmReferenceRtf,
      demotedFromWebGpu: stickyDemotion?.demotedFromWebGpu === true,
      graphCapture: selectedBackend === 'webgpu' && _pocketCalibration?.graphCapture === true,
      mimiProvider: selectedBackend === 'webgpu' ? (_pocketCalibration?.mimiProvider || 'wasm-threaded') : 'wasm-threaded',
      gpuSyncGroupBlocks: selectedBackend === 'webgpu' ? Number(_pocketCalibration?.gpuSyncGroupBlocks || 4) : 1,
    });
    return { preference, selectedBackend, eligibility, calibration: _pocketCalibration, context: _pocketBackendContext, threadCount };
  })();
  return _pocketBackendPlanPromise;
}
// Kick off GPU detection immediately on module load (async, non-blocking)
const _gpuDetectionPromise = _detectGpuVendor();

// Recover from a Pocket worker that dies AFTER it became ready — an uncaught
// worker error, a WASM abort(), or the browser terminating the worker under
// memory pressure. Web Worker onerror is otherwise a no-op once ready, so the
// in-flight generation promise never settled and the caller (cache loop or live
// playback) hung until the 600s worker timeout; with Pocket capped to one
// worker, every subsequent paragraph then dispatched to the same dead worker
// and hung too. Reject pending synthesis so callers fail fast (the cache loop's
// error path re-queues and retries), then reset engine state so the next
// generateChunk rebuilds the worker pool from scratch.
let _pocketCrashRecoveryCount = 0;
function _recoverFromPocketWorkerCrash(workerObj, reason) {
  if (workerObj && workerObj._crashHandled) return;
  if (workerObj) workerObj._crashHandled = true;
  _pocketCrashRecoveryCount++;
  console.error('[PocketTTS] Narration worker crashed after ready — recovering:', reason);
  window.Diagnostics?.log('ERROR', 'Pocket worker crashed after ready', {
    reason: String(reason || 'unknown'),
    recoveryCount: _pocketCrashRecoveryCount,
  });
  ttsWorkers.forEach((w) => { try { w?.worker?.terminate(); } catch (_) {} });
  ttsWorkers = [];
  Object.values(ttsQueue).forEach((entry) => {
    try { entry.reject(new Error('Narration worker crashed; retrying.')); } catch (_) {}
  });
  ttsQueue = {};
  _encodedPocketVoices = new Set();
  _pocketVoiceLoadPromises.clear();
  _pocketBackendOptimizationPromise = null;
  _setNeuralState('idle');
  loadedVoiceEngine = null;
}

async function _loadPocketEngine() {
  const initializationStartedAt = performance.now();
  const engine = _resolveActiveEngine();
  const settings = window.userProfile?.settings || {};
  if (engine !== 'pocket') return false;

  if (loadedVoiceEngine !== engine) {
    console.log(`[AudioCore] Voice engine changed from ${loadedVoiceEngine} to ${engine}. Terminating active workers.`);
    ttsWorkers.forEach(w => {
      if (w && w.worker) w.worker.terminate();
    });
    ttsWorkers = [];
    // Reject all pending synthesis promises so callers don't hang for 600s
    Object.values(ttsQueue).forEach(entry => {
      try { entry.reject(new Error('TTS engine reloaded')); } catch(_) {}
    });
    ttsQueue = {};
    _encodedPocketVoices = new Set();
    _pocketVoiceLoadPromises.clear();
    _setNeuralState('idle');
    loadedVoiceEngine = null;
  }

  if (neuralState === 'ready') return true;
  if (neuralState === 'loading') {
    await _engineReadyPromise;
    return neuralState === 'ready';
  }

  loadedVoiceEngine = engine;

  // Ensure any corrupted AI caches are wiped before the engine tries to load
  await _clearCorruptedCacheOnce();



  _setNeuralState('loading');
  try { localStorage.setItem(POCKET_TTS_INIT_PENDING_KEY, String(Date.now())); } catch (_) {}
  window._pocketLoadTelemetry = { progress: 0, lastProgressAt: Date.now(), loadedBytes: 0, totalBytes: 0, asset: null };
  _engineReadyPromise = new Promise(resolve => {
    _engineReadyResolve = resolve;
  });

  _setPlayBtnLoading(true);

  const _setStatus = (msg) => {
    const bufferText = document.getElementById('reader-buffer-text');
    if (bufferText) bufferText.innerText = msg;
    const modalText = document.getElementById('caching-progress-text');
    if (modalText) modalText.innerText = msg;
  };

  const _setProgressFill = (pct) => {
    const fill = document.getElementById('caching-progress-fill');
    if (fill) fill.style.width = pct + '%';
  };
  _setProgressFill(1);
  // Ensure GPU detection has finished before reporting hardware details.
  await _gpuDetectionPromise;
  const backendPlan = await _preparePocketBackendPlan();
  const vendor = _gpuVendor || 'unknown';
  // A second complete inference worker is allowed only for positively
  // high-memory desktop cache jobs. The shared policy keeps every mobile,
  // saver, low-battery, WebGPU, and non-isolated session on one worker.
  let nWorkers = await _recommendedPocketCacheWorkers(backendPlan);
  _pocketBackendRuntime.cacheWorkerCount = nWorkers;

  let engineLabel = 'Pocket TTS';
  _setStatus(`Loading ${engineLabel} (${backendPlan.selectedBackend === 'webgpu' ? 'WebGPU FP16' : 'threaded WASM'})...`);

  let engineLoadTimerId = null;
  try {
    let workersReady = 0;
    let workerFailed = 0;

    const spawnWorker = (i) => {
      return new Promise((resolveSpawn) => {
        // A fixed absolute, versioned URL is essential for installed PWAs: a
        // timestamp cache-buster misses the app-shell cache and a relative URL
        // can resolve under an Anvil shell subpath.
        const workerScript = '/_/theme/pocket_worker.js?v=pocket-worker-v41';
        const worker = new Worker(workerScript, { type: 'module' });
        const workerObj = { id: i, worker: worker, activeTasks: 0, ready: false };
        ttsWorkers.push(workerObj);

        let resolved = false;
        const done = (success) => {
          if (!resolved) {
            resolved = true;
            resolveSpawn(success);
          }
        };

        let startupTimerId = setTimeout(() => {
          if (workerObj.ready || resolved) return;
          const message = 'Pocket TTS worker did not start within 45 seconds';
          workerFailed++;
          console.error(`${engineLabel} Worker ${i}: ${message}`);
          if (window.Diagnostics) window.Diagnostics.log('ERROR', message, { worker: i, workerScript });
          worker.terminate();
          done(false);
          if ((workersReady + workerFailed) === nWorkers) {
            _setNeuralState(workersReady > 0 ? 'ready' : 'failed');
            if (_engineReadyResolve) { _engineReadyResolve(); _engineReadyResolve = null; }
          }
        }, 45000);

        worker.onmessage = (e) => {
          clearTimeout(startupTimerId);
          const data = e.data;

          if (data.type === 'progress' && i === 0) {
            const info = data.info;
            if (info?.status === 'progress' || data.progress !== undefined) {
              let pct = info?.progress !== undefined ? info.progress : (data.progress !== undefined ? data.progress : 0);
              if (!pct && info?.total) pct = (info.loaded / info.total) * 100;
              const loadedBytes = Number(info?.loadedBytes || info?.loaded || 0);
              const totalBytes = Number(info?.totalBytes || info?.total || 0);
              window._pocketLoadTelemetry = {
                progress: pct,
                lastProgressAt: Date.now(),
                loadedBytes,
                totalBytes,
                asset: info?.asset || null,
              };
              const byteText = loadedBytes && totalBytes
                ? ` (${(loadedBytes / 1048576).toFixed(1)} / ${(totalBytes / 1048576).toFixed(1)} MiB)`
                : '';
              _setStatus(`Downloading model weights... ${Math.round(pct)}%${byteText}`);
              _setProgressFill(pct);
            } else if (info?.status === 'ready' || info?.status === 'done' || data.status === 'ready') {
              _setStatus('Model loaded!');
              _setProgressFill(100);
            }
          } else if (data.type === 'status' && i === 0 && data.state === 'loading') {
            window._pocketLoadTelemetry.lastProgressAt = Date.now();
            _setStatus(data.status || 'Preparing Pocket TTS...');
          } else if (data.type === 'diagnostic') {
            // INFO-level worker telemetry (per-paragraph pipeline stats) floods
            // the console on long cache jobs and adds nothing the diagnostics
            // buffer below doesn't already capture. Surface only WARN/ERROR to
            // the raw console; keep every level in Diagnostics for observability.
            if (data.level === 'WARN' || data.level === 'ERROR') {
              console.log(`[${engineLabel} Worker ${i} ${data.level}]`, data.message);
            }
            if (window.Diagnostics) window.Diagnostics.log(data.level, data.message);
            if (data.level === 'WARN' && i === 0) _setStatus('Hardware issue detected,auto-falling back...');
          } else if (data.type === 'backend_selected' || data.type === 'backend_status') {
            const telemetry = data.telemetry || {};
            Object.assign(_pocketBackendRuntime, telemetry, {
              selectedBackend: telemetry.selectedBackend || _pocketBackendRuntime.selectedBackend,
              precision: telemetry.precision || _pocketBackendRuntime.precision,
              modelRevision: telemetry.modelRevision || _pocketBackendRuntime.modelRevision,
              threadCount: Number(telemetry.threads || _pocketBackendRuntime.threadCount || 1),
            });
            if (telemetry.calibrationVersion) _pocketBackendRuntime.calibration = telemetry;
            window.updatePocketBackendControl?.();
            window.refreshPerfPanel?.();
          } else if (data.type === 'calibration_progress') {
            _setStatus(data.text || `Optimizing narration: ${data.backend || data.stage || ''} ${data.run || ''}/${data.total || ''}`.trim());
            window.dispatchEvent(new CustomEvent('pocket-backend-progress', { detail: data }));
          } else if (data.type === 'calibration_result') {
            const result = data.result || {};
            _pocketCalibration = result;
            _pocketBackendRuntime.calibration = result;
            _pocketBackendRuntime.selectedBackend = result.selectedBackend || 'wasm';
            _pocketBackendRuntime.precision = _pocketBackendRuntime.selectedBackend === 'webgpu' ? 'fp16' : 'int8';
            _pocketBackendRuntime.modelRevision = _pocketBackendRuntime.selectedBackend === 'webgpu' ? POCKET_WEBGPU_MODEL_REVISION : POCKET_WASM_MODEL_REVISION;
            _pocketBackendRuntime.gpuResidentStateBytes = _pocketBackendRuntime.selectedBackend === 'webgpu' ? POCKET_GPU_RESIDENT_STATE_BYTES : 0;
            _pocketBackendRuntime.rejectionReason = result.rejectionReason || '';
            _pocketBackendRuntime.graphCapture = _pocketBackendRuntime.selectedBackend === 'webgpu' && result.graphCapture === true;
            _pocketBackendRuntime.mimiProvider = _pocketBackendRuntime.selectedBackend === 'webgpu'
              ? (result.mimiProvider || 'wasm-threaded')
              : 'wasm-threaded';
            _pocketBackendRuntime.gpuSyncGroupBlocks = _pocketBackendRuntime.selectedBackend === 'webgpu'
              ? Number(result.gpuSyncGroupBlocks || 4)
              : 1;
            writePocketCalibration(localStorage, _pocketBackendContext, result);
            window.updatePocketBackendControl?.();
            window.refreshPerfPanel?.();
          } else if (data.type === 'gpu_lost' || data.type === 'backend_fallback') {
            const sustainedOnly = data.sustained === true;
            _pocketGpuFailureCount = Math.max(_pocketGpuFailureCount + 1, Number(data.failures || 0));
            Object.assign(_pocketBackendRuntime, {
              selectedBackend: 'wasm', precision: 'int8', modelRevision: POCKET_WASM_MODEL_REVISION,
              gpuResidentStateBytes: 0, rejectionReason: data.reason || 'WebGPU failed; switched to WASM.',
              graphCapture: false, mimiProvider: 'wasm-threaded', gpuSyncGroupBlocks: 1,
              demotedFromWebGpu: true,
            });
            const demoteReason = data.reason || 'WebGPU failed; switched to WASM.';
            // Persist demotion for a genuine hard failure (init, OOM, gpu_lost,
            // invalid audio) so the next cold start does not re-download the FP16
            // bundle and re-fail the same way. A sustained/parity miss is only
            // evidence WebGPU lost to WASM on THIS run's paragraphs (thermal
            // state, a background tab, one unusually long paragraph) — not proof
            // the backend is broken on this device — so keep it session-local and
            // let the next session try WebGPU fresh instead of banning it forever.
            if (!sustainedOnly) {
              writeWebGpuDemotion(localStorage, _pocketBackendContext || {
                browserMajor: browserMajorVersion(),
                isolated: window.crossOriginIsolated === true,
                platform: detectMobilePlatform(navigator.userAgent || ''),
                userAgent: navigator.userAgent || '',
              }, demoteReason);
            }
            if (_pocketCalibration) {
              _pocketCalibration = {
                ..._pocketCalibration,
                selectedBackend: 'wasm',
                optimistic: false,
                demotedFromWebGpu: true,
                rejectionReason: demoteReason,
                graphCapture: false,
                mimiProvider: 'wasm-threaded',
                gpuSyncGroupBlocks: 1,
              };
              _pocketBackendRuntime.calibration = _pocketCalibration;
              if (!sustainedOnly) writePocketCalibration(localStorage, _pocketBackendContext, _pocketCalibration);
            }
            // Clear measured calibration payloads after repeated hard failures, but
            // keep the sticky demotion flag so optimistic WebGPU does not return.
            if (!sustainedOnly && _pocketGpuFailureCount >= 3) {
              clearPocketCalibrations(localStorage);
              _pocketCalibration = {
                calibrationVersion: POCKET_CALIBRATION_VERSION,
                selectedBackend: 'wasm',
                demotedFromWebGpu: true,
                rejectionReason: demoteReason,
                threadCount: _pocketBackendRuntime.threadCount || 1,
              };
              writePocketCalibration(localStorage, _pocketBackendContext, _pocketCalibration);
            }
            window.Diagnostics?.log('WARN', 'Pocket WebGPU fell back to WASM', { reason: data.reason, failures: _pocketGpuFailureCount, sustained: sustainedOnly });
            _setStatus(sustainedOnly
              ? 'WebGPU fell behind WASM; continuing with threaded WASM...'
              : 'Switching to threaded WASM...');
          } else if (data.type === 'wasm_rtf_sample') {
            const measured = Number(data.realTimeFactor);
            if (Number.isFinite(measured) && measured > 0 && Number(data.audioDurationSec || 0) >= 2) {
              _pocketBackendRuntime.wasmReferenceRtf = measured;
              if (_pocketCalibration) {
                _pocketCalibration = { ..._pocketCalibration, measuredWasmRtf: measured };
                _pocketBackendRuntime.calibration = _pocketCalibration;
                writePocketCalibration(localStorage, _pocketBackendContext, _pocketCalibration);
              }
              window.Diagnostics?.log('INFO', 'Measured WASM RTF for parity demotion', { measuredWasmRtf: measured });
            }
          } else if (data.type === 'generation_progress') {
            window._pocketGenerationProgress = {
              frames: Number(data.frames) || 0,
              elapsedMs: Number(data.elapsedMs) || 0,
              backend: data.backend || 'wasm',
              at: Date.now(),
            };
          } else if (data.type === 'audio_segment') {
            ttsQueue[data.id]?.onSegment?.(data);
          } else if (data.type === 'voice_evicted') {
            _encodedPocketVoices.delete(String(data.voiceName || ''));
          } else if (data.type === 'init_done' || data.type === 'ready' || data.type === 'loaded' || data.type === 'bundle_loaded') {
            if (!workerObj.ready) {
              workerObj.ready = true;
              workersReady++;
              done(true);
              if ((workersReady + workerFailed) === nWorkers) {
                if (workersReady > 0) {
                  _setNeuralState('ready');
                  if (_engineReadyResolve) {
                    _engineReadyResolve();
                    _engineReadyResolve = null;
                  }
                  _setStatus('Neural engine ready - synthesizing audio...');
                  if (typeof window.triggerVirtue === 'function') {
                    window.triggerVirtue('virtue_holding_bubble_happy_no_paws');
                    window.virtueSpeak(`${engineLabel} loaded! Ready for high-quality narration.`, 4000);
                  }
                } else {
                  _setNeuralState('failed');
                  if (_engineReadyResolve) {
                    _engineReadyResolve();
                    _engineReadyResolve = null;
                  }
                }
              }
            }
          } else if (data.type === 'init_error' || data.type === 'error') {
            if (!workerObj.ready && !resolved) {
              workerFailed++;
              console.error(`${engineLabel} Worker ${i} init failed:`, data.error);
              done(false);
              if ((workersReady + workerFailed) === nWorkers) {
                if (workersReady > 0) {
                  _setNeuralState('ready');
                  if (_engineReadyResolve) {
                    _engineReadyResolve();
                    _engineReadyResolve = null;
                  }
                  _setStatus('Neural engine ready - synthesizing audio...');
                  if (typeof window.triggerVirtue === 'function') {
                    window.triggerVirtue('virtue_holding_bubble_happy_no_paws');
                    window.virtueSpeak(`${engineLabel} loaded! Ready for high-quality narration.`, 4000);
                  }
                } else {
                  _setNeuralState('failed');
                  if (_engineReadyResolve) {
                    _engineReadyResolve();
                    _engineReadyResolve = null;
                  }
                }
              }
            }
          } else if (data.type === 'generate_done' || data.type === 'complete') {
            workerObj.activeTasks = Math.max(0, workerObj.activeTasks - 1);
            if (ttsQueue[data.id]) {
              ttsQueue[data.id].resolve(data);
              delete ttsQueue[data.id];
            }
          } else if (data.type === 'generate_error') {
            workerObj.activeTasks = Math.max(0, workerObj.activeTasks - 1);
            if (ttsQueue[data.id]) {
              ttsQueue[data.id].reject(new Error(data.error));
              delete ttsQueue[data.id];
            }
          }
        };

        worker.onerror = (err) => {
          clearTimeout(startupTimerId);
          if (!workerObj.ready && !resolved) {
            workerFailed++;
            console.error(`${engineLabel} Worker ${i} crashed (onerror):`, err.message || err);
            if (window.Diagnostics) window.Diagnostics.log('ERROR', `Worker ${i} crashed`, { message: err.message });
            done(false);
            if ((workersReady + workerFailed) === nWorkers) {
              if (workersReady > 0) {
                _setNeuralState('ready');
                _setStatus('Neural engine ready - synthesizing audio...');
              } else {
                _setNeuralState('failed');
              }
              if (_engineReadyResolve) { _engineReadyResolve(); _engineReadyResolve = null; }
            }
          } else if (workerObj.ready) {
            // Post-ready crash: onerror here used to be a no-op, stranding the
            // in-flight generation on the 600s timeout. Recover instead.
            _recoverFromPocketWorkerCrash(workerObj, err?.message || 'worker crashed');
          }
        };

        worker.postMessage({
          type: 'init',
          voiceEngine: 'pocket',
          backendPreference: backendPlan.preference,
          selectedBackend: backendPlan.selectedBackend,
          wasmThreadCount: backendPlan.threadCount,
          wasmReferenceRtf: _pocketBackendRuntime.wasmReferenceRtf,
          graphCapture: _pocketBackendRuntime.graphCapture,
          mimiProvider: _pocketBackendRuntime.mimiProvider,
          gpuSyncGroupBlocks: _pocketBackendRuntime.gpuSyncGroupBlocks,
          constrainedMemoryMode: window.isPocketDeviceMemorySafeMode?.() !== false,
        });
      });
    };

    // Fix Memory/Cache Stampede: Wait for all workers to download/init sequentially
    // Concurrent initialization of 8 workers causes massive memory spikes (OOM) and crashes the Web Worker
    // ── Hard timeout on engine load ──────────────────────────────────────
    // Allow slow first-time mobile downloads while still bounding a silent
    // network or worker failure. The timer now covers worker creation too.
    const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    const ENGINE_LOAD_TIMEOUT_MS = (isMobileDevice ? 20 : 12) * 60 * 1000;
    const engineLoadTimeout = new Promise((_, reject) => {
      engineLoadTimerId = setTimeout(
        () => reject(new Error(`Engine load timed out after ${Math.round(ENGINE_LOAD_TIMEOUT_MS / 60000)} minutes`)),
        ENGINE_LOAD_TIMEOUT_MS,
      );
    });
    const initializeWorkers = async () => {
      for (let i = 0; i < nWorkers; i++) {
        await spawnWorker(i);
      }
      await _engineReadyPromise;
    };
    await Promise.race([initializeWorkers(), engineLoadTimeout]);
    clearTimeout(engineLoadTimerId);
    if (neuralState === 'failed') throw new Error('Worker init failed');
  } catch (e) {
    _setNeuralState('failed');
    console.error(`Failed to load ${engineLabel} Web Workers:`, e);
    ttsWorkers.forEach(w => {
      if (w && w.worker) w.worker.terminate();
    });
    ttsWorkers = [];
    if (_engineReadyResolve) {
      _engineReadyResolve();
      _engineReadyResolve = null;
    }
    _fallbackToWebSpeech();
  } finally {
    clearTimeout(engineLoadTimerId);
    _setPlayBtnLoading(false);
    try { localStorage.removeItem(POCKET_TTS_INIT_PENDING_KEY); } catch (_) {}
  }

  _pocketInitializationMs = Math.round(performance.now() - initializationStartedAt);
  return neuralState === 'ready';
}

function _fallbackToWebSpeech() {
  const _setStatus = (msg) => {
    const bufferText = document.getElementById('reader-buffer-text');
    if (bufferText) bufferText.innerText = msg;
    const modalText = document.getElementById('caching-progress-text');
    if (modalText) modalText.innerText = msg;
  };

  _setStatus('Engine failed to load. Check diagnostics for details.');

  if (typeof window.triggerVirtue === 'function') {
    window.triggerVirtue('virtue_annoyed_bubble');
    window.virtueSpeak("Couldn't load the neural engine. Switching to Device voice.", 6000);
  }
  if (typeof window.switchReaderVoiceEngine === 'function') {
    window.switchReaderVoiceEngine('webspeech');
  }
}

// ── Play button + Media Session ───────────────────────────────────────────
// Single place to set the play button state AND update the OS lock-screen card.
function _updatePlayButton(playing) {
  const btn = document.getElementById('play-btn-main');
  if (btn && !btn.dataset.prevHtml) {
    btn.innerHTML = playing ? 'Pause' : 'Play';
  }
  _updateMediaSession(playing);
}

let _mediaSessionActionsBound = false;

function _setMediaPositionState() {
  if (!('mediaSession' in navigator) || !(window.currentAudio instanceof HTMLAudioElement)) return;
  const audio = window.currentAudio;
  const duration = Number(audio.duration);
  const position = Number(audio.currentTime);
  const playbackRate = Number(audio.playbackRate) || 1;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(Math.max(0, position), duration),
      playbackRate,
    });
  } catch (_) {
    // Some mobile implementations expose MediaSession without position state.
  }
}

function _bindMediaElementSession(audio) {
  if (!audio || audio.dataset.prMediaSessionBound === '1') return;
  audio.dataset.prMediaSessionBound = '1';
  ['loadedmetadata', 'durationchange', 'timeupdate', 'ratechange', 'seeked'].forEach((eventName) => {
    audio.addEventListener(eventName, _setMediaPositionState);
  });
}

function _bindMediaSessionActions() {
  if (_mediaSessionActionsBound || !('mediaSession' in navigator)) return;
  _mediaSessionActionsBound = true;
  const bind = (action, handler) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
  };
  bind('play', () => { if (!window.isPlaying && window.currentStory) window.togglePlayState?.(); });
  bind('pause', () => { if (window.isPlaying) window.pausePlayback?.(); });
  bind('stop', () => { if (window.isPlaying) window.pausePlayback?.(); });
  bind('previoustrack', () => window.skipChapter?.(-1));
  bind('nexttrack', () => window.skipChapter?.(1));
  bind('seekbackward', () => window.skipParagraph?.(-1));
  bind('seekforward', () => window.skipParagraph?.(1));
  bind('seekto', (details) => {
    const audio = window.currentAudio;
    if (audio instanceof HTMLAudioElement && Number.isFinite(details?.seekTime)) {
      audio.currentTime = Math.max(0, Math.min(Number(details.seekTime), Number(audio.duration) || 0));
    }
  });
}

function _updateMediaSession(playing) {
  if (!('mediaSession' in navigator) || !window.currentStory) return;
  const story   = window.currentStory;
  const chapIdx = window.currentChapterIndex || 0;
  const chTitle = story.chapters?.[chapIdx]?.title || `Chapter ${chapIdx + 1}`;
  const bufText = document.getElementById('reader-buffer-text')?.textContent || '';
  const cacheHint = (bufText && bufText !== 'Buffer idle.') ? ` · ${bufText}` : '';
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title:   chTitle,
      artist:  story.author || 'Unknown author',
      album:   story.title  || 'Pocket Reader',
      artwork: [
        { src: new URL('/_/theme/reader%20512.png', window.location.origin).href, sizes: '512x512', type: 'image/png' },
        { src: new URL('/_/theme/reader%20192.png', window.location.origin).href, sizes: '192x192', type: 'image/png' },
      ]
    });
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    _bindMediaSessionActions();
    _setMediaPositionState();
  } catch(e) { /* MediaSession not supported */ }
}
window._updateMediaSession = _updateMediaSession;

// ── iOS / Android / Desktop background audio keep-alive ─────────────────────
// Plays a silent looping audio stream during active narration or background caching
// so OS power managers treat the tab process as an active media player, avoiding
// Web Worker suspension and timer clamping when screen is off or locked.
let _bgKeepAlive = null;
function _ensureBgKeepAlive() {
  if (_bgKeepAlive) return _bgKeepAlive;
  // Shortest possible valid WAV (1 sample, silence)
  const silWav = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';
  _bgKeepAlive = new Audio(silWav);
  _bgKeepAlive.loop   = true;
  _bgKeepAlive.volume = 0.001; // near-inaudible but keeps session alive
  if (typeof document !== 'undefined' && document.body) {
    document.body.appendChild(_bgKeepAlive);
  }
  return _bgKeepAlive;
}
export function startBgKeepAlive() {
  const audio = _ensureBgKeepAlive();
  if (audio && audio.paused) {
    audio.play().catch(() => {});
  }
  if (window.isPlaying) _updateMediaSession(true);
}
export function stopBgKeepAlive() {
  const isCachingActive = Boolean(window.BufferManager?.isActive && !window.BufferManager?.paused);
  if (_bgKeepAlive && !_bgKeepAlive.paused && !window.isPlaying && !isCachingActive) {
    try { _bgKeepAlive.pause(); } catch (_) {}
  }
  if (!window.isPlaying) _updateMediaSession(false);
}
window.startBgKeepAlive = startBgKeepAlive;
window.stopBgKeepAlive  = stopBgKeepAlive;

// Resume after app comes back to foreground or transitions to background
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    _updateMediaSession(window.isPlaying);
    // If audio stalled while backgrounded, restart the current paragraph
    if (window.isPlaying && window.currentAudio instanceof HTMLAudioElement &&
        window.currentAudio.paused && !window.currentAudio.ended) {
      window.currentAudio.play().catch(() => {});
    }
    const isCachingActive = Boolean(window.BufferManager?.isActive && !window.BufferManager?.paused);
    if (!window.isPlaying && !isCachingActive) {
      stopBgKeepAlive();
    }
  } else if (document.visibilityState === 'hidden') {
    const isCachingActive = Boolean(window.BufferManager?.isActive && !window.BufferManager?.paused);
    if (window.isPlaying || isCachingActive) {
      startBgKeepAlive();
    }
  }
});

function _setPlayBtnLoading(loading, message = '⏳ Loading...') {
  const playBtn = document.getElementById('play-btn-main');
  if (!playBtn) return;

  if (loading) {
    playBtn.disabled = true;
    playBtn.style.opacity = '0.5';
    playBtn.style.cursor = 'not-allowed';
    const old = playBtn.innerHTML;
    if (!playBtn.dataset.prevHtml) playBtn.dataset.prevHtml = old;
    playBtn.innerHTML = message;
  } else {
    playBtn.disabled = false;
    playBtn.style.opacity = '';
    playBtn.style.cursor = '';
    playBtn.innerHTML = playBtn.dataset.prevHtml || 'Play';
    delete playBtn.dataset.prevHtml;
  }
}

function _parseSafetensors(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  // Safetensors header length is an 8-byte unsigned little-endian integer
  const headerLength = Number(view.getBigUint64(0, true));

  // Extract JSON header bytes
  const jsonBytes = new Uint8Array(arrayBuffer, 8, headerLength);
  const jsonText = new TextDecoder().decode(jsonBytes);
  const header = JSON.parse(jsonText);

  const keys = Object.keys(header).filter(k => k !== '__metadata__');
  if (keys.length === 0) throw new Error("No tensors found in safetensors file");

  const result = {};
  for (const key of keys) {
    const entry = header[key];
    const [start, end] = entry.data_offsets;
    const byteOffset = 8 + headerLength + start;
    const byteLength = end - start;

    let data;
    let dtype;
    if (entry.dtype === 'F32') {
      data = new Float32Array(arrayBuffer.slice(byteOffset, byteOffset + byteLength));
      dtype = 'float32';
    } else if (entry.dtype === 'I64') {
      data = new BigInt64Array(arrayBuffer.slice(byteOffset, byteOffset + byteLength));
      dtype = 'int64';
    } else if (entry.dtype === 'BOOL') {
      data = new Uint8Array(arrayBuffer.slice(byteOffset, byteOffset + byteLength));
      dtype = 'bool';
    } else {
      // default fallback
      data = new Float32Array(arrayBuffer.slice(byteOffset, byteOffset + byteLength));
      dtype = 'float32';
    }

    result[key] = {
      data: data,
      shape: entry.shape,
      dtype: dtype
    };
  }

  return result;
}

let _encodedPocketVoices = new Set();
const _pocketVoiceLoadPromises = new Map();

function _sameBaseFallbackVoiceIds(targetVoice) {
  const baseVoice = _baseVoiceId(targetVoice);
  const emotions = ['neutral', 'calm', 'tired', 'happy', 'sad', 'worried'];
  const fallbacks = [];
  emotions.forEach((emotion) => {
    const asset = typeof window.resolvePocketAssetVoiceId === 'function'
      ? window.resolvePocketAssetVoiceId(baseVoice, emotion)
      : `${baseVoice}_${emotion}`;
    if (asset && asset !== targetVoice && !fallbacks.includes(asset)) fallbacks.push(asset);
  });
  const defaultAsset = typeof window.resolvePocketAssetVoiceId === 'function'
    ? window.resolvePocketAssetVoiceId(POCKET_DEFAULT_VOICE, 'neutral')
    : `${POCKET_DEFAULT_VOICE}_neutral`;
  if (defaultAsset && defaultAsset !== targetVoice && !fallbacks.includes(defaultAsset)) fallbacks.push(defaultAsset);
  if (!fallbacks.includes('rob_neutral')) fallbacks.push('rob_neutral');
  return fallbacks;
}

async function ensurePocketVoiceLoaded(voiceName) {
  const fileExt = 'safetensors';
  let targetVoice = typeof window.resolvePocketAssetVoiceId === 'function'
    ? window.resolvePocketAssetVoiceId(voiceName)
    : String(voiceName || `${POCKET_DEFAULT_VOICE}_neutral`).toLowerCase();
  if (_encodedPocketVoices.has(targetVoice)) return targetVoice;
  if (_pocketVoiceLoadPromises.has(targetVoice)) return _pocketVoiceLoadPromises.get(targetVoice);

  const loadPromise = (async () => {
    let loadedVoice = targetVoice;
    const voiceLabel = typeof window.getPocketVoiceLabel === 'function'
      ? window.getPocketVoiceLabel(targetVoice)
      : targetVoice;
    console.log(`[PocketTTS] Loading custom voice: ${targetVoice}`);

    const proxyBase = window.PR_PROXY_BASE || window.POCKET_READER_CONFIG?.proxyBase || 'https://pocket-reader-proxy.christopher-gotham67.workers.dev';
    const directB2Base = 'https://f005.backblazeb2.com/file/pocket-reader-assets';
    let url = `${proxyBase}/models/voices/${POCKET_VOICE_PACK_PATH}${targetVoice}.${fileExt}?rev=${POCKET_VOICE_PACK_REV}`;
    const directPrimaryUrl = `${directB2Base}/voices/${POCKET_VOICE_PACK_PATH}${targetVoice}.${fileExt}?rev=${POCKET_VOICE_PACK_REV}`;

    let cache = null;
    let buffer = null;
    try {
      cache = await caches.open("pocket-voices");
      const cachedResponse = await cache.match(url) || await cache.match(directPrimaryUrl);
      if (cachedResponse) {
        buffer = await cachedResponse.arrayBuffer();
        console.log(`[PocketTTS] Loaded voice ${targetVoice} from Cache Storage.`);
      }
    } catch (e) {
      console.warn("Unable to open cache for Pocket TTS", e);
    }

    if (!buffer) {
      if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_thinking');
      if (typeof window.virtueSpeak === 'function') window.virtueSpeak(`Preparing neural voice (${voiceLabel})...`, 4000);

      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        buffer = await response.arrayBuffer();
      } catch (fetchErr) {
        console.warn(`[PocketTTS] Failed to fetch voice file ${targetVoice}:`, fetchErr.message || fetchErr);
        const fallbackVoices = _sameBaseFallbackVoiceIds(targetVoice);

        // Candidate order: legacy v1 of the SAME voice+emotion first (identical
        // asset id, just the older pack), then emotion fallbacks in v2, then v1.
        const candidates = [
          { voice: targetVoice, url: directPrimaryUrl },
          { voice: targetVoice, url: `${proxyBase}/models/voices/${targetVoice}.${fileExt}` },
          { voice: targetVoice, url: `${directB2Base}/voices/${targetVoice}.${fileExt}` },
          ...fallbackVoices.flatMap((fv) => [
            { voice: fv, url: `${proxyBase}/models/voices/${POCKET_VOICE_PACK_PATH}${fv}.${fileExt}?rev=${POCKET_VOICE_PACK_REV}` },
            { voice: fv, url: `${directB2Base}/voices/${POCKET_VOICE_PACK_PATH}${fv}.${fileExt}?rev=${POCKET_VOICE_PACK_REV}` },
            { voice: fv, url: `${proxyBase}/models/voices/${fv}.${fileExt}` },
            { voice: fv, url: `${directB2Base}/voices/${fv}.${fileExt}` },
          ]),
        ];

        let lastFallbackError = fetchErr;
        for (const candidate of candidates) {
          try {
            console.log(`[PocketTTS] Attempting fallback voice asset: ${candidate.url}`);
            const fallbackResponse = await fetch(candidate.url);
            if (!fallbackResponse.ok) throw new Error(`HTTP ${fallbackResponse.status}`);
            buffer = await fallbackResponse.arrayBuffer();
            loadedVoice = candidate.voice;
            url = candidate.url;
            console.log(`[PocketTTS] Successfully fell back to: ${candidate.url}`);
            break;
          } catch (fallbackErr) {
            lastFallbackError = fallbackErr;
          }
        }
        if (!buffer) {
          throw new Error(`Pocket TTS load failed completely: ${lastFallbackError.message || lastFallbackError}`);
        }
      }

      if (cache && buffer) {
        try {
          await cache.put(url, new Response(buffer.slice(0)));
          console.log(`[PocketTTS] Saved voice ${loadedVoice} to Cache Storage.`);
        } catch (e) {
          console.warn("Unable to cache Pocket TTS voice", e);
        }
      }
    }

    const voiceState = _parseSafetensors(buffer);
    const registerMsg = { type: 'register_precompiled_voice', voiceName: loadedVoice, voiceState };

    const ready = await _loadPocketEngine();
    if (!ready || ttsWorkers.length === 0) {
      throw new Error("Neural engine not ready");
    }

    // Wait for the workers to confirm loading. Each promise MUST settle: a
    // dropped/renamed ack would otherwise leave the listener attached and this
    // await hanging forever (there is no outer timeout on voice loading, unlike
    // generation), stalling playback. So we bound it with a timeout and always
    // clean up the listener.
    const VOICE_REGISTER_TIMEOUT_MS = 60000;
    const loadPromises = ttsWorkers.map(w => {
      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          if (settled) return;
          settled = true;
          w.worker.removeEventListener('message', msgHandler);
          clearTimeout(timer);
        };
        const msgHandler = (e) => {
          if (e.data && (e.data.type === 'voice_encoded' || e.data.type === 'voice_set') && (!e.data.voiceName || e.data.voiceName === loadedVoice)) {
            cleanup();
            resolve();
          } else if (e.data && (e.data.type === 'error' || e.data.type === 'generate_error')) {
            cleanup();
            reject(new Error(e.data.error || 'Voice registration failed'));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Voice registration timed out for ${loadedVoice}`));
        }, VOICE_REGISTER_TIMEOUT_MS);
        w.worker.addEventListener('message', msgHandler);
        w.worker.postMessage(registerMsg);
      });
    });

    await Promise.all(loadPromises);
    _encodedPocketVoices.add(loadedVoice);
    console.log(`[PocketTTS] Custom voice loaded in workers: ${loadedVoice}`);
    return loadedVoice;
  })();
  _pocketVoiceLoadPromises.set(targetVoice, loadPromise);
  try {
    return await loadPromise;
  } finally {
    _pocketVoiceLoadPromises.delete(targetVoice);
  }
}

// Warm the Cache Storage copies of routed voice assets before a cache job
// needs them, so the first paragraph that routes to a new emotion never blocks
// on a multi-megabyte download mid-job (each emotion state is ~5-6.5MB, which
// on a mobile connection showed up as 10-30s spikes in per-paragraph times).
// Network-only and sequential by design: downloads must not compete with the
// model download or active synthesis for bandwidth. Registration/encoding
// still happens lazily in ensurePocketVoiceLoaded, which matches these URLs.
async function prefetchPocketVoiceAssets(voiceIds = []) {
  const unique = [...new Set((voiceIds || []).map((id) => (
    typeof window.resolvePocketAssetVoiceId === 'function'
      ? window.resolvePocketAssetVoiceId(id)
      : String(id || '').toLowerCase().trim()
  )))].filter(Boolean);
  if (!unique.length) return 0;
  let cache = null;
  try { cache = await caches.open('pocket-voices'); } catch (_) { return 0; }
  const proxyBase = window.PR_PROXY_BASE || window.POCKET_READER_CONFIG?.proxyBase || 'https://pocket-reader-proxy.christopher-gotham67.workers.dev';
  let fetched = 0;
  for (const voiceId of unique) {
    if (_encodedPocketVoices.has(voiceId)) continue;
    const url = `${proxyBase}/models/voices/${POCKET_VOICE_PACK_PATH}${voiceId}.safetensors?rev=${POCKET_VOICE_PACK_REV}`;
    try {
      if (await cache.match(url)) continue;
      const response = await fetch(url);
      if (!response.ok) continue;
      await cache.put(url, response);
      fetched += 1;
    } catch (_) {
      // Leave this voice to the mid-cache fallback chain in ensurePocketVoiceLoaded.
    }
  }
  if (fetched) {
    window.Diagnostics?.log('INFO', 'Pocket voice prefetch complete', { fetched, requested: unique.length });
  }
  return fetched;
}
window.prefetchPocketVoiceAssets = prefetchPocketVoiceAssets;

async function _ensurePocketBackendOptimizedForVoice(voiceName) {
  const plan = await _preparePocketBackendPlan();
  if (plan.preference === 'wasm' || !plan.eligibility.eligible || plan.calibration) return _pocketBackendRuntime;
  if (_pocketBackendOptimizationPromise) return _pocketBackendOptimizationPromise;

  _pocketBackendOptimizationPromise = (async () => {
    const ready = await _loadPocketEngine();
    if (!ready) throw new Error('Pocket TTS must be loaded before backend optimization.');
    const workerObj = ttsWorkers.find((candidate) => candidate.ready);
    if (!workerObj) throw new Error('No Pocket worker is ready for backend optimization.');
    const loadedVoice = await ensurePocketVoiceLoaded(voiceName || `${POCKET_DEFAULT_VOICE}_neutral`);
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Backend optimization timed out.'));
      }, 20 * 60 * 1000);
      const cleanup = () => {
        clearTimeout(timeoutId);
        workerObj.worker.removeEventListener('message', onMessage);
      };
      const onMessage = (event) => {
        const data = event.data || {};
        if (data.type === 'calibration_result') {
          cleanup();
          resolve(data.result || _pocketBackendRuntime);
        } else if (data.type === 'error' && /calibrat|backend|webgpu/i.test(data.error || '')) {
          cleanup();
          reject(new Error(data.error || 'Backend optimization failed.'));
        }
      };
      workerObj.worker.addEventListener('message', onMessage);
      workerObj.worker.postMessage({ type: 'calibrate_backend', voiceName: loadedVoice });
    });
  })().catch((error) => {
    Object.assign(_pocketBackendRuntime, {
      selectedBackend: 'wasm', precision: 'int8', modelRevision: POCKET_WASM_MODEL_REVISION,
      gpuResidentStateBytes: 0, rejectionReason: error?.message || String(error),
      graphCapture: false, mimiProvider: 'wasm-threaded', gpuSyncGroupBlocks: 1,
    });
    window.Diagnostics?.log('WARN', 'Pocket backend optimization retained WASM', { reason: _pocketBackendRuntime.rejectionReason });
    return _pocketBackendRuntime;
  });
  return _pocketBackendOptimizationPromise;
}

window.ensurePocketBackendOptimized = _ensurePocketBackendOptimizedForVoice;

async function _resetPocketEngineForBackend() {
  ttsWorkers.forEach((worker) => worker?.worker?.terminate());
  ttsWorkers = [];
  Object.values(ttsQueue).forEach((entry) => {
    try { entry.reject(new Error('Pocket backend reset')); } catch (_) {}
  });
  ttsQueue = {};
  _encodedPocketVoices = new Set();
  _pocketVoiceLoadPromises.clear();
  _pocketBackendPlanPromise = null;
  _pocketBackendOptimizationPromise = null;
  _setNeuralState('idle');
  loadedVoiceEngine = null;
}
// The buffer_manager.js caching circuit breaker recovers from repeated
// consecutive failures by calling this — it must be reachable from window
// since buffer_manager runs in its own module scope.
window._resetPocketEngineForBackend = _resetPocketEngineForBackend;

// Prepare the bounded two-worker pool immediately before a cache job. If live
// playback previously loaded a one-worker engine, reload from the browser's
// model cache so the cache job can use the measured parallel path. Never reset
// while synthesis is active.
window.preparePocketCacheWorkerPool = async function preparePocketCacheWorkerPool() {
  const recommended = await _recommendedPocketCacheWorkers(_pocketBackendRuntime);
  const readyCount = ttsWorkers.filter((worker) => worker?.ready).length;
  if (recommended > readyCount && neuralState === 'ready' && !(window._pocketActiveSynthesis > 0)) {
    await _resetPocketEngineForBackend();
  }
  if (neuralState !== 'ready') await _loadPocketEngine();
  const available = Math.max(1, ttsWorkers.filter((worker) => worker?.ready).length);
  _pocketBackendRuntime.cacheWorkerCount = Math.min(recommended, available);
  return _pocketBackendRuntime.cacheWorkerCount;
};

// Release model memory after caching. Desktops retain one warm worker; iOS and
// constrained devices terminate the entire worker so the browser can reclaim
// its WASM arena, model weights, transient tensors, and voice states together.
window.trimPocketCacheWorkerPool = function trimPocketCacheWorkerPool() {
  if ((window._pocketActiveSynthesis || 0) > 0) return ttsWorkers.length;
  if (window.isPocketDeviceMemorySafeMode?.() !== false) {
    const retired = ttsWorkers.splice(0);
    retired.forEach((worker) => worker?.worker?.terminate());
    Object.values(ttsQueue).forEach((entry) => {
      try { entry.reject(new Error('Pocket memory-safe cache session released')); } catch (_) {}
    });
    ttsQueue = {};
    _encodedPocketVoices = new Set();
    _pocketVoiceLoadPromises.clear();
    _pocketBackendOptimizationPromise = null;
    _pocketBackendRuntime.cacheWorkerCount = 0;
    _setNeuralState('idle');
    loadedVoiceEngine = null;
    return 0;
  }
  if (ttsWorkers.length <= 1) return ttsWorkers.length;
  const retired = ttsWorkers.splice(1);
  retired.forEach((worker) => worker?.worker?.terminate());
  _pocketBackendRuntime.cacheWorkerCount = 1;
  return ttsWorkers.length;
};

// ── Idle model-memory reclaim ────────────────────────────────────────────────
// A warm TTS worker keeps the ONNX models resident (hundreds of MB of WASM).
// After caching, trimPocketCacheWorkerPool already releases them on memory-safe
// devices, but nothing released them after plain listening. When playback stops
// and no cache job is running, release the worker+models after a few idle
// minutes to reclaim that memory; the next narration reloads the engine (a
// one-time few-second warm-up). Any synthesis cancels the pending release, so an
// active session is never torn down.
const POCKET_IDLE_RELEASE_MS = 180000;
let _pocketIdleReleaseTimer = null;

function _cancelWorkerIdleRelease() {
  if (_pocketIdleReleaseTimer) { clearTimeout(_pocketIdleReleaseTimer); _pocketIdleReleaseTimer = null; }
}

function _releaseIdlePocketWorkers() {
  _pocketIdleReleaseTimer = null;
  // Re-check every idle guard at fire time — state may have changed in the wait.
  if (window.isPlaying) return;
  if (window.BufferManager?.isActive || window.BufferManager?.paused) return;
  if ((window._pocketActiveSynthesis || 0) > 0) return;
  if (!ttsWorkers.length) return;
  const retired = ttsWorkers.splice(0);
  retired.forEach((worker) => { try { worker?.worker?.terminate(); } catch (_) {} });
  Object.values(ttsQueue).forEach((entry) => {
    try { entry.reject(new Error('Pocket engine released after idle')); } catch (_) {}
  });
  ttsQueue = {};
  _encodedPocketVoices = new Set();
  _pocketVoiceLoadPromises.clear();
  _pocketBackendOptimizationPromise = null;
  _pocketBackendRuntime.cacheWorkerCount = 0;
  _setNeuralState('idle');
  loadedVoiceEngine = null;
  window.Diagnostics?.log('INFO', 'Pocket TTS engine released after idle to reclaim model memory');
}

function _scheduleWorkerIdleRelease() {
  _cancelWorkerIdleRelease();
  if (!ttsWorkers.length) return;
  if (window.BufferManager?.isActive || window.BufferManager?.paused) return;
  _pocketIdleReleaseTimer = setTimeout(_releaseIdlePocketWorkers, POCKET_IDLE_RELEASE_MS);
}

window.rerunPocketBackendOptimization = async function rerunPocketBackendOptimization() {
  clearPocketCalibrations(localStorage);
  clearWebGpuDemotion(localStorage, _pocketBackendContext || {
    browserMajor: browserMajorVersion(),
    isolated: window.crossOriginIsolated === true,
    platform: detectMobilePlatform(navigator.userAgent || ''),
    userAgent: navigator.userAgent || '',
  });
  _pocketCalibration = null;
  _pocketGpuFailureCount = 0;
  await _resetPocketEngineForBackend();
  const voice = window.userProfile?.settings?.pocketVoice || POCKET_DEFAULT_VOICE;
  return _ensurePocketBackendOptimizedForVoice(voice);
};

window.applyPocketBackendPreference = async function applyPocketBackendPreference() {
  await _resetPocketEngineForBackend();
  return _preparePocketBackendPlan(true);
};

window.clearPocketGpuAssets = async function clearPocketGpuAssets() {
  clearPocketCalibrations(localStorage);
  _pocketCalibration = null;
  if ('caches' in window) {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => /pocket.*(?:model|webgpu|onnx)/i.test(name)).map((name) => caches.delete(name)));
  }
  await _resetPocketEngineForBackend();
  return true;
};

function _countPromptWords(text) {
  return (String(text || '').match(/[A-Za-z0-9']+/g) || []).length;
}

function _explicitPauseSeconds(text) {
  let total = 0;
  const re = /\[(\d+(?:\.\d+)?)\s*s\]/gi;
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    const sec = Number(match[1]);
    if (Number.isFinite(sec)) total += Math.max(0.05, Math.min(30, sec));
  }
  return total;
}

function _hasRepeatedAudioPattern(samples, sampleRate) {
  const windowSize = Math.max(1024, Math.floor((Number(sampleRate) || 24000) * 0.25));
  if (!samples || samples.length < windowSize * 6) return false;
  let prev = null;
  let prevRms = 0;
  let repeated = 0;
  for (let start = 0; start + windowSize <= samples.length; start += windowSize) {
    let sum = 0;
    for (let i = 0; i < windowSize; i++) {
      const sample = samples[start + i] || 0;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / windowSize);
    if (prev && rms > 0.018 && prevRms > 0.018) {
      let diff = 0;
      for (let i = 0; i < windowSize; i += 16) {
        diff += Math.abs((samples[start + i] || 0) - (prev[i] || 0));
      }
      const normalizedDiff = diff / ((windowSize / 16) * Math.max(rms, prevRms, 0.001));
      repeated = normalizedDiff < 0.08 ? repeated + 1 : 0;
      if (repeated >= 4) return true;
    }
    prev = samples.subarray(start, start + windowSize);
    prevRms = rms;
  }
  return false;
}

// ── Pitch-consistency guard ──────────────────────────────────────────────────
// The flow-LM occasionally renders a chunk noticeably higher/lower pitched than
// the rest of the same voice state ("the narrator suddenly went up an octave").
// None of the energy/duration checks catch that, so we estimate a median F0 per
// rendered chunk (autocorrelation over voiced frames) and compare it against a
// rolling per-asset baseline. Deviation beyond ~4 semitones flags the render,
// which sends it through the identity-preserving retry.
const _pocketPitchBaselines = new Map(); // assetVoice -> recent median F0s

function _estimateMedianPitchHz(samples, sampleRate) {
  // Downsample x2 by pair-averaging: halves autocorrelation cost, keeps <6kHz.
  const sr = sampleRate / 2;
  const n = Math.min(Math.floor(samples.length / 2), Math.floor(sr * 15)); // cap 15s
  if (n < sr * 0.5) return null;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (samples[2 * i] + samples[2 * i + 1]) * 0.5;

  const win = Math.floor(sr * 0.03);        // 30ms analysis window
  const hop = Math.floor(sr * 0.06);        // 60ms hop
  const minLag = Math.floor(sr / 400);      // 400 Hz ceiling
  const maxLag = Math.floor(sr / 60);       // 60 Hz floor
  const pitches = [];

  for (let start = 0; start + win + maxLag < n && pitches.length < 40; start += hop) {
    let energy = 0;
    for (let i = 0; i < win; i++) energy += x[start + i] * x[start + i];
    const rms = Math.sqrt(energy / win);
    if (rms < 0.01) continue; // unvoiced/quiet frame

    let bestLag = 0;
    let bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      let e2 = 0;
      for (let i = 0; i < win; i++) {
        corr += x[start + i] * x[start + i + lag];
        e2 += x[start + i + lag] * x[start + i + lag];
      }
      const norm = Math.sqrt(energy * e2) || 1;
      const score = corr / norm;
      if (score > bestCorr) {
        bestCorr = score;
        bestLag = lag;
      }
    }
    if (bestCorr > 0.5 && bestLag > 0) pitches.push(sr / bestLag);
  }

  if (pitches.length < 5) return null; // not enough voiced evidence
  pitches.sort((a, b) => a - b);
  return pitches[Math.floor(pitches.length / 2)];
}

function _pitchBaselineFor(assetVoice) {
  const history = _pocketPitchBaselines.get(assetVoice);
  if (!history || history.length < 3) return null;
  const sorted = [...history].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function _recordPitchSample(assetVoice, pitchHz) {
  if (!assetVoice || !pitchHz) return;
  if (_pocketPitchBaselines.size > 32) _pocketPitchBaselines.clear();
  const history = _pocketPitchBaselines.get(assetVoice) || [];
  history.push(pitchHz);
  if (history.length > 8) history.shift();
  _pocketPitchBaselines.set(assetVoice, history);
}

function _inspectPocketAudioQuality(result, text, assetVoice = null) {
  const samples = result?.audio;
  const sampleRate = Number(result?.sampleRate) || 24000;
  const reasons = [];
  let fatal = false;
  if (!samples || !samples.length) {
    return { ok: false, fatal: true, retryable: true, reasons: ['empty output'], stats: { durationSec: 0, rms: 0, peak: 0 } };
  }

  let sumSq = 0;
  let peak = 0;
  let clipped = 0;
  let silent = 0;
  let invalid = 0;
  const silenceThreshold = 0.0008;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    if (!Number.isFinite(value)) {
      invalid++;
      continue;
    }
    const abs = Math.abs(value);
    peak = Math.max(peak, abs);
    sumSq += value * value;
    if (abs >= 0.995) clipped++;
    if (abs < silenceThreshold) silent++;
  }

  if (invalid) {
    fatal = true;
    reasons.push('invalid samples');
  }

  const durationSec = samples.length / sampleRate;
  const rms = Math.sqrt(sumSq / Math.max(1, samples.length - invalid));
  const clipRatio = clipped / samples.length;
  const silenceRatio = silent / samples.length;
  const wordCount = _countPromptWords(text);
  const explicitPause = _explicitPauseSeconds(text) + POCKET_PARAGRAPH_PAUSE_SEC;
  const minDuration = Math.max(0.35, (wordCount / 340) * 60 + explicitPause * 0.35);
  const maxDuration = Math.max(3.5, (wordCount / 70) * 60 + explicitPause + 3);

  if (rms < 0.0012) {
    fatal = true;
    reasons.push('very low rms');
  }
  if (durationSec < minDuration) {
    fatal = true;
    reasons.push('duration too short');
  }
  if (durationSec > maxDuration) reasons.push('duration too long');
  if (clipRatio > 0.005) reasons.push('clipping');
  if (durationSec > 1.2 && silenceRatio > 0.82) {
    fatal = true;
    reasons.push('excessive silence');
  }
  if (_hasRepeatedAudioPattern(samples, sampleRate)) {
    fatal = true;
    reasons.push('repeated pattern');
  }

  // Pitch consistency vs the rolling baseline for this exact voice asset.
  // Baselines are per {voice}_{emotion} so legitimate emotional pitch ranges
  // never trip the check — only the same state rendering off-baseline does.
  let pitchHz = null;
  let pitchBaseHz = null;
  if (assetVoice && !fatal && durationSec > 0.8) {
    pitchHz = _estimateMedianPitchHz(samples, sampleRate);
    pitchBaseHz = _pitchBaselineFor(assetVoice);
    if (pitchHz && pitchBaseHz) {
      const deviation = Math.abs(pitchHz - pitchBaseHz) / pitchBaseHz;
      if (deviation > 0.28) {
        fatal = true;
        reasons.push('pitch shift'); // ~4+ semitones off-baseline
      }
    }
    // Feed the baseline only with renders that passed every check, so a rogue
    // high-pitch chunk can never drag the baseline toward itself.
    if (pitchHz && reasons.length === 0) _recordPitchSample(assetVoice, pitchHz);
  }

  return {
    ok: reasons.length === 0,
    fatal,
    retryable: reasons.length > 0,
    reasons,
    stats: {
      durationSec: Number(durationSec.toFixed(2)),
      rms: Number(rms.toFixed(5)),
      peak: Number(peak.toFixed(4)),
      clipRatio: Number(clipRatio.toFixed(5)),
      silenceRatio: Number(silenceRatio.toFixed(3)),
      wordCount,
      minDuration: Number(minDuration.toFixed(2)),
      maxDuration: Number(maxDuration.toFixed(2)),
      pitchHz: pitchHz ? Number(pitchHz.toFixed(1)) : null,
      pitchBaseHz: pitchBaseHz ? Number(pitchBaseHz.toFixed(1)) : null,
    },
  };
}

function _selectReadyPocketWorker() {
  let bestWorker = ttsWorkers.find((worker) => worker.ready);
  if (!bestWorker) throw new Error('No workers ready');
  for (const worker of ttsWorkers) {
    if (worker.ready && worker.activeTasks < bestWorker.activeTasks) bestWorker = worker;
  }
  return bestWorker;
}

async function _runPocketWorkerGeneration(workerObj, text, workerVoice, opts, handlers = {}) {
  const id = ttsMsgId++;
  const pending = new Promise((resolve, reject) => {
    ttsQueue[id] = { resolve, reject, onSegment: handlers.onSegment || null };
  });
  workerObj.activeTasks++;
  workerObj.worker.postMessage({
    type: 'generate',
    id,
    text,
    voice: workerVoice,
    isPriority: !!window._playPriority,
    opts,
  });

  // Foreground zombie-worker detection stays fast (60s) so an active listener
  // is never stuck waiting on a genuinely stuck worker. A backgrounded/locked
  // session gets a much longer allowance (10 min, the pre-60s-fix value):
  // synthesis can legitimately run several times slower once the OS
  // deprioritizes a backgrounded tab/PWA, and the reject path here resets the
  // ENTIRE engine — timing out real, still-progressing work while backgrounded
  // was killing background playback and caching mid-session. The budget is
  // re-read live on every poll (not fixed at call start) so a session that
  // backgrounds mid-generation still gets the patient budget for the rest of
  // the wait, and one that returns to the foreground still fails fast if truly
  // stuck.
  const FOREGROUND_TIMEOUT_MS = 60000;
  const BACKGROUND_TIMEOUT_MS = 600000;
  const POLL_MS = 5000;
  const currentTimeoutMs = () => (typeof document !== 'undefined' && document.hidden)
    ? BACKGROUND_TIMEOUT_MS : FOREGROUND_TIMEOUT_MS;
  let timerObj = null;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        const start = Date.now();
        let lastTick = start;
        const check = () => {
          const now = Date.now();
          const sinceLastTick = now - lastTick;
          lastTick = now;
          // A tick firing much later than its poll interval means the JS event
          // loop itself was suspended (OS/tab freeze), not that the worker is
          // slow — give it a fresh window rather than counting suspended time
          // against the budget.
          if (sinceLastTick > POLL_MS + 10000) {
            console.log('[Timeout] System sleep or background suspension detected. Rescheduling worker timeout.');
            timerObj = setTimeout(check, POLL_MS);
            return;
          }
          const elapsed = now - start;
          const timeoutMs = currentTimeoutMs();
          if (elapsed >= timeoutMs) {
            reject(new Error(`TTS worker timeout after ${Math.round(elapsed / 1000)}s`));
            return;
          }
          timerObj = setTimeout(check, Math.min(POLL_MS, timeoutMs - elapsed));
        };
        timerObj = setTimeout(check, Math.min(POLL_MS, currentTimeoutMs()));
      }),
    ]);
  } finally {
    if (timerObj) clearTimeout(timerObj);
    delete ttsQueue[id];
    if (workerObj) workerObj.activeTasks = Math.max(0, workerObj.activeTasks - 1);
  }
}

let _pocketTtsCalibrationPromise = null;
async function _ensurePocketTtsCalibration() {
  if (_pocketTtsCalibrationRecorded) return;
  if (_pocketTtsCalibrationPromise) return _pocketTtsCalibrationPromise;
  _pocketTtsCalibrationPromise = (async () => {
    try {
      const neutralVoice = typeof window.resolvePocketAssetVoiceId === 'function'
        ? window.resolvePocketAssetVoiceId(POCKET_DEFAULT_VOICE, 'neutral')
        : `${POCKET_DEFAULT_VOICE}_neutral`;
      const loadedVoice = await ensurePocketVoiceLoaded(neutralVoice);
      const worker = _selectReadyPocketWorker();
      // One worker, one short neutral phrase. This measures the real TTS path
      // without combining privacy-sensitive browser hints into a RAM estimate.
      const result = await _runPocketWorkerGeneration(worker, 'Pocket Reader is ready.', loadedVoice, {
        ..._buildPocketProsodyOpts(loadedVoice, { paragraphEmotion: 'neutral' }),
        expressive: false,
        calibration: true,
      });
      recordPocketTtsCalibration(localStorage, {
        initializationSucceeded: true,
        initializationMs: _pocketInitializationMs,
        realTimeFactor: result?.telemetry?.realTimeFactor,
        interrupted: false,
      });
    } catch (error) {
      recordPocketTtsCalibration(localStorage, {
        initializationSucceeded: true,
        initializationMs: _pocketInitializationMs,
        interrupted: false,
      });
      window.Diagnostics?.log('WARN', 'Pocket TTS device calibration skipped', { reason: error?.message || String(error) });
    } finally {
      _pocketTtsCalibrationRecorded = true;
    }
  })();
  return _pocketTtsCalibrationPromise;
}

async function _generatePocketAttempt(workerObj, text, route, retryLevel = 0, handlers = {}) {
  let workerVoice = route.voiceId;
  try {
    workerVoice = await ensurePocketVoiceLoaded(route.voiceId);
    await _ensurePocketBackendOptimizedForVoice(workerVoice);
    const opts = _buildPocketProsodyOpts(workerVoice, {
      paragraphEmotion: route.emotion,
      retryLevel,
    });
    if (handlers.onSegment) opts.streamSegments = true;
    // Select after all asynchronous voice/backend preparation. If two cache
    // loops arrive together, the first dispatch increments activeTasks before
    // the second selects, so work is actually distributed across the pool.
    const dispatchWorker = workerObj || _selectReadyPocketWorker();
    const result = await _runPocketWorkerGeneration(dispatchWorker, text, workerVoice, opts, handlers);
    const qualityStartedAt = performance.now();
    const quality = _inspectPocketAudioQuality(result, text, workerVoice);
    if (result?.telemetry) result.telemetry.qualityCheckMs = Math.round(performance.now() - qualityStartedAt);
    return { result, quality, workerVoice, opts, route, error: null };
  } catch (err) {
    return {
      result: null,
      quality: { ok: false, fatal: true, retryable: true, reasons: [err?.message || String(err)], stats: { durationSec: 0, rms: 0, peak: 0 } },
      workerVoice,
      opts: null,
      route,
      error: err,
    };
  }
}

function _logPocketQuality(level, message, attempt, extra = {}) {
  if (!window.Diagnostics) return;
  const quality = attempt?.quality || {};
  window.Diagnostics.log(level, message, {
    voice: attempt?.route?.voiceId,
    baseVoice: attempt?.route?.baseVoice,
    emotion: attempt?.route?.emotion,
    retryOf: attempt?.route?.retryOf || null,
    temperature: attempt?.opts?.temperature,
    artifactGuardVersion: POCKET_ARTIFACT_GUARD_VERSION,
    pauseProfileVersion: POCKET_PAUSE_PROFILE_VERSION,
    paragraphPauseSec: POCKET_PARAGRAPH_PAUSE_SEC,
    qualityReason: (quality.reasons || []).join(', '),
    ...(quality.stats || {}),
    ...extra,
  });
}

// Live generator with one quality-guard retry around Pocket output.
window.generateChunk = async function(text, voice) {
  if (!text || text.trim() === '') return null;
  _cancelWorkerIdleRelease();
  const engine = _resolveActiveEngine();
  if (engine !== 'pocket') return null;

  const ready = await _loadPocketEngine();
  if (!ready || ttsWorkers.length === 0) {
    console.warn('Neural engine unavailable - skipping generation.');
    return null;
  }
  await _ensurePocketTtsCalibration();

  // Refresh worker session periodically (~30 continuous paragraphs / ~15 mins of speech)
  // to clear ONNX Runtime internal state accumulation and prevent voice hallucinations.
  window._pocketParagraphCount = (window._pocketParagraphCount || 0) + 1;
  if (window._pocketParagraphCount >= 30) {
    window._pocketParagraphCount = 0;
    window.Diagnostics?.log('INFO', 'Recycling Pocket TTS worker session to maintain pristine audio quality');
    try {
      await _resetPocketEngineForBackend();
      await _loadPocketEngine();
    } catch (_) {}
  }

  window._pocketActiveSynthesis = (window._pocketActiveSynthesis || 0) + 1;
  window.setExperienceSuppressed?.(true, 'pocket-synthesis');
  window.setCinematicSynthesisSuppressed?.(true);
  try {
    const _t0 = performance.now();
    const route = _resolvePocketRoute(engine, voice, text);
    const first = await _generatePocketAttempt(null, text, route, 0);
    let accepted = first;
    let retryUsed = false;

    // Background caching skips the full re-render retry: a second pass doubles
    // wall time on phones. Empty/fatal still fails the paragraph so the loop
    // can resurface the error instead of storing silence.
    const allowQualityRetry = !_isPocketThroughputCache() && shouldRetryPocketQuality(first.quality);
    if (allowQualityRetry) {
      // Re-render once with clean worker state at lower temperature.
      _logPocketQuality('WARN', 'Pocket synth quality guard retrying with clean worker session', first, { retryUsed: false });
      window._pocketParagraphCount = 0;
      try {
        await _resetPocketEngineForBackend();
        await _loadPocketEngine();
      } catch (_) {}
      const retry = await _generatePocketAttempt(null, text, route, 1);
      retryUsed = true;
      if (!retry.quality.fatal) {
        accepted = retry;
      } else {
        _logPocketQuality('ERROR', 'Pocket synth quality guard rejected both attempts', retry, {
          retryUsed: true,
          firstReason: first.quality.reasons.join(', '),
        });
        return null;
      }
    } else if (first.quality.fatal && _isPocketThroughputCache()) {
      _logPocketQuality('ERROR', 'Pocket synth quality guard rejected cache paragraph (no retry in throughput mode)', first, { retryUsed: false });
      return null;
    } else if (!first.quality.ok) {
      _logPocketQuality('WARN', 'Pocket synth accepted with a soft quality warning', first, { retryUsed: false });
    }

    const _ms = Math.round(performance.now() - _t0);
    const synthTelemetry = {
      ms: _ms,
      chars: (text || '').length,
      voice: accepted.route.voiceId,
      emotion: accepted.route.emotion,
      temperature: accepted.opts?.temperature,
      retryUsed,
      throughputMode: _isPocketThroughputCache(),
      cacheVersion: POCKET_NARRATION_CACHE_VERSION,
      artifactGuardVersion: POCKET_ARTIFACT_GUARD_VERSION,
      pauseProfileVersion: POCKET_PAUSE_PROFILE_VERSION,
      paragraphPauseSec: POCKET_PARAGRAPH_PAUSE_SEC,
      performancePolicyVersion: POCKET_PERFORMANCE_POLICY_VERSION,
      qualityReason: (accepted.quality.reasons || []).join(', '),
      ...(accepted.result?.telemetry || {}),
      ...(accepted.quality.stats || {}),
    };
    window._lastPocketSynthTelemetry = synthTelemetry;
    if (window.Diagnostics) {
      window.Diagnostics.log(_ms > 8000 ? 'WARN' : 'INFO',
        `Pocket synth ${_ms}ms${retryUsed ? ' (quality retry)' : ''}${synthTelemetry.throughputMode ? ' (cache throughput)' : ''}`,
        synthTelemetry);
    }

    if (!accepted.result || !accepted.result.audio || accepted.result.audio.length === 0) return null;
    const wavStartedAt = performance.now();
    const wav = _encodeWAV(accepted.result.audio, accepted.result.sampleRate || 24000);
    window.Diagnostics?.log('INFO', 'Pocket WAV encoded', { wavEncodingMs: Math.round(performance.now() - wavStartedAt), bytes: wav.size });
    return wav;
  } catch (e) {
    console.error('Pocket worker inference failed:', e);
    try { await _resetPocketEngineForBackend(); } catch (_) {}
    return null;
  } finally {
    window._pocketActiveSynthesis = Math.max(0, (window._pocketActiveSynthesis || 1) - 1);
    if (!window._pocketActiveSynthesis) {
      window.setExperienceSuppressed?.(false);
      window.setCinematicSynthesisSuppressed?.(false);
    }
  }
};

window.generateChunkStream = async function(text, voice, onSegment) {
  if (!text || text.trim() === '' || typeof onSegment !== 'function') return null;
  _cancelWorkerIdleRelease();
  if (_resolveActiveEngine() !== 'pocket') return null;
  const ready = await _loadPocketEngine();
  if (!ready || ttsWorkers.length === 0) return null;
  await _ensurePocketTtsCalibration();

  window._pocketActiveSynthesis = (window._pocketActiveSynthesis || 0) + 1;
  window.setExperienceSuppressed?.(true, 'pocket-synthesis');
  window.setCinematicSynthesisSuppressed?.(true);
  try {
    const startedAt = performance.now();
    const route = _resolvePocketRoute('pocket', voice, text);
    const attempt = await _generatePocketAttempt(null, text, route, 0, { onSegment });
    if (attempt.quality.fatal || !attempt.result?.audio?.length) {
      _logPocketQuality('ERROR', 'Pocket streamed synthesis failed quality validation', attempt, { streamed: true });
      return null;
    }
    window.Diagnostics?.log('INFO', 'Pocket streamed synthesis complete', {
      ms: Math.round(performance.now() - startedAt),
      voice: route.voiceId,
      emotion: route.emotion,
      streamed: true,
      ...(attempt.result.telemetry || {}),
      ...(attempt.quality.stats || {}),
    });
    const wavStartedAt = performance.now();
    const wav = _encodeWAV(attempt.result.audio, attempt.result.sampleRate || 24000);
    window.Diagnostics?.log('INFO', 'Pocket streamed WAV encoded', { wavEncodingMs: Math.round(performance.now() - wavStartedAt), bytes: wav.size });
    return wav;
  } catch (error) {
    console.error('Pocket streamed inference failed:', error);
    return null;
  } finally {
    window._pocketActiveSynthesis = Math.max(0, (window._pocketActiveSynthesis || 1) - 1);
    if (!window._pocketActiveSynthesis) {
      window.setExperienceSuppressed?.(false);
      window.setCinematicSynthesisSuppressed?.(false);
    }
  }
};

// First-play cold-start cue (Issue 15). On mobile the neural engine warmup is
// deliberately skipped at boot (battery/data), so the very first Play tap must
// load the engine before any audio — a multi-second wait that's easy to mistake
// for a frozen app. The play button already flips to a loading label and the
// reader buffer line shows model-download progress; this adds a one-time,
// accurate heads-up at the moment of the tap so the delay reads as expected.
function _signalColdStartOnce() {
  try {
    const engine = _resolveActiveEngine();
    const ready = typeof window._neuralState === 'function' && window._neuralState() === 'ready';
    if (engine !== 'pocket' || ready) return;
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')
      || (navigator.maxTouchPoints || 0) > 0;
    if (!isMobile) return;
    if (localStorage.getItem('pr_coldstart_notice_shown') === 'true') return;
    localStorage.setItem('pr_coldstart_notice_shown', 'true');
    if (typeof window.virtueSpeak === 'function') {
      window.virtueSpeak("Warming up the narrator — the first play takes a few seconds while I load the voice. It's quick after that!", 6000);
    }
  } catch (_) {}
}

export function togglePlayState() {
  if (!window.currentStory || !window.currentStory.chapters) {
    alert('No story loaded.');
    return;
  }

  // Away Mode guard: block playback while Permanent mode is actively caching
  if (!window.isPlaying && window.BufferManager?.isActive &&
      window.BufferManager.mode === 'Permanent' && !window.BufferManager.paused) {
    if (typeof window.triggerVirtue === 'function') {
      window.triggerVirtue('virtue_annoyed_bubble');
      window.virtueSpeak('Playback is locked while Away Mode is actively caching. Pause or cancel it in Settings first!', 6000);
    }
    return;
  }

  // Enforce 30-paragraph caching requirement if the current story is actively caching
  if (!window.isPlaying && window.BufferManager && window.BufferManager.isActive) {
    const activeJob = window.BufferManager.queue && window.BufferManager.queue[0];
    if (activeJob && activeJob.storyTitle === window.currentStory.title) {
      const cachedCount = window.BufferManager.cachedCount || 0;
      // Use the job's real paragraph total (BufferManager.totalToCache) so that
      // stories shorter than 30 paragraphs unlock once fully cached instead of
      // being blocked forever. Queue items carry no per-item total.
      const total = window.BufferManager.totalToCache || 999;
      if (cachedCount < 30 && cachedCount < total) {
        if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_explaining');
        if (typeof window.virtueSpeak === 'function') {
          window.virtueSpeak("Still securing the text! Please let me cache at least 30 paragraphs before we begin reading.", 4500, true);
        } else {
          alert("Still caching! Please wait for at least 30 paragraphs before playing.");
        }
        return;
      }
    }
  }

  const playBtn = document.getElementById('play-btn-main');
  window.isPlaying = !window.isPlaying;

  if (window.isPlaying) {
    _updatePlayButton(true);
    if (typeof window._setControlsLocked === 'function') window._setControlsLocked(true);
    startBgKeepAlive();
    _signalColdStartOnce();
    playCurrentParagraph();
  } else {
    _updatePlayButton(false);
    if (typeof window._setControlsLocked === 'function') window._setControlsLocked(false);
    pausePlayback();
  }
}
window.togglePlayState = togglePlayState;

export async function playCurrentParagraph() {
  if (!window.isPlaying) return;

  const story = window.currentStory;
  if (!story || !story.chapters) return;
  if (typeof window._updateMediaSessionMetadata === 'function') window._updateMediaSessionMetadata();

  const chap = story.chapters[window.currentChapterIndex];
  if (!chap || !chap.paragraphs) {
    window.isPlaying = false;
    return;
  }

  let text = chap.paragraphs[window.currentParagraphIndex];

  while ((!text || text.trim() === '' || _isMetaParagraph(text)) && window.isPlaying) {
    const canAdvance = _advanceIndices();
    if (!canAdvance) {
      _finishStory();
      return;
    }
    text = story.chapters[window.currentChapterIndex].paragraphs[window.currentParagraphIndex];
  }

  if (!window.isPlaying) return;
  if (typeof window.updateReaderUIText === 'function') window.updateReaderUIText();

  const engine = _resolveActiveEngine();
  const defaultVoice = engine === 'pocket' ? POCKET_DEFAULT_VOICE : '';
  const voice = document.getElementById('voice-selector')?.value || defaultVoice;

  try {
    if (engine === 'pocket') {
      await _playGeneratedAudio(text, story.title, window.currentChapterIndex, window.currentParagraphIndex, voice);
    } else {
      await _playWebSpeech(text);
    }
  } catch (e) {
    console.error('Playback error:', e);
    pausePlayback();
  }
}
window.playCurrentParagraph = playCurrentParagraph;

let _premiumAudio = null;
let _audioCtx = null;
let _audioSource = null;
let _splitter = null;
let _merger = null;
let _monoGainL = null;
let _monoGainR = null;
let _pocketWorkletModulePromise = null;
let _activePocketStream = null;

async function _createPocketPcmStream(onEnded) {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (!_audioCtx.audioWorklet) throw new Error('AudioWorklet is unavailable.');
  if (!_pocketWorkletModulePromise) {
    _pocketWorkletModulePromise = _audioCtx.audioWorklet.addModule('/_/theme/pocket_pcm_worklet.js?v=pcm-v1');
  }
  await _pocketWorkletModulePromise;
  if (_audioCtx.state === 'suspended') await _audioCtx.resume();

  const node = new AudioWorkletNode(_audioCtx, 'pocket-pcm-stream', { outputChannelCount: [2] });
  const stream = {
    node,
    segments: 0,
    bufferedSamples: 0,
    sourceSampleRate: 24000,
    connected: false,
    stopped: false,
    start() {
      if (this.stopped || this.connected) return false;
      node.connect(_audioCtx.destination);
      this.connected = true;
      return true;
    },
    enqueue(data) {
      if (this.stopped || !data?.audio?.length) return false;
      if (this.segments === 0) {
        this.sourceSampleRate = data.sampleRate || 24000;
        node.port.postMessage({
          type: 'configure',
          sampleRate: this.sourceSampleRate,
          playbackRate: parseFloat(document.getElementById('speed-slider')?.value || '1'),
        });
      }
      this.segments += 1;
      this.bufferedSamples += data.audio.length;
      node.port.postMessage({ type: 'segment', audio: data.audio }, [data.audio.buffer]);
      return this.bufferedSamples / this.sourceSampleRate >= 1.0 ? this.start() : false;
    },
    end() {
      if (this.stopped) return;
      this.start();
      node.port.postMessage({ type: 'end' });
    },
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      node.port.postMessage({ type: 'stop' });
      if (this.connected) try { node.disconnect(); } catch (_) {}
    },
  };
  node.port.onmessage = (event) => {
    if (event.data?.type !== 'drained' || stream.stopped) return;
    stream.stopped = true;
    if (stream.connected) try { node.disconnect(); } catch (_) {}
    if (_activePocketStream === stream) _activePocketStream = null;
    onEnded?.();
  };
  _activePocketStream?.stop?.();
  _activePocketStream = stream;
  return stream;
}

function _preferDirectMobileMediaPlayback() {
  // Direct HTMLAudioElement output bypasses AudioContext background suspension
  // across desktop, laptop, mobile, PWA, and locked-screen sessions.
  return true;
}

function _setupAudioRouting(audioElement) {
  if (!audioElement) return;
  if (_audioSource) return; // already set up

  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    _audioSource = _audioCtx.createMediaElementSource(audioElement);

    _splitter = _audioCtx.createChannelSplitter(2);
    _merger = _audioCtx.createChannelMerger(2);

    // Route channel 0 (single narrator voice) to both L and R outputs
    _monoGainL = _audioCtx.createGain();
    _monoGainR = _audioCtx.createGain();

    _audioSource.connect(_splitter);
    _splitter.connect(_monoGainL, 0, 0);
    _splitter.connect(_monoGainR, 0, 0);
    _monoGainL.connect(_merger, 0, 0);
    _monoGainR.connect(_merger, 0, 1);
    _merger.connect(_audioCtx.destination);
  } catch (e) {
    console.warn("Failed to initialize Web Audio routing:", e);
  }
}

// ── Emotion-boundary onset fade ──────────────────────────────────────────────
// When consecutive paragraphs use different voice conditioning (emotion
// switch), the timbre steps at the chunk boundary. A short gain ramp on the
// incoming chunk softens the onset so residual differences the anchored pack
// doesn't remove read as delivery, not a speaker change.
let _lastPlayedVoiceAsset = null;
const EMOTION_FADE_SEC = 0.12;

function _applyEmotionBoundaryFade(voiceAsset) {
  const switched = _lastPlayedVoiceAsset !== null && voiceAsset !== _lastPlayedVoiceAsset;
  _lastPlayedVoiceAsset = voiceAsset;
  if (!_audioCtx || !_monoGainL || !_monoGainR) return;
  try {
    const now = _audioCtx.currentTime;
    for (const gain of [_monoGainL, _monoGainR]) {
      gain.gain.cancelScheduledValues(now);
      if (switched) {
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(1, now + EMOTION_FADE_SEC);
      } else {
        gain.gain.setValueAtTime(1, now);
      }
    }
  } catch (e) { /* cosmetic only — never block playback */ }
}


async function _playGeneratedAudio(text, title, chapIdx, paraIdx, voice) {
  const engine = _resolveActiveEngine();
  const storyRef = window.currentStory?.storyKey || window.getStoryStableKey?.(window.currentStory) || title;
  // Pass the chunk position so the deterministic chapter emotion plan is used;
  // the background cacher (buffer_manager.js) passes the same ctx, so both
  // resolve the identical emotion → identical voice asset → identical cache key.
  const cleanVoice = resolveVoiceWithSentiment(engine, voice, text, { storyTitle: title, chapIdx, paraIdx });
  if (engine === 'pocket') await _ensurePocketBackendOptimizedForVoice(cleanVoice);
  // Try every render-mode cache key: the background cacher stores under the
  // throughput tag while live playback computes the non-throughput tag, and
  // both are valid renders of this paragraph. Exact-key misses here used to
  // re-synthesize audio the cache job had already stored.
  const cacheVoice = cleanVoice + (typeof _prosodyCacheTag === 'function' ? _prosodyCacheTag(engine) : '');

  const _playT0 = performance.now();
  let _cacheHit = true;

  let audioBlob = null;
  for (const tag of _prosodyCacheTagVariants(engine)) {
    audioBlob = await getAudioChunk(storyRef, chapIdx, paraIdx, engine, cleanVoice + tag);
    if (!audioBlob && storyRef !== title) {
      audioBlob = await getAudioChunk(title, chapIdx, paraIdx, engine, cleanVoice + tag);
      if (audioBlob) saveAudioChunk(storyRef, chapIdx, paraIdx, engine, cleanVoice + tag, audioBlob, false).catch(() => {});
    }
    if (audioBlob) break;
  }
  let streamedPlayback = false;

  if (!audioBlob) {
    _cacheHit = false;
    window._playPriority = true;
    window._pocketLiveSynthActive = true;

    // Show that it's generating audio, not frozen
    if (typeof _setPlayBtnLoading === 'function') _setPlayBtnLoading(true, '🧠 Synthesizing...');

    let stream = null;
    try {
      try {
        stream = await _createPocketPcmStream(() => {
          if (window.isPlaying) _handleParagraphEnd();
        });
      } catch (streamError) {
        window.Diagnostics?.log('WARN', 'Pocket streaming unavailable; using full-paragraph playback', { error: streamError?.message || String(streamError) });
      }
      audioBlob = stream
        ? await window.generateChunkStream(text, cleanVoice, (segment) => {
            const playbackStarted = stream.enqueue(segment);
            if (!streamedPlayback && playbackStarted) {
              streamedPlayback = true;
              if (typeof _setPlayBtnLoading === 'function') _setPlayBtnLoading(false);
              window.Diagnostics?.log('INFO', 'Pocket first streamed audio available', { firstSegmentMs: segment.firstSegmentMs });
            }
          })
        : await window.generateChunk(text, cleanVoice);
      if (stream) {
        if (audioBlob && stream.segments > 0) {
          stream.end();
          streamedPlayback = true;
          if (typeof _setPlayBtnLoading === 'function') _setPlayBtnLoading(false);
        } else stream.stop();
      }
    } finally {
      window._playPriority = false;
      window._pocketLiveSynthActive = false;
      if (typeof _setPlayBtnLoading === 'function') _setPlayBtnLoading(false);
    }
    if (window.isPlaying) { _updatePlayButton(true); }

    if (!window.isPlaying) {
      console.log('User paused during generation — skipping play.');
      return;
    }

    if (audioBlob) {
      const writeStartedAt = performance.now();
      saveAudioChunk(storyRef, chapIdx, paraIdx, engine, cacheVoice, audioBlob, false)
        .then(() => window.Diagnostics?.log('INFO', 'Pocket playback cache write', {
          indexedDbWriteMs: Math.round(performance.now() - writeStartedAt),
          bytes: audioBlob.size,
        }))
        .catch(console.error);
    }
    if (streamedPlayback) return;
  }

  if (!audioBlob || !(audioBlob instanceof Blob) || audioBlob.size < 100) {
    console.warn('No audio blob for this paragraph — stopping playback to avoid skip-loop.');
    pausePlayback();
    if (typeof window.virtueSpeak === 'function') {
      window.virtueSpeak('The neural engine couldn\'t produce audio. Try switching to Device voice in settings.', 6000);
    }
    return;
  }

  if (!window.currentAudio || !(window.currentAudio instanceof HTMLAudioElement)) {
    if (!_premiumAudio) {
      _premiumAudio = new Audio();
      // iOS can suspend a Web Audio graph after the screen locks even while
      // the media element remains eligible for OS-controlled playback. Keep
      // phone/tablet narration on the direct HTMLAudioElement path.
      if (!_preferDirectMobileMediaPlayback()) _setupAudioRouting(_premiumAudio);
      _bindMediaElementSession(_premiumAudio);
    }
    window.currentAudio = _premiumAudio;
  } else {
    window.currentAudio.pause();
    if (window.currentAudio.src.startsWith('blob:')) {
      URL.revokeObjectURL(window.currentAudio.src);
    }
  }

  const audioUrl = URL.createObjectURL(audioBlob);
  window.currentAudio.src = audioUrl;
  window.currentAudio.playbackRate = parseFloat(document.getElementById('speed-slider')?.value || '1');
  window.currentAudio.load();

  window.currentAudio.onended = () => {
    if (window.currentAudio && window.currentAudio.error) {
      console.warn('Audio element ended with error:', window.currentAudio.error);
      URL.revokeObjectURL(audioUrl);
      return;
    }
    URL.revokeObjectURL(audioUrl);
    if (window.isPlaying) _handleParagraphEnd();
  };

  window.currentAudio.onerror = (e) => {
    console.error('Audio playback error:', e);
    URL.revokeObjectURL(audioUrl);
    pausePlayback();
    if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_annoyed_bubble');
  };



  try {
    // Wake the routing graph if the browser suspended it (routine on mobile
    // when backgrounded/locked). A suspended context freezes currentTime, which
    // would otherwise leave the emotion-fade gain ramp stuck near zero → silent
    // playback. resume() on an already-running context is a harmless no-op.
    if (_audioCtx && _audioCtx.state === 'suspended') {
      try { await _audioCtx.resume(); } catch (e) {}
    }
    _applyEmotionBoundaryFade(cleanVoice);
    await window.currentAudio.play();
    // Play-start latency telemetry — flags the "stuck play button" class of
    // issues (cache miss forcing an on-the-fly synth) in diagnostic files.
    if (window.Diagnostics) {
      const _ms = Math.round(performance.now() - _playT0);
      window.Diagnostics.log(_ms > 3000 ? 'WARN' : 'INFO',
                             `Play start ${_ms}ms (${_cacheHit ? 'cache hit' : 'synthesized'})`,
                             { ms: _ms, cacheHit: _cacheHit });
    }
  } catch (playError) {
    console.warn('Autoplay blocked:', playError);
    pausePlayback();
    if (typeof window.virtueSpeak === 'function') {
      window.virtueSpeak('Tap Play to begin - your browser needs a user gesture first.', 5000);
    }
  }
}

async function _playWebSpeech(text) {
  if (!('speechSynthesis' in window)) {
    alert('Web Speech API not supported in this browser.');
    pausePlayback();
    return;
  }

  // Resume if already paused
  if (window.speechSynthesis.paused && window.currentAudio instanceof SpeechSynthesisUtterance) {
    window.speechSynthesis.resume();
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = parseFloat(document.getElementById('speed-slider')?.value || '1');
  const voices = window.speechSynthesis.getVoices();
  const preferredName = document.getElementById('voice-selector')?.value || '';
  let picked = voices.find(v => v.name === preferredName) || voices.find(v => v.lang.startsWith('en'));

  if (picked) utterance.voice = picked;

  utterance.onend = () => {
    if (window.isPlaying) _handleParagraphEnd();
  };

  utterance.onerror = (e) => {
    if (e.error !== 'canceled' && window.isPlaying) {
      window.pausePlayback();
      if (typeof window.virtueSpeak === 'function') {
        window.virtueSpeak('Speech synthesis failed. Playback paused.', 5000);
      }
    }
  };

  window.currentAudio = utterance;
  window.speechSynthesis.speak(utterance);
}

export function pausePlayback() {
  window.isPlaying = false;
  _updatePlayButton(false);
  if (typeof window._setControlsLocked === 'function') window._setControlsLocked(false);
  stopBgKeepAlive(); // stop keep-alive when not actively playing
  _activePocketStream?.stop?.();
  _activePocketStream = null;

  if (window.currentAudio instanceof HTMLAudioElement) {
    window.currentAudio.pause();
  } else if ('speechSynthesis' in window && window.currentAudio instanceof SpeechSynthesisUtterance) {
    window.speechSynthesis.pause();
  }
  // Reclaim the resident TTS models if the user stays paused (skipped while a
  // background cache job is running — that path manages its own workers).
  _scheduleWorkerIdleRelease();
}
window.pausePlayback = pausePlayback;

// Drop our reference to the current audio, first revoking the reusable element's
// blob URL if it has one. Manual skip/seek pauses the element and reloads a new
// source, so the normal end-of-paragraph revoke (in onended) never fires for the
// old clip — without this each jump leaks one ObjectURL. Also nulls WebSpeech
// utterances so _playWebSpeech speaks the new text instead of resuming the old.
function _releaseCurrentAudio() {
  _activePocketStream?.stop?.();
  _activePocketStream = null;
  const a = window.currentAudio;
  if (a instanceof HTMLAudioElement && typeof a.src === 'string' && a.src.startsWith('blob:')) {
    try { URL.revokeObjectURL(a.src); } catch (e) {}
  }
  window.currentAudio = null;
}

// recordDailyActivity now lives in library_manager.js (an eagerly-loaded
// module) so daily-streak tracking fires on every app open, not only sessions
// where the user triggers this lazily-loaded narration module. Still called
// from _handleParagraphEnd below — by the time that runs, narration is active
// and library_manager.js (eager) has long since defined the global.

let _lastProgressCloudCheckpoint = 0;
let _paragraphsSinceCloudCheckpoint = 0;

function _checkpointPlaybackProgress(forceCloud = false) {
  const story = window.currentStory;
  // Resolve by stable ref first (storyKey), so two library entries sharing a
  // title can't send this story's progress to the wrong one; fall back to the
  // legacy unique-title match when there's no ref/library helper.
  const storyRef = story?.storyKey || window.getStoryStableKey?.(story) || story?.title;
  const libraryStory = window.findLibraryStoryByRef?.(storyRef)
    || window.userProfile?.library?.find((item) => item.title === story?.title);
  if (!libraryStory) return;
  libraryStory.progressChapter = window.currentChapterIndex;
  libraryStory.progressParagraph = window.currentParagraphIndex;
  libraryStory.lastRead = Date.now();
  window.stampStorySyncField?.(libraryStory, 'progress');
  window.recordStoryHistory?.(libraryStory, { silent: true });
  window.saveLocalData?.({ skipCloud: true });
  _paragraphsSinceCloudCheckpoint += 1;
  const due = forceCloud || _paragraphsSinceCloudCheckpoint >= 10 || Date.now() - _lastProgressCloudCheckpoint >= 60000;
  if (due && window._cloudPushAllowed) {
    _lastProgressCloudCheckpoint = Date.now();
    _paragraphsSinceCloudCheckpoint = 0;
    window.queueCloudSync?.('playback-checkpoint');
  }
}

function _handleParagraphEnd() {
  if (window.currentStory?.chapters) {
    const chap = window.currentStory.chapters[window.currentChapterIndex];
    if (chap?.paragraphs) {
      const text = chap.paragraphs[window.currentParagraphIndex] || '';
      const words = text.split(/\s+/).filter(Boolean).length;

      if (window.userProfile?.stats) {
        if (typeof window.incrementDeviceStat === 'function') window.incrementDeviceStat('totalWords', words);
        else {
          window.userProfile.stats.totalWords = (window.userProfile.stats.totalWords || 0) + words;
          window.userProfile.stats.hoursListened = window.userProfile.stats.totalWords / 9000;
        }
        // Shared daily tracking (streak / distinct days / first day) + the
        // achievement check. Listening counts as activity for the day too.
        if (typeof window.recordDailyActivity === 'function') window.recordDailyActivity();
      }
    }
  }

  const canAdvance = _advanceIndices();
  _checkpointPlaybackProgress(!canAdvance);
  if (canAdvance) {
    playCurrentParagraph();
  } else {
    _finishStory();
  }
}

function _advanceIndices() {
  const story = window.currentStory;
  if (!story) return false;
  const c = window.currentChapterIndex;
  const p = window.currentParagraphIndex;

  if (!story.chapters || !story.chapters[c] || !story.chapters[c].paragraphs) return false;

  if (p + 1 < story.chapters[c].paragraphs.length) {
    window.currentParagraphIndex++;
    return true;
  } else if (c + 1 < story.chapters.length) {
    window.currentChapterIndex++;
    window.currentParagraphIndex = 0;
    window.incrementDeviceStat?.('chaptersCompleted', 1);
    return true;
  }
  return false;
}

function _finishStory() {
  window.isPlaying = false;
  const playBtn = document.getElementById('play-btn-main');
  _updatePlayButton(false);

  if (typeof window.incrementDeviceStat === 'function') window.incrementDeviceStat('finishedStories', 1);
  else if (window.userProfile?.stats) window.userProfile.stats.finishedStories = (window.userProfile.stats.finishedStories || 0) + 1;

  if (window.userProfile?.library) {
    const storyRef = window.currentStory.storyKey || window.getStoryStableKey?.(window.currentStory) || window.currentStory.title;
    const libStory = window.findLibraryStoryByRef?.(storyRef, window.userProfile.library);
    if (libStory) {
      libStory.isFinished = true;
      if (typeof window.stampStorySyncField === 'function') window.stampStorySyncField(libStory, 'progress');
    }
    if (typeof window.saveLocalData === 'function') window.saveLocalData();
  }

  if (typeof window.triggerVirtue === 'function') {
    window.triggerVirtue('virtue_story_complete');
    window.virtueSpeak('Story complete! I hope you enjoyed it.', 8000);
  }
}

export function skipParagraph(offset) {
  if (!window.currentStory) return;
  const wasPlaying = window.isPlaying;
  pausePlayback();
  _releaseCurrentAudio(); // revoke old blob + force load of the new paragraph
  const story = window.currentStory;
  let c = window.currentChapterIndex;
  let p = window.currentParagraphIndex;

  if (offset > 0) {
    p += offset;
    while (c < story.chapters.length && story.chapters[c] && story.chapters[c].paragraphs && p >= story.chapters[c].paragraphs.length) {
      p -= story.chapters[c].paragraphs.length;
      c++;
    }
    if (c >= story.chapters.length) {
      c = story.chapters.length - 1;
      p = (story.chapters[c] && story.chapters[c].paragraphs) ? story.chapters[c].paragraphs.length - 1 : 0;
    }
  } else if (offset < 0) {
    p += offset;
    while (p < 0 && c > 0) {
      c--;
      p += story.chapters[c].paragraphs.length;
    }
    if (p < 0) {
      c = 0;
      p = 0;
    }
  }

  window.currentChapterIndex = c;
  window.currentParagraphIndex = p;

  window._readerHasScrolled = false;
  if (typeof window.updateReaderUIText === 'function') window.updateReaderUIText();
  if (wasPlaying) {
    window.isPlaying = true;
    playCurrentParagraph();
  }
}
window.skipParagraph = skipParagraph;

export function skipChapter(offset) {
  if (!window.currentStory) return;
  const wasPlaying = window.isPlaying;
  pausePlayback();
  _releaseCurrentAudio(); // revoke old blob + force load of the new chapter
  const story = window.currentStory;
  let c = window.currentChapterIndex + offset;

  if (c < 0) c = 0;
  if (c >= story.chapters.length) c = story.chapters.length - 1;

  window.currentChapterIndex = c;
  window.currentParagraphIndex = 0;

  window._readerHasScrolled = false;
  if (typeof window.updateReaderUIText === 'function') window.updateReaderUIText();
  if (wasPlaying) {
    window.isPlaying = true;
    playCurrentParagraph();
  }
}
window.skipChapter = skipChapter;

export function seekToParagraph(chapterIndex, paragraphIndex) {
  if (!window.currentStory) return;
  const wasPlaying = window.isPlaying;
  pausePlayback();

  window.currentChapterIndex = chapterIndex;
  window.currentParagraphIndex = paragraphIndex;
  _releaseCurrentAudio(); // revoke old blob + force load new paragraph

  window._readerHasScrolled = false;
  if (typeof window.updateReaderUIText === 'function') window.updateReaderUIText();

  if (wasPlaying) {
    window.isPlaying = true;
    const playBtn = document.getElementById('play-btn-main');
    _updatePlayButton(true);
    startBgKeepAlive();
    playCurrentParagraph();
  }
}
window.seekToParagraph = seekToParagraph;

export function seekToChapter(chapterIndexStr) {
  if (!window.currentStory) return;
  let c = parseInt(chapterIndexStr, 10);
  if (isNaN(c)) return;

  const wasPlaying = window.isPlaying;
  pausePlayback();

  const story = window.currentStory;
  if (c < 0) c = 0;
  if (c >= story.chapters.length) c = story.chapters.length - 1;

  window.currentChapterIndex = c;
  window.currentParagraphIndex = 0;
  _releaseCurrentAudio(); // revoke old blob + force load new chapter

  window._readerHasScrolled = false;
  if (typeof window.updateReaderUIText === 'function') window.updateReaderUIText();

  if (wasPlaying) {
    window.isPlaying = true;
    const playBtn = document.getElementById('play-btn-main');
    _updatePlayButton(true);
    startBgKeepAlive();
    playCurrentParagraph();
  }
}
window.seekToChapter = seekToChapter;

export function applyPlaybackSpeed() {
  const el = document.getElementById('speed-slider');
  const rate = parseFloat(el?.value || '1');

  if (window.isPlaying) {
    if (window.virtueSpeak) window.virtueSpeak("Please pause the story first before changing playback speed.", 4000);
    else alert("Please pause the story first before changing playback speed.");
    const currentRate = window.currentAudio ? (window.currentAudio.playbackRate || 1.0) : (window.userProfile?.settings?.speed || 1.0);
    if (el) {
      el.value = currentRate;
      if (window.onSpeedSliderInput) {
        window.onSpeedSliderInput(currentRate);
      }
    }
    return;
  }

  if (window.userProfile && window.userProfile.settings) {
    window.userProfile.settings.speed = rate;
  }
  if (typeof window.saveLocalData === 'function') window.saveLocalData();

  if (window.currentAudio instanceof HTMLAudioElement) {
    window.currentAudio.playbackRate = rate;
  } else if (window.currentAudio instanceof SpeechSynthesisUtterance) {
    const wasPlaying = window.isPlaying;
    if (wasPlaying) {
      pausePlayback();
      playCurrentParagraph();
    }
  }

  if (!window.isPlaying && window.virtueSpeak) {
    window.virtueSpeak("Speed changed.", 2500);
  }
  if (typeof window.updateTimeRemaining === 'function') window.updateTimeRemaining();
}
window.applyPlaybackSpeed = applyPlaybackSpeed;

window.onSpeedSliderInput = function(val) {
  const label = document.getElementById('speed-label');
  if (label) label.innerText = parseFloat(val).toFixed(2) + 'x';
};

window.applyPlaybackSpeedSlider = function(val) {
  applyPlaybackSpeed();
};

export function switchReaderVoiceEngine(engineVal, silent = false) {
  if (!engineVal) {
    engineVal = window.userProfile?.settings?.voiceEngine || 'pocket';
  }
  if (engineVal !== 'pocket' && engineVal !== 'webspeech') engineVal = 'pocket';
  if (!document.getElementById('voice-selector')) {
    // If DOM elements aren't ready yet, defer execution to guarantee perfect dropdown synchronization
    setTimeout(() => switchReaderVoiceEngine(engineVal, silent), 50);
    return;
  }

  if (window.isPlaying && !silent) {
    if (window.virtueSpeak) window.virtueSpeak("Please pause the story first before changing the voice engine.", 4000);
    else alert("Please pause the story first before changing the voice engine.");
    const prev = window.userProfile?.settings?.voiceEngine || 'pocket';
    const globalSel = document.getElementById('voice-engine-select');
    if (globalSel) globalSel.value = prev;
    const playbarSel = document.getElementById('reader-engine-select');
    if (playbarSel) playbarSel.value = prev;
    return;
  }

  pausePlayback();
  if (!window.userProfile) window.userProfile = {};
  if (!window.userProfile.settings) window.userProfile.settings = {};
  window.userProfile.settings.voiceEngine = engineVal;

  const globalSel = document.getElementById('voice-engine-select');
  if (globalSel) globalSel.value = engineVal;
  const playbarSel = document.getElementById('reader-engine-select');
  if (playbarSel) playbarSel.value = engineVal;

  const voiceSelector = document.getElementById('voice-selector');
  if (voiceSelector) {
    if (engineVal === 'pocket') {
      let savedVoice = window.userProfile?.settings?.pocketVoice || POCKET_DEFAULT_VOICE;
      if (typeof window.renderPocketVoiceOptions === 'function') {
        savedVoice = window.renderPocketVoiceOptions(voiceSelector, savedVoice);
      } else {
        voiceSelector.innerHTML = `<option value="${POCKET_DEFAULT_VOICE}">Donald Malone - American, Midwestern (Recommended)</option>`;
        voiceSelector.value = POCKET_DEFAULT_VOICE;
        savedVoice = POCKET_DEFAULT_VOICE;
      }
      window.userProfile.settings.pocketVoice = savedVoice;
    } else if (engineVal === 'webspeech' && 'speechSynthesis' in window) {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) {
        window.speechSynthesis.onvoiceschanged = () => {
          _populateWebSpeechVoices(voiceSelector, window.speechSynthesis.getVoices());
        };
      } else {
        _populateWebSpeechVoices(voiceSelector, voices);
      }
    }
  }

  if (!silent) {
    // Mark that the user explicitly chose this engine so auto-detection
    // never overrides their deliberate choice in future sessions.
    window.userProfile.settings._engineManuallySet = true;
    if (typeof window.saveLocalData === 'function') window.saveLocalData();
    if (typeof window.triggerVirtue === 'function') {
      window.triggerVirtue('virtue_bubble_wink');
      let label = engineVal === 'pocket' ? 'Pocket TTS' : 'Device';
      window.virtueSpeak(`Switched to ${label} voice. Well? How do I sound?`, 4000);
    }
  }

  if (!silent) {
    if (window.virtueSpeak) window.virtueSpeak("Voice engine changed. Recaching audio... Please wait for 30 paragraphs or 100% before resuming play.", 5000);
    else alert("Voice engine changed. Recaching audio... Please wait for 30 paragraphs or 100% before resuming play.");
    if (engineVal === 'pocket') {
      if (typeof window.startCaching === 'function') window.startCaching('Normal');
      else if (window.BufferManager) window.BufferManager.start();
    }
  }
}

window.onVoiceSelectionChange = function(newVoice) {
  if (window.isPlaying) {
    if (window.virtueSpeak) window.virtueSpeak("Please pause the story first before changing the voice.", 4000);
    else alert("Please pause the story first before changing the voice.");
    const engine = window.userProfile?.settings?.voiceEngine || 'pocket';
    const prev = engine === 'pocket' ? (window.userProfile?.settings?.pocketVoice || POCKET_DEFAULT_VOICE) : (window.userProfile?.settings?.webVoice || '');
    const sel = document.getElementById('voice-selector');
    if (sel) sel.value = prev;
    return;
  }

  if (!window.userProfile) window.userProfile = {};
  if (!window.userProfile.settings) window.userProfile.settings = {};
  const engine = window.userProfile.settings.voiceEngine || 'pocket';
  const prevVoice = engine === 'pocket'
    ? (window.userProfile.settings.pocketVoice || POCKET_DEFAULT_VOICE)
    : (window.userProfile.settings.webVoice || '');
  const cleanNewVoice = engine === 'pocket' && typeof window.canonicalPocketVoice === 'function'
    ? window.canonicalPocketVoice(newVoice)
    : newVoice;

  // Switching voice re-synthesizes the loaded story in the new voice — warn
  // first so a long recache is never a surprise. Previously cached voices are
  // kept, so the user can switch back without re-caching that one.
  if (window.currentStory && cleanNewVoice !== prevVoice) {
    const ok = window.confirm(
      "Changing the voice will re-cache this story in the new voice.\n\n" +
      "It can take a few minutes, and you'll need to wait for about 30 paragraphs " +
      "(or 100%) before playback. Your previously cached voices are kept.\n\nSwitch voice?"
    );
    if (!ok) {
      const sel = document.getElementById('voice-selector');
      if (sel) sel.value = prevVoice;
      return;
    }
  }

  if (engine === 'pocket') window.userProfile.settings.pocketVoice = cleanNewVoice;
  else window.userProfile.settings.webVoice = cleanNewVoice;

  if (typeof window.saveLocalData === 'function') window.saveLocalData();

  if (window.currentStory) {
    if (window.virtueSpeak) window.virtueSpeak("Voice changed - re-caching this story in the new voice. Wait for ~30 paragraphs or 100% before pressing play.", 5000);
    else alert("Voice changed - re-caching this story in the new voice. Wait for ~30 paragraphs or 100% before pressing play.");
    if (engine === 'pocket') {
      if (typeof window.startCaching === 'function') window.startCaching('Normal');
      else if (window.BufferManager) window.BufferManager.start();
    }
  } else {
    if (window.virtueSpeak) window.virtueSpeak("Voice setting updated.", 3000);
  }
};
window.switchReaderVoiceEngine = switchReaderVoiceEngine;

function _populateWebSpeechVoices(selectEl, voices) {
  const englishVoices = voices.filter(v => v.lang.startsWith('en'));
  const displayVoices = englishVoices.length > 0 ? englishVoices : voices;
  selectEl.innerHTML = '';

  displayVoices.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = `${v.name}(${v.lang})`;
    selectEl.appendChild(opt);
  });
}

export function saveBookmark() {
  if (!window.currentStory || !window.userProfile?.library) return;
  const storyRef = window.currentStory.storyKey || window.getStoryStableKey?.(window.currentStory) || window.currentStory.title;
  const libStory = window.findLibraryStoryByRef?.(storyRef, window.userProfile.library);

  if (libStory) {
    libStory.progressChapter = window.currentChapterIndex;
    libStory.progressParagraph = window.currentParagraphIndex;
    if (typeof window.stampStorySyncField === 'function') window.stampStorySyncField(libStory, 'progress');
    libStory.lastRead = Date.now();
    if (!libStory.bookmarks) libStory.bookmarks = [];

    const chIdx = window.currentChapterIndex;
    const pIdx = window.currentParagraphIndex;

    if (!libStory.bookmarks.find(b => b.c === chIdx && b.p === pIdx)) {
      const chap = window.currentStory.chapters[chIdx];
      const text = (chap && chap.paragraphs && chap.paragraphs[pIdx]) ? chap.paragraphs[pIdx].substring(0, 100) + '...' : 'Bookmark';
      const bookmarkStamp = Date.now();
      libStory.bookmarks.push({ id: `b_${chIdx}_${pIdx}_${bookmarkStamp}`, c: chIdx, p: pIdx, t: text, ts: bookmarkStamp, updatedAt: bookmarkStamp, label: '', note: '' });
      if (libStory.bookmarks.length > 50) libStory.bookmarks.shift();
      if (typeof window.stampStorySyncField === 'function') window.stampStorySyncField(libStory, 'bookmarks');
    }

    if (typeof window.saveLocalData === 'function') window.saveLocalData();
    if (typeof window.updateContinueReading === 'function') window.updateContinueReading();
    if (typeof window.renderBookmarksTab === 'function') window.renderBookmarksTab();

    if (window.userProfile?.stats) {
      if (typeof window.setDeviceStatFlag === 'function') window.setDeviceStatFlag('firstBookmark');
      else window.userProfile.stats.firstBookmark = 1;
      if (typeof window.checkForNewAchievements === 'function') window.checkForNewAchievements();
    }

    if (typeof window.triggerVirtue === 'function') {
      window.triggerVirtue('virtue_favorite_story');
      window.virtueSpeak("Bookmark saved!I'll remember where we left off.", 4000);
    }
  }
}
window.saveBookmark = saveBookmark;

function _isMetaParagraph(text) {
  // Delegates to the canonical detector (defined in ui_controller, exposed as
  // window.isMetaParagraph) so playback skips exactly the paragraphs the cache
  // and word-count skip. Derives the current story/chapter titles to match the
  // canonical (text, storyTitle, chapterTitle) signature.
  const story = window.currentStory;
  const chapTitle = (story && story.chapters && story.chapters[window.currentChapterIndex])
    ? story.chapters[window.currentChapterIndex].title
    : null;
  if (typeof window.isMetaParagraph === 'function') {
    return window.isMetaParagraph(text, story ? story.title : null, chapTitle);
  }
  return !text || !text.trim();
}

function _encodeWAV(samples, sampleRate) {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  const ws = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  ws(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  ws(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  const int16 = new Int16Array(buffer, 44);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
export function _updateMediaSessionMetadata() {
  _updateMediaSession(Boolean(window.isPlaying));
}
window._updateMediaSessionMetadata = _updateMediaSessionMetadata;
