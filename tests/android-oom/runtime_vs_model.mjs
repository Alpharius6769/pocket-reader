// Runtime-vs-model split. Answers: of the ~283 MB session-creation cost, how
// much is ORT's fixed per-session allocation and how much is Kokoro's weights?
//
// Measures app-only anon (Chrome's own 51-52 MB baseline excluded) at four
// points, in ONE worker so the runtime is paid for once:
//   1. worker constructed
//   2. ORT runtime loaded (wasm instantiated, no session)
//   3. session from a 69-byte Identity model   <- ORT's fixed session cost
//   4. session from the 82 MB Kokoro model     <- the model's marginal cost
//
// Needs: emulator up, jetsam watchdog running, adb forward tcp:9222, and the
// app open on an isolated (?tts_fast=1) page.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
const ADB = 'C:/Users/Chris/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const BASE = 52;
const anon = () => { try { return Number(execFileSync(ADB,['shell','/data/local/tmp/mem.sh'],{encoding:'utf8'}).trim().split(/\s+/)[0]) - BASE; } catch { return -1; } };
const settle = (ms) => new Promise(r => setTimeout(r, ms));

const PROXY = 'https://pocket-reader-proxy.alpharius67.workers.dev';
const TINY = `${PROXY}/models/diagnostics/tiny_identity.onnx`;
const KOKORO = `${PROXY}/models/kokoro/v1.0/model_q8f16.onnx`;

const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = b.contexts()[0].pages().find(p => p.url().includes('pocket-reader'));
console.log('isolated:', await page.evaluate(() => self.crossOriginIsolated));

await page.evaluate(() => {
  window.__probe = [];
  window.__w = new Worker('assets/js/ort_memory_probe_worker.js?v=probe-v1', { type: 'module' });
  window.__w.onmessage = (e) => window.__probe.push(e.data);
  window.__w.onerror = (e) => window.__probe.push({ stage: 'construct_error', message: e.message || '(silent)' });
});
const marks = [];
const mark = async (label) => { await settle(3000); const a = anon(); marks.push([label, a]); console.log(`  ${label.padEnd(34)} ${a} MB`); return a; };

await mark('1. worker constructed');
await page.evaluate(() => window.__w.postMessage({ cmd: 'load_runtime' }));
await settle(15000);
await mark('2. ORT runtime loaded (no session)');

await page.evaluate((u) => window.__w.postMessage({ cmd: 'create_session', url: u }), TINY);
await settle(20000);
await mark('3. + session from 69-byte model');

await page.evaluate((u) => window.__w.postMessage({ cmd: 'create_session', url: u }), KOKORO);
await settle(75000);
await mark('4. + session from 82 MB Kokoro');

console.log('\nworker messages:');
for (const m of await page.evaluate(() => window.__probe)) console.log('   ', JSON.stringify(m));

const [, w] = marks[0], [, rt] = marks[1], [, tiny] = marks[2], [, kok] = marks[3];
console.log('\n=== SPLIT ===');
console.log(`  ORT runtime load        ${rt - w:+5d} MB`);
console.log(`  ORT fixed session cost  ${tiny - rt:+5d} MB   <- paid for ANY model, even 69 bytes`);
console.log(`  Kokoro marginal cost    ${kok - tiny:+5d} MB   <- what a smaller model could ever save`);
await b.close(); process.exit(0);
