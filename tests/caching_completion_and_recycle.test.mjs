import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── Skipped paragraphs must count as processed so caching can reach "complete" ──
// (Fixes the "stuck at 2098/2106" symptom: a story with a few un-synthesizable
//  paragraphs previously left cachedCount permanently short of totalToCache.)

test('circuit-breaker skip advances progress (cachedCount + skippedCount)', async () => {
  const buf = await read('public/assets/js/buffer_manager.js');
  // The 3-fail skip path increments both counters before scheduling the next loop.
  assert.match(buf, /failed 3 times[\s\S]*?this\.cachedCount\+\+;\s*\n\s*this\.skippedCount\+\+;/);
});

test('interrupt-retry skip also advances progress', async () => {
  const buf = await read('public/assets/js/buffer_manager.js');
  assert.match(buf, /stuck in a retry loop[\s\S]*?this\.cachedCount\+\+;\s*\n\s*this\.skippedCount\+\+;/);
});

// ── A playback yield is not a recycle and must not spend the recycle budget ──
// A cache render stood down so the paragraph being LISTENED to can go first is
// the priority system working. It happens roughly once per played paragraph, so
// sharing the 6-attempt recycle cap would permanently skip a healthy paragraph
// after a few seconds of listening.

test('a playback yield is counted and requeued separately from a recycle', async () => {
  const buf = await read('public/assets/js/buffer_manager.js');
  assert.match(buf, /const yielded = err\?\.message === 'Narration cache yielded to playback';/);
  assert.match(buf, /const counter = yielded \? 'yieldRetries' : 'resetRetries';/);
  assert.match(buf, /const limit = yielded \? 40 : 6;/);
  // Requeued at the BACK, or it just loses the race to the next playback render.
  assert.match(buf, /if \(yielded\) this\.queue\.push\(task\);\s*\n\s*else this\.queue\.unshift\(task\);/);
});

// ── The worker has to actually honour isPriority ──
// It was posted on every generate and read by nothing, so a live paragraph
// queued behind whatever cache render had already started.

test('the Pocket worker prefers a priority job and preempts a cache render', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  // Not-yet-started jobs: playback jumps the queue.
  assert.match(worker, /const next = generationQueue\.findIndex\(\(job\) => job\.isPriority\);/);
  // The running job: a cache render is stood down, a playback render never is.
  assert.match(
    worker,
    /if \(job\.isPriority && isGenerating && !activeGenerationIsPriority && !cancelRequested\) \{\s*\n\s*preemptedJobId = activeGenerationJobId;\s*\n\s*cancelRequested = true;/,
  );
  // The flag has to survive the trip from the message into the queued job.
  assert.match(worker, /isPriority: data\.isPriority === true,/);
  // A preempted render must not settle with its partial audio -- the buffer
  // manager would store a fragment as the whole paragraph.
  assert.match(
    worker,
    /if \(preemptedJobId != null && preemptedJobId === activeGenerationJobId\) \{[\s\S]*?settleWithError\(POCKET_YIELDED_TO_PLAYBACK\);\s*\n\s*\} else if \(allChunks\.length > 0\)/,
  );
});

test('the yield message is spelled identically on both sides', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const buf = await read('public/assets/js/buffer_manager.js');
  assert.match(worker, /const POCKET_YIELDED_TO_PLAYBACK = 'Narration cache yielded to playback';/);
  assert.ok(buf.includes("'Narration cache yielded to playback'"));
  // Three workers emit it now, so the string must not name one of them.
  for (const w of ["kokoro_worker.js", "kitten_worker.js"]) {
    const styled = await read(`public/assets/js/${w}`);
    assert.match(styled, /const YIELDED_TO_PLAYBACK = 'Narration cache yielded to playback';/);
  }
});

test('skippedCount is initialised and reset with the other counters', async () => {
  const buf = await read('public/assets/js/buffer_manager.js');
  assert.match(buf, /cachedCount: 0,\s*\n\s*skippedCount: 0,/);
  assert.match(buf, /this\.cachedCount = 0;\s*\n\s*this\.skippedCount = 0;/);
});

test('completion message discloses skipped paragraphs honestly', async () => {
  const buf = await read('public/assets/js/buffer_manager.js');
  assert.match(buf, /this\.skippedCount > 0[\s\S]*?skipped/);
});

// ── Backend-aware worker recycle (full engine reload is cheap on WASM, costly on WebGPU) ──

test('recycle threshold is backend-aware: 20 on WASM, 60 on WebGPU', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /const recycleEvery = _pocketBackendRuntime\?\.selectedBackend === 'webgpu' \? 60 : 20;/);
  assert.match(audio, /if \(window\._pocketParagraphCount < recycleEvery\) return false;/);
});
