import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deploy = path.join(root, 'anvil-app');
const normalize = (value) => value.replace(/\r\n/g, '\n');
const read = (file) => normalize(readFileSync(file, 'utf8'));
const failures = [];

const assetFiles = [
  'public/assets/js/api_core.js', 'public/assets/js/audio_core.js', 'public/assets/js/buffer_manager.js', 'public/assets/js/device_setup.js',
  'public/assets/js/diagnostics.js', 'public/assets/js/library_manager.js', 'public/assets/js/pocket_backend_policy.js',
  'public/assets/js/pocket_performance_policy.js', 'public/assets/js/pocket_worker.js', 'public/assets/js/settings_manager.js',
  'public/assets/js/tts_pronunciation_core.js', 'public/assets/js/ui_controller.js', 'public/assets/js/virtue_controller.js',
  'public/assets/js/narration_runtime_loader.js', 'public/assets/css/theme.css', 'public/standard-page.html',
];
// Sources are nested under public/; Anvil serves a FLAT theme/assets/
// directory, so the mirror target is the basename only.
for (const name of assetFiles) {
  const source = path.join(root, name);
  const target = path.join(deploy, 'theme', 'assets', path.basename(name));
  if (!existsSync(target) || read(source) !== read(target)) {
    failures.push(`${name} differs from ${path.relative(root, target)}`);
  }
}

// public/index.html is excluded once Phase 3 converts it to a standalone
// document: it can no longer be represented as an Anvil form template, so a
// difference there is the expected end state rather than drift. Anvil's
// form_template.html is frozen pre-conversion until Anvil is deleted.
const indexIsStandalone = read(path.join(root, 'public', 'index.html'))
  .trimStart()
  .startsWith('<!DOCTYPE');

for (const [sourceName, targetName] of [
  ...(indexIsStandalone
    ? []
    : [['public/index.html', path.join('client_code', 'FrontEnd', 'form_template.html')]]),
  ['FrontEnd_code.py', path.join('client_code', 'FrontEnd', '__init__.py')],
  ['serviceworker.py', path.join('server_code', 'serviceworker.py')],
]) {
  const source = path.join(root, sourceName);
  const target = path.join(deploy, targetName);
  if (!existsSync(target) || read(source) !== read(target)) {
    failures.push(`${sourceName} differs from ${target}`);
  }
}

for (const name of [
  'app.py', 'parsers_core.py', 'parsers_epub.py', 'parsers_pdf.py',
  'scrapers_core.py',
]) {
  const source = path.join(root, 'backend', name);
  const target = path.join(root, 'Hugging Face Space', name);
  if (!existsSync(target) || read(source) !== read(target)) {
    failures.push(`backend/${name} differs from Hugging Face Space/${name}`);
  }
}

const wranglerPath = path.join(root, 'worker', 'wrangler.toml');
const wrangler = read(wranglerPath);
const mainMatch = wrangler.match(/^main\s*=\s*"([^"]+)"/m);
// main is relative to the wrangler.toml, which now lives in worker/.
if (!mainMatch || !existsSync(path.join(root, 'worker', mainMatch[1]))) {
  failures.push('worker/wrangler.toml has a missing main entrypoint');
}

if (process.argv.includes('--live')) {
  const localWorker = read(path.join(root, 'serviceworker.py'));
  const revision = localWorker.match(/pocket-reader-core-v(\d+)/)?.[1];
  const response = await fetch(`https://hot-wiry-raven.anvil.app/_/api/serviceworker.js?parity=${Date.now()}`);
  const liveWorker = await response.text();
  if (!response.ok || !revision || !liveWorker.includes(`pocket-reader-core-v${revision}`)) {
    failures.push('live service-worker revision does not match the local release');
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Release parity verified${process.argv.includes('--live') ? ', including live markers' : ''}.`);
}
