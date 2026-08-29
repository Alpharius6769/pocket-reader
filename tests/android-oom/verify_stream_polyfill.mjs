// Verify the polyfill against the EXACT pattern the espeak data package uses,
// with the native implementation removed to simulate Safari < 17.4.
import { webkit } from 'playwright';
const b = await webkit.launch();
const p = await b.newPage();
const src = (await import('node:fs')).readFileSync(
  'public/assets/js/kokoro_worker.js', 'utf8');
const fn = src.slice(src.indexOf('function _installStreamAsyncIteratorPolyfill'),
                     src.indexOf('async function loadPhonemizer'));
console.log(JSON.stringify(await p.evaluate(async ([fnSrc]) => {
  const log = () => {};
  // Simulate an engine without native support.
  delete ReadableStream.prototype[Symbol.asyncIterator];
  const before = typeof ReadableStream.prototype[Symbol.asyncIterator];
  let threwBefore = null;
  try {
    const s = new Blob([new Uint8Array([1,2,3])]).stream();
    for await (const _ of s) { /* consume */ }
    threwBefore = false;
  } catch (e) { threwBefore = String(e.message).slice(0, 45); }

  eval(fnSrc + '\n_installStreamAsyncIteratorPolyfill();');

  // The phonemizer's exact shape: gzip blob -> stream -> DecompressionStream
  // -> for await -> Blob -> arrayBuffer.
  const payload = new TextEncoder().encode('en_dict payload '.repeat(64));
  const gz = await new Response(
    new Blob([payload]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer();
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const out = new Uint8Array(await new Blob(chunks).arrayBuffer());
  const ok = out.length === payload.length && out.every((v, i) => v === payload[i]);

  // Early exit must release the reader rather than leak a lock.
  let earlyExitClean = false;
  try {
    const s2 = new Blob([new Uint8Array(64)]).stream();
    for await (const _ of s2) break;
    earlyExitClean = true;
  } catch (_) { earlyExitClean = false; }

  return { nativeRemoved: before === 'undefined', threwBefore,
           afterInstall: typeof ReadableStream.prototype[Symbol.asyncIterator],
           roundTripBytesMatch: ok, bytes: out.length, earlyExitClean };
}, [fn]), null, 2));
await b.close(); process.exit(0);
