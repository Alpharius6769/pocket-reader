// Reproducible Chromium benchmark for an ORT Web WASM runtime/model pair.
// It serves all assets with COOP/COEP, launches a fresh browser per thread
// count, and measures the deployed flow_lm_main_int8 decode graph.

import { createServer } from 'node:http';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../tests/webkit-smoke/node_modules/playwright');

function parseArgs(argv) {
  const values = {
    label: 'stock',
    kind: 'flow-main',
    simd: 'stock',
    threads: [1, 2, 4],
    iterations: 9,
    warmup: 2,
    runtimeDir: 'pocket-webgpu-build/npm/package/dist',
    moduleFile: 'ort.min.mjs',
    model: 'pocket-tts-onnx-b2-upload/onnx/english_2026-04/flow_lm_main_int8.onnx',
    bundle: 'pocket-tts-onnx-b2-upload/onnx/english_2026-04/bundle.json',
    output: '',
    preallocatedOutputs: false,
    chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const next = argv[index + 1];
    if (key === '--label') values.label = next;
    else if (key === '--kind') values.kind = next;
    else if (key === '--simd') values.simd = next;
    else if (key === '--threads') values.threads = next.split(',').map(Number);
    else if (key === '--iterations') values.iterations = Number(next);
    else if (key === '--warmup') values.warmup = Number(next);
    else if (key === '--runtime-dir') values.runtimeDir = next;
    else if (key === '--module-file') values.moduleFile = next;
    else if (key === '--model') values.model = next;
    else if (key === '--bundle') values.bundle = next;
    else if (key === '--output') values.output = next;
    else if (key === '--preallocated-outputs') {
      values.preallocatedOutputs = true;
      continue;
    }
    else if (key === '--chrome') values.chrome = next;
    else continue;
    index += 1;
  }
  values.runtimeDir = resolve(values.runtimeDir);
  values.model = resolve(values.model);
  values.bundle = resolve(values.bundle);
  values.output = values.output ? resolve(values.output) : '';
  values.chrome = resolve(values.chrome);
  return values;
}

const MIME = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

function headers(contentType) {
  return {
    'Content-Type': contentType,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

function benchmarkPage() {
  return `<!doctype html><meta charset="utf-8"><title>ORT WASM benchmark</title>
<script type="module">
import * as ortModule from '/ort/ort.min.mjs';
const ort = ortModule.default || ortModule;
const params = new URLSearchParams(location.search);
const threadCount = Number(params.get('threads') || 1);
const kind = params.get('kind') || 'flow-main';
const simd = params.get('simd') || 'stock';
const iterations = Number(params.get('iterations') || 9);
const warmup = Number(params.get('warmup') || 2);
const preallocatedOutputs = params.get('preallocatedOutputs') === 'true';

function makeData(dtype, shape, fill) {
  const size = shape.reduce((total, value) => total * value, 1);
  if (dtype === 'int64') return new BigInt64Array(size);
  if (dtype === 'bool') return new Uint8Array(size);
  const data = new Float32Array(size);
  if (fill === 'nan') data.fill(Number.NaN);
  return data;
}

async function run() {
  const started = performance.now();
  ort.env.wasm.wasmPaths = simd === 'relaxed'
    ? {
        mjs: new URL('/ort/ort-wasm-relaxedsimd-threaded.mjs', location.href).href,
        wasm: new URL('/ort/ort-wasm-relaxedsimd-threaded.wasm', location.href).href,
      }
    : '/ort/';
  ort.env.wasm.numThreads = threadCount;
  ort.env.wasm.simd = simd === 'relaxed' ? 'relaxed' : true;
  ort.env.wasm.proxy = false;
  const bundle = await (await fetch('/bundle.json')).json();
  const sessionStarted = performance.now();
  const session = await ort.InferenceSession.create('/model.onnx', {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
  const sessionCreationMs = performance.now() - sessionStarted;
  const unified = kind === 'unified-block4';
  const blockMatch = kind.match(/^block(2|4|6|8)$/);
  const blockFrames = unified ? 4 : (blockMatch ? Number(blockMatch[1]) : 1);
  // Normalize block benchmarks to at least eight generated frames per
  // sample, so block2/4/6/8 can be compared by per-frame cost.
  const runsPerSample = blockMatch || unified ? Math.ceil(8 / blockFrames) : 1;
  let feeds = kind === 'flow-main'
    ? {
        sequence: new ort.Tensor('float32', new Float32Array(32), [1, 1, 32]),
        text_embeddings: new ort.Tensor('float32', new Float32Array(0), [1, 0, 1024]),
      }
    : { sequence: new ort.Tensor('float32', new Float32Array(32), [1, 1, 32]) };
  if (unified) {
    feeds.decode_mode = new ort.Tensor('bool', new Uint8Array([1]), []);
    feeds.text_embeddings = new ort.Tensor('float32', new Float32Array(0), [1, 0, 1024]);
  }
  for (const spec of bundle.flow_lm_state_manifest) {
    const shape = spec.shape.map(Number);
    feeds[spec.input_name] = new ort.Tensor(spec.dtype, makeData(spec.dtype, shape, spec.fill), shape);
  }

  const samples = [];
  let output = null;
  let outputPools = null;
  let outputPoolIndex = 0;

  function cloneOutputTensor(tensor) {
    const Source = tensor.data.constructor;
    return new ort.Tensor(tensor.type, new Source(tensor.data.length), tensor.dims);
  }

  async function runSession(activeFeeds) {
    if (!preallocatedOutputs || !outputPools) {
      const result = await session.run(activeFeeds);
      if (preallocatedOutputs && !outputPools) {
        outputPools = [0, 1].map(() => Object.fromEntries(
          Object.entries(result).map(([name, tensor]) => [name, cloneOutputTensor(tensor)]),
        ));
      }
      return result;
    }
    const fetches = outputPools[outputPoolIndex];
    outputPoolIndex = 1 - outputPoolIndex;
    return session.run(activeFeeds, fetches);
  }

  for (let index = 0; index < warmup + iterations; index += 1) {
    const tick = performance.now();
    const randomFrames = blockFrames;
    for (let block = 0; block < runsPerSample; block += 1) {
      if (kind !== 'flow-main') {
        feeds.random_latents = new ort.Tensor(
          'float32', new Float32Array(randomFrames * 32), [1, randomFrames, 32],
        );
      }
      output = await runSession(feeds);
      if (kind !== 'flow-main') feeds.sequence = output.next_sequence;
      for (const spec of bundle.flow_lm_state_manifest) {
        if (output[spec.output_name]) feeds[spec.input_name] = output[spec.output_name];
      }
    }
    const elapsed = performance.now() - tick;
    if (index >= warmup) samples.push(elapsed);
    if (kind === 'flow-main') feeds.sequence = new ort.Tensor('float32', new Float32Array(32), [1, 1, 32]);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  await session.release();
  return {
    threadsRequested: threadCount,
    kind,
    simd,
    preallocatedOutputs,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
    sessionCreationMs,
    samplesMs: samples,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    generatedFramesPerSample: (blockMatch || unified) ? runsPerSample * blockFrames : 1,
    medianMsPerFrame: sorted[Math.floor(sorted.length / 2)]
      / ((blockMatch || unified) ? runsPerSample * blockFrames : 1),
    elapsedMs: performance.now() - started,
    jsHeapBytes: performance.memory?.usedJSHeapSize || null,
  };
}

run().then((result) => { window.__benchmarkResult = result; })
  .catch((error) => { window.__benchmarkError = error?.stack || String(error); });
</script>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const path of [options.runtimeDir, options.model, options.bundle, options.chrome]) statSync(path);

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/') {
        response.writeHead(200, headers('text/html; charset=utf-8'));
        response.end(benchmarkPage());
        return;
      }
      let path;
      if (url.pathname === '/model.onnx') path = options.model;
      else if (url.pathname === '/bundle.json') path = options.bundle;
      else if (url.pathname.startsWith('/ort/')) {
        let filename = decodeURIComponent(url.pathname.slice('/ort/'.length));
        if (!/^[A-Za-z0-9._-]+$/.test(filename)) throw new Error('Invalid runtime filename');
        if (filename === 'ort.min.mjs') filename = options.moduleFile;
        path = resolve(options.runtimeDir, filename);
        if (!path.startsWith(options.runtimeDir)) throw new Error('Runtime path escape');
      } else {
        response.writeHead(404, headers('text/plain; charset=utf-8'));
        response.end('not found');
        return;
      }
      const body = readFileSync(path);
      response.writeHead(200, { ...headers(MIME[extname(path)] || 'application/octet-stream'), 'Content-Length': body.length });
      response.end(body);
    } catch (error) {
      response.writeHead(500, headers('text/plain; charset=utf-8'));
      response.end(String(error));
    }
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  const results = [];
  try {
    for (const threads of options.threads) {
      const browser = await chromium.launch({
        executablePath: options.chrome,
        headless: true,
        args: ['--enable-precise-memory-info'],
      });
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/?threads=${threads}&iterations=${options.iterations}&warmup=${options.warmup}&kind=${encodeURIComponent(options.kind)}&simd=${encodeURIComponent(options.simd)}&preallocatedOutputs=${options.preallocatedOutputs}`);
        await page.waitForFunction(() => window.__benchmarkResult || window.__benchmarkError, null, { timeout: 180000 });
        const error = await page.evaluate(() => window.__benchmarkError || null);
        if (error) throw new Error(`x${threads} browser benchmark failed: ${error}`);
        results.push(await page.evaluate(() => window.__benchmarkResult));
      } finally {
        await browser.close();
      }
    }
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }

  const report = {
    schemaVersion: 1,
    label: options.label,
    kind: options.kind,
    simd: options.simd,
    preallocatedOutputs: options.preallocatedOutputs,
    generatedAt: new Date().toISOString(),
    runtimeDir: options.runtimeDir,
    moduleFile: options.moduleFile,
    runtimeWasmBytes: statSync(resolve(
      options.runtimeDir,
      options.simd === 'relaxed' ? 'ort-wasm-relaxedsimd-threaded.wasm' : 'ort-wasm-simd-threaded.wasm',
    )).size,
    model: options.model,
    modelBytes: statSync(options.model).size,
    results,
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) writeFileSync(options.output, rendered);
  process.stdout.write(rendered);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
