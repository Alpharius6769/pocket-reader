import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();

// anvil-app is a bare gitlink with no .gitmodules, so a plain clone (and any
// CI checkout) leaves it empty. The mirror checks are a local pre-deploy guard;
// skip them where the checkout does not exist rather than failing CI.
const anvilPresent = existsSync(new URL('../anvil-app/theme/assets', import.meta.url));

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

// Phase 3 deliberately diverged the two workers: Anvil serves assets from
// /_/theme/ and Pages from /assets/, and the static worker drops Anvil-only
// branches. Byte parity is therefore wrong. What still matters while BOTH
// exist is that they cache the same things at the same version -- otherwise a
// fix lands on one host and not the other.
const precachedAssets = (source) =>
  new Set(
    [...source.matchAll(/['"](?:\/_\/theme|\/assets\/(?:js|css|img|icons|fonts))\/([^'"?]+)/g)]
      .map((m) => decodeURIComponent(m[1])),
  );

test('both service workers precache the same asset set', async () => {
  const [py, sw] = await Promise.all([read('serviceworker.py'), read('public/sw.js')]);
  const anvil = precachedAssets(extractJsFromEndpoint(py));
  const stat = precachedAssets(sw);
  const missing = [...anvil].filter((f) => !stat.has(f));
  const extra = [...stat].filter((f) => !anvil.has(f));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    'the Anvil and Pages service workers cache different assets',
  );
});

test('the static worker carries no Anvil-only paths', async () => {
  const sw = await read('public/sw.js');
  const lines = sw.split('\n').filter((l) => !l.includes("replace(/_/g"));  // base64url decoder
  const offenders = lines.filter((l) => l.includes('/_/theme/') || l.includes('/_/api/'));
  assert.deepEqual(offenders, [], 'public/sw.js still references Anvil paths');
  assert.ok(sw.includes("url.pathname === '/sw.js'"),
    'the self-interception guard must match the static worker path, not Anvil\'s endpoint name');
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

test('index.html is a real document, not an Anvil form template', async () => {
  const html = await read('public/index.html');
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'index.html must open with a doctype');
  for (const tag of ['<html lang="en">', '<head>', '</head>', '<body>', '</body>', '</html>']) {
    assert.ok(html.includes(tag), `index.html is missing ${tag}`);
  }
  assert.ok(!html.includes('anvil-form'), 'the <anvil-form> wrapper survived conversion');
  assert.ok(!html.includes('&quot;'), 'attribute escaping survived conversion');
  assert.ok(!html.includes('_/theme/'), 'index.html still points at Anvil asset paths');
  // A protocol-relative //assets/... would resolve against the host "assets".
  assert.ok(!html.includes('"//assets/') && !html.includes("'//assets/"),
    'protocol-relative //assets/ URL would resolve to the wrong origin');
});

test('the page registers the static service worker, not the Anvil endpoint', async () => {
  const html = await read('public/index.html');
  assert.ok(html.includes("register('/sw.js"),
    'index.html must register /sw.js; the Anvil endpoint does not exist on Pages');
  assert.ok(!html.includes('/_/api/serviceworker.js'),
    'the Anvil service-worker endpoint is still referenced');
});

// Guard the decision recorded in MIGRATION_PLAN.md: global COOP/COEP breaks
// OAuth popups, which Google sign-in through Supabase depends on. Isolation is
// applied per-navigation by the service worker instead. This test exists
// because adding these headers looks like an obvious improvement.
test('_headers does not set COOP/COEP globally', async () => {
  const headers = await read('public/_headers');
  const active = headers.split('\n').filter((l) => !l.trimStart().startsWith('#'));
  for (const banned of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy']) {
    assert.ok(
      !active.some((l) => l.includes(banned)),
      `${banned} must not be set globally -- it severs OAuth popups and breaks Google sign-in`,
    );
  }
  assert.ok(active.some((l) => l.includes('Cache-Control: no-cache')),
    'the service worker and shell must not be long-cached');
});

test('the PWA manifest is valid and self-hosted', async () => {
  const manifest = JSON.parse(await read('public/manifest.webmanifest'));
  assert.equal(manifest.start_url, '/');
  // Shown under the home-screen icon; launchers truncate around 12-15 chars.
  // The point of the guard is to catch the Anvil default, which was the full
  // "Alpharius' Pocket Reader (WIP Name)".
  assert.ok(manifest.short_name.length <= 15,
    `short_name "${manifest.short_name}" is too long for a home-screen label`);
  assert.ok(manifest.icons.length > 0, 'manifest declares no icons');
  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('/assets/'), `icon ${icon.src} is not self-hosted`);
    const ext = icon.src.split('.').pop();
    const expected = { webp: 'image/webp', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png' }[ext];
    assert.equal(icon.type, expected, `icon ${icon.src} declares the wrong MIME type`);
  }
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'),
    'a maskable icon is needed for a clean Android home-screen shape');
});

// The anvil-app mirror is no longer asserted. Confirmed 2026-07-26 that Anvil
// has no users and no accounts worth preserving and is being deleted, so the
// frontend modules now target Cloudflare Pages unconditionally (the TTS worker,
// AudioWorklet, sprite and icon URLs all moved to /assets/**). Anvil can no
// longer run them, and pretending otherwise would mean maintaining two asset
// layouts for a host that is going away.
//
// What replaces it: the guard below asserts the modules carry NO Anvil asset
// paths, which is the property that actually matters now.
test('no module still builds an Anvil asset URL', async () => {
  const modules = [
    'audio_core.js', 'buffer_manager.js', 'pocket_worker.js', 'cinematic_ui.js',
    'device_setup.js', 'virtue_controller.js', 'experience_coordinator.js',
    'library_manager.js', 'narration_runtime_loader.js',
  ];
  for (const name of modules) {
    const source = await read(`public/assets/js/${name}`);
    const offenders = source
      .split('\n')
      // The base64url decoder contains a /_/g regex literal, not a path.
      .filter((line) => !line.includes('replace(/_/g'))
      .filter((line) => line.includes('_/theme/'))
      .map((line) => line.trim().slice(0, 100));
    assert.deepEqual(offenders, [],
      `${name} still points at Anvil's asset layout, which 404s on Pages`);
  }
});
