import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();

// During the Anvil decommission (MIGRATION_PLAN.md) the service worker exists
// twice: Anvil serves it from a Python http_endpoint, Cloudflare Pages will
// serve the static file. Both must stay byte-identical until Phase 4 deletes
// the Anvil copy, or users get one shell on one host and a different one on
// the other.
const extractJsFromEndpoint = (py) => {
  const open = py.indexOf('js_code = """');
  assert.notEqual(open, -1, 'serviceworker.py no longer assigns js_code = """..."""');
  const bodyStart = open + 'js_code = """'.length;
  const close = py.indexOf('"""', bodyStart);
  assert.notEqual(close, -1, 'serviceworker.py js_code string is unterminated');
  return py.slice(bodyStart, close);
};

test('public/sw.js matches the JS embedded in serviceworker.py', async () => {
  const [py, staticSw] = await Promise.all([
    read('serviceworker.py'),
    read('public/sw.js'),
  ]);
  assert.equal(
    norm(staticSw),
    norm(extractJsFromEndpoint(py)),
    'public/sw.js drifted from serviceworker.py -- update both or Anvil and Pages ship different shells',
  );
});

test('extracted sw.js carries no Python wrapper leakage', async () => {
  const sw = await read('public/sw.js');
  for (const token of ['js_code', 'HttpResponse', 'anvil.server', 'http_endpoint']) {
    assert.ok(!sw.includes(token), `public/sw.js contains Python wrapper token: ${token}`);
  }
});

test('sw.js and serviceworker.py declare the same cache version', async () => {
  const [py, sw] = await Promise.all([read('serviceworker.py'), read('public/sw.js')]);
  const pick = (s) => s.match(/var CACHE_NAME = '([^']+)'/)?.[1];
  const swVersion = pick(sw);
  assert.ok(swVersion, 'public/sw.js has no CACHE_NAME declaration');
  assert.equal(swVersion, pick(py), 'CACHE_NAME differs between the static and Anvil service workers');
});

// The canonical frontend now lives in public/. anvil-app keeps a flat mirror
// until Anvil is decommissioned; these are the files whose drift would ship
// broken narration, so they are checked explicitly.
test('anvil-app mirror still matches the canonical public/ sources', async () => {
  const sources = {
    'audio_core.js': 'public/assets/js/audio_core.js',
    'buffer_manager.js': 'public/assets/js/buffer_manager.js',
    'pocket_worker.js': 'public/assets/js/pocket_worker.js',
    'narration_runtime_loader.js': 'public/assets/js/narration_runtime_loader.js',
  };
  for (const [name, canonical] of Object.entries(sources)) {
    const source = norm(await read(canonical));
    const mirror = norm(await read(`anvil-app/theme/assets/${name}`));
    assert.equal(mirror, source, `${name} mirror drifted from ${canonical}`);
  }
});
