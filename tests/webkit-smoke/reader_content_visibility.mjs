// Does content-visibility break the reader in the engine iOS actually uses?
// The uncertainty in wrapping chapters is not whether the markup is balanced
// (a static test covers that) but whether a SKIPPED subtree still supports
// getElementById, scrollIntoView and event delegation. Answer it in WebKit.
import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone 13
const fail = [];
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail.push(m); };

// Same shape renderFullStory emits: sections with a per-chapter intrinsic size,
// paragraphs carrying data-chapter/data-paragraph and reader-p-C-P ids.
await page.setContent(`<!doctype html><meta charset=utf-8>
<style>
  .reader-chapter { content-visibility: auto; }
  #reader-content { width: min(100%, 78ch); margin-inline: auto; }
  #reader-content .reader-paragraph { margin-block: 0 1em; }
  .reader-paragraph.highlight { background: yellow; }
</style>
<div id="reader-content"></div>
<script>
  const D = document.getElementById('reader-content');
  const parts = [];
  for (let c = 0; c < 6; c++) {
    const paras = Array.from({length: 45}, (_, i) => 'Chapter ' + c + ' paragraph ' + i + ' ' + 'lorem ipsum dolor '.repeat(18));
    const chars = paras.reduce((n, t) => n + t.length, 0);
    const est = Math.max(400, Math.round((chars / 60) * 28 + paras.length * 16));
    parts.push('<section class="reader-chapter" style="contain-intrinsic-size:auto ' + est + 'px">');
    if (c > 0) parts.push('<h1 class="chapter-title" id="reader-ch-' + c + '">Chapter ' + c + '</h1>');
    paras.forEach((t, p) => parts.push('<p class="reader-paragraph" id="reader-p-' + c + '-' + p + '" data-chapter="' + c + '" data-paragraph="' + p + '">' + t + '</p>'));
    parts.push('</section>');
  }
  D.innerHTML = parts.join('');
  window.__seeks = [];
  D.addEventListener('dblclick', (e) => {
    const t = e.target.closest && e.target.closest('.reader-paragraph');
    if (!t || !D.contains(t)) return;
    window.__seeks.push([parseInt(t.dataset.chapter,10), parseInt(t.dataset.paragraph,10)]);
  });
<\/script>`);

ok(await page.evaluate(() => CSS.supports('content-visibility', 'auto')),
   'WebKit supports content-visibility:auto (else it degrades to today\'s behaviour)');

const struct = await page.evaluate(() => ({
  sections: document.querySelectorAll('#reader-content > section.reader-chapter').length,
  paras: document.querySelectorAll('#reader-content .reader-paragraph').length,
  perSection: [...document.querySelectorAll('section.reader-chapter')].map(s => s.querySelectorAll('.reader-paragraph').length),
}));
ok(struct.sections === 6, `6 sections parsed, not nested/unbalanced (got ${struct.sections})`);
ok(struct.paras === 270, `all 270 paragraphs present in DOM (got ${struct.paras})`);
ok(struct.perSection.every(n => n === 45), `each section holds its own 45 paragraphs (${struct.perSection})`);

// The descendant selector the highlight code uses must still match through the section.
ok(await page.evaluate(() => {
  const el = document.getElementById('reader-p-5-40');
  if (!el) return false;
  el.classList.add('highlight');
  return document.querySelectorAll('#reader-content .reader-paragraph.highlight').length === 1;
}), 'highlight selector still matches through the section wrapper');

// The real question: a paragraph deep in a SKIPPED section.
const deep = await page.evaluate(async () => {
  const el = document.getElementById('reader-p-5-40');
  const foundWhileSkipped = !!el;
  el.scrollIntoView({ behavior: 'auto', block: 'start' });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const r = el.getBoundingClientRect();
  return { foundWhileSkipped, top: Math.round(r.top), h: Math.round(r.height), vh: innerHeight };
});
ok(deep.foundWhileSkipped, 'getElementById reaches into an off-screen skipped section');
ok(deep.h > 0, `the skipped paragraph has real layout once scrolled to (height ${deep.h})`);
ok(deep.top > -60 && deep.top < deep.vh,
   `scrollIntoView LANDS it in the viewport, no estimate drift (top ${deep.top}, viewport ${deep.vh})`);

// Delegation must survive a target inside a section that was skipped a moment ago.
const seeks = await page.evaluate(async () => {
  document.getElementById('reader-p-4-10').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  return window.__seeks;
});
ok(JSON.stringify(seeks) === '[[4,10]]', `delegated dblclick reports the right indices (got ${JSON.stringify(seeks)})`);

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED` : '\nall checks passed');
process.exit(fail.length ? 1 : 0);

// Run: node tests/webkit-smoke/reader_content_visibility.mjs  (self-contained, no server needed)
