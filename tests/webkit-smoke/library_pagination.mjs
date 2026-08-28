// Library pagination + touch-target check in real WebKit (the engine iOS uses).
//
// renderLibrary used to draw EVERY story with no limit; each card is ~30-40
// elements, so a 200-story library was ~8,000 nodes built synchronously on the
// phones least able to afford it. This drives the paged render for real rather
// than pattern-matching the source: it seeds 60 stories, checks the first page,
// pages through to the end, and confirms a filter change snaps back to page 1.
//
// Needs the app served locally first (the page is static; no backend required):
//   python -m http.server 8791 --directory public
//   node tests/webkit-smoke/library_pagination.mjs
//
// NOTE: measure sizes only with the view actually shown. An inactive view is
// display:none, so every element reads 0x0 and looks like a layout bug.
import { webkit } from 'playwright';
const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 150)));
await page.goto('http://127.0.0.1:8791/index.html', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4500);

const r = await page.evaluate(async () => {
  const out = {};
  if (!window.userProfile) return { note: 'no userProfile' };
  window.userProfile.library = Array.from({ length: 60 }, (_, i) => ({
    id: 'demo-' + i, storyId: 'demo-' + i, title: 'Story ' + i, author: 'A' + i,
    chapters: [], addedAt: Date.now() - i * 1000, progressChapter: 0, progressParagraph: 0, tags: [], fandoms: [],
  }));
  window.currentLibraryFilter = 'all';
  window.showView('library-view');
  await new Promise(r => setTimeout(r, 500));
  window.renderLibrary(true);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  out.firstPage = document.querySelectorAll('#library-grid .story-card').length;
  out.hasShowMore = !!document.getElementById('library-show-more');
  out.showMoreLabel = document.getElementById('library-show-more')?.textContent?.trim();
  // 44px target check on the control itself.
  const b = document.getElementById('library-show-more')?.getBoundingClientRect();
  out.showMoreSize = b ? `${Math.round(b.width)}x${Math.round(b.height)}` : null;
  const card = document.querySelector('#library-grid .story-card')?.getBoundingClientRect();
  out.storyCardSize = card ? `${Math.round(card.width)}x${Math.round(card.height)}` : null;
  const lv = document.getElementById('library-view');
  out.libraryViewDisplay = lv ? getComputedStyle(lv).display : null;
  window.showMoreLibraryStories();
  out.secondPage = document.querySelectorAll('#library-grid .story-card').length;
  window.showMoreLibraryStories();
  window.showMoreLibraryStories();
  out.fullyExpanded = document.querySelectorAll('#library-grid .story-card').length;
  out.showMoreGoneAtEnd = !document.getElementById('library-show-more');
  // Changing the filter must snap the page back to the first 24.
  window.currentLibraryFilter = 'not-started';
  window.renderLibrary(true);
  out.afterFilterChange = document.querySelectorAll('#library-grid .story-card').length;
  return out;
});
console.log(JSON.stringify(r, null, 2));
if (errs.length) console.log('page errors:', [...new Set(errs)].filter(e => !/access control|Fetch API/.test(e)).slice(0, 4));
await browser.close();
