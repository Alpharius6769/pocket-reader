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

async function loadPhonemizer() {
  status('Loading pronunciation engine...');
  // espeak-ng compiled to WASM, self-hosted alongside the model. The bundle
  // makes no external requests, which is what keeps narration working offline
  // and inside the COEP-isolated session.
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
  const buffer = await fetchBuffer(`${KOKORO_BASE}/model_q8f16.onnx`, 'Kokoro model');
  progress(70);
  status('Preparing narration session...');
  // Declared so the main-thread silence watchdog does not mistake a long
  // blocking session build for a dead worker (see audio_core's phase budget).
  self.postMessage({
    type: 'status', status: 'Preparing narration session...', state: 'loading',
    phase: 'blocking', budgetMs: MODEL_TIMEOUT_MS,
  });
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

// The graph's sequence axis is fixed at 512 including the two boundary zeros.
// This used to slice the token stream every 510 ids, which lands wherever it
// lands -- mid-word, mid-diphthong -- and the two halves were then rendered as
// separate utterances and concatenated, so a long paragraph got an audible
// fracture in the middle of a word. Packing whole clauses instead means a seam
// can only ever fall where the writing already had a pause. Only a single
// clause longer than the whole sequence axis is still hard-split, and that
// flushes what came before it first so the damage stays local.
function packUnitsIntoChunks(unitIds) {
  const limit = MAX_TOKENS - 2;
  const chunks = [];
  let current = [];
  for (const ids of unitIds) {
    if (ids.length > limit) {
      if (current.length) { chunks.push(current); current = []; }
      for (let index = 0; index < ids.length; index += limit) {
        chunks.push(ids.slice(index, index + limit));
      }
      continue;
    }
    if (current.length + ids.length > limit) {
      chunks.push(current);
      current = [];
    }
    current = current.length ? current.concat(ids) : ids.slice();
  }
  if (current.length) chunks.push(current);
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
  const phonemes = await phonemize(String(text || ''), 'en-us');
  const clauses = (Array.isArray(phonemes) ? phonemes : [String(phonemes || '')])
    .map((clause) => String(clause || '').trim())
    .filter(Boolean);
  if (!clauses.length) return new Float32Array(0);

  const marks = clauseMarksFrom(text);
  const aligned = marks.length === clauses.length;
  const units = clauses.map((clause, index) => {
    const mark = aligned ? marks[index] : (index < clauses.length - 1 ? ',' : '');
    // Trailing space between clauses; the vocab has one, and without it two
    // clauses run together as a single word.
    return `${clause}${mark}${index < clauses.length - 1 ? ' ' : ''}`;
  });

  const unitIds = units.map(tokenizePhonemes).filter((ids) => ids.length);
  if (!unitIds.length) return new Float32Array(0);

  const pieces = [];
  let total = 0;
  const chunks = packUnitsIntoChunks(unitIds);
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
          threads: 1,
        },
      });
      log('INFO', 'Kokoro engine ready (single 86MB session, non-autoregressive)');
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
