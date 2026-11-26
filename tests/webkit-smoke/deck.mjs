import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, webkit } from 'playwright';

const port = process.env.DECK_PORT || '4789';
const origin = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, ['tools/serve_public.mjs', port], { stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
const title = 'Night train across the mountains';
const story = { title, author: 'Demo author', chapters: [
  { title: 'Departure', paragraphs: ['The whistle sounded.', 'We crossed the river.'] },
  { title: 'Arrival', paragraphs: ['At dawn, the train reached the coast.'] },
] };

try {
  await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw Error('Preview failed to start'); })]);
  browser = await (process.env.DECK_BROWSER === 'webkit' ? webkit : chromium).launch();
  const ctx = await browser.newContext({ viewport: { width: 320, height: 640 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    if (!('speechSynthesis' in window)) {
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      window.speechSynthesis = { getVoices: () => [], cancel() {}, pause() {}, resume() {} };
    }
  });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));

  // External story sources are simulated so CI never needs the network.
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin === origin || !u.protocol.startsWith('http')) return route.continue();
    let data;
    if (u.pathname === '/api/upload') data = story;
    else if (u.pathname.endsWith('/catalog.json')) data = { schemaVersion: 1, records: [{id:'night',title:'The Last Train',authors:['Demo author'],sources:[],tags:[],partnerSpecies:[],worlds:['HMOFA']}], recordCount: 1 };
    else data = { items: [], count: 0, ratings: {}, trending: [] };
    return route.fulfill({ json: data });
  });
  await page.goto(origin);
  await page.locator('#setup-skip-btn').click();
  assert.equal(await page.locator('#device-setup-modal').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Browse stories', exact: true }).isVisible(), true);
  await page.locator('#local-file-upload').setInputFiles({ name: 'night.txt', mimeType: 'text/plain', buffer: Buffer.from('A local book') });
  await page.waitForFunction(() => window.currentActiveView === 'reading-view' && window.currentStory?.chapters.length === 2);
  assert.equal(await page.locator('#device-setup-modal').isVisible(), false);
  const nav = name => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
  await nav('Home');
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await page.locator('#device-setup-modal').getByRole('button', {name:'Cancel', exact:true}).click();
  assert.equal(await page.evaluate(() => !!window.isPlaying), false);
  await page.locator('.deck-voice summary').click();
  await page.locator('#reader-engine-select').selectOption('webspeech');
  // Headless hosts have no system voice. Keep the browser utterance alive while
  // exercising real playback, navigation and pause handlers.
  await page.evaluate(() => { speechSynthesis.speak = utterance => { window.testUtterance = utterance; }; });
  await nav('Home');
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await page.waitForFunction(() => window.isPlaying && window.testUtterance);
  await nav('Library');
  await page.waitForSelector('#deck-mini:not([hidden])');
  await nav('Discover');
  await page.waitForFunction(() => window.currentActiveView === 'hmofa-view');
  await page.getByText('The Last Train', {exact:true}).first().waitFor();
  assert.equal(await page.evaluate(() => window.testUtterance === window.currentAudio && window.isPlaying), true);
  await page.locator('[data-deck-toggle]').click();
  assert.equal(await page.evaluate(() => window.isPlaying), false);
  await page.locator('[data-deck-return]').click();
  await page.waitForFunction(() => window.currentActiveView === 'reading-view');
  await page.evaluate(() => window.seekToParagraph(1, 0));
  await nav('Home');
  await page.waitForFunction(() => document.querySelector('.deck-scale')?.textContent.includes('Arrival'));
  for (const size of [{width:320,height:568},{width:740,height:360},{width:1280,height:820}]) {
    await page.setViewportSize(size);
    for (const text of ['Read','Listen']) {
      const box = await page.getByRole('button', { name:text, exact:true }).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1, JSON.stringify({text,size,box}));
    }
  }
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page.waitForFunction(() => window.currentActiveView === 'reading-view');
  assert.equal(await page.evaluate(() => window.currentChapterIndex), 1);

  await page.evaluate(() => {
    window.saveBookmark();
    window.saveLocalData({ immediate: true, skipCloud: true });
  });
  const saved = await ctx.storageState({ indexedDB: true });
  // Accounts were retired: a sign-in token left over from an earlier version is
  // cleared at load, and the local library survives the reload untouched.
  const libraryBefore = await page.evaluate(() => window.userProfile.library.map((s) => s.storyKey).sort());
  await page.evaluate(() => {
    localStorage.setItem('pr_supabase_session_v1', JSON.stringify({ access_token: 'fixture', refresh_token: 'fixture' }));
    localStorage.setItem('pr_profile_owner', 'reader@example.test');
  });
  await page.reload();
  await page.waitForFunction(() => window.__pocketProfileHydrated === true, null, { timeout: 12000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('pr_supabase_session_v1')), null, 'retired session token is cleared');
  assert.equal(await page.evaluate(() => localStorage.getItem('pr_profile_owner')), null, 'retired account owner is cleared');
  assert.deepEqual(await page.evaluate(() => window.userProfile.library.map((s) => s.storyKey).sort()), libraryBefore);
  assert.deepEqual(errors, []);
  const offline = await browser.newContext({ storageState: saved });
  await offline.route(/^https:\/\//, route => route.abort('internetdisconnected'));
  const offlinePage = await offline.newPage();
  const seedPage = origin + '/upgrade-fixture.html';
  await offlinePage.route(seedPage, route => route.fulfill({ contentType:'text/html', body:'<!doctype html><title>Previous install</title>' }));
  await offlinePage.goto(seedPage);
  await offlinePage.evaluate(async () => {
    await caches.open('pocket-reader-core-legacy-review');
    for (const name of ['hmofa-catalog-v1', 'pocket-voices-review']) {
      const cache = await caches.open(name);
      await cache.put('/upgrade-sentinel', new Response(name));
    }
  });
  await offlinePage.evaluate(() => navigator.serviceWorker.register('./sw.js'));
  await offlinePage.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 60000 });
  const preserved = await offlinePage.evaluate(async () => ({
    oldShell: await caches.has('pocket-reader-core-legacy-review'),
    catalog: await (await (await caches.open('hmofa-catalog-v1')).match('/upgrade-sentinel'))?.text(),
    voices: await (await (await caches.open('pocket-voices-review')).match('/upgrade-sentinel'))?.text(),
  }));
  assert.deepEqual(preserved, { oldShell: false, catalog:'hmofa-catalog-v1', voices:'pocket-voices-review' });
  await offlinePage.goto(origin);
  await offlinePage.waitForFunction(() => window.__pocketProfileHydrated);
  // Removing the origin also exercises WebKit builds whose offline emulation
  // prevents the navigation from reaching the service worker at all.
  const stopped = once(server, 'exit');
  server.kill();
  await stopped;
  await offlinePage.reload({ waitUntil: 'domcontentloaded' });
  await offlinePage.locator('.sidebar').getByRole('button', { name:'Home', exact:true }).click();
  await offlinePage.getByRole('heading', {name:title}).waitFor();
  await offlinePage.locator('.deck-scale').getByText('Arrival', { exact:true }).waitFor();
  await offlinePage.getByRole('button', { name:'Read', exact:true }).click();
  await offlinePage.waitForFunction(() => window.currentStory?.chapters?.[1]?.title === 'Arrival'
    && window.currentActiveView === 'reading-view' && window.currentChapterIndex === 1
    && window.userProfile.library.some(entry => entry.title === window.currentStory.title && entry.bookmarks?.some(b => b.c === 1)),
    null, { timeout: 8000 }).catch(async error => {
      console.error('Offline read', await offlinePage.evaluate(() => ({
        view: window.currentActiveView, title: window.currentStory?.title, chapter: window.currentChapterIndex,
        chapters: window.currentStory?.chapters?.length, notice: document.querySelector('#deck-notice')?.textContent,
        stories: window.userProfile.library.filter(s => s.author === 'Demo author').map(s => [s.title, s.progressChapter, s.bookmarks?.length])
      })));
      throw error;
    });
  await offline.close();
  console.log('Deck smoke passed: import, resume, calibration cancel, transport continuity, layout, catalog, retired-account cleanup, offline upgrade.');
} finally {
  try { await browser?.close(); } finally { server.kill(); }
}
