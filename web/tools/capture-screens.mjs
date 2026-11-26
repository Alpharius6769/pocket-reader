#!/usr/bin/env node
/**
 * Design-review screenshots of every v2 screen, light and dark, at iPhone 16 Pro
 * size (402x874) in WebKit, with the ?sim=iphone status bar + Dynamic Island.
 *
 *   npm run dev                       # serves http://localhost:5180
 *   PLAYWRIGHT_DIR=<dir with node_modules/playwright> node web/tools/capture-screens.mjs [outDir]
 *
 * Playwright is not a project dependency; point PLAYWRIGHT_DIR at any install
 * (tests/webkit-smoke has one once `npm install` has run there).
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const pwDir = process.env.PLAYWRIGHT_DIR ?? resolve('tests/webkit-smoke');
const { webkit } = createRequire(join(pwDir, 'package.json'))('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:5180/';
const OUT = resolve(process.argv[2] ?? 'ui-review');
const WIDTH = Number(process.env.WIDTH ?? 402);
const HEIGHT = Number(process.env.HEIGHT ?? 874);

/** [file, query, hash, settle ms] */
export const SHOTS = [
  ['01-onboarding', 'onboarded=0', '', 600],
  ['02-listen', '', '', 600],
  ['03-listen-empty', 'empty=1', '', 600],
  ['04-library-grid', '', 'library', 500],
  ['05-library-list', '', 'library/list', 500],
  ['06-story-actions', '', 'story/mock-ferry-house', 700],
  ['07-discover-ao3', '', 'discover', 600],
  ['08-discover-results', '', 'discover/results', 900],
  ['09-ao3-filters', '', 'discover/filters', 700],
  ['10-story-preview', '', 'preview', 900],
  ['11-catalog', '', 'discover/catalog', 900],
  ['12-import', '', 'discover/import', 600],
  ['13-now-playing', '', 'now-playing', 900],
  ['14-now-playing-live', '', 'now-playing/playing', 2600],
  ['15-preparing-narration', 'cold=1', 'now-playing/preparing', 1300],
  ['16-chapters', '', 'now-playing/chapters', 800],
  ['17-bookmarks', '', 'now-playing/bookmarks', 800],
  ['18-voice-speed', '', 'now-playing/voice', 800],
  ['19-sleep-timer', '', 'now-playing/sleep', 800],
  ['20-reader', '', 'reader', 900],
  ['21-settings', '', 'settings', 500],
  ['22-settings-voice', '', 'settings/voice', 600],
  ['23-pronunciation', '', 'settings/pronunciation', 500],
  ['24-reading-text', '', 'settings/display', 500],
  ['25-storage', '', 'settings/storage', 600],
  ['26-backup', '', 'settings/backup', 600],
  ['27-about', '', 'settings/about', 600],
  ['28-diagnostics', '', 'settings/diagnostics', 600],
  ['29-toast', 'toast=1', '', 450],
];

const browser = await webkit.launch();
for (const scheme of ['light', 'dark']) {
  const dir = join(OUT, scheme);
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: scheme,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  for (const [name, query, hash, settle] of SHOTS) {
    const page = await ctx.newPage();
    const url = `${BASE}?sim=iphone${query ? `&${query}` : ''}${hash ? `#${hash}` : ''}`;
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(settle);
    await page.screenshot({ path: join(dir, `${name}.png`) });
    await page.close();
    process.stdout.write(`${scheme}/${name} `);
  }
  await ctx.close();
}
await browser.close();
console.log(`\nSaved to ${OUT}`);
