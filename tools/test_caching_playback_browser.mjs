// Browser-level reliability harness for the real buffer manager + IndexedDB.
// It verifies lazy model startup, cache-hit replay, the 20-paragraph runway,
// and cancellation isolation without downloading the production TTS models.

import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../tests/webkit-smoke/node_modules/playwright');
const root = resolve('public');
const chrome = resolve(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe');
statSync(root);
statSync(chrome);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const shell = `<!doctype html><meta charset="utf-8"><body>
  <div id="reader-buffer-container"><div id="reader-buffer-fill"></div>
    <span id="reader-buffer-text"></span><span id="reader-buffer-eta"></span>
    <button id="cache-pause-btn"></button><button id="cache-resume-btn"></button>
  </div>
  <div id="away-mode-bar"></div>
  <div id="caching-progress-modal"><span id="caching-progress-text"></span>
    <div id="caching-progress-fill"></div><span id="caching-progress-stats"></span>
    <button id="caching-progress-dismiss-btn"></button>
  </div>
  <button id="away-queue-minimize-btn"></button><span id="away-queue-hint"></span>
  <select id="voice-selector"><option value="donald_malone" selected>Donald Malone</option></select>
  <select id="voice-engine-select"><option value="pocket" selected>Pocket</option></select>
</body>`;

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cache-Control': 'no-store',
      });
      response.end(shell);
      return;
    }
    const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(`${root}\\`)) throw new Error('invalid path');
    const body = readFileSync(path);
    response.writeHead(200, {
      'Content-Type': mime[extname(path)] || 'application/octet-stream',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(String(error?.message || error));
  }
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || String(error)));
  await page.goto(origin, { waitUntil: 'load' });

  const result = await page.evaluate(async () => {
    await new Promise((resolveDelete, rejectDelete) => {
      const request = indexedDB.deleteDatabase('PocketReaderDB');
      request.onsuccess = () => resolveDelete();
      request.onerror = () => rejectDelete(request.error);
      request.onblocked = () => rejectDelete(new Error('IndexedDB delete blocked'));
    });

    window.HARD_CAP_WORKERS = 1;
    window.MANUAL_CAP_WORKERS = 1;
    window.DEFAULT_MAX_WORKERS = 1;
    window.POCKET_VOICES = ['donald_malone'];
    window.POCKET_DEFAULT_VOICE = 'donald_malone';
    window.userProfile = { settings: { voiceEngine: 'pocket', maxWorkers: 1 }, library: [] };
    window._resolveActiveEngine = () => 'pocket';
    window.resolveVoiceWithSentiment = (_engine, voice) => voice;
    window._prosodyCacheTag = () => '';
    window._prosodyCacheTagVariants = () => [''];
    window.getStoryStableKey = (story) => story.storyKey || story.title;
    window.findLibraryStoryByRef = () => null;
    window.renderAwayModeUI = () => {};
    window.updatePlayButtons = () => {};
    window.updateReaderDrawerStatus = () => {};
    window.stopBgKeepAlive = () => {};
    window.startBgKeepAlive = () => {};
    window.trimPocketCacheWorkerPool = () => {};
    window.preparePocketCacheWorkerPool = async () => 1;
    window.isPocketDeviceMemorySafeMode = () => false;
    window.Diagnostics = { log() {} };
    window._pocketBackendRuntime = { selectedBackend: 'wasm', threadCount: 1 };

    let ensureCalls = 0;
    let synthDelay = 0;
    window.ensurePocketBackendOptimized = async () => { ensureCalls += 1; };
    window.generateChunk = async () => {
      if (synthDelay) await new Promise((resolveDelay) => setTimeout(resolveDelay, synthDelay));
      return new Blob([new Uint8Array(256)], { type: 'audio/wav' });
    };

    const storageModule = await import('/assets/js/storage_core.js?v=storage-v33');
    await import('/assets/js/buffer_manager.js?v=buffer-v92');
    window.BufferManager.initUI();

    const repaired = storageModule.normalizeStoryChapters([{
      title: 'Chapter 1: Test',
      paragraphs: [
        'Test Story\nPosted originally on the Archive of Our Own',
        'Chapter Notes\nThanks to my beta readers.',
        'See the end of the chapter for more notes\nThe first real sentence.',
        'The second real sentence.',
        'Chapter End Notes\nThanks for reading.',
      ],
    }], { title: 'Test Story', author: 'Test Author' });
    const repairedText = repaired.flatMap((chapter) => chapter.paragraphs).join('\n');

    const makeStory = (key, count) => ({
      title: key,
      storyKey: key,
      author: 'Test',
      chapters: [{ title: 'Chapter 1', paragraphs: Array.from({ length: count }, (_, i) => `Paragraph ${i + 1} has enough story words to narrate.`) }],
    });
    const waitComplete = async () => {
      const started = Date.now();
      while (Date.now() - started < 15000) {
        if (!window.BufferManager.isActive
            && window.BufferManager.cachedCount === window.BufferManager.totalToCache) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      throw new Error(`Cache did not complete: ${window.BufferManager.cachedCount}/${window.BufferManager.totalToCache}`);
    };

    const storyA = makeStory('browser-cache-story-a', 22);
    window.currentStory = storyA;
    await window.BufferManager.start('Normal');
    await waitComplete();
    const cold = {
      ensureCalls,
      ready: window.BufferManager.getReadyCount(),
      playbackReady: window.BufferManager.isPlaybackReadyForStory(storyA),
    };

    ensureCalls = 0;
    await window.BufferManager.start('Normal');
    await waitComplete();
    const warm = {
      ensureCalls,
      ready: window.BufferManager.getReadyCount(),
      playbackReady: window.BufferManager.isPlaybackReadyForStory(storyA),
    };

    const storyB = makeStory('browser-cache-story-b', 25);
    window.currentStory = storyB;
    synthDelay = 15;
    await window.BufferManager.start('Normal');
    const started = Date.now();
    while (window.BufferManager.cachedCount < 14 && Date.now() - started < 15000) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    window.BufferManager.stop();
    const stoppedAt = window.BufferManager.cachedCount;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const stopped = {
      stoppedAt,
      afterSettle: window.BufferManager.cachedCount,
      playbackReady: window.BufferManager.isPlaybackReadyForStory(storyB),
      active: window.BufferManager.isActive,
    };

    return {
      cold,
      warm,
      stopped,
      repairedNarration: {
        text: repairedText,
        clean: repairedText.includes('The first real sentence.')
          && repairedText.includes('The second real sentence.')
          && !/archive of our own|chapter notes|chapter end notes|thanks to my beta/i.test(repairedText),
      },
      isolated: crossOriginIsolated,
    };
  });

  const passed = result.cold.ensureCalls === 1
    && result.cold.ready === 22
    && result.cold.playbackReady
    && result.warm.ensureCalls === 0
    && result.warm.ready === 22
    && result.warm.playbackReady
    && result.stopped.stoppedAt >= 14
    && result.stopped.afterSettle === result.stopped.stoppedAt
    && result.stopped.playbackReady === false
    && result.stopped.active === false
    && result.repairedNarration.clean
    && pageErrors.length === 0;

  process.stdout.write(`${JSON.stringify({ passed, ...result, pageErrors }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise((done) => server.close(done));
}
