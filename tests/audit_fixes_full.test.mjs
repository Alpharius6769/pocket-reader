import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFile(path.join(ROOT, relative), 'utf8');

test('supabase_bridge escapes email before interpolating into statusEl.innerHTML', async () => {
  const bridge = await read('public/assets/js/supabase_bridge.js');
  assert.match(bridge, /function _escapeHtml\(/, 'Expected _escapeHtml helper to be defined');
  assert.match(
    bridge,
    /statusEl\.innerHTML\s*=\s*`Signed in as <strong>\$\{_escapeHtml\(email\)\}<\/strong>/,
    'OAuth email must be HTML-escaped before inserting into innerHTML'
  );
  assert.doesNotMatch(
    bridge,
    /statusEl\.innerHTML\s*=\s*`Signed in as <strong>\$\{email\}<\/strong>/,
    'Unescaped OAuth email interpolation must not be present'
  );
});

test('public/index.html script query versions match public/sw.js CORE_ASSETS', async () => {
  const indexHtml = await read('public/index.html');
  const swJs = await read('public/sw.js');

  const swAssetMatches = swJs.match(/'assets\/js\/[^']+\.js\?v=[^']+'/g) || [];
  assert.ok(swAssetMatches.length > 0, 'Expected sw.js to contain versioned JS assets');

  for (const rawAsset of swAssetMatches) {
    const assetPath = rawAsset.replace(/'/g, '');
    const [fileName, query] = assetPath.split('?');
    // If the script is loaded via index.html script tag, its version query parameter must match exactly
    const scriptRegex = new RegExp(`src=['"]${fileName.replace(/\./g, '\\.')}(\\?v=[^'"]+)?['"]`);
    const match = indexHtml.match(scriptRegex);
    if (match) {
      assert.ok(
        indexHtml.includes(`src='${assetPath}'`) || indexHtml.includes(`src="${assetPath}"`),
        `index.html script tag for ${fileName} must match sw.js version (${assetPath})`
      );
    }
  }
});

test('library_manager progressChapter handles null/undefined without producing NaN', async () => {
  const lib = await read('public/assets/js/library_manager.js');

  assert.match(
    lib,
    /Ch \$\{\(Number\(story\.progressChapter\) \|\| 0\) \+ 1\}/,
    'Card metadata must coerce progressChapter to avoid Ch NaN'
  );
  assert.match(
    lib,
    /Chapter \$\{\(Number\(story\.progressChapter\) \|\| 0\) \+ 1\}/,
    'Continue reading drawer must coerce progressChapter to avoid Chapter NaN'
  );
  assert.doesNotMatch(
    lib,
    /`Ch \$\{story\.progressChapter \+ 1\}/,
    'Raw story.progressChapter + 1 without coercion must not exist in library cards'
  );
});

test('reader_features initializes data.library defensively', async () => {
  const rf = await read('public/assets/js/reader_features.js');
  const ensureFn = rf.slice(rf.indexOf('export function ensureReaderFeatures()'), rf.indexOf('window.ensureReaderFeatures ='));
  assert.match(
    ensureFn,
    /data\.library \|\|=\s*\[\];/,
    'ensureReaderFeatures must ensure data.library is initialized as an array'
  );
});
