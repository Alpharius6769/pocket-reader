// Peak-memory measurement for a real caching run.
//
// iOS jetsam kills a tab well before desktop would notice, so the question
// "does caching a chapter fit in the budget" cannot be answered by reading the
// code -- it needs the engine loaded and paragraphs actually rendered.
//
// WHAT IS MEASURED
// performance.measureUserAgentSpecificMemory() from the page. In Chrome that
// covers the whole agent cluster, which includes the dedicated narration worker
// and the WebAssembly memory its ONNX session allocates -- the allocation that
// dominates here. Sampled before init, after init, and every few paragraphs, so
// the shape of the curve is visible rather than just the endpoint.
//
// ALLOCATED vs RESIDENT
// This API counts a WebAssembly.Memory at the size it was grown to, and ORT
// grows a heap it never shrinks -- so the figure is allocated, while a phone's
// jetsam counts resident pages. Process working set is sampled alongside it to
// keep that visible. In practice the two moved together here, so the allocated
// number is not an overstatement, but do not assume that on another engine.
//
// A WebKit variant of this was written and deleted: Playwright's WebKit port on
// Windows loses the page whenever a page.evaluate() runs for minutes without
// yielding, which is exactly the shape of this measurement, and it crashed
// before producing a number. Polling from Node in small steps does work if
// somebody wants to rebuild it.
//
// WHAT IT IS NOT
// Desktop Chrome on Windows, not iOS Safari. Treat the numbers as the engine's
// intrinsic footprint and the SHAPE of its growth, not as a jetsam prediction:
// WebKit's allocator, its WASM heap granularity and the OS accounting all
// differ. A run that sits comfortably under budget here can still be tight on a
// phone; a run that blows the budget here will certainly blow it there.
//
//   node tools/measure_narration_memory.mjs [--paragraphs 30] [--voice af_heart]
//
// Requires Chrome and the playwright install under tests/webkit-smoke.

import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, basename, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('../tests/webkit-smoke/node_modules/playwright');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const PARAGRAPHS = Number(flag('paragraphs', 30));
const VOICE = flag('voice', 'af_heart');
// Sentences per paragraph. The peak looks like it tracks how much audio a
// SINGLE generate() call has to hold, not how many calls are made, so this is
// the knob that tests that.
const SENTENCES_PER = Number(flag('sentences', 4));
const noWrite = argv.includes('--no-write');
const output = resolve('benchmark-results/narration-memory.json');

const root = resolve('public/assets/js');
const chrome = resolve(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe');
statSync(root);
statSync(chrome);

// measureUserAgentSpecificMemory() reports WebAssembly.Memory at its ALLOCATED
// size. A phone's jetsam counts resident pages, so the two can differ by a lot
// and the difference decides whether a budget is blown. Sampling the process
// tree's working set alongside it makes that visible instead of assumed.
const execFileAsync = promisify(execFile);
const RSS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$dir = $env:PW_EXE_DIR',
  '$procs = Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($dir) }',
  '$total = 0',
  'foreach ($p in $procs) { $total += $p.WorkingSet64 }',
  'Write-Output "$total"',
].join('; ');
async function rssBytes(exeDir) {
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', RSS_SCRIPT],
      { maxBuffer: 1 << 20, env: { ...process.env, PW_EXE_DIR: exeDir } });
    return Number(stdout.trim()) || 0;
  } catch (_) { return 0; }
}

const mime = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const productionOrigin = 'https://alpharius6769.github.io';
const appPath = '/pocket-reader';
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

// Realistic narration input: ~70 words a paragraph, mixed punctuation, the
// shape the chunker and the phonemizer actually see in a story.
const SENTENCES = [
  'The corridor stretched on, dim and cold, and she counted the doors as she passed them.',
  '"Is anyone there?" she called, and nothing at all answered her.',
  'By the twentieth door she had stopped counting; by the thirtieth she had stopped hoping.',
  'He set the lantern down on the flagstones and watched the flame gutter, then steady.',
  'It was the kind of quiet that presses on the ears until it becomes a sound of its own.',
  'She had been told the house was empty — told it twice, in fact, and believed it once.',
  'Somewhere below, a door closed with the particular softness of someone not wishing to be heard.',
  'The stair turned back on itself and delivered them into a room they had already left.',
];
const paragraphAt = (index) => {
  const out = [];
  for (let i = 0; i < 4; i++) out.push(SENTENCES[(index * 4 + i) % SENTENCES.length]);
  return out.join(' ');
};

const startedAt = Date.now();
let browser;

try {
  browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    // measureUserAgentSpecificMemory() reports far more useful numbers when the
    // collector can run on demand instead of waiting for a heuristic GC.
    args: ['--js-flags=--expose-gc'],
  });
  const context = await browser.newContext();
  await context.route(`${productionOrigin}/**`, async (route) => {
    try {
      const url = new URL(route.request().url());
      if (url.pathname === `${appPath}/__memory__`) {
        await route.fulfill({ status: 200, headers: { ...isolationHeaders, 'Content-Type': 'text/html; charset=utf-8' }, body: '<!doctype html><meta charset="utf-8"><title>memory</title>' });
        return;
      }
      const path = resolve(root, basename(url.pathname));
      if (!path.startsWith(`${root}\\`) && path !== root) throw new Error('invalid path');
      await route.fulfill({ status: 200, headers: { ...isolationHeaders, 'Content-Type': mime[extname(path)] || 'application/octet-stream' }, body: readFileSync(path) });
    } catch (error) {
      await route.fulfill({ status: 404, body: String(error?.message || error) });
    }
  });

  const page = await context.newPage();
  const chromeDir = dirname(chrome);
  const rssByLabel = {};
  await page.exposeFunction('__sampleRss', async (label) => {
    rssByLabel[label] = Number(((await rssBytes(chromeDir)) / 1048576).toFixed(1));
    return true;
  });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e.message || e)));
  await page.goto(`${productionOrigin}${appPath}/__memory__`, { waitUntil: 'load' });

  const result = await page.evaluate(async ({ appPath: base, voice, paragraphs, sentences, perParagraph }) => {
    const paragraphAt = (index) => {
      const out = [];
      for (let i = 0; i < perParagraph; i++) out.push(sentences[(index * perParagraph + i) % sentences.length]);
      return out.join(' ');
    };
    const MB = (bytes) => Number((bytes / 1048576).toFixed(1));
    const measure = async (label) => {
      try { globalThis.gc?.(); } catch (_) {}
      await window.__sampleRss(label);
      const sample = await performance.measureUserAgentSpecificMemory();
      const byType = {};
      for (const entry of sample.breakdown || []) {
        for (const type of entry.types || ['other']) byType[type] = (byType[type] || 0) + entry.bytes;
      }
      return { label, totalMB: MB(sample.bytes), byTypeMB: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, MB(v)])) };
    };

    if (!crossOriginIsolated) return { error: 'not cross-origin isolated' };
    if (typeof performance.measureUserAgentSpecificMemory !== 'function') {
      return { error: 'measureUserAgentSpecificMemory unavailable' };
    }

    const samples = [];
    samples.push(await measure('baseline (page only, no worker)'));

    const worker = new Worker(`${base}/assets/js/kokoro_worker.js?v=kokoro-v29`, { type: 'module' });
    const waitFor = (types, timeoutMs, label) => new Promise((settle) => {
      const timer = setTimeout(() => settle({ type: 'timeout', error: `${label} timed out` }), timeoutMs);
      const onMessage = (event) => {
        if (!types.includes(event.data?.type)) return;
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        settle(event.data);
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', () => { clearTimeout(timer); settle({ type: 'worker_script_error' }); }, { once: true });
    });

    const initPromise = waitFor(['init_done', 'init_error', 'worker_script_error'], 10 * 60 * 1000, 'init');
    worker.postMessage({ type: 'init', voiceEngine: 'pocket' });
    const init = await initPromise;
    if (init?.type !== 'init_done') return { error: `init failed: ${init?.type} ${init?.error || ''}`, samples };

    samples.push(await measure('after engine init (model + runtime resident)'));

    const paragraphSeconds = [];
    let totalAudioSeconds = 0;
    for (let index = 0; index < paragraphs; index += 1) {
      const done = waitFor(['generate_done', 'generate_error', 'worker_script_error'], 5 * 60 * 1000, `generate ${index}`);
      worker.postMessage({ type: 'generate', id: `p${index}`, text: paragraphAt(index), voice, opts: { speed: 1 } });
      const result = await done;
      if (result?.type !== 'generate_done') return { error: `paragraph ${index} failed: ${result?.error || result?.type}`, samples };
      const seconds = (result.audio?.length || 0) / (result.sampleRate || 24000);
      totalAudioSeconds += seconds;
      paragraphSeconds.push(Number(seconds.toFixed(2)));
      // The caller keeps every rendered paragraph, exactly as the cache job does
      // before it writes them to IndexedDB, so the audio is held live here too.
      if ((index + 1) % 5 === 0 || index === paragraphs - 1) {
        samples.push(await measure(`after ${index + 1} paragraphs`));
      }
    }

    worker.terminate();
    await new Promise((r) => setTimeout(r, 1500));
    samples.push(await measure('after worker terminate'));

    return {
      samples,
      paragraphs,
      voice,
      totalAudioSeconds: Number(totalAudioSeconds.toFixed(1)),
      perParagraphSeconds: paragraphSeconds,
      sentencesPerParagraph: perParagraph,
      telemetry: init.telemetry || null,
    };
  }, { appPath, voice: VOICE, paragraphs: PARAGRAPHS, sentences: SENTENCES, perParagraph: SENTENCES_PER });

  for (const sample of result.samples || []) sample.processRssMB = rssByLabel[sample.label] ?? null;
  const report = { engine: 'kokoro', ...result, elapsedMs: Date.now() - startedAt, consoleErrors, userAgentNote: 'Chrome headless on Windows; NOT iOS Safari' };
  if (!noWrite) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
}
