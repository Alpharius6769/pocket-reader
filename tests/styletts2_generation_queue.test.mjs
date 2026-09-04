import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── The StyleTTS2 workers had no mutual exclusion at all ────────────────────
//
// `generate` ran straight out of onmessage, so two requests arriving together
// both started -- on one ONNX session and one WASM heap, allocating their
// tensors at the same time, each one's wall clock containing the other's work.
// An iPhone 13 Pro Max cache log shows exactly that signature: 199 characters
// in 18.4s next to 201 characters in 73.2s, a 4x spread at the same length.
// The second request also reset cancelRequested out from under the first.
//
// Pocket grew a queue for this and it was never carried across. The behaviour
// is exercised directly in scratch simulation against the shipped block; these
// guards pin the structure so it cannot quietly revert.

for (const file of ['kokoro_worker.js', 'kitten_worker.js']) {
  test(`${file}: one render at a time`, async () => {
    const worker = await read(`public/assets/js/${file}`);
    assert.match(worker, /let isGenerating = false;/);
    assert.match(worker, /async function processGenerationQueue\(\) \{\s*\n\s*if \(isGenerating \|\| !generationQueue\.length\) return;/);
    // The handler must ENQUEUE, never call generate() directly again.
    // Sliced forward to the NEXT message branch: cancel_generation happens to
    // sit earlier in the file, so slicing to it yields an empty range that
    // passes every assertion vacuously.
    const from = worker.indexOf("if (type === 'generate') {");
    const nextBranch = worker.indexOf('if (type ===', from + 10);
    const handler = worker.slice(from, nextBranch === -1 ? undefined : nextBranch);
    assert.ok(handler.length > 40, 'the generate handler must be findable');
    assert.match(handler, /enqueueGeneration\(\{/);
    assert.ok(!/await generate\(/.test(handler), 'the message handler must not run a render itself');
  });

  test(`${file}: playback goes first, and preempts a cache render`, async () => {
    const worker = await read(`public/assets/js/${file}`);
    assert.match(worker, /const next = generationQueue\.findIndex\(\(job\) => job\.isPriority\);/);
    assert.match(
      worker,
      /if \(job\.isPriority && isGenerating && !activeGenerationIsPriority && !cancelRequested\) \{\s*\n\s*preemptedJobId = activeGenerationJobId;\s*\n\s*cancelRequested = true;/,
    );
    // The flag has to survive the trip from the message into the queued job.
    assert.match(worker, /isPriority: data\.isPriority === true,/);
  });

  test(`${file}: a preempted render reports the yield, never partial audio`, async () => {
    const worker = await read(`public/assets/js/${file}`);
    // generate() throws on cancellation rather than returning a short buffer,
    // so the preempted job lands in catch and is renamed there.
    assert.match(worker, /const preempted = preemptedJobId != null && preemptedJobId === task\.jobId;/);
    assert.match(worker, /error: preempted \? YIELDED_TO_PLAYBACK : \(error\?\.message \|\| String\(error\)\),/);
    assert.match(worker, /const YIELDED_TO_PLAYBACK = 'Narration cache yielded to playback';/);
  });

  test(`${file}: nothing queued is left hanging`, async () => {
    const worker = await read(`public/assets/js/${file}`);
    // The main thread parks a promise per dispatched id; a dropped job that is
    // never settled costs the caller its full timeout.
    assert.match(worker, /function drainGenerationQueue\(reason\) \{/);
    assert.match(worker, /drainGenerationQueue\('Narration backend was disposed\.'\);/);
    assert.match(worker, /generationQueue = generationQueue\.filter\(\(job\) => job\.jobId !== targetId\);/);
    // And the mutex is always released.
    const drain = worker.slice(worker.indexOf('async function processGenerationQueue'), worker.indexOf('function withTimeout'));
    assert.match(drain, /\} finally \{\s*\n\s*isGenerating = false;/);
    assert.match(drain, /setTimeout\(processGenerationQueue, 0\);/);
  });
}

test('the yield message names no engine, because three now emit it', async () => {
  for (const file of ['pocket_worker.js', 'kokoro_worker.js', 'kitten_worker.js']) {
    const worker = await read(`public/assets/js/${file}`);
    assert.match(worker, /= 'Narration cache yielded to playback';/, file);
    assert.ok(!worker.includes("'Pocket cache yielded to playback'"), `${file} still names Pocket`);
  }
  const buf = await read('public/assets/js/buffer_manager.js');
  assert.match(buf, /err\?\.message === 'Narration cache yielded to playback'/);
});
