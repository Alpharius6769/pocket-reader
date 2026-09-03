// Browser-safe Pocket TTS pronunciation and tuning helpers.
// Keep this module free of Node-only APIs; it is imported by the app and worker.

// Deliberately NOT bumped alongside the module's own ?v=. This is the version
// of the RULES, and it is folded into Pocket's audio cache key; the rules did
// not change when Kokoro was given access to them (keepClausePunctuation
// defaults off, so Pocket's output is byte-identical). Bumping it would
// re-render every cached Pocket paragraph for no audible difference.
export const PRONUNCIATION_RULESET_VERSION = 'pron-v14'; // v14: Mulberry32 PRNG & voice seed consistency
export const DEFAULT_POCKET_PLAYBACK_SPEED = 1.0;
export const DEFAULT_POCKET_TEMPERATURE_PRESET = 'balanced';
export const DEFAULT_POCKET_QUALITY_MODE = 'mobile';
// Folded into every Pocket latent-noise seed so cache jobs and live playback
// share one speaker identity. An explicit settings.pocketVoiceSeed still wins.
export const DEFAULT_POCKET_VOICE_SEED = 'pr-voice-1';

export const POCKET_TTS_TUNING_PRESETS = Object.freeze({
  stable: { temperature: 0.70, lsdSteps: 1, label: 'Stable audiobook' },
  balanced: { temperature: 0.86, lsdSteps: 1, label: 'Balanced audiobook' },
  expressive: { temperature: 0.93, lsdSteps: 1, label: 'Full expression' },
  quality: { temperature: 0.86, lsdSteps: 4, label: 'Benchmark quality' },
});

const PRESET_RANK = Object.freeze({ stable: 0, balanced: 1, quality: 1, expressive: 2 });

const MAX_USER_OVERRIDES = 200;

const BUILT_IN_PRONUNCIATION_OVERRIDES = Object.freeze([
  { term: 'basically', soundsLike: 'bay sick lee', enabled: true },
]);

const CONTRACTIONS = Object.freeze([
  // "'s" + been/got/gotten is UNAMBIGUOUSLY "has" ("it is been" is never
  // grammatical), so expand it FIRST — before the generic "'s -> is" rules
  // below — so "it's been" -> "it has been", not the broken "it is been".
  // Only these three participles are safe; every other "'s" stays "is" (the
  // far more common reading), matching the deliberate-conservatism of this set.
  [/\b(it|he|she|that|there|what|who|here)'s\s+(been|got|gotten)\b/gi, '$1 has $2'],
  [/\bI'm\b/g, 'I am'], [/\bI've\b/g, 'I have'], [/\bI'll\b/g, 'I will'],
  [/\byou're\b/gi, 'you are'], [/\byou've\b/gi, 'you have'], [/\byou'll\b/gi, 'you will'],
  [/\bhe's\b/gi, 'he is'], [/\bhe'll\b/gi, 'he will'],
  [/\bshe's\b/gi, 'she is'], [/\bshe'll\b/gi, 'she will'],
  [/\bwe're\b/gi, 'we are'], [/\bwe've\b/gi, 'we have'], [/\bwe'll\b/gi, 'we will'],
  [/\bthey're\b/gi, 'they are'], [/\bthey've\b/gi, 'they have'], [/\bthey'll\b/gi, 'they will'],
  [/\bit's\b/gi, 'it is'], [/\bit'll\b/gi, 'it will'], [/\bthat's\b/gi, 'that is'], [/\bthat'll\b/gi, 'that will'],
  [/\bwhat's\b/gi, 'what is'], [/\bwhat'll\b/gi, 'what will'], [/\bwhat're\b/gi, 'what are'],
  [/\bwho's\b/gi, 'who is'], [/\bwho'll\b/gi, 'who will'],
  [/\blet's\b/gi, 'let us'], [/\bthere's\b/gi, 'there is'], [/\bthere're\b/gi, 'there are'], [/\bthere'll\b/gi, 'there will'],
  [/\bdon't\b/gi, 'do not'], [/\bdoesn't\b/gi, 'does not'], [/\bdidn't\b/gi, 'did not'], [/\bwon't\b/gi, 'will not'],
  [/\bwouldn't\b/gi, 'would not'], [/\bcouldn't\b/gi, 'could not'], [/\bshouldn't\b/gi, 'should not'], [/\bmustn't\b/gi, 'must not'],
  [/\bmightn't\b/gi, 'might not'], [/\bneedn't\b/gi, 'need not'], [/\bdaren't\b/gi, 'dare not'], [/\bisn't\b/gi, 'is not'],
  [/\baren't\b/gi, 'are not'], [/\bwasn't\b/gi, 'was not'], [/\bweren't\b/gi, 'were not'], [/\bhasn't\b/gi, 'has not'],
  [/\bhaven't\b/gi, 'have not'], [/\bhadn't\b/gi, 'had not'], [/\bain't\b/gi, 'is not'],
  [/\bcan't\b/gi, 'can not'], [/\bshan't\b/gi, 'shall not'],
  // NOTE: ma'am is deliberately NOT rewritten. 'mam' reads as British "mum",
  // and phonetic respellings ('maam') destabilize the flow-LM — it renders the
  // pseudo-word in a shifted voice. The model's native "ma'am" is the best take.
  // NOTE: the ambiguous "'d" contractions (I'd, you'd, he'd, she'd, we'd, they'd,
  // who'd) are deliberately NOT expanded. "'d" is would OR had; always choosing
  // "would" mis-said them when they meant "had" (e.g. "she'd already gone" ->
  // "she would already gone"). The flow-LM reads the native contraction fine.
  [/\bo'clock\b/gi, 'oh clock'], [/\by'all\b/gi, 'you all'],
]);

const STRESS_HETERONYMS = Object.freeze([
  ['abstract', 'abstract', 'abstrakt'], ['accent', 'accent', 'axent'], ['addict', 'addict', 'uhdict'],
  ['address', 'address', 'uhdress'], ['ally', 'ally', 'uhly'], ['combat', 'combat', 'cumbat'],
  ['conduct', 'connduct', 'conduct'], ['conflict', 'confflict', 'conflict'], ['console', 'console', 'consoal'],
  ['contest', 'contest', 'cuntest'], ['contract', 'conntract', 'contract'], ['contrast', 'contrast', 'cuntrast'],
  ['convert', 'convert', 'cunvert'], ['decrease', 'decrease', 'dicrease'], ['defect', 'defect', 'difect'],
  ['desert', 'dezert', 'dizzert'], ['discount', 'discount', 'dis count'], ['escort', 'escort', 'iscort'],
  ['extract', 'exxtract', 'extract'], ['finance', 'finance', 'fy nance'], ['frequent', 'frequent', 'free kwent'],
  ['impact', 'impackt', 'impact'], ['object', 'obbject', 'ubject'], ['permit', 'permit', 'permitt'],
  ['present', 'prezzent', 'prezent'], ['produce', 'prodoos', 'produce'], ['progress', 'progress', 'prugress'],
  ['project', 'projject', 'project'], ['protest', 'protest', 'prutest'], ['rebel', 'rebbel', 'rebell'],
  ['record', 'reckord', 'record'], ['refund', 'refund', 'rifund'], ['refuse', 'reffuse', 'refuze'],
  ['reject', 'reject', 'riject'], ['subject', 'subbject', 'subject'], ['survey', 'survey', 'survay'],
  ['suspect', 'suspect', 'suspeckt'], ['torment', 'torment', 'tormennt'], ['transfer', 'transsfer', 'transfer'],
]);

const ATE_HETERONYMS = Object.freeze([
  ['advocate', 'advokit', 'advocate'], ['animate', 'animit', 'animate'], ['articulate', 'articyulit', 'articulate'],
  ['delegate', 'dellegit', 'delegate'], ['deliberate', 'dilibberit', 'deliberate'], ['desolate', 'dessolit', 'desolate'],
  ['estimate', 'estimut', 'estimate'], ['graduate', 'graduit', 'graduate'], ['intimate', 'intimut', 'intimate'],
  ['moderate', 'modderit', 'moderate'], ['separate', 'seprit', 'separate'],
]);

const VOICED_HETERONYMS = Object.freeze([
  ['abuse', 'abuce', 'abuze'], ['close', 'cloce', 'cloze'], ['use', 'uce', 'uze'],
  ['excuse', 'excuce', 'excuze'], ['house', 'house', 'houze'],
]);

const PLURAL_FIXES = Object.freeze(['skies', 'flies', 'spies', 'fries', 'cries', 'tries', 'dries']);



const PROTECTED_PATTERNS = Object.freeze([
  /`[^`]*`/g,
  /\bhttps?:\/\/[^\s<>"']+/gi,
  /\bwww\.[^\s<>"']+/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /<\/?[a-z][^>]{0,200}>/gi,
]);

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function preserveCase(original, replacement) {
  const repl = String(replacement || '');
  if (!original || !repl) return repl;
  if (original[0] === original[0].toUpperCase()) return repl.charAt(0).toUpperCase() + repl.slice(1);
  return repl;
}

function protectSegments(text) {
  const saved = [];
  let out = String(text || '');
  for (const pattern of PROTECTED_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const token = `{{${saved.length}}}`;
      saved.push(match);
      return token;
    });
  }
  return {
    text: out,
    restore(value) {
      return String(value || '').replace(/\{\{(\d+)\}\}/g, (match, index) => saved[Number(index)] ?? match);
    },
  };
}

export function validatePronunciationOverride(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const term = String(entry.term || '').trim().replace(/\s+/g, ' ');
  const soundsLike = String(entry.soundsLike || entry.replacement || '').trim().replace(/\s+/g, ' ');
  if (!term || !soundsLike) return null;
  if (term.length > 80 || soundsLike.length > 160) return null;
  if (/[\r\n<>]/.test(term) || /[\r\n<>]/.test(soundsLike)) return null;
  return { term, soundsLike, enabled: entry.enabled !== false };
}

export function normalizePronunciationOverrides(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const normalized = [];
  for (const entry of input) {
    const clean = validatePronunciationOverride(entry);
    if (!clean) continue;
    const key = clean.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(clean);
    if (normalized.length >= MAX_USER_OVERRIDES) break;
  }
  return normalized;
}

function applyPronunciationOverrides(text, userOverrides) {
  const user = normalizePronunciationOverrides(userOverrides);
  const seen = new Set(user.map((entry) => entry.term.toLowerCase()));
  const builtIns = BUILT_IN_PRONUNCIATION_OVERRIDES.filter((entry) => !seen.has(entry.term.toLowerCase()));
  const all = [...user, ...builtIns].filter((entry) => entry.enabled !== false);
  let out = String(text || '');
  for (const entry of all) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegExp(entry.term)})(?=$|[^A-Za-z0-9_])`, 'gi');
    out = out.replace(pattern, (match, prefix, word) => `${prefix}${preserveCase(word, entry.soundsLike)}`);
  }
  return out;
}

function applyStressHeteronyms(text, entries) {
  const verbContext = "\\b(to|will|can|shall|do|did|would|could|must|may|might|please|let's|should)(?:\\s+[a-zA-Z]+ly|\\s+never|\\s+not|\\s+already|\\s+just|\\s+always|\\s+soon|\\s+quickly)*\\s+";
  for (const [word, noun, verb] of entries) {
    text = text.replace(new RegExp(`\\b${word}\\b`, 'gi'), (match, offset) => {
      const prefix = text.slice(Math.max(0, offset - 70), offset);
      return new RegExp(`${verbContext}$`, 'i').test(prefix)
        ? preserveCase(match, verb)
        : preserveCase(match, noun);
    });
  }
  return text;
}

function applyWildcardHeteronyms(text) {
  const verbContext = "\\b(to|will|can|shall|do|did|would|could|must|may|might|please|let's|should)(?:\\s+[a-zA-Z]+ly|\\s+never|\\s+not|\\s+already|\\s+just|\\s+always|\\s+soon|\\s+quickly)*\\s+";
  const nounContext = "\\b(a|an|the|my|your|his|her|their|our|this|that|some|any|no)\\s+";
  const pastContext = "\\b(have|has|had|was|were|already|I have|you have|we have|they have)\\s+";

  return text
    // initiate: default is the VERB (in-ish-ee-ATE) — narrative text uses
    // "initiate the sequence" far more than the noun (a new recruit). Only a
    // determiner right before it signals the noun reading (in-ISH-ee-ut).
    // NOTE (2026-07): a broad batch of extra heteronym respellings (initiate,
    // tears-as-rip, lives-noun, winds-verb, dove, content-adj, buffet, moped)
    // plus American-English respellings (lieutenant, schedule, missile, ...)
    // was tried here and REMOVED after listening tests: the flow-LM renders
    // pseudo-word respellings in a shifted, unstable voice — worse than an
    // occasionally wrong but natural pronunciation. Do not reintroduce spelling
    // hacks for these; per-word fixes belong in the user's pronunciation
    // overrides where they can be auditioned individually.
    .replace(new RegExp(`(${pastContext})read\\b`, 'gi'), (match, p1) => p1 + match.slice(p1.length).replace(/read$/i, 'red'))
    .replace(/\b(r)ead\b/gi, (match, r) => (r === 'R' ? 'R' : 'r') + 'eed')
    .replace(/\b(made of|heavy|pipe|pencil)(\s+)lead\b/gi, '$1$2led')
    .replace(/\b(l)ead(\s+)(pipe|pencil|weight|bullet|shot|paint|apron|lining)\b/gi, (match, l, s, rest) => `${l === 'L' ? 'Led' : 'led'}${s}${rest}`)
    .replace(/\b(l)ead\b/gi, (match, l) => (l === 'L' ? 'L' : 'l') + 'eed')
    .replace(/\b(paper|apart|up|down)(\s+)tear\b/gi, '$1$2tare')
    .replace(new RegExp(`(${verbContext})tear\\b`, 'gi'), (match, p1) => p1 + match.slice(p1.length).replace(/tear$/i, 'tare'))
    .replace(/\b(t)ear\b/gi, (match, t) => (t === 'T' ? 'T' : 't') + 'eer')
    .replace(/\b(clock|watch|up|down)(\s+)wind\b/gi, '$1$2wynd')
    .replace(/\b(w)ind(\s+)(the\s+)?(clock|watch|timer|music box)\b/gi, (match, w, s, article, rest) => `${w === 'W' ? 'Wynd' : 'wynd'}${s}${article || ''}${rest}`)
    .replace(new RegExp(`(${verbContext})wind\\b`, 'gi'), (match, p1) => p1 + match.slice(p1.length).replace(/wind$/i, 'wynd'))
    .replace(/\b(w)ind\b/gi, (match, w) => (w === 'W' ? 'W' : 'w') + 'ind')
    .replace(new RegExp(`(${nounContext})resume\\b`, 'gi'), (match, p1) => p1 + match.slice(p1.length).replace(/resume$/i, 'rez oo may'))
    .replace(/\b(r)esume\b/gi, (match, r) => (r === 'R' ? 'R' : 'r') + 'izoom')
    .replace(/\b(bass)(\s+)(guitar|player|drop|heavy)\b/gi, (match, b, s, rest) => `${preserveCase(b, 'base')}${s}${rest}`)
    .replace(/\b(b)ass\b/gi, (match, b) => (b === 'B' ? 'B' : 'b') + 'ass')
    .replace(/\b(b)ow\b/gi, (match, b, offset) => {
      const prefix = text.slice(Math.max(0, offset - 40), offset);
      const suffix = text.slice(offset + match.length, offset + match.length + 40);
      if (new RegExp(`${verbContext}$`, 'i').test(prefix) || /^\s+(deeply|low|before|in respect)/i.test(suffix)) return b === 'B' ? 'Bow' : 'bow';
      return b === 'B' ? 'Boe' : 'boe';
    })
    .replace(/\b(b)owed\b/gi, (match, b, offset) => {
      const prefix = text.slice(Math.max(0, offset - 40), offset);
      const suffix = text.slice(offset + match.length, offset + match.length + 40);
      if (/^\s+(before|head|deeply|low)/i.test(suffix)) return b === 'B' ? 'Boud' : 'boud';
      if (/(wooden|planks|legs|walls|beams)\s+$/i.test(prefix)) return b === 'B' ? 'Bode' : 'bode';
      return b === 'B' ? 'Boud' : 'boud';
    })
    .replace(/\b(herd of|female|wild|bucks and|deer)(\s+)does\b/gi, '$1$2dose')
    .replace(/\b(d)oes\b/gi, (match, d) => (d === 'D' ? 'D' : 'd') + 'uz')
    .replace(/\b(l)ive\b/gi, (match, l, offset) => {
      const suffix = text.slice(offset + match.length, offset + match.length + 40);
      const prefix = text.slice(Math.max(0, offset - 40), offset);
      if (/^\s+(concert|band|performance|broadcast|stream|show|audience|television|animal|wire|wires|ammunition|ammo|round|rounds|fire|bait|grenade|feed|coverage|studio|steel)/i.test(suffix)) return l === 'L' ? 'Lyve' : 'lyve';
      if (new RegExp(`${verbContext}$`, 'i').test(prefix) || /^\s+(in|with|at|a life)/i.test(suffix)) return l === 'L' ? 'Liv' : 'liv';
      return l === 'L' ? 'Liv' : 'liv';
    })
    .replace(/\b(m)inute\b/gi, (match, m, offset) => {
      const suffix = text.slice(offset + match.length, offset + match.length + 40);
      if (/^\s+(details?|particles?|changes?|differences?|amounts?|scales?)/i.test(suffix)) return m === 'M' ? 'Mynoot' : 'mynoot';
      return m === 'M' ? 'Minnit' : 'minnit';
    })
    .replace(/\b(master|skilled|clothing|dress|garment)(\s+)sewer\b/gi, '$1$2so er')
    .replace(/\b(city|system|pipes|grate|storm|underground)(\s+)sewer\b/gi, '$1$2sooer')
    .replace(/\b(w)ound\b/gi, (match, w, offset) => {
      const prefix = text.slice(Math.max(0, offset - 40), offset);
      const suffix = text.slice(offset + match.length, offset + match.length + 40);
      if (/^\s+(healed|inflicted)/i.test(suffix) || /(grievous|mortal|flesh|deep|bullet|open|sword)\s+$/i.test(prefix)) return w === 'W' ? 'Woond' : 'woond';
      if (/^\s+(up|around|tight|tighter|the clock|through|along|down|between|about|its way|itself|past)/i.test(suffix)
          || /(tightly|had|have|has|was|were|carefully|slowly)\s+$/i.test(prefix)) return w === 'W' ? 'Wownd' : 'wownd';
      return w === 'W' ? 'Woond' : 'woond';
    })
    .replace(/\b(r)ow\b/gi, (match, r, offset) => {
      const prefix = text.slice(Math.max(0, offset - 40), offset);
      return /(awful|terrible|drunken|acrimonious|loud|had a)\s+$/i.test(prefix)
        ? (r === 'R' ? 'Row' : 'row')
        : (r === 'R' ? 'Roe' : 'roe');
    });
}

export function getPocketTuningPreset(name, emotionMode = 'neutral') {
  let key = String(name || DEFAULT_POCKET_TEMPERATURE_PRESET).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(POCKET_TTS_TUNING_PRESETS, key)) key = DEFAULT_POCKET_TEMPERATURE_PRESET;

  // The emotion profile is the user's expressiveness control. This argument
  // used to be ignored, so Settings → Expressive still sampled at balanced
  // 0.70 and the voices stayed flat. Escalate the preset to match the
  // profile; never de-escalate an explicit hotter choice, and leave the
  // quality LSD-4 path on its own temperature.
  const mode = emotionMode === 'full' ? 'expressive' : String(emotionMode || 'neutral');
  const modeKey = mode === 'expressive' ? 'expressive'
    : mode === 'balanced' ? 'balanced'
    : null;
  if (modeKey && key !== 'quality' && (PRESET_RANK[key] ?? 1) < (PRESET_RANK[modeKey] ?? 1)) {
    key = modeKey;
  }

  return { name: key, ...POCKET_TTS_TUNING_PRESETS[key] };
}

export function getBuiltInPronunciationRuleCount() {
  return BUILT_IN_PRONUNCIATION_OVERRIDES.length
    + CONTRACTIONS.length
    + STRESS_HETERONYMS.length
    + ATE_HETERONYMS.length
    + VOICED_HETERONYMS.length
    + PLURAL_FIXES.length;
}

// Shared by BOTH narration workers.
//
// Everything here except the two cadence rules noted below is front-end
// agnostic: contractions, the reader's own overrides, the built-in respellings
// and the "No. 5" expansion all work by writing a word the way it should sound,
// which any phonemizer honours. That is why Kokoro uses this too -- it
// previously used none of it, so a reader's pronunciation rules were discarded
// in silence on every device that runs Kokoro.
//
// settings.keepClausePunctuation is for an engine whose own front-end already
// renders clause marks. Pocket's zero-shot cadence drifts on an em-dash, so it
// flattens them; Kokoro tokenizes the em-dash directly and splits clauses on
// it, so flattening would cost a pause it can actually produce.
export function normalizeForPocketTts(text, settings = {}) {
  const overrides = Array.isArray(settings) ? settings : settings.pronunciationOverrides;
  const keepClausePunctuation = !Array.isArray(settings) && settings.keepClausePunctuation === true;
  const protectedText = protectSegments(text);
  let out = protectedText.text;

  for (const [pattern, expansion] of CONTRACTIONS) {
    out = out.replace(pattern, expansion);
  }

  out = applyPronunciationOverrides(out, overrides);
  
  if (!keepClausePunctuation) {
    // Strip commas directly preceding "and" to prevent random pauses in TTS
    out = out.replace(/,\s+(and\b)/gi, ' $1');
  }

  // Strip pseudo-SSML inline pause tags so they are never spoken aloud. Not
  // optional for either engine: left in, the literal characters reach the
  // phonemizer and get read out.
  out = out.replace(/\[(?:\d+(?:\.\d+)?)\s*s\]/gi, '');

  // Normalize typography that causes cadence/timbre drift
  if (!keepClausePunctuation) {
    out = out.replace(/—/g, ', '); // em-dash to comma
  }
  out = out.replace(/…/g, '...'); // ellipsis character to three dots
  
  out = applyStressHeteronyms(out, STRESS_HETERONYMS);
  out = applyStressHeteronyms(out, ATE_HETERONYMS);
  out = applyStressHeteronyms(out, VOICED_HETERONYMS);
  out = applyWildcardHeteronyms(out);

  for (const word of PLURAL_FIXES) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'gi'), (match) => `${match.slice(0, -3)}y's`);
  }
  out = out.replace(/\b(w)omen\b/gi, (match, w) => (w === 'W' ? 'W' : 'w') + 'immen');

  // "No." / "Nos." as an abbreviation for number(s) — ONLY immediately before a
  out = out.replace(/\bNos\.\s*(?=\d)/gi, 'numbers ').replace(/\bNo\.\s*(?=\d)/gi, 'number ');

  return protectedText.restore(out);
}

if (typeof window !== 'undefined') {
  window.PRONUNCIATION_RULESET_VERSION = PRONUNCIATION_RULESET_VERSION;
  window.DEFAULT_POCKET_PLAYBACK_SPEED = DEFAULT_POCKET_PLAYBACK_SPEED;
  window.DEFAULT_POCKET_TEMPERATURE_PRESET = DEFAULT_POCKET_TEMPERATURE_PRESET;
  window.DEFAULT_POCKET_QUALITY_MODE = DEFAULT_POCKET_QUALITY_MODE;
  window.DEFAULT_POCKET_VOICE_SEED = DEFAULT_POCKET_VOICE_SEED;
  window.POCKET_TTS_TUNING_PRESETS = POCKET_TTS_TUNING_PRESETS;
  window.getPocketTuningPreset = getPocketTuningPreset;
  window.getBuiltInPronunciationRuleCount = getBuiltInPronunciationRuleCount;
  window.validatePronunciationOverride = validatePronunciationOverride;
  window.normalizePronunciationOverrides = normalizePronunciationOverrides;
  window.normalizeForPocketTts = normalizeForPocketTts;
}
