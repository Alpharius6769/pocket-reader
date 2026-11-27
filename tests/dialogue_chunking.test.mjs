// The dropped "Hey!" (owner's iPhone listen, Paul, Winter's Grasp ch. 1):
//   I raise both arms into the air and begin waving, “Hey! That’s mine!”
// The render went "...begin waving -- that is mine". Measured with the Windows
// offline recognizer on the long-form bench, three causes stacked:
//   1. the chunk filled up at `waving, “Hey!`, so the quotation was split and
//      the model ended on the open quote without saying "Hey";
//   2. kept whole but LAST in its chunk, the model dropped the entire line;
//   3. the contraction rule wrote "that is" in lowercase after "Hey!".
// With all three fixed, "hey" is recognised at 0.94 confidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeForPocketTts } from '../public/assets/js/tts_pronunciation_core.js';

const source = await readFile(new URL('../public/assets/js/pocket_worker.js', import.meta.url), 'utf8');

function lift(names) {
  const parts = names.map((name) => {
    const re = /^[A-Z_]+$/.test(name)
      ? new RegExp(`^const ${name} = [\\s\\S]*?;$`, 'm')
      : new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}$`, 'm');
    const m = source.match(re);
    assert.ok(m, `could not lift ${name}`);
    return m[0];
  });
  parts.push(`return { ${names.filter((n) => !/^[A-Z_]+$/.test(n)).join(', ')} };`);
  return new Function(parts.join('\n\n'))();
}

const { joinOpenQuotations, splitTextIntoSentences } = lift([
  'SENTENCE_TERMINATORS', 'SENTENCE_CLOSERS', 'SENTENCE_ABBREVIATIONS', 'QUOTE_TAIL_RE', 'QUOTE_TAIL_MAX_WORDS',
  '_wordCount', '_opensQuotation', 'joinOpenQuotations', 'splitTextIntoSentences',
]);

const units = (text) => joinOpenQuotations(splitTextIntoSentences(text), 60);

test('a quotation is never split, and never ends a unit when narration follows', () => {
  const out = units('I know it can only be a wolf. I raise both arms and begin waving, “Hey! That is mine!” I repeat this a couple of times. The wind is too much.');
  assert.deepEqual(out, [
    'I know it can only be a wolf.',
    'I raise both arms and begin waving, “Hey! That is mine!” I repeat this a couple of times.',
    'The wind is too much.',
  ]);
  // Straight quotes behave the same.
  assert.deepEqual(units('He waved, "Hey! Stop!" Nobody did.'), ['He waved, "Hey! Stop!" Nobody did.']);
});

test('dialogue at the very end of a paragraph has nothing to join and stays as it is', () => {
  assert.deepEqual(units('She turned. “Wait.”'), ['She turned.', '“Wait.”']);
});

test('an unclosed quote cannot swallow the paragraph', () => {
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} goes here.`).join(' ');
  const out = units(`“It started like this. ${long}`);
  assert.ok(out.length > 1, 'joined only up to the word cap');
  assert.ok(out.every((u) => u.split(/\s+/).length <= 64));
});

test('a long sentence ending in a quote is not joined', () => {
  const narration = 'The old man walked slowly down the long and winding road toward the village where he had grown up so many years before, and finally said “Enough.”';
  assert.deepEqual(units(`${narration} Then he sat.`), [narration, 'Then he sat.']);
});

test('expanded contractions keep their capital', () => {
  assert.equal(normalizeForPocketTts('“Hey! That’s mine!”'), '“Hey! That is mine!”');
  assert.equal(normalizeForPocketTts('I’m sure it’s been there.'), 'I am sure it has been there.');
  assert.equal(normalizeForPocketTts('Don’t. Won’t.'), 'Do not. Will not.');
  assert.equal(normalizeForPocketTts('he said that’s fine'), 'he said that is fine');
});

test('Pocket ellipses render as two dots; Kokoro keeps three', () => {
  // ".." measured at about half the silence of "..." (0.54 s vs 1.02 s).
  assert.equal(normalizeForPocketTts('‘What is…’ my mind races.'), "'What is..' my mind races.");
  assert.equal(normalizeForPocketTts('He stopped... and turned.'), 'He stopped.. and turned.');
  assert.equal(normalizeForPocketTts('He stopped… and turned.', { keepClausePunctuation: true }), 'He stopped... and turned.');
  // And the worker still reads ".." as a pause, not a sentence end.
  assert.deepEqual(splitTextIntoSentences('He stopped.. and then he turned.'), ['He stopped.. and then he turned.']);
});
