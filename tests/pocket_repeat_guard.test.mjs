// Guards for the repeated-speech detector.
//
// From a 20-30 minute listen: "Words will be repeated every few paragraphs."
// The pre-existing _hasRepeatedAudioPattern cannot catch that — it looks for
// adjacent 0.25s windows that are near sample-IDENTICAL, which is a frozen
// decoder, not a re-synthesized repeat. A repeated word has new samples and no
// phase alignment, so it slips straight through.
//
// The detector under test correlates a 4-band log-energy feature sequence.
// An earlier version of it correlated the energy ENVELOPE alone and these
// false-positive tests rejected it: an envelope is periodic at the syllable
// rate, so evenly-paced speech correlates ~1.0 at multiples of that period.
// Spectrum is what separates a repeated word from a different word said with
// the same rhythm, so the negative cases below matter as much as the positive
// ones — a detector that fires on ordinary prose would send every paragraph
// through three needless re-renders and make longform WORSE.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SR = 24000;

// Lift the detector out of audio_core.js: the module is a browser bundle that
// touches window/document at import time.
const source = await readFile(
  new URL('../public/assets/js/audio_core.js', import.meta.url), 'utf8',
);

function lift(names) {
  const parts = [];
  for (const name of names) {
    const candidates = /^[A-Z_]+$/.test(name)
      ? [
          new RegExp(`^const ${name} = .*?;$`, 'm'),        // single line
          new RegExp(`^const ${name} = \\{[\\s\\S]*?\\n\\};$`, 'm'), // object literal
        ]
      : [new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}$`, 'm')];
    const match = candidates.map((re) => source.match(re)).find(Boolean);
    assert.ok(match, `could not lift ${name} out of audio_core.js`);
    parts.push(match[0]);
  }
  parts.push(`return { ${names.filter((n) => !/^[A-Z_]+$/.test(n)).join(', ')} };`);
  return new Function(parts.join('\n\n'))();
}

const { _hasRepeatedSpeechSegment } = lift([
  'REPEAT_ENVELOPE_HOP_SEC', 'REPEAT_MIN_LAG_SEC', 'REPEAT_MAX_LAG_SEC',
  'REPEAT_MIN_CYCLES', 'REPEAT_CORRELATION', 'REPEAT_BAND_HZ',
  '_speechBandFeatures', '_hasRepeatedSpeechSegment',
]);

// ── Signal builders ─────────────────────────────────────────────────────────

// Deterministic PRNG so a threshold that only passes on a lucky noise draw
// cannot creep into the suite.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// A "phoneme": gain, pitch, and how much of its energy is fricative noise
// rather than voiced harmonics. Sibilants are noise-heavy and high-passed;
// vowels are voiced and low. This spectral difference is exactly what the
// detector keys on, so the synthetic speech has to have it.
const VOWEL_A = { gain: 0.95, f0: 105, noise: 0.05, bright: 0.15 };
const VOWEL_E = { gain: 0.85, f0: 125, noise: 0.08, bright: 0.35 };
const VOWEL_O = { gain: 0.90, f0: 95, noise: 0.05, bright: 0.10 };
const SIB_S = { gain: 0.45, f0: 0, noise: 0.95, bright: 0.95 };
const STOP_T = { gain: 0.35, f0: 0, noise: 0.70, bright: 0.75 };
const NASAL_M = { gain: 0.60, f0: 110, noise: 0.05, bright: 0.05 };

function synth(phonemes, { syllableSec = 0.18, seed = 7, jitter = 0.12 } = {}) {
  const random = rng(seed);
  const per = Math.floor(SR * syllableSec);
  const out = new Float32Array(phonemes.length * per);
  let phase = 0;
  let highState = 0;
  for (let s = 0; s < phonemes.length; s++) {
    const p = phonemes[s];
    // Each utterance is re-synthesized: same identity, new detail.
    const gain = p.gain * (1 + (random() - 0.5) * jitter);
    const f0 = p.f0 * (1 + (random() - 0.5) * 0.06);
    for (let i = 0; i < per; i++) {
      const t = i / per;
      const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * Math.min(1, Math.max(0, t)));
      let voiced = 0;
      if (f0 > 0) {
        phase += (2 * Math.PI * f0) / SR;
        voiced = Math.sin(phase) + 0.3 * Math.sin(2 * phase) + 0.15 * Math.sin(3 * phase);
      }
      const white = random() * 2 - 1;
      // One-pole high-pass so "noise" lands in the upper bands, like a fricative.
      highState += 0.55 * (white - highState);
      const noise = p.bright > 0.5 ? (white - highState) : white * 0.4;
      const mixed = voiced * (1 - p.noise) * 0.3 + noise * p.noise * 0.5;
      out[s * per + i] = gain * env * mixed;
    }
  }
  return out;
}

const WORD_THANKS = [SIB_S, VOWEL_A, NASAL_M];
const WORD_TAKING = [STOP_T, VOWEL_E, NASAL_M];
const WORD_IN = [VOWEL_O, NASAL_M];

// ── Must fire ───────────────────────────────────────────────────────────────

test('a repeated phrase is detected even though the samples differ', () => {
  // "thanks for taking me in, thanks for taking me in, ..."
  const phrase = [...WORD_THANKS, ...WORD_TAKING, ...WORD_IN];
  const repeated = synth([...phrase, ...phrase, ...phrase, ...phrase], { seed: 11 });
  assert.equal(_hasRepeatedSpeechSegment(repeated, SR), true,
    'a phrase repeated four times must be caught');
});

test('a repeated word loop is detected', () => {
  const loop = Array.from({ length: 7 }, () => WORD_TAKING).flat();
  assert.equal(_hasRepeatedSpeechSegment(synth(loop, { seed: 3 }), SR), true);
});

// ── Must NOT fire ───────────────────────────────────────────────────────────

test('ordinary varied prose does not trip the detector', () => {
  const prose = [
    VOWEL_A, NASAL_M, SIB_S, VOWEL_O, STOP_T, VOWEL_E, NASAL_M, VOWEL_A,
    SIB_S, VOWEL_E, VOWEL_O, STOP_T, NASAL_M, VOWEL_A, VOWEL_E, SIB_S,
    VOWEL_O, NASAL_M, STOP_T, VOWEL_A, VOWEL_E, SIB_S, NASAL_M, VOWEL_O,
  ];
  assert.equal(_hasRepeatedSpeechSegment(synth(prose, { seed: 5 }), SR), false,
    'varied prose must not be flagged as repetition');
});

test('steady syllabic rhythm with varied words does not trip the detector', () => {
  // The false positive that killed the envelope-only version: perfectly even
  // pacing and near-equal stress, but the CONTENT does not repeat.
  const even = [
    VOWEL_A, VOWEL_E, VOWEL_O, SIB_S, NASAL_M, STOP_T, VOWEL_E, VOWEL_A,
    SIB_S, VOWEL_O, STOP_T, NASAL_M, VOWEL_A, SIB_S, VOWEL_E, VOWEL_O,
    NASAL_M, STOP_T,
  ].map((p) => ({ ...p, gain: 0.8 }));
  assert.equal(_hasRepeatedSpeechSegment(synth(even, { seed: 9, jitter: 0.3 }), SR), false,
    'metronomic but non-repeating speech must not be flagged');
});

test('a word recurring naturally in a sentence is not a repeat', () => {
  // "the man saw the man" — the same word twice, but not consecutively and not
  // enough cycles to be degeneration.
  const sentence = [
    ...WORD_TAKING, VOWEL_A, SIB_S, VOWEL_O, ...WORD_TAKING, NASAL_M, VOWEL_E,
  ];
  assert.equal(_hasRepeatedSpeechSegment(synth(sentence, { seed: 17 }), SR), false,
    'a word legitimately recurring in a sentence must not be flagged');
});

test('silence and near-silence are left to the rms checks', () => {
  assert.equal(_hasRepeatedSpeechSegment(new Float32Array(SR * 3), SR), false);
  const quiet = new Float32Array(SR * 3);
  for (let i = 0; i < quiet.length; i++) quiet[i] = 1e-5;
  assert.equal(_hasRepeatedSpeechSegment(quiet, SR), false);
});

test('short and empty renders are handled without throwing', () => {
  assert.equal(_hasRepeatedSpeechSegment(new Float32Array(0), SR), false);
  assert.equal(_hasRepeatedSpeechSegment(new Float32Array(64), SR), false);
  assert.equal(_hasRepeatedSpeechSegment(synth([VOWEL_A, NASAL_M]), SR), false,
    'too short to contain the required repetitions');
});

test('fast delivery with varied content is not a repeat', () => {
  // Rapid speech is still speech. Only the CONTENT repeating counts.
  const fast = [
    SIB_S, VOWEL_A, NASAL_M, VOWEL_E, STOP_T, VOWEL_O, VOWEL_A, SIB_S,
    NASAL_M, VOWEL_O, VOWEL_E, STOP_T, SIB_S, VOWEL_A, VOWEL_O, NASAL_M,
    STOP_T, VOWEL_E, VOWEL_A, SIB_S, VOWEL_O, NASAL_M, VOWEL_E, STOP_T,
    VOWEL_A, SIB_S, NASAL_M, VOWEL_O,
  ];
  assert.equal(_hasRepeatedSpeechSegment(synth(fast, { syllableSec: 0.09, seed: 21 }), SR), false);
});

test('a two-phoneme stutter loop IS caught, at any speed', () => {
  // "sa-sa-sa-sa..." is not fast speech, it is the decoder stuck in a cycle —
  // the detector should say so rather than treating short lags as off-limits.
  const stutter = Array.from({ length: 40 }, (_, i) => (i % 2 ? VOWEL_A : SIB_S));
  assert.equal(_hasRepeatedSpeechSegment(synth(stutter, { syllableSec: 0.09, seed: 23 }), SR), true);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test('the repeated-speech reason is fatal and ranked above the cosmetic ones', () => {
  assert.match(source, /reasons\.push\('repeated speech'\)/);
  // It must actually set fatal, or it would be logged and then played anyway.
  const block = source.slice(
    source.indexOf("if (!fatal && durationSec > 1.2 && _hasRepeatedSpeechSegment"),
    source.indexOf('// Pitch consistency vs the rolling baseline'),
  );
  assert.ok(block.length > 0, 'the repeated-speech check must still be wired into the guard');
  assert.match(block, /fatal = true;/);

  // And the least-bad chooser has to know how bad it is, or an all-attempts
  // failure could keep the looping take over a merely clipped one.
  const weights = source.slice(
    source.indexOf('const POCKET_QUALITY_REASON_WEIGHT'),
    source.indexOf('function _pocketQualityPenalty'),
  );
  const weightOf = (key) => Number(weights.match(new RegExp(`'?${key}'?: (\\d+)`))?.[1]);
  assert.ok(Number.isFinite(weightOf('repeated speech')), 'repeated speech must be weighted');
  assert.ok(weightOf('repeated speech') > weightOf('clipping'));
  assert.ok(weightOf('repeated speech') > weightOf('duration too long'));
});

// ── Never drop a paragraph ──────────────────────────────────────────────────

test('a fatally-flagged paragraph is retried several times, cooling each pass', () => {
  // The old path was ONE retry, and returning null when it also failed. Null
  // means the reader silently loses a piece of the story — the worst outcome
  // for an audiobook, and the reason the detection thresholds had been loosened
  // until they stopped catching real artifacts.
  const retries = Number(source.match(/const POCKET_MAX_QUALITY_RETRIES = (\d+)/)?.[1]);
  assert.ok(retries >= 2, `expected multiple retries, got ${retries}`);
  assert.match(source, /for \(let level = 1; level <= POCKET_MAX_QUALITY_RETRIES; level\+\+\)/);

  // Each attempt must differ from the last in BOTH noise and temperature,
  // otherwise a retry just re-rolls the same odds on the same take.
  const worker = source.includes('retryLevel');
  assert.ok(worker, 'retryLevel must still reach the worker opts');
  const cooling = source.slice(
    source.indexOf('function _artifactCappedTemperature'),
    source.indexOf('// The route carries the engine it was resolved FOR'),
  );
  assert.match(cooling, /retries \* 0\.06/, 'retries must step the temperature down per level');
  assert.doesNotMatch(cooling, /retryLevel \? 0\.06 : 0/, 'the one-shot step-down was the old behaviour');
});

test('when every attempt fails the least-bad render is kept, not dropped', () => {
  assert.match(source, /function _leastBadPocketAttempt/);
  // The only unplayable outcome is a render with no audio at all.
  const block = source.slice(
    source.indexOf('const clean = attempts.find'),
    source.indexOf('} else if (first.quality.fatal) {'),
  );
  assert.ok(block.length > 0, 'the best-effort branch must still be findable');
  assert.match(block, /if \(!best\.result\?\.audio\?\.length\) return null;/);
  assert.match(block, /accepted = best;/);
  assert.match(block, /keptBestEffort: true/);
});

test('the least-bad chooser prefers playable audio and the lighter defect', () => {
  const { _leastBadPocketAttempt } = lift([
    'POCKET_QUALITY_REASON_WEIGHT', '_pocketQualityPenalty', '_leastBadPocketAttempt',
  ]);
  const attempt = (reasons, samples = 100) => ({
    quality: { reasons },
    result: { audio: new Float32Array(samples) },
  });

  // A looping render loses to a merely clipped one.
  assert.deepEqual(
    _leastBadPocketAttempt([attempt(['repeated speech']), attempt(['clipping'])]).quality.reasons,
    ['clipping'],
  );
  // Two defects lose to one of the same kind.
  assert.deepEqual(
    _leastBadPocketAttempt([attempt(['clipping', 'pitch drift']), attempt(['clipping'])]).quality.reasons,
    ['clipping'],
  );
  // Silence can never win over something audible, however it was labelled.
  const silent = { quality: { reasons: [] }, result: { audio: new Float32Array(0) } };
  assert.notEqual(_leastBadPocketAttempt([silent, attempt(['repeated speech'])]), silent);
});

test('the pitch gate is tight enough to catch the reported artifacts', () => {
  // Relaxed to 0.50 (~7 semitones) only because a rejected paragraph used to be
  // dropped. It is not dropped any more, so the gate can sit where the reported
  // "high pitched and/or distorted" quotes actually live.
  const fatalCut = Number(source.match(/if \(deviation > (0\.\d+)\) \{\s*\r?\n\s*fatal = true;/)?.[1]);
  assert.ok(Number.isFinite(fatalCut), 'the fatal pitch cut must be findable');
  assert.ok(fatalCut <= 0.42, `pitch gate ${fatalCut} is back in the range that missed real artifacts`);
  assert.ok(fatalCut > 0.30, `pitch gate ${fatalCut} would reject ordinary emphatic questions`);
});

test('a best-effort render is played but never cached', async () => {
  // Caching a render the guard rejected would make the defect permanent for
  // that paragraph. It must stay playable and stay out of IndexedDB.
  assert.match(source, /if \(keptBestEffort\) wav\.pocketBestEffort = true;/);

  const storage = await readFile(
    new URL('../public/assets/js/storage_core.js', import.meta.url), 'utf8',
  );
  const save = storage.slice(
    storage.indexOf('export async function saveAudioChunk'),
    storage.indexOf('const db = await initDB();', storage.indexOf('export async function saveAudioChunk')),
  );
  assert.match(save, /if \(audioBlob\.pocketBestEffort\) return null;/,
    'the skip must live in saveAudioChunk so no call site can forget it');
});

test('a retry loop counts as one drift signal, not one per attempt', () => {
  // The prosody guard demotes after three failures in its window. Recording
  // inside the loop would let a single stubborn paragraph flatten the whole
  // session's expressiveness on its own.
  const block = source.slice(
    source.indexOf('const attempts = [first];'),
    source.indexOf('const clean = attempts.find'),
  );
  assert.ok(block.length > 0, 'the retry loop must still be findable');
  assert.equal((block.match(/_recordProsodyOutcome/g) || []).length, 1,
    'exactly one drift record per paragraph');
  // It has to come after the loop closes, not inside it. The last statement in
  // the loop body is the per-attempt rejection log, and the loop's closing brace
  // sits between that and the record.
  const lastInLoop = block.lastIndexOf('rejected`, attempt');
  const recordAt = block.indexOf('_recordProsodyOutcome');
  assert.ok(lastInLoop !== -1 && recordAt > lastInLoop);
  assert.match(block.slice(lastInLoop, recordAt), /\r?\n {6}\}\r?\n/,
    'the drift record must sit outside the retry loop');
});

// ── FP16 Mimi vocoder ───────────────────────────────────────────────────────

test('unconstrained WASM devices decode through the FP16 Mimi vocoder', async () => {
  // Measured against the FP16 build on identical inputs, the INT8 Mimi decoder
  // lands at 16.6-25.9 dB SNR. It is the vocoder, so that error is heard as
  // grain. FP16 is smaller (20.9 vs 22.7 MB) and loaded faster in ORT Web.
  const worker = await readFile(
    new URL('../public/assets/js/pocket_worker.js', import.meta.url), 'utf8',
  );
  assert.match(worker, /const WASM_MIMI_FP16_FILE = 'mimi_decoder_fp16\.onnx';/);

  const prefer = worker.slice(
    worker.indexOf('function preferFp16Mimi()'),
    worker.indexOf('function mimiWasmFilename()'),
  );
  assert.ok(prefer.length > 0, 'the FP16 preference must be findable');
  // Constrained devices keep INT8: ORT WASM has no native FP16 kernels, so the
  // weights widen to FP32 in the heap and the resident session grows.
  assert.match(prefer, /!constrainedMemoryMode/);
  // There is no FP16 build in the .ort bundle.
  assert.match(prefer, /!useOrtFormatWasm/);
  assert.match(prefer, /currentBackend === 'wasm'/);

  // The descriptor must carry a fallback, or a device that cannot fetch or build
  // the FP16 decoder loses narration entirely rather than losing fidelity.
  assert.match(worker, /fallbackFilename: preferFp16Mimi\(\) \? wasmModelFilename\('mimi_decoder'\) : null,/);
  assert.match(worker, /return await loadModelDescriptor\(\{ asset, target, filename: fallbackFilename, sourceBackend \}\);/);

  // Download progress has to size the file actually being fetched.
  assert.match(worker, /descriptor\.filename === WASM_MIMI_FP16_FILE \? WASM_MIMI_FP16_BYTES : 0/);
});

test('switching the vocoder busts the narration cache', async () => {
  // The waveform genuinely changes, so previously cached paragraphs must not be
  // replayed as if nothing happened.
  const audio = await readFile(
    new URL('../public/assets/js/audio_core.js', import.meta.url), 'utf8',
  );
  assert.match(audio, /const POCKET_NARRATION_CACHE_VERSION = 'narrv22'/);
});

test('the Pocket TTS upstream license is recorded with its attribution terms', async () => {
  // CC BY 4.0 permits commercial use and derivatives (the ONNX/INT8/FP16
  // exports are derivatives) but REQUIRES attribution and an indication of
  // changes. Both have to be stated where the obligation is tracked.
  const attributions = await readFile(new URL('../ATTRIBUTIONS.md', import.meta.url), 'utf8');
  assert.match(attributions, /kyutai\/pocket-tts/);
  assert.match(attributions, /CC BY 4\.0/);
  assert.match(attributions, /Modifications made by this project/);
  const notice = await readFile(new URL('../NOTICE', import.meta.url), 'utf8');
  assert.match(notice, /Pocket TTS is `kyutai\/pocket-tts`, licensed CC BY 4\.0/);
});

// ── Rebuilt decode block ────────────────────────────────────────────────────

test('the WASM decode block is the per-channel rebuild, with a fallback', async () => {
  // The original export gives every weight matrix ONE scalar scale and scores
  // 9.89 dB latent SNR against the FP16 build of the same weights. The latents
  // drive the vocoder, so that error is upstream of everything. Per-channel
  // scales score 23.31 dB in a file that is smaller and loads twice as fast.
  const worker = await readFile(
    new URL('../public/assets/js/pocket_worker.js', import.meta.url), 'utf8',
  );
  assert.match(worker, /const WASM_BLOCK_FILE = 'flow_lm_decode_block4_int8_pc\.onnx';/);
  assert.match(worker, /const WASM_BLOCK_LEGACY_FILE = 'flow_lm_decode_block4_int8\.onnx';/);

  // A bundle without the rebuilt file must find the old block rather than
  // dropping to the per-frame path, which is far slower than either.
  // An earlier bosResponse fetch sits above this one in the file, so the end of
  // the slice has to be searched for AFTER the block fetch or it comes out empty.
  const blockAt = worker.indexOf('const blockResponse = await fetchFirstAvailable([');
  const fetchBlock = worker.slice(
    blockAt,
    worker.indexOf('const bosResponse = await fetchFirstAvailable([', blockAt),
  );
  assert.ok(fetchBlock.length > 0, 'the block fetch must still be findable');
  assert.match(fetchBlock, /wasmModelPaths\(language, wasmBlockFilename\(false\)\)/);
  assert.match(fetchBlock, /wasmModelPaths\(language, WASM_BLOCK_LEGACY_FILE\)/);
  // The .ort bundle has no rebuilt file, so it must not chase a legacy .onnx.
  assert.match(fetchBlock, /useOrtFormatWasm \? \[\] :/);
});

test('new latents mean a new cache generation', async () => {
  const audio = await readFile(
    new URL('../public/assets/js/audio_core.js', import.meta.url), 'utf8',
  );
  assert.match(audio, /const POCKET_NARRATION_CACHE_VERSION = 'narrv22'/);
});

test('the decode-block rebuild is reproducible from a checked-in tool', async () => {
  // A model asset nobody can rebuild is a model asset nobody can fix. The
  // recipe, the Gemm workaround and the rejected variants live in the tool.
  const tool = await readFile(
    new URL('../tools/rebuild_pocket_block_int8.py', import.meta.url), 'utf8',
  );
  assert.match(tool, /per_channel=True/);
  assert.match(tool, /def fold_gemms/);
  assert.match(tool, /def score/);
  // The measurements that justify the change have to travel with it.
  assert.match(tool, /9\.89 dB/);
  assert.match(tool, /23\.31 dB/);
  assert.match(tool, /Variants that were measured and rejected/);
});
