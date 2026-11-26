// Objective long-form narration benchmark for Pocket Reader.
//
// Loads the REAL narration cores (public/assets/js/audio_core.js and what it
// imports, plus pocket_worker.js) in headless Chrome through a minimal harness
// page (tools/bench/harness.*), narrates an original chapter paragraph by
// paragraph down the live-playback path, and writes per-paragraph WAVs plus
// report.json / report.html / abtest.html under benchmark-results/.
//
// The other tools (benchmark_pocket_worker_pipeline, smoke_pocket_worker_runtime,
// measure_kokoro_chunk_tradeoff) post straight to the worker and so skip the
// emotion plan, prosody opts, quality guard, retries, drift guard and worker
// recycle in audio_core.js. This one goes through all of them.
//
// Model access: the CF proxy only answers production origins, so -- exactly as
// those tools do -- the page is served under https://alpharius6769.github.io via
// Playwright routing, with local files fulfilled from this checkout and
// COOP/COEP set so WASM threads are available. Model requests go to the real
// proxy; nothing is downloaded beyond what the app itself downloads.
//
// Usage:
//   node tools/longform_bench.mjs --label baseline
//   node tools/longform_bench.mjs --label quick --paragraphs 6 --no-abtest
// Options:
//   --label <name>        output folder prefix (default "run")
//   --paragraphs <n>      first n paragraphs of the fixture (default: all)
//   --voice <id>          Pocket voice (default alba)
//   --threads <n>         WASM threads (default 2, the iOS value)
//   --emotion-mode <m>    neutral | balanced | expressive (default balanced, the app default)
//   --seed <s>            Pocket voice seed (default: the app default). Renders are deterministic
//                         per seed, so stability comparisons need several seeds, not repeats
//   --no-expressive       turn expressive prosody OFF (default ON)
//   --no-stream           render paragraph 0 with generateChunk instead of the
//                         streaming path a cold desktop Play press uses
//   --no-abtest           skip the respelling A/B
//   --fixture <path>      chapter text (default tools/bench/fixture_chapter.txt)
//   --chrome <path>       Chrome executable (default: system Chrome, else Playwright Chromium)
//   --out <dir>           explicit output directory

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSamples, readWav, prosodyVector, rollingDrift, median, FRAME_RATE_HZ, DRIFT_UNITS } from './bench/audio_analysis.mjs';
import { RESPELLING_PAIRS, patchNaturalSpelling } from './bench/respelling_pairs.mjs';
import { renderReportHtml, renderAbTestHtml } from './bench/report_html.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const publicRoot = join(repoRoot, 'public');
const productionOrigin = 'https://alpharius6769.github.io';
const harnessPath = '/__longform_bench__.html';

function parseArgs(argv) {
  const options = {
    label: 'run',
    paragraphs: 0,
    voice: 'alba',
    threads: 2,
    emotionMode: 'balanced',
    seed: '',
    expressive: true,
    stream: true,
    abtest: true,
    fixture: join(here, 'bench', 'fixture_chapter.txt'),
    chrome: '',
    out: '',
  };
  const flags = new Set(['--no-expressive', '--no-stream', '--no-abtest']);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (flags.has(key)) {
      if (key === '--no-expressive') options.expressive = false;
      if (key === '--no-stream') options.stream = false;
      if (key === '--no-abtest') options.abtest = false;
      continue;
    }
    if (value == null) throw new Error(`missing value for ${key}`);
    if (key === '--label') options.label = value.replace(/[^A-Za-z0-9._-]/g, '_');
    else if (key === '--paragraphs') options.paragraphs = Math.max(0, Number(value) || 0);
    else if (key === '--voice') options.voice = value.toLowerCase();
    else if (key === '--threads') options.threads = Math.max(1, Number(value) || 2);
    else if (key === '--emotion-mode') options.emotionMode = value;
    else if (key === '--seed') options.seed = String(value);
    else if (key === '--fixture') options.fixture = resolve(value);
    else if (key === '--chrome') options.chrome = resolve(value);
    else if (key === '--out') options.out = resolve(value);
    else throw new Error(`unknown option ${key}`);
    i += 1;
  }
  if (!['neutral', 'balanced', 'expressive'].includes(options.emotionMode)) {
    throw new Error(`--emotion-mode must be neutral, balanced or expressive`);
  }
  return options;
}

// Playwright lives in tests/webkit-smoke/node_modules. A git worktree usually
// has no node_modules of its own, so fall back to the main checkout's copy.
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [join(repoRoot, 'tests', 'webkit-smoke', 'node_modules', 'playwright')];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    candidates.push(join(dirname(common), 'tests', 'webkit-smoke', 'node_modules', 'playwright'));
  } catch (_) {}
  if (process.env.PLAYWRIGHT_PATH) candidates.unshift(resolve(process.env.PLAYWRIGHT_PATH));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return require(candidate);
  }
  throw new Error(`Playwright not found. Run "npm install" in tests/webkit-smoke (looked in: ${candidates.join(', ')})`);
}

// Module specifiers exactly as the app imports them, so every core resolves to
// the same module instance it would in production (a different ?v= is a
// different module with its own state).
function appSpecifiers() {
  const index = readFileSync(join(publicRoot, 'index.html'), 'utf8');
  const loader = readFileSync(join(publicRoot, 'assets', 'js', 'narration_runtime_loader.js'), 'utf8');
  const pick = (source, pattern, label) => {
    const match = source.match(pattern);
    if (!match) throw new Error(`could not find the ${label} import`);
    return match[1];
  };
  return {
    engineUtils: `/${pick(index, /src='(assets\/js\/engine_utils\.js[^']*)'/, 'engine_utils')}`,
    pronunciation: `/${pick(index, /src='(assets\/js\/tts_pronunciation_core\.js[^']*)'/, 'tts_pronunciation_core')}`,
    audioCore: `/assets/js/${pick(loader, /import\('\.\/(audio_core\.js[^']*)'\)/, 'audio_core')}`,
  };
}

function readFixture(path, limit) {
  const raw = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
  const blocks = raw.split(/\n\s*\n/).map((b) => b.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  // The first block is the chapter heading. The app does not narrate it as a
  // paragraph either (it is the chapter title).
  const [chapterTitle, ...paragraphs] = blocks;
  return { chapterTitle, paragraphs: limit > 0 ? paragraphs.slice(0, limit) : paragraphs };
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const isolatedHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

async function processMemory(cdp) {
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const ids = processInfo.map((entry) => Number(entry.id)).filter(Number.isFinite);
    if (!ids.length || process.platform !== 'win32') return null;
    const command = `$r=Get-Process -Id @(${ids.join(',')}) -ErrorAction SilentlyContinue | Select-Object Id,PrivateMemorySize64; $r | ConvertTo-Json -Compress`;
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim();
    const rows = raw ? [].concat(JSON.parse(raw)) : [];
    return { privateBytes: rows.reduce((sum, row) => sum + (Number(row.PrivateMemorySize64) || 0), 0), processes: rows.length };
  } catch (_) {
    return null;
  }
}

function log(message) {
  process.stderr.write(`[longform] ${message}\n`);
}

const options = parseArgs(process.argv.slice(2));
const { chapterTitle, paragraphs } = readFixture(options.fixture, options.paragraphs);
const specifiers = appSpecifiers();
const startedIso = new Date().toISOString();
const date = startedIso.slice(0, 10);
let outDir = options.out || join(repoRoot, 'benchmark-results', `${options.label}-${date}`);
if (!options.out && existsSync(outDir)) outDir = `${outDir}-${startedIso.slice(11, 19).replace(/:/g, '')}`;
mkdirSync(join(outDir, 'wav'), { recursive: true });
if (options.abtest) mkdirSync(join(outDir, 'ab'), { recursive: true });

const { chromium } = loadPlaywright();
const systemChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const chromePath = options.chrome || (existsSync(systemChrome) ? systemChrome : '');
const browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
const cdp = await browser.newBrowserCDPSession();
const context = await browser.newContext();

const pronunciationSource = readFileSync(join(publicRoot, 'assets', 'js', 'tts_pronunciation_core.js'), 'utf8');
const naturalPronunciationSource = patchNaturalSpelling(pronunciationSource);
let naturalSpelling = false; // flipped for the A/B "as spelled" page only
const harnessConfig = {
  voice: options.voice,
  threads: options.threads,
  expressive: options.expressive,
  emotionMode: options.emotionMode,
  seed: options.seed,
  storyTitle: 'Longform Bench: The Glass Orchard',
  chapterTitle,
  paragraphs,
  specifiers,
};

const networkErrors = [];
const tokenizerUrls = { module: null, model: null };
context.on('request', (request) => {
  const url = request.url();
  if (/sentencepiece\.js/i.test(url) && !tokenizerUrls.module) tokenizerUrls.module = url;
  if (/tokenizer[^/]*\.model/i.test(url) && !tokenizerUrls.model) tokenizerUrls.model = url;
});
context.on('response', (response) => {
  if (response.status() >= 400) networkErrors.push({ url: response.url(), status: response.status() });
});
context.on('requestfailed', (request) => networkErrors.push({ url: request.url(), error: request.failure()?.errorText || 'failed' }));

await context.route(`${productionOrigin}/**`, async (route) => {
  const url = new URL(route.request().url());
  const send = (body, type, status = 200) => route.fulfill({ status, headers: { ...isolatedHeaders, 'Content-Type': type }, body });
  try {
    if (url.pathname === harnessPath) return send(readFileSync(join(here, 'bench', 'harness.html')), mime['.html']);
    if (url.pathname === '/__bench__/harness.js') return send(readFileSync(join(here, 'bench', 'harness.js')), mime['.js']);
    if (url.pathname === '/__bench__/config.json') return send(JSON.stringify(harnessConfig), mime['.json']);
    const file = resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(publicRoot + sep) || !existsSync(file)) return send(`not found: ${url.pathname}`, 'text/plain', 404);
    if (naturalSpelling && file.endsWith(`${sep}tts_pronunciation_core.js`)) return send(naturalPronunciationSource, mime['.js']);
    return send(readFileSync(file), mime[extname(file).toLowerCase()] || 'application/octet-stream');
  } catch (error) {
    return send(String(error?.message || error), 'text/plain', 500);
  }
});

async function openHarness() {
  const page = await context.newPage();
  const consoleMessages = [];
  page.on('console', (message) => {
    if (consoleMessages.length < 2000) consoleMessages.push(`${message.type()}: ${message.text()}`.slice(0, 600));
  });
  page.on('pageerror', (error) => consoleMessages.push(`pageerror: ${String(error?.stack || error).slice(0, 600)}`));
  await page.goto(`${productionOrigin}${harnessPath}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 60_000 });
  const environment = await page.evaluate(() => window.__bench.load());
  return { page, consoleMessages, environment };
}

function decodeWav(base64, path) {
  const bytes = Buffer.from(base64, 'base64');
  writeFileSync(path, bytes);
  return readWav(bytes);
}

const wordCount = (text) => (String(text).match(/[A-Za-z0-9’']+/g) || []).length;

// ── Long-form run ───────────────────────────────────────────────────────────
log(`output: ${outDir}`);
log(`fixture: ${paragraphs.length} paragraphs, voice ${options.voice}, ${options.threads} WASM threads, expressive ${options.expressive ? 'on' : 'off'}, emotion mode ${options.emotionMode}`);
const runStartedAt = Date.now();
const main = await openHarness();
log(`harness loaded (isolated=${main.environment.crossOriginIsolated}, engine=${main.environment.engine}, cores=${main.environment.hardwareConcurrency})`);
if (!main.environment.crossOriginIsolated) throw new Error('harness page is not cross-origin isolated; WASM threads would be unavailable');

const records = [];
for (let index = 0; index < paragraphs.length; index += 1) {
  const stream = options.stream && index === 0;
  const result = await main.page.evaluate(({ index, stream }) => window.__bench.synth(index, { stream }), { index, stream });
  const wavName = `p${String(index).padStart(2, '0')}.wav`;
  let features = null;
  if (result.wavBase64) {
    const { samples, sampleRate } = decodeWav(result.wavBase64, join(outDir, 'wav', wavName));
    features = analyzeSamples(samples, sampleRate, { words: wordCount(result.text) });
  }
  delete result.wavBase64;
  result.wav = features ? `wav/${wavName}` : null;
  result.features = features;
  result.words = wordCount(result.text);
  result.processMemory = await processMemory(cdp);
  records.push(result);
  const t = result.telemetry || {};
  log(`p${index}: ${result.wallMs} ms, audio ${features?.durationSec ?? 0}s, ${result.routedVoice}, temp ${t.temperature ?? '?'}, `
    + `${t.retryUsed ? 'RETRY ' : ''}${result.bestEffort ? 'BEST-EFFORT ' : ''}${t.qualityReason ? `guard: ${t.qualityReason}` : 'clean'}`
    + `${result.error ? ` ERROR ${result.error}` : ''}`);
}

// Exact token counts from the worker's own tokenizer.
let tokenCounts = null;
let tokenizerNote = '';
if (tokenizerUrls.module && tokenizerUrls.model) {
  try {
    await main.page.evaluate(({ module, model }) => window.__bench.loadTokenizer(module, model), tokenizerUrls);
    tokenCounts = await main.page.evaluate((texts) => window.__bench.countTokens(texts), paragraphs);
  } catch (error) {
    tokenizerNote = `tokenizer load failed: ${error?.message || error}`;
  }
} else {
  tokenizerNote = 'tokenizer URLs were not observed in the worker requests';
}
if (!tokenCounts) log(`token counts unavailable (${tokenizerNote}); early-EOS check falls back to words`);

const normalizedTexts = await main.page.evaluate((texts) => texts.map((text) => window.__bench.normalize(text)), paragraphs);
const allLogs = await main.page.evaluate(() => window.__bench.logs);
const stateTrace = await main.page.evaluate(() => window.__bench.stateTrace);

// ── Respelling A/B ──────────────────────────────────────────────────────────
const abResults = [];
async function renderAb(page, side) {
  for (const pair of RESPELLING_PAIRS) {
    const result = await page.evaluate(({ text }) => window.__bench.synth(-1, { text, ctx: false }), { text: pair.text });
    const name = `${pair.id}_${side}.wav`;
    let features = null;
    if (result.wavBase64) {
      const { samples, sampleRate } = decodeWav(result.wavBase64, join(outDir, 'ab', name));
      features = analyzeSamples(samples, sampleRate, { words: wordCount(pair.text) });
    }
    let entry = abResults.find((e) => e.id === pair.id);
    if (!entry) {
      entry = { ...pair, respelledText: null };
      abResults.push(entry);
    }
    entry[side] = {
      wav: features ? `ab/${name}` : null,
      wallMs: result.wallMs,
      routedVoice: result.routedVoice,
      qualityReason: result.telemetry?.qualityReason || '',
      retryUsed: result.telemetry?.retryUsed === true,
      error: result.error,
      features,
    };
    log(`ab ${side} ${pair.id}: ${features?.durationSec ?? 0}s${result.error ? ` ERROR ${result.error}` : ''}`);
  }
}
let naturalConsole = [];
if (options.abtest) {
  const respelledTexts = await main.page.evaluate((texts) => texts.map((t) => window.__bench.normalize(t)), RESPELLING_PAIRS.map((p) => p.text));
  RESPELLING_PAIRS.forEach((pair, i) => {
    if (respelledTexts[i] === pair.text || !respelledTexts[i].toLowerCase().includes(pair.expect)) {
      throw new Error(`respelling pair ${pair.id} no longer triggers its rule (got "${respelledTexts[i]}")`);
    }
  });
  await renderAb(main.page, 'respelled');
  abResults.forEach((entry, i) => { entry.respelledText = respelledTexts[i]; });
  await main.page.close();
  naturalSpelling = true;
  log('opening the natural-spelling page (wildcard respellings disabled in memory)');
  const natural = await openHarness();
  naturalConsole = natural.consoleMessages;
  const check = await natural.page.evaluate((texts) => texts.map((t) => window.__bench.normalize(t)), RESPELLING_PAIRS.map((p) => p.text));
  RESPELLING_PAIRS.forEach((pair, i) => {
    if (check[i].toLowerCase().includes(pair.expect) && !pair.text.toLowerCase().includes(pair.expect)) {
      throw new Error(`natural-spelling patch did not take effect for ${pair.id}`);
    }
  });
  await renderAb(natural.page, 'natural');
  await natural.page.close();
} else {
  await main.page.close();
}

await browser.close();

// ── Derived metrics ─────────────────────────────────────────────────────────
const PARAGRAPH_GAP_SEC = 0; // the worker already appends the 0.5 s paragraph pause to the audio
const LOOKAHEAD = 8; // POCKET_PLAYBACK_LOOKAHEAD in audio_core.js

const retryRendersFor = (record) => {
  const rejected = record.logs.filter((l) => /attempt \d+ rejected/.test(l.message)).length;
  if (!record.telemetry?.retryUsed) return 0;
  return record.bestEffort ? rejected : rejected + 1;
};
const verdictFor = (record) => {
  if (record.error || !record.features) return 'failed (no audio)';
  if (record.bestEffort) return 'best-effort (every attempt rejected)';
  const reason = record.telemetry?.qualityReason || '';
  if (record.telemetry?.retryUsed) return reason ? `retried, accepted with: ${reason}` : 'retried, then clean';
  return reason ? `soft warning: ${reason}` : 'clean';
};

const tokens = tokenCounts || paragraphs.map((p) => Math.round(wordCount(p) * 1.3));
const speechFramesPerToken = records.map((r, i) => (r.features ? (r.features.activeSpeechSec * FRAME_RATE_HZ) / Math.max(1, tokens[i]) : null));
const referenceFpt = median(speechFramesPerToken);

// Playback timeline: paragraph 0 starts playing at its first audio; each later
// paragraph needs its audio by the time the previous one finishes. Synthesis is
// serial on the one live worker, and the lookahead may not run more than 8
// paragraphs ahead of the cursor. Measured wall times are replayed through that
// model, so a paragraph that took longer to render than the audio queued ahead
// of it shows up as a stall.
const timeline = [];
{
  let genEnd = 0;
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    const duration = r.features?.durationSec || 0;
    const gate = i - LOOKAHEAD >= 1 ? timeline[i - LOOKAHEAD].playStart : 0;
    const genStart = i === 0 ? 0 : Math.max(genEnd, gate);
    genEnd = genStart + r.wallMs / 1000;
    const ready = i === 0 && r.firstAudioMs != null ? genStart + r.firstAudioMs / 1000 : genEnd;
    const prevEnd = i === 0 ? null : timeline[i - 1].playEnd + PARAGRAPH_GAP_SEC;
    const playStart = i === 0 ? ready : Math.max(ready, prevEnd);
    const stallSec = i === 0 ? 0 : Math.max(0, ready - prevEnd);
    timeline.push({ index: i, genStart, genEnd, ready, playStart, playEnd: playStart + duration, stallSec });
  }
}

const recycleIndices = records.filter((r) => r.logs.some((l) => /Recycling Pocket TTS worker/.test(l.message))).map((r) => r.index);
const driftGuardEvents = allLogs.filter((l) => /Prosody drift guard/.test(l.message)).map((l) => ({
  message: l.message,
  paragraph: records.find((r) => l.t >= r.startedAt && l.t <= r.endedAt)?.index ?? null,
  ...l.data,
}));

const paragraphRows = records.map((r, i) => {
  const t = r.telemetry || {};
  const f = r.features;
  const expectedFrames = referenceFpt ? Math.round(tokens[i] * referenceFpt) : null;
  const actualFrames = f ? Math.round(f.activeSpeechSec * FRAME_RATE_HZ) : null;
  const eosRatio = expectedFrames && actualFrames != null ? actualFrames / expectedFrames : null;
  const earlyEosReasons = [];
  if (eosRatio != null && eosRatio < 0.65) earlyEosReasons.push(`speech ${Math.round(eosRatio * 100)}% of token-expected`);
  if (f?.endsInSpeech) earlyEosReasons.push('audio ends mid-speech (no tail)');
  return {
    index: i,
    words: r.words,
    tokens: tokens[i],
    tokensExact: Boolean(tokenCounts),
    normalizedText: normalizedTexts[i],
    text: r.text,
    wav: r.wav,
    routedVoice: r.routedVoice,
    emotion: t.emotion ?? null,
    rawEmotion: r.rawEmotion?.emotion ?? null,
    temperature: t.temperature ?? null,
    streamed: r.streamed,
    wallMs: r.wallMs,
    firstAudioMs: r.firstAudioMs,
    workerPipelineMs: t.pipelineMs ?? null,
    workerRtf: t.realTimeFactor ?? null,
    wallRtf: f?.durationSec ? Number((r.wallMs / 1000 / f.durationSec).toFixed(3)) : null,
    stallSec: Number(timeline[i].stallSec.toFixed(3)),
    retryRenders: retryRendersFor(r),
    verdict: verdictFor(r),
    qualityReason: t.qualityReason || '',
    bestEffort: r.bestEffort,
    frames: t.frames ?? null,
    textChunks: t.textChunks ?? null,
    frameBudgetStops: t.frameBudgetStops ?? null,
    arMode: t.arMode ?? null,
    wasmThreads: t.wasmThreads ?? null,
    expectedSpeechFrames: expectedFrames,
    actualSpeechFrames: actualFrames,
    earlyEosSuspect: earlyEosReasons.length > 0,
    earlyEosReasons,
    recycledBefore: recycleIndices.includes(i),
    jsHeapMb: r.jsHeapBytes ? Number((r.jsHeapBytes / 1048576).toFixed(1)) : null,
    privateMemoryMb: r.processMemory ? Number((r.processMemory.privateBytes / 1048576).toFixed(0)) : null,
    guardLogs: r.logs.filter((l) => /quality guard|drift guard|Recycling|retry/i.test(l.message)).map((l) => l.message),
    error: r.error,
    features: f,
  };
});

const prosodyVectors = paragraphRows.map((row) => prosodyVector(row.features));
const timbreVectors = paragraphRows.map((row) => row.features?.mfccMean ?? null);
const prosodyDrift = rollingDrift(prosodyVectors);
const timbreDrift = rollingDrift(timbreVectors);

const sum = (values) => values.reduce((a, b) => a + (Number(b) || 0), 0);
const audioTotal = sum(paragraphRows.map((r) => r.features?.durationSec));
const wallTotal = sum(paragraphRows.map((r) => r.wallMs)) / 1000;
const stalls = paragraphRows.filter((r) => r.stallSec > 0.05);
const loadingAt = stateTrace.find((s) => s.state && s.state !== 'idle')?.t;
const readyAt = stateTrace.find((s) => s.state === 'ready')?.t;
const maxOf = (rows) => rows.reduce((m, r) => (r.distance != null && r.distance > m ? r.distance : m), 0);
const lastOf = (rows) => rows.length ? rows[rows.length - 1].distance : null;

const headline = {
  paragraphs: paragraphRows.length,
  audioSec: Number(audioTotal.toFixed(1)),
  synthWallSec: Number(wallTotal.toFixed(1)),
  timeToFirstAudioColdMs: paragraphRows[0]?.firstAudioMs ?? paragraphRows[0]?.wallMs ?? null,
  timeToFirstAudioIncludes: options.stream ? 'engine load + first streamed segment of paragraph 0' : 'engine load + all of paragraph 0',
  engineLoadMs: loadingAt != null && readyAt != null ? Math.round(readyAt - loadingAt) : null,
  rtfOverall: audioTotal > 0 ? Number((wallTotal / audioTotal).toFixed(3)) : null,
  rtfMedianWarm: median(paragraphRows.slice(1).map((r) => r.wallRtf)),
  rtfWorstWarm: Math.max(0, ...paragraphRows.slice(1).map((r) => r.wallRtf || 0)),
  stallCount: stalls.length,
  stallTotalSec: Number(sum(stalls.map((r) => r.stallSec)).toFixed(2)),
  stallWorstSec: Number(Math.max(0, ...stalls.map((r) => r.stallSec)).toFixed(2)),
  retryParagraphs: paragraphRows.filter((r) => r.retryRenders > 0).length,
  retryRenders: sum(paragraphRows.map((r) => r.retryRenders)),
  bestEffortParagraphs: paragraphRows.filter((r) => r.bestEffort).length,
  failedParagraphs: paragraphRows.filter((r) => !r.features).length,
  softWarnings: paragraphRows.filter((r) => r.verdict.startsWith('soft warning')).length,
  frameBudgetStops: sum(paragraphRows.map((r) => r.frameBudgetStops)),
  earlyEosSuspects: paragraphRows.filter((r) => r.earlyEosSuspect).length,
  workerRecycles: recycleIndices.length,
  driftGuardTransitions: driftGuardEvents.length,
  prosodyDriftMax: maxOf(prosodyDrift),
  prosodyDriftFinal: lastOf(prosodyDrift),
  timbreDriftMax: maxOf(timbreDrift),
  timbreDriftFinal: lastOf(timbreDrift),
  f0MedianHzRun: median(paragraphRows.map((r) => r.features?.f0MedianHz)),
  maxInternalSilenceSec: Math.max(0, ...paragraphRows.map((r) => r.features?.maxInternalSilenceSec || 0)),
  peakPrivateMemoryMb: Math.max(0, ...paragraphRows.map((r) => r.privateMemoryMb || 0)) || null,
  networkErrors: networkErrors.length,
};

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
let gitHead = null;
try { gitHead = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(); } catch (_) {}
let gitDirty = null;
try { gitDirty = execFileSync('git', ['status', '--porcelain', '--', 'public'], { cwd: repoRoot, encoding: 'utf8' }).trim().length > 0; } catch (_) {}

const report = {
  schemaVersion: 1,
  label: options.label,
  generatedAt: startedIso,
  elapsedSec: Math.round((Date.now() - runStartedAt) / 1000),
  git: { head: gitHead, publicDirty: gitDirty },
  coreHashes: Object.fromEntries(['audio_core.js', 'pocket_worker.js', 'buffer_manager.js', 'pocket_backend_policy.js', 'tts_pronunciation_core.js']
    .map((name) => [name, sha(join(publicRoot, 'assets', 'js', name))])),
  options: { ...options, fixture: options.fixture.replace(repoRoot + sep, '') },
  environment: { ...main.environment, chrome: chromePath || 'playwright-chromium' },
  specifiers,
  method: {
    path: 'resolveVoiceWithSentiment (chapter emotion plan) -> generateChunk; paragraph 0 via generateChunkStream when streaming is on',
    stalls: `serial synthesis replayed against a playback clock, lookahead ${LOOKAHEAD}; a stall is time the listener would wait between paragraphs`,
    rtf: 'wall-clock synthesis time (including guard retries and worker recycles) / audio duration',
    earlyEos: `speech frames (active audio x ${FRAME_RATE_HZ} Hz) vs tokens x run-median speech-frames-per-token; suspect below 65%, or audio that ends without a tail`,
    tokens: tokenCounts ? 'exact, from the worker\'s own SentencePiece model on normalizeForPocketTts output' : `ESTIMATED as words x 1.3 (${tokenizerNote})`,
    drift: 'distance of each rolling 5-paragraph window mean from the first 5 (RMS over dimensions). Prosody axes in fixed units; timbre = MFCC c1-c12 mean, raw cepstral units',
    driftUnits: DRIFT_UNITS,
    caveat: 'The fixture has deliberate emotional swings, so some prosody distance is the script, not drift. Compare runs on the same fixture.',
  },
  headline,
  paragraphs: paragraphRows,
  timeline,
  prosodyDrift,
  timbreDrift,
  driftGuardEvents,
  recycleIndices,
  abtest: options.abtest ? abResults : null,
  networkErrors: networkErrors.slice(0, 200),
  logs: allLogs,
  console: { main: main.consoleMessages.slice(-400), natural: naturalConsole.slice(-200) },
};

writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(outDir, 'report.html'), renderReportHtml(report));
if (options.abtest) writeFileSync(join(outDir, 'abtest.html'), renderAbTestHtml(report));

log('done');
process.stdout.write(`${JSON.stringify({ outDir, headline }, null, 2)}\n`);
