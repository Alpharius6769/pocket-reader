// End-to-end smoke test for the Kokoro worker against the live model proxy.
//
// The Node suite can only prove that the wiring LOOKS right. Kokoro had six
// separate "engine name compared to the wrong literal" bugs and a service
// worker that withheld the COEP header its own worker needed, and every one of
// them passed every unit test — because none of them ran the model. This does:
// it initializes the real 86 MB session from the real proxy and synthesizes a
// real paragraph, then checks the samples are audio rather than silence.
//
//   node tools/smoke_kokoro_worker_runtime.mjs
//   node tools/smoke_kokoro_worker_runtime.mjs --no-write
//
// Requires Chrome and the playwright install under tests/webkit-smoke.

import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, basename, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../tests/webkit-smoke/node_modules/playwright');

const noWrite = process.argv.includes('--no-write');
const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const root = resolve(positional[0] || 'public/assets/js');
const output = resolve(positional[1] || 'benchmark-results/kokoro-worker-runtime-smoke.json');
const chrome = resolve(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe');
statSync(root);
statSync(chrome);

const mime = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// The Cloudflare model proxy reflects CORS only for the real app origins, so
// the page has to BE one. Playwright fulfills every request to it from the
// working tree; only the proxy fetches leave the machine.
const productionOrigin = 'https://alpharius6769.github.io';
const appPath = '/pocket-reader';
const pageHtml = '<!doctype html><meta charset="utf-8"><title>Kokoro worker smoke</title>';

// Exactly what sw.js stamps. A dedicated worker created by an isolated document
// will not start without these on its OWN script response, which is the bug
// this harness exists to keep fixed.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

const VOICE = process.env.KOKORO_VOICE || 'af_heart';
const TEXT = process.env.KOKORO_TEXT
  || 'The lantern guttered once, and then the corridor was very quiet indeed.';

const startedAt = Date.now();
let browser;

try {
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext();

  await context.route(`${productionOrigin}/**`, async (route) => {
    try {
      const url = new URL(route.request().url());
      if (url.pathname === `${appPath}/__kokoro_smoke__`) {
        await route.fulfill({
          status: 200,
          headers: { ...isolationHeaders, 'Content-Type': 'text/html; charset=utf-8' },
          body: pageHtml,
        });
        return;
      }
      const path = resolve(root, basename(url.pathname));
      if (!path.startsWith(`${root}\\`) && path !== root) throw new Error('invalid path');
      await route.fulfill({
        status: 200,
        headers: { ...isolationHeaders, 'Content-Type': mime[extname(path)] || 'application/octet-stream' },
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

  await page.goto(`${productionOrigin}${appPath}/__kokoro_smoke__`, { waitUntil: 'load' });

  const result = await page.evaluate(async ({ appPath: base, voice, text }) => {
    const messages = [];
    const worker = new Worker(`${base}/assets/js/kokoro_worker.js?v=kokoro-v7`, { type: 'module' });
    const record = (data) => {
      if (data?.type === 'generate_done') messages.push({ type: 'generate_done', id: data.id });
      else messages.push(data);
    };

    const waitFor = (types, timeoutMs, label) => new Promise((settle) => {
      const timer = setTimeout(() => settle({ type: 'timeout', error: `${label} timed out` }), timeoutMs);
      worker.addEventListener('message', function onMessage(event) {
        record(event.data);
        if (!types.includes(event.data?.type)) return;
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        settle(event.data);
      });
      worker.addEventListener('error', function onError(event) {
        clearTimeout(timer);
        worker.removeEventListener('error', onError);
        // A COEP refusal arrives as a bare Event with no message at all.
        settle({
          type: 'worker_script_error',
          error: event.message || 'Worker script failed to load (no message — check COEP headers)',
          filename: event.filename || '',
          line: event.lineno || 0,
        });
      }, { once: true });
    });

    const initPromise = waitFor(['init_done', 'init_error', 'worker_script_error'], 10 * 60 * 1000, 'init');
    worker.postMessage({ type: 'init', voiceEngine: 'pocket' });
    const init = await initPromise;

    let generation = null;
    let audioStats = null;
    if (init?.type === 'init_done') {
      const generated = waitFor(['generate_done', 'generate_error', 'worker_script_error'], 5 * 60 * 1000, 'generate');
      worker.postMessage({ type: 'generate', id: 'smoke-1', text, voice, opts: { speed: 1 } });
      const done = await generated;
      generation = { type: done?.type, error: done?.error || null, sampleRate: done?.sampleRate || null };
      const audio = done?.audio;
      if (audio && audio.length) {
        let peak = 0;
        let sumSquares = 0;
        let nonZero = 0;
        for (let i = 0; i < audio.length; i++) {
          const value = audio[i];
          const magnitude = Math.abs(value);
          if (magnitude > peak) peak = magnitude;
          if (magnitude > 1e-4) nonZero++;
          sumSquares += value * value;
        }
        audioStats = {
          samples: audio.length,
          seconds: Number((audio.length / (done.sampleRate || 24000)).toFixed(3)),
          peak: Number(peak.toFixed(5)),
          rms: Number(Math.sqrt(sumSquares / audio.length).toFixed(5)),
          audibleFraction: Number((nonZero / audio.length).toFixed(4)),
        };
      }
    }

    worker.terminate();
    return {
      init: { type: init?.type, error: init?.error || null, telemetry: init?.telemetry || null },
      generation,
      audioStats,
      statuses: messages.filter((m) => m?.type === 'status').map((m) => m.status),
      diagnostics: messages.filter((m) => m?.type === 'diagnostic').map((m) => m.message),
      crossOriginIsolated,
      userAgent: navigator.userAgent,
    };
  }, { appPath, voice: VOICE, text: TEXT });

  // A real read of this sentence is a couple of seconds of speech. Anything
  // near-silent or a fraction of a second means the graph ran but the phonemes,
  // the style row, or the token ids were wrong — which is exactly the failure a
  // "did it throw" check sails straight past.
  const stats = result.audioStats;
  const passed = result.init.type === 'init_done'
    && result.generation?.type === 'generate_done'
    && !!stats
    && stats.seconds >= 1
    && stats.rms >= 0.005
    && stats.peak >= 0.05
    && stats.audibleFraction >= 0.2;

  const report = {
    ...result,
    voice: VOICE,
    text: TEXT,
    elapsedMs: Date.now() - startedAt,
    consoleMessages,
    networkErrors,
    passed,
  };

  if (!noWrite) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
