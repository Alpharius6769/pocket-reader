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
  'api_core.js', 'audio_core.js', 'buffer_manager.js', 'device_setup.js',
  'diagnostics.js', 'library_manager.js', 'pocket_backend_policy.js',
  'pocket_performance_policy.js', 'pocket_worker.js', 'settings_manager.js',
  'tts_pronunciation_core.js', 'ui_controller.js', 'virtue_controller.js',
  'narration_runtime_loader.js', 'theme.css', 'standard-page.html',
];
for (const name of assetFiles) {
  const source = path.join(root, name);
  const target = path.join(deploy, 'theme', 'assets', name);
  if (!existsSync(target) || read(source) !== read(target)) {
    failures.push(`${name} differs from ${target}`);
  }
}

for (const [sourceName, targetName] of [
  ['FrontEnd_html.html', path.join('client_code', 'FrontEnd', 'form_template.html')],
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
  const source = path.join(root, 'Back end', name);
  const target = path.join(root, 'Hugging Face Space', name);
  if (!existsSync(target) || read(source) !== read(target)) {
    failures.push(`Back end/${name} differs from Hugging Face Space/${name}`);
  }
}

const wranglerPath = path.join(root, 'Back end', 'wrangler.toml');
const wrangler = read(wranglerPath);
const mainMatch = wrangler.match(/^main\s*=\s*"([^"]+)"/m);
if (!mainMatch || !existsSync(path.join(root, 'Back end', mainMatch[1]))) {
  failures.push('Back end/wrangler.toml has a missing main entrypoint');
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
