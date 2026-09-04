/* kitten_worker.js - KittenTTS Nano narration worker for the lightest tier.

   WHY THIS EXISTS
   Measured on the 4 GB rig (tests/android-oom): Kokoro's session costs +275 MB
   resident, Kitten Nano's costs +23 MB - 12x less, on a model that builds its
   session in 640 ms rather than 1690 ms. That is the difference between fitting
   an iPhone 13's ~400-450 MB budget and not.

   WHY IT IS A SEPARATE FILE RATHER THAN A FLAG ON kokoro_worker
   The two are close but not the same, and Kokoro is the currently-working path.
   KittenTTS is StyleTTS2 like Kokoro, with IDENTICAL graph inputs (input_ids,
   style, speed) and near-identical phoneme ids - of 103 shared symbols, 101
   match. But the VOICE FORMAT differs in kind: Kokoro ships a (510, 1, 256)
   table indexed by the token count of the chunk being spoken, while Kitten ships
   ONE 256-float vector per voice. Threading that through the live engine as a
   conditional would risk the tier that already works to save duplication.
*/
import { normalizeForPocketTts } from './tts_pronunciation_core.js?v=pron-v32';

self.postMessage({ type: 'status', status: 'Worker Thread Started', state: 'idle' });

const PROXY_BASE_URL = self.PR_PROXY_BASE || 'https://pocket-reader-proxy.alpharius67.workers.dev';
const KITTEN_BASE = `${PROXY_BASE_URL}/models/kitten/v0.1`;
// Deliberately the SAME espeak bundle Kokoro uses, not a copy: both engines
// are StyleTTS2 and their vocabularies agree on 101 of 103 shared symbols, so
// a reader who switches tiers pays no second 890 KB download.
const PHONEMIZER_URL = `${PROXY_BASE_URL}/models/kokoro/phonemizer/1.2.1/phonemizer.js`;
const ORT_BASE = `${PROXY_BASE_URL}/models/onnxruntime/1.27.0/`;

const SAMPLE_RATE = 24000;
// Upper bound on tokens handed to one inference. Longer phoneme runs are split
// rather than truncated, so no audio is ever silently dropped.
//
// INHERITED FROM KOKORO AND NOT MEASURED HERE. Kokoro's 512 comes from its voice
// table having 510 rows, which its style lookup indexes by token count; Kitten
// has no such table, so nothing about this number is derived from this model.
// input_ids is [1, sequence_length] with a dynamic axis in both exports, so it
// is a chosen cap rather than a graph limit. It is kept because a bound is worth
// having, not because it is the right bound.
const MAX_TOKENS = 512;
// Kitten's style vector is 256 floats, one per voice - no per-length table.
const STYLE_DIM = 256;

// The only export onnx-community publishes for Kitten Nano, and the one that was
// measured: +23 MB resident against Kokoro's +275 MB. It carries no f16 in its
// name and needs none - ORT's wasm CPU backend cannot execute float16, which is
// why the equivalent Kokoro swap was tried and reverted (see kokoro_worker.js).
const MODEL_FILE = 'model_quantized.onnx';

const MODEL_TIMEOUT_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 90000;
// How long a body read may produce nothing before the download is called dead.
// Deliberately much smaller than FETCH_TIMEOUT_MS: this is an IDLE timeout
// between chunks, not a budget for the whole transfer, so a slow-but-alive
// connection is never cut off while a stalled one fails quickly.
const STREAM_IDLE_TIMEOUT_MS = 25000;
// Throttle for the progress messages below. Frequent enough to keep the
// main-thread watchdog fed and the percentage moving, rare enough not to flood
// the message port during a fast download.
const STREAM_PROGRESS_INTERVAL_MS = 750;

// Ceiling on WASM threads for this engine, whatever the device policy asks for.
const MAX_WASM_THREADS = 4;
// Set from the init message before loadOrtRuntime() runs. 0 means "nothing was
// sent" -- a worker constructed directly by the measurement tools -- and falls
// back to the conservative pair this used to hardcode for everyone.
let requestedThreadCount = 0;

let ort = null;
let session = null;
let phonemize = null;
let vocab = null;
let isReady = false;
let cancelRequested = false;
// Filled by the last generate() and shipped with its result. See the note in
// generate() for why a bare millisecond count was not enough.
let lastGenerateTelemetry = null;
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
  let lastReportAt = 0;
  while (true) {
    // Per-chunk deadline, not a whole-download one. The timeout above only
    // covers the response HEADERS -- fetch() resolves as soon as they arrive --
    // so before this the body read had no deadline at all and a stalled stream
    // simply never returned. This measures the stall, so a slow connection is
    // still allowed to finish while a dead one fails in seconds.
    const { done, value } = await withTimeout(
      reader.read(), STREAM_IDLE_TIMEOUT_MS, `${label} download stalled`,
    );
    if (done) break;
    if (filled + value.byteLength > out.byteLength) {
      await reader.cancel().catch(() => {});
      throw new Error(`${label} exceeded its declared length`);
    }
    out.set(value, filled);
    filled += value.byteLength;
    // Proof of life, throttled. audio_core's startup watchdog allows 75 s of
    // silence, and this download used to produce every second of it: the 86 MB
    // model takes ~69 s on the 10 Mbps link the reporting phone was on, so
    // Kokoro sat nine percent inside the budget on a good connection and
    // outside it on any worse one. It also fills in the byte-level
    // "Downloading model weights..." status that was already written for it.
    const now = Date.now();
    if (now - lastReportAt >= STREAM_PROGRESS_INTERVAL_MS) {
      lastReportAt = now;
      self.postMessage({
        type: 'progress',
        info: {
          status: 'progress',
          progress: Math.round((filled / out.byteLength) * 100),
          loadedBytes: filled,
          totalBytes: out.byteLength,
          asset: label,
        },
      });
    }
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
  //
  // The count comes from the main thread's device policy, which was already in
  // every init message and was being ignored here -- so a Pixel 6 Pro ran this
  // 15M-parameter model on 2 threads while Pocket's autoregressive one got 4.
  //
  // Deferring to the policy keeps the caution this used to hardcode: it returns
  // 2 on iOS (two performance cores; extra threads stall ORT's per-layer
  // barrier on the E-cores), 2 on budget Androids and on desktop, and only
  // reaches 4 on a flagship whose big cores can hold them.
  //
  // Still capped at 4. One non-autoregressive pass has less to gain per thread
  // than Pocket's loop, and each thread carries its own stack and arena, so this
  // raises the ceiling rather than removing it.
  const isolated = self.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
  const requested = Number(requestedThreadCount) || 0;
  const fallback = Math.min(2, self.navigator?.hardwareConcurrency || 1);
  ort.env.wasm.numThreads = isolated
    ? Math.max(1, Math.min(MAX_WASM_THREADS, requested || fallback))
    : 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  log('INFO', `Kitten runtime: threaded WASM x${ort.env.wasm.numThreads}, isolated=${isolated}`);
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
  const response = await withTimeout(fetch(`${KITTEN_BASE}/tokenizer.json`), FETCH_TIMEOUT_MS, 'tokenizer');
  if (!response.ok) throw new Error(`tokenizer failed: HTTP ${response.status}`);
  const parsed = await response.json();
  vocab = parsed?.model?.vocab;
  if (!vocab || typeof vocab !== 'object') throw new Error('tokenizer.json carried no vocab');
}

async function loadModel() {
  status('Preparing narration model...');
  progress(30);
  const buffer = await fetchBuffer(`${KITTEN_BASE}/${MODEL_FILE}`, 'Kitten model');
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
    'Kitten session initialization',
  );
  progress(90);
}

// Supplied by the main thread at init, from the one voice catalog. Empty means
// "not told", and the check below is skipped rather than guessed at.
let ownVoiceIds = null;

async function loadVoice(voiceId) {
  const id = String(voiceId || '').toLowerCase().trim();
  if (!id) throw new Error('No voice requested.');
  // An id from another engine is not a missing file. Reporting it as one turns
  // a routing bug into a 404 per paragraph that reads as a network problem.
  if (ownVoiceIds && ownVoiceIds.size && !ownVoiceIds.has(id)) {
    throw new Error(`'${id}' is not a Kitten voice -- this worker was handed another engine's voice id.`);
  }
  if (voiceCache.has(id)) return voiceCache.get(id);
  const buffer = await fetchBuffer(`${KITTEN_BASE}/voices/${id}.bin`, `voice ${id}`);
  const data = new Float32Array(buffer);
  // THE difference from Kokoro. Kitten ships one 256-float style vector per
  // voice (1024 bytes), not a (510, 1, 256) table indexed by token count. Any
  // other length means a Kokoro asset has been pointed at this engine - exactly
  // the cross-engine leak the voice contract in pocket_backend_policy exists to
  // prevent - so it fails loudly rather than emitting noise.
  if (data.length !== STYLE_DIM) {
    throw new Error(
      `voice ${id} has ${data.length} floats, expected ${STYLE_DIM}. `
      + 'That length is a Kokoro voice table; Kitten voices are a single vector.',
    );
  }
  voiceCache.clear();
  voiceCache.set(id, data);
  return data;
}

// Kokoro picks a style row by the chunk's token count. Kitten has exactly one
// vector per voice, so the count is irrelevant; the signature is kept only so
// the call site below reads the same in both workers.
function styleForTokenCount(voiceData, _tokenCount) {
  return voiceData;
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
// The mechanism carries over from Kokoro and is why a cap exists at all: both
// engines are non-autoregressive, so the whole utterance is materialised in a
// single forward pass and the vocoder's intermediates live at the 24 kHz output
// rate. Activation memory therefore tracks output LENGTH, not parameter count,
// and a smaller model does NOT automatically mean smaller activations.
//
// THE NUMBERS ARE NOT MEASURED FOR THIS MODEL. Kokoro's sweep (510 -> 592 MB,
// 256 -> 440 MB, 192 -> 355 MB, knee at 192) described an engine whose session
// alone costs +275 MB resident; Kitten's costs +23 MB, so those figures cannot
// be assumed to transfer and are deliberately not repeated here as if they did.
// The caps below are Kokoro's, carried over as a conservative starting point.
//
// Re-measuring them for Kitten is a real task: tests/android-oom has the rig,
// and maxChunkTokens is already overridable from the init message so a sweep
// needs no code change.
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
// ── Clause prosody ──────────────────────────────────────────────────────────
// Two things were missing here that Pocket has had all along.
//
// 1. SEAM SILENCE. A paragraph is packed into chunks and each chunk is a
//    separate inference, then the results were concatenated with merged.set()
//    at zero offset -- back to back, no gap at all. The model renders the
//    punctuation INSIDE a chunk (that is what putting the marks back buys), but
//    it cannot know a chunk boundary happened, so two sentences split across
//    chunks ran together with no breath between them. That is the flat,
//    hurried delivery on long paragraphs, and it got worse the longer the
//    paragraph, because longer paragraphs mean more seams.
//
// 2. PACE SHAPE. speed was one scalar for the whole paragraph. Real narration
//    slows into a full stop and carries on through a comma. The shaping below
//    is deliberately small -- a few percent -- because the failure mode of
//    overdoing it is seasick delivery that sounds worse than flat.
//
// The pause table is Pocket's PUNCT_PAUSE_SEC verbatim, so a reader switching
// engines hears the same breathing rather than a different narrator.
const PUNCT_PAUSE_SEC = {
  '.': 0.38, '!': 0.42, '?': 0.42, '\u2026': 0.60,
  ',': 0.18, ';': 0.26, ':': 0.26, '\u2014': 0.28,
};
const DEFAULT_SEAM_PAUSE_SEC = 0.12;
const PARAGRAPH_TAIL_PAUSE_SEC = 0.5;

// A terminal mark gets a slight ritardando, a comma keeps its pace. Clamped
// tight: this is phrasing, not a tempo effect.
const CLAUSE_SPEED_SCALE = {
  '.': 0.97, '!': 0.98, '?': 0.98, '\u2026': 0.95,
  ',': 1.0, ';': 0.99, ':': 0.99, '\u2014': 0.99,
};

function pauseAfterMark(mark, expressive) {
  if (!expressive) return 0;
  if (!mark) return DEFAULT_SEAM_PAUSE_SEC;
  const sec = PUNCT_PAUSE_SEC[mark];
  return sec == null ? DEFAULT_SEAM_PAUSE_SEC : sec;
}

function speedForMark(baseSpeed, mark, expressive) {
  if (!expressive || !mark) return baseSpeed;
  const scale = CLAUSE_SPEED_SCALE[mark];
  const shaped = scale == null ? baseSpeed : baseSpeed * scale;
  // Never leave the range the graph was exported for, whatever the base is.
  return Math.max(0.5, Math.min(2, shaped));
}

function silenceFrames(seconds, sampleRate) {
  const frames = Math.max(0, Math.round((Number(seconds) || 0) * sampleRate));
  return frames > 0 ? new Float32Array(frames) : null;
}

function packUnitsIntoChunks(units, unitMarks = []) {
  const limit = chunkTokenLimit();
  const chunks = [];
  const chunkMarks = [];
  let current = [];
  let currentMark = '';
  // The mark a chunk ends on is the mark of the LAST unit packed into it. A
  // chunk split mid-unit (an oversized clause) ends on nothing, and correctly
  // gets the neutral seam pause rather than a full stop it never reached.
  const flush = () => {
    if (current.length) { chunks.push(current); chunkMarks.push(currentMark); current = []; currentMark = ''; }
  };
  // Both call sites below only reach this with ids that already fit, but an
  // oversized chunk would be handed to a graph whose sequence axis is 512 and
  // fail at inference rather than here -- so the invariant is enforced, not
  // assumed.
  const add = (ids, mark = '') => {
    if (ids.length > limit) {
      flush();
      for (let index = 0; index < ids.length; index += limit) {
        chunks.push(ids.slice(index, index + limit));
        chunkMarks.push(index + limit >= ids.length ? mark : '');
      }
      return;
    }
    if (current.length + ids.length > limit) flush();
    current = current.length ? current.concat(ids) : ids.slice();
    if (mark) currentMark = mark;
  };

  units.forEach((unit, unitIndex) => {
    const mark = unitMarks[unitIndex] || '';
    const ids = tokenizePhonemes(unit);
    if (!ids.length) return;
    if (ids.length <= limit) { add(ids, mark); return; }

    flush();
    const words = wordPiecesOf(unit);
    words.forEach((word, wordIndex) => {
      const wordIds = tokenizePhonemes(word);
      if (!wordIds.length) return;
      // Only the LAST piece of a split clause carries the clause's mark; the
      // pieces before it are mid-sentence and must not be given a full stop.
      const wordMark = wordIndex === words.length - 1 ? mark : '';
      if (wordIds.length > limit) {
        flush();
        for (let index = 0; index < wordIds.length; index += limit) {
          chunks.push(wordIds.slice(index, index + limit));
          chunkMarks.push(index + limit >= wordIds.length ? wordMark : '');
        }
        return;
      }
      add(wordIds, wordMark);
    });
  });
  flush();
  return { chunks, chunkMarks };
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
  if (!isReady) throw new Error('Kitten engine is not initialized.');
  const speed = Math.max(0.5, Math.min(2, Number(opts.speed) || 1));
  // Defaults ON: flat delivery was never a choice anyone made, it was the
  // absence of this code. Settings can still turn it off.
  const expressive = opts.expressive !== false;
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
  const unitMarks = clauses.map((clause, index) => (
    aligned ? marks[index] : (index < clauses.length - 1 ? ',' : '')
  ));
  const units = clauses.map((clause, index) => {
    const mark = unitMarks[index];
    // Trailing space between clauses; the vocab has one, and without it two
    // clauses run together as a single word.
    return `${clause}${mark}${index < clauses.length - 1 ? ' ' : ''}`;
  });


  const pieces = [];
  let total = 0;
  const { chunks, chunkMarks } = packUnitsIntoChunks(units, unitMarks);
  if (!chunks.length) return new Float32Array(0);
  let rendered = 0;
  // A render reported only its wall-clock milliseconds, so a field report of
  // "bad caching performance" carried no way to tell a slow device from a long
  // paragraph, a single-threaded session from a threaded one, or work from
  // waiting. An iPhone 13 Pro Max reporting "105358ms" for 274 characters could
  // not be analysed at all: every field the Pocket pipeline fills -- frames,
  // realTimeFactor, threads, backend -- is null for this engine.
  const startedAt = (self.performance || Date).now();
  let inferenceMs = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    // Cancelling must FAIL the request, not resolve it short. Breaking out and
    // returning what had been produced so far reported generate_done with
    // truncated audio, and the caller has no way to know it is incomplete — it
    // caches it, so a paragraph interrupted once stays half-spoken forever.
    if (cancelRequested) throw new Error('Narration cancelled.');
    const mark = chunkMarks[index] || '';
    const chunkStartedAt = (self.performance || Date).now();
    const audio = await runChunk(chunks[index], voiceData, speedForMark(speed, mark, expressive));
    // Model time only, so pauses and merging do not read as slow inference.
    inferenceMs += (self.performance || Date).now() - chunkStartedAt;
    pieces.push(audio);
    total += audio.length;
    rendered += 1;
    // Silence AFTER the chunk, sized to the punctuation the listener just
    // heard. The final chunk gets the paragraph tail instead, so consecutive
    // paragraphs do not run together either.
    const gapSec = index === chunks.length - 1
      ? (expressive ? PARAGRAPH_TAIL_PAUSE_SEC : 0)
      : pauseAfterMark(mark, expressive);
    const gap = silenceFrames(gapSec, SAMPLE_RATE);
    if (gap) { pieces.push(gap); total += gap.length; }
  }
  if (rendered !== chunks.length) throw new Error('Narration ended before every chunk was rendered.');
  lastGenerateTelemetry = {
    totalMs: Math.round((self.performance || Date).now() - startedAt),
    inferenceMs: Math.round(inferenceMs),
    audioDurationSec: Number((total / SAMPLE_RATE).toFixed(2)),
    // The number that makes renders comparable across devices and paragraph
    // lengths. Above 1.0 means synthesis is slower than listening, so caching
    // can never build a lead and playback cannot help but stall.
    realTimeFactor: total > 0
      ? Number((((self.performance || Date).now() - startedAt) / (total / SAMPLE_RATE) / 1000).toFixed(3))
      : null,
    chunks: chunks.length,
    phonemeChars: units.reduce((sum, unit) => sum + unit.length, 0),
    chunkTokenCap: chunkTokenLimit(),
    wasmThreads: ort?.env?.wasm?.numThreads || 1,
    isolated: self.crossOriginIsolated === true,
    speed,
    expressive,
  };
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
      // The voices this engine owns, from the main thread's single catalog.
      // Absent (an older page, a test harness) leaves the check in loadVoice
      // disabled rather than guessing at the list.
      ownVoiceIds = Array.isArray(data.voiceIds) && data.voiceIds.length
        ? new Set(data.voiceIds.map((v) => String(v || '').toLowerCase().trim()).filter(Boolean))
        : null;
      // An explicit cap wins (the measurement tools sweep it). Otherwise take
      // the device class the main thread sends: constrainedMemoryMode was
      // already in every init message and was being dropped on the floor here,
      // so the phone this engine exists for got the same cap as a desktop.
      maxChunkTokens = Number(data.maxChunkTokens) > 0
        ? Number(data.maxChunkTokens)
        : (data.constrainedMemoryMode === false ? ROOMY_MAX_CHUNK_TOKENS : CONSTRAINED_MAX_CHUNK_TOKENS);
      // Same reasoning as the line above: the main thread's device policy has
      // been sending this all along and this worker was answering with its own
      // constant instead.
      requestedThreadCount = Number(data.wasmThreadCount) || 0;
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
        engine: 'kitten',
        telemetry: {
          selectedBackend: 'wasm',
          precision: 'q8f16',
          modelRevision: 'kitten-nano-v0.1',
          sampleRate: SAMPLE_RATE,
          // Report what ORT was actually configured with. This was hardcoded to
          // 1 while the line above logs numThreads, so an isolated session that
          // started two threads told the Settings panel it had started one.
          threads: ort?.env?.wasm?.numThreads || 1,
          maxChunkTokens: chunkTokenLimit(),
        },
      });
      // Said "Kokoro engine ready (single 86MB session...)" -- a leftover from
      // cloning this worker off Kokoro's. Both halves were wrong: the engine
      // name and the size, since Kitten's model is roughly 12x smaller. This
      // is the ONLY line that confirms Kitten actually started, so anyone
      // debugging it was being told to look at the wrong engine.
      log('INFO', `Kitten engine ready (KittenTTS Nano 0.1, non-autoregressive, chunk cap ${chunkTokenLimit()})`);
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
      lastGenerateTelemetry = null;
      const audio = await generate(data.text, data.voice, data.opts || {});
      self.postMessage(
        {
          type: 'generate_done',
          id: data.id,
          audio,
          sampleRate: SAMPLE_RATE,
          telemetry: lastGenerateTelemetry,
        },
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
