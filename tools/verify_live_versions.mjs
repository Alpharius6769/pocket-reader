// Compare every shipped asset version in the working tree against what the live
// origin is actually serving.
//
// check_module_versions.mjs proves the tree is self-consistent. It cannot tell
// you whether that tree reached production: GitHub Pages deploys on a push, the
// Cloudflare Worker deploys only through wrangler, and the Hugging Face Space is
// a third pipeline again. A green CI run means the code is correct, not that it
// is live.
//
//   node tools/verify_live_versions.mjs
//
// Exits non-zero if anything shipped locally is not what the live origin serves.

const PAGES = 'https://alpharius6769.github.io/pocket-reader';
const WORKER = 'https://pocket-reader-proxy.alpharius67.workers.dev';
const WEB_ORIGIN = 'https://alpharius6769.github.io';

import { readFile } from 'node:fs/promises';

const problems = [];
const notes = [];

const get = async (url, init) => {
  const response = await fetch(url, { ...init, redirect: 'follow' });
  return { status: response.status, text: await response.text() };
};

// ── 1. The shell and every module version it references ─────────────────────
const localShell = await readFile('public/index.html', 'utf8');
const liveShell = await get(`${PAGES}/index.html?cachebust=${Date.now()}`);

if (liveShell.status !== 200) {
  problems.push(`GitHub Pages returned ${liveShell.status} for index.html`);
} else {
  const versionsOf = (html) => {
    const map = new Map();
    for (const m of html.matchAll(/assets\/js\/([a-z_]+\.js)\?v=([A-Za-z0-9._-]+)/g)) {
      map.set(m[1], m[2]);
    }
    return map;
  };
  const local = versionsOf(localShell);
  const live = versionsOf(liveShell.text);

  for (const [file, version] of local) {
    const liveVersion = live.get(file);
    if (!liveVersion) problems.push(`${file}: referenced locally, absent from the live shell`);
    else if (liveVersion !== version) problems.push(`${file}: local ${version}, live ${liveVersion}`);
  }
  for (const file of live.keys()) {
    if (!local.has(file)) problems.push(`${file}: served live but no longer referenced locally`);
  }
  notes.push(`shell: ${local.size} module references compared`);
}

// ── 2. The service worker revision, which gates every cached asset ──────────
const localSw = await readFile('public/sw.js', 'utf8');
const liveSw = await get(`${PAGES}/sw.js?cachebust=${Date.now()}`);
const cacheName = (text) => text.match(/pocket-reader-core-v(\d+)/)?.[1];
const localCache = cacheName(localSw);
const liveCache = cacheName(liveSw.text);
if (liveCache !== localCache) {
  problems.push(`service worker: local cache v${localCache}, live v${liveCache}`);
} else {
  notes.push(`service worker: v${localCache}`);
}

// Every asset the SW precaches must actually exist at that exact version, or the
// install rejects and the device is left with no offline shell.
const coreList = localSw.slice(localSw.indexOf('var CORE_ASSETS = ['), localSw.indexOf('// Best-effort cache fill'));
const coreAssets = [...coreList.matchAll(/'(assets\/[^']+)'/g)].map((m) => m[1]);
let missing = 0;
await Promise.all(coreAssets.map(async (asset) => {
  const response = await fetch(`${PAGES}/${asset}`, { method: 'HEAD' });
  if (!response.ok) { problems.push(`precached asset missing live: ${asset} (${response.status})`); missing += 1; }
}));
notes.push(`precache: ${coreAssets.length} core assets checked, ${missing} missing`);

// ── 3. The Cloudflare Worker, which does NOT deploy on a git push ───────────
// No version string is served, so this asserts the behaviour the current source
// is supposed to produce. A stale Worker fails at least one of these.
const workerChecks = [
  ['github.io origin reaches /api/', `${WORKER}/api/health`, { Origin: WEB_ORIGIN }, 200],
  ['native app origin reaches /models/', `${WORKER}/models/onnxruntime/1.27.0/ort-wasm-simd-threaded.jsep.mjs`, { Origin: 'https://localhost' }, 200],
  ['unknown origin is refused', `${WORKER}/api/health`, { Origin: 'https://evil.example' }, 403],
];
for (const [label, url, headers, expected] of workerChecks) {
  const response = await fetch(url, { headers });
  if (response.status !== expected) problems.push(`worker: ${label} -> ${response.status}, expected ${expected}`);
}
// The origin-less CORS grant was removed; a stale Worker still sends "null".
const originless = await fetch(`${WORKER}/models/onnxruntime/1.27.0/ort-wasm-simd-threaded.jsep.mjs`);
if (originless.headers.get('access-control-allow-origin') === 'null') {
  problems.push('worker: still reflecting Access-Control-Allow-Origin: null — deploy is stale (wrangler deploy)');
}
notes.push('worker: origin gates and the null-grant fix verified live');

// ── 4. Every shipped voice, per engine ──────────────────────────────────────
const policy = await readFile('public/assets/js/pocket_backend_policy.js', 'utf8');
const engineUtils = await readFile('public/assets/js/engine_utils.js', 'utf8');
const idsIn = (source, from, to) => {
  const block = source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  return [...block.matchAll(/id: '([a-z0-9_-]+)'/g)].map((m) => m[1]);
};
const kokoro = idsIn(policy, 'export const KOKORO_VOICES', ']);');
const kitten = idsIn(policy, 'export const KITTEN_VOICES', ']);');
// From `voices: [`, not from the pack object: POCKET_VOICE_PACK carries its own
// `id` (the pack name, e.g. kyutai-curated-v1), which is not a voice and has no
// asset behind it.
const pocket = idsIn(engineUtils, '  voices: [', 'window.POCKET_RETIRED_VOICES');

const voiceUrls = [
  ...pocket.map((v) => [`pocket/${v}`, `${WORKER}/models/voices/v2/${v}_neutral.safetensors?rev=r3`]),
  ...kokoro.map((v) => [`kokoro/${v}`, `${WORKER}/models/kokoro/v1.0/voices/${v}.bin`]),
  ...kitten.map((v) => [`kitten/${v}`, `${WORKER}/models/kitten/v0.1/voices/${v}.bin`]),
];
await Promise.all(voiceUrls.map(async ([label, url]) => {
  const response = await fetch(url, { method: 'HEAD', headers: { Origin: WEB_ORIGIN } });
  if (!response.ok) problems.push(`voice asset missing: ${label} (${response.status})`);
}));
notes.push(`voices: ${pocket.length} pocket + ${kokoro.length} kokoro + ${kitten.length} kitten checked`);
if (pocket.length !== 6 || kokoro.length !== 6 || kitten.length !== 6) {
  problems.push(`each engine should ship 6 voices: pocket ${pocket.length}, kokoro ${kokoro.length}, kitten ${kitten.length}`);
}

// ── 5. The backend, on its own pipeline again ───────────────────────────────
const health = await get(`${WORKER}/api/health`, { headers: { Origin: WEB_ORIGIN } });
if (health.status !== 200) problems.push(`backend health: ${health.status}`);
else {
  try {
    notes.push(`backend: ${JSON.parse(health.text).version}`);
  } catch { problems.push('backend health did not return JSON'); }
}

// ── report ──────────────────────────────────────────────────────────────────
for (const note of notes) console.log(`  ok   ${note}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  FAIL ${problem}`);
  process.exit(1);
}
console.log('\nEverything shipped locally is what the live origins serve.');
