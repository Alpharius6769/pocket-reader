/**
 * Pre-deploy parity check.
 *
 * The Anvil legs are gone (MIGRATION_PLAN.md Phase 5): there is no Anvil app
 * mirror, no FrontEnd_code.py and no serviceworker.py to compare against. What
 * remains are the two places content genuinely exists twice -- backend/ versus
 * the Hugging Face checkout -- plus config sanity, plus an optional live check
 * against the deployed Pages origin.
 *
 *   node tools/verify_release_parity.mjs [--live]
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The live frontend is GitHub Pages under a /pocket-reader/ SUBPATH; the
// pocket-reader-f2y.pages.dev origin this used to check is NXDOMAIN, so the
// --live parity check had been reporting 'could not reach' rather than
// comparing anything.
const PAGES_ORIGIN = 'https://alpharius6769.github.io/pocket-reader';
const normalize = (value) => value.replace(/\r\n/g, '\n');
const read = (file) => normalize(readFileSync(file, 'utf8'));
const failures = [];

// backend/ is the source of truth; the Space checkout is a deploy target that
// the GitHub Action keeps in step. Drift here means a hand edit landed in one.
const hfSpaceDir = path.join(root, 'Hugging Face Space');
if (existsSync(hfSpaceDir)) {
  for (const name of [
    'app.py', 'parsers_core.py', 'parsers_epub.py', 'parsers_pdf.py', 'scrapers_core.py',
  ]) {
    const source = path.join(root, 'backend', name);
    const target = path.join(hfSpaceDir, name);
    if (!existsSync(target) || read(source) !== read(target)) {
      failures.push(`backend/${name} differs from Hugging Face Space/${name}`);
    }
  }
}

// main is relative to the wrangler.toml, which lives in worker/.
const wrangler = read(path.join(root, 'worker', 'wrangler.toml'));
const mainMatch = wrangler.match(/^main\s*=\s*"([^"]+)"/m);
if (!mainMatch || !existsSync(path.join(root, 'worker', mainMatch[1]))) {
  failures.push('worker/wrangler.toml has a missing main entrypoint');
}

// The shell, the worker and the loader must agree on the cache version, or the
// service worker installs a shell whose modules it never precached.
const sw = read(path.join(root, 'public', 'sw.js'));
const cacheName = sw.match(/var CACHE_NAME = '([^']+)'/)?.[1];
if (!cacheName) failures.push('public/sw.js has no CACHE_NAME');

// Nothing may reference the deleted Anvil host.
for (const rel of ['public/index.html', 'public/sw.js', 'public/standard-page.html']) {
  const source = read(path.join(root, rel));
  for (const token of ['anvil.app', 'serviceworker.py', '_/api/serviceworker']) {
    if (source.includes(token)) failures.push(`${rel} still references ${token}`);
  }
}

if (process.argv.includes('--live')) {
  const revision = cacheName?.match(/pocket-reader-core-v(\d+)/)?.[1];
  try {
    const response = await fetch(`${PAGES_ORIGIN}/sw.js?parity=${Date.now()}`);
    const liveWorker = await response.text();
    if (!response.ok || !revision || !liveWorker.includes(`pocket-reader-core-v${revision}`)) {
      failures.push(`live service worker at ${PAGES_ORIGIN} does not match local ${cacheName}`);
    }
  } catch (err) {
    failures.push(`could not reach ${PAGES_ORIGIN}: ${err.message}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Release parity verified${process.argv.includes('--live') ? ', including live markers' : ''}.`);
}
