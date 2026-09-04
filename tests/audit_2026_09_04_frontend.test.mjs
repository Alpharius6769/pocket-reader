import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── Declared model sizes must describe the file they name ───────────────────
//
// Every entry in MODEL_ASSET_BYTES was checked against what B2 serves from
// english_2026-04. Two were wrong: flow_lm_unified_block4 held 87264376, which
// is the .ORT build's size (the same number appears in
// ORT_FORMAT_MODEL_ASSET_BYTES) while the .onnx is 88818684; and
// flow_lm_decode_block4 had no entry at all despite the .ort map having one.
//
// The WASM bundle.json carries no `artifacts` block, so these constants are the
// only source for those figures.

test('the ONNX size map does not carry an ORT size', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const onnx = worker.slice(worker.indexOf('const MODEL_ASSET_BYTES = {'), worker.indexOf('const ORT_FORMAT_MODEL_ASSET_BYTES'));
  assert.match(onnx, /flow_lm_unified_block4: 88818684,/);
  assert.match(onnx, /flow_lm_decode_block4: 88173753,/);
  assert.ok(!/87264376/.test(onnx), 'that is the .ort size, not the .onnx one');

  const ort = worker.slice(worker.indexOf('const ORT_FORMAT_MODEL_ASSET_BYTES'));
  assert.match(ort.slice(0, 400), /flow_lm_unified_block4: 87264376,/);
});

// ── A stale constant must not be able to fail a download ────────────────────
//
// The header and the local maps were one expression, so the estimate sized the
// buffer whenever Content-Length was absent -- and the overflow check turns one
// byte of shortfall into "exceeded its declared Content-Length". A wrong
// constant should cost a wrong percentage, never a failed engine load.

test('only Content-Length may size the download buffer', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /const headerAssetBytes = Number\(response\.headers\.get\("Content-Length"\)\) \|\| 0;/);
  // The estimate still drives progress...
  assert.match(worker, /const expectedAssetBytes = headerAssetBytes \|\| currentModelAssetBytes\[asset\] \|\| MODEL_ASSET_BYTES\[asset\] \|\| 0;/);
  // ...but never the allocation.
  assert.match(worker, /let output = headerAssetBytes > 0 \? new Uint8Array\(headerAssetBytes\) : null;/);
  assert.ok(
    !/new Uint8Array\(expectedAssetBytes\)/.test(worker),
    'an estimated size must not be allocated against',
  );
});

// ── A deterministic engine renders the same audio twice ─────────────────────
//
// The quality-guard retry chain re-rolls the noise seed and cools the
// temperature. Kokoro and Kitten read neither -- their workers take speed,
// expressive and pronunciationOverrides, identical across attempts -- so a
// re-render returns the same samples and a verdict about that audio repeats.
// Up to POCKET_MAX_QUALITY_RETRIES identical renders, the first preceded by an
// 86 MB session teardown and rebuild.

test('quality-guard retries are skipped when a re-render cannot differ', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /const deterministicEngine = _isStyleTts2Engine\(route\.engine\);/);
  // An attempt that produced nothing to judge is a broken attempt, not a
  // verdict, and a fresh worker really can fix it.
  assert.match(audio, /const hadNothingToJudge = Boolean\(first\.error\) \|\| !\(first\.result\?\.audio\?\.length > 0\);/);
  assert.match(audio, /const retryCouldDiffer = !deterministicEngine \|\| hadNothingToJudge;/);
  assert.match(audio, /const allowQualityRetry = qualityRetryNeeded && retryCouldDiffer && canResetSharedEngine\(\);/);
  // And the skip is visible, or it looks like the guard simply stopped running.
  assert.match(audio, /quality guard kept the first render \(a retry renders identical audio\)/);
});

test('Pocket still retries, because its renders genuinely differ', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  // retryLevel reaches the seed and the temperature, which only Pocket reads.
  assert.match(audio, /_artifactCappedTemperature\(tuning\.temperature, paragraphEmotion, retryLevel\)/);
  for (const file of ['kokoro_worker.js', 'kitten_worker.js']) {
    const worker = await read(`public/assets/js/${file}`);
    assert.ok(!/opts\.temperature/.test(worker), `${file} does not read temperature`);
    assert.ok(!/opts\.voiceSeed|opts\.seed\b/.test(worker), `${file} does not read a seed`);
  }
});
