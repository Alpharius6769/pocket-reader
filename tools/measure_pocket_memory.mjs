// The Kokoro memory harness, pointed at Pocket, so the two can be compared.
//
// WHY THIS EXISTS SEPARATELY
// "Kokoro peaks at 592 MB" only means something next to a Pocket number taken
// the SAME way. Pocket needs more setup than Kokoro -- it does not fetch its own
// voice, the main thread fetches a .safetensors, parses it and posts it as
// register_precompiled_voice -- so that step is replicated here rather than
// pulling in audio_core, which has a large side-effectful module body.
//
// Same page, same isolation headers, same paragraphs, same
// measureUserAgentSpecificMemory() checkpoints as measure_narration_memory.mjs.
//
//   node tools/measure_pocket_memory.mjs [--paragraphs 8] [--sentences 4]
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
const PARAGRAPHS = Number(flag('paragraphs', 8));
const SENTENCES_PER = Number(flag('sentences', 4));
const VOICE = flag('voice', 'alba_neutral');
const noWrite = argv.includes('--no-write');
const output = resolve('benchmark-results/pocket-memory.json');

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

const startedAt = Date.now();
let browser;

try {
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--js-flags=--expose-gc'] });
  const context = await browser.newContext();
  await context.route(`${productionOrigin}/**`, async (route) => {
    try {
      const url = new URL(route.request().url());
      if (url.pathname === `${appPath}/__pocketmem__`) {
        await route.fulfill({ status: 200, headers: { ...isolationHeaders, 'Content-Type': 'text/html; charset=utf-8' }, body: '<!doctype html><meta charset="utf-8"><title>pocket memory</title>' });
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
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e.message || e)));
  await page.goto(`${productionOrigin}${appPath}/__pocketmem__`, { waitUntil: 'load' });

  const result = await page.evaluate(async ({ appPath: base, voice, paragraphs, sentences, perParagraph }) => {
    const MB = (b) => Number((b / 1048576).toFixed(1));
    const measure = async (label) => {
      try { globalThis.gc?.(); } catch (_) {}
      const s = await performance.measureUserAgentSpecificMemory();
      return { label, totalMB: MB(s.bytes) };
    };
    const paragraphAt = (index) => {
      const out = [];
      for (let i = 0; i < perParagraph; i++) out.push(sentences[(index * perParagraph + i) % sentences.length]);
      return out.join(' ');
    };
    // Byte-for-byte the shape audio_core's _parseSafetensors produces.
    const parseSafetensors = (buffer) => {
      const view = new DataView(buffer);
      const headerLength = Number(view.getBigUint64(0, true));
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength)));
      const out = {};
      for (const key of Object.keys(header).filter((k) => k !== '__metadata__')) {
        const entry = header[key];
        const [start, end] = entry.data_offsets;
        const at = 8 + headerLength + start;
        const len = end - start;
        let data; let dtype;
        if (entry.dtype === 'I64') { data = new BigInt64Array(buffer.slice(at, at + len)); dtype = 'int64'; }
        else if (entry.dtype === 'BOOL') { data = new Uint8Array(buffer.slice(at, at + len)); dtype = 'bool'; }
        else { data = new Float32Array(buffer.slice(at, at + len)); dtype = 'float32'; }
        out[key] = { data, shape: entry.shape, dtype };
      }
      return out;
    };

    if (!crossOriginIsolated) return { error: 'not cross-origin isolated' };
    const samples = [];
    samples.push(await measure('baseline (page only, no worker)'));

    const worker = new Worker(`${base}/assets/js/pocket_worker.js?v=pocket-worker-v117`, { type: 'module' });
    const waitFor = (types, timeoutMs, label) => new Promise((settle) => {
      const timer = setTimeout(() => settle({ type: 'timeout', error: `${label} timed out` }), timeoutMs);
      const onMessage = (event) => {
        if (!types.includes(event.data?.type)) return;
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        settle(event.data);
      };
      worker.addEventListener('message', onMessage);
    });

    const initPromise = waitFor(['init_done', 'ready', 'bundle_loaded', 'init_error', 'error'], 15 * 60 * 1000, 'init');
    worker.postMessage({
      type: 'init', voiceEngine: 'pocket',
      backendPreference: 'wasm', selectedBackend: 'wasm', wasmThreadCount: 4,
      wasmReferenceRtf: 0, constrainedMemoryMode: false, clientPlatform: 'desktop',
    });
    const init = await initPromise;
    if (!['init_done', 'ready', 'bundle_loaded'].includes(init?.type)) {
      return { error: `init failed: ${init?.type} ${init?.error || ''}`, samples };
    }
    samples.push(await measure('after engine init (sessions resident)'));

    // Fetch + register the voice exactly as audio_core does.
    const proxy = 'https://pocket-reader-proxy.alpharius67.workers.dev';
    const voiceResponse = await fetch(`${proxy}/models/voices/${voice}.safetensors`);
    if (!voiceResponse.ok) return { error: `voice fetch ${voiceResponse.status}`, samples };
    const voiceState = parseSafetensors(await voiceResponse.arrayBuffer());
    const registered = waitFor(['voice_encoded', 'error'], 5 * 60 * 1000, 'register');
    worker.postMessage({ type: 'register_precompiled_voice', voiceName: voice, voiceState });
    const reg = await registered;
    if (reg?.type !== 'voice_encoded') return { error: `voice registration failed: ${reg?.error || reg?.type}`, samples };
    samples.push(await measure('after voice registered (conditioned state live)'));

    const paragraphSeconds = [];
    let totalAudioSeconds = 0;
    for (let index = 0; index < paragraphs; index += 1) {
      const done = waitFor(['complete', 'generate_error'], 10 * 60 * 1000, `generate ${index}`);
      worker.postMessage({ type: 'generate', id: `p${index}`, text: paragraphAt(index), voice, opts: null });
      const out = await done;
      if (out?.type !== 'complete') return { error: `paragraph ${index}: ${out?.error || out?.type}`, samples };
      const seconds = (out.audio?.length || 0) / (out.sampleRate || 24000);
      totalAudioSeconds += seconds;
      paragraphSeconds.push(Number(seconds.toFixed(2)));
      if ((index + 1) % 4 === 0 || index === paragraphs - 1) samples.push(await measure(`after ${index + 1} paragraphs`));
    }

    worker.terminate();
    await new Promise((r) => setTimeout(r, 1500));
    samples.push(await measure('after worker terminate'));
    return { samples, paragraphs, voice, totalAudioSeconds: Number(totalAudioSeconds.toFixed(1)), perParagraphSeconds: paragraphSeconds, sentencesPerParagraph: perParagraph };
  }, { appPath, voice: VOICE, paragraphs: PARAGRAPHS, sentences: SENTENCES, perParagraph: SENTENCES_PER });

  const report = { engine: 'pocket', ...result, elapsedMs: Date.now() - startedAt, consoleErrors, userAgentNote: 'Chrome headless on Windows; NOT iOS Safari' };
  if (!noWrite) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
}
