import { readFile } from 'node:fs/promises';
import { webkit } from '../tests/webkit-smoke/node_modules/playwright/index.mjs';

const root = new URL('../', import.meta.url);
const loaderSource = await readFile(new URL('public/assets/js/narration_runtime_loader.js', root), 'utf8');
const audioSource = await readFile(new URL('public/assets/js/audio_core.js', root), 'utf8');
// Line endings must not decide whether this harness runs. git is configured
// with core.autocrlf=true here, so every checked-out file is CRLF in the
// working tree while the blob in git is LF — an \n-anchored extraction silently
// matches nothing on Windows and the harness dies before it opens a browser.
const toggleSource = audioSource
  .match(/export function togglePlayState\(\) \{[\s\S]*?\r?\n\}\r?\nwindow\.togglePlayState/)?.[0]
  ?.replace('export function', 'function')
  ?.replace(/\r?\nwindow\.togglePlayState$/, '') || '';

if (!toggleSource) {
  throw new Error(
    'Could not extract togglePlayState from audio_core.js. The exported function or its '
    + '`window.togglePlayState` assignment moved — update the extraction pattern in this harness.',
  );
}

const requested = [];
const browser = await webkit.launch({ headless: true });
const page = await browser.newPage({
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  hasTouch: true,
});

await page.route('https://pocket.test/**', async (route) => {
  const url = new URL(route.request().url());
  requested.push(url.pathname);
  if (url.pathname === '/') {
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html>
        <script>
          window.__insideNarrationTap = false;
          window.__mediaPlayWasSynchronous = false;
          HTMLMediaElement.prototype.play = function() {
            if (window.__insideNarrationTap) window.__mediaPlayWasSynchronous = true;
            return Promise.resolve();
          };
          window.invokeNarrationTap = function() {
            window.__insideNarrationTap = true;
            window.togglePlayState();
            window.__insideNarrationTap = false;
          };
        </script>
        <button id="play" onclick="window.invokeNarrationTap()">Play</button>
        <script type="module" src="/narration_runtime_loader.js?v=narration-loader-v131"></script>`,
    });
  } else if (url.pathname.endsWith('/narration_runtime_loader.js')) {
    await route.fulfill({ contentType: 'text/javascript', body: loaderSource });
  } else if (url.pathname.endsWith('/audio_core.js')) {
    await route.fulfill({
      contentType: 'text/javascript',
      body: `window.__audioExecuted = (window.__audioExecuted || 0) + 1;
        window.togglePlayState = () => { window.__playInvoked = (window.__playInvoked || 0) + 1; };`,
    });
  } else if (url.pathname.endsWith('/buffer_manager.js')) {
    await route.fulfill({
      contentType: 'text/javascript',
      body: 'window.__bufferExecuted = (window.__bufferExecuted || 0) + 1;',
    });
  } else {
    await route.fulfill({ status: 404, body: 'not found' });
  }
});

await page.goto('https://pocket.test/');
await page.waitForFunction(() => typeof window.ensureNarrationRuntime === 'function');
const before = await page.evaluate(() => ({
  runtimeLoaded: window.__pocketNarrationRuntimeLoaded === true,
  audioExecuted: window.__audioExecuted || 0,
  bufferExecuted: window.__bufferExecuted || 0,
}));
if (before.runtimeLoaded || before.audioExecuted || before.bufferExecuted) {
  throw new Error(`Narration runtime executed eagerly in WebKit: ${JSON.stringify(before)}`);
}
if (requested.some((path) => /audio_core|buffer_manager/.test(path))) {
  throw new Error(`Heavy narration modules were requested before Play: ${JSON.stringify(requested)}`);
}

await page.click('#play');
await page.waitForFunction(() => window.__playInvoked === 1);
const after = await page.evaluate(() => ({
  runtimeLoaded: window.__pocketNarrationRuntimeLoaded === true,
  audioExecuted: window.__audioExecuted || 0,
  bufferExecuted: window.__bufferExecuted || 0,
  playInvoked: window.__playInvoked || 0,
  mediaPlayWasSynchronous: window.__mediaPlayWasSynchronous === true,
  sharedMediaElement: window.__pocketMobileMediaElement === window.currentAudio,
}));
if (!after.runtimeLoaded || after.audioExecuted !== 1 || after.bufferExecuted !== 1 || after.playInvoked !== 1
  || !after.mediaPlayWasSynchronous || !after.sharedMediaElement) {
  throw new Error(`Deferred narration activation failed in WebKit: ${JSON.stringify(after)}`);
}

const ordering = await page.evaluate((source) => {
  document.body.innerHTML = '<button id="play-btn-main"></button>';
  window.currentStory = { title: 'Test', chapters: [{ paragraphs: ['Hello'] }] };
  window.currentChapterIndex = 0;
  window.currentParagraphIndex = 0;
  window.isPlaying = false;
  window.BufferManager = null;
  window.__events = [];
  window._setControlsLocked = () => {};
  window.requestPocketNarrationIsolation = () => {
    window.__events.push('isolation');
    return true;
  };
  const harness = new Function(`
    const _resolveActiveEngine = () => 'pocket';
    const preparePocketMobileMediaSession = () => window.__events.push('media');
    const _updatePlayButton = () => window.__events.push('button');
    const startBgKeepAlive = () => window.__events.push('keepalive');
    const _signalColdStartOnce = () => {};
    const playCurrentParagraph = () => window.__events.push('play');
    const pausePlayback = () => {};
    ${source}
    return togglePlayState;
  `);
  harness()();
  return { events: window.__events, isPlaying: window.isPlaying };
}, toggleSource);

if (ordering.events.join(',') !== 'media,isolation' || ordering.isPlaying !== false) {
  throw new Error(`iOS isolation ordering is wrong: ${JSON.stringify(ordering)}`);
}

await browser.close();
console.log(JSON.stringify({ deferred: before, activated: after, isolationOrdering: ordering }, null, 2));
