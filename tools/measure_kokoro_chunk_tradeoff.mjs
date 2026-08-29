// Sweep Kokoro's chunk cap: peak memory against audio fidelity.
//
// Capping how much audio one inference produces is the only lever that moves
// Kokoro's peak, but it buys memory by cutting the utterance into more pieces --
// so the cap is only usable if the seams are inaudible. This measures both ends
// of that trade on the SAME text, with the 510-token setting (the full sequence
// axis, i.e. the old behaviour) as the reference rendering.
//
// FIDELITY PROXIES, and what each would catch:
//   durationDeltaPct  - pacing drift; a cap that changes speech rate is audible
//                       even with perfect seams.
//   rmsDeltaPct       - level drift between renderings.
//   maxStep           - largest sample-to-sample jump. A concatenation seam with
//                       a DC mismatch shows up here as a click.
//   clicks            - count of steps beyond 0.25 full-scale, which is a very
//                       loud transient at 24 kHz and should be zero.
//   envelopeDiffPct   - mean |difference| of the 50 ms RMS envelope against the
//                       reference, relative to reference RMS. Catches a seam
//                       that is not a click but still a gap or a level step.
//
//   node tools/measure_kokoro_chunk_tradeoff.mjs [--caps 510,256,192,160,128]
//
// Requires Chrome and the playwright install under tests/webkit-smoke.

import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, basename, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../tests/webkit-smoke/node_modules/playwright');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const CAPS = String(flag('caps', '510,256,192,160,128')).split(',').map(Number).filter(Boolean);
const PARAGRAPHS = Number(flag('paragraphs', 3));
const VOICE = flag('voice', 'af_heart');
const noWrite = argv.includes('--no-write');
const output = resolve('benchmark-results/kokoro-chunk-tradeoff.json');

const root = resolve('public/assets/js');
const chrome = resolve(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe');
statSync(root);
statSync(chrome);

const mime = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const productionOrigin = 'https://alpharius6769.github.io';
const appPath = '/pocket-reader';
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

// One long paragraph with a sentence too long to fit a small cap, so the
// word-gap fallback is actually exercised rather than assumed.
const PARAGRAPH = 'The corridor stretched on, dim and cold, and she counted the doors as she '
  + 'passed them one after another without ever once slowing her pace or letting herself '
  + 'look back over her shoulder towards the stair she had come up. "Is anyone there?" she '
  + 'called. Nothing answered. By the twentieth door she had stopped counting; by the '
  + 'thirtieth she had stopped hoping, and the lantern in her hand was burning down to '
  + 'nothing at all.';

const startedAt = Date.now();
let browser;

try {
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--js-flags=--expose-gc'] });
  const context = await browser.newContext();
  await context.route(`${productionOrigin}/**`, async (route) => {
    try {
      const url = new URL(route.request().url());
      if (url.pathname === `${appPath}/__tradeoff__`) {
        await route.fulfill({ status: 200, headers: { ...isolationHeaders, 'Content-Type': 'text/html; charset=utf-8' }, body: '<!doctype html><meta charset="utf-8"><title>tradeoff</title>' });
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
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
  await page.goto(`${productionOrigin}${appPath}/__tradeoff__`, { waitUntil: 'load' });

  const rows = await page.evaluate(async ({ appPath: base, voice, caps, paragraphs, paragraph }) => {
    const MB = (b) => Number((b / 1048576).toFixed(1));
    const measure = async () => {
      try { globalThis.gc?.(); } catch (_) {}
      return MB((await performance.measureUserAgentSpecificMemory()).bytes);
    };
    const envelopeOf = (audio, rate) => {
      const win = Math.max(1, Math.round(rate * 0.05));
      const out = [];
      for (let i = 0; i < audio.length; i += win) {
        let sum = 0;
        const end = Math.min(audio.length, i + win);
        for (let j = i; j < end; j++) sum += audio[j] * audio[j];
        out.push(Math.sqrt(sum / Math.max(1, end - i)));
      }
      return out;
    };
    const statsOf = (audio, rate) => {
      let peak = 0; let sumSq = 0; let maxStep = 0; let clicks = 0;
      for (let i = 0; i < audio.length; i++) {
        const v = audio[i];
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sumSq += v * v;
        if (i > 0) {
          const step = Math.abs(v - audio[i - 1]);
          if (step > maxStep) maxStep = step;
          if (step > 0.25) clicks++;
        }
      }
      return {
        seconds: Number((audio.length / rate).toFixed(3)),
        rms: Number(Math.sqrt(sumSq / audio.length).toFixed(5)),
        peak: Number(peak.toFixed(5)),
        maxStep: Number(maxStep.toFixed(5)),
        clicks,
        envelope: envelopeOf(audio, rate),
      };
    };

    const results = [];
    let reference = null;

    for (const cap of caps) {
      const worker = new Worker(`${base}/assets/js/kokoro_worker.js?v=kokoro-v15`, { type: 'module' });
      const waitFor = (types, timeoutMs) => new Promise((settle) => {
        const timer = setTimeout(() => settle({ type: 'timeout' }), timeoutMs);
        const onMessage = (e) => {
          if (!types.includes(e.data?.type)) return;
          clearTimeout(timer);
          worker.removeEventListener('message', onMessage);
          settle(e.data);
        };
        worker.addEventListener('message', onMessage);
      });

      const initPromise = waitFor(['init_done', 'init_error'], 10 * 60 * 1000);
      worker.postMessage({ type: 'init', voiceEngine: 'pocket', maxChunkTokens: cap });
      const init = await initPromise;
      if (init?.type !== 'init_done') { results.push({ cap, error: init?.error || init?.type }); worker.terminate(); continue; }
      const afterInit = await measure();

      let peakMB = afterInit;
      let last = null;
      for (let i = 0; i < paragraphs; i++) {
        const done = waitFor(['generate_done', 'generate_error'], 5 * 60 * 1000);
        worker.postMessage({ type: 'generate', id: `c${cap}p${i}`, text: paragraph, voice, opts: { speed: 1 } });
        const out = await done;
        if (out?.type !== 'generate_done') { results.push({ cap, error: out?.error || out?.type }); break; }
        last = out;
        const now = await measure();
        if (now > peakMB) peakMB = now;
      }
      if (!last) { worker.terminate(); continue; }

      const stats = statsOf(last.audio, last.sampleRate || 24000);
      if (reference === null) reference = stats;
      let envelopeDiffPct = 0;
      const n = Math.min(stats.envelope.length, reference.envelope.length);
      if (n > 0) {
        let diff = 0;
        for (let i = 0; i < n; i++) diff += Math.abs(stats.envelope[i] - reference.envelope[i]);
        envelopeDiffPct = Number(((diff / n) / (reference.rms || 1) * 100).toFixed(1));
      }
      results.push({
        cap,
        afterInitMB: afterInit,
        peakMB,
        seconds: stats.seconds,
        rms: stats.rms,
        peak: stats.peak,
        maxStep: stats.maxStep,
        clicks: stats.clicks,
        durationDeltaPct: Number(((stats.seconds - reference.seconds) / reference.seconds * 100).toFixed(1)),
        rmsDeltaPct: Number(((stats.rms - reference.rms) / reference.rms * 100).toFixed(1)),
        envelopeDiffPct,
      });
      worker.terminate();
      await new Promise((r) => setTimeout(r, 1200));
    }
    return results;
  }, { appPath, voice: VOICE, caps: CAPS, paragraphs: PARAGRAPHS, paragraph: PARAGRAPH });

  const report = { engine: 'kokoro', voice: VOICE, paragraphText: PARAGRAPH, rows, pageErrors, elapsedMs: Date.now() - startedAt };
  if (!noWrite) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); }
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
}
