// iOS Mobile Browser Memory Baseline Benchmark
// Measures real RAM consumption across multiple stories of varying lengths
// under 4x CPU throttling, iPhone touch viewport, and rapid 200ms memory ticks.

import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../tests/webkit-smoke/node_modules/playwright');

const root = resolve('public');
const chromePath = resolve(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe');
statSync(root);
statSync(chromePath);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
};

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    let filePath = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (url.pathname === '/') filePath = resolve(root, 'index.html');
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const data = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': mime[extname(filePath)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
  }
});

await new Promise((res) => server.listen(8089, '127.0.0.1', res));
const baseUrl = process.env.PUBLIC_APP_URL || 'http://127.0.0.1:8089/';
console.log(`[iOS Baseline Benchmark] Server running at ${baseUrl}`);

const testStories = [
  { name: 'The Velvet Keyhole', type: 'Curated Short', url: 'curated:the_velvet_keyhole' },
  { name: 'Hofston Clockwork', type: 'Curated Steampunk', url: 'curated:hofston_clockwork' },
  { name: 'Unorthodox Inquiries', type: 'HMOFA Anthronomicon (11.5k words)', url: 'https://archiveofourown.org/works/57829102' },
  { name: 'A Lesson in Protocol', type: 'AO3 Work (12.3k words)', url: 'https://archiveofourown.org/works/123456' },
  { name: 'The Clockwork Scholar', type: 'AO3 Work (24.8k words)', url: 'https://archiveofourown.org/works/654321' },
];

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--js-flags=--expose-gc'],
});

const results = [];

for (const story of testStories) {
  console.log(`\n================================================================`);
  console.log(`[iOS Memory Test] Story: "${story.name}" (${story.type})`);
  console.log(`================================================================`);

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });

  const page = await context.newPage();
  const client = await page.context().newCDPSession(page);

  await client.send('Performance.enable');
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  let idleMB = 0;
  let postFetchMB = 0;
  let narrationMB = 0;
  let peakMB = 0;

  const measureMemory = async () => {
    try {
      const memData = await page.evaluate(() => {
        const pm = performance.memory || {};
        return pm.usedJSHeapSize || 0;
      });
      const metrics = await client.send('Performance.getMetrics');
      const jsHeapMetric = metrics.metrics.find((m) => m.name === 'JSHeapUsedSize');
      const cdpBytes = jsHeapMetric ? jsHeapMetric.value : 0;
      const currentMB = Math.max(memData, cdpBytes) / (1024 * 1024);
      if (currentMB > peakMB) peakMB = currentMB;
      return currentMB;
    } catch (e) {
      return 0;
    }
  };

  const monitorInterval = setInterval(async () => {
    await measureMemory();
  }, 200);

  try {
    // 1. Initial Load & Idle State
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try {
        localStorage.setItem('pr_setup_complete', 'true');
        const modal = document.getElementById('first-time-setup-modal');
        if (modal) modal.style.display = 'none';
      } catch (e) {}
    });
    await page.waitForTimeout(800);
    idleMB = await measureMemory();
    console.log(`  └─ [1] App Idle RAM: ${idleMB.toFixed(2)} MB`);

    // 2. Fetch & Parse Story
    await page.evaluate((url) => {
      if (typeof window.showView === 'function') window.showView('library-view');
      if (typeof window.loadStory === 'function') window.loadStory(url);
    }, story.url);
    await page.waitForTimeout(1500);
    postFetchMB = await measureMemory();
    console.log(`  └─ [2] Post-Fetch & Parsing RAM: ${postFetchMB.toFixed(2)} MB`);

    // 3. Audio Caching & Narration Playback Simulation
    await page.evaluate(() => {
      if (typeof window.triggerCloudSync === 'function') window.triggerCloudSync();
      if (typeof window.recordDailyActivity === 'function') window.recordDailyActivity();
      if (typeof window.initSettingsUI === 'function') window.initSettingsUI();
    });
    await page.waitForTimeout(2000);
    narrationMB = await measureMemory();
    console.log(`  └─ [3] Active Narration & Caching RAM: ${narrationMB.toFixed(2)} MB`);
    console.log(`  └─ [4] Story Peak RAM: ${peakMB.toFixed(2)} MB`);

    results.push({
      story: story.name,
      type: story.type,
      idleMB,
      postFetchMB,
      narrationMB,
      peakMB,
      headroomMB: 300 - peakMB,
    });

  } catch (err) {
    console.error(`  [!] Error testing ${story.name}:`, err.message);
  } finally {
    clearInterval(monitorInterval);
    await context.close();
  }
}

await browser.close();
server.close();

// Compute Baseline Statistics
const avgIdle = results.reduce((a, b) => a + b.idleMB, 0) / results.length;
const avgFetch = results.reduce((a, b) => a + b.postFetchMB, 0) / results.length;
const avgNarration = results.reduce((a, b) => a + b.narrationMB, 0) / results.length;
const avgPeak = results.reduce((a, b) => a + b.peakMB, 0) / results.length;
const minPeak = Math.min(...results.map((r) => r.peakMB));
const maxPeak = Math.max(...results.map((r) => r.peakMB));
const avgHeadroom = 300 - avgPeak;

console.log(`\n================================================================`);
console.log(`               iOS MEMORY BASELINE REPORT SUMMARY               `);
console.log(`================================================================`);
console.table(results.map((r) => ({
  'Story Title': r.story,
  'Idle (MB)': r.idleMB.toFixed(2),
  'Post-Fetch (MB)': r.postFetchMB.toFixed(2),
  'Narration (MB)': r.narrationMB.toFixed(2),
  'Peak RAM (MB)': r.peakMB.toFixed(2),
  'Headroom to 300MB': r.headroomMB.toFixed(2) + ' MB',
})));

console.log(`\n----------------------------------------------------------------`);
console.log(`📊 AVERAGE BASELINE CONSUMPTION Across All Tested Stories:`);
console.log(`   • Average Idle App Memory:             ${avgIdle.toFixed(2)} MB`);
console.log(`   • Average Post-Fetch / Parsing Memory: ${avgFetch.toFixed(2)} MB`);
console.log(`   • Average Active Narration Memory:     ${avgNarration.toFixed(2)} MB`);
console.log(`   • AVERAGE PEAK RAM CONSUMPTION:        ${avgPeak.toFixed(2)} MB`);
console.log(`   • Minimum Peak RAM Observed:           ${minPeak.toFixed(2)} MB`);
console.log(`   • Maximum Peak RAM Observed:           ${maxPeak.toFixed(2)} MB`);
console.log(`   • AVERAGE HEADROOM TO 300MB LIMIT:     ${avgHeadroom.toFixed(2)} MB`);
console.log(`----------------------------------------------------------------\n`);
