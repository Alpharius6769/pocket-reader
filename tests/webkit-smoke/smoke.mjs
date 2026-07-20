// WebKit smoke test for Pocket Reader (Phase 0).
//
// Runs the production app in real WebKit (the engine under every iOS browser)
// to answer, from Windows, the questions static analysis cannot:
//   1. Do all theme modules parse and execute in WebKit (no Safari-only syntax
//      or API crashes)?
//   2. Does the ?tts_fast=1 service-worker isolation handoff actually yield
//      crossOriginIsolated === true under WebKit?
//   3. If isolation fails, does the retry guard stop after one attempt
//      (no infinite reload loop)?
//
// Limits: this validates the ENGINE and the isolation dance, not iPhone
// memory ceilings or thermal behavior — those still need a physical device.
//
// Usage: node smoke.mjs [appUrl]

import { webkit } from 'playwright';

const APP_URL = process.argv[2] || 'https://hot-wiry-raven.anvil.app';
const SETTLE_MS = 12000;

function section(title) {
  console.log(`\n=== ${title} ===`);
}

const browser = await webkit.launch();
const context = await browser.newContext({ serviceWorkers: 'allow' });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
const navigations = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err)));
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) navigations.push(frame.url());
});

section('1. Plain load (no isolation requested)');
await page.goto(APP_URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(SETTLE_MS);

const plain = await page.evaluate(() => ({
  crossOriginIsolated: window.crossOriginIsolated === true,
  sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  serviceWorkerSupported: 'serviceWorker' in navigator,
  swController: !!navigator.serviceWorker?.controller,
  modules: {
    bufferManager: !!window.BufferManager,
    generateChunk: typeof window.generateChunk === 'function',
    loadLocalData: typeof window.loadLocalData === 'function',
    enqueueExperience: typeof window.enqueueExperience === 'function',
    prefetchVoices: typeof window.prefetchPocketVoiceAssets === 'function',
  },
  audioWorklet: (() => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const ok = !!ctx.audioWorklet;
      ctx.close();
      return ok;
    } catch (e) { return `error: ${e.message}`; }
  })(),
  webgpu: !!navigator.gpu,
  hardwareConcurrency: navigator.hardwareConcurrency,
  userAgent: navigator.userAgent,
}));
console.log(JSON.stringify(plain, null, 2));

section('1b. On-demand narration activation');
await page.evaluate(() => window.ensureNarrationRuntime());
const narration = await page.evaluate(() => ({
  runtimeLoaded: window.__pocketNarrationRuntimeLoaded === true,
  bufferManager: !!window.BufferManager,
  generateChunk: typeof window.generateChunk === 'function',
  prefetchVoices: typeof window.prefetchPocketVoiceAssets === 'function',
}));
console.log(JSON.stringify(narration, null, 2));

// Give the service worker time to finish installing before the isolation hop.
await page.waitForTimeout(5000);

section('2. Isolation handoff (?tts_fast=1)');
navigations.length = 0;
const isoUrl = `${APP_URL}/?tts_fast=1&tts_iso=${Date.now()}`;
await page.goto(isoUrl, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(SETTLE_MS);

const isolated = await page.evaluate(() => ({
  crossOriginIsolated: window.crossOriginIsolated === true,
  sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  swController: !!navigator.serviceWorker?.controller,
  retryFlag: sessionStorage.getItem('pr_fast_narration_retry_v1'),
  url: location.href,
}));
console.log(JSON.stringify(isolated, null, 2));
console.log(`navigations during isolation phase: ${navigations.length}`);
navigations.forEach((u) => console.log(`  -> ${u}`));

section('3. Reload-loop guard');
// Sit for a while: an infinite reload loop would keep adding navigations.
navigations.length = 0;
await page.waitForTimeout(15000);
console.log(`extra navigations while settled: ${navigations.length}`);

section('4. Errors collected across the whole run');
console.log(`pageerror count: ${pageErrors.length}`);
pageErrors.slice(0, 10).forEach((e) => console.log(`  PAGEERROR: ${e}`));
console.log(`console error count: ${consoleErrors.length}`);
consoleErrors.slice(0, 15).forEach((e) => console.log(`  CONSOLE: ${e.slice(0, 200)}`));

section('VERDICT');
const verdict = {
  webkitParsesApp: pageErrors.length === 0,
  isolationWorks: isolated.crossOriginIsolated,
  noReloadLoop: navigations.length === 0,
  narrationDeferred: !plain.modules.bufferManager
    && !plain.modules.generateChunk
    && !plain.modules.prefetchVoices,
  modulesLoadOnDemand: Object.values(narration).every(Boolean),
};
console.log(JSON.stringify(verdict, null, 2));

await browser.close();
process.exit(
  verdict.webkitParsesApp
    && verdict.isolationWorks
    && verdict.noReloadLoop
    && verdict.narrationDeferred
    && verdict.modulesLoadOnDemand
    ? 0
    : 1,
);
