import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── Skipped paragraphs must count as processed so caching can reach "complete" ──
// (Fixes the "stuck at 2098/2106" symptom: a story with a few un-synthesizable
//  paragraphs previously left cachedCount permanently short of totalToCache.)

test('circuit-breaker skip advances progress (cachedCount + skippedCount)', async () => {
  const buf = await read('buffer_manager.js');
  // The 3-fail skip path increments both counters before scheduling the next loop.
  assert.match(buf, /failed 3 times[\s\S]*?this\.cachedCount\+\+;\s*\n\s*this\.skippedCount\+\+;/);
});

test('worker-recycle skip also advances progress', async () => {
  const buf = await read('buffer_manager.js');
  assert.match(buf, /worker-recycle retry loop[\s\S]*?this\.cachedCount\+\+;\s*\n\s*this\.skippedCount\+\+;/);
});

test('skippedCount is initialised and reset with the other counters', async () => {
  const buf = await read('buffer_manager.js');
  assert.match(buf, /cachedCount: 0,\s*\n\s*skippedCount: 0,/);
  assert.match(buf, /this\.cachedCount = 0;\s*\n\s*this\.skippedCount = 0;/);
});

test('completion message discloses skipped paragraphs honestly', async () => {
  const buf = await read('buffer_manager.js');
  assert.match(buf, /this\.skippedCount > 0[\s\S]*?skipped/);
});

// ── Backend-aware worker recycle (full engine reload is cheap on WASM, costly on WebGPU) ──

test('recycle threshold is backend-aware: 20 on WASM, 60 on WebGPU', async () => {
  const audio = await read('audio_core.js');
  assert.match(audio, /const _recycleEvery = _pocketBackendRuntime\?\.selectedBackend === 'webgpu' \? 60 : 20;/);
  assert.match(audio, /if \(window\._pocketParagraphCount >= _recycleEvery\)/);
});
