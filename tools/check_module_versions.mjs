// Detects the failure mode the drift check cannot see: a module whose CONTENT
// changed while its own ?v= stayed put.
//
// Assets are served `max-age=31536000, immutable`, so the version string is the
// only thing that makes a browser re-fetch a module. Edit a file without
// bumping it and every returning user keeps running the old code — the fix
// ships to nobody, and it fails silently because every *reference* still agrees
// with every other reference, which is all the drift test can check.
//
// This bit for real during the 2026-08-14 work: narration_runtime_loader.js had
// its audio_core reference rewritten three times while sitting at
// narration-loader-v15, so a reloaded browser kept serving the cached loader
// and kept pulling the superseded audio_core.
//
//   node tools/check_module_versions.mjs           # verify (exit 1 on drift)
//   node tools/check_module_versions.mjs --update  # accept current state
//
// Run --update only after deliberately bumping the versions of what you changed.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const JS_DIR = 'public/assets/js';
const MANIFEST = 'tools/module_version_manifest.json';
const update = process.argv.includes('--update');

const sha = (text) =>
  // Normalize line endings: git runs with core.autocrlf=true here, so the
  // working tree is CRLF while the blob is LF. Hashing raw bytes would report
  // every file as changed depending on who checked it out.
  createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 16);

const sources = {
  'sw.js': await readFile('public/sw.js', 'utf8'),
  'index.html': await readFile('public/index.html', 'utf8'),
};
const moduleFiles = (await readdir(JS_DIR)).filter((f) => f.endsWith('.js')).sort();
for (const file of moduleFiles) {
  sources[file] = await readFile(path.join(JS_DIR, file), 'utf8');
}

// Resolve each module's declared version from however it is referenced.
const versionOf = new Map();
for (const text of Object.values(sources)) {
  for (const m of text.matchAll(/assets\/js\/([a-z_0-9]+\.js)\?v=([A-Za-z0-9._-]+)/g)) {
    versionOf.set(m[1], m[2]);
  }
}

// Unversioned modules ride the service-worker cache name instead.
const swRevision = sources['sw.js'].match(/pocket-reader-core-v(\d+)/)?.[1] || '0';

const current = {};
for (const file of moduleFiles) {
  current[file] = {
    version: versionOf.get(file) || `sw-${swRevision}`,
    sha256: sha(sources[file]),
  };
}
current['sw.js'] = { version: `sw-${swRevision}`, sha256: sha(sources['sw.js']) };

let previous = {};
try {
  previous = JSON.parse(await readFile(MANIFEST, 'utf8'));
} catch {
  if (!update) {
    console.error(`No manifest at ${MANIFEST}. Create it with --update.`);
    process.exit(1);
  }
}

const stale = [];
const bumped = [];
const added = [];
for (const [file, now] of Object.entries(current)) {
  const before = previous[file];
  if (!before) { added.push(file); continue; }
  if (before.sha256 === now.sha256) continue;
  if (before.version === now.version) stale.push({ file, version: now.version });
  else bumped.push({ file, from: before.version, to: now.version });
}

if (update) {
  await writeFile(MANIFEST, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Manifest updated: ${Object.keys(current).length} modules`);
  if (bumped.length) console.log(`  bumped: ${bumped.map((b) => `${b.file} ${b.from}->${b.to}`).join(', ')}`);
  if (added.length) console.log(`  added:  ${added.join(', ')}`);
  process.exit(0);
}

if (stale.length) {
  console.error('Module content changed without a version bump.\n');
  console.error('These edits would NOT reach a returning browser — the old copy is cached immutable:\n');
  for (const { file, version } of stale) {
    console.error(`  ${file}  still at  ?v=${version}`);
  }
  console.error('\nBump each module\'s own ?v= everywhere it is referenced (sw.js, index.html,');
  console.error('and every importer), then re-run with --update.');
  process.exit(1);
}

console.log(`Module versions consistent (${Object.keys(current).length} modules checked).`);
if (bumped.length) console.log(`Bumped since last manifest: ${bumped.map((b) => b.file).join(', ')} — run --update to record.`);
if (added.length) console.log(`New modules: ${added.join(', ')} — run --update to record.`);
