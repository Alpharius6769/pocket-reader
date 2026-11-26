import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFile(path.join(ROOT, relative), 'utf8');

test('library_manager progressChapter handles null/undefined without producing NaN', async () => {
  const lib = await read('public/assets/js/library_manager.js');

  assert.match(
    lib,
    /Ch \$\{\(Number\(story\.progressChapter\) \|\| 0\) \+ 1\}/,
    'Card metadata must coerce progressChapter to avoid Ch NaN'
  );
  assert.match(
    lib,
    /Number\(live \? window\.currentChapterIndex : story\?\.progressChapter\) \|\| 0/,
    'Continue reading drawer must coerce progressChapter to avoid Chapter NaN'
  );
  assert.doesNotMatch(
    lib,
    /`Ch \$\{story\.progressChapter \+ 1\}/,
    'Raw story.progressChapter + 1 without coercion must not exist in library cards'
  );
});

