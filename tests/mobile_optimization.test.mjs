// Mobile optimization pass, 2026-08-28. Each guard pins a cost that only shows
// up on a phone: node counts, retained closures, compositor layers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

test('the reader seeks via one delegated listener, not a closure per paragraph', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  // A 60k-word story is ~1,000-1,200 paragraphs; this attached an ondblclick to
  // every one and retained them for the session.
  assert.doesNotMatch(ui, /querySelectorAll\('\.reader-paragraph'\)\.forEach\(p => \{\s*\n\s*p\.ondblclick/);
  assert.match(ui, /contentDiv\.addEventListener\('dblclick'/);
  assert.match(ui, /event\.target\.closest\?\.\('\.reader-paragraph'\)/);
  // Bound once, or repeated renders stack duplicate listeners that each seek.
  assert.match(ui, /if \(!contentDiv\._prSeekDelegated\) \{/);
  assert.match(ui, /contentDiv\._prSeekDelegated = true;/);
});

test('the reader DOM is releasable AND rebuilt when it comes back', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  const map = ui.slice(ui.indexOf('const _OFFSCREEN_RELEASABLE'), ui.indexOf('function _releaseOffscreenViewDom'));
  assert.match(map, /'reading-view': \['reader-content'\]/);

  // Releasing without a rebuild would leave the reader BLANK on return —
  // renderFullStory is only called from populateReaderUI, not on view entry.
  assert.match(ui, /readerContent\.childElementCount === 0/);
  assert.match(ui, /window\.renderFullStory\(window\.currentStory\)/);
  // Guarded, so ordinary navigation does not redraw ~1,200 paragraphs for free.
  assert.match(ui, /&& window\.currentStory\?\.chapters\?\.length/);
});

test('the library grid is bounded and its page tracks the result set', async () => {
  const lib = await read('public/assets/js/library_manager.js');
  assert.match(lib, /const LIBRARY_PAGE_SIZE = 24;/);
  assert.match(lib, /const visible = library\.slice\(0, _libraryRenderLimit\);/);
  assert.doesNotMatch(lib, /\n  library\.forEach\(\(story\) => \{\s*\n\s*html \+= _buildStoryCardHtml/);
  assert.match(lib, /window\.showMoreLibraryStories/);

  // The page must reset when the RESULT SET changes, derived rather than
  // hooked — hooking every filter and keystroke would eventually miss one, and
  // the symptom is an expanded page applied to a different set of stories.
  assert.match(lib, /const filterSignature = `\$\{filter\}\|\$\{searchQuery\}\|\$\{collectionId\}\|\$\{library\.length\}`/);
  assert.match(lib, /_libraryRenderLimit = LIBRARY_PAGE_SIZE;/);
});

test('no backdrop-filter sits behind a near-opaque surface', async () => {
  // Strip comments FIRST. The rules removed by this pass carry a comment saying
  // why, and that comment names the property -- scanning raw text would match
  // the explanation instead of a live declaration.
  const css = (await read('public/assets/css/theme.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  // A blur behind a 96-97% opaque ground is invisible but still forces a
  // compositor layer and a readback every frame.
  const rules = css.split('}');
  for (const rule of rules) {
    if (!/backdrop-filter/.test(rule)) continue;
    const bg = rule.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)/);
    if (bg) {
      assert.ok(Number(bg[1]) < 0.95,
        `backdrop-filter behind ${bg[1]} opacity is invisible and costs a GPU layer:\n${rule.trim().slice(0, 160)}`);
    }
  }
});

test('the chapter list styles hover in CSS instead of per-item handlers', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  const css = await read('public/assets/css/theme.css');
  // Two inline handlers per chapter, inert on touch, parsed for every chapter.
  assert.doesNotMatch(ui, /onmouseover="this\.style\.borderColor/);
  assert.doesNotMatch(ui, /onmouseout="this\.style\.borderColor/);
  assert.match(ui, /class="chapter-jump-item"/);
  assert.match(css, /\.chapter-jump-item \{/);
  // Hover styling gated so it never applies on touch.
  assert.match(css, /@media \(hover: hover\) \{\s*\n\s*\.chapter-jump-item:hover/);
});

test('reader chapters are wrapped so the browser can skip off-screen ones', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  const css = (await read('public/assets/css/theme.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(ui, /<section class="reader-chapter" style="contain-intrinsic-size:auto \$\{_estPx\}px">/);
  assert.match(ui, /parts\.push\('<\/section>'\);/);
  assert.match(css, /\.reader-chapter \{\s*content-visibility: auto;\s*\}/);

  // The size estimate must come from the chapter, not be a flat constant: a
  // skipped section is laid out at its estimate until first rendered, so a bad
  // number makes the scrollbar jump and lands resume-scroll in the wrong place.
  assert.match(ui, /const _estPx = Math\.max\(400, Math\.round\(\(_chars \/ 60\) \* 28 \+ _paras \* 16\)\)/);

  // Open and close must be pushed the same number of times per chapter.
  const body = ui.slice(ui.indexOf('export function renderFullStory'), ui.indexOf('window.renderFullStory = renderFullStory'));
  assert.equal((body.match(/<section class="reader-chapter"/g) || []).length, 1);
  assert.equal((body.match(/'<\/section>'/g) || []).length, 1);
});

test('the tip card opt-out is a real touch target', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  const css = (await read('public/assets/css/theme.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  // _renderTip builds the card in JS with inline styles, so the sitewide 44px
  // coarse-pointer rules never reach it. Measured at 390px it was 300x24.
  assert.match(ui, /<label class="pr-tip-optout"/);
  assert.match(css, /@media \(pointer: coarse\) \{\s*\.pr-tip-optout \{\s*min-height: 44px;/);
  // The label WRAPS the checkbox, so the row itself is the target. If the input
  // were moved out of the label, min-height would grow an empty box instead.
  const card = ui.slice(ui.indexOf('function _renderTip'), ui.indexOf('layer.appendChild(card)'));
  const labelAt = card.indexOf('<label class="pr-tip-optout"');
  const inputAt = card.indexOf('<input type="checkbox" id="pr-tip-dismiss">');
  const closeAt = card.indexOf('</label>');
  assert.ok(labelAt !== -1 && inputAt !== -1 && closeAt !== -1, 'tip opt-out markup not found');
  assert.ok(labelAt < inputAt && inputAt < closeAt,
    'the dismiss checkbox must stay inside its label — the label is the 44px target');
});
