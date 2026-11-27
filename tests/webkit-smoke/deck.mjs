// v2 browser smoke: the production build (dist/) on the real cores, at iPhone
// size, in Chromium or WebKit (DECK_BROWSER=webkit).
//
// Covers what unit tests cannot: the cores loading by their versioned URLs into
// the Svelte shell, the profile surviving a reload, and the service worker
// serving the whole app offline (shell, hashed bundle, cores, story text).
// Narration itself is not played here: CI has no route to the model proxy, and
// audio quality is not judgeable by a test anyway.
//
// Prerequisite: `npm run build`. Usage: node tests/webkit-smoke/deck.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

if (!existsSync('dist/index.html') || !existsSync('dist/sw.js')) {
  throw new Error('dist/ is missing: run `npm run build` first.');
}

const port = process.env.DECK_PORT || '4789';
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['tools/serve_public.mjs', port, '--root', 'dist'], { stdio: ['ignore', 'pipe', 'inherit'] });
const title = 'Night Train';
const text = [
  'Chapter 1', '',
  'The whistle sounded twice, and the carriage lurched forward into the dark.', '',
  '"Are we late?" she asked. Nobody answered.', '',
  'At dawn, the train reached the coast, and the sea was the colour of slate.',
].join('\n');

const uploadedStory = {
  title,
  author: 'Demo author',
  chapters: [{
    title: 'Chapter 1',
    paragraphs: [
      'The whistle sounded twice, and the carriage lurched forward into the dark.',
      '"Are we late?" she asked. Nobody answered.',
      'At dawn, the train reached the coast, and the sea was the colour of slate.',
    ],
  }],
};

let browser;
try {
  await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(() => { throw new Error('Static server failed to start'); }),
  ]);
  browser = await (process.env.DECK_BROWSER === 'webkit' ? webkit : chromium).launch();
  // WebKit runs without the service worker: with one controlling the page,
  // Playwright's WebKit stops routing the page's cross-origin fetches through
  // the stand-ins below, and it cannot do the offline reload anyway. Chromium
  // keeps it, and covers the offline boot.
  const offlineCheck = process.env.DECK_BROWSER !== 'webkit';
  const ctx = await browser.newContext({
    viewport: { width: 402, height: 874 }, hasTouch: true, deviceScaleFactor: 2,
    serviceWorkers: offlineCheck ? 'allow' : 'block',
  });

  // Everything off-origin (the API proxy, Supabase-era endpoints, fonts CDNs)
  // is answered locally, so CI needs no network and no credentials.
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || !url.protocol.startsWith('http')) return route.continue();
    // Uploaded files are parsed by the backend (POST /api/upload), as in production.
    // WebKit enforces CORS on fulfilled responses (Chromium does not), and the
    // real proxy sends these headers, so the stand-in must too.
    const headers = {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': route.request().headers()['access-control-request-headers'] || 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname.endsWith('/api/upload')) return route.fulfill({ json: uploadedStory, headers });
    return route.fulfill({ json: { items: [], stories: [], results: [], count: 0 }, headers });
  });

  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const bridgeReady = () => page.waitForFunction(() => window.__pocketCoreBridge?.kind === 'real', null, { timeout: 20000 });

  // ── First launch: onboarding, on the real bridge ──────────────────────────
  await page.goto(origin);
  await bridgeReady();
  await page.getByText('Stories, read aloud.').waitFor({ timeout: 10000 });
  // Scoped to the onboarding dialog: the tab bar behind it has a Listen button too.
  await page.getByRole('dialog').getByRole('button', { name: /^Listen/ }).click();
  await page.waitForFunction(() => localStorage.getItem('pr_setup_complete') === 'true');

  // ── Import, open, bookmark, speed ─────────────────────────────────────────
  const key = await page.evaluate(async ([name, body]) => {
    const summary = await window.__pocketCoreBridge.importFile(new File([body], `${name}.txt`, { type: 'text/plain' }));
    return summary.key;
  }, [title, text]);
  assert.ok(key, 'import returns a library key');
  const opened = await page.evaluate(async (k) => {
    const b = window.__pocketCoreBridge;
    const story = await b.loadStory({ kind: 'key', key: k });
    await b.seekToParagraph(2);
    const mark = await b.saveBookmark('dawn');
    b.setSpeed(1.25);
    return { paragraphs: story.chapters[0].paragraphs.length, mark: [mark.chapter, mark.paragraph, mark.label] };
  }, key);
  assert.ok(opened.paragraphs >= 3, `story text loaded (${opened.paragraphs} paragraphs)`);
  assert.deepEqual(opened.mark, [0, 2, 'dawn']);
  await page.getByText(title).first().waitFor({ timeout: 5000 });

  // ── Reload: the profile and its settings come back ────────────────────────
  // Also lets the service worker (registered by the production build) take
  // control of this page before going offline.
  await page.reload();
  await bridgeReady();
  if (offlineCheck) await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15000 });
  const restored = await page.evaluate(async (k) => {
    const b = window.__pocketCoreBridge;
    const entry = (await b.library.list()).find((e) => e.story.key === k);
    return { title: entry?.story.title, bookmarks: entry?.bookmarks.length, speed: (await b.getSettings()).speed };
  }, key);
  assert.deepEqual(restored, { title, bookmarks: 1, speed: 1.25 });
  assert.equal(await page.getByText('Stories, read aloud.').count(), 0, 'onboarding does not return');

  // ── Open by tapping: Library tab → story → Read ───────────────────────────
  // The story sheet's Listen and Read buttons closed the sheet and then read
  // their story from it, threw, and did nothing; opening through the bridge
  // above never noticed. (Read, not Listen: Listen would start the voice model.)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${title} by `) }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: /^Read$/ }).click();
  await page.getByRole('dialog', { name: 'Reader' }).waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => window.currentStory?.title), title, 'Read opens the tapped story');
  await page.getByRole('button', { name: 'Close reader' }).click();

  // ── Offline: the whole app comes from the service worker ──────────────────
  // Chromium only. Playwright's WebKit cannot reload a service-worker-controlled
  // page under offline emulation ("WebKit encountered an internal error"), which
  // is a harness limit, not an app one; a real iPhone check covers WebKit.
  if (offlineCheck) {
  await ctx.setOffline(true);
  await page.reload();
  await bridgeReady();
  await page.getByText(title).first().waitFor({ timeout: 10000 });
  const offline = await page.evaluate(async (k) => {
    const story = await window.__pocketCoreBridge.loadStory({ kind: 'key', key: k });
    return story.chapters[0].paragraphs.length;
  }, key);
  assert.equal(offline, opened.paragraphs, 'story text opens offline from IndexedDB');
  await ctx.setOffline(false);
  }

  assert.deepEqual(errors, [], 'no uncaught page errors');
  console.log(`Deck smoke passed (${process.env.DECK_BROWSER || 'chromium'}): onboarding, import, open, bookmark, settings after reload, `
    + (offlineCheck ? 'offline boot.' : 'offline boot SKIPPED (WebKit harness limit).'));
} finally {
  await browser?.close();
  server.kill();
}
