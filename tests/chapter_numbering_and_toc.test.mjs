import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
// storage_core warms the audio cache on a timer at import. Only the pure
// chapter-normalising functions are under test here, so hand it a request that
// simply never settles rather than letting the open() throw and surface as an
// unhandled rejection after the tests have finished.
globalThis.indexedDB = { open: () => ({ onsuccess: null, onerror: null, onupgradeneeded: null }) };
const storage = await import('../public/assets/js/storage_core.js');

// ── The generated-EPUB table of contents was being read as chapter 1 ──────────
// FicHub's AO3 export (and Calibre, and most converters) emits a leading
// section whose whole body is the titles of the sections after it, labelled
// with the WORK's title rather than "Contents" -- so the front-matter title
// list never matched it. Keeping it costs two things at once: every real
// chapter is numbered one too high for the whole book, and narration opens by
// reading thirty-odd bare chapter titles aloud.

const TOC_EXPORT = {
  title: 'Bridging Divides',
  chapters: [
    {
      title: 'Bridging Divides',
      paragraphs: ['Introduction', 'Balance', 'Encounter and Initiatives',
        'A Helping Hand', 'Under the Surface', 'Chapter 6'],
    },
    { title: 'Balance', paragraphs: ['He woke before the alarm, as he always did.'] },
    { title: 'Encounter and Initiatives', paragraphs: ['The office smelled of cold coffee.'] },
    { title: 'A Helping Hand', paragraphs: ['She offered it without being asked.'] },
    { title: 'Under the Surface', paragraphs: ['The water was colder than it looked.'] },
    { title: 'Chapter 6', paragraphs: ['Nobody had given this one a name.'] },
  ],
};

test('a table-of-contents section is not kept as chapter 1', () => {
  const out = storage.normalizeStoryChapters(TOC_EXPORT.chapters, TOC_EXPORT);
  assert.equal(out.length, 5, 'the contents list should be dropped, the 5 chapters kept');
  assert.equal(out[0].title, 'Balance');
  assert.equal(out[4].title, 'Chapter 6');
  assert.ok(
    !out.some((chapter) => chapter.paragraphs.includes('Encounter and Initiatives')),
    'the bare title list must not survive as narratable text',
  );
});

test('dropping it puts every chapter back on its real number', () => {
  const out = storage.normalizeStoryChapters(TOC_EXPORT.chapters, TOC_EXPORT);
  // "Chapter 6" is the sixth chapter of the work and sits at index 4 here only
  // because this fixture is truncated -- what matters is that the chapter the
  // author titled "Balance" is index 0 and not index 1.
  assert.equal(out.findIndex((chapter) => chapter.title === 'Balance'), 0);
});

// Prose must never be mistaken for a contents list, however many chapter names
// it happens to mention.
test('a real chapter that name-drops other chapters is kept', () => {
  const story = {
    title: 'Test Work',
    chapters: [
      {
        title: 'Balance',
        paragraphs: [
          'Balance was the word she kept coming back to, long after the argument ended and the house had gone quiet around her.',
          'Under the Surface there was something she did not want to name, and naming it now would cost more than she had.',
          'A Helping Hand, he had called it, which was generous of him considering whose hand it was and what it had taken.',
          'She thought about the encounter and initiatives paperwork still sitting unsigned on the kitchen table.',
        ],
      },
      { title: 'Under the Surface', paragraphs: ['The water was cold.'] },
      { title: 'A Helping Hand', paragraphs: ['She offered it.'] },
      { title: 'Encounter and Initiatives', paragraphs: ['Cold coffee.'] },
      { title: 'Chapter 5', paragraphs: ['Unnamed.'] },
    ],
  };
  const out = storage.normalizeStoryChapters(story.chapters, story);
  assert.equal(out.length, 5, 'prose is longer than a contents line and must survive');
  assert.equal(out[0].title, 'Balance');
});

test('a scraped story with no contents section is untouched', () => {
  const story = {
    title: 'Scraped Work',
    chapters: [
      { title: 'Chapter 1: Balance', paragraphs: ['He woke before the alarm.'] },
      { title: 'Chapter 2: Encounter', paragraphs: ['Cold coffee.'] },
      { title: 'Chapter 3', paragraphs: ['Unnamed.'] },
    ],
  };
  const out = storage.normalizeStoryChapters(story.chapters, story);
  assert.equal(out.length, 3);
});

// ── One chapter-label rule, not two ──────────────────────────────────────────
// The jump list carried its own copy that renumbered a bare "Chapter N" title
// to its array position, while the reader header kept the number the source
// stated. The same chapter could therefore be "Chapter 6" at the top of the
// reader and "Chapter 5" in the jump list.

test('the chapter jump list and the reader header share one label function', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  assert.ok(
    !ui.includes('_formatChapterTitle'),
    'the jump list must not carry a second labelling rule',
  );
  assert.equal(
    (ui.match(/function _formatChapterLabel\(/g) || []).length, 1,
    'exactly one chapter-label function should exist',
  );
  assert.match(ui, /const title = _formatChapterLabel\(idx, ch\.title\);/);
});

// ── Scrolling to a chapter inside content-visibility sections ────────────────
// One scrollIntoView() lands on the sum of the contain-intrinsic-size ESTIMATES
// of every skipped section above the target. On a phone those estimates are
// roughly half the real height, so a jump to chapter 7 stopped inside chapter 1
// while the header (driven by the index, which was correct) said "Chapter 7".

test('a chapter jump re-issues the scroll until it converges', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(ui, /function _settleScrollTo\(el\) \{/);
  assert.match(ui, /_settleScrollTo\(activeEl\);/);
  // Bounded, and abandoned if the reader has moved on to another paragraph.
  assert.match(ui, /if \(stable >= 1 \|\| \+\+frames >= 8\) return;/);
  assert.match(ui, /if \(el\.id !== `reader-p-\$\{window\.currentChapterIndex\}-\$\{window\.currentParagraphIndex\}`\) return;/);
});

// ── An empty chapter must not end narration ─────────────────────────────────
// The AO3 scraper now KEEPS a chapter whose body it could not read, so that the
// numbering after it stays true. Playback has to walk past it.

test('narration walks past a chapter with no paragraphs', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /for \(let next = c \+ 1; next < story\.chapters\.length; next\+\+\) \{\s*\n\s*if \(!story\.chapters\[next\]\?\.paragraphs\?\.length\) continue;/);
});

// ── FicHub rejects a scheme-less query ──────────────────────────────────────
// Stripping "https://" made every AO3 FicHub lookup return err:-1 with the
// fixit "please try a full url including http:// or https:// at the start",
// which _fichubResolve reads as fatal -- so the primary AO3 path had quietly
// stopped working and every story paid a wasted round trip first.

test('the FicHub query keeps the URL scheme', async () => {
  const api = await read('public/assets/js/api_core.js');
  const body = api.slice(api.indexOf('function _fichubApiUrl'), api.indexOf('async function _fichubResolve'));
  assert.ok(
    !/replace\(\/\^https\?:\\\/\\\/\/i, ''\)/.test(body),
    'the scheme must not be stripped from the FicHub query',
  );
  assert.match(body, /replace\(\/\^\(\?!https\?:\\\/\\\/\)\/i, 'https:\/\/'\)/);
  // Still one work, not one chapter.
  assert.match(body, /replace\(\/\\\/chapters\\\/\\d\+\.\*\$\/, ''\)/);
});

// ── The AO3 scraper must not renumber a work by dropping a chapter ──────────

test('AO3 chapters are paired with their own title, and an unreadable one is kept', async () => {
  const ao3 = await read('backend/scrapers_ao3.py');
  // Direct children only: AO3 nests a div.chapter.preface.group per chapter.
  assert.match(ao3, /sections = soup\.select\("#chapters > div\.chapter"\)/);
  // The title comes from inside the section it belongs to, not from a parallel
  // list zipped by position.
  assert.match(ao3, /heading = section\.select_one\("h3\.title"\)/);
  // No `continue` that would skip an empty body while the index marches on.
  assert.match(ao3, /paragraphs=_chapter_paragraphs\(body\) if body is not None else \[\],/);
  assert.ok(
    !/if not paras:\s*\n\s*continue\s*\n\s*ch_title = chapter_titles\[i\]/.test(ao3),
    'the positional title zip with a silent skip must be gone',
  );
});
