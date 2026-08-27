// Deterministic end-to-end Pocket worker benchmark.
// Measures full text-to-PCM generation, per-stage telemetry, and browser memory
// for x1/x2/x4 WASM configurations while serving a selected local worker tree
// under Pocket Reader's production origin.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../tests/webkit-smoke/node_modules/playwright');

function parseArgs(argv) {
  const options = {
    assetRoot: 'public/assets/js',
    output: 'benchmark-results/pocket-pipeline-production.json',
    threads: [1, 2, 4],
    repeats: 3,
    throughputMode: true,
    constrainedMemoryMode: false,
    qualityMode: 'balanced',
    text: 'The moonlit library stood silent while Mara crossed the marble floor, listening for the clockwork bird hidden among the ancient books.',
    chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    voiceFile: 'voice-zero-pocket-pack/jodi_krangle_expressive_neutral.safetensors',
    voiceName: 'benchmark_voice',
    unifiedModel: '',
    ortModelDir: '',
    runtimeDir: '',
    ortModelBase: '',
    runtimeBase: '',
    backend: 'wasm',
    graphCapture: false,
    mimiProvider: 'wasm-threaded',
    syncGroupBlocks: 4,
    isolated: true,
    userAgent: '',
    workerCount: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--asset-root') options.assetRoot = value;
    else if (key === '--output') options.output = value;
    else if (key === '--threads') options.threads = value.split(',').map(Number);
    else if (key === '--repeats') options.repeats = Number(value);
    else if (key === '--text') options.text = value;
    else if (key === '--chrome') options.chrome = value;
    else if (key === '--voice-file') options.voiceFile = value;
    else if (key === '--unified-model') options.unifiedModel = value;
    else if (key === '--ort-model-dir') options.ortModelDir = value;
    else if (key === '--runtime-dir') options.runtimeDir = value;
    else if (key === '--ort-model-base') options.ortModelBase = value;
    else if (key === '--runtime-base') options.runtimeBase = value;
    else if (key === '--backend') options.backend = value === 'webgpu' ? 'webgpu' : 'wasm';
    else if (key === '--graph-capture') options.graphCapture = true;
    else if (key === '--mimi-provider') options.mimiProvider = value === 'webgpu-mixed' ? 'webgpu-mixed' : 'wasm-threaded';
    else if (key === '--sync-group-blocks') options.syncGroupBlocks = Number(value);
    else if (key === '--user-agent') options.userAgent = value;
    else if (key === '--workers') options.workerCount = Math.max(1, Number(value) || 1);
    else if (key === '--live-mode') options.throughputMode = false;
    else if (key === '--constrained') options.constrainedMemoryMode = true;
    else if (key === '--quality') options.qualityMode = 'quality';
    else if (key === '--non-isolated') options.isolated = false;
    else continue;
    if (!['--live-mode', '--constrained', '--quality', '--non-isolated', '--graph-capture'].includes(key)) index += 1;
  }
  options.assetRoot = resolve(options.assetRoot);
  options.output = resolve(options.output);
  options.chrome = resolve(options.chrome);
  options.voiceFile = resolve(options.voiceFile);
  options.unifiedModel = options.unifiedModel ? resolve(options.unifiedModel) : '';
  options.ortModelDir = options.ortModelDir ? resolve(options.ortModelDir) : '';
  options.runtimeDir = options.runtimeDir ? resolve(options.runtimeDir) : '';
  return options;
}

const options = parseArgs(process.argv.slice(2));
statSync(options.assetRoot);
statSync(options.chrome);
statSync(options.voiceFile);
if (options.unifiedModel) statSync(options.unifiedModel);
if (options.ortModelDir) statSync(options.ortModelDir);
if (options.runtimeDir) statSync(options.runtimeDir);
mkdirSync(dirname(options.output), { recursive: true });

const productionOrigin = 'https://alpharius6769.github.io';
const mime = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const isolatedHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

async function measureMemory(page) {
  return page.evaluate(async () => {
    if (typeof performance.measureUserAgentSpecificMemory === 'function') {
      try {
        const result = await Promise.race([
          performance.measureUserAgentSpecificMemory(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('memory measurement timeout')), 10_000)),
        ]);
        return { bytes: result.bytes, source: 'measureUserAgentSpecificMemory' };
      } catch (_) {}
    }
    return { bytes: performance.memory?.usedJSHeapSize || null, source: 'performance.memory' };
  });
}

async function measureBrowserProcessMemory(browserCdp) {
  try {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const ids = processInfo.map((entry) => Number(entry.id)).filter(Number.isFinite);
    if (!ids.length) return null;
    const command = [
      `$ids=@(${ids.join(',')})`,
      '$rows=Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64',
      '$rows | ConvertTo-Json -Compress',
    ].join('; ');
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim();
    const rows = raw ? JSON.parse(raw) : [];
    const values = Array.isArray(rows) ? rows : [rows];
    const typeById = new Map(processInfo.map((entry) => [Number(entry.id), entry.type]));
    const byType = {};
    let workingSetBytes = 0;
    let privateBytes = 0;
    for (const row of values) {
      const type = typeById.get(Number(row.Id)) || 'unknown';
      if (!byType[type]) byType[type] = { count: 0, workingSetBytes: 0, privateBytes: 0 };
      const workingSet = Number(row.WorkingSet64) || 0;
      const privateMemory = Number(row.PrivateMemorySize64) || 0;
      byType[type].count += 1;
      byType[type].workingSetBytes += workingSet;
      byType[type].privateBytes += privateMemory;
      workingSetBytes += workingSet;
      privateBytes += privateMemory;
    }
    return { workingSetBytes, privateBytes, byType };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

async function runThreadCount(browser, browserCdp, threads) {
  process.stderr.write(`[pipeline] x${threads}: starting\n`);
  const context = await browser.newContext(options.userAgent ? { userAgent: options.userAgent } : {});
  if (options.runtimeDir) {
    await context.route('**/onnxruntime/**', async (route) => {
      const filename = basename(new URL(route.request().url()).pathname);
      const path = resolve(options.runtimeDir, filename);
      if (!path.startsWith(`${options.runtimeDir}\\`) || !existsSync(path)) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { ...isolatedHeaders, 'Content-Type': mime[extname(path)] || 'application/octet-stream' },
        body: readFileSync(path),
      });
    });
  }
  if (options.runtimeBase) {
    await context.route('**/onnxruntime/**', async (route) => {
      if (route.request().url().startsWith(options.runtimeBase)) {
        await route.continue();
        return;
      }
      const filename = basename(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 302, headers: { Location: `${options.runtimeBase.replace(/\/$/, '')}/${filename}` } });
    });
  }
  if (options.ortModelDir) {
    await context.route('**/*_int8.onnx', async (route) => {
      const filename = basename(new URL(route.request().url()).pathname).replace(/\.onnx$/i, '.ort');
      const path = resolve(options.ortModelDir, filename);
      if (!path.startsWith(`${options.ortModelDir}\\`) || !existsSync(path)) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { ...isolatedHeaders, 'Content-Type': 'application/octet-stream' },
        body: readFileSync(path),
      });
    });
  }
  if (options.ortModelBase) {
    await context.route('**/*_int8.onnx', async (route) => {
      if (route.request().url().startsWith(options.ortModelBase)) {
        await route.continue();
        return;
      }
      const filename = basename(new URL(route.request().url()).pathname).replace(/\.onnx$/i, '.ort');
      await route.fulfill({ status: 302, headers: { Location: `${options.ortModelBase.replace(/\/$/, '')}/${filename}` } });
    });
  }
  if (options.unifiedModel) {
    await context.route('**/flow_lm_unified_block4_int8.onnx', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { ...isolatedHeaders, 'Content-Type': 'application/octet-stream' },
        body: readFileSync(options.unifiedModel),
      });
    });
  }
  await context.route(`${productionOrigin}/**`, async (route) => {
    try {
      const url = new URL(route.request().url());
      if (url.pathname === '/__pocket_pipeline_benchmark__') {
        await route.fulfill({
          status: 200,
          headers: {
            ...(options.isolated ? isolatedHeaders : { 'Cache-Control': 'no-store' }),
            'Content-Type': 'text/html; charset=utf-8',
          },
          body: '<!doctype html><meta charset="utf-8"><title>Pocket pipeline benchmark</title>',
        });
        return;
      }
      if (url.pathname.endsWith('/benchmark_worker.js')) {
        await route.fulfill({
          status: 200,
          headers: { ...isolatedHeaders, 'Content-Type': 'text/javascript; charset=utf-8' },
          body: readFileSync(resolve(options.assetRoot, 'pocket_worker.js')),
        });
        return;
      }
      if (url.pathname.endsWith('/benchmark_voice.safetensors')) {
        await route.fulfill({
          status: 200,
          headers: { ...isolatedHeaders, 'Content-Type': 'application/octet-stream' },
          body: readFileSync(options.voiceFile),
        });
        return;
      }
      if (options.unifiedModel && url.pathname.endsWith('/flow_lm_unified_block4_int8.onnx')) {
        await route.fulfill({
          status: 200,
          headers: { ...isolatedHeaders, 'Content-Type': 'application/octet-stream' },
          body: readFileSync(options.unifiedModel),
        });
        return;
      }
      const path = resolve(options.assetRoot, basename(url.pathname));
      if (!path.startsWith(`${options.assetRoot}\\`) && path !== options.assetRoot) throw new Error('invalid asset path');
      await route.fulfill({
        status: 200,
        headers: { ...isolatedHeaders, 'Content-Type': mime[extname(path)] || 'application/octet-stream' },
        body: readFileSync(path),
      });
    } catch (error) {
      await route.fulfill({ status: 404, body: String(error?.message || error) });
    }
  });

  const page = await context.newPage();
  const consoleMessages = [];
  page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
  await page.goto(`${productionOrigin}/__pocket_pipeline_benchmark__`, { waitUntil: 'load' });
  const initStarted = Date.now();
  const init = await page.evaluate(async ({
    threads, constrainedMemoryMode, voiceName, backend, graphCapture, mimiProvider, syncGroupBlocks, workerCount,
  }) => {
    const workers = Array.from({ length: workerCount }, () => new Worker('/assets/js/benchmark_worker.js', { type: 'module' }));
    const messages = Array.from({ length: workerCount }, () => []);
    const terminals = await Promise.all(workers.map((worker, workerIndex) => new Promise((resolveTerminal, rejectTerminal) => {
      const timeout = setTimeout(() => rejectTerminal(new Error(`Pocket worker ${workerIndex} initialization timed out.`)), 10 * 60 * 1000);
      worker.onmessage = (event) => {
        messages[workerIndex].push(event.data);
        if (event.data?.type === 'init_done' || event.data?.type === 'init_error') {
          clearTimeout(timeout);
          resolveTerminal(event.data);
        }
      };
      worker.onerror = (event) => {
        clearTimeout(timeout);
        rejectTerminal(new Error(event.message || `Pocket worker ${workerIndex} script failed.`));
      };
      worker.postMessage({
        type: 'init',
        constrainedMemoryMode,
        backendPreference: backend,
        selectedBackend: backend,
        wasmThreadCount: threads,
        wasmReferenceRtf: 0,
        graphCapture,
        mimiProvider,
        gpuSyncGroupBlocks: syncGroupBlocks,
      });
    })));
    const voiceBuffer = await (await fetch('/assets/voices/benchmark_voice.safetensors')).arrayBuffer();
    const view = new DataView(voiceBuffer);
    const headerLength = Number(view.getBigUint64(0, true));
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(voiceBuffer, 8, headerLength)));
    const voiceState = {};
    for (const key of Object.keys(header).filter((name) => name !== '__metadata__')) {
      const entry = header[key];
      const [start, end] = entry.data_offsets;
      const byteOffset = 8 + headerLength + start;
      const byteLength = end - start;
      let data;
      let dtype;
      if (entry.dtype === 'I64') {
        data = new BigInt64Array(voiceBuffer.slice(byteOffset, byteOffset + byteLength));
        dtype = 'int64';
      } else if (entry.dtype === 'BOOL') {
        data = new Uint8Array(voiceBuffer.slice(byteOffset, byteOffset + byteLength));
        dtype = 'bool';
      } else {
        data = new Float32Array(voiceBuffer.slice(byteOffset, byteOffset + byteLength));
        dtype = 'float32';
      }
      voiceState[key] = { data, shape: entry.shape, dtype };
    }
    await Promise.all(workers.map((worker, workerIndex) => new Promise((resolveVoice, rejectVoice) => {
      const timeout = setTimeout(() => rejectVoice(new Error(`Voice registration timed out for worker ${workerIndex}.`)), 120_000);
      const handler = (event) => {
        if (event.data?.type === 'voice_encoded' && event.data.voiceName === voiceName) {
          clearTimeout(timeout);
          worker.removeEventListener('message', handler);
          resolveVoice();
        } else if (event.data?.type === 'error') {
          clearTimeout(timeout);
          worker.removeEventListener('message', handler);
          rejectVoice(new Error(event.data.error));
        }
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ type: 'register_precompiled_voice', voiceName, voiceState });
    })));
    window.__pocketBenchmarkWorkers = workers;
    const flatMessages = messages.flat();
    return {
      terminal: terminals[0],
      terminals,
      telemetry: [...flatMessages].reverse().find((message) => message?.type === 'backend_selected')?.telemetry || null,
      diagnostics: flatMessages.filter((message) => message?.type === 'diagnostic').map((message) => message.message),
      fallbacks: flatMessages.filter((message) => message?.type === 'backend_fallback').map((message) => ({
        from: message.from,
        to: message.to,
        reason: message.reason,
      })),
    };
  }, {
    threads,
    constrainedMemoryMode: options.constrainedMemoryMode,
    voiceName: options.voiceName,
    backend: options.backend,
    graphCapture: options.graphCapture,
    mimiProvider: options.mimiProvider,
    syncGroupBlocks: options.syncGroupBlocks,
    workerCount: options.workerCount,
  });
  if (init.terminal?.type !== 'init_done') throw new Error(`Pocket init failed: ${JSON.stringify(init.terminal)}`);
  process.stderr.write(`[pipeline] x${threads}: initialized\n`);
  const memoryAfterInit = await measureMemory(page);
  const processMemoryAfterInit = await measureBrowserProcessMemory(browserCdp);
  process.stderr.write(`[pipeline] x${threads}: memory baseline recorded (${memoryAfterInit.source})\n`);

  const runs = [];
  for (let run = 0; run < options.repeats; run += 1) {
    process.stderr.write(`[pipeline] x${threads}: generation ${run + 1}/${options.repeats}\n`);
    const generation = await page.evaluate(async ({ text, throughputMode, qualityMode, run, voiceName }) => {
      const workers = window.__pocketBenchmarkWorkers;
      const started = performance.now();
      const runOne = (worker, workerIndex) => new Promise((resolveResult, rejectResult) => {
        const id = `benchmark-${run}-${workerIndex}`;
        const timeout = setTimeout(() => rejectResult(new Error('Pocket generation timed out.')), 10 * 60 * 1000);
        const runtimeEvents = [];
        const handler = (event) => {
          const data = event.data;
          if (data?.type === 'backend_fallback' || data?.type === 'diagnostic') {
            runtimeEvents.push({ type: data.type, reason: data.reason || data.message || '' });
          }
          if (data?.id !== id) return;
          if (data.type === 'complete' || data.type === 'generate_error') {
            clearTimeout(timeout);
            worker.removeEventListener('message', handler);
            if (data.type === 'generate_error') rejectResult(new Error(data.error));
            else resolveResult({ data, runtimeEvents });
          }
        };
        worker.addEventListener('message', handler);
        worker.postMessage({
          type: 'generate',
          id,
          text,
          voice: voiceName,
          opts: {
            throughputMode,
            qualityMode,
            allowBenchmarkQuality: qualityMode === 'quality',
          },
        });
      });
      const workerResults = await Promise.all(workers.map(runOne));
      const outputs = [];
      for (const { data: result, runtimeEvents } of workerResults) {
        const audio = result.audio;
        let sumSquares = 0;
        let peak = 0;
        let finite = true;
        for (let index = 0; index < audio.length; index += 1) {
          const value = audio[index];
          if (!Number.isFinite(value)) finite = false;
          sumSquares += value * value;
          peak = Math.max(peak, Math.abs(value));
        }
        const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
        outputs.push({
          telemetry: result.telemetry,
          runtimeEvents,
          audio: {
            samples: audio.length,
            sampleRate: result.sampleRate,
            durationSec: audio.length / result.sampleRate,
            finite,
            rms: Math.sqrt(sumSquares / Math.max(1, audio.length)),
            peak,
            sha256,
          },
        });
      }
      return {
        elapsedMs: performance.now() - started,
        workerCount: workers.length,
        totalAudioDurationSec: outputs.reduce((sum, output) => sum + output.audio.durationSec, 0),
        effectiveRealTimeFactor: (performance.now() - started) / 1000 / Math.max(0.001, outputs.reduce((sum, output) => sum + output.audio.durationSec, 0)),
        telemetry: outputs[0]?.telemetry || null,
        runtimeEvents: outputs.flatMap((output) => output.runtimeEvents),
        audio: outputs[0]?.audio || null,
        outputs,
      };
    }, {
      text: options.text,
      throughputMode: options.throughputMode,
      qualityMode: options.qualityMode,
      run,
      voiceName: options.voiceName,
    });
    generation.memory = await measureMemory(page);
    generation.processMemory = await measureBrowserProcessMemory(browserCdp);
    runs.push(generation);
    process.stderr.write(`[pipeline] x${threads}: generation ${run + 1} complete (${Math.round(generation.elapsedMs)}ms)\n`);
  }

  await page.evaluate(() => window.__pocketBenchmarkWorkers?.forEach((worker) => worker.terminate()));
  await context.close();
  return {
    threads,
    initElapsedMs: Date.now() - initStarted,
    init,
    memoryAfterInit,
    processMemoryAfterInit,
    runs,
    consoleMessages,
  };
}

const browser = await chromium.launch({ executablePath: options.chrome, headless: true });
const browserCdp = await browser.newBrowserCDPSession();
const generatedAt = new Date().toISOString();
try {
  const results = [];
  for (const threads of options.threads) results.push(await runThreadCount(browser, browserCdp, threads));
  const report = {
    schemaVersion: 1,
    generatedAt,
    assetRoot: options.assetRoot,
    text: options.text,
    throughputMode: options.throughputMode,
    constrainedMemoryMode: options.constrainedMemoryMode,
    qualityMode: options.qualityMode,
    isolated: options.isolated,
    userAgent: options.userAgent || null,
    backend: options.backend,
    graphCapture: options.graphCapture,
    mimiProvider: options.mimiProvider,
    syncGroupBlocks: options.syncGroupBlocks,
    workerCount: options.workerCount,
    workerSha256: createHash('sha256').update(readFileSync(resolve(options.assetRoot, 'pocket_worker.js'))).digest('hex'),
    results,
  };
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser.close();
}
