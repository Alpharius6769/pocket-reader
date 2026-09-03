// engine_utils.js — shared engine constants loaded before audio_core, buffer_manager, settings_manager
// Writes to window so all downstream ES modules read a single source of truth.
import {
  isMobileLikePlatform,
  selectNarrationEngine,
  NARRATION_ENGINE_TIERS,
} from './pocket_backend_policy.js?v=backend-v45';

const _prLogicalCores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 2) : 2;
// Routed through the shared platform helper so a stock iPad — which reports a
// desktop "Macintosh" UA — is capped at mobile worker counts. Getting this wrong
// spawns up to 4 concurrent TTS workers instead of 1, each holding model
// weights, on a device with iPhone-class per-tab memory limits.
const _isMobileDevice = typeof navigator !== 'undefined' && isMobileLikePlatform(navigator.userAgent || '');

window.HARD_CAP_WORKERS   = _isMobileDevice ? 1 : Math.min(4, Math.max(1, Math.floor(_prLogicalCores * 0.5)));
window.MANUAL_CAP_WORKERS = _isMobileDevice ? 2 : Math.min(8, Math.max(1, Math.floor(_prLogicalCores * 0.75)));
window.DEFAULT_MAX_WORKERS = window.HARD_CAP_WORKERS;

// The emotion vocabulary the narration router can ask for. Kept as the full
// space even though every shipped voice is currently a single neutral
// reference: the router picks an emotion from the prose either way, and the
// per-voice fallback map is what decides where that lands. Shrinking this to
// ['neutral'] would delete the routing, not simplify it.
const POCKET_PRIMARY_EMOTIONS = ['neutral', 'calm', 'happy', 'sad', 'worried', 'surprised', 'tired', 'frustrated'];
const POCKET_GATED_EMOTIONS = ['anger', 'excited', 'enthused', 'shout'];
const POCKET_EXTRA_EMOTIONS = ['confused'];
const POCKET_ALL_EMOTIONS = [...POCKET_PRIMARY_EMOTIONS, ...POCKET_GATED_EMOTIONS, ...POCKET_EXTRA_EMOTIONS];

// The general emotion fallback graph: where each state degrades to when a voice
// has no reference built for it. Unused while every voice is neutral-only, and
// kept because it is the contract a multi-state voice would rejoin.
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

// Every Kyutai voice is a single official reference recording, so an emotion
// the router picks must land on neutral rather than on a state with no file
// behind it. Requesting a missing state is what makes the worker fetch a 404
// and stall, so this is a correctness contract, not a nicety.
const NEUTRAL_ONLY_FALLBACKS = Object.freeze(
  Object.fromEntries(POCKET_ALL_EMOTIONS.map((emotion) => [emotion, 'neutral'])),
);

// Three male and three female, all from Kyutai's own catalog.
//
// What was removed and why: the six Voice-Zero voices and the personal Rayne
// clone are gone at the product's request. Worth recording honestly, because it
// is not free -- the Voice-Zero six were the ONLY voices with real multi-state
// emotion references built in B2 (donald_malone_happy, _sad, _anger and friends
// all resolve; alba_happy does not). With them gone, expressiveness has to come
// from synthesis-time control rather than from swapping reference packs, which
// is the only approach that could ever have worked across Kokoro and Kitten
// anyway: Kokoro indexes a (510, 1, 256) style table by token count and Kitten
// carries one 256-float vector, and neither has an emotion axis to swap.
//
// The accent spread is deliberate: one English and two American per gender, so
// a listener has a real choice rather than three takes on the same voice.
// Kyutai's `jane` and `michael` were the two dropped -- both English VCTK reads
// that duplicated Alba's and Charles's accent with weaker provenance, and
// `michael` additionally collided by display name with Kokoro's am_michael,
// which would have put two different "Michael" voices in one picker.
window.POCKET_DEFAULT_VOICE = 'alba';
window.POCKET_DEFAULT_EMOTION = 'neutral';
window.POCKET_VOICE_PACK = {
  id: 'kyutai-curated-v1',
  title: 'Kyutai Pocket TTS Voices',
  sourceRepository: 'https://github.com/kyutai-labs/pocket-tts',
  license: 'CC BY 4.0 via Kyutai TTS voices',
  defaultVoice: window.POCKET_DEFAULT_VOICE,
  defaultEmotion: window.POCKET_DEFAULT_EMOTION,
  primaryEmotions: POCKET_PRIMARY_EMOTIONS,
  gatedEmotions: POCKET_GATED_EMOTIONS,
  extraEmotions: POCKET_EXTRA_EMOTIONS,
  voices: [
    {
      id: 'alba',
      displayName: 'Alba',
      gender: 'female',
      accent: 'English',
      recommended: true,
      recommendedUse: 'Default narrator; professional acted delivery and the steadiest over long chapters.',
      sourceName: 'Alba MacKenna',
      sourceFolder: 'alba-mackenna',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/alba-mackenna/casual.wav',
      originUrl: 'https://github.com/kyutai-labs/pocket-tts',
      license: 'CC BY 4.0 via Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: NEUTRAL_ONLY_FALLBACKS
    },
    {
      id: 'mary',
      displayName: 'Mary',
      gender: 'female',
      accent: 'American, Indiana',
      recommended: true,
      recommendedUse: 'American female narrator; clean midwestern read.',
      sourceName: 'VCTK p333',
      sourceFolder: 'vctk',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p333_023_enhanced.wav',
      originUrl: 'https://datashare.ed.ac.uk/handle/10283/3443',
      license: 'CC BY 4.0 via VCTK / Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: NEUTRAL_ONLY_FALLBACKS
    },
    {
      id: 'eve',
      displayName: 'Eve',
      gender: 'female',
      accent: 'American, New Jersey',
      recommended: true,
      recommendedUse: 'American female narrator; brighter east-coast read.',
      sourceName: 'VCTK p361',
      sourceFolder: 'vctk',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p361_023_enhanced.wav',
      originUrl: 'https://datashare.ed.ac.uk/handle/10283/3443',
      license: 'CC BY 4.0 via VCTK / Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: NEUTRAL_ONLY_FALLBACKS
    },
    {
      id: 'charles',
      displayName: 'Charles',
      gender: 'male',
      accent: 'English',
      recommended: true,
      recommendedUse: 'Default male narrator; measured English read.',
      sourceName: 'VCTK p254',
      sourceFolder: 'vctk',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p254_023_enhanced.wav',
      originUrl: 'https://datashare.ed.ac.uk/handle/10283/3443',
      license: 'CC BY 4.0 via VCTK / Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: NEUTRAL_ONLY_FALLBACKS
    },
    {
      id: 'george',
      displayName: 'George',
      gender: 'male',
      accent: 'American, New England',
      recommended: true,
      recommendedUse: 'American male narrator; warmer new-england read.',
      sourceName: 'VCTK p315',
      sourceFolder: 'vctk',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p315_023_enhanced.wav',
      originUrl: 'https://datashare.ed.ac.uk/handle/10283/3443',
      license: 'CC BY 4.0 via VCTK / Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: NEUTRAL_ONLY_FALLBACKS
    },
    {
      id: 'noah',
      displayName: 'Noah',
      gender: 'male',
      accent: 'American, Florida',
      recommended: true,
      recommendedUse: 'American male narrator; younger southern read.',
      sourceName: 'VCTK p345',
      sourceFolder: 'vctk',
      sourceUrl: 'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p345_023_enhanced.wav',
      originUrl: 'https://datashare.ed.ac.uk/handle/10283/3443',
      license: 'CC BY 4.0 via VCTK / Kyutai TTS voices',
      availableEmotions: ['neutral'],
      fallbackEmotions: NEUTRAL_ONLY_FALLBACKS
    }
  ]
};

// Voices retired from the picker. Kept ONLY so a stored setting naming one can
// be recognised as retired and migrated to a live voice, rather than being
// handed to the worker as an unknown id -- which is what previously resolved to
// a Pocket voice pack that does not exist and hung for 60 s on every attempt.
window.POCKET_RETIRED_VOICES = Object.freeze([
  'donald_malone', 'bill_boerst', 'jason_mayoff',
  'kristin_hughes', 'jodi_krangle_expressive', 'karen_savage',
  'jane', 'michael', 'rayne',
]);

window.POCKET_VOICES = window.POCKET_VOICE_PACK.voices.map((voice) => voice.id);
// Every alias resolves to a voice that EXISTS. This map used to point the older
// nicknames at the Voice-Zero six, and leaving it that way through their removal
// would have been the worst possible outcome: canonicalPocketVoice returns an
// alias hit directly, so `rob` would have resolved to a retired id, reached the
// worker as an unknown voice, and hung for 60 s -- the exact failure the voice
// contract exists to prevent. A stale alias is worse than no alias.
//
// Retired ids are aliased too, so a reader whose stored setting names a removed
// voice is migrated to the closest LIVE one of the same gender rather than
// having everyone silently collapse onto the default.
window.POCKET_VOICE_ALIASES = {
  // Legacy nicknames.
  rob: 'charles',
  dan: 'george',
  caden: 'george',
  dave: 'noah',
  ian: 'noah',
  jodi: 'alba',
  'jodi_krangle-expressive': 'alba',
  reeses: 'eve',
  stephanie: 'mary',
  vd: 'mary',
  christine: 'eve',
  // Retired Voice-Zero voices, migrated by gender.
  donald_malone: 'charles',
  bill_boerst: 'george',
  jason_mayoff: 'noah',
  kristin_hughes: 'mary',
  jodi_krangle_expressive: 'alba',
  karen_savage: 'eve',
  // Retired Kyutai duplicates and the personal clone.
  jane: 'alba',
  michael: 'charles',
  rayne: 'alba'
};
window.POCKET_VOICE_ASSET_IDS = [];
window.POCKET_VOICE_PACK.voices.forEach((voice) => {
  (voice.availableEmotions || POCKET_ALL_EMOTIONS).forEach((emotion) => {
    window.POCKET_VOICE_ASSET_IDS.push(`${voice.id}_${emotion}`);
  });
});

// Guard rather than trust. The map above is hand-maintained and its whole job
// is to never emit a dead id, so a future edit that reintroduces one should
// fail loudly here instead of silently at the worker 60 seconds later.
Object.entries(window.POCKET_VOICE_ALIASES).forEach(([from, to]) => {
  if (!window.POCKET_VOICES.includes(to)) {
    console.error(`Pocket voice alias ${from} -> ${to} names a voice that does not exist.`);
    delete window.POCKET_VOICE_ALIASES[from];
  }
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
  // Belt and braces with the startup guard above: an alias is only honoured
  // when it names a live voice, so no path can return an id the worker cannot
  // load however the map is edited later.
  const alias = window.POCKET_VOICE_ALIASES[token];
  if (alias && window.POCKET_VOICES.includes(alias)) return alias;
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
  // Female first, to match Kokoro and Kitten (built in settings_manager's
  // syncNarrationControls) and the static markup in the shell. Pocket was the
  // only engine listing male first, so the picker reordered itself purely
  // because the reader changed engine.
  //
  // No "(Recommended)" suffix either: it is now on every shipped voice, since
  // the catalog was cut to six curated ones. A label that appears on every
  // option distinguishes nothing and just crowds a narrow phone dropdown.
  ['female', 'male'].forEach((gender) => {
    const group = document.createElement('optgroup');
    group.label = gender === 'male' ? 'Male voices' : 'Female voices';
    window.POCKET_VOICE_PACK.voices
      .filter((voice) => voice.gender === gender)
      .forEach((voice) => {
        const opt = document.createElement('option');
        opt.value = voice.id;
        opt.textContent = `${voice.displayName} - ${voice.accent}`;
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
  // A tier this page has already failed to start is not a candidate again.
  // _degradeNarrationEngine sets this after an engine fails to load, so the
  // session keeps NEURAL narration one rung down instead of dropping to the
  // device voice. In memory only: a reload retries the reader's real choice.
  if (NARRATION_ENGINE_TIERS.includes(window._pocketRuntimeEngineOverride)) {
    return window._pocketRuntimeEngineOverride;
  }
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
