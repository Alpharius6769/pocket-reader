// engine_utils.js — shared engine constants loaded before audio_core, buffer_manager, settings_manager
// Writes to window so all downstream ES modules read a single source of truth.
import { isMobileLikePlatform } from './pocket_backend_policy.js?v=backend-v22';

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

window.POCKET_DEFAULT_VOICE = 'rayne';
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
    {
      id: 'rayne',
      displayName: 'Rayne (Personal)',
      gender: 'female',
      accent: 'Personal Clone',
      recommended: false,
      recommendedUse: 'Custom user-cloned voice.',
      sourceName: 'Rayne',
      sourceFolder: 'rayne',
      sourceUrl: `/personal voices/rayne`,
      originUrl: 'local',
      license: 'personal',
      availableEmotions: ['neutral'],
      fallbackEmotions: baseFallbacks
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

window.isPocketBaseVoice = function isPocketBaseVoice(voiceName) {
  const token = _cleanPocketToken(voiceName);
  const alias = window.POCKET_VOICE_ALIASES[token];
  return window.POCKET_VOICES.includes(token) || window.POCKET_VOICES.includes(alias);
};

window.isPocketAssetVoice = function isPocketAssetVoice(voiceName) {
  const token = _cleanPocketToken(voiceName);
  if (window.POCKET_VOICE_ASSET_IDS.includes(token)) return true;
  const match = token.match(/^(.+)_(neutral|calm|happy|sad|worried|surprised|tired|frustrated|anger|excited|enthused|shout|confused)$/);
  if (!match) return false;
  const base = window.POCKET_VOICE_ALIASES[match[1]] || match[1];
  return window.POCKET_VOICE_ASSET_IDS.includes(`${base}_${match[2]}`);
};

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
  return engine;
};

export {};
