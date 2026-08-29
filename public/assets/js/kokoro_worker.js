// kokoro_worker.js — Kokoro-82M narration worker for memory-constrained devices.
//
// WHY THIS EXISTS
// Pocket TTS is autoregressive: three ONNX sessions (~126 MB resident) plus a
// ~47 MB fp32 flow-LM state that crosses the JS/WASM boundary once per frame.
// On a 4 GB iPhone that sustained churn is what kills the tab mid-cache, and no
// amount of startup trimming fixed it.
//
// Kokoro is a different shape, not just a smaller one: ONE 86 MB session,
// non-autoregressive, hard-capped at 512 input tokens. There is no per-frame
// state to move, so the allocation pattern that was killing the device does not
// exist here. The parameter drop (100M -> 82M) is the least interesting part.
//
// CONTRACT
// Speaks the same worker protocol as pocket_worker.js so audio_core needs no
// special case: {type:'init'} -> init_done | init_error, and
// {type:'generate', id, text, voice} -> generate_done {audio, sampleRate} |
// generate_error. Audio is Float32Array at 24 kHz, which is already
// audio_core's default sample rate.

// The SAME text normalisation Pocket uses: contractions, the reader's own
// pronunciation overrides, the built-in respellings, and the [Ns] pause-tag
// strip. None of it ran here before -- normalizeForPocketTts() had exactly one
// caller in the codebase, inside pocket_worker.js -- so a reader on Kokoro
// (which is every iPhone) had their Settings overrides, their per-story
// overrides and the whole built-in ruleset silently discarded, and any inline
// [2s] tag read out character by character.
import { normalizeForPocketTts } from './tts_pronunciation_core.js?v=pron-v15';

self.postMessage({ type: 'status', status: 'Worker Thread Started', state: 'idle' });

const PROXY_BASE_URL = self.PR_PROXY_BASE || 'https://pocket-reader-proxy.alpharius67.workers.dev';
const KOKORO_BASE = `${PROXY_BASE_URL}/models/kokoro/v1.0`;
const PHONEMIZER_URL = `${PROXY_BASE_URL}/models/kokoro/phonemizer/1.2.1/phonemizer.js`;
const ORT_BASE = `${PROXY_BASE_URL}/models/onnxruntime/1.27.0/`;

const SAMPLE_RATE = 24000;
// The exported graph fixes the sequence axis at 512. Longer phoneme runs are
// split rather than truncated, so no audio is ever silently dropped.
const MAX_TOKENS = 512;
// Each voice .bin is (510, 1, 256) float32: one 256-wide style vector per
// possible token length. Kokoro indexes it by the token count of THIS chunk,
// which is why the whole table ships rather than a single vector.
const STYLE_DIM = 256;
const VOICE_ROWS = 510;

// WHICH MODEL FILE, AND WHY THIS ONE.
//
// model_quantized.onnx was tried here and REVERTED on measurement, 2026-08-29.
//
// The theory was sound and the evidence for it was real: ORT's WASM CPU backend
// does not implement float16, so every fp16 tensor gets a Cast to fp32 inserted
// around it, and this worker is wasm-only (executionProviders: ['wasm'], never
// WebGPU). model_q8f16.onnx is a WebGPU-oriented build, and its graph carries
// 812 Cast and 1390 QuantizeLinear nodes against model_quantized.onnx's 452 and
// 278 — with identical integer-op counts, so it really is the same int8
// quantisation minus the fp16 machinery.
//
// It did not help. Measured on the 4 GB rig (tests/android-oom), app-only:
//
//                        peak      plateau
//   q8f16 (this file)   519 MB      459 MB
//   quantized run A     587 MB      459 MB
//   quantized run B     580 MB      465 MB
//
// Two clean runs, reproducible: +64 MB at peak, +3 MB at the plateau. Peak is
// the number that gets a tab killed, so the swap made an OOM MORE likely while
// costing +10 MB of download. Removing the casts saved time in the graph but
// not memory, which says the resident cost lives somewhere else — the arena,
// the LSTM/GRU working buffers, or ORT's own fixed session cost.
//
// model_quantized.onnx is still uploaded at kokoro/v1.0/ on B2, so re-testing
// costs one line. Do not re-derive this from the graph counts alone; they are
// persuasive and they were wrong.
const MODEL_FILE = 'model_q8f16.onnx';

const MODEL_TIMEOUT_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 90000;

let ort = null;
let session = null;
let phonemize = null;
let vocab = null;
let isReady = false;
let cancelRequested = false;
const voiceCache = new Map();

function log(level, message) {
  self.postMessage({ type: 'diagnostic', level, message });
}

function status(text) {
  self.postMessage({ type: 'status', status: text, state: 'loading' });
}

function progress(pct) {
  self.postMessage({ type: 'progress', info: { status: 'progress', progress: pct } });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

// Preallocate from Content-Length rather than buffering chunks and joining.
// Same reasoning as the Pocket loader: holding the chunk list AND the assembled
// copy briefly doubles peak for the one allocation that matters most, and this
// worker exists precisely because that headroom is not there.
async function fetchBuffer(url, label) {
  const response = await withTimeout(fetch(url), FETCH_TIMEOUT_MS, label);
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get('Content-Length')) || 0;
  if (!declared || !response.body?.getReader) return await response.arrayBuffer();
  const out = new Uint8Array(declared);
  const reader = response.body.getReader();
  let filled = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (filled + value.byteLength > out.byteLength) {
      await reader.cancel().catch(() => {});
      throw new Error(`${label} exceeded its declared length`);
    }
    out.set(value, filled);
    filled += value.byteLength;
  }
  if (filled !== out.byteLength) throw new Error(`${label} ended short`);
  return out.buffer;
}

async function loadOrtRuntime() {
  status('Loading ONNX Runtime...');
  const module = await withTimeout(import(`${ORT_BASE}ort.min.mjs`), MODEL_TIMEOUT_MS, 'ORT import');
  ort = module.default || module;

  // Pin the exact binaries rather than handing ORT a base directory.
  //
  // Only the THREADED variants are published: ort-wasm-simd.wasm and
  // ort-wasm.wasm both 404 on the proxy. Given a bare base string ORT derives
  // the filename itself and asks for the non-threaded build whenever
  // numThreads is 1 — so the original `wasmPaths = ORT_BASE` plus
  // `numThreads = 1` guaranteed a 404 and the engine could never have started.
  // pocket_worker pins {mjs, wasm} for exactly this reason; this mirrors it.
  ort.env.wasm.wasmPaths = {
    mjs: `${ORT_BASE}ort-wasm-simd-threaded.mjs`,
    wasm: `${ORT_BASE}ort-wasm-simd-threaded.wasm`,
  };
  // The threaded binary needs SharedArrayBuffer, which needs cross-origin
  // isolation. Where that is unavailable it still runs, single-threaded.
  // Kokoro is one non-autoregressive pass, so extra threads buy little and each
  // carries its own stack and arena on a device with none to spare — two is the
  // ceiling rather than hardwareConcurrency.
  const isolated = self.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
  ort.env.wasm.numThreads = isolated ? Math.min(2, self.navigator?.hardwareConcurrency || 1) : 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  log('INFO', `Kokoro runtime: threaded WASM x${ort.env.wasm.numThreads}, isolated=${isolated}`);
}

// espeak-ng's data package unpacks itself with
//   for await (const chunk of blob.stream().pipeThrough(new DecompressionStream('gzip')))
// and async iteration over a ReadableStream only shipped in Safari 17.4 and
// Chrome 124. Below those it throws `TypeError: e is not async iterable` from
// inside an un-caught IIFE, so en_dict, intonations and the voice tables never
// reach the WASM filesystem and phonemisation runs on whatever espeak can do
// without its dictionaries.
//
// Scope, honestly: this is NOT the iPhone bug. WebKit 26.5 was checked directly
// and supports async iteration, so iOS 26 is unaffected — it was found because
// the 4 GB test rig runs Chrome 113. It matters for older iOS, which is exactly
// the device class this engine exists to serve.
//
// Feature-detected, so it installs only where the capability is missing and is
// inert everywhere else.
function _installStreamAsyncIteratorPolyfill() {
  if (typeof ReadableStream === 'undefined') return;
  if (typeof ReadableStream.prototype[Symbol.asyncIterator] === 'function') return;
  ReadableStream.prototype[Symbol.asyncIterator] = function streamAsyncIterator() {
    const reader = this.getReader();
    return {
      next() { return reader.read(); },
      async return(value) {
        await reader.cancel().catch(() => {});
        return { done: true, value };
      },
      [Symbol.asyncIterator]() { return this; },
    };
  };
  log('INFO', 'Installed ReadableStream async-iterator polyfill for the phonemizer');
}

async function loadPhonemizer() {
  // "Phoneme engine", not "pronunciation engine": this is espeak-ng, and the
  // old wording read as though the reader's pronunciation rules were being
  // loaded here. They are applied in generate(), by normalizeForPocketTts.
  status('Loading phoneme engine...');
  // espeak-ng compiled to WASM, self-hosted alongside the model. The bundle
  // makes no external requests, which is what keeps narration working offline
  // and inside the COEP-isolated session.
  // Must run BEFORE the import: the data package unpacks during module
  // evaluation, so patching afterwards would be too late.
  _installStreamAsyncIteratorPolyfill();
  const module = await withTimeout(import(PHONEMIZER_URL), MODEL_TIMEOUT_MS, 'phonemizer import');
  phonemize = module.phonemize || module.default?.phonemize;
  if (typeof phonemize !== 'function') throw new Error('phonemizer module exposed no phonemize()');
}

async function loadVocab() {
  const response = await withTimeout(fetch(`${KOKORO_BASE}/tokenizer.json`), FETCH_TIMEOUT_MS, 'tokenizer');
  if (!response.ok) throw new Error(`tokenizer failed: HTTP ${response.status}`);
  const parsed = await response.json();
  vocab = parsed?.model?.vocab;
  if (!vocab || typeof vocab !== 'object') throw new Error('tokenizer.json carried no vocab');
}

async function loadModel() {
  status('Preparing narration model...');
  progress(30);
  const buffer = await fetchBuffer(`${KOKORO_BASE}/${MODEL_FILE}`, 'Kokoro model');
  progress(70);
  status('Preparing narration session...');
  // Declared so the main-thread silence watchdog does not mistake a long
  // blocking session build for a dead worker (see audio_core's phase budget).
  self.postMessage({
    type: 'status', status: 'Preparing narration session...', state: 'loading',
    phase: 'blocking', budgetMs: MODEL_TIMEOUT_MS,
  });

  // MEASURED AND RULED OUT, 2026-08-28 (rig + traces in tests/android-oom).
  //
  // On a 4 GB emulator with an iOS-style footprint budget, and excluding
  // Chrome's own 52 MB renderer cost, the app peaks near 400 MB right here:
  // +64 MB then +184 MB in two consecutive 250 ms samples. Steady-state
  // synthesis is only ~298-310 MB, so this transient is the whole problem —
  // an iPhone-class ~350 MB budget kills the tab before one paragraph caches.
  //
  // Two plausible causes were tried together and made no difference:
  //
  //   a) holding the ~86 MB download in a binding across the await, alongside
  //      the copy ORT makes in the WASM heap — released it before awaiting;
  //   b) graphOptimizationLevel 'all' materialising fresh optimised weight
  //      tensors on top of that copy — dropped to 'basic'.
  //
  // Peak before: 396, 400, 405 MB. Peak after: 373, 421 MB. The spread between
  // runs is wider than the effect, so neither is where the memory goes, and
  // 'basic' would have forgone real optimisations to buy nothing. Reverted.
  //
  // RESOLVED — it was the fp16 half, not the int8 half. ORT's WASM CPU backend
  // does not implement float16 at all, so every fp16 tensor was getting a Cast
  // to fp32 around it, doubling the memory those weights occupy. The old
  // model_q8f16.onnx is a WebGPU-oriented build and this worker is wasm-only.
  // See MODEL_FILE above: the model now loaded is the same int8 quantisation
  // without the fp16 conversion machinery.
  session = await withTimeout(
    ort.InferenceSession.create(buffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }),
    MODEL_TIMEOUT_MS,
    'Kokoro session initialization',
  );
  progress(90);
}

async function loadVoice(voiceId) {
  const id = String(voiceId || '').toLowerCase().trim();
  if (!id) throw new Error('No voice requested.');
  if (voiceCache.has(id)) return voiceCache.get(id);
  const buffer = await fetchBuffer(`${KOKORO_BASE}/voices/${id}.bin`, `voice ${id}`);
  const data = new Float32Array(buffer);
  if (data.length !== VOICE_ROWS * STYLE_DIM) {
    throw new Error(`voice ${id} has ${data.length} floats, expected ${VOICE_ROWS * STYLE_DIM}`);
  }
  // Only one voice is held at a time. Each table is 510 KB, which is trivial
  // next to the model, but this worker's whole reason for existing is not
  // accumulating things.
  voiceCache.clear();
  voiceCache.set(id, data);
  return data;
}

// Kokoro's style vector is chosen by the token count of the chunk being spoken,
// not by the voice alone. Row 0 is unused padding in the released tables.
function styleForTokenCount(voiceData, tokenCount) {
  const row = Math.max(0, Math.min(VOICE_ROWS - 1, tokenCount));
  return voiceData.slice(row * STYLE_DIM, (row + 1) * STYLE_DIM);
}

function tokenizePhonemes(phonemeString) {
  const ids = [];
  for (const symbol of Array.from(phonemeString)) {
    const id = vocab[symbol];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

// espeak splits on punctuation and DROPS the mark it split on, so rejoining the
// clauses with ", " flattened every sentence end, question and exclamation in a
// paragraph into one long comma-separated run. Kokoro's vocab carries
// . ! ? ; : — … and the quote marks, so the model was being denied prosody it
// can actually render -- the flat, unbroken delivery was ours, not the model's.
//
// Verified against the shipped phonemizer (1.2.1): the returned clause count
// equals the source mark count exactly, for commas, terminals, semicolons,
// colons, em dashes, and commas inside quotes. Where it does NOT line up the
// old join is used instead, because inventing a boundary is worse than a flat
// one.
const CLAUSE_MARK_RE = /[.!?;:,—…]+/g;

function clauseMarksFrom(text) {
  const marks = [];
  for (const match of String(text || '').matchAll(CLAUSE_MARK_RE)) {
    const run = match[0];
    // "..." is one pause, not three sentence ends, and Kokoro has a token for it.
    marks.push(/^\.{2,}$/.test(run) ? '…' : run[0]);
  }
  return marks;
}

// How much audio ONE inference is allowed to produce.
//
// The graph's sequence axis tops out at 512, but filling it is what sets peak
// memory. Kokoro is non-autoregressive: it materialises the entire utterance in
// a single forward pass, and the vocoder's intermediates live at the 24 kHz
// output rate, so activation memory tracks output LENGTH, not parameter count.
//
// Measured in Chrome over identical paragraphs:
// Swept over identical text, peak against cap:
//   510 (the full axis) -> 592 MB      192 -> 355 MB
//   256                 -> 440 MB      128 -> 355 MB
// 192 is the knee: below it the peak stops falling, because what remains is not
// the chunk any more. Engine init alone is ~250 MB of that floor.
//
// For contrast, Pocket measured on the same harness: 356 MB at init and 482 MB
// at peak, i.e. only 69 MB of activations for the same 20 s, because it is
// autoregressive and only ever holds one frame. Kokoro trades that bounded
// activation cost for speed -- capping the chunk buys it back.
// 192 is the constrained-device cap. A device that is NOT memory-constrained
// can afford the 256 step (440 MB peak against 355 MB) and buys back inference
// count and seam count for it, so the cap follows the device class the main
// thread already reports rather than being one number for everything.
const CONSTRAINED_MAX_CHUNK_TOKENS = 192;
const ROOMY_MAX_CHUNK_TOKENS = 256;
let maxChunkTokens = CONSTRAINED_MAX_CHUNK_TOKENS;

function chunkTokenLimit() {
  return Math.max(32, Math.min(MAX_TOKENS - 2, maxChunkTokens));
}

// Phoneme string -> its words, each keeping the space that followed it, so
// rejoining is lossless and a split between them lands in a real word gap.
function wordPiecesOf(unitText) {
  const parts = String(unitText || '').split(' ');
  const pieces = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index]) continue;
    pieces.push(index < parts.length - 1 ? `${parts[index]} ` : parts[index]);
  }
  return pieces;
}

// Seams, in order of preference: between clauses, then between words, and only
// inside a word if a single word somehow exceeds the whole cap.
//
// The clause-preferring behaviour is what made a seam inaudible at the old
// 510-token cap, and it is doing MORE work now: at 192 tokens (~48 words) a
// long sentence no longer fits, so the word-gap fallback is on the common path
// rather than the pathological one. Slicing token ids blindly there -- which is
// what the previous version did once a unit was oversized -- would put a cut
// inside a word, and that is exactly the artefact this cap must not introduce.
function packUnitsIntoChunks(units) {
  const limit = chunkTokenLimit();
  const chunks = [];
  let current = [];
  const flush = () => {
    if (current.length) { chunks.push(current); current = []; }
  };
  // Both call sites below only reach this with ids that already fit, but an
  // oversized chunk would be handed to a graph whose sequence axis is 512 and
  // fail at inference rather than here -- so the invariant is enforced, not
  // assumed.
  const add = (ids) => {
    if (ids.length > limit) {
      flush();
      for (let index = 0; index < ids.length; index += limit) {
        chunks.push(ids.slice(index, index + limit));
      }
      return;
    }
    if (current.length + ids.length > limit) flush();
    current = current.length ? current.concat(ids) : ids.slice();
  };

  for (const unit of units) {
    const ids = tokenizePhonemes(unit);
    if (!ids.length) continue;
    if (ids.length <= limit) { add(ids); continue; }

    flush();
    for (const word of wordPiecesOf(unit)) {
      const wordIds = tokenizePhonemes(word);
      if (!wordIds.length) continue;
      if (wordIds.length > limit) {
        flush();
        for (let index = 0; index < wordIds.length; index += limit) {
          chunks.push(wordIds.slice(index, index + limit));
        }
        continue;
      }
      add(wordIds);
    }
  }
  flush();
  return chunks;
}

async function runChunk(tokenIds, voiceData, speed) {
  const padded = [0, ...tokenIds, 0];
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(padded.map(BigInt)), [1, padded.length]),
    style: new ort.Tensor('float32', styleForTokenCount(voiceData, tokenIds.length), [1, STYLE_DIM]),
    speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
  };
  const output = await session.run(feeds);
  const first = output[session.outputNames[0]];
  return first.data instanceof Float32Array ? first.data : Float32Array.from(first.data);
}

async function generate(text, voiceId, opts = {}) {
  if (!isReady) throw new Error('Kokoro engine is not initialized.');
  const speed = Math.max(0.5, Math.min(2, Number(opts.speed) || 1));
  const voiceData = await loadVoice(voiceId);
  // phonemize() returns an ARRAY, one entry per clause, splitting ON
  // punctuation and dropping the mark ("Hello there, this is a test." ->
  // ["həlˈoʊ ðˈɛɹ", "ðɪs ɪz ɐ tˈɛst"]). Putting the real mark back is
  // what lets the model render a question as a question. See clauseMarksFrom.
  // keepClausePunctuation: Kokoro's vocab carries the em-dash and clauseMarksFrom
  // splits on it, so the Pocket cadence hack that flattens em-dashes to commas
  // would cost a pause this engine can actually render.
  const spoken = normalizeForPocketTts(String(text || ''), {
    pronunciationOverrides: opts.pronunciationOverrides || [],
    keepClausePunctuation: true,
  });
  const phonemes = await phonemize(spoken, 'en-us');
  const clauses = (Array.isArray(phonemes) ? phonemes : [String(phonemes || '')])
    .map((clause) => String(clause || '').trim())
    .filter(Boolean);
  if (!clauses.length) return new Float32Array(0);

  // Counted on the normalised string, not the raw one: alignment is a
  // mark-count-vs-clause-count comparison, and normalisation can add or remove
  // marks (a stripped [2s] tag, an expanded contraction).
  const marks = clauseMarksFrom(spoken);
  const aligned = marks.length === clauses.length;
  const units = clauses.map((clause, index) => {
    const mark = aligned ? marks[index] : (index < clauses.length - 1 ? ',' : '');
    // Trailing space between clauses; the vocab has one, and without it two
    // clauses run together as a single word.
    return `${clause}${mark}${index < clauses.length - 1 ? ' ' : ''}`;
  });


  const pieces = [];
  let total = 0;
  const chunks = packUnitsIntoChunks(units);
  if (!chunks.length) return new Float32Array(0);
  for (const chunk of chunks) {
    // Cancelling must FAIL the request, not resolve it short. Breaking out and
    // returning what had been produced so far reported generate_done with
    // truncated audio, and the caller has no way to know it is incomplete — it
    // caches it, so a paragraph interrupted once stays half-spoken forever.
    if (cancelRequested) throw new Error('Narration cancelled.');
    const audio = await runChunk(chunk, voiceData, speed);
    pieces.push(audio);
    total += audio.length;
  }
  if (pieces.length !== chunks.length) throw new Error('Narration ended before every chunk was rendered.');
  if (pieces.length === 1) return pieces[0];
  const merged = new Float32Array(total);
  let offset = 0;
  for (const piece of pieces) {
    merged.set(piece, offset);
    offset += piece.length;
  }
  return merged;
}

self.onmessage = async (event) => {
  const data = event.data || {};
  const { type } = data;

  if (type === 'init') {
    try {
      cancelRequested = false;
      // An explicit cap wins (the measurement tools sweep it). Otherwise take
      // the device class the main thread sends: constrainedMemoryMode was
      // already in every init message and was being dropped on the floor here,
      // so the phone this engine exists for got the same cap as a desktop.
      maxChunkTokens = Number(data.maxChunkTokens) > 0
        ? Number(data.maxChunkTokens)
        : (data.constrainedMemoryMode === false ? ROOMY_MAX_CHUNK_TOKENS : CONSTRAINED_MAX_CHUNK_TOKENS);
      progress(2);
      await loadOrtRuntime();
      progress(10);
      await loadVocab();
      await loadPhonemizer();
      await loadModel();
      isReady = true;
      progress(100);
      self.postMessage({
        type: 'init_done',
        engine: 'kokoro',
        telemetry: {
          selectedBackend: 'wasm',
          precision: 'q8f16',
          modelRevision: 'kokoro-82m-v1.0',
          sampleRate: SAMPLE_RATE,
          // Report what ORT was actually configured with. This was hardcoded to
          // 1 while the line above logs numThreads, so an isolated session that
          // started two threads told the Settings panel it had started one.
          threads: ort?.env?.wasm?.numThreads || 1,
          maxChunkTokens: chunkTokenLimit(),
        },
      });
      log('INFO', `Kokoro engine ready (single 86MB session, non-autoregressive, chunk cap ${chunkTokenLimit()})`);
    } catch (error) {
      isReady = false;
      self.postMessage({ type: 'init_error', error: error?.message || String(error) });
    }
    return;
  }

  if (type === 'cancel_generation') {
    cancelRequested = true;
    return;
  }

  if (type === 'generate') {
    cancelRequested = false;
    try {
      const audio = await generate(data.text, data.voice, data.opts || {});
      self.postMessage(
        { type: 'generate_done', id: data.id, audio, sampleRate: SAMPLE_RATE },
        [audio.buffer],
      );
    } catch (error) {
      self.postMessage({
        type: 'generate_error',
        id: data.id,
        error: error?.message || String(error),
      });
    }
    return;
  }

  if (type === 'dispose_backend') {
    try { await session?.release?.(); } catch (_) {}
    session = null;
    voiceCache.clear();
    isReady = false;
    self.postMessage({ type: 'backend_disposed' });
  }
};
