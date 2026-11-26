import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('iOS memory-safe lifecycle bounds startup blobs, voices, workers, and story prefetch', async () => {
  const policy = await read('public/assets/js/pocket_backend_policy.js');
  const audio = await read('public/assets/js/audio_core.js');
  const worker = await read('public/assets/js/pocket_worker.js');
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(policy, /memorySafeInference:\s*platform === 'ios' \|\| constrained/);
  assert.match(policy, /fullStoryVoicePrefetch:\s*platform !== 'ios' && !constrained/);
  assert.match(audio, /ttsWorkers\.splice\(0\)/);
  assert.match(audio, /Pocket memory-safe cache session released/);
  assert.match(worker, /MAX_CONSTRAINED_CUSTOM_VOICES\s*=\s*2/);
  assert.match(worker, /modelBuffer = null/);
  assert.match(worker, /setTimeout\(resolve, 24\)/);
  assert.match(buffer, /shouldPocketPrefetchFullStoryVoices/);
  assert.match(buffer, /_prefetchNextVoice/);
});
