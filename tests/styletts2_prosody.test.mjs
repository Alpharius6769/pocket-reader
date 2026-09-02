// Kokoro and Kitten had exactly one prosody knob -- a single `speed` scalar for
// the whole paragraph -- while Pocket carried an emotion router, a temperature
// preset, a punctuation pause table and a paragraph tail. "Expressive narration
// on all engines" cannot be delivered from a Pocket-only surface, so these two
// grew the same shaping, and these tests keep the two engines identical.
//
// The concrete defect this fixes: a paragraph is packed into chunks, each chunk
// is a separate inference, and the results were concatenated at zero offset --
// literally back to back. The model renders punctuation INSIDE a chunk, but it
// cannot know a chunk boundary happened, so two sentences split across a seam
// ran together with no breath at all. Longer paragraphs have more seams, so the
// delivery got flatter exactly where it mattered most.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENGINES = ['kokoro', 'kitten'];

const sourceFor = (engine) =>
  readFile(path.join(ROOT, `public/assets/js/${engine}_worker.js`), 'utf8');

// Load the real packing and prosody helpers out of the worker, stubbing only
// the ORT/phonemizer surface. Testing the shipped source beats restating it.
async function loadProsody(engine) {
  const src = await sourceFor(engine);
  const grab = (from, to) => {
    const a = src.indexOf(from);
    assert.notEqual(a, -1, `${engine}: missing ${from}`);
    const b = src.indexOf(to, a);
    assert.notEqual(b, -1, `${engine}: missing ${to}`);
    return src.slice(a, b);
  };
  const prelude = `
    const MAX_TOKENS = 512;
    let maxChunkTokens = 40;
    function chunkTokenLimit(){ return maxChunkTokens; }
    function tokenizePhonemes(s){ return Array.from(String(s)).map((_, i) => i + 1); }
    function wordPiecesOf(s){ return String(s).split(/(?<= )/); }
    const SAMPLE_RATE = 24000;
  `;
  return import('data:text/javascript,' + encodeURIComponent(
    prelude
    + grab('const PUNCT_PAUSE_SEC', 'function packUnitsIntoChunks')
    + grab('function packUnitsIntoChunks', '\nasync function runChunk')
    + '\nexport { packUnitsIntoChunks, pauseAfterMark, speedForMark, silenceFrames, PUNCT_PAUSE_SEC, CLAUSE_SPEED_SCALE };'
  ));
}

for (const engine of ENGINES) {
  test(`${engine}: every chunk reports the punctuation it ends on`, async () => {
    const { packUnitsIntoChunks } = await loadProsody(engine);
    const marks = [',', '.', '?', '.'];
    const units = ['hello there', 'this is a test', 'is it working', 'yes it is']
      .map((c, i) => `${c}${marks[i]} `);
    const { chunks, chunkMarks } = packUnitsIntoChunks(units, marks);
    assert.ok(chunks.length > 1, 'the fixture must actually span a seam');
    assert.equal(chunks.length, chunkMarks.length,
      'a chunk without a mark slot gets no seam pause at all');
    for (const mark of chunkMarks) assert.equal(typeof mark, 'string');
  });

  test(`${engine}: a clause split across chunks only marks its final piece`, async () => {
    const { packUnitsIntoChunks } = await loadProsody(engine);
    // A clause too long for one inference is split mid-sentence. Giving every
    // piece the clause's full stop would drop a 0.38 s silence into the middle
    // of a word -- worse than the flat delivery this replaces.
    const { chunks, chunkMarks } = packUnitsIntoChunks(['x'.repeat(95) + '.'], ['.']);
    assert.ok(chunks.length > 1);
    assert.ok(chunkMarks.slice(0, -1).every((m) => m === ''),
      'mid-clause pieces must carry no mark');
    assert.equal(chunkMarks.at(-1), '.');
  });

  test(`${engine}: pause length follows the mark, and is off when expressive is off`, async () => {
    const { pauseAfterMark, PUNCT_PAUSE_SEC } = await loadProsody(engine);
    // A comma must not breathe like a full stop.
    assert.ok(pauseAfterMark(',', true) < pauseAfterMark('.', true));
    assert.ok(pauseAfterMark('.', true) < pauseAfterMark('…', true));
    assert.equal(pauseAfterMark('.', true), PUNCT_PAUSE_SEC['.']);
    // An unknown or absent mark still gets a small seam gap rather than zero:
    // a seam with no gap is the defect being fixed.
    assert.ok(pauseAfterMark('', true) > 0);
    assert.ok(pauseAfterMark('~', true) > 0);
    // Off means off -- the previous output is exactly reproducible.
    for (const mark of ['.', ',', '', '…']) {
      assert.equal(pauseAfterMark(mark, false), 0);
    }
  });

  test(`${engine}: pace shaping is subtle and cannot leave the exported range`, async () => {
    const { speedForMark } = await loadProsody(engine);
    // A terminal gets a slight ritardando; a comma keeps its pace.
    assert.ok(speedForMark(1, '.', true) < 1);
    assert.equal(speedForMark(1, ',', true), 1);
    // Subtle on purpose: overdone shaping sounds seasick, which is worse than
    // flat. Nothing may move more than 6%.
    for (const mark of ['.', '!', '?', ',', ';', ':', '—', '…']) {
      const shaped = speedForMark(1, mark, true);
      assert.ok(Math.abs(shaped - 1) <= 0.06, `${mark} moved pace by more than 6%`);
    }
    // The graph was exported for [0.5, 2]; shaping must not walk outside it.
    assert.ok(speedForMark(2, '.', true) <= 2);
    assert.ok(speedForMark(0.5, '.', true) >= 0.5);
    assert.ok(speedForMark(2, ',', true) <= 2);
    // Off means unchanged.
    assert.equal(speedForMark(1.25, '.', false), 1.25);
  });

  test(`${engine}: silence is sized in real frames at the output rate`, async () => {
    const { silenceFrames } = await loadProsody(engine);
    assert.equal(silenceFrames(0.38, 24000).length, 9120);
    assert.ok(silenceFrames(0.5, 24000).every((v) => v === 0), 'a gap must be silent');
    // Zero must allocate nothing rather than a zero-length buffer to splice.
    assert.equal(silenceFrames(0, 24000), null);
    assert.equal(silenceFrames(-1, 24000), null);
  });

  test(`${engine}: generate lays the gap between chunks and a tail after the last`, async () => {
    const src = await sourceFor(engine);
    const generate = src.slice(src.indexOf('async function generate('), src.indexOf('self.onmessage'));
    assert.match(generate, /packUnitsIntoChunks\(units, unitMarks\)/,
      'the marks must reach the packer or every seam gets the default gap');
    assert.match(generate, /speedForMark\(speed, mark, expressive\)/);
    assert.match(generate, /pauseAfterMark\(mark, expressive\)/);
    assert.match(generate, /PARAGRAPH_TAIL_PAUSE_SEC/,
      'consecutive paragraphs must not run together either');
    assert.match(generate, /const expressive = opts\.expressive !== false;/,
      'must read the flag the main thread actually sends');
    // Cancellation still has to FAIL rather than return short audio, which the
    // caller would cache as a permanently half-spoken paragraph.
    assert.match(generate, /if \(cancelRequested\) throw new Error\('Narration cancelled\.'\);/);
    assert.match(generate, /rendered !== chunks\.length/,
      'completeness is counted on inferences, not on the padded piece list');
  });
}

test('both StyleTTS2 engines breathe identically, and like Pocket', async () => {
  // A reader moving between tiers should hear the same narrator phrasing, not
  // discover that one engine pauses differently from another.
  const [kokoro, kitten] = await Promise.all(ENGINES.map(loadProsody));
  assert.deepEqual(kokoro.PUNCT_PAUSE_SEC, kitten.PUNCT_PAUSE_SEC);
  assert.deepEqual(kokoro.CLAUSE_SPEED_SCALE, kitten.CLAUSE_SPEED_SCALE);

  // And the table is Pocket's, so all three agree. Parsed rather than pattern
  // matched: several of these marks are regex metacharacters, and building
  // patterns out of them produces a broken regex, not a failed assertion.
  const pocket = await readFile(path.join(ROOT, 'public/assets/js/pocket_worker.js'), 'utf8');
  const start = pocket.indexOf('const PUNCT_PAUSE_SEC = {');
  const table = pocket.slice(start, pocket.indexOf('};', start));
  const pocketPauses = {};
  for (const [, mark, sec] of table.matchAll(/'((?:\\u[0-9a-fA-F]{4})|[^'])': ([0-9.]+)/g)) {
    const key = mark.startsWith('\\u')
      ? String.fromCharCode(parseInt(mark.slice(2), 16))
      : mark;
    pocketPauses[key] = Number(sec);
  }
  assert.deepEqual(pocketPauses, kokoro.PUNCT_PAUSE_SEC,
    'all three engines must breathe on the same table');
});

test('the prosody change is versioned, or cached flat audio would be replayed', async () => {
  // Rendering changed, so every previously cached Kokoro and Kitten chunk is
  // now stale. Their cache tag is only the engine version -- unlike Pocket's,
  // it carries no prosody state of its own -- so the version is the ONLY thing
  // that can invalidate them. Leaving it alone would ship the fix to nobody
  // who had already listened, and silently.
  const audio = await readFile(path.join(ROOT, 'public/assets/js/audio_core.js'), 'utf8');
  assert.match(audio, /const KOKORO_NARRATION_CACHE_VERSION = 'kokorov3';/);
  assert.match(audio, /const KITTEN_NARRATION_CACHE_VERSION = 'kittenv2';/);
  assert.match(audio, /if \(_isStyleTts2Engine\(engine\)\) return `#\$\{NEURAL_CACHE_VERSIONS\[engine\]\}`;/);
});
