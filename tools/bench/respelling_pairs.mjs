// One short sentence per pseudo-word respelling in
// public/assets/js/tts_pronunciation_core.js (applyWildcardHeteronyms and the
// "women" rule). Each sentence is written so the production rules fire on
// exactly the target word; longform_bench.mjs asserts that by running the real
// normalizeForPocketTts over it and refuses to render a pair whose text the
// rules leave unchanged.
//
// `expect` is the respelled token the rule should produce, checked too, so if a
// rule is changed or removed the bench says so instead of rendering two
// identical clips.

export const RESPELLING_PAIRS = Object.freeze([
  { id: 'does-duz', word: 'does', expect: 'duz', text: 'She does not know where the key is.' },
  { id: 'does-dose', word: 'does', expect: 'dose', text: 'A herd of does crossed the frozen field.' },
  { id: 'minute-minnit', word: 'minute', expect: 'minnit', text: 'Give me one minute and I will be ready.' },
  { id: 'minute-mynoot', word: 'minute', expect: 'mynoot', text: 'There were minute details carved into the frame.' },
  { id: 'women-wimmen', word: 'women', expect: 'wimmen', text: 'The women walked down to the harbour together.' },
  { id: 'lead-leed', word: 'lead', expect: 'leed', text: 'You lead the way and we will follow you home.' },
  { id: 'lead-led', word: 'lead', expect: 'led', text: 'The old house still had a lead pipe under the floor.' },
  { id: 'live-liv', word: 'live', expect: 'liv', text: 'They live at the far end of the harbour wall.' },
  { id: 'live-lyve', word: 'live', expect: 'lyve', text: 'We watched the live broadcast from the square.' },
  { id: 'tear-teer', word: 'tear', expect: 'teer', text: 'A single tear ran slowly down her cheek.' },
  { id: 'tear-tare', word: 'tear', expect: 'tare', text: 'Please do not tear the page out of the ledger.' },
  { id: 'wound-woond', word: 'wound', expect: 'woond', text: 'The wound on his arm had finally healed.' },
  { id: 'wound-wownd', word: 'wound', expect: 'wownd', text: 'The narrow path wound up the hill toward the house.' },
  { id: 'row-roe', word: 'row', expect: 'roe', text: 'They planted a row of beehives beside the hedge.' },
  { id: 'bow-boe', word: 'bow', expect: 'boe', text: 'She tied a red bow in her hair for the festival.' },
  { id: 'bowed-boud', word: 'bowed', expect: 'boud', text: 'He bowed before the old woman and stepped aside.' },
  { id: 'resume-rizoom', word: 'resume', expect: 'rizoom', text: 'We will resume the reading after supper.' },
  { id: 'resume-rez-oo-may', word: 'resume', expect: 'rez oo may', text: 'She left her resume on the kitchen table.' },
  { id: 'read-red', word: 'read', expect: 'red', text: 'He read the letter twice before he spoke.' },
  { id: 'read-reed', word: 'read', expect: 'reed', text: 'I like to read by the attic window.' },
  { id: 'wind-wynd', word: 'wind', expect: 'wynd', text: 'Remember to wind the clock before bed.' },
  { id: 'sewer-sooer', word: 'sewer', expect: 'sooer', text: 'The city sewer ran beneath the market square.' },
  { id: 'bass-base', word: 'bass', expect: 'base', text: 'He played bass guitar in the harbour band.' },
]);

// Source patch for the "natural spelling" side. Applied in memory to the copy
// of tts_pronunciation_core.js served to the second page only; the file on disk
// is never touched. Both edits must apply or the bench aborts: a silent no-op
// would make every pair two renders of the same respelled text.
export const NATURAL_SPELLING_PATCHES = Object.freeze([
  { find: 'out = applyWildcardHeteronyms(out);', replace: '/* longform bench: wildcard respellings disabled */' },
  {
    find: "out = out.replace(/\\b(w)omen\\b/gi, (match, w) => (w === 'W' ? 'W' : 'w') + 'immen');",
    replace: '/* longform bench: women respelling disabled */',
  },
]);

export function patchNaturalSpelling(source) {
  let out = source;
  for (const patch of NATURAL_SPELLING_PATCHES) {
    if (!out.includes(patch.find)) {
      throw new Error(`Respelling A/B patch no longer matches tts_pronunciation_core.js: ${patch.find}`);
    }
    out = out.replace(patch.find, patch.replace);
  }
  return out;
}
