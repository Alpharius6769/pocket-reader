import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── A Kokoro render reported milliseconds and nothing else ──────────────────
//
// Field report, iPhone 13 Pro Max: "bad performance for caching". Its log holds
// lines like "105358ms ... chars: 274" and, for every one of them, frames:
// null, realTimeFactor: null, wasmThreads: null, backend: null -- because those
// are Pocket pipeline fields and generate_done from the StyleTTS2 workers
// carried `{ audio, sampleRate }` and no telemetry at all.
//
// So the three candidate explanations -- a single-threaded (unisolated)
// session, a thread cap that does not suit the model, or superlinear cost in
// paragraph length -- could not be told apart from the report. Each render now
// says which.

for (const file of ['kokoro_worker.js', 'kitten_worker.js']) {
  test(`${file}: generate_done carries render telemetry`, async () => {
    const worker = await read(`public/assets/js/${file}`);
    assert.match(worker, /let lastGenerateTelemetry = null;/);
    assert.match(worker, /telemetry: lastGenerateTelemetry,/);
    // Cleared before each render, so a failed one cannot report the previous
    // render's numbers.
    assert.match(worker, /lastGenerateTelemetry = null;\s*\n\s*const audio = await generate\(/);
  });

  test(`${file}: the telemetry answers the questions a slow report raises`, async () => {
    const worker = await read(`public/assets/js/${file}`);
    const record = worker.slice(worker.indexOf('lastGenerateTelemetry = {'), worker.indexOf('if (pieces.length === 1) return pieces[0];'));
    assert.ok(record.length > 0, 'the telemetry record must be findable');
    // Was it slower than listening?
    assert.match(record, /realTimeFactor:/);
    assert.match(record, /audioDurationSec:/);
    // Was it threaded, and was the session isolated at all?
    assert.match(record, /wasmThreads: ort\?\.env\?\.wasm\?\.numThreads \|\| 1,/);
    assert.match(record, /isolated: self\.crossOriginIsolated === true,/);
    // Was the time in the model, or in pauses and merging?
    assert.match(record, /inferenceMs:/);
    // Did paragraph length drive it?
    assert.match(record, /chunks: chunks\.length,/);
    assert.match(record, /phonemeChars:/);
    assert.match(record, /chunkTokenCap: chunkTokenLimit\(\),/);
  });

  test(`${file}: inference time excludes the silence it inserts`, async () => {
    const worker = await read(`public/assets/js/${file}`);
    // Timed around runChunk only -- pause padding and the final merge are not
    // the model being slow, and counting them would misattribute the cost.
    assert.match(worker, /const chunkStartedAt = \(self\.performance \|\| Date\)\.now\(\);\s*\n\s*const audio = await runChunk\(/);
    assert.match(worker, /inferenceMs \+= \(self\.performance \|\| Date\)\.now\(\) - chunkStartedAt;/);
  });
}

test('the main thread already spreads a worker telemetry block into the log', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  // This is what carries the new fields into the diagnostic report without any
  // engine-specific plumbing.
  assert.match(audio, /\.\.\.\(accepted\.result\?\.telemetry \|\| \{\}\),/);
});
