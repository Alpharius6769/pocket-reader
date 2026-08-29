/* Diagnostic worker. Not referenced by the app — loaded only by
   tests/android-oom/runtime_vs_model.mjs.

   Answers one question: of the ~283 MB that session creation adds, how much is
   ONNX Runtime's fixed per-session cost and how much is Kokoro's weights?
   A reported 2 KB model triggers a ~300 MB session allocation
   (microsoft/onnxruntime#18165); if that reproduces here, no model change of any
   size can help and the remaining scoping options collapse to one.

   Mirrors kokoro_worker.js's ORT setup EXACTLY — same pinned binaries, same
   thread rule, same simd/proxy/logLevel — or the comparison measures the setup
   rather than the model.

   Named *_worker.js so the service worker stamps it with the isolation headers
   (see sw.js); without them it dies on construction inside ?tts_fast=1. */

const PROXY_BASE_URL = self.PR_PROXY_BASE || 'https://pocket-reader-proxy.alpharius67.workers.dev';
const ORT_BASE = `${PROXY_BASE_URL}/models/onnxruntime/1.27.0/`;

let ort = null;
const say = (stage, extra = {}) => self.postMessage({ type: 'probe', stage, ...extra });

async function loadRuntime() {
  const module = await import(`${ORT_BASE}ort.min.mjs`);
  ort = module.default || module;
  ort.env.wasm.wasmPaths = {
    mjs: `${ORT_BASE}ort-wasm-simd-threaded.mjs`,
    wasm: `${ORT_BASE}ort-wasm-simd-threaded.wasm`,
  };
  const isolated = self.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
  ort.env.wasm.numThreads = isolated ? Math.min(2, self.navigator?.hardwareConcurrency || 1) : 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  say('runtime_ready', { isolated, threads: ort.env.wasm.numThreads });
}

self.onmessage = async (e) => {
  const { cmd, url } = e.data || {};
  try {
    if (cmd === 'load_runtime') return await loadRuntime();
    if (cmd === 'create_session') {
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      say('model_fetched', { bytes: buf.byteLength });
      const t0 = performance.now();
      const session = await ort.InferenceSession.create(buf, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      say('session_created', {
        ms: Math.round(performance.now() - t0),
        inputs: session.inputNames,
      });
      // Held deliberately: we are measuring RESIDENT cost, so it must stay alive.
      self._session = session;
    }
  } catch (err) {
    say('error', { message: String(err && err.message || err).slice(0, 200) });
  }
};

self.postMessage({ type: 'probe', stage: 'worker_started' });
