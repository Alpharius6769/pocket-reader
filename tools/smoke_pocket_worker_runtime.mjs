// End-to-end smoke test for Pocket's production module worker and live model proxy.
// Serves the deployable assets with COOP/COEP, initializes the WASM backend,
// and records the runtime flavor selected by the worker.

import { createServer } from 'node:http';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, basename, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../tests/webkit-smoke/node_modules/playwright');

const noWrite = process.argv.includes('--no-write');
const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const root = resolve(positional[0] || 'public/assets/js');
const output = resolve(positional[1] || 'benchmark-results/pocket-worker-runtime-smoke.json');
const chrome = resolve(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe');
statSync(root);
statSync(chrome);

const mime = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const commonHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

const pageHtml = `<!doctype html><meta charset="utf-8"><title>Pocket worker smoke</title>`;
const productionOrigin = 'https://alpharius6769.github.io';
const blockRelaxed = process.env.BLOCK_RELAXED === '1';
const expectedRuntimeFlavor = blockRelaxed ? 'stock-wasm-only' : 'relaxed-simd-minimal-ort';
const useLiveAssets = process.env.USE_LIVE_ASSETS === '1';

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, { ...commonHeaders, 'Content-Type': 'text/html; charset=utf-8' });
      response.end(pageHtml);
      return;
    }
    const fileName = basename(url.pathname);
    const path = resolve(root, fileName);
    if (!path.startsWith(`${root}\\`) && path !== root) throw new Error('invalid path');
    const body = readFileSync(path);
    response.writeHead(200, {
      ...commonHeaders,
      'Content-Type': mime[extname(path)] || 'application/octet-stream',
    });
    response.end(body);
  } catch (error) {
    response.writeHead(404, { ...commonHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(String(error?.message || error));
  }
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}/`;
const startedAt = Date.now();
let browser;

try {
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext();
  if (blockRelaxed) {
    await context.route('**/models/onnxruntime/1.27.0-relaxed/**', (route) => route.fulfill({
      status: 503,
      headers: { 'Access-Control-Allow-Origin': productionOrigin },
      body: 'relaxed runtime intentionally blocked by smoke test',
    }));
  }
  // Fulfill the app-origin files locally while retaining the exact production
  // Origin header expected by the Cloudflare model proxy.
  await context.route(`${productionOrigin}/**`, async (route) => {
    try {
      const url = new URL(route.request().url());
      if (url.pathname === '/' || url.pathname === '/__pocket_worker_smoke__') {
        const bootstrap = url.searchParams.get('bootstrap') === '1';
        await route.fulfill({
          status: 200,
          headers: bootstrap
            ? { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' }
            : { ...commonHeaders, 'Content-Type': 'text/html; charset=utf-8' },
          body: pageHtml,
        });
        return;
      }
      if (useLiveAssets) {
        await route.continue();
        return;
      }
      const path = resolve(root, basename(url.pathname));
      if (!path.startsWith(`${root}\\`) && path !== root) throw new Error('invalid path');
      await route.fulfill({
        status: 200,
        headers: { ...commonHeaders, 'Content-Type': mime[extname(path)] || 'application/octet-stream' },
        body: readFileSync(path),
      });
    } catch (error) {
      await route.fulfill({ status: 404, body: String(error?.message || error) });
    }
  });
  const page = await context.newPage();
  const consoleMessages = [];
  const networkErrors = [];
  page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => consoleMessages.push(`pageerror: ${error.stack || error}`));
  page.on('requestfailed', (request) => networkErrors.push({
    url: request.url(),
    error: request.failure()?.errorText || 'request failed',
  }));
  page.on('response', (response) => {
    if (response.status() >= 400) networkErrors.push({ url: response.url(), status: response.status() });
  });
  if (useLiveAssets) {
    await page.goto(`${productionOrigin}/__pocket_worker_smoke__?bootstrap=1`, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js?v=304', { scope: '/' });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolveController, rejectController) => {
          const timeout = setTimeout(() => rejectController(new Error('Service worker did not claim the smoke page.')), 30_000);
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            clearTimeout(timeout);
            resolveController();
          }, { once: true });
        });
      }
    });
    await page.goto(`${productionOrigin}/__pocket_worker_smoke__?tts_fast=1`, { waitUntil: 'load' });
  } else {
    await page.goto(`${productionOrigin}/__pocket_worker_smoke__`, { waitUntil: 'load' });
  }
  const result = await page.evaluate(async () => {
    const messages = [];
    const worker = new Worker('/assets/js/pocket_worker.js?v=pocket-worker-v101', { type: 'module' });
    const terminal = await new Promise((resolveTerminal, rejectTerminal) => {
      const timeout = setTimeout(() => rejectTerminal(new Error('Worker initialization timed out.')), 10 * 60 * 1000);
      worker.onmessage = (event) => {
        const data = event.data;
        messages.push(data);
        if (data?.type === 'init_done' || data?.type === 'init_error') {
          clearTimeout(timeout);
          resolveTerminal(data);
        }
      };
      worker.onerror = (event) => {
        clearTimeout(timeout);
        resolveTerminal({
          type: 'worker_script_error',
          error: event.message || 'Worker script error',
          filename: event.filename || '',
          line: event.lineno || 0,
          column: event.colno || 0,
        });
      };
      worker.postMessage({
        type: 'init',
        constrainedMemoryMode: false,
        backendPreference: 'wasm',
        selectedBackend: 'wasm',
        wasmThreadCount: 4,
        wasmReferenceRtf: 0,
      });
    });
    const telemetry = [...messages].reverse().find((item) => item?.type === 'backend_selected')?.telemetry || null;
    const diagnostics = messages
      .filter((item) => item?.type === 'diagnostic')
      .map((item) => item.message);
    worker.terminate();
    return {
      terminal,
      telemetry,
      diagnostics,
      messageTypeCounts: messages.reduce((counts, item) => {
        const type = item?.type || 'unknown';
        counts[type] = (counts[type] || 0) + 1;
        return counts;
      }, {}),
      crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency,
      userAgent: navigator.userAgent,
    };
  });
  const report = {
    ...result,
    elapsedMs: Date.now() - startedAt,
    consoleMessages,
    networkErrors,
    passed: result.terminal?.type === 'init_done'
      && result.telemetry?.selectedBackend === 'wasm'
      && result.telemetry?.ortWasmRuntimeFlavor === expectedRuntimeFlavor,
    expectedRuntimeFlavor,
  };
  if (!noWrite) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise((done) => server.close(done));
}
