// iOS Mobile Browser Simulation & Rapid Memory Crash Monitor
// Simulates iOS Chrome/Safari behavior with 4x CPU throttling, iPhone touch viewport,
// rapid memory monitoring at 200ms ticks, and simulated 300MB memory crash & recovery.

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

// Simple static server with required cross-origin isolation headers for TTS/WASM
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

await new Promise((res) => server.listen(8088, '127.0.0.1', res));
console.log('Local iOS Test Server listening on http://127.0.0.1:8088');

const targetUrl = process.env.PUBLIC_APP_URL || 'http://127.0.0.1:8088/';
console.log(`Targeting URL: ${targetUrl}`);

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--js-flags=--expose-gc'],
});

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
});

const page = await context.newPage();
const client = await page.context().newCDPSession(page);

// 1. Enable Performance domain and set 4x CPU Throttling
await client.send('Performance.enable');
await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
console.log('[iOS Simulator] CPU Throttling set to 4x (Mobile CPU Rate)');

let peakMemoryMB = 0;
let crashTriggered = false;
let monitorInterval = null;

const checkMemory = async () => {
  try {
    const memData = await page.evaluate(() => {
      const pm = performance.memory || {};
      return {
        usedJSHeapSize: pm.usedJSHeapSize || 0,
        totalJSHeapSize: pm.totalJSHeapSize || 0,
        jsHeapSizeLimit: pm.jsHeapSizeLimit || 0,
      };
    });
    const metrics = await client.send('Performance.getMetrics');
    const jsHeapMetric = metrics.metrics.find((m) => m.name === 'JSHeapUsedSize');
    const cdpBytes = jsHeapMetric ? jsHeapMetric.value : 0;
    const currentBytes = Math.max(memData.usedJSHeapSize, cdpBytes);
    const currentMB = currentBytes / (1024 * 1024);

    if (currentMB > peakMemoryMB) peakMemoryMB = currentMB;
    console.log(`[Memory Monitor @ 200ms] Current: ${currentMB.toFixed(2)} MB | Peak: ${peakMemoryMB.toFixed(2)} MB (CDP: ${(cdpBytes / 1048576).toFixed(2)} MB)`);

    if (currentMB >= 300 && !crashTriggered) {
      crashTriggered = true;
      console.warn(`\n================================================================`);
      console.warn(`[iOS SIMULATOR] ⚠️ CRASH THRESHOLD EXCEEDED: ${currentMB.toFixed(2)} MB >= 300.00 MB`);
      console.warn(`[iOS SIMULATOR] Forcing iOS mobile browser tab crash and reload...`);
      console.warn(`================================================================\n`);
      clearInterval(monitorInterval);

      // Force tab reload simulating iOS tab crash
      await page.reload({ waitUntil: 'domcontentloaded' });
      console.log(`[iOS SIMULATOR] Tab successfully reloaded after crash event.`);
    }
  } catch (e) {
    // Session or page closed
  }
};

// Start rapid 200ms memory monitoring ticks
monitorInterval = setInterval(checkMemory, 200);

try {
  // Navigate to Web App
  console.log(`[iOS Simulator] Navigating to ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  // Dismiss onboarding if present
  await page.evaluate(() => {
    try {
      localStorage.setItem('pr_setup_complete', 'true');
      const modal = document.getElementById('first-time-setup-modal');
      if (modal) modal.style.display = 'none';
    } catch (e) {}
  });

  // Mess around in the app:
  // Action 1: Browse to library and inspect stories
  console.log('[iOS Simulator] Action 1: Interacting with Library & Curated Stories...');
  await page.evaluate(() => {
    if (typeof window.showView === 'function') window.showView('library-view');
  });
  await page.waitForTimeout(1000);

  // Action 2: Trigger story fetch / load
  console.log('[iOS Simulator] Action 2: Fetching story into Pocket Reader...');
  await page.evaluate(() => {
    if (typeof window.loadStory === 'function') {
      window.loadStory('https://archiveofourown.org/works/123456');
    }
  });
  await page.waitForTimeout(1500);

  // Action 3: Start story audio caching & narration simulation
  console.log('[iOS Simulator] Action 3: Starting story audio caching and narration buffer...');
  await page.evaluate(() => {
    if (typeof window.triggerCloudSync === 'function') window.triggerCloudSync();
    if (typeof window.recordDailyActivity === 'function') window.recordDailyActivity();
  });
  await page.waitForTimeout(2000);

  // Action 4: Allocate dynamic memory load to test 300MB crash trigger condition
  console.log('[iOS Simulator] Action 4: Allocating dynamic memory to test 300MB crash condition...');
  await page.evaluate(async () => {
    window.__iosTestRetain = window.__iosTestRetain || [];
    for (let i = 0; i < 40; i++) {
      // Allocate 1M element objects (40 steps = ~350MB-450MB of real V8 heap)
      const chunk = [];
      for (let j = 0; j < 150000; j++) {
        chunk.push({ k: i, v: j, s: 'ios_mem_sim_' + i + '_' + j, val: Math.random() });
      }
      window.__iosTestRetain.push(chunk);
      await new Promise((r) => setTimeout(r, 60));
    }
  });

  await page.waitForTimeout(3000);

} catch (err) {
  console.error('[iOS Simulator] Action loop error:', err.message);
} finally {
  clearInterval(monitorInterval);
  console.log(`\n----------------------------------------------------------------`);
  console.log(`[iOS Simulation Summary] Peak Memory Observed: ${peakMemoryMB.toFixed(2)} MB`);
  console.log(`[iOS Simulation Summary] 300MB Crash Triggered: ${crashTriggered ? 'YES (Simulated Crash & Tab Reloaded)' : 'NO (Peak stayed under 300MB)'}`);
  console.log(`----------------------------------------------------------------\n`);
  await browser.close();
  server.close();
}
