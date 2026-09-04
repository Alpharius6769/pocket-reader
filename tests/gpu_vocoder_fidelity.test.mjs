import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const worker = await read('public/assets/js/pocket_worker.js');

// ── The GPU vocoder was chosen on speed, by a guard blind to how it fails ────
//
// A desktop on the WebGPU FP16 path reported "very crunchy" audio while Kokoro
// (a different engine, WASM) sounded fine. That render's own telemetry: peak
// 0.687, clipRatio 0, rms 0.075, duration and pitch normal -- every number the
// quality guards look at, entirely unremarkable. Broadband grain is invisible
// to level and clipping statistics, which is all you can measure about ONE
// waveform. So the Mimi provider decision, which is a speed benchmark, had no
// working quality veto behind it.

test('calibration compares the two vocoder renders against each other', async () => {
  assert.match(worker, /function compareWaveforms\(reference, candidate\) \{/);
  // A trial has to hand back the waveform, not just aggregates of it.
  assert.match(worker, /samples: concatSamples\(chunks\),/);
  assert.match(worker, /const fidelity = compareWaveforms\(selectedVariant\.referenceSamples, gpuMimiVariant\.referenceSamples\);/);
});

test('the comparison refuses to return a number it cannot stand behind', async () => {
  const fn = worker.slice(worker.indexOf('function compareWaveforms('), worker.indexOf('function concatSamples('));
  // Different frame counts make a sample-aligned SNR meaningless, not noisy.
  assert.match(fn, /if \(lengthRatio < 0\.98\) return \{ snrDb: null, lengthRatio, aligned: false \};/);
  // Silence would divide by zero.
  assert.match(fn, /if \(!\(signal > 0\)\) return \{ snrDb: null, lengthRatio, aligned: false \};/);
});

test('a run-to-run control decides whether the A/B means anything', async () => {
  // The same configuration rendered twice. If a GPU is not bit-reproducible,
  // the floor is low and the later comparison cannot separate the decoder from
  // that noise -- which must read as inconclusive, never as a fault.
  assert.match(worker, /let selfSnrDb = null;/);
  assert.match(worker, /const control = compareWaveforms\(referenceSamples, trial\.samples\);/);
  assert.match(worker, /const controlUsable = controlDb === null \|\| controlDb >= MIMI_FIDELITY_MIN_CONTROL_DB;/);
});

test('rejection happens only on evidence, and only downward', async () => {
  assert.match(worker, /const MIMI_FIDELITY_MIN_SNR_DB = 20;/);
  assert.match(worker, /const MIMI_FIDELITY_MIN_CONTROL_DB = 30;/);
  // Measured AND controlled AND below threshold -- all three.
  assert.match(
    worker,
    /if \(measured && controlUsable && gpuMimiVariant\.mimiFidelitySnrDb < MIMI_FIDELITY_MIN_SNR_DB\) \{/,
  );
  // An unmeasurable comparison keeps the previous speed-only behaviour rather
  // than discarding a working decoder over a missing number.
  assert.match(worker, /const measured = Number\.isFinite\(gpuMimiVariant\.mimiFidelitySnrDb\);/);
});

test('the numbers reach telemetry, and the waveforms do not', async () => {
  // This is the only way to see the GPU decoder's real fidelity on hardware
  // that cannot be reproduced locally.
  assert.match(worker, /result\.mimiFidelitySnrDb = selectedVariant\.mimiFidelitySnrDb/);
  assert.match(worker, /result\.mimiFidelityControlDb = webGpuVariants/);
  // Megabytes of Float32, structured-cloned on every postMessage and then held
  // for the life of the worker as lastBackendTelemetry.
  assert.match(worker, /referenceSamples: undefined,/);
  assert.match(worker, /result\.webgpu = \{ \.\.\.selectedVariant, referenceSamples: undefined \};/);
  assert.match(worker, /if \(result\.wasm\) result\.wasm = \{ \.\.\.result\.wasm, referenceSamples: undefined \};/);
});

// ── The fidelity cliff the gate would otherwise have measured against ───────
// The comparison is only meaningful because BOTH sides are now the FP16
// decoder. While the WASM side of a GPU session was INT8, the two candidates
// were different models and their difference was quantisation noise, not GPU
// execution.

test('a WebGPU session and a WASM session choose the same vocoder file', async () => {
  const prefer = worker.slice(worker.indexOf('function preferFp16Mimi()'), worker.indexOf('function mimiWasmFilename()'));
  assert.ok(!/currentBackend !== 'wasm'/.test(prefer));
  const webgpuDescriptors = worker.slice(
    worker.indexOf("const modelDescriptors = currentBackend === 'webgpu'"),
    worker.indexOf('asset: WEBGPU_BLOCK_ROLE'),
  );
  assert.match(webgpuDescriptors, /filename: mimiWasmFilename\(\),/);
  assert.match(webgpuDescriptors, /fallbackFilename: preferFp16Mimi\(\) \? wasmModelFilename\('mimi_decoder'\) : null,/);
});
