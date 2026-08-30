import { getAudioChunk, saveAudioChunk } from './storage_core.js?v=storage-v19';
import {
  PRONUNCIATION_RULESET_VERSION,
  DEFAULT_POCKET_TEMPERATURE_PRESET,
  DEFAULT_POCKET_QUALITY_MODE,
  getPocketTuningPreset,
  normalizePronunciationOverrides as normalizeTtsPronunciationOverrides,
} from './tts_pronunciation_core.js?v=pron-v18';
import {
  POCKET_ORT_VERSION,
  POCKET_CALIBRATION_VERSION,
  POCKET_ACCELERATION_VERSION,
  POCKET_WASM_MODEL_REVISION,
  POCKET_WEBGPU_MODEL_REVISION,
  POCKET_WEBGPU_BUNDLE,
  POCKET_GPU_RESIDENT_STATE_BYTES,
  normalizePocketBackend,
  readNarrationEngineOverride,
  writeNarrationEngineOverride,
  isKokoroVoice,
  isKittenVoice,
  KITTEN_VOICES,
  KITTEN_DEFAULT_VOICE,
  KITTEN_ENGINE,
  voicesForEngine,
  coerceVoiceForEngine,
  KOKORO_VOICES,
  KOKORO_DEFAULT_VOICE,
  recommendedWasmThreadCount,
  recommendedPocketCacheWorkerCount,
  browserMajorVersion,
  detectMobilePlatform,
  isMobileLikePlatform,
  createProsodyDriftGuard,
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
} from './pocket_backend_policy.js?v=backend-v26';
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
const POCKET_DEFAULT_VOICE = window.POCKET_DEFAULT_VOICE || 'donald_malone';
const POCKET_SAFE_EMOTIONS = ['neutral', 'calm', 'happy', 'sad', 'worried', 'surprised', 'tired', 'frustrated'];
const POCKET_GATED_EMOTIONS = ['anger', 'excited', 'enthused', 'shout'];
const POCKET_ALL_EMOTIONS = [...POCKET_SAFE_EMOTIONS, ...POCKET_GATED_EMOTIONS, 'confused'];
const POCKET_BALANCED_EMOTIONS = ['neutral', 'calm', 'happy', 'sad', 'worried', 'surprised', 'tired', 'frustrated'];
const POCKET_BALANCED_EMOTION_MAP = {
  anger: 'frustrated',
  excited: 'happy',
  enthused: 'happy',
  shout: 'surprised',
  confused: 'worried',
};
const POCKET_EMOTION_PATTERN = new RegExp(`_(${POCKET_ALL_EMOTIONS.join('|')})$`);
// Pocket audio cache keys are position-based, so anything that shifts chapter
// or paragraph indices must invalidate them: embedded AO3 metadata removal and
// outline-less chapter splitting both do, and reusing old audio across such a
// change plays the wrong paragraph with nothing to detect it. Bump on any
// change to how a paragraph is rendered as well, so cached audio re-renders
// rather than mixing engines.
const POCKET_NARRATION_CACHE_VERSION = 'narrv19';
const POCKET_BACKEND_CACHE_VERSION = 'backendv2';
// Kokoro's render-shape version. Bump whenever anything that changes the audio
// for the same (text, voice) changes: the chunk cap, the clause rejoin, the
// phonemizer, or the model revision. v2 = text now goes through
// normalizeForPocketTts (pronunciation overrides, contractions, [Ns] strip).
// Back to v2 deliberately: the v3 model swap was measured and reverted, so the
// engine is once again the exact one that rendered every v2 entry. Returning the
// key restores those caches instead of forcing a third full re-render for a
// render that is now identical again.
// Known edge: on engines older than Safari 17.4 / Chrome 124 the espeak data
// package previously failed to unpack (see the polyfill in kokoro_worker), so
// v2 audio cached on THOSE devices was rendered without espeak's dictionaries.
// Reverting the key re-serves it. That is not a regression -- it is the state
// they were already in -- and fixing it would cost everyone else a re-render.
const KOKORO_NARRATION_CACHE_VERSION = 'kokorov2';
// Kitten renders are versioned on their own axis: a different model produces
// different audio for the same (text, voice), so the two must not share a key.
const KITTEN_NARRATION_CACHE_VERSION = 'kittenv1';
const NEURAL_CACHE_VERSIONS = Object.freeze({
  kokoro: KOKORO_NARRATION_CACHE_VERSION,
  kitten: KITTEN_NARRATION_CACHE_VERSION,
});

// Kokoro and Kitten are both single-session StyleTTS2 engines speaking the same
// worker protocol. Everything that differs from Pocket differs the SAME WAY for
// both, so branch on this rather than on either engine's name.
//
// Branching on the name is what shipped Kitten unable to run at all:
// _loadPocketEngine tested `engine !== 'pocket' && engine !== 'kokoro'` and
// returned false, so the tier was selectable, routed, and dead. Four other sites
// had the same shape - cache tagging, tag variants, voice resolution and the
// backend plan - and each would have failed differently and quietly.
function _isStyleTts2Engine(engine) {
  return engine === 'kokoro' || engine === KITTEN_ENGINE;
}
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
  neutral: 0.80,
  calm: 0.78,
  sad: 0.84,
  tired: 0.80,
  worried: 0.88,
  happy: 0.88,
  surprised: 0.90,
  frustrated: 0.90,
};
const POCKET_FULL_TEMP_CAPS = {
  neutral: 0.86,
  calm: 0.82,
  sad: 0.88,
  tired: 0.86,
  confused: 0.90,
  worried: 0.92,
  happy: 0.93,
  enthused: 0.94,
  surprised: 0.94,
  frustrated: 0.94,
  excited: 0.95,
  anger: 0.95,
  shout: 0.95,
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
  const raw = window.currentStory?.narrationPreset?.emotion || window.userProfile?.settings?.voiceEmotionMode || 'balanced';
  // 'full' is the TIER name (POCKET_PROSODY_TIERS); 'expressive' is the MODE
  // name. The story-preset dialog offered the tier name, so every story saved
  // with "Full" fell through to balanced here. The dialog now offers the mode
  // name; this accepts the ones already stored instead of quietly ignoring them.
  const mode = raw === 'full' ? 'expressive' : raw;
  return ['neutral', 'balanced', 'expressive'].includes(mode) ? mode : 'balanced';
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

  // Lexicons cover how prose actually carries emotion, not just the names of
  // emotions. Fiction almost never writes "he was angry" — it writes a dialogue
  // tag ("snapped", "spat") or a physical reaction ("jaw tight", "slammed").
  // The original lists held only the explicit words, so ordinary narrative
  // scored zero: `"Get away from me!" she shouted, shoving the table` matched
  // nothing at all and rendered in flat neutral.
  //
  // Sensitivity here is safe because it is not the last word. _planEmotionFor()
  // runs this same detector across a whole chapter and applies hysteresis
  // (dwell + quiet-exit), so an emotion must be *sustained* to change the
  // conditioning reference. Detection finds candidates; the plan decides.
  add('anger', /\b(angry|anger|furious|fury|rage|raging|hate|hated|hatred|snarl|snarled|snarling|growl|growled|growling|murder|murdered|seethe|seething|snapped|spat|slammed|shouted|shouting|yelled|yelling|roared|roaring|bellowed|glare|glared|glaring|fists?|teeth clenched|jaw (tight|clenched))\b/g, 3);
  add('happy', /\b(excited|thrilled|amazing|wonderful|fantastic|delighted|delight|laugh|laughed|laughing|laughter|grin|grinned|grinning|smile|smiled|smiling|cheer|cheered|cheering|beamed|beaming|joy|joyful|glee|bright(ly)?|radiant|hugged|elated)\b/g, 2);
  add('sad', /\b(sad|sadness|sorrow|cry|cried|crying|tears|tearful|weep|wept|weeping|sob|sobbed|sobbing|death|dead|died|dying|loss|lost her|lost him|grief|grieving|mourn|mourned|mourning|lonely|loneliness|heartbroken|ache|aching|hollow|empty|never (again|come back)|gone forever)\b/g, 2.5);
  // Grief is very often carried entirely by gesture, with no emotional word
  // anywhere in the paragraph — "he put his head in his hands. It was over."
  // scored a flat zero against the vocabulary list above. These are the common
  // fiction constructions, not a rewrite of the lexicon; a keyword detector
  // will still miss grief that is purely implied, which is an accepted ceiling
  // of this approach rather than something to keep patching case by case.
  add('sad', /\b(head in (his|her|their) hands|buried (his|her|their) face|shoulders shook|voice broke|choked up|it was over|nothing (would|could) bring)\b/g, 2.5);
  add('worried', /\b(worry|worried|worrying|fear|feared|fearful|afraid|scared|scaring|terror|terrified|danger|dangerous|threat|threatened|anxious|anxiety|nervous|panic|panicked|dread|dreaded|uneasy|tense|tensed|trembl(e|ed|ing)|shivered|shivering|held (his|her|their) breath|heart (pounding|racing|hammering))\b/g, 2.5);
  add('surprised', /\b(suddenly|sudden|gasp|gasped|gasping|startled|startling|surprise|surprised|shock|shocked|stunned|flinch|flinched|jolted|blinked|stared|whirled|spun around|froze)\b/g, 2);
  add('tired', /\b(tired|tiredness|sleepy|exhausted|exhaustion|weary|wearily|yawn|yawned|yawning|weakly|drained|slept|sleepless|worn out|heavy(-| )lidded|dragging|slumped|collapsed onto)\b/g, 2.5);
  add('frustrated', /\b(frustrated|frustration|annoyed|annoying|irritated|irritation|impossible|ugh|groan|groaned|groaning|muttered|muttering|sighed|sighing|exasperated|gritted|rolled (his|her|their) eyes)\b/g, 2);
  add('calm', /\b(softly|quietly|quiet|gently|gentle|calm|calmly|peaceful|peacefully|still(ness)?|whisper|whispered|whispering|murmur|murmured|murmuring|soothing|serene|hush(ed)?|slowly|drifted)\b/g, 2);

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

  // 2.05 meant a single weight-2 match (happy, surprised, frustrated, calm)
  // scored 2.00 and lost to the threshold by 0.05 — so those four emotions were
  // effectively unreachable on one keyword, no matter how clear it was.
  // "She laughed, bright and sudden" landed at confidence 0.98 and rendered
  // neutral. 2.0 lets one unambiguous signal count; short paragraphs still need
  // a strong (2.5-3 weight) word.
  const threshold = words.length < 12 ? 3.0 : 2.0;
  const confidence = threshold > 0 ? bestScore / threshold : 0;
  let emotion = bestScore < threshold ? 'neutral' : best;
  return {
    emotion,
    rawEmotion: best,
    score: Number(bestScore.toFixed(2)),
    threshold,
    confidence: Number(confidence.toFixed(2)),
    evidenceCount,
    highConfidence: (confidence >= 1.25 && evidenceCount >= 1) || (confidence >= 1.0 && evidenceCount >= 2),
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
      // Switch on high single-paragraph confidence, clear detection (confidence >= 1.0),
      // or a sustained two-paragraph vote, and never inside the post-switch dwell window.
      // 0.75 (was 0.9): lets moderately-voiced scenes reach their emotion state
      // instead of staying neutral — the pitch-matched pack keeps timbre stable
      // enough that the extra switches no longer read as speaker changes.
      const sustained = pendingRun >= 2 && info.confidence >= 0.75;
      if (dwell === 0 && (info.highConfidence || sustained || (info.confidence >= 1.0 && detected !== 'neutral'))) {
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
  if (mode !== 'expressive' && POCKET_GATED_EMOTIONS.includes(resolved)) {
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

// ── Long-form prosody drift guard ───────────────────────────────────────────
// Expressive narration raises sampling temperature, and higher temperature is
// exactly what destabilizes a long listen: artifacts accumulate over dozens of
// paragraphs rather than showing up on the first one. So expressiveness is not
// a fixed setting here — it is a tier that automatically steps down when this
// session starts producing quality-guard failures, and steps back up after a
// clean run.
//
// Tiers, in descending order: 'full' (POCKET_FULL_TEMP_CAPS) -> 'balanced'
// (POCKET_BALANCED_TEMP_CAPS) -> 'neutral' (emotion detection disabled
// entirely). Stability outranks expressiveness, so the guard only ever
// de-escalates on evidence and re-escalates on a sustained clean streak.
const _prosodyDrift = createProsodyDriftGuard();

function _effectiveProsodyTier() {
  return _prosodyDrift.effectiveTier(_emotionMode());
}
// Not published: _effectiveProsodyTier is read by _artifactCappedTemperature and
// _resolvePocketRoute in this module and by nothing outside it. The window alias
// belonged to the same family as _recordPocketProsodyOutcome and should have
// gone with it. The two hooks that ARE published unreferenced --
// inspectPocketEmotion and inspectPocketPreload -- say in their own comments
// that they exist for diagnostics, which is what makes them deliberate.

// Called once per synthesized paragraph with whether it passed the quality
// guard cleanly. Only tier transitions are logged, not every paragraph.
function _recordProsodyOutcome(clean) {
  const change = _prosodyDrift.record(clean, _emotionMode());
  if (!change) return;
  window.Diagnostics?.log(
    change.direction === 'down' ? 'WARN' : 'INFO',
    change.direction === 'down'
      ? 'Prosody drift guard stepped down a tier'
      : 'Prosody drift guard restored a tier',
    change,
  );
}
// No window alias: _recordProsodyOutcome is called from generateChunk in this
// module and from nowhere else, so publishing it only widened the surface.

// Exposed for diagnostics and browser verification: "does narration actually
// vary by emotion" is otherwise unanswerable from outside this module, which is
// how four separate expressiveness ceilings went unnoticed at once. Read-only —
// calling it has no effect on playback.
window.inspectPocketEmotion = (text) => _detectPocketEmotion(String(text || ''));

// Reset per story/chapter so one rough chapter does not permanently flatten the
// rest of the book.
window.resetPocketProsodyDrift = () => {
  _prosodyDriftPosition = null;
  _prosodyDrift.reset();
};

// ...and actually call it. This export had no callers anywhere, so a chapter
// that tripped the guard carried its demotion into every later chapter and the
// next book, which is exactly what the line above says must not happen. (The
// guard does re-escalate on its own after 20 clean paragraphs, so this was a
// slow recovery rather than a permanent one -- but "recovers eventually" is not
// what a per-chapter reset means.)
//
// Driven from position rather than from a navigation hook because there are
// five ways to change chapter (skipChapter, seekToChapter, seekToParagraph, the
// paragraph-end rollover, and a resumed story) and a hook on each is four more
// chances to miss one. playCurrentParagraph runs on every one of them.
let _prosodyDriftPosition = null;
function _syncProsodyDriftToPosition() {
  const key = `${window.currentStory?.storyKey || window.currentStory?.title || ''}::${window.currentChapterIndex || 0}`;
  if (_prosodyDriftPosition === key) return;
  const moved = _prosodyDriftPosition !== null;
  _prosodyDriftPosition = key;
  if (moved) _prosodyDrift.reset();
}

function _artifactCappedTemperature(baseTemperature, emotion, retryLevel = 0) {
  // POCKET_FULL_TEMP_CAPS was previously dead: this function computed the mode
  // and then unconditionally used the balanced table, so the wider caps could
  // never apply no matter what the user selected.
  const caps = _effectiveProsodyTier() === 'full'
    ? POCKET_FULL_TEMP_CAPS
    : POCKET_BALANCED_TEMP_CAPS;
  const intended = Number(caps[emotion] || caps.neutral);
  const base = Number(baseTemperature);
  // The cap table is the per-emotion sampling temperature, not a ceiling on
  // the preset. min(preset, cap) flattened every paragraph to 0.70 whenever
  // the default balanced preset sat below every cap — which is why Expressive
  // in Settings still sounded like Neutral. A missing table entry falls back
  // to the preset; the worker still clamps to [0.5, 0.95].
  const chosen = Number.isFinite(intended)
    ? intended
    : (Number.isFinite(base) ? base : 0.82);
  return Number(Math.max(0.5, Math.min(0.95, chosen - (retryLevel ? 0.06 : 0))).toFixed(2));
}

// The route carries the engine it was resolved FOR, because everything
// downstream of it -- voice registration, backend calibration, the prosody
// cache tag -- is Pocket-specific and must not run for another engine. Deriving
// it again later from _resolveActiveEngine() would not be equivalent: the two
// hardcoded 'pocket' call sites this replaced proved the resolved engine and
// the engine a route was built for can disagree.
function _resolvePocketRoute(engine, voice, text, ctx = null) {
  if (engine !== 'pocket') {
    return { engine, voiceId: _normalizeVoice(engine, voice || null), baseVoice: voice || '', emotion: 'neutral', emotionInfo: null };
  }
  const baseVoice = _baseVoiceId(voice || window.userProfile?.settings?.pocketVoice || POCKET_DEFAULT_VOICE);
  const lockedEmotion = _emotionFromAssetVoice(voice);
  // The drift guard can force neutral even when the user has expressive on:
  // a session that is actively producing artifacts gets stability back first.
  const expressive = (window.isPocketExpressiveProsodyEnabled?.()
    ?? (window.userProfile?.settings?.expressiveProsody !== false))
    && _effectiveProsodyTier() !== 'neutral';
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
  return { engine, voiceId, baseVoice, emotion, emotionInfo };
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
    seed: overrides.seed != null ? overrides.seed : (overrides.voiceSeed != null ? overrides.voiceSeed : (s.pocketVoiceSeed || null)),
    voiceSeed: overrides.voiceSeed != null ? overrides.voiceSeed : (overrides.seed != null ? overrides.seed : (s.pocketVoiceSeed || null)),
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
  // Kokoro renders are versioned too. This returned '' for every non-Pocket
  // engine, so a Kokoro chunk was keyed on position and voice alone and carried
  // none of the markers that say HOW it was rendered. Changing the per-inference
  // chunk cap (510 -> 192, and now 192/256 by device class) moves every seam in
  // a paragraph, and audio rendered under the old cap was being replayed as if
  // nothing had changed -- textHash catches re-segmentation of the paragraph,
  // not a change in how that paragraph is split for inference.
  if (_isStyleTts2Engine(engine)) return `#${NEURAL_CACHE_VERSIONS[engine]}`;
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
  if (_isStyleTts2Engine(engine)) return [_prosodyCacheTag(engine)];
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
    // Which WASM runtime the worker actually resolved, and whether cross-origin
    // isolation really took. Both were already measured and neither was visible
    // anywhere, so a device on the heavy fallback path looked identical to one
    // on the lean path -- and the difference (stock ORT reading .onnx protobuf
    // vs the minimal relaxed-SIMD build reading .ort) is a large slice of peak
    // startup memory on a constrained iPhone. Read-only: nothing branches on
    // these, they are reported.
    ortWasmRuntimeFlavor: _pocketBackendRuntime.ortWasmRuntimeFlavor || 'unreported',
    relaxedSimdSupported: _pocketBackendRuntime.relaxedSimdSupported ?? null,
    ortFormatModels: _pocketBackendRuntime.ortFormatModels ?? null,
    crossOriginIsolated: window.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
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
  // Kokoro carries no per-emotion voice variants, so there is nothing to route:
  // the requested voice is the voice.
  if (_isStyleTts2Engine(engine)) return window.resolveVoiceForEngine(engine, voice);
  if (engine !== 'pocket') return _normalizeVoice(engine, voice || null);
  return _resolvePocketRoute(engine, voice, text, ctx).voiceId;
}
window.resolveVoiceWithSentiment = resolveVoiceWithSentiment;

// Narration engine selection is NOT re-published here.
//
// Four wrappers used to sit at this point -- resolveNarrationEngineChoice,
// describeNarrationEngineChoice, getNarrationEngineOverride and
// setNarrationEngineOverride -- under a comment saying engine_utils
// feature-detects them rather than importing. It stopped doing that when the
// engine decision moved into the shell: engine_utils and settings_manager both
// import selectNarrationEngine from the policy directly, precisely so the
// answer does not depend on whether this lazy-loaded module has arrived. That
// left all four unreferenced, and a fifth path to the same decision is exactly
// what made "which engine is running" ambiguous in the first place.

window.KOKORO_VOICES = KOKORO_VOICES;
window.KOKORO_DEFAULT_VOICE = KOKORO_DEFAULT_VOICE;
window.isKokoroVoice = isKokoroVoice;

// Which voice id to hand the worker for the engine that is actually running.
// A Pocket voice id means nothing to Kokoro and vice versa, so a stored voice
// from the other engine must not leak across.
window.KITTEN_VOICES = KITTEN_VOICES;
window.KITTEN_DEFAULT_VOICE = KITTEN_DEFAULT_VOICE;
window.isKittenVoice = isKittenVoice;
window.voicesForEngine = voicesForEngine;

window.resolveVoiceForEngine = function resolveVoiceForEngine(engine, voice) {
  const allowed = voicesForEngine(engine);
  if (!allowed.length) return voice;          // Pocket validates its own packs.
  const requested = String(voice || '').toLowerCase().trim();
  if (allowed.some((v) => v.id === requested)) return requested;
  const settings = window.userProfile?.settings || {};
  const saved = engine === KITTEN_ENGINE ? settings.kittenVoice : settings.kokoroVoice;
  return coerceVoiceForEngine(engine, String(saved || '').toLowerCase().trim());
};


// The narration worker pool is sized by recommendedPocketCacheWorkerCount()
// alone (see _recommendedPocketCacheWorkers below), which weighs platform,
// memory, isolation, battery and thermal state. The HARD_CAP / MANUAL_CAP /
// DEFAULT_MAX constants and the _getMaxWorkers() that read them lived here
// until that policy took over, and were left behind with no callers -- while
// the comment above them still claimed maxWorkers was "read dynamically from
// userProfile.settings at engine load time", which is what made the dead
// Settings override look wired. settings.maxWorkers now reaches the pool for
// real, as a ceiling passed to the policy.

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
  const detectedGpuEl = document.getElementById('detected-gpu');
  if (detectedGpuEl && _gpuVendor && _gpuVendor !== 'unknown') {
    detectedGpuEl.textContent = _gpuVendor;
  }
  if (typeof window.refreshPerfPanel === 'function') {
    try { window.refreshPerfPanel(); } catch(_) {}
  }
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
  const settings = window.userProfile?.settings || {};
  return recommendedPocketCacheWorkerCount({
    // The Settings override, as a ceiling. Nothing read settings.maxWorkers on
    // this path before, so the control and its "may cause audio glitches"
    // warning described an effect that could not happen.
    userMaxWorkers: settings.enableManualWorkers ? Number(settings.maxWorkers) : NaN,
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
// Not published: the pool size is decided here and read by _loadPocketEngine.
// The window alias had no callers.

async function _preparePocketBackendPlan(force = false) {
  if (_pocketBackendPlanPromise && !force) return _pocketBackendPlanPromise;
  _pocketBackendPlanPromise = (async () => {
    const settings = window.userProfile?.settings || {};
    const preference = readPocketDeviceBackendPreference(localStorage);
    delete settings.pocketBackend;
    const deviceSetup = readPocketDeviceSetup(localStorage);
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const userAgent = navigator.userAgent || '';
    const mobile = isMobileLikePlatform(userAgent);
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
      const proxyBase = window.PR_PROXY_BASE || window.POCKET_READER_CONFIG?.proxyBase || 'https://pocket-reader-proxy.alpharius67.workers.dev';
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
  _resetPocketVoiceRegistry();
  _pocketBackendOptimizationPromise = null;
  _setNeuralState('idle');
  loadedVoiceEngine = null;
}

async function _loadPocketEngine() {
  const initializationStartedAt = performance.now();
  const engine = _resolveActiveEngine();
  const settings = window.userProfile?.settings || {};
  // Both neural engines load through this path. They speak the same worker
  // protocol, so everything below is shared; only the script URL and the voice
  // namespace differ.
  if (engine !== 'pocket' && !_isStyleTts2Engine(engine)) return false;

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
    _resetPocketVoiceRegistry();
    _setNeuralState('idle');
    loadedVoiceEngine = null;
  }

  // An engine switch fires the reset without awaiting it (the change handler is
  // synchronous). Wait for any in-flight teardown before allocating.
  if (_pocketResetPromise) { try { await _pocketResetPromise; } catch (_) {} }

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
  // Kokoro has one WASM graph and no WebGPU variant, so the Pocket backend
  // planner (eligibility probes, calibration, GPU demotion bookkeeping) has
  // nothing to decide and running it would only spend time and write
  // calibration state that does not describe this engine.
  const backendPlan = _isStyleTts2Engine(engine)
    ? { preference: 'wasm', selectedBackend: 'wasm', threadCount: 1, eligibility: { eligible: false } }
    : await _preparePocketBackendPlan();
  const vendor = _gpuVendor || 'unknown';
  // A second complete inference worker is allowed only for positively
  // high-memory desktop cache jobs. The shared policy keeps every mobile,
  // saver, low-battery, WebGPU, and non-isolated session on one worker.
  let nWorkers = await _recommendedPocketCacheWorkers(backendPlan);
  _pocketBackendRuntime.cacheWorkerCount = nWorkers;

  const ENGINE_LOAD_LABELS = { kokoro: 'Kokoro TTS', kitten: 'Kitten TTS', pocket: 'Pocket TTS' };
  let engineLabel = ENGINE_LOAD_LABELS[engine] || 'Pocket TTS';
  _setStatus(`Loading ${engineLabel} (${backendPlan.selectedBackend === 'webgpu' ? 'WebGPU FP16' : 'threaded WASM'})...`);

  let engineLoadTimerId = null;
  try {
    let workersReady = 0;
    let workerFailed = 0;

    const spawnWorker = (i) => {
      return new Promise((resolveSpawn) => {
        // A fixed absolute, versioned URL is essential for installed PWAs: a
        // timestamp cache-buster misses the app-shell cache and a relative URL
        // resolves consistently from every static-app route.
        const WORKER_SCRIPTS = {
          kokoro: 'assets/js/kokoro_worker.js?v=kokoro-v17',
          kitten: 'assets/js/kitten_worker.js?v=kitten-v6',
          pocket: 'assets/js/pocket_worker.js?v=pocket-worker-v68',
        };
        const workerScript = new URL(
          WORKER_SCRIPTS[engine] || WORKER_SCRIPTS.pocket, document.baseURI,
        ).href;
        const worker = new Worker(workerScript, { type: 'module' });
        const workerObj = { id: i, worker: worker, activeTasks: 0, ready: false };
        ttsWorkers.push(workerObj);

        let resolved = false;
        const done = (success) => {
          if (!resolved) {
            resolved = true;
            // Whatever settled this spawn, the startup watchdog is finished --
            // leaving it armed would terminate a worker that just went ready.
            clearStartupWatchdog();
            resolveSpawn(success);
          }
        };

        // Silence watchdog for worker startup.
        //
        // This used to be a one-shot 45s timer cleared by the first message of
        // ANY kind -- and pocket_worker.js posts "Worker Thread Started" as its
        // very first executable line, so the guard was disarmed milliseconds in,
        // before init had loaded a single model. It could only ever catch a
        // worker that failed to run line 1, which onerror already reports.
        //
        // That mattered most on iOS. Safari terminates a worker that exceeds the
        // tab memory ceiling WITHOUT firing onerror or any other event -- the
        // worker simply stops. Peak residency is the moment every ONNX session is
        // live, which is exactly where init posts "Preparing voice (...)" at 90%.
        // So the kill landed there, that status was the last message the UI ever
        // received, and with the startup guard already cleared and onerror never
        // firing, nothing failed the load until ENGINE_LOAD_TIMEOUT_MS -- twenty
        // minutes on mobile. Indistinguishable from a permanent hang.
        //
        // Rearming on each message instead measures what actually matters: not
        // "did the worker ever speak" but "has it gone quiet mid-init". Init
        // reports progress continuously (2/10/30/70/90 plus per-asset status), so
        // a healthy worker keeps this alive; a dead one trips it in one interval.
        // Base budget must clear every BOUNDED silent operation the worker can
        // legitimately be inside, or the watchdog kills healthy workers. The
        // longest of those is MODEL_STALL_TIMEOUT_MS (60s) on a stalled read;
        // ORT module import allows 45s. 75s clears both with margin.
        //
        // Session creation is the exception and cannot be covered by any base
        // value: ort.InferenceSession.create() is one blocking call posting
        // nothing for minutes on a phone, which is why the worker allows five
        // for it. Rather than duplicate that constant here and let the two
        // drift, the worker declares its own budget on the status that precedes
        // the blocking call and this honours it.
        const WORKER_SILENCE_TIMEOUT_MS = 75000;
        // Margin so the worker's own timeout rejects first and reports a real
        // error whenever it still can; this only fires when the worker is gone
        // and no rejection is possible.
        const WORKER_PHASE_GRACE_MS = 30000;
        let workerSilenceBudgetMs = WORKER_SILENCE_TIMEOUT_MS;
        let startupTimerId = null;
        const failWorkerStartup = (message) => {
          if (workerObj.ready || resolved) return;
          workerFailed++;
          console.error(`${engineLabel} Worker ${i}: ${message}`);
          if (window.Diagnostics) {
            window.Diagnostics.log('ERROR', message, {
              worker: i,
              workerScript,
              lastStatus: workerObj._lastStatus || null,
              lastProgress: workerObj._lastProgress ?? null,
            });
          }
          worker.terminate();
          done(false);
          if ((workersReady + workerFailed) === nWorkers) {
            _setNeuralState(workersReady > 0 ? 'ready' : 'failed');
            if (_engineReadyResolve) { _engineReadyResolve(); _engineReadyResolve = null; }
          }
        };
        const clearStartupWatchdog = () => {
          if (startupTimerId !== null) {
            clearTimeout(startupTimerId);
            startupTimerId = null;
          }
        };
        const armStartupWatchdog = () => {
          clearStartupWatchdog();
          if (workerObj.ready || resolved) return;
          const budget = workerSilenceBudgetMs;
          startupTimerId = setTimeout(() => {
            const stalledAt = workerObj._lastStatus
              ? ` (last status: ${workerObj._lastStatus})`
              : '';
            failWorkerStartup(
              `${engineLabel} worker went silent for ${Math.round(budget / 1000)}s during startup${stalledAt}`
              + ' — treating it as terminated (on iOS this is normally the tab memory ceiling).',
            );
          }, budget);
        };
        armStartupWatchdog();

        worker.onmessage = (e) => {
          const data = e.data;
          // Only a terminal outcome disarms the watchdog; everything else is
          // proof of life and pushes the deadline out.
          if (data?.type === 'init_done' || data?.type === 'ready' || data?.type === 'loaded'
              || data?.type === 'bundle_loaded' || data?.type === 'init_error' || data?.type === 'error') {
            clearStartupWatchdog();
          } else {
            // A declared blocking phase buys its own budget for the NEXT silent
            // stretch only; anything else returns to the base budget, so a long
            // session creation cannot leave the watchdog permanently relaxed.
            const declared = Number(data?.budgetMs);
            workerSilenceBudgetMs = (data?.phase === 'blocking' && Number.isFinite(declared) && declared > 0)
              ? declared + WORKER_PHASE_GRACE_MS
              : WORKER_SILENCE_TIMEOUT_MS;
            armStartupWatchdog();
          }
          if (typeof data?.status === 'string') workerObj._lastStatus = data.status;
          if (data?.info?.progress !== undefined) workerObj._lastProgress = data.info.progress;

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
            _setStatus(data.status || `Preparing ${engineLabel}...`);
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
            const evicted = String(data.voiceName || '');
            _encodedPocketVoices.delete(evicted);
            // Drop any request that had been resolved onto this asset, so the
            // next lookup reloads instead of returning an id the worker just
            // dropped from its voice table.
            for (const [requested, resolved] of _pocketVoiceFallbacks) {
              if (resolved === evicted) {
                _pocketVoiceFallbacks.delete(requested);
                _encodedPocketVoices.delete(requested);
              }
            }
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
            // activeTasks is released in _runPocketWorkerGeneration's finally,
            // which covers this path AND the timeout path. Decrementing here too
            // released one dispatch twice, so with a two-worker cache pool a
            // still-busy worker reported activeTasks 0 and _selectReadyPocketWorker
            // stacked the next paragraph onto it while the other worker idled.
            if (ttsQueue[data.id]) {
              ttsQueue[data.id].resolve(data);
              delete ttsQueue[data.id];
            }
          } else if (data.type === 'generate_error') {
            if (ttsQueue[data.id]) {
              ttsQueue[data.id].reject(new Error(data.error));
              delete ttsQueue[data.id];
            }
          }
        };

        worker.onerror = (err) => {
          clearStartupWatchdog();
          const errMsg = err?.message || (err?.filename ? `${err.filename}:${err.lineno}:${err.colno}` : (typeof err === 'string' ? err : 'Worker initialization error'));
          if (!workerObj.ready && !resolved) {
            workerFailed++;
            console.error(`${engineLabel} Worker ${i} crashed (onerror):`, errMsg, err);
            if (window.Diagnostics) window.Diagnostics.log('ERROR', `Worker ${i} crashed`, { message: errMsg, filename: err?.filename, lineno: err?.lineno, colno: err?.colno });
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
          // The engine actually being started. Neither worker reads this today,
          // but a message that names the wrong engine is a trap for the next
          // thing that does -- and this whole file's history is that trap.
          voiceEngine: engine,
          backendPreference: backendPlan.preference,
          selectedBackend: backendPlan.selectedBackend,
          wasmThreadCount: backendPlan.threadCount,
          wasmReferenceRtf: _pocketBackendRuntime.wasmReferenceRtf,
          graphCapture: _pocketBackendRuntime.graphCapture,
          mimiProvider: _pocketBackendRuntime.mimiProvider,
          gpuSyncGroupBlocks: _pocketBackendRuntime.gpuSyncGroupBlocks,
          constrainedMemoryMode: window.isPocketDeviceMemorySafeMode?.() !== false,
          // Resolved here because WorkerNavigator has no maxTouchPoints, so the
          // worker cannot distinguish an iPad from a Mac on its own.
          clientPlatform: detectMobilePlatform(navigator.userAgent || ''),
        });
      });
    };

    // Fix Memory/Cache Stampede: Wait for all workers to download/init sequentially
    // Concurrent initialization of 8 workers causes massive memory spikes (OOM) and crashes the Web Worker
    // ── Hard timeout on engine load ──────────────────────────────────────
    // Allow slow first-time mobile downloads while still bounding a silent
    // network or worker failure. The timer now covers worker creation too.
    const isMobileDevice = isMobileLikePlatform(navigator.userAgent || '');
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

// A neural engine that fails to load must not rewrite the reader's saved
// preference, and it must not silence the fallback it just promised.
//
// This called switchReaderVoiceEngine('webspeech'), which did two things it had
// no business doing. It PERSISTED voiceEngine: 'webspeech', so a single
// transient failure demoted the profile for good -- and since only a neural
// engine starts a cache job, every later story open then skipped the
// "Preparing Narration" modal with nothing on screen to explain why. And it
// called pausePlayback(), which cleared window.isPlaying, so the caller took
// its "User paused during generation" exit and the device voice this function
// announces never spoke a word. The reader got silence AND a downgraded
// account, from one failed worker.
//
// Now the failure is recorded in memory for this page only. Playback keeps
// running so _playGeneratedAudio can finish the paragraph on the device voice,
// a reload retries the neural engine, and picking one in Settings clears it.
function _fallbackToWebSpeech() {
  const _setStatus = (msg) => {
    const bufferText = document.getElementById('reader-buffer-text');
    if (bufferText) bufferText.innerText = msg;
    const modalText = document.getElementById('caching-progress-text');
    if (modalText) modalText.innerText = msg;
  };

  _setStatus('Engine failed to load. Check diagnostics for details.');
  window._pocketNeuralEngineUnavailable = true;

  // Reflect the temporary state in the controls WITHOUT writing it to the
  // profile, so the reader can see which voice is speaking and still finds
  // their own choice intact next launch.
  const controlValue = 'webspeech';
  const globalSel = document.getElementById('voice-engine-select');
  if (globalSel) globalSel.value = controlValue;
  const playbarSel = document.getElementById('reader-engine-select');
  if (playbarSel) playbarSel.value = controlValue;
  const voiceSelector = document.getElementById('voice-selector');
  if (voiceSelector && 'speechSynthesis' in window) {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) {
      window.speechSynthesis.onvoiceschanged = () => {
        _populateWebSpeechVoices(voiceSelector, window.speechSynthesis.getVoices());
      };
    } else {
      _populateWebSpeechVoices(voiceSelector, voices);
    }
  }

  window.Diagnostics?.log('WARN', 'Neural engine unavailable for this session; using the device voice', {
    engine: loadedVoiceEngine || 'unknown',
    persisted: false,
  });
  if (typeof window.triggerVirtue === 'function') {
    window.triggerVirtue('virtue_annoyed_bubble');
    window.virtueSpeak(
      "Couldn't load the neural engine, so I'll read with the device voice for now. Your saved choice is untouched — reload to try again.",
      7000,
    );
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
  audio.addEventListener('timeupdate', () => {
    if (typeof _onAudioClockPump === 'function') _onAudioClockPump();
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
        { src: new URL('assets/img/reader%20512.png', document.baseURI).href, sizes: '512x512', type: 'image/png' },
        { src: new URL('assets/img/reader%20192.png', document.baseURI).href, sizes: '192x192', type: 'image/png' },
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

export function preparePocketMobileMediaSession() {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
    || (navigator.maxTouchPoints || 0) > 0;
  if (!mobile) return false;

  // Use the same media element that later receives narrated blobs. Calling
  // play() here, directly in the user's tap, grants iOS playback permission to
  // that element before model loading and synthesis cross async boundaries.
  if (!_premiumAudio) {
    _premiumAudio = new Audio();
  }
  _premiumAudio.preload = 'auto';
  _premiumAudio.playsInline = true;
  _premiumAudio.setAttribute?.('playsinline', '');
  _premiumAudio.setAttribute?.('webkit-playsinline', '');
  _bindMediaElementSession(_premiumAudio);
  window.currentAudio = _premiumAudio;
  const keepAlive = _ensureBgKeepAlive();
  const hasPausedNarration = _premiumAudio.dataset?.pocketNarration === '1'
    && Boolean(_premiumAudio.src);
  if (!hasPausedNarration && (!_premiumAudio.src || _premiumAudio.dataset?.pocketUnlock !== '1')) {
    _premiumAudio.src = keepAlive.src;
    _premiumAudio.loop = true;
    _premiumAudio.volume = 0.001;
    if (_premiumAudio.dataset) _premiumAudio.dataset.pocketUnlock = '1';
    _premiumAudio.play().catch(() => {});
  }

  // No AudioContext is created here. Mobile narration plays through the media
  // element above and never routes through a graph, so the context this used to
  // build was resumed on every paragraph and then never connected to anything --
  // dead weight on the platform most sensitive to audio-session churn.
  return true;
}
window.preparePocketMobileMediaSession = preparePocketMobileMediaSession;

export function startBgKeepAlive() {
  const audio = _ensureBgKeepAlive();
  if (audio && audio.paused) {
    audio.play().catch(() => {});
  }
  if (_premiumAudio?.dataset?.pocketUnlock === '1' && _premiumAudio.paused) {
    _premiumAudio.play().catch(() => {});
  }
  if (window.isPlaying) _updateMediaSession(true);
}
export function stopBgKeepAlive() {
  const isCachingActive = Boolean(window.BufferManager?.isActive && !window.BufferManager?.paused);
  if (_bgKeepAlive && !_bgKeepAlive.paused && !window.isPlaying && !isCachingActive) {
    try { _bgKeepAlive.pause(); } catch (_) {}
  }
  if (_premiumAudio?.dataset?.pocketUnlock === '1'
      && !_premiumAudio.paused && !window.isPlaying && !isCachingActive) {
    try { _premiumAudio.pause(); } catch (_) {}
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
// requested asset id -> the asset id actually registered in the workers. Only
// differs when a voice+emotion file was missing and the loader fell back.
const _pocketVoiceFallbacks = new Map();
const _pocketVoiceLoadPromises = new Map();

// Bumped by every reset. A voice load that started before the reset must not
// write its result into the registry afterwards: the workers it registered with
// are gone, so the memo would claim a voice is loaded in a fresh worker that
// never received it, and the next generate would dispatch a voice name that
// worker does not know.
let _pocketVoiceRegistryGeneration = 0;

// Every worker teardown path invalidates the registrations, so the memo of what
// is loaded must be dropped with them or the next generate would target a voice
// the fresh worker has never been given.
function _resetPocketVoiceRegistry() {
  _pocketVoiceRegistryGeneration += 1;
  _encodedPocketVoices = new Set();
  _pocketVoiceFallbacks.clear();
  _pocketVoiceLoadPromises.clear();
}

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
  // A previously-resolved request may have landed on a different asset (this
  // emotion state 404s). Return the asset actually registered in the workers,
  // otherwise generation would be dispatched with a voice name they don't know.
  if (_encodedPocketVoices.has(targetVoice)) {
    return _pocketVoiceFallbacks.get(targetVoice) || targetVoice;
  }
  if (_pocketVoiceLoadPromises.has(targetVoice)) return _pocketVoiceLoadPromises.get(targetVoice);

  // Snapshot the registry generation this load belongs to. Registration below
  // is only recorded if no teardown happened while we were awaiting.
  const registryGeneration = _pocketVoiceRegistryGeneration;

  const loadPromise = (async () => {
    let loadedVoice = targetVoice;
    const voiceLabel = typeof window.getPocketVoiceLabel === 'function'
      ? window.getPocketVoiceLabel(targetVoice)
      : targetVoice;
    console.log(`[PocketTTS] Loading custom voice: ${targetVoice}`);

    const proxyBase = window.PR_PROXY_BASE || window.POCKET_READER_CONFIG?.proxyBase || 'https://pocket-reader-proxy.alpharius67.workers.dev';
    const directB2Base = 'https://f005.backblazeb2.com/file/pocket-reader-assets';
    let url = `${proxyBase}/models/voices/${POCKET_VOICE_PACK_PATH}${targetVoice}.${fileExt}?rev=${POCKET_VOICE_PACK_REV}`;
    // The key this request started at. `url` is reassigned when a fallback
    // candidate wins, so keep the original for the Cache Storage write below.
    const requestedUrl = url;
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
      // Some browsers/private-mode/quota states throw "Unexpected internal
      // error" from CacheStorage.open. It is non-fatal — the voice fetch below
      // still hits the browser HTTP cache — so warn only ONCE per session
      // instead of on every voice load and every worker recycle (which was the
      // repeated console warning). The persistent-cache layer is simply skipped.
      if (!window._pocketVoiceCacheWarned) {
        window._pocketVoiceCacheWarned = true;
        console.warn("Pocket TTS voice CacheStorage unavailable; using HTTP cache instead.", e?.name || e);
      }
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
          // Store under BOTH the URL the bytes came from and the URL this
          // request started at. Without the second key a fallback asset was
          // written under the fallback URL while the next lookup only ever
          // checked the original — so every paragraph re-ran the whole fetch +
          // candidate chain instead of hitting Cache Storage.
          await cache.put(url, new Response(buffer.slice(0)));
          if (url !== requestedUrl) {
            await cache.put(requestedUrl, new Response(buffer.slice(0)));
          }
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
    // A worker crash / engine reset / idle release during the awaits above
    // replaced the whole pool, so this registration describes workers that no
    // longer exist. Return the voice for THIS caller but do not memoise it, or
    // the next request would skip loading and dispatch to a worker that was
    // never given the voice.
    if (registryGeneration !== _pocketVoiceRegistryGeneration) {
      console.log(`[PocketTTS] Voice ${loadedVoice} loaded into a retired worker pool; not memoising.`);
      return loadedVoice;
    }
    _encodedPocketVoices.add(loadedVoice);
    // Also mark the voice that was ASKED for as resolved. The early-return at the
    // top of this function tests targetVoice, so when a request fell back to a
    // different asset (a 404 on this emotion state) nothing was ever memoised
    // under targetVoice and every subsequent paragraph re-ran the full fetch →
    // candidate chain → worker re-registration cycle.
    _encodedPocketVoices.add(targetVoice);
    _pocketVoiceFallbacks.set(targetVoice, loadedVoice);
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
  const proxyBase = window.PR_PROXY_BASE || window.POCKET_READER_CONFIG?.proxyBase || 'https://pocket-reader-proxy.alpharius67.workers.dev';
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
  // Belt and braces with the call-site gates: this ends in
  // ensurePocketVoiceLoaded(), so reaching it on a Kokoro session would load a
  // Pocket voice pack and post register_precompiled_voice to a worker that
  // cannot answer it. There is nothing here for another engine to calibrate.
  if (_resolveActiveEngine() !== 'pocket') return _pocketBackendRuntime;
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

// Field crash, iPhone 13 (4 GB), 2026-08-22: caching died at paragraph 20 and
// again at 41 — exactly the every-20-paragraph worker recycle.
//
// This function was declared async but contained no await, so it returned
// synchronously. worker.terminate() only REQUESTS teardown; it does not wait
// for WebKit to reclaim the worker's WASM heap, and that heap is holding the
// full ~126 MB model set. _maybeRecyclePocketEngine then called
// _loadPocketEngine() on the very next line, which downloads and creates a
// second full set. For a moment the device is asked to hold both — roughly
// 250 MB — and on a 4 GB iPhone that is the kill.
//
// Yielding lets the terminated worker actually go away first. Two macrotasks
// plus a short settle on constrained devices costs a fraction of a second
// against a recycle that only happens every twenty paragraphs, and it is the
// difference between a reload and a crash.
async function _resetPocketEngineForBackend() {
  const hadWorkers = ttsWorkers.length > 0;
  ttsWorkers.forEach((worker) => worker?.worker?.terminate());
  ttsWorkers = [];
  Object.values(ttsQueue).forEach((entry) => {
    try { entry.reject(new Error('Pocket backend reset')); } catch (_) {}
  });
  ttsQueue = {};
  _resetPocketVoiceRegistry();
  _pocketBackendPlanPromise = null;
  _pocketBackendOptimizationPromise = null;
  _setNeuralState('idle');
  loadedVoiceEngine = null;
  if (hadWorkers) {
    // Drop the references above out of scope for the collector, then give the
    // terminated worker's heap a real chance to be reclaimed before anything
    // allocates again. Published so a caller that did not await this still
    // cannot race a fresh engine load past it.
    _pocketResetPromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const settleMs = window.isPocketDeviceMemorySafeMode?.() !== false ? 250 : 0;
      if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
    })().finally(() => { _pocketResetPromise = null; });
    await _pocketResetPromise;
  }
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
    _resetPocketVoiceRegistry();
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
  _resetPocketVoiceRegistry();
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
      // Questions and emphatic delivery legitimately raise median pitch ~3-5
      // semitones (26-42% deviation), so the old 0.28 (~4 semitone) FATAL cut
      // rejected ordinary dialogue lines — e.g. a two-question paragraph — which,
      // with deterministic seeding, then failed every identical retry and was
      // permanently skipped, leaving a gap in the story. Only an EXTREME shift
      // (>0.50, ~7 semitones) reliably indicates a genuine squeaky/garbled
      // artifact, so reserve fatal rejection for that; treat the in-between band
      // as a soft warning (accepted, not baseline-fed). Gibberish prevention
      // leans on the proactive worker recycle, not this detector.
      if (deviation > 0.50) {
        fatal = true;
        reasons.push('pitch shift'); // extreme (~7+ semitones) — genuine artifact
      } else if (deviation > 0.30) {
        reasons.push('pitch drift'); // soft: natural question/emphasis range
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

  // Foreground zombie-worker detection stays fast while still scaling
  // adaptively for longer paragraphs on mobile WASM so long multi-sentence
  // paragraphs (80–140s on phone CPUs) are not prematurely killed by a static ceiling.
  // A backgrounded/locked session gets a patient budget (10 min): synthesis
  // can legitimately run several times slower once the OS deprioritizes a
  // backgrounded tab/PWA. The budget is re-read live on every poll so a session
  // that backgrounds mid-generation gets the patient budget.
  const FOREGROUND_TIMEOUT_MS = 60000;
  const BACKGROUND_TIMEOUT_MS = 600000;
  const POLL_MS = 5000;
  const _words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const _chars = String(text || '').trim().length;
  const _isMobile = isMobileLikePlatform(navigator.userAgent || '');
  const _estAudioSec = Math.max(4, Math.max(_words * 0.45, _chars / 16));
  // Adaptive foreground ceiling: 60s base, scaling up to 240s for long paragraphs
  const adaptiveForegroundMs = Math.max(
    FOREGROUND_TIMEOUT_MS,
    Math.min(240000, Math.round(_estAudioSec * (_isMobile ? 3600 : 2200)) + 30000)
  );
  const currentTimeoutMs = () => (typeof document !== 'undefined' && document.hidden)
    ? BACKGROUND_TIMEOUT_MS : adaptiveForegroundMs;
  let timerObj = null;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        let start = Date.now();
        let lastTick = start;
        const check = () => {
          const now = Date.now();
          const sinceLastTick = now - lastTick;
          lastTick = now;
          // A tick firing much later than its poll interval means the JS event
          // loop itself was suspended (OS/tab freeze), not that the worker is
          // slow — adjust start time so suspended time is not counted against
          // the budget.
          if (sinceLastTick > POLL_MS + 10000) {
            console.log('[Timeout] System sleep or background suspension detected. Rescheduling worker timeout.');
            start += (sinceLastTick - POLL_MS);
            timerObj = setTimeout(check, POLL_MS);
            return;
          }
          const elapsed = now - start;
          const timeoutMs = currentTimeoutMs();
          if (elapsed >= timeoutMs) {
            try {
              workerObj?.worker?.postMessage({ type: 'cancel_generation', id });
            } catch (_) {}
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

function _recordPocketTtsCalibrationFromTelemetry(telemetry) {
  if (_pocketTtsCalibrationRecorded) return;
  recordPocketTtsCalibration(localStorage, {
    initializationSucceeded: true,
    initializationMs: _pocketInitializationMs,
    realTimeFactor: telemetry?.realTimeFactor,
    interrupted: false,
  });
  _pocketTtsCalibrationRecorded = true;
}

// Voice registration and backend calibration are POCKET-ONLY, and running them
// for another engine is not merely wasteful -- it is fatal.
//
// ensurePocketVoiceLoaded() resolves whatever it is given through
// resolvePocketAssetVoiceId(), which answers donald_malone_neutral for any id
// it does not recognise. A Kokoro voice ('af_heart') is exactly such an id, so
// every Kokoro paragraph downloaded a ~5-6 MB Pocket .safetensors and posted
// register_precompiled_voice to a worker whose onmessage handles four types and
// not that one. No ack ever came, the 60s registration timeout rejected, and
// the caller saw a fatal quality failure -- twice, because generateChunk takes
// one quality retry. Playback then stopped with "The neural engine couldn't
// produce audio" and caching with "Neural engine failed".
//
// Kokoro fetches its own voices/{id}.bin inside generate(), so the correct
// preparation for it is none: hand the worker the id the route already holds.
// This is the same 'pocket'-means-neural slip the engine gates fixed, one layer
// down, and it is gated on route.engine rather than a fresh
// _resolveActiveEngine() call so the decision matches the route being run.
async function _generatePocketAttempt(workerObj, text, route, retryLevel = 0, handlers = {}) {
  let workerVoice = route.voiceId;
  try {
    if (route.engine === 'pocket') {
      workerVoice = await ensurePocketVoiceLoaded(route.voiceId);
      await _ensurePocketBackendOptimizedForVoice(workerVoice);
    }
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

// A reset in flight. _resetPocketEngineForBackend clears state synchronously but
// then waits for the terminated worker's heap to be reclaimed; anything that
// loads an engine must wait for that, or an engine switch followed immediately
// by Play allocates a second full model set on top of the first.
let _pocketResetPromise = null;
let _pocketRecyclePromise = null;
async function _maybeRecyclePocketEngine() {
  if (_pocketRecyclePromise) {
    await _pocketRecyclePromise;
    return true;
  }
  // POCKET ONLY. The drift this exists to clear is autoregressive: ONNX Runtime
  // state accumulating across frames until the voice starts hallucinating,
  // reported at roughly paragraph 25-30. Kokoro is one forward pass with no KV
  // cache -- which is exactly why the ORT arena guard Pocket needs was measured
  // as a no-op there (592 vs 594 MB, 356.6 vs 354.7 MB) and left out -- and its
  // memory is flat from paragraph 5 to 30. There is no accumulating state for a
  // recycle to clear.
  //
  // Running it anyway cost every Kokoro device a full teardown, ORT re-import
  // and 86 MB session rebuild once per 20 paragraphs, for nothing. It only
  // started happening when Kokoro could first synthesize past its opening
  // paragraph; before that no session ever survived to 20.
  if (_resolveActiveEngine() !== 'pocket') return false;
  window._pocketParagraphCount = (window._pocketParagraphCount || 0) + 1;
  const recycleEvery = _pocketBackendRuntime?.selectedBackend === 'webgpu' ? 60 : 20;
  if (window._pocketParagraphCount < recycleEvery) return false;
  // A second cache worker or live request may still own the shared engine.
  // Leave the threshold armed and let the next idle request perform the reset.
  if ((window._pocketActiveSynthesis || 0) > 0) return false;

  window._pocketParagraphCount = 0;
  _pocketRecyclePromise = (async () => {
    window.Diagnostics?.log('INFO', 'Recycling Pocket TTS worker session to maintain pristine audio quality', {
      every: recycleEvery,
      backend: _pocketBackendRuntime?.selectedBackend,
    });
    await _resetPocketEngineForBackend();
    await _loadPocketEngine();
  })().catch((error) => {
    window.Diagnostics?.log('WARN', 'Pocket TTS worker recycle deferred after reset failure', {
      reason: error?.message || String(error),
    });
  }).finally(() => {
    _pocketRecyclePromise = null;
  });
  await _pocketRecyclePromise;
  return true;
}

// Live generator with one quality-guard retry around Pocket output.
window.generateChunk = async function(text, voice) {
  if (!text || text.trim() === '') return null;
  window._lastPocketQualityFailure = null;
  _cancelWorkerIdleRelease();
  const engine = _resolveActiveEngine();
  if (!_isNeuralEngine(engine)) return null;

  const ready = await _loadPocketEngine();
  if (!ready || ttsWorkers.length === 0) {
    console.warn('Neural engine unavailable - skipping generation.');
    return null;
  }

  // Refresh worker session periodically to clear ONNX Runtime internal state
  // accumulation and prevent voice hallucinations. The recycle does a FULL
  // engine reload, so its cost is backend-dependent, and so is the threshold:
  //  - WASM (incl. iOS): the reload re-inits sessions from cached model bytes
  //    (cheap), and this is where the reported long-form degradation onset
  //    (~15-20 min of listening, ~paragraph 25-30) appeared — so recycle often
  //    (every 20) to stay ahead of onset.
  //  - WebGPU: the reload re-creates the GPU session and re-fetches the ORT
  //    runtime — expensive and visible ("downloading models again"), and over a
  //    long story the reload churn dominates caching time. Recycle far less
  //    often (every 60); the WebGPU EP doesn't show the same WASM-state drift.
  await _maybeRecyclePocketEngine();

  window._pocketActiveSynthesis = (window._pocketActiveSynthesis || 0) + 1;
  const canResetSharedEngine = () => (window._pocketActiveSynthesis || 0) <= 1;
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
    const qualityRetryNeeded = shouldRetryPocketQuality(first.quality);
    const allowQualityRetry = qualityRetryNeeded && canResetSharedEngine();
    if (allowQualityRetry) {
      // Re-render once with clean worker state at lower temperature.
      const throughputRetry = _isPocketThroughputCache();
      _logPocketQuality('WARN', throughputRetry
        ? 'Pocket synth quality guard retrying failed cache paragraph'
        : 'Pocket synth quality guard retrying with clean worker session', first, { retryUsed: false });
      const isTimeoutFailure = (first.quality?.reasons || []).some((r) => /timeout/i.test(String(r || '')));
      if (!throughputRetry || isTimeoutFailure) {
        window._pocketParagraphCount = 0;
        try {
          await _resetPocketEngineForBackend();
          await _loadPocketEngine();
        } catch (_) {}
      }
      const retry = await _generatePocketAttempt(null, text, route, 1);
      retryUsed = true;
      // A paragraph that needed a re-render is drift evidence regardless of
      // whether the second pass succeeded.
      _recordProsodyOutcome(false);
      if (!retry.quality.fatal) {
        accepted = retry;
      } else {
        _logPocketQuality('ERROR', 'Pocket synth quality guard rejected both attempts', retry, {
          retryUsed: true,
          firstReason: first.quality.reasons.join(', '),
        });
        window._lastPocketQualityFailure = {
          text,
          voice,
          reason: retry.quality.reasons.join(', '),
        };
        return null;
      }
    } else if (first.quality.fatal) {
      const reason = _isPocketThroughputCache()
        ? 'no retry in throughput mode'
        : 'shared engine is serving another synthesis';
      _logPocketQuality('ERROR', `Pocket synth quality guard rejected paragraph (${reason})`, first, { retryUsed: false });
      _recordProsodyOutcome(false);
      window._lastPocketQualityFailure = {
        text,
        voice,
        reason: first.quality.reasons.join(', '),
      };
      return null;
    } else if (!first.quality.ok) {
      _logPocketQuality('WARN', 'Pocket synth accepted with a soft quality warning', first, { retryUsed: false });
      _recordProsodyOutcome(false);
    } else {
      _recordProsodyOutcome(true);
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
    _recordPocketTtsCalibrationFromTelemetry(synthTelemetry);
    if (window.Diagnostics) {
      window.Diagnostics.log(_ms > 8000 ? 'WARN' : 'INFO',
        `Pocket synth ${_ms}ms${retryUsed ? ' (quality retry)' : ''}${synthTelemetry.throughputMode ? ' (cache throughput)' : ''}`,
        synthTelemetry);
    }

    if (!accepted.result || !accepted.result.audio || accepted.result.audio.length === 0) return null;
    const wavStartedAt = performance.now();
    const wav = _encodeWAV(accepted.result.audio, accepted.result.sampleRate || 24000, {
      fadeInSec: _onsetFadeSecFor(route.voiceId),
    });
    window.Diagnostics?.log('INFO', 'Pocket WAV encoded', { wavEncodingMs: Math.round(performance.now() - wavStartedAt), bytes: wav.size });
    return wav;
  } catch (e) {
    console.error('Pocket worker inference failed:', e);
    if (canResetSharedEngine()) {
      try { await _resetPocketEngineForBackend(); } catch (_) {}
    }
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
  const engine = _resolveActiveEngine();
  if (!_isNeuralEngine(engine)) return null;
  const ready = await _loadPocketEngine();
  if (!ready || ttsWorkers.length === 0) return null;

  window._pocketActiveSynthesis = (window._pocketActiveSynthesis || 0) + 1;
  window.setExperienceSuppressed?.(true, 'pocket-synthesis');
  window.setCinematicSynthesisSuppressed?.(true);
  try {
    const startedAt = performance.now();
    const route = _resolvePocketRoute(engine, voice, text);
    const attempt = await _generatePocketAttempt(null, text, route, 0, { onSegment });
    if (attempt.quality.fatal || !attempt.result?.audio?.length) {
      _logPocketQuality('ERROR', 'Pocket streamed synthesis failed quality validation', attempt, { streamed: true });
      return null;
    }
    const streamTelemetry = {
      ms: Math.round(performance.now() - startedAt),
      voice: route.voiceId,
      emotion: route.emotion,
      streamed: true,
      ...(attempt.result.telemetry || {}),
      ...(attempt.quality.stats || {}),
    };
    window._lastPocketSynthTelemetry = streamTelemetry;
    _recordPocketTtsCalibrationFromTelemetry(streamTelemetry);
    window.Diagnostics?.log('INFO', 'Pocket streamed synthesis complete', streamTelemetry);
    const wavStartedAt = performance.now();
    const wav = _encodeWAV(attempt.result.audio, attempt.result.sampleRate || 24000, {
      fadeInSec: _onsetFadeSecFor(route.voiceId),
    });
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
    if (!_isNeuralEngine(engine) || ready) return;
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
    window.pocketNotify?.('No story loaded yet — open one from your library first.', 4000);
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

  // Keep a full twenty-successful-paragraph runway. This check is deliberately
  // independent of the worker's active/paused state: a failed or paused cache
  // job must not turn a partial runway into an accidental playback unlock.
  if (!window.isPlaying && window.BufferManager?.isPlaybackReadyForStory
      && !window.BufferManager.isPlaybackReadyForStory(window.currentStory)) {
    const readyCount = window.BufferManager.getReadyCount?.() || 0;
    const total = window.BufferManager.totalToCache || 0;
    const minReady = window.getPocketPlaybackReadyCount?.(total) ?? Math.min(20, total);
    if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_explaining');
    if (typeof window.virtueSpeak === 'function') {
      window.virtueSpeak(`Still securing the text! ${readyCount} of ${minReady} paragraphs are ready.`, 4500, true);
    } else {
      window.pocketNotify?.(`Still caching — ${readyCount} of ${minReady} paragraphs ready.`, 4000);
    }
    return;
  }

  let resumePausedPocketAudio = false;
  if (!window.isPlaying && _isNeuralEngine(_resolveActiveEngine())) {
    // Run synchronously in the tap before any model/network await. If isolation
    // requires a navigation, the resume path asks for one fresh tap afterward.
    preparePocketMobileMediaSession();
    if (window.requestPocketNarrationIsolation?.('playback', 'Normal')) return;
    resumePausedPocketAudio = _canResumePausedPocketAudio();
  }

  window.isPlaying = !window.isPlaying;

  if (window.isPlaying) {
    _updatePlayButton(true);
    if (typeof window._setControlsLocked === 'function') window._setControlsLocked(true);
    startBgKeepAlive();
    _signalColdStartOnce();
    if (!resumePausedPocketAudio) playCurrentParagraph();
    else _resumePausedPocketAudio();
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
  if (!story || !story.chapters) {
    pausePlayback();
    return;
  }
  if (typeof window._updateMediaSessionMetadata === 'function') window._updateMediaSessionMetadata();

  const chap = story.chapters[window.currentChapterIndex];
  if (!chap || !chap.paragraphs) {
    pausePlayback();
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
  _syncProsodyDriftToPosition();

  const engine = _resolveActiveEngine();
  const defaultVoice = _defaultVoiceForEngine(engine);
  const voice = document.getElementById('voice-selector')?.value || defaultVoice;

  try {
    // THE playback dispatch. Testing for the literal 'pocket' sent every Kokoro
    // paragraph down the Web Speech branch — the engine was loaded and the OS
    // voice spoke instead, which is what "Kokoro is using device voices" was.
    if (_isNeuralEngine(engine)) {
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

let _premiumAudio = window.__pocketMobileMediaElement || null;
let _audioCtx = window.__pocketMobileAudioContext || null;
let _pocketWorkletModulePromise = null;
let _activePocketStream = null;

// Suspend the AudioContext once nothing is streaming through it. This is a
// desktop-only concern by construction: _preferDirectMobileMediaPlayback()
// routes every phone and tablet to a bare HTMLAudioElement (iOS suspends a Web
// Audio graph on screen lock), so _audioCtx is never created there. On desktop
// a running context keeps the audio thread alive through every pause, which is
// real idle power for no benefit. The context object is retained rather than
// closed — _createPocketPcmStream and the keep-alive path both resume it, and
// a closed context cannot be revived.
function _suspendIdleAudioContext() {
  if (!_audioCtx || _activePocketStream || window.isPlaying) return;
  if (_audioCtx.state !== 'running') return;
  Promise.resolve(_audioCtx.suspend()).catch(() => {});
}

async function _createPocketPcmStream(onEnded) {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (!_audioCtx.audioWorklet) throw new Error('AudioWorklet is unavailable.');
  if (!_pocketWorkletModulePromise) {
    _pocketWorkletModulePromise = _audioCtx.audioWorklet.addModule('assets/js/pocket_pcm_worklet.js?v=pcm-v1');
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
          playbackRate: getEffectivePlaybackRate(),
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
  // Gates the AudioWorklet streaming path only. Desktop can stream PCM through
  // an AudioContext to cut first-audio latency; mobile must not, because iOS
  // suspends an AudioContext on screen lock while a bare media element keeps
  // playing under OS control. Returning true means "play whole paragraphs from
  // the media element", which is also the fallback whenever streaming fails.
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
    || (navigator.maxTouchPoints || 0) > 1;
}

// The narration media element is no longer routed through an AudioContext on
// any platform. That graph existed to host the emotion-boundary gain ramp and
// to duplicate channel 0 across L/R, but the ramp now lives in the encoded
// samples and the encoder emits mono (numChannels = 1), which browsers already
// play to both outputs. Removing it means desktop and mobile share one playback
// path, so what is exercised on desktop is what ships to phones -- and nothing
// holds a MediaElementSource that iOS would suspend on screen lock.
//
// _audioCtx itself is retained: the desktop AudioWorklet streaming path
// (_startPocketStream) still needs it.

// ── Emotion-boundary onset fade ──────────────────────────────────────────────
// When consecutive paragraphs use different voice conditioning (emotion
// switch), the timbre steps at the chunk boundary. A short onset ramp on the
// incoming chunk softens it so residual differences the anchored pack doesn't
// remove read as delivery, not a speaker change.
//
// The ramp is now baked into the samples at encode time (see _encodeWAV) rather
// than applied by a Web Audio gain node, because the gain path was unreachable
// on every phone. Tracking therefore moves from "last played" to "last
// synthesized": paragraphs are synthesized in reading order by the live player,
// the lookahead and the background cacher alike, so the preceding synthesis is
// the preceding paragraph.
//
// TRADEOFF: the ramp is part of the cached bytes, so a paragraph is no longer a
// pure function of (text, voice) -- one cached during a switch keeps its ramp if
// later replayed after the same emotion. That is inaudible in practice, since
// every paragraph already starts from silence after a paragraph pause, and it
// buys a fade that actually works on the platform most users are on.
let _lastSynthesizedVoiceAsset = null;
const EMOTION_FADE_SEC = 0.12;

function _onsetFadeSecFor(voiceAsset) {
  const switched = _lastSynthesizedVoiceAsset !== null && voiceAsset !== _lastSynthesizedVoiceAsset;
  _lastSynthesizedVoiceAsset = voiceAsset;
  return switched ? EMOTION_FADE_SEC : 0;
}


// ── Playback lookahead prefetch ──────────────────────────────────────────────
// Keep a small runway of upcoming paragraphs synthesized ahead of the playback
// cursor so a screen lock — which suspends the TTS worker on iOS — never lands
// on an uncached paragraph and silently stalls narration. This runs only on
// idle worker time while a paragraph is already playing, always yields to live
// synthesis (which owns the worker), and no-ops when a full background cache
// job is already filling ahead. It renders in the same (non-throughput) mode
// live playback reads first, so a prefetched paragraph is an instant cache hit
// when the cursor reaches it — no CPU needed, which is exactly what a locked
// iOS screen denies. Con (as flagged to the user): more eager synthesis =
// more battery while playing uncached stretches.
const POCKET_PLAYBACK_LOOKAHEAD = 8;
let _lookaheadRunning = false;
let _lastAudioClockPumpAt = 0;

export function _onAudioClockPump() {
  if (!window.isPlaying || !_isNeuralEngine(_resolveActiveEngine())) return;
  const now = Date.now();
  if (now - _lastAudioClockPumpAt < 2000) return;
  _lastAudioClockPumpAt = now;
  _ensurePlaybackLookahead();
}
window._onAudioClockPump = _onAudioClockPump;

function _peekNextIndices(c, p) {
  const story = window.currentStory;
  if (!story?.chapters?.[c]?.paragraphs) return null;
  if (p + 1 < story.chapters[c].paragraphs.length) return { c, p: p + 1 };
  if (c + 1 < story.chapters.length && story.chapters[c + 1]?.paragraphs?.length) return { c: c + 1, p: 0 };
  return null;
}

// Live playback must always win the single worker; bail the instant it needs it.
function _lookaheadShouldYield() {
  return !window.isPlaying || window._pocketLiveSynthActive === true || window._playPriority === true;
}

async function _ensurePlaybackLookahead() {
  if (_lookaheadRunning) return;
  if (!_isNeuralEngine(_resolveActiveEngine())) return;
  if (window.BufferManager?.isActive) return;   // the full cacher already fills ahead of the cursor
  if (_lookaheadShouldYield()) return;
  const story = window.currentStory;
  if (!story?.chapters) return;
  _lookaheadRunning = true;
  try {
    // Must be the RESOLVED engine, not the literal. Pinned to 'pocket' this
    // rewrote every Kokoro voice into a Pocket emotion asset, read and wrote
    // cache keys under engine 'pocket' with the Pocket prosody tag while
    // playback reads 'kokoro' with an empty tag -- so every slot was a
    // guaranteed miss, and each miss then committed the worker to a synthesis
    // that could not succeed.
    const engine = _resolveActiveEngine();
    const title = story.title;
    const storyRef = story.storyKey || window.getStoryStableKey?.(story) || title;
    const selVoice = document.getElementById('voice-selector')?.value || _defaultVoiceForEngine(engine);
    let c = window.currentChapterIndex, p = window.currentParagraphIndex;
    for (let i = 0; i < POCKET_PLAYBACK_LOOKAHEAD; i++) {
      if (_lookaheadShouldYield()) break;
      const nxt = _peekNextIndices(c, p);
      if (!nxt) break;              // end of story
      c = nxt.c; p = nxt.p;
      const text = story.chapters[c]?.paragraphs?.[p];
      if (!text || text.trim() === '' || _isMetaParagraph(text)) continue;
      const cleanVoice = resolveVoiceWithSentiment(engine, selVoice, text, { storyTitle: title, chapIdx: c, paraIdx: p });
      // Already rendered under either render-mode tag? Then this slot is safe.
      let cached = false;
      for (const tag of _prosodyCacheTagVariants(engine)) {
        if (await getAudioChunk(storyRef, c, p, engine, cleanVoice + tag, text)) { cached = true; break; }
      }
      if (cached) continue;
      if (_lookaheadShouldYield()) break;   // re-check right before committing the worker
      const audioBlob = await window.generateChunk(text, cleanVoice);
      if (audioBlob) {
        const cacheVoice = cleanVoice + (typeof _prosodyCacheTag === 'function' ? _prosodyCacheTag(engine) : '');
        await saveAudioChunk(storyRef, c, p, engine, cacheVoice, audioBlob, false, text).catch(() => {});
        window.Diagnostics?.log?.('INFO', 'Playback lookahead cached paragraph ahead of the cursor', { chapIdx: c, paraIdx: p });
      }
    }
  } catch (e) {
    window.Diagnostics?.log?.('WARN', 'Playback lookahead prefetch skipped', { error: e?.message || String(e) });
  } finally {
    _lookaheadRunning = false;
  }
}
window._ensurePlaybackLookahead = _ensurePlaybackLookahead;

async function _playGeneratedAudio(text, title, chapIdx, paraIdx, voice) {
  const engine = _resolveActiveEngine();
  const storyRef = window.currentStory?.storyKey || window.getStoryStableKey?.(window.currentStory) || title;
  // Pass the chunk position so the deterministic chapter emotion plan is used;
  // the background cacher (buffer_manager.js) passes the same ctx, so both
  // resolve the identical emotion → identical voice asset → identical cache key.
  const cleanVoice = resolveVoiceWithSentiment(engine, voice, text, { storyTitle: title, chapIdx, paraIdx });
  // Try every render-mode cache key: the background cacher stores under the
  // throughput tag while live playback computes the non-throughput tag, and
  // both are valid renders of this paragraph. Exact-key misses here used to
  // re-synthesize audio the cache job had already stored.
  const cacheVoice = cleanVoice + (typeof _prosodyCacheTag === 'function' ? _prosodyCacheTag(engine) : '');

  const _playT0 = performance.now();
  let _cacheHit = true;

  // A paragraph handed over by the preloader needs no storage round-trip, which
  // is the whole point: with the screen locked, the `ended` window is too short
  // to reliably complete an IndexedDB read before play() must be called.
  let audioBlob = _takePreloadedParagraph(storyRef, chapIdx, paraIdx, cleanVoice);
  if (!audioBlob) {
    for (const tag of _prosodyCacheTagVariants(engine)) {
      audioBlob = await getAudioChunk(storyRef, chapIdx, paraIdx, engine, cleanVoice + tag, text);
      if (!audioBlob && storyRef !== title) {
        audioBlob = await getAudioChunk(title, chapIdx, paraIdx, engine, cleanVoice + tag, text);
        if (audioBlob) saveAudioChunk(storyRef, chapIdx, paraIdx, engine, cleanVoice + tag, audioBlob, false, text).catch(() => {});
      }
      if (audioBlob) break;
    }
  }
  if (!(audioBlob instanceof Blob) || audioBlob.size < 100) audioBlob = null;
  let streamedPlayback = false;

  if (!audioBlob) {
    _cacheHit = false;
    window._playPriority = true;
    window._pocketLiveSynthActive = true;

    // Show that it's generating audio, not frozen
    if (typeof _setPlayBtnLoading === 'function') _setPlayBtnLoading(true, '🧠 Synthesizing...');

    let stream = null;
    try {
      if (engine === 'pocket') await _ensurePocketBackendOptimizedForVoice(cleanVoice);
      // Segment streaming is a Pocket capability: it is autoregressive, so it
      // can hand back audio while it is still generating. Kokoro is one forward
      // pass and returns the whole utterance at once, so a stream would collect
      // zero segments and be torn down again -- an AudioWorklet built and
      // discarded on every paragraph for nothing.
      if (engine === 'pocket' && !_preferDirectMobileMediaPlayback()) {
        try {
          stream = await _createPocketPcmStream(() => {
            if (window.isPlaying) _handleParagraphEnd();
          });
        } catch (streamError) {
          window.Diagnostics?.log('WARN', 'Pocket streaming unavailable; using full-paragraph playback', { error: streamError?.message || String(streamError) });
        }
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
      saveAudioChunk(storyRef, chapIdx, paraIdx, engine, cacheVoice, audioBlob, false, text)
        .then(() => window.Diagnostics?.log('INFO', 'Pocket playback cache write', {
          indexedDbWriteMs: Math.round(performance.now() - writeStartedAt),
          bytes: audioBlob.size,
        }))
        .catch(console.error);
    }
    if (streamedPlayback) {
      // Streamed paragraph is playing and the worker is now idle — build the
      // lookahead runway (fire-and-forget; yields at once if not safe).
      if (window.isPlaying) _ensurePlaybackLookahead();
      return;
    }
  }

  if (!audioBlob || !(audioBlob instanceof Blob) || audioBlob.size < 100) {
    // The engine failed to LOAD rather than failing to render this paragraph:
    // _fallbackToWebSpeech has already announced the device voice, so actually
    // use it. Stopping here was the difference between narration that continues
    // less well and total silence one paragraph into the story.
    if (window._pocketNeuralEngineUnavailable === true && window.isPlaying) {
      await _playWebSpeech(text);
      return;
    }
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
      // Direct HTMLAudioElement output on every platform: iOS suspends a Web
      // Audio graph after the screen locks even while a bare media element
      // stays eligible for OS-controlled playback.
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
  window.currentAudio.loop = false;
  window.currentAudio.volume = 1;
  if (window.currentAudio.dataset) delete window.currentAudio.dataset.pocketUnlock;
  if (window.currentAudio.dataset) {
    window.currentAudio.dataset.pocketNarration = '1';
    window.currentAudio.dataset.pocketStoryRef = String(storyRef);
    window.currentAudio.dataset.pocketChapter = String(chapIdx);
    window.currentAudio.dataset.pocketParagraph = String(paraIdx);
  }
  window.currentAudio.playbackRate = getEffectivePlaybackRate();
  window.currentAudio.load();

  window.currentAudio.onended = () => {
    if (window.currentAudio && window.currentAudio.error) {
      console.warn('Audio element ended with error:', window.currentAudio.error);
      URL.revokeObjectURL(audioUrl);
      pausePlayback();
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
    // Only the desktop AudioWorklet streaming path owns an AudioContext now, and
    // this element does not route through it. Resume it anyway when one exists
    // and the browser suspended it, so a backgrounded tab does not strand a
    // streamed segment. resume() on a running context is a harmless no-op, and
    // on mobile there is no context to resume.
    if (_audioCtx && _audioCtx.state === 'suspended') {
      try { await _audioCtx.resume(); } catch (e) {}
    }
    await window.currentAudio.play();
    // Resolve the next paragraph now, while this one is playing and the tab
    // still has normal execution. At the boundary it is handed over
    // synchronously, so a locked screen never has to complete a storage read
    // inside the brief post-`ended` window.
    _preloadNextParagraphAudio();
    // Play-start latency telemetry — flags the "stuck play button" class of
    // issues (cache miss forcing an on-the-fly synth) in diagnostic files.
    if (window.Diagnostics) {
      const _ms = Math.round(performance.now() - _playT0);
      window.Diagnostics.log(_ms > 3000 ? 'WARN' : 'INFO',
                             `Play start ${_ms}ms (${_cacheHit ? 'cache hit' : 'synthesized'})`,
                             { ms: _ms, cacheHit: _cacheHit });
    }
    // This paragraph is now playing on the audio element and the worker is
    // idle — synthesize the next few ahead so a screen lock can't strand us on
    // an uncached paragraph. Fire-and-forget; it yields at once if not safe.
    if (window.isPlaying) _ensurePlaybackLookahead();
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
    window.pocketNotify?.('This browser has no built-in speech engine. Switch to a Pocket voice in Settings.', 6000);
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
  utterance.rate = getEffectivePlaybackRate();
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
  _suspendIdleAudioContext();

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

function _canResumePausedPocketAudio() {
  const audio = window.currentAudio;
  if (!(audio instanceof HTMLAudioElement) || !audio.paused || audio.ended) return false;
  if (audio.dataset?.pocketNarration !== '1' || !audio.src) return false;
  const story = window.currentStory;
  const storyRef = story?.storyKey || window.getStoryStableKey?.(story) || story?.title;
  return audio.dataset.pocketStoryRef === String(storyRef)
    && Number(audio.dataset.pocketChapter) === Number(window.currentChapterIndex)
    && Number(audio.dataset.pocketParagraph) === Number(window.currentParagraphIndex);
}

async function _resumePausedPocketAudio() {
  try {
    await window.currentAudio.play();
    _updatePlayButton(true);
  } catch (error) {
    console.warn('Could not resume paused narration; reloading the paragraph.', error);
    _releaseCurrentAudio();
    if (window.isPlaying) playCurrentParagraph();
  }
}

// Drop our reference to the current audio, first revoking the reusable element's
// blob URL if it has one. Manual skip/seek pauses the element and reloads a new
// source, so the normal end-of-paragraph revoke (in onended) never fires for the
// old clip — without this each jump leaks one ObjectURL. Also nulls WebSpeech
// utterances so _playWebSpeech speaks the new text instead of resuming the old.
function _releaseCurrentAudio() {
  // Any manual jump invalidates the preloaded next paragraph. The key check in
  // _takePreloadedParagraph would already refuse a stale entry, so this is about
  // not holding a decoded blob for audio the reader has skipped past.
  _discardParagraphPreload();
  _activePocketStream?.stop?.();
  _activePocketStream = null;
  const a = window.currentAudio;
  if (a instanceof HTMLAudioElement && typeof a.src === 'string' && a.src.startsWith('blob:')) {
    try { URL.revokeObjectURL(a.src); } catch (e) {}
  }
  if (a instanceof HTMLAudioElement && a.dataset) {
    delete a.dataset.pocketNarration;
    delete a.dataset.pocketStoryRef;
    delete a.dataset.pocketChapter;
    delete a.dataset.pocketParagraph;
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

// ── Next-paragraph preload (locked-screen playback continuity) ───────────────
// With the screen off, the only JS a backgrounded tab reliably gets is the
// short window after a media event. Resolving the next paragraph inside that
// window means an IndexedDB open + read + blob decode before play() can even be
// called, and if the window closes first, narration simply stops — which is why
// playback died after one paragraph once the phone locked.
//
// So the next paragraph is resolved *while the current one is still playing*,
// when there is plenty of time, and handed over synchronously at the boundary.
// Only already-cached audio is preloaded; synthesis stays the lookahead's job.
let _paragraphPreload = null;   // { key, blob }
let _preloadInFlight = false;

const _preloadKey = (storyRef, chapIdx, paraIdx, voice) => `${storyRef}::${chapIdx}::${paraIdx}::${voice}`;

function _takePreloadedParagraph(storyRef, chapIdx, paraIdx, voice) {
  if (!_paragraphPreload) return null;
  if (_paragraphPreload.key !== _preloadKey(storyRef, chapIdx, paraIdx, voice)) return null;
  const blob = _paragraphPreload.blob;
  _paragraphPreload = null;
  return blob instanceof Blob && blob.size >= 100 ? blob : null;
}

function _discardParagraphPreload() {
  _paragraphPreload = null;
}
window._discardParagraphPreload = _discardParagraphPreload;

async function _preloadNextParagraphAudio() {
  if (_preloadInFlight || !window.isPlaying) return;
  const story = window.currentStory;
  if (!story?.chapters) return;
  const next = _peekNextIndices(window.currentChapterIndex, window.currentParagraphIndex);
  if (!next) return;

  const engine = _resolveActiveEngine();
  if (!_isNeuralEngine(engine)) return;
  const text = story.chapters[next.c]?.paragraphs?.[next.p];
  if (!text || !text.trim() || _isMetaParagraph(text)) return;

  const title = story.title;
  const storyRef = story.storyKey || window.getStoryStableKey?.(story) || title;
  const selVoice = document.getElementById('voice-selector')?.value || POCKET_DEFAULT_VOICE;
  const cleanVoice = resolveVoiceWithSentiment(engine, selVoice, text, {
    storyTitle: title, chapIdx: next.c, paraIdx: next.p,
  });
  const key = _preloadKey(storyRef, next.c, next.p, cleanVoice);
  if (_paragraphPreload?.key === key) return;

  _preloadInFlight = true;
  try {
    for (const tag of _prosodyCacheTagVariants(engine)) {
      const blob = await getAudioChunk(storyRef, next.c, next.p, engine, cleanVoice + tag, text)
        || (storyRef !== title
          ? await getAudioChunk(title, next.c, next.p, engine, cleanVoice + tag, text)
          : null);
      if (blob instanceof Blob && blob.size >= 100) {
        // Indices may have moved while awaiting (a skip, or the paragraph ended
        // early); a stale entry is simply never claimed, and the key check in
        // _takePreloadedParagraph makes that safe rather than wrong.
        _paragraphPreload = { key, blob };
        return;
      }
    }
  } catch (error) {
    window.Diagnostics?.log?.('WARN', 'Next-paragraph preload skipped', { error: error?.message || String(error) });
  } finally {
    _preloadInFlight = false;
  }
}
window._preloadNextParagraphAudio = _preloadNextParagraphAudio;

// Read-only view of the preload slot. Background playback fails silently by
// nature — the phone is in a pocket, nobody is watching a console — so being
// able to ask "is the next paragraph actually staged?" is the difference
// between diagnosing a stall and guessing at it.
window.inspectPocketPreload = () => (_paragraphPreload
  ? { staged: true, key: _paragraphPreload.key, bytes: _paragraphPreload.blob?.size ?? 0 }
  : { staged: false });

function _handleParagraphEnd() {
  // Ordering here is load-bearing for locked-screen playback. This runs inside
  // the `ended` media event, which is the only JS window a backgrounded iOS tab
  // reliably gets — and play() is far more likely to be honoured early in it.
  // Statistics, streak tracking and the achievement sweep used to run FIRST,
  // spending that window on bookkeeping before the next paragraph was even
  // requested. Capture what the stats need, start the audio, then account.
  let pendingWords = 0;
  const chap = window.currentStory?.chapters?.[window.currentChapterIndex];
  if (chap?.paragraphs) {
    const text = chap.paragraphs[window.currentParagraphIndex] || '';
    pendingWords = text.split(/\s+/).filter(Boolean).length;
  }

  const canAdvance = _advanceIndices();
  if (canAdvance) {
    playCurrentParagraph();
  }

  // Everything below is bookkeeping — safe to run after playback is under way.
  if (pendingWords && window.userProfile?.stats) {
    if (typeof window.incrementDeviceStat === 'function') window.incrementDeviceStat('totalWords', pendingWords);
    else {
      window.userProfile.stats.totalWords = (window.userProfile.stats.totalWords || 0) + pendingWords;
      window.userProfile.stats.hoursListened = window.userProfile.stats.totalWords / 9000;
    }
    // Shared daily tracking (streak / distinct days / first day) + the
    // achievement check. Listening counts as activity for the day too.
    if (typeof window.recordDailyActivity === 'function') window.recordDailyActivity();
  }

  _checkpointPlaybackProgress(!canAdvance);
  if (!canAdvance) _finishStory();
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
  _updatePlayButton(false);
  if (typeof window._setControlsLocked === 'function') window._setControlsLocked(false);
  _activePocketStream?.stop?.();
  _activePocketStream = null;
  _suspendIdleAudioContext();
  stopBgKeepAlive();
  _scheduleWorkerIdleRelease();

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
      // Guarded like the forward branch above. A chapter without a paragraphs
      // array threw a TypeError here and killed the whole skip -- reachable
      // because curated .json stories are returned verbatim and never pass
      // through normalizeStoryChapters, so their shape is not guaranteed.
      p += story.chapters[c]?.paragraphs?.length || 0;
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
    _updatePlayButton(true);
    startBgKeepAlive();
    playCurrentParagraph();
  }
}
window.seekToChapter = seekToChapter;

/**
 * The effective playback rate: per-story narration preset first, then the
 * profile setting, then 1.0.
 *
 * There is deliberately NO speed slider or label in the UI. Every playback path
 * used to look up a range input by id and fall back to "1" -- an element that
 * exists nowhere in the app and is created by no module -- so the rate resolved
 * to 1.0 on every paragraph and silently clobbered anything set elsewhere.
 * `settings.speed` and `narrationPreset.speed` were stored, cloud-synced and
 * merged, but never reached playback at all. Speed now comes from the profile,
 * which is the only place it is actually recorded.
 */
export function getEffectivePlaybackRate() {
  const preset = window.currentStory?.narrationPreset || {};
  const raw = Number(preset.speed) || Number(window.userProfile?.settings?.speed) || 1;
  if (!Number.isFinite(raw)) return 1;
  // HTMLAudioElement tolerates a wide range but pitch-corrects poorly outside
  // this band, and the PCM worklet already clamps to the same limits.
  return Math.min(2, Math.max(0.5, raw));
}
window.getEffectivePlaybackRate = getEffectivePlaybackRate;

// A global narration speed lives in settings.speed and is read here on every
// paragraph. Writing it is settings_manager's onNarrationSpeedChange, NOT a
// function in this module: applyPlaybackSpeed() used to live here, exported,
// on window and listed in narration_runtime_loader's deferred actions -- with
// no caller anywhere, because the control it was written for did not exist.
// Reinstating it here would also have meant a slider drag pulling in the whole
// narration runtime through the deferred shim, which is the cost the engine
// select was moved out of this module to avoid.

// Which option the merged control is showing. 'pocket' and 'kokoro' both
// collapse to the neural engine internally, so the raw setting cannot round-trip
// the user's choice on its own.
let _selectedVoiceEngineControlValue = null;

// 'pocket' and 'kokoro' are both the NEURAL path. Every gate below used to test
// for the literal 'pocket', which on a Kokoro device meant generation returned
// null and the caller fell back to the device voice — the engine was selected,
// listed, and never actually asked to speak.
function _isNeuralEngine(engine) {
  // Kitten belongs here for the same reason Kokoro does: every gate that guards
  // the narration path reads this, and omitting the new tier would make it look
  // like a device-speech engine to all of them.
  return engine === 'pocket' || engine === 'kokoro' || engine === KITTEN_ENGINE;
}

function _defaultVoiceForEngine(engine) {
  if (engine === KITTEN_ENGINE) {
    const saved = window.userProfile?.settings?.kittenVoice;
    return isKittenVoice(saved) ? saved : KITTEN_DEFAULT_VOICE;
  }
  if (engine === 'kokoro') {
    const saved = window.userProfile?.settings?.kokoroVoice;
    return isKokoroVoice(saved) ? saved : KOKORO_DEFAULT_VOICE;
  }
  return engine === 'pocket' ? POCKET_DEFAULT_VOICE : '';
}

export function switchReaderVoiceEngine(engineVal, silent = false) {
  if (!engineVal) {
    engineVal = window.userProfile?.settings?.voiceEngine || 'pocket';
  }
  // The single Voice Engine control now carries the neural choice too, because
  // a separate "Narration engine" select said an overlapping thing and left the
  // reader guessing which one won. 'auto' / 'kokoro' are UI values: both run
  // the neural path, and which model that means is the narration override.
  if (engineVal === 'auto' || engineVal === 'kokoro'
      || engineVal === 'kitten' || engineVal === 'pocket') {
    writeNarrationEngineOverride(localStorage, engineVal === 'auto' ? null : engineVal);
    // Asking for a neural engine is asking to try it again, so lift the
    // session-only 'this engine could not load' flag rather than resolving
    // straight back to the device voice and looking like the control is dead.
    window._pocketNeuralEngineUnavailable = false;
    // Swapping the model set invalidates the running worker and its voice
    // registry; it is rebuilt on the next request.
    try { _resetPocketEngineForBackend(); } catch (_) {}
    _selectedVoiceEngineControlValue = engineVal;
    engineVal = 'pocket';
  } else if (engineVal === 'webspeech') {
    _selectedVoiceEngineControlValue = 'webspeech';
  }
  if (engineVal !== 'pocket' && engineVal !== 'webspeech') engineVal = 'pocket';
  if (!document.getElementById('voice-selector')) {
    // If DOM elements aren't ready yet, defer execution to guarantee perfect dropdown synchronization
    setTimeout(() => switchReaderVoiceEngine(engineVal, silent), 50);
    return;
  }

  if (window.isPlaying && !silent) {
    if (window.virtueSpeak) window.virtueSpeak("Please pause the story first before changing the voice engine.", 4000);
    else window.pocketNotify?.("Pause the story first, then switch the voice engine.", 4000);
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

  const controlValue = _selectedVoiceEngineControlValue || engineVal;
  const globalSel = document.getElementById('voice-engine-select');
  if (globalSel) globalSel.value = controlValue;
  const playbarSel = document.getElementById('reader-engine-select');
  if (playbarSel) playbarSel.value = controlValue;
  if (typeof window.renderNarrationEngineControls === 'function') {
    try { window.renderNarrationEngineControls(); } catch (_) {}
  }

  const voiceSelector = document.getElementById('voice-selector');
  const neuralEngine = engineVal === 'pocket' ? _resolveActiveEngine() : engineVal;
  if (voiceSelector) {
    const neuralVoices = voicesForEngine(neuralEngine);
    if (neuralVoices.length) {
      const savedKey = neuralEngine === KITTEN_ENGINE ? 'kittenVoice' : 'kokoroVoice';
      const chosen = coerceVoiceForEngine(neuralEngine, window.userProfile?.settings?.[savedKey]);
      const byGender = (gender) => neuralVoices.filter((voice) => voice.gender === gender)
        .map((voice) => `<option value="${voice.id}"${voice.id === chosen ? ' selected' : ''}>`
          + `${voice.label}${voice.grade ? ` (${voice.grade})` : ''}</option>`).join('');
      voiceSelector.innerHTML =
        `<optgroup label="Female voices">${byGender('female')}</optgroup>`
        + `<optgroup label="Male voices">${byGender('male')}</optgroup>`;
      voiceSelector.value = chosen;
      if (window.userProfile?.settings) window.userProfile.settings[savedKey] = chosen;
    } else if (engineVal === 'pocket') {
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
    if (window.virtueSpeak) window.virtueSpeak("Voice engine changed. Recaching audio... Playback will unlock as soon as the starting buffer is ready.", 5000);
    else alert("Voice engine changed. Recaching audio... Playback will unlock as soon as the starting buffer is ready.");
    if (engineVal === 'pocket') {
      if (typeof window.startCaching === 'function') window.startCaching('Normal');
      else if (window.BufferManager) window.BufferManager.start();
    }
  }
}

window.onVoiceSelectionChange = function(newVoice) {
  // Kokoro voices are a separate namespace stored under their own setting.
  // Falling through to the Pocket path would canonicalise a Kokoro id against
  // the Pocket voice list and quietly rewrite it to donald_malone.
  const neuralEngine = isKittenVoice(newVoice) ? KITTEN_ENGINE
    : (isKokoroVoice(newVoice) ? 'kokoro' : null);
  if (neuralEngine) {
    const savedKey = neuralEngine === KITTEN_ENGINE ? 'kittenVoice' : 'kokoroVoice';
    const label = neuralEngine === KITTEN_ENGINE ? 'Kitten' : 'Kokoro';
    if (window.isPlaying) {
      window.virtueSpeak?.('Please pause the story first before changing the voice.', 4000);
      const sel = document.getElementById('voice-selector');
      if (sel) sel.value = coerceVoiceForEngine(neuralEngine, window.userProfile?.settings?.[savedKey]);
      return;
    }
    if (!window.userProfile) window.userProfile = {};
    if (!window.userProfile.settings) window.userProfile.settings = {};
    window.userProfile.settings[savedKey] = newVoice;
    window.saveLocalData?.();
    window.pocketNotify?.(`${label} voice updated.`);
    return;
  }
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
      "Playback unlocks as soon as a short starting buffer is ready. " +
      "Your previously cached voices are kept.\n\nSwitch voice?"
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
    if (window.virtueSpeak) window.virtueSpeak("Voice changed - re-caching this story. Playback will unlock when the starting buffer is ready.", 5000);
    else alert("Voice changed - re-caching this story. Playback will unlock when the starting buffer is ready.");
    if (engine === 'pocket') {
      if (typeof window.startCaching === 'function') window.startCaching('Normal');
      else if (window.BufferManager) window.BufferManager.start();
    }
  } else {
    if (window.virtueSpeak) window.virtueSpeak("Voice setting updated.", 3000);
  }
};
window.switchReaderVoiceEngine = switchReaderVoiceEngine;

// The voice list was only ever built inside switchReaderVoiceEngine, so it was
// populated when the engine CHANGED and never when a story was simply opened in
// a session that was already on Kokoro — which is why the reader showed an empty
// voice dropdown. Re-running the same engine resolution on story load fixes it
// without duplicating the list-building logic.
window.refreshVoiceSelectorForEngine = function refreshVoiceSelectorForEngine() {
  const stored = window.userProfile?.settings?.voiceEngine || 'pocket';
  const control = stored === 'webspeech'
    ? 'webspeech'
    : (readNarrationEngineOverride(localStorage) || 'auto');
  try { switchReaderVoiceEngine(control, true); } catch (_) {}
};

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
    return window.isMetaParagraph(text, story ? story.title : null, chapTitle, story ? story.author : null);
  }
  return !text || !text.trim();
}

/**
 * PCM -> 16-bit mono WAV.
 *
 * `fadeInSec` applies a raised-cosine onset ramp to the head of the clip. It
 * replaces the old Web Audio gain ramp (_applyEmotionBoundaryFade), which could
 * never run on mobile: the gain nodes it needed were created by
 * _setupAudioRouting, which was deliberately skipped on phones because routing
 * narration through an AudioContext makes iOS suspend it on screen lock. So
 * every iPhone heard an abrupt timbre step at each emotion change while desktop
 * heard it smoothed. Shaping the samples themselves works identically on both
 * platforms and survives the direct-media-element path.
 *
 * Raised cosine rather than linear: a linear ramp has a discontinuous first
 * derivative at both ends, which is faintly audible as a click on a voice
 * onset. The old implementation got away with linear because it was applied to
 * a gain node rather than to the waveform.
 */
function _encodeWAV(samples, sampleRate, { fadeInSec = 0 } = {}) {
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

  // Never ramp across more than the clip itself, however short it is.
  const fadeSamples = Math.min(
    samples.length,
    Math.max(0, Math.round((Number(fadeInSec) || 0) * sampleRate)),
  );

  const int16 = new Int16Array(buffer, 44);
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    if (i < fadeSamples) {
      s *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeSamples);
    }
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
export function _updateMediaSessionMetadata() {
  _updateMediaSession(Boolean(window.isPlaying));
}
window._updateMediaSessionMetadata = _updateMediaSessionMetadata;
