// engine_utils.js — shared engine constants loaded before audio_core, buffer_manager, settings_manager
// Writes to window so all downstream ES modules read a single source of truth.
import {
  isMobileLikePlatform,
  selectNarrationEngine,
  NARRATION_ENGINE_TIERS,
} from './pocket_backend_policy.js?v=backend-v29';

const _prLogicalCores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 2) : 2;
// Routed through the shared platform helper so a stock iPad — which reports a
// desktop "Macintosh" UA — is capped at mobile worker counts. Getting this wrong
// spawns up to 4 concurrent TTS workers instead of 1, each holding model
// weights, on a device with iPhone-class per-tab memory limits.
const _isMobileDevice = typeof navigator !== 'undefined' && isMobileLikePlatform(navigator.userAgent || '');

window.HARD_CAP_WORKERS   = _isMobileDevice ? 1 : Math.min(4, Math.max(1, Math.floor(_prLogicalCores * 0.5)));
window.MANUAL_CAP_WORKERS = _isMobileDevice ? 2 : Math.min(8, Math.max(1, Math.floor(_prLogicalCores * 0.75)));
window.DEFAULT_MAX_WORKERS = window.HARD_CAP_WORKERS;

const VOICE_ZERO_PRIMARY_EMOTIONS = ['neutral', 'calm', 'happy', 'sad', 'worried', 'surprised', 'tired', 'frustrated'];
const VOICE_ZERO_GATED_EMOTIONS = ['anger', 'excited', 'enthused', 'shout'];
const VOICE_ZERO_EXTRA_EMOTIONS = ['confused'];
const VOICE_ZERO_ALL_EMOTIONS = [...VOICE_ZERO_PRIMARY_EMOTIONS, ...VOICE_ZERO_GATED_EMOTIONS, ...VOICE_ZERO_EXTRA_EMOTIONS];

const VOICE_ZERO_BASE_URL = 'https://github.com/OwenTyme/voice-zero';
const VOICE_ZERO_EMOTION_URL = `${VOICE_ZERO_BASE_URL}/tree/main/voices-emotion`;

const baseFallbacks = {
  neutral: 'neutral',
  calm: 'neutral',
  happy: 'calm',
  sad: 'calm',
  worried: 'calm',
  surprised: 'happy',
  tired: 'calm',
  frustrated: 'worried',
  confused: 'worried',
  anger: 'frustrated',
  excited: 'happy',
  enthused: 'happy',
  shout: 'surprised'
};

// Rayne has one built state, so every emotion the router picks must land on
// neutral rather than on a state with no file behind it.
const RAYNE_NEUTRAL_ONLY_FALLBACKS = Object.freeze(
  Object.fromEntries(VOICE_ZERO_ALL_EMOTIONS.map((emotion) => [emotion, 'neutral'])),
);

window.POCKET_DEFAULT_VOICE = 'donald_malone';
window.POCKET_DEFAULT_EMOTION = 'neutral';
window.POCKET_VOICE_PACK = {
  id: 'voice-zero-emotional-v1',
  title: 'Voice-Zero Emotional Pack',
  sourceRepository: VOICE_ZERO_BASE_URL,
  license: 'CC0 unless otherwise noted by Voice-Zero',
  defaultVoice: window.POCKET_DEFAULT_VOICE,
  defaultEmotion: window.POCKET_DEFAULT_EMOTION,
  primaryEmotions: VOICE_ZERO_PRIMARY_EMOTIONS,
  gatedEmotions: VOICE_ZERO_GATED_EMOTIONS,
  extraEmotions: VOICE_ZERO_EXTRA_EMOTIONS,
  voices: [
    {
      id: 'donald_malone',
      displayName: 'Donald Malone',
      gender: 'male',
      accent: 'American, Midwestern',
      recommended: true,
      recommendedUse: 'Default male narrator; calm long-form narration and broad emotional coverage.',
      sourceName: 'Donald Malone',
      sourceFolder: 'donald_malone',
      sourceUrl: `${VOICE_ZERO_EMOTION_URL}/donald_malone`,
      originUrl: 'https://librivox.org/short-poetry-collection-204-by-various/',
      license: 'CC0 via Voice-Zero',
      availableEmotions: VOICE_ZERO_ALL_EMOTIONS,
      fallbackEmotions: baseFallbacks
    },
    {
      id: 'bill_boerst',
      displayName: 'Bill Boerst',
      gender: 'male',
      accent: 'American',
      recommended: true,
      recommendedUse: 'Warm alternate male voice for narration and dialogue-heavy stories.',
      sourceName: 'Bill Boerst',
      sourceFolder: 'bill_boerst',
      sourceUrl: `${VOICE_ZERO_EMOTION_URL}/bill_boerst`,
      originUrl: 'https://librivox.org/',
      license: 'CC0 via Voice-Zero',
      availableEmotions: VOICE_ZERO_ALL_EMOTIONS,
      fallbackEmotions: baseFallbacks
    },
    {
      id: 'jason_mayoff',
      displayName: 'Jason Mayoff',
      gender: 'male',
      accent: 'American',
      recommended: false,
      recommendedUse: 'Clear, serious male voice for tense scenes and grounded narration.',
      sourceName: 'Jason Mayoff',
      sourceFolder: 'jason_mayoff',
      sourceUrl: `${VOICE_ZERO_EMOTION_URL}/jason_mayoff`,
      originUrl: 'https://librivox.org/',
      license: 'CC0 via Voice-Zero',
      availableEmotions: VOICE_ZERO_ALL_EMOTIONS,
      fallbackEmotions: baseFallbacks
    },
    {
      id: 'kristin_hughes',
      displayName: 'Kristin Hughes',
      gender: 'female',
      accent: 'American, Iowa',
      recommended: true,
      recommendedUse: 'Default female narrator; clean long-form tone and stable emotion references.',
      sourceName: 'Kristin Hughes',
      sourceFolder: 'kristin_hughes',
      sourceUrl: `${VOICE_ZERO_EMOTION_URL}/kristin_hughes`,
      originUrl: 'https://librivox.org/',
      license: 'CC0 via Voice-Zero',
      availableEmotions: VOICE_ZERO_ALL_EMOTIONS,
      fallbackEmotions: baseFallbacks
    },
    {
      id: 'jodi_krangle_expressive',
      displayName: 'Jodi Krangle Expressive',
      gender: 'female',
      accent: 'American',
      recommended: true,
      recommendedUse: 'Expressive female voice for dialogue, companion lines, and emotional passages.',
      sourceName: 'Jodi Krangle',
      sourceFolder: 'jodi_krangle-expressive',
      sourceUrl: `${VOICE_ZERO_EMOTION_URL}/jodi_krangle-expressive`,
      originUrl: 'https://librivox.org/short-science-fiction-collection-vol-002/',
      license: 'CC0 via Voice-Zero',
      availableEmotions: VOICE_ZERO_ALL_EMOTIONS,
      fallbackEmotions: baseFallbacks
    },
    {
      id: 'karen_savage',
      displayName: 'Karen Savage',
      gender: 'female',
      accent: 'American',
      recommended: false,
      recommendedUse: 'Polished female narrator for steady audiobook-style delivery.',
      sourceName: 'Karen Savage',
      sourceFolder: 'karen_savage',
      sourceUrl: `${VOICE_ZERO_EMOTION_URL}/karen_savage`,
      originUrl: 'https://librivox.org/',
      license: 'CC0 via Voice-Zero',
      availableEmotions: VOICE_ZERO_ALL_EMOTIONS,
      fallbackEmotions: baseFallbacks
    },
    // Kyutai Pocket TTS catalog. Each is a single official reference, so
    // emotion routing must land on neutral — the same contract as Rayne.
    {
      id: 'alba',
      displayName: 'Alba',
      gender: 'female',
      accent: 'English',
      recommended: true,
      recommendedUse: 'Kyutai default female voice; professional acted narration.',
      sourceName: 'Alba MacKenna',
      sourceFolder: 'alba-mackenna',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/alba-mackenna/casual.wav',
      originUrl: 'https://github.com/kyutai-labs/pocket-tts',
      license: 'CC BY 4.0 via Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: RAYNE_NEUTRAL_ONLY_FALLBACKS
    },
    {
      id: 'jane',
      displayName: 'Jane',
      gender: 'female',
      accent: 'English',
      recommended: true,
      recommendedUse: 'Kyutai demo female voice; clean VCTK enhanced reference.',
      sourceName: 'VCTK p339',
      sourceFolder: 'vctk',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p339_023_enhanced.wav',
      originUrl: 'https://datashare.ed.ac.uk/handle/10283/3443',
      license: 'CC BY 4.0 via VCTK / Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: RAYNE_NEUTRAL_ONLY_FALLBACKS
    },
    {
      id: 'charles',
      displayName: 'Charles',
      gender: 'male',
      accent: 'English',
      recommended: true,
      recommendedUse: 'Kyutai catalog male voice; clean VCTK enhanced reference.',
      sourceName: 'VCTK p254',
      sourceFolder: 'vctk',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p254_023_enhanced.wav',
      originUrl: 'https://datashare.ed.ac.uk/handle/10283/3443',
      license: 'CC BY 4.0 via VCTK / Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: RAYNE_NEUTRAL_ONLY_FALLBACKS
    },
    {
      id: 'michael',
      displayName: 'Michael',
      gender: 'male',
      accent: 'English',
      recommended: true,
      recommendedUse: 'Kyutai catalog male voice; clean VCTK enhanced reference.',
      sourceName: 'VCTK p360',
      sourceFolder: 'vctk',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p360_023_enhanced.wav',
      originUrl: 'https://datashare.ed.ac.uk/handle/10283/3443',
      license: 'CC BY 4.0 via VCTK / Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: RAYNE_NEUTRAL_ONLY_FALLBACKS
    },
    {
      id: 'george',
      displayName: 'George',
      gender: 'male',
      accent: 'American, New England',
      recommended: true,
      recommendedUse: 'Kyutai catalog American male; clean VCTK enhanced reference.',
      sourceName: 'VCTK p315',
      sourceFolder: 'vctk',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p315_023_enhanced.wav',
      originUrl: 'https://datashare.ed.ac.uk/handle/10283/3443',
      license: 'CC BY 4.0 via VCTK / Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: RAYNE_NEUTRAL_ONLY_FALLBACKS
    },
    {
      id: 'noah',
      displayName: 'Noah',
      gender: 'male',
      accent: 'American, Florida',
      recommended: true,
      recommendedUse: 'Kyutai VCTK American male; clean enhanced reference.',
      sourceName: 'VCTK p345',
      sourceFolder: 'vctk',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p345_023_enhanced.wav',
      originUrl: 'https://datashare.ed.ac.uk/handle/10283/3443',
      license: 'CC BY 4.0 via VCTK / Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: RAYNE_NEUTRAL_ONLY_FALLBACKS
    },
    {
      id: 'mary',
      displayName: 'Mary',
      gender: 'female',
      accent: 'American, Indiana',
      recommended: true,
      recommendedUse: 'Kyutai catalog American female; clean VCTK enhanced reference.',
      sourceName: 'VCTK p333',
      sourceFolder: 'vctk',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p333_023_enhanced.wav',
      originUrl: 'https://datashare.ed.ac.uk/handle/10283/3443',
      license: 'CC BY 4.0 via VCTK / Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: RAYNE_NEUTRAL_ONLY_FALLBACKS
    },
    {
      id: 'eve',
      displayName: 'Eve',
      gender: 'female',
      accent: 'American, New Jersey',
      recommended: true,
      recommendedUse: 'Kyutai catalog American female; clean VCTK enhanced reference.',
      sourceName: 'VCTK p361',
      sourceFolder: 'vctk',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p361_023_enhanced.wav',
      originUrl: 'https://datashare.ed.ac.uk/handle/10283/3443',
      license: 'CC BY 4.0 via VCTK / Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: RAYNE_NEUTRAL_ONLY_FALLBACKS
    },
    // Project-owned personal clone. Unlike the Voice-Zero six this has no
    // upstream: the reference material is maintainer-held and only the neutral
    // state has been built, so availableEmotions is the single entry and every
    // routed emotion resolves back to it. Two things were wrong here:
    // sourceUrl held a local directory path in a field that is a URL
    // everywhere else, and the full baseFallbacks map implied emotion states
    // that do not exist. RAYNE_NEUTRAL_ONLY_FALLBACKS says the true thing.
    {
      id: 'rayne',
      displayName: 'Rayne (Personal)',
      gender: 'female',
      accent: 'Personal Clone',
      recommended: false,
      recommendedUse: 'Custom user-cloned voice. Neutral delivery only.',
      sourceName: 'Rayne',
      sourceFolder: 'rayne',
      sourceUrl: null,
      originUrl: null,
      license: 'Project-owned (see ATTRIBUTIONS.md)',
      availableEmotions: ['neutral'],
      fallbackEmotions: RAYNE_NEUTRAL_ONLY_FALLBACKS
    }
  ]
};

window.POCKET_VOICES = window.POCKET_VOICE_PACK.voices.map((voice) => voice.id);
window.POCKET_VOICE_ALIASES = {
  rob: 'donald_malone',
  dan: 'bill_boerst',
  caden: 'bill_boerst',
  dave: 'jason_mayoff',
  ian: 'jason_mayoff',
  jodi: 'jodi_krangle_expressive',
  'jodi_krangle-expressive': 'jodi_krangle_expressive',
  reeses: 'karen_savage',
  stephanie: 'kristin_hughes',
  vd: 'kristin_hughes',
  christine: 'karen_savage'
};
window.POCKET_VOICE_ASSET_IDS = [];
window.POCKET_VOICE_PACK.voices.forEach((voice) => {
  (voice.availableEmotions || VOICE_ZERO_ALL_EMOTIONS).forEach((emotion) => {
    window.POCKET_VOICE_ASSET_IDS.push(`${voice.id}_${emotion}`);
  });
});

function _cleanPocketToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
}

function _voiceById(id) {
  return window.POCKET_VOICE_PACK.voices.find((voice) => voice.id === id) || null;
}

window.canonicalPocketVoice = function canonicalPocketVoice(voiceName) {
  const token = _cleanPocketToken(voiceName || window.POCKET_DEFAULT_VOICE);
  if (window.POCKET_VOICE_ASSET_IDS.includes(token)) return token;
  const alias = window.POCKET_VOICE_ALIASES[token];
  if (alias) return alias;
  if (window.POCKET_VOICES.includes(token)) return token;
  const assetMatch = token.match(/^(.+)_(neutral|calm|happy|sad|worried|surprised|tired|frustrated|anger|excited|enthused|shout|confused)$/);
  if (assetMatch) {
    const base = window.POCKET_VOICE_ALIASES[assetMatch[1]] || assetMatch[1];
    const candidate = `${base}_${assetMatch[2]}`;
    if (window.POCKET_VOICE_ASSET_IDS.includes(candidate)) return candidate;
  }
  return window.POCKET_DEFAULT_VOICE;
};

// isPocketBaseVoice() and isPocketAssetVoice() lived here and had no callers.
// Voice classification in the running code goes through canonicalPocketVoice()
// and resolvePocketAssetVoiceId() below, which answer the question the callers
// actually ask ("what should I load?") rather than a yes/no about a string.

window.resolvePocketAssetVoiceId = function resolvePocketAssetVoiceId(voiceName, emotionName) {
  const canonical = window.canonicalPocketVoice(voiceName);
  if (window.POCKET_VOICE_ASSET_IDS.includes(canonical)) return canonical;
  const base = window.POCKET_VOICES.includes(canonical) ? canonical : window.POCKET_DEFAULT_VOICE;
  const voice = _voiceById(base) || _voiceById(window.POCKET_DEFAULT_VOICE);
  const emotion = _cleanPocketToken(emotionName || window.POCKET_DEFAULT_EMOTION);
  if (voice && voice.availableEmotions.includes(emotion)) return `${base}_${emotion}`;
  return `${base}_${window.POCKET_DEFAULT_EMOTION}`;
};

window.getPocketVoiceLabel = function getPocketVoiceLabel(voiceName) {
  const canonical = window.canonicalPocketVoice(voiceName);
  const base = window.POCKET_VOICES.includes(canonical) ? canonical : canonical.replace(/_(neutral|calm|happy|sad|worried|surprised|tired|frustrated|anger|excited|enthused|shout|confused)$/, '');
  const voice = _voiceById(base);
  return voice ? voice.displayName : 'Pocket Voice';
};

window.renderPocketVoiceOptions = function renderPocketVoiceOptions(selectEl, selectedVoice) {
  if (!selectEl) return window.POCKET_DEFAULT_VOICE;
  selectEl.innerHTML = '';
  const selected = window.canonicalPocketVoice(selectedVoice || window.POCKET_DEFAULT_VOICE);
  const selectedBase = window.POCKET_VOICES.includes(selected)
    ? selected
    : selected.replace(/_(neutral|calm|happy|sad|worried|surprised|tired|frustrated|anger|excited|enthused|shout|confused)$/, '');
  ['male', 'female'].forEach((gender) => {
    const group = document.createElement('optgroup');
    group.label = gender === 'male' ? 'Male voices' : 'Female voices';
    window.POCKET_VOICE_PACK.voices
      .filter((voice) => voice.gender === gender)
      .forEach((voice) => {
        const opt = document.createElement('option');
        opt.value = voice.id;
        opt.textContent = `${voice.displayName} - ${voice.accent}${voice.recommended ? ' (Recommended)' : ''}`;
        group.appendChild(opt);
      });
    selectEl.appendChild(group);
  });
  selectEl.value = window.POCKET_VOICES.includes(selectedBase) ? selectedBase : window.POCKET_DEFAULT_VOICE;
  return selectEl.value;
};

window._resolveActiveEngine = function _resolveActiveEngine() {
  // A neural engine that failed to LOAD is unusable for the rest of this page's
  // life -- but that is a runtime fact about this session, not a preference.
  // audio_core used to record it by PERSISTING voiceEngine: 'webspeech', which
  // demoted the account permanently after one transient failure and, because
  // only a neural engine starts a cache job, silently suppressed the
  // "Preparing Narration" modal on every later story open. The flag lives in
  // memory instead: a reload retries the engine, and choosing one in Settings
  // clears it at once.
  if (window._pocketNeuralEngineUnavailable === true) return 'webspeech';
  let engine = window.userProfile?.settings?.voiceEngine;
  if (!engine) {
    try {
      const raw = localStorage.getItem('pocketReaderData');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.settings?.voiceEngine) {
          engine = parsed.settings.voiceEngine;
        }
      }
    } catch (e) {}
  }
  if (engine !== 'pocket' && engine !== 'webspeech') {
    engine = 'pocket';
  }
  // "pocket" is the user's choice of NEURAL narration, not a specific model.
  // Which neural engine runs is a device decision, resolved here from the
  // shared policy. This used to feature-detect a global published by
  // audio_core, which meant the answer depended on whether the narration
  // runtime happened to be loaded yet -- so a cold session resolved Pocket even
  // on a device that should never run it. Importing the policy directly makes
  // the decision available from the first frame, which is what "pick the best
  // engine at startup" actually requires.
  if (engine === 'pocket') {
    try {
      const choice = selectNarrationEngine({
        capability: window._pocketDeviceCapability,
        userAgent: navigator.userAgent || '',
        deviceMemory: Number(navigator.deviceMemory || 0),
        screenWidth: Number(window.screen?.width || 0),
        screenHeight: Number(window.screen?.height || 0),
        lowMemoryMode: window.userProfile?.settings?.lowMemoryMode === true,
        storage: localStorage,
      });
      // Return whatever the policy picked, validated against the known tiers.
      // Naming one engine here is what made 'kitten' unreachable: the policy
      // selected it, this returned 'pocket', and every downstream gate then
      // resolved a device onto an engine it had not chosen.
      if (choice?.engine && choice.engine !== 'pocket'
          && NARRATION_ENGINE_TIERS.includes(choice.engine)) {
        return choice.engine;
      }
    } catch (_) { /* any failure keeps the historical Pocket default */ }
  }
  return engine;
};

// Resolved once at boot so the choice (and the reason for it) is observable
// before narration is ever requested — diagnostics, the settings panel and the
// first play all read the same answer.
window.getNarrationEngineDecision = function getNarrationEngineDecision() {
  try {
    return selectNarrationEngine({
      capability: window._pocketDeviceCapability,
      userAgent: navigator.userAgent || '',
      deviceMemory: Number(navigator.deviceMemory || 0),
      screenWidth: Number(window.screen?.width || 0),
      screenHeight: Number(window.screen?.height || 0),
      lowMemoryMode: window.userProfile?.settings?.lowMemoryMode === true,
      storage: localStorage,
    });
  } catch (_) {
    return { engine: 'pocket', automatic: true, reason: '' };
  }
};
try {
  const decision = window.getNarrationEngineDecision();
  window._narrationEngineDecision = decision;
  window.Diagnostics?.log?.('INFO', 'Narration engine resolved at startup', decision);
} catch (_) {}

export {};
