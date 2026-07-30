import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeForPocketTts, PRONUNCIATION_RULESET_VERSION } from '../public/assets/js/tts_pronunciation_core.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── Contraction normalization (the narrator mispronounces raw contractions) ──

test("can't / shan't expand for the narrator", () => {
  assert.equal(normalizeForPocketTts("I can't do it"), 'I can not do it');
  assert.equal(normalizeForPocketTts("We shan't wait"), 'We shall not wait');
});

test("previously-handled contractions still expand (regression)", () => {
  assert.equal(normalizeForPocketTts("Don't stop"), 'do not stop');
  assert.equal(normalizeForPocketTts("I'm here"), 'I am here');
  assert.equal(normalizeForPocketTts("won't and didn't"), 'will not and did not');
});

test("'s + been/got/gotten is 'has', not the broken 'is been'", () => {
  assert.equal(normalizeForPocketTts("It's been raining"), 'It has been raining');
  assert.equal(normalizeForPocketTts("he's got it"), 'he has got it');
  assert.equal(normalizeForPocketTts("She's gotten better"), 'She has gotten better');
  assert.equal(normalizeForPocketTts("There's been a change"), 'There has been a change');
});

test("plain 's stays 'is' — the has-rule never over-fires", () => {
  // NB: the generic 's->is rules lowercase the leading letter (pre-existing;
  // irrelevant to the case-insensitive TTS). The has-rule preserves case ($1).
  assert.equal(normalizeForPocketTts("It's cold"), 'it is cold');
  // "done" is a passive/adjectival 'is', not 'has' — must not become "that has done"
  assert.equal(normalizeForPocketTts("that's done"), 'that is done');
  assert.equal(normalizeForPocketTts("What's that"), 'what is that');
});

test("ambiguous 'd contractions are still left native (deliberate)", () => {
  // "she'd already gone" must not be forced to "she would already gone"
  assert.match(normalizeForPocketTts("she'd already gone"), /she'd already gone/);
});

test("pronunciation ruleset version bumped so cached audio re-renders", () => {
  assert.equal(PRONUNCIATION_RULESET_VERSION, 'pron-v11');
});

// ── #3 — seed-perturb on a failed paragraph's retry (worker) ──────────────────

test("worker salts the latent seed only on a retry, preserving determinism", async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  // The generation pipeline reads a seed salt from control...
  assert.match(worker, /const seedSalt = control && control\.seedSalt \? String\(control\.seedSalt\) : '';/);
  // ...and folds it into the per-chunk latent noise seed.
  assert.match(worker, /const chunkNoiseSeed = voiceName \+ '\|' \+ \(meta\.emotion \|\| 'neutral'\) \+ '\|' \+ chunkText \+ seedSalt;/);
  // The salt is non-empty ONLY when retryLevel > 0 (normal renders stay byte-identical).
  assert.match(worker, /seedSalt: Number\(opts\?\.retryLevel\) > 0 \? \('\|r' \+ Number\(opts\.retryLevel\)\) : ''/);
});

// ── #5 — guaranteed lookahead buffer during locked playback (audio_core) ──────

test("playback lookahead prefetch exists and yields to live synthesis", async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /async function _ensurePlaybackLookahead\(\)/);
  // Never competes with the live paragraph's synthesis or a full cache job.
  assert.match(audio, /function _lookaheadShouldYield\(\)[\s\S]*?window\._pocketLiveSynthActive === true \|\| window\._playPriority === true/);
  assert.match(audio, /if \(window\.BufferManager\?\.isActive\) return;/);
  // Bounded depth (a runway, not the whole story).
  assert.match(audio, /const POCKET_PLAYBACK_LOOKAHEAD = \d+;/);
});

test("lookahead is triggered once a paragraph is actually playing", async () => {
  const audio = await read('public/assets/js/audio_core.js');
  // Fired on the streamed path and on the normal audio-element play path.
  const hits = audio.match(/_ensurePlaybackLookahead\(\)/g) || [];
  // 1 definition call site (window assignment) + at least 2 trigger sites.
  assert.ok(hits.length >= 3, `expected >=3 references, saw ${hits.length}`);
  assert.match(audio, /if \(window\.isPlaying\) _ensurePlaybackLookahead\(\);/);
});
