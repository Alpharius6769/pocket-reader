// Three questions the chunk-cap sweep raised and could not answer.
//
// 1. Peak floors at ~355 MB below cap 192, ~102 MB above init. What is that
//    term? Prime suspect: with many small chunks there are many more session
//    runs, and the WASM heap only ever grows. Disabling ORT's arena (which this
//    worker now does on memory-safe devices) removes the pooling that would
//    otherwise let those runs reuse the same block -- so the guard added for
//    safety may be RAISING the floor in exactly the regime capping creates.
//    Tested by sweeping constrainedMemoryMode against the cap.
//
// 2. Capped renderings are ~10% longer for identical text. Added pauses at the
//    seams, or slower speech? Measured as the fraction of the waveform below a
//    silence floor: if the extra length is silence, pauses are being inserted.
//
// 3. What does capping cost in wall-clock? More chunks means more session runs,
//    and a cache job that takes 30% longer is its own problem.
//
//   node tools/probe_kokoro_floor.mjs
//
// Requires Chrome and the playwright install under tests/webkit-smoke.

import { readFileSync, statSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../tests/webkit-smoke/node_modules/playwright');

const root = resolve('public/assets/js');
const chrome = resolve(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe');
statSync(root); statSync(chrome);

const mime = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const productionOrigin = 'https://alpharius6769.github.io';
const appPath = '/pocket-reader';
const H = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

const PARAGRAPH = 'The corridor stretched on, dim and cold, and she counted the doors as she '
  + 'passed them one after another without ever once slowing her pace or letting herself '
  + 'look back over her shoulder towards the stair she had come up. "Is anyone there?" she '
  + 'called. Nothing answered. By the twentieth door she had stopped counting; by the '
  + 'thirtieth she had stopped hoping, and the lantern in her hand was burning down to '
  + 'nothing at all.';

// cap, constrainedMemoryMode
const CONFIGS = [
  [510, true], [510, false],
  [192, true], [192, false],
  [160, false],
];

let browser;
try {
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--js-flags=--expose-gc'] });
  const context = await browser.newContext();
  await context.route(`${productionOrigin}/**`, async (route) => {
    try {
      const url = new URL(route.request().url());
      if (url.pathname === `${appPath}/__floor__`) {
        return route.fulfill({ status: 200, headers: { ...H, 'Content-Type': 'text/html; charset=utf-8' }, body: '<!doctype html><meta charset="utf-8">' });
      }
      const path = resolve(root, basename(url.pathname));
      if (!path.startsWith(`${root}\\`) && path !== root) throw new Error('bad path');
      return route.fulfill({ status: 200, headers: { ...H, 'Content-Type': mime[extname(path)] || 'application/octet-stream' }, body: readFileSync(path) });
    } catch (e) { return route.fulfill({ status: 404, body: String(e.message) }); }
  });
  const page = await context.newPage();
  await page.goto(`${productionOrigin}${appPath}/__floor__`, { waitUntil: 'load' });

  const rows = await page.evaluate(async ({ appPath: base, configs, paragraph }) => {
    const MB = (b) => Number((b / 1048576).toFixed(1));
    const measure = async () => { try { globalThis.gc?.(); } catch (_) {} return MB((await performance.measureUserAgentSpecificMemory()).bytes); };
    const out = [];
    for (const [cap, constrained] of configs) {
      const worker = new Worker(`${base}/assets/js/kokoro_worker.js?v=kokoro-v5`, { type: 'module' });
      const waitFor = (types, ms) => new Promise((s) => {
        const t = setTimeout(() => s({ type: 'timeout' }), ms);
        const h = (e) => { if (!types.includes(e.data?.type)) return; clearTimeout(t); worker.removeEventListener('message', h); s(e.data); };
        worker.addEventListener('message', h);
      });
      const ip = waitFor(['init_done', 'init_error'], 10 * 60 * 1000);
      worker.postMessage({ type: 'init', voiceEngine: 'pocket', maxChunkTokens: cap, constrainedMemoryMode: constrained });
      const init = await ip;
      if (init?.type !== 'init_done') { out.push({ cap, constrained, error: init?.error || init?.type }); worker.terminate(); continue; }
      const afterInit = await measure();

      let peak = afterInit; let last = null; let genMs = 0;
      for (let i = 0; i < 2; i++) {
        const d = waitFor(['generate_done', 'generate_error'], 5 * 60 * 1000);
        const t0 = performance.now();
        worker.postMessage({ type: 'generate', id: `f${cap}${constrained}${i}`, text: paragraph, voice: 'af_heart', opts: { speed: 1 } });
        const r = await d;
        genMs += performance.now() - t0;
        if (r?.type !== 'generate_done') { out.push({ cap, constrained, error: r?.error || r?.type }); break; }
        last = r;
        const m = await measure();
        if (m > peak) peak = m;
      }
      if (last) {
        const a = last.audio; const rate = last.sampleRate || 24000;
        // Silence floor at -50 dBFS relative to full scale.
        let quiet = 0;
        for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) < 0.00316) quiet++;
        out.push({
          cap, constrained,
          afterInitMB: afterInit, peakMB: peak,
          seconds: Number((a.length / rate).toFixed(3)),
          silencePct: Number((quiet / a.length * 100).toFixed(1)),
          genSecPerCall: Number((genMs / 2 / 1000).toFixed(2)),
        });
      }
      worker.terminate();
      await new Promise((r) => setTimeout(r, 1200));
    }
    return out;
  }, { appPath, configs: CONFIGS, paragraph: PARAGRAPH });

  console.log(JSON.stringify(rows, null, 2));
} finally {
  if (browser) await browser.close();
}
