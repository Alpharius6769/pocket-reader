// Segmentation guards for Pocket narration.
//
// These come from a 20-30 minute desktop listen that reported two things the
// old splitter caused directly: paragraphs "cut in half, causing a pause", and
// long quotes where the narrator went high-pitched or distorted and then
// mispronounced the word it landed on.
//
// Both are segmentation, not sampling. Every chunk is a separate render with a
// fresh flow-LM state (RESET_FLOW_STATE_EACH_CHUNK) and a CHUNK_GAP_SEC pause
// after it, so a boundary in the wrong place is audible as a gap AND as the
// model re-anchoring its pitch on a fragment.
//
// pocket_worker.js is a worker module and cannot be imported here, so the two
// functions under test are lifted out of the source and evaluated. That still
// exercises the real implementation rather than asserting on its text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(
  new URL('../public/assets/js/pocket_worker.js', import.meta.url), 'utf8',
);

function lift(source, names) {
  const parts = [];
  for (const name of names) {
    const declaration = name.startsWith('SENTENCE_') || name.startsWith('CLAUSE_')
      ? new RegExp(`^const ${name} = [\\s\\S]*?;$`, 'm')
      : new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}$`, 'm');
    const match = source.match(declaration);
    assert.ok(match, `could not lift ${name} out of pocket_worker.js`);
    parts.push(match[0]);
  }
  parts.push(`return { ${names.filter((n) => !/^[A-Z_]+$/.test(n)).join(', ')} };`);
  return new Function(parts.join('\n\n'))();
}

const { splitTextIntoSentences } = lift(workerSource, [
  'SENTENCE_TERMINATORS', 'SENTENCE_CLOSERS', 'SENTENCE_ABBREVIATIONS', 'splitTextIntoSentences',
]);

test('an ellipsis is a pause inside a sentence, not a chunk boundary', () => {
  // normalizeForPocketTts rewrites "…" to "...", so this is what the splitter
  // actually receives from any story with an ellipsis in the dialogue.
  assert.deepEqual(
    splitTextIntoSentences('He stopped at the door... and then he turned around.'),
    ['He stopped at the door... and then he turned around.'],
  );
  assert.deepEqual(
    splitTextIntoSentences('"I’m James... thanks for taking me in?"'),
    ['"I’m James... thanks for taking me in?"'],
  );
});

test('a closing quote stays with the sentence it closes', () => {
  // This used to yield a trailing fragment that was nothing but the quote mark,
  // which is a degenerate prompt for a zero-shot flow-LM.
  const out = splitTextIntoSentences('“Take me in?” He waited.');
  assert.deepEqual(out, ['“Take me in?”', 'He waited.']);
  for (const piece of out) {
    assert.match(piece, /[A-Za-z]/, `chunk ${JSON.stringify(piece)} carries no speakable text`);
  }
});

test('no fragment is ever punctuation alone', () => {
  const prose = '“Hi,” he started, clearing his voice at the first pathetic attempt '
    + 'that came out weaker than he meant, “I’m James... thanks for taking me in?” '
    + 'James swallowed. “Is that all right?”';
  for (const piece of splitTextIntoSentences(prose)) {
    assert.match(piece, /[A-Za-z]/, `chunk ${JSON.stringify(piece)} carries no speakable text`);
  }
});

test('abbreviations, initials and decimals do not end a sentence', () => {
  assert.deepEqual(
    splitTextIntoSentences('Mr. Vale said no. Dr. Reyes agreed.'),
    ['Mr. Vale said no.', 'Dr. Reyes agreed.'],
  );
  assert.deepEqual(
    splitTextIntoSentences('J. R. R. Tolkien wrote it.'),
    ['J. R. R. Tolkien wrote it.'],
  );
  assert.deepEqual(
    splitTextIntoSentences('It cost 3.5 credits.'),
    ['It cost 3.5 credits.'],
  );
});

test('ordinary sentence splitting still works', () => {
  assert.deepEqual(
    splitTextIntoSentences('One. Two! Three? Four'),
    ['One.', 'Two!', 'Three?', 'Four'],
  );
  assert.deepEqual(splitTextIntoSentences(''), []);
  assert.deepEqual(splitTextIntoSentences('   '), []);
  assert.deepEqual(splitTextIntoSentences('No terminator here'), ['No terminator here']);
});

test('every character of the input survives segmentation', () => {
  // A splitter that drops text is worse than one that splits badly: the reader
  // would simply never hear the missing words.
  const samples = [
    'He stopped... and turned. "Why?" she asked. Mr. Vale said nothing.',
    '“Wait!”— he called — “don’t go.”',
    'One sentence only',
    'Ends in an ellipsis...',
    '?!',
  ];
  for (const sample of samples) {
    const joined = splitTextIntoSentences(sample).join(' ').replace(/\s+/g, ' ').trim();
    const expected = sample.replace(/\s+/g, ' ').trim();
    assert.equal(joined, expected, `text changed for ${JSON.stringify(sample)}`);
  }
});

// ── Over-cap sentences ──────────────────────────────────────────────────────

const { splitLongTextSafely } = lift(workerSource, [
  'CLAUSE_BOUNDARY_RE', 'splitLongTextSafely',
]);

// A stand-in tokenizer: one token per word. The real one is SentencePiece, but
// the splitting policy under test is about WHERE the cut lands, not tokenizing.
const wordTokenizer = {
  encodeIds: (s) => String(s || '').trim().split(/\s+/).filter(Boolean),
  decodeIds: (ids) => ids.join(' '),
};

function splitWithCap(text, cap) {
  globalThis.tokenizerProcessor = wordTokenizer;
  globalThis.splitTokenIdsIntoChunks = (ids, maxTokens) => {
    const out = [];
    for (let i = 0; i < ids.length; i += maxTokens) out.push(ids.slice(i, i + maxTokens).join(' '));
    return out;
  };
  try {
    return splitLongTextSafely(text, cap);
  } finally {
    delete globalThis.tokenizerProcessor;
    delete globalThis.splitTokenIdsIntoChunks;
  }
}

test('an over-cap sentence is cut at a clause mark, not mid-phrase', () => {
  const line = 'He had been waiting there for hours in the cold, '
    + 'turning the same thought over and over in his head, '
    + 'and by the time she arrived he had nothing left to say.';
  const pieces = splitWithCap(line, 20);
  assert.ok(pieces.length > 1, 'the sample must actually exceed the cap');
  for (const piece of pieces.slice(0, -1)) {
    assert.match(piece, /[,;:—–]$/,
      `piece ${JSON.stringify(piece)} ends mid-phrase instead of on a clause mark`);
  }
});

test('splitting an over-cap sentence never drops or reorders text', () => {
  const line = 'He had been waiting there for hours in the cold, '
    + 'turning the same thought over and over in his head, '
    + 'and by the time she arrived he had nothing left to say.';
  for (const cap of [8, 12, 20, 40]) {
    const joined = splitWithCap(line, cap).join(' ').replace(/\s+/g, ' ').trim();
    assert.equal(joined, line.replace(/\s+/g, ' ').trim(), `text changed at cap ${cap}`);
  }
});

test('a clause-free run still splits rather than blowing the cap', () => {
  const line = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const pieces = splitWithCap(line, 10);
  assert.ok(pieces.length >= 3);
  for (const piece of pieces) {
    assert.ok(wordTokenizer.encodeIds(piece).length <= 10,
      `piece ${JSON.stringify(piece)} is over the cap`);
  }
  assert.equal(pieces.join(' '), line);
});
