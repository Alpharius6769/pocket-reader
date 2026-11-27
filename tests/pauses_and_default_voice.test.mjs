// Owner's requests, 2026-11-26: shorter pauses after every punctuation type,
// the pause between paragraphs kept, and Paul as the default Pocket voice.
// The worker and library_manager are not importable here, so the functions
// under test are lifted out of the source and run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../public/assets/js/pocket_worker.js', import.meta.url), 'utf8');
const library = await readFile(new URL('../public/assets/js/library_manager.js', import.meta.url), 'utf8');

function lift(source, names, prelude = '') {
  const parts = [prelude];
  for (const name of names) {
    const re = /^[A-Z_]+$/.test(name)
      ? new RegExp(`^const ${name} = [\\s\\S]*?;$`, 'm')
      : new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}$`, 'm');
    const m = source.match(re);
    assert.ok(m, `could not lift ${name}`);
    parts.push(m[0]);
  }
  parts.push(`return { ${names.join(', ')} };`);
  return new Function(parts.join('\n\n'))();
}

const RATE = 24000;
const { createSilenceLimiter, PUNCT_PAUSE_SEC, PARAGRAPH_END_PUNCT_SEC, CHUNK_GAP_SEC } = lift(worker, [
  'CHUNK_GAP_SEC', 'PARAGRAPH_END_PUNCT_SEC', 'PUNCT_PAUSE_SCALE', 'PUNCT_PAUSE_SEC',
  'SILENCE_KEEP_SEC', 'SILENCE_RATIO', 'SILENCE_CAP_SEC', 'SILENCE_WINDOW_SEC', 'SILENCE_RMS', 'createSilenceLimiter',
]);

const speech = (sec) => Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => 0.3 * Math.sin(i / 7));
const silence = (sec) => new Float32Array(Math.round(sec * RATE));
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sec = (n) => Math.round((n / RATE) * 100) / 100;

test('silences inside a paragraph are shortened; short ones and speech are untouched', () => {
  for (const [gap, expected] of [[0.1, 0.1], [0.2, 0.2], [0.3, 0.25], [0.54, 0.37], [1.0, 0.5], [1.5, 0.5]]) {
    const lim = createSilenceLimiter(RATE);
    const out = lim.process(join(speech(0.5), silence(gap), speech(0.5)));
    assert.equal(sec(out.length), sec(speech(1).length) + expected, `${gap}s of silence`);
  }
});

test('works across streamed blocks, as the worker appends them', () => {
  const lim = createSilenceLimiter(RATE);
  const blocks = [speech(0.32), silence(0.32), silence(0.32), silence(0.32), speech(0.32)];
  const total = blocks.map((b) => lim.process(b).length).reduce((a, b) => a + b, 0);
  assert.equal(sec(total), 1.14);
});

test('the silence before the first word and the trimmed tail are what keep the paragraph gap', () => {
  const lim = createSilenceLimiter(RATE);
  const lead = lim.process(silence(0.56));
  assert.equal(lead.length, silence(0.56).length, 'leading silence is exempt');
  lim.process(speech(0.4));
  const tail = lim.process(silence(0.9));
  // The worker adds trailingDropped back onto the paragraph-end gap.
  assert.equal(tail.length + lim.trailingDropped, silence(0.9).length);
});

test('every punctuation gap is shorter; the paragraph-end values are the old ones', () => {
  assert.deepEqual(PARAGRAPH_END_PUNCT_SEC, {
    '.': 0.38, '!': 0.42, '?': 0.42, '…': 0.60, ',': 0.18, ';': 0.26, ':': 0.26, '—': 0.28,
  });
  for (const [mark, full] of Object.entries(PARAGRAPH_END_PUNCT_SEC)) {
    assert.ok(PUNCT_PAUSE_SEC[mark] < full, `${mark} is shorter`);
    assert.equal(PUNCT_PAUSE_SEC[mark], Math.round(full * 0.6 * 100) / 100);
  }
  assert.equal(CHUNK_GAP_SEC, 0.15);
  // The paragraph tail uses the full value plus the paragraph pause, and gets
  // the limiter's trim back.
  assert.match(worker, /chunkMeta\[i\]\.explicit \? \(chunkMeta\[i\]\.pauseAfterSec \|\| 0\) : \(chunkMeta\[i\]\.paragraphEndSec \|\| 0\)/);
  assert.match(worker, /const restored = meta\.paragraphTail && silenceLimiter \? silenceLimiter\.trailingDropped : 0;/);
  assert.match(worker, /if \(audible && silenceLimiter\) chunk = silenceLimiter\.process\(chunk\);/);
});

const engineUtils = await readFile(new URL('../public/assets/js/engine_utils.js', import.meta.url), 'utf8');

test('Paul is the default Pocket voice, and readers who never chose move to it', () => {
  assert.match(engineUtils, /window\.POCKET_DEFAULT_VOICE = 'paul';/);
  const fakeWindow = { POCKET_DEFAULT_VOICE: 'paul', POCKET_VOICES: ['alba', 'mary', 'eve', 'charles', 'george', 'paul'] };
  const source = library.match(/^function normalizePocketVoiceSetting\([\s\S]*?\n\}$/m)?.[0];
  assert.ok(source, 'normalizePocketVoiceSetting must be locatable');
  // The module's other helpers are stubbed: only the voice part is under test.
  const normalize = new Function(
    'window', 'DEFAULT_POCKET_PLAYBACK_SPEED', 'DEFAULT_POCKET_TEMPERATURE_PRESET', 'normalizePronunciationOverrides', 'normalizeCompanionSetting',
    `${source}\nreturn normalizePocketVoiceSetting;`,
  )(fakeWindow, 1, 'balanced', (x) => x || [], () => {});
  const norm = (settings) => { normalize({ settings }); return settings; };
  // Still on the old default and never chose: moves to Paul, once.
  assert.equal(norm({ pocketVoice: 'alba' }).pocketVoice, 'paul');
  // Chose Alba on purpose: kept.
  assert.equal(norm({ pocketVoice: 'alba', pocketVoiceChosen: true }).pocketVoice, 'alba');
  // Already migrated: a later pick of Alba is not undone.
  assert.equal(norm({ pocketVoice: 'alba', voiceDefaultsVersion: 2 }).pocketVoice, 'alba');
  // Any other voice is left alone; nothing set gets Paul.
  assert.equal(norm({ pocketVoice: 'mary' }).pocketVoice, 'mary');
  assert.equal(norm({}).pocketVoice, 'paul');
  // Every voice control records the choice.
  assert.match(library + engineUtils, /pocketVoiceChosen/);
});

test('a new service worker precaches from the network, so an unversioned default reaches readers', async () => {
  // engine_utils.js (where the default voice lives) is loaded without a ?v=
  // token. Precached through the HTTP cache, a new worker stored last deploy's
  // copy and the old default stuck.
  const sw = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /function freshRequest\(asset\) \{\s*return new Request\(asset, \{ cache: 'reload' \}\);/);
  assert.match(sw, /cache\.addAll\(CORE_ASSETS\.map\(freshRequest\)\)/);
  assert.match(sw, /cache\.add\(freshRequest\(asset\)\)/);
  assert.doesNotMatch(sw, /cache\.addAll\(CORE_ASSETS\)/);
});
