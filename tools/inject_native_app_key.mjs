// Plants the native build's proxy key into the COPIED web assets, after
// `npx cap sync` and before the APK/IPA is assembled.
//
//   node tools/inject_native_app_key.mjs --key "$APP_PROXY_TOKEN"
//   node tools/inject_native_app_key.mjs --key "$APP_PROXY_TOKEN" --target <dir>
//   node tools/inject_native_app_key.mjs --check --target <dir>
//
// The key must match the Worker's APP_PROXY_TOKEN secret:
//   npx wrangler secret put APP_PROXY_TOKEN --config worker/wrangler.toml
//
// This never writes into public/. That directory ships verbatim to GitHub
// Pages, so a key written there would be served on the open web to anyone who
// asked -- the whole reason the key lives in a separate, git-empty slot.
//
// It is worth being blunt about what the key is worth: it is inside a binary
// users install, so it is extractable, and it is a cost barrier rather than a
// secret. Rotate it freely; nothing that must actually stay secret may depend
// on it, and it is intentionally not the backend's PROXY_AUTH_TOKEN.

import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const MODULE_RELATIVE = 'assets/js/native_app_key.js';
const MARKER = '// pocket:native-app-proxy-key';
const KEY_LINE = /^const NATIVE_APP_PROXY_KEY = '[^']*';\s*\/\/ pocket:native-app-proxy-key$/m;

const DEFAULT_TARGETS = [
  'android/app/src/main/assets/public',
  'ios/App/App/public',
];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const check = process.argv.includes('--check');
const explicitTarget = argValue('--target');
const key = argValue('--key') ?? process.env.APP_PROXY_TOKEN ?? '';

function fail(message) {
  console.error(`inject_native_app_key: ${message}`);
  process.exit(1);
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

// Refuse the source tree outright. A mistyped --target that lands on public/ is
// the one mistake that publishes the key, so it is checked by resolved path
// rather than by string shape.
function assertNotSourceTree(targetDir) {
  const resolved = path.resolve(targetDir);
  const forbidden = path.resolve('public');
  if (resolved === forbidden || resolved.startsWith(forbidden + path.sep)) {
    fail(
      `refusing to write into public/ (${resolved}).\n` +
      '  public/ ships verbatim to GitHub Pages -- a key there would be published.\n' +
      '  Run `npx cap sync` first and point --target at the copied build assets.',
    );
  }
}

async function resolveTargets() {
  if (explicitTarget) {
    assertNotSourceTree(explicitTarget);
    const file = path.join(explicitTarget, MODULE_RELATIVE);
    if (!(await exists(file))) fail(`no ${MODULE_RELATIVE} under ${explicitTarget}. Run \`npx cap sync\` first.`);
    return [file];
  }
  const found = [];
  for (const dir of DEFAULT_TARGETS) {
    const file = path.join(dir, MODULE_RELATIVE);
    if (await exists(file)) {
      assertNotSourceTree(dir);
      found.push(file);
    }
  }
  if (!found.length) {
    fail(
      'no native build assets found. Expected one of:\n' +
      DEFAULT_TARGETS.map((d) => `  ${path.join(d, MODULE_RELATIVE)}`).join('\n') +
      '\n  Run `npx cap add android` / `npx cap sync`, or pass --target <dir>.',
    );
  }
  return found;
}

const targets = await resolveTargets();

if (check) {
  let injected = 0;
  for (const file of targets) {
    const text = await readFile(file, 'utf8');
    const match = text.match(KEY_LINE);
    if (!match) fail(`${file} has no injectable key line (marker ${MARKER}).`);
    const value = match[0].slice(match[0].indexOf("'") + 1, match[0].lastIndexOf("'"));
    const state = value ? `injected (${value.length} chars)` : 'EMPTY';
    console.log(`${value ? 'ok  ' : 'MISS'} ${file} -- ${state}`);
    if (value) injected += 1;
  }
  process.exit(injected === targets.length ? 0 : 1);
}

if (!key) {
  fail('no key. Pass --key <token> or set APP_PROXY_TOKEN. It must match the Worker secret of the same name.');
}
// The value is embedded inside a single-quoted JS literal, so anything that
// could terminate or continue that literal has to be rejected rather than
// escaped -- a token is ours to choose, and a restricted alphabet is cheaper to
// guarantee than to sanitise.
if (!/^[A-Za-z0-9._~+/=-]{16,512}$/.test(key)) {
  fail('key must be 16-512 chars of [A-Za-z0-9._~+/=-]. Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
}

for (const file of targets) {
  const text = await readFile(file, 'utf8');
  if (!KEY_LINE.test(text)) fail(`${file} has no injectable key line (marker ${MARKER}).`);
  const next = text.replace(KEY_LINE, `const NATIVE_APP_PROXY_KEY = '${key}'; ${MARKER}`);
  await writeFile(file, next);
  console.log(`injected proxy key into ${file}`);
}
console.log(`\n${targets.length} target(s) keyed. The Worker must hold the same value:`);
console.log('  npx wrangler secret put APP_PROXY_TOKEN --config worker/wrangler.toml');
