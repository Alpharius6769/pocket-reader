import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

/**
 * Invariants of the static site that replaced the Anvil-hosted app.
 *
 * Originally these compared the Pages build against Anvil's copies. Anvil is
 * deleted, so the cross-host comparisons are gone
 * and what remains are the properties that must hold on their own.
 */

test('the static worker carries no Anvil-only paths', async () => {
  const sw = await read('public/sw.js');
  const offenders = sw.split('\n')
    .filter((l) => !l.includes('replace(/_/g'))   // base64url decoder, not a path
    .filter((l) => l.includes('/_/theme/') || l.includes('/_/api/'));
  assert.deepEqual(offenders, [], 'public/sw.js still references Anvil paths');
  assert.ok(sw.includes("url.pathname === '/sw.js'") || sw.includes("url.pathname.indexOf('/sw.js') !== -1") || sw.includes("url.pathname.endsWith('/sw.js')"),
    "the self-interception guard must match the static worker path");
});

test('all public files are free of deleted Anvil asset paths', async () => {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../public/', import.meta.url));
  const offenders = [];
  async function walk(dir, rel = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(file, path);
      else {
        const source = await readFile(file, 'utf8');
        if (source.includes('/_/theme/') || source.includes('/_/api/')) offenders.push(path);
      }
    }
  }
  await walk(root);
  assert.deepEqual(offenders, [], `public files still contain deleted Anvil paths: ${offenders.join(', ')}`);
});

// Asserted against `backend/`, not the "Hugging Face Space" checkout: that
// checkout is a deploy target (and a bare gitlink CI does not fetch), so
// reading it made this test fail with ENOENT on every CI run.
test('the HMOFA catalog is served by the index, not this API', async () => {
  const app = await readFile(new URL('../backend/app.py', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /docs\.google\.com\/spreadsheets/);
  // /api/masterlist served backend/masterlist.json, whose stories array was
  // empty, to a frontend that reads the published index directly. Route and
  // data file are both retired; the route answers 410 so an old cached client
  // gets JSON rather than an HTML error page.
  assert.match(app, /@app\.get\("\/api\/masterlist"\)/);
  assert.match(app, /The masterlist is served by the Anthronomicon index/);
  assert.doesNotMatch(app, /MASTERLIST_CACHE\s*=/);
  await assert.rejects(
    () => readFile(new URL('../backend/masterlist.json', import.meta.url), 'utf8'),
    'the empty masterlist.json is retired along with the route that read it',
  );
});

const precachedAssets = (source) =>
  new Set(
    [...source.matchAll(/['"]\/assets\/(?:js|css|img|icons|fonts)\/([^'"?]+)/g)]
      .map((m) => decodeURIComponent(m[1])),
  );

// Global COOP/COEP breaks OAuth popups, which Google sign-in through Supabase
// depends on. Isolation is applied per-navigation by the service worker
// instead. This test exists because adding these headers looks like an obvious
// improvement.
test('_headers does not set COOP/COEP globally, and says it is inert', async () => {
  const headers = await read('public/_headers');
  const active = headers.split('\n').filter((l) => !l.trimStart().startsWith('#'));
  for (const banned of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy']) {
    assert.ok(!active.some((l) => l.includes(banned)),
      `${banned} must not be set globally -- it severs OAuth popups and breaks Google sign-in`);
  }
  assert.ok(active.some((l) => l.includes('Cache-Control: no-cache')),
    'the service worker and shell must not be long-cached');
  // GitHub Pages does not read _headers, so every rule in it is documentation.
  // The file has to say so, or it reads as live config and the gaps it leaves
  // go unnoticed.
  assert.match(headers, /INERT ON THE CURRENT HOST/,
    '_headers must state that the current host ignores it');
});

test('the PWA manifest is valid and self-hosted', async () => {
  const manifest = JSON.parse(await read('public/manifest.webmanifest'));
  assert.ok(manifest.start_url === '/' || manifest.start_url === './');
  assert.ok(manifest.short_name.length <= 15,
    `short_name "${manifest.short_name}" is too long for a home-screen label`);
  assert.ok(manifest.icons.length > 0, 'manifest declares no icons');
  for (const icon of manifest.icons) {
    assert.ok(icon.src.includes('assets/'), `icon ${icon.src} is not self-hosted`);
    const ext = icon.src.split('.').pop();
    const expected = { webp: 'image/webp', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png' }[ext];
    assert.equal(icon.type, expected, `icon ${icon.src} declares the wrong MIME type`);
  }
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'),
    'a maskable icon is needed for a clean Android home-screen shape');
});
